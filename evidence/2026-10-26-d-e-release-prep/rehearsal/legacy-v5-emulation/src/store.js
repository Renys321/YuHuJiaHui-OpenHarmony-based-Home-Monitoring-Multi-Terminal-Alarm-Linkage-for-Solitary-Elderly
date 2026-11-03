'use strict';

const {
  DISPOSITION_ACTOR,
  DISPOSITION_ID_RE,
  SAFETY_LOG_CAP,
  validateDispositionInput
} = require('./safety-log');

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const EVIDENCE_ID_RE = /^fall-[0-9]{1,16}-(?:na|[0-9]{1,12})$/;
const COMMAND_ID_RE = /^[1-9][0-9]{0,15}$/;
const RESULT_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;
const STATES = new Set(['NORMAL', 'WARN', 'ALARM', 'ACKED']);

function boundedText(value, max, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 安全日志排序：`serverTime` 降序，同刻按 `dispositionId` 的数值降序
 * （与合同 §2.2/§2.3 一致；ID 是单调递增的，因此同刻排序是稳定且确定的）。
 */
function compareSafetyLogs(left, right) {
  if (right.serverTime !== left.serverTime) return right.serverTime - left.serverTime;
  return Number(right.dispositionId.slice(4)) - Number(left.dispositionId.slice(4));
}

function normalizeStatus(input, receivedAt = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('status must be an object');
  if (!DEVICE_ID_RE.test(input.deviceId || '')) throw new Error('invalid deviceId');
  if (!STATES.has(input.state)) throw new Error('invalid state');
  const monitorOnline = input.monitorOnline === undefined ? -1 : input.monitorOnline;
  if (!Number.isSafeInteger(monitorOnline) || ![-1, 0, 1].includes(monitorOnline)) {
    throw new Error('invalid monitorOnline');
  }
  const ts = Number.isSafeInteger(input.ts) && input.ts >= 0 ? input.ts : receivedAt;
  const alarm = input.alarm && typeof input.alarm === 'object' ? input.alarm : {};
  const alarmId = boundedText(alarm.id, 80);
  if (alarmId && !ALARM_ID_RE.test(alarmId)) throw new Error('invalid alarm id');
  const evidenceId = alarm.evidenceId === undefined ? '' : alarm.evidenceId;
  if (typeof evidenceId !== 'string' || (evidenceId && !EVIDENCE_ID_RE.test(evidenceId))) {
    throw new Error('invalid evidence id');
  }
  if (evidenceId && (!alarmId || alarm.type !== 'FALL')) throw new Error('evidence requires a FALL alarm');
  const gps = input.gps && typeof input.gps === 'object' ? input.gps : {};
  const sensors = input.sensors && typeof input.sensors === 'object' ? input.sensors : {};
  return {
    deviceId: input.deviceId,
    room: boundedText(input.room, 32, '未分配'),
    online: input.online !== false,
    monitorOnline,
    state: input.state,
    ts,
    receivedAt,
    sensors,
    alarm: {
      id: alarmId,
      type: boundedText(alarm.type, 32),
      countToday: Number.isSafeInteger(alarm.countToday) ? alarm.countToday : 0,
      evidenceId
    },
    gps: {
      valid: gps.valid === true,
      latitude: finiteOrNull(gps.latitude),
      longitude: finiteOrNull(gps.longitude),
      fixTime: Number.isSafeInteger(gps.fixTime) ? gps.fixTime : 0
    },
    csq: Number.isInteger(input.csq) && input.csq >= 0 && input.csq <= 99 ? input.csq : null
  };
}

class MemoryStore {
  constructor(options = {}) {
    this.devices = new Map();
    this.alerts = new Map();
    this.commands = [];
    /**
     * 安全日志台账（告警处置结果）：按写入顺序保存，容量上限 SAFETY_LOG_CAP。
     * 与 `alerts` / `commands` 完全独立：登记处置不改变告警状态、不生成 ACK 命令。
     */
    this.safetyLogs = [];
    this.contacts = Array.isArray(options.contacts) ? options.contacts.map((item, index) => ({
      id: String(item.id || `contact-${index + 1}`),
      name: boundedText(item.name, 40, '联系人'),
      relation: boundedText(item.relation, 24),
      phone: typeof item.phone === 'string' ? item.phone.replace(/[^0-9+ -]/g, '').slice(0, 24) : '',
      primary: item.primary === true
    })).filter((item) => item.phone) : [];
  }

  ingest(input, receivedAt = Date.now()) {
    const status = normalizeStatus(input, receivedAt);
    // Validate every binding before changing either devices or alerts.  This
    // applies to ACKED/NORMAL repeats too, not just new ALARM snapshots.
    const prior = this.alerts.get(status.alarm.id);
    if (prior && prior.deviceId !== status.deviceId) throw new Error('alarm id already belongs to another device');
    if (prior && prior.evidenceId && status.alarm.evidenceId && prior.evidenceId !== status.alarm.evidenceId) {
      throw new Error('alarm evidence binding conflict');
    }
    if (status.alarm.evidenceId) {
      for (const alert of this.alerts.values()) {
        if (alert.evidenceId === status.alarm.evidenceId &&
            (alert.alarmId !== status.alarm.id || alert.deviceId !== status.deviceId)) {
          throw new Error('evidence already belongs to another alarm');
        }
      }
    }
    this.devices.set(status.deviceId, status);
    if (status.state === 'ALARM' && status.alarm.id) {
      const existing = this.alerts.get(status.alarm.id);
      if (existing && existing.deviceId !== status.deviceId) {
        throw new Error('alarm id already belongs to another device');
      }
      if (existing && existing.evidenceId && status.alarm.evidenceId &&
          existing.evidenceId !== status.alarm.evidenceId) {
        throw new Error('alarm evidence binding conflict');
      }
      if (existing && !existing.evidenceId && status.alarm.evidenceId) {
        existing.evidenceId = status.alarm.evidenceId;
      }
      this.alerts.set(status.alarm.id, existing || {
        alarmId: status.alarm.id,
        deviceId: status.deviceId,
        room: status.room,
        type: status.alarm.type || 'UNKNOWN',
        createdAt: status.ts || receivedAt,
        status: 'ALARM',
        ackPending: false,
        acknowledgedAt: 0,
        acknowledgedBy: '',
        action: '',
        evidenceId: status.alarm.evidenceId
      });
    }
    if (status.state === 'ACKED' && status.alarm.id && this.alerts.has(status.alarm.id)) {
      const alert = this.alerts.get(status.alarm.id);
      alert.status = 'ACKED';
      alert.ackPending = false;
      alert.acknowledgedAt = status.ts || receivedAt;
    }
    return status;
  }

  listDevices() {
    return [...this.devices.values()].sort((a, b) => a.room.localeCompare(b.room, 'zh-CN'));
  }

  listRooms() {
    const groups = new Map();
    for (const device of this.listDevices()) {
      const room = groups.get(device.room) || { devices: [], states: [] };
      room.devices.push(this.toPublicDevice(device));
      room.states.push(device.state);
      groups.set(device.room, room);
    }
    return [...groups.entries()].map(([name, group]) => ({
      id: name,
      name,
      location: '',
      state: group.states.includes('ALARM') ? 'ALARM'
        : group.states.includes('WARN') ? 'WARN'
          : group.states.every((state) => state === 'OFFLINE') ? 'OFFLINE' : 'NORMAL',
      onlineDeviceCount: group.devices.filter((device) => device.online).length,
      deviceCount: group.devices.length,
      devices: group.devices
    }));
  }

  listAlerts() {
    return [...this.alerts.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((alert) => ({
        id: alert.alarmId,
        alarmId: alert.alarmId,
        deviceId: alert.deviceId,
        roomName: alert.room,
        type: alert.type,
        message: alert.type === 'NO_MOTION' ? '长时间未检测到活动' : '检测到异常',
        state: alert.status,
        ackPending: alert.ackPending,
        createdAt: alert.createdAt,
        acknowledgedAt: alert.acknowledgedAt,
        acknowledgedBy: alert.acknowledgedBy,
        evidenceId: alert.evidenceId || ''
      }));
  }

  getAlert(alarmId) {
    return this.alerts.get(alarmId) || null;
  }

  findAlertByEvidence(evidenceId, deviceId) {
    for (const alert of this.alerts.values()) {
      if (alert.evidenceId === evidenceId && alert.deviceId === deviceId) return alert;
    }
    return null;
  }

  toPublicDevice(device) {
    return {
      id: device.deviceId,
      deviceId: device.deviceId,
      name: `${device.room}节点`,
      roomId: device.room,
      roomName: device.room,
      location: '',
      online: device.online,
      monitorOnline: device.monitorOnline,
      state: device.state,
      lastSeenTs: device.receivedAt,
      sensors: device.sensors,
      csq: device.csq
    };
  }

  listPublicDevices() {
    return this.listDevices().map((device) => this.toPublicDevice(device));
  }

  latestLocation() {
    return this.listDevices()
      .filter((device) => device.gps.valid && device.gps.latitude !== null && device.gps.longitude !== null)
      .sort((a, b) => (b.gps.fixTime || b.ts) - (a.gps.fixTime || a.ts))[0]?.gps || null;
  }

  listLocations() {
    return this.listDevices()
      .filter((device) => device.gps.valid && device.gps.latitude !== null && device.gps.longitude !== null)
      .map((device) => ({
        deviceId: device.deviceId,
        location: `${device.gps.latitude.toFixed(6)}, ${device.gps.longitude.toFixed(6)}`,
        latitude: device.gps.latitude,
        longitude: device.gps.longitude,
        fixTime: device.gps.fixTime
      }));
  }

  overview() {
    const devices = this.listDevices();
    const alerts = this.listAlerts();
    return {
      generatedAt: Date.now(),
      deviceCount: devices.length,
      onlineCount: devices.filter((item) => item.online).length,
      monitorOfflineCount: devices.filter((item) => item.monitorOnline === 0).length,
      activeAlertCount: alerts.filter((item) => item.state !== 'ACKED').length,
      latestAlert: alerts[0] || null,
      location: this.latestLocation()
    };
  }

  /* ---------------------------------------------------- 告警处置结果 / 安全日志 */

  /**
   * 登记一条告警处置结果（独立于 ACK）。
   *
   * 硬性边界：本方法**只**追加安全日志，绝不触碰 `alerts` / `commands` / `devices`，
   * 因此不会把告警改成 ACKED、不会清 `ackPending`、不会生成 ACK 命令。
   *
   * 幂等键 = `alarmId + clientDispositionId`：
   *   - 同键同内容：`{created:false, duplicate:true, conflict:false, disposition: 已有记录}`；
   *   - 同键不同内容：`{created:false, duplicate:false, conflict:true, disposition: 已有记录}`；
   *   - 新键：追加记录并返回 `{created:true, ...}`。
   * 未知告警返回 `null`（由路由映射为 404），不伪造记录。
   *
   * @param {{alarmId: string, clientDispositionId: string, outcome: string, note?: string}} input
   * @param {number} [now] 服务端时间；生产路径使用 Date.now()，测试可传入固定值
   */
  createDisposition(input, now = Date.now()) {
    const source = input && typeof input === 'object' ? input : {};
    const alarmId = typeof source.alarmId === 'string' ? source.alarmId : '';
    if (!ALARM_ID_RE.test(alarmId)) throw new Error('invalid alarm id');
    const validated = validateDispositionInput({
      clientDispositionId: source.clientDispositionId,
      outcome: source.outcome,
      note: source.note
    });
    if (!validated.ok) throw new Error('invalid disposition');
    const alert = this.alerts.get(alarmId);
    if (!alert) return null;
    const { clientDispositionId, outcome, note } = validated.value;

    const existing = this.safetyLogs.find(
      (log) => log.alarmId === alarmId && log.clientDispositionId === clientDispositionId
    );
    if (existing) {
      const conflict = existing.outcome !== outcome || existing.note !== note;
      return {
        created: false,
        duplicate: conflict === false,
        conflict,
        disposition: existing
      };
    }

    const record = {
      dispositionId: this._allocateDispositionId(),
      clientDispositionId,
      alarmId,
      deviceId: alert.deviceId,
      room: alert.room,
      type: alert.type,
      outcome,
      note,
      actor: DISPOSITION_ACTOR,
      serverTime: Number.isSafeInteger(now) && now >= 0 ? now : Date.now()
    };
    this.safetyLogs.push(record);
    this._trimSafetyLogs();
    return { created: true, duplicate: false, conflict: false, disposition: record };
  }

  /** 单条告警的处置记录，按 `serverTime` 降序（同刻按 ID 数值降序）。未知/非法 alarmId 返回空数组。 */
  listDispositions(alarmId) {
    if (typeof alarmId !== 'string' || alarmId === '') return [];
    return this.safetyLogs
      .filter((log) => log.alarmId === alarmId)
      .sort(compareSafetyLogs);
  }

  /**
   * 安全日志历史（跨告警）。`limit` 取 1-200，非法值回退 50；可选 `alarmId` 过滤。
   * 该列表来自持久化台账本身，不是由当前 alerts 现场推导。
   */
  listSafetyLogs(options = {}) {
    const source = options && typeof options === 'object' ? options : {};
    const limit = Number.isSafeInteger(source.limit) && source.limit >= 1 && source.limit <= 200
      ? source.limit
      : 50;
    const alarmId = typeof source.alarmId === 'string' ? source.alarmId : '';
    return this.safetyLogs
      .filter((log) => alarmId === '' || log.alarmId === alarmId)
      .sort(compareSafetyLogs)
      .slice(0, limit);
  }

  /** 按处置 ID 读取；非法 ID 或不存返回 null（不抛异常）。 */
  getDisposition(dispositionId) {
    if (typeof dispositionId !== 'string' || !DISPOSITION_ID_RE.test(dispositionId)) return null;
    return this.safetyLogs.find((log) => log.dispositionId === dispositionId) || null;
  }

  /**
   * 分配处置 ID。内存实现取"现有台账中的最大 ID + 1"；
   * PersistentStore 覆盖为基于 `_maxDispositionId` 的单调分配（重启不复用）。
   */
  _allocateDispositionId() {
    let max = 0;
    for (const log of this.safetyLogs) {
      const numeric = Number(log.dispositionId.slice(4));
      if (Number.isSafeInteger(numeric) && numeric > max) max = numeric;
    }
    this._maxDispositionId = Number.isSafeInteger(this._maxDispositionId) ? Math.max(this._maxDispositionId, max) : max;
    const next = this._maxDispositionId + 1;
    if (!Number.isSafeInteger(next) || next <= 0 || !DISPOSITION_ID_RE.test(`dsp-${next}`)) {
      throw new Error('disposition id space exhausted');
    }
    this._maxDispositionId = next;
    return `dsp-${next}`;
  }

  /** 台账容量上限：按写入顺序淘汰最旧（必须在写盘前调用）。 */
  _trimSafetyLogs() {
    if (this.safetyLogs.length <= SAFETY_LOG_CAP) return;
    this.safetyLogs.splice(0, this.safetyLogs.length - SAFETY_LOG_CAP);
  }

  requestAck(alarmId, action, requestedBy, now = Date.now()) {
    if (!ALARM_ID_RE.test(alarmId || '')) throw new Error('invalid alarm id');
    const alert = this.alerts.get(alarmId);
    if (!alert) return null;
    if (alert.status === 'ACKED') throw new Error('alarm already acknowledged');
    const cleanAction = boundedText(action, 120, '监护人已确认').replace(/\r|\n/g, ' ');
    const pending = this.commands.find((item) => item.alarmId === alarmId && item.status === 'PENDING');
    if (pending) return pending;
    const command = {
      id: String(this.commands.length + 1),
      createdAt: now,
      requestedBy,
      deviceId: alert.deviceId,
      command: 'ACK',
      alarmId,
      action: cleanAction,
      status: 'PENDING'
    };
    this.commands.push(command);
    alert.ackPending = true;
    alert.action = cleanAction;
    return command;
  }

  listCommands(afterId = 0) {
    return this.commands.filter((item) => Number(item.id) > afterId);
  }

  completeCommand(commandId, result, now = Date.now()) {
    if (!COMMAND_ID_RE.test(commandId || '')) throw new Error('invalid command id');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid command result');
    const command = this.commands.find((item) => item.id === commandId);
    if (!command) return null;
    if (result.status !== 'ACKED' && result.status !== 'FAILED') throw new Error('invalid command result status');

    if (command.status !== 'PENDING') {
      if (command.status !== result.status) throw new Error('command result conflicts with completed command');
      return command;
    }

    const alert = this.alerts.get(command.alarmId);
    if (!alert || alert.deviceId !== command.deviceId) throw new Error('command alert binding mismatch');

    if (result.status === 'FAILED') {
      const code = typeof result.code === 'string' ? result.code : '';
      if (!RESULT_CODE_RE.test(code)) throw new Error('invalid command failure code');
      command.status = 'FAILED';
      command.completedAt = now;
      command.resultCode = code;
      alert.ackPending = false;
      return command;
    }

    const rawDeviceState = result.deviceState;
    const deviceState = normalizeStatus(rawDeviceState, now);
    const previousDevice = this.devices.get(command.deviceId);
    // Command receipts contain only the fields needed to prove ACK. Preserve
    // telemetry omitted by that partial receipt instead of replacing it with
    // normalizeStatus defaults and persisting false "unknown" values.
    if (previousDevice) {
      if (rawDeviceState.monitorOnline === undefined) deviceState.monitorOnline = previousDevice.monitorOnline;
      if (rawDeviceState.sensors === undefined) deviceState.sensors = previousDevice.sensors;
      if (rawDeviceState.gps === undefined) deviceState.gps = previousDevice.gps;
      if (rawDeviceState.csq === undefined) deviceState.csq = previousDevice.csq;
    }
    if (deviceState.deviceId !== command.deviceId ||
        deviceState.state !== 'ACKED' ||
        deviceState.alarm.id !== command.alarmId ||
        (deviceState.alarm.evidenceId && alert.evidenceId && deviceState.alarm.evidenceId !== alert.evidenceId)) {
      throw new Error('device receipt does not match command binding');
    }

    this.devices.set(deviceState.deviceId, deviceState);
    command.status = 'ACKED';
    command.completedAt = now;
    command.resultCode = '';
    alert.status = 'ACKED';
    alert.ackPending = false;
    alert.acknowledgedAt = deviceState.ts || now;
    alert.acknowledgedBy = command.requestedBy;
    return command;
  }
}

module.exports = {
  ALARM_ID_RE,
  COMMAND_ID_RE,
  DEVICE_ID_RE,
  EVIDENCE_ID_RE,
  MemoryStore,
  normalizeStatus
};

