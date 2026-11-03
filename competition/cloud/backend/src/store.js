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
/**
 * 电量（契约 BATTERY-CHAIN-CONTRACT.md §2/§5）。后端不默认 0：没有电池数据就是 null，
 * APP 显示“电量未知”；非法 battery 也只降级为无电量并记内部 code，绝不让整条设备状态被丢弃。
 */
const BATTERY_SOURCES = new Set(['battery', 'fixed']);
const BATTERY_FIELDS = ['source', 'present', 'valid', 'mv', 'percent', 'low', 'calibrated', 'reason'];
const BATTERY_REASON_RE = /^[A-Z_]{0,16}$/;
const BATTERY_MV_MAX = 60000;

/** 门磁开关事件台账容量上限（全局，按写入顺序淘汰最旧，避免无限增长）。 */
const DOOR_EVENT_CAP = 2000;
/** 门磁事件 ID 格式：`dr-<单调整数>`（与 D 类 `dsp-<n>` 同一分配模式）。 */
const DOOR_EVENT_ID_RE = /^dr-[1-9][0-9]{0,15}$/;
const WEARABLE_LOCATION_DEVICE_ID = 'wearable-sos-001';

function boundedText(value, max, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeWearableLocation(input, receivedAt = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('location must be an object');
  const deviceId = typeof input.deviceId === 'string' && input.deviceId.trim() ? input.deviceId.trim() : WEARABLE_LOCATION_DEVICE_ID;
  if (deviceId !== WEARABLE_LOCATION_DEVICE_ID) throw new Error('invalid wearable deviceId');
  if (!Number.isSafeInteger(input.seq) || input.seq <= 0) throw new Error('invalid location seq');
  const fixValid = input.fixValid === true;
  const latitude = finiteOrNull(input.latitude);
  const longitude = finiteOrNull(input.longitude);
  if (fixValid) {
    if (latitude === null || latitude < -90 || latitude > 90) throw new Error('invalid latitude');
    if (longitude === null || longitude < -180 || longitude > 180) throw new Error('invalid longitude');
    if (latitude === 0 && longitude === 0) throw new Error('invalid zero coordinate');
  }
  const positionTime = Number.isSafeInteger(input.positionTime) && input.positionTime >= 0
    ? input.positionTime : receivedAt;
  return {
    deviceId,
    seq: input.seq,
    fixValid,
    latitude,
    longitude,
    positionTime,
    receivedAt
  };
}

/**
 * 安全日志排序：`serverTime` 降序，同刻按 `dispositionId` 的数值降序
 * （与合同 §2.2/§2.3 一致；ID 是单调递增的，因此同刻排序是稳定且确定的）。
 */
function compareSafetyLogs(left, right) {
  if (right.serverTime !== left.serverTime) return right.serverTime - left.serverTime;
  return Number(right.dispositionId.slice(4)) - Number(left.dispositionId.slice(4));
}

/**
 * 归一化一台设备的电量快照，返回 { battery, code }：battery 为 null 表示没有数据或非法
 * 降级；code 为 null 表示正常，否则是内部诊断码，只用于日志，绝不透出给 APP 当电量。
 *
 * 严格程度与 adapter.js 对齐（未知字段、类型、范围、自相矛盾都不接受），但不抛异常：
 * 契约 §5 要求非法 battery 不得导致设备状态整体丢弃。deviceId/state 等仍由 normalizeStatus
 * 严格校验，所以这里的降级不会掩盖真正的报文损坏。
 */
function normalizeBattery(input) {
  if (input === undefined || input === null) return { battery: null, code: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
  }
  for (const key of Object.keys(input)) {
    if (!BATTERY_FIELDS.includes(key)) return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
  }
  const source = input.source;
  if (typeof source !== 'string' || !BATTERY_SOURCES.has(source)) {
    return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
  }
  for (const key of ['present', 'valid', 'low', 'calibrated']) {
    if (typeof input[key] !== 'boolean') return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
  }
  const mv = input.mv === null ? null : input.mv;
  if (mv !== null && (!Number.isSafeInteger(mv) || mv < 0 || mv > BATTERY_MV_MAX)) {
    return { battery: null, code: 'BATTERY_OUT_OF_RANGE' };
  }
  const percent = input.percent === null ? null : input.percent;
  if (percent !== null && (!Number.isSafeInteger(percent) || percent < 0 || percent > 100)) {
    return { battery: null, code: 'BATTERY_OUT_OF_RANGE' };
  }
  const reason = input.reason === undefined ? '' : input.reason;
  if (typeof reason !== 'string' || !BATTERY_REASON_RE.test(reason)) {
    return { battery: null, code: 'BATTERY_INVALID_SHAPE' };
  }
  const { present, valid, low, calibrated } = input;
  if (source === 'fixed') {
    if (present || valid || low || mv !== null || percent !== null) {
      return { battery: null, code: 'BATTERY_INCONSISTENT' };
    }
  }
  if (valid) {
    if (source !== 'battery') return { battery: null, code: 'BATTERY_INCONSISTENT' };
    /* mv=0 是“未接线/悬空拉到地”的典型读数，绝不能当成有效电量 */
    if (mv === null || mv <= 0) return { battery: null, code: 'BATTERY_INCONSISTENT' };
  } else if (mv !== null || percent !== null || low) {
    return { battery: null, code: 'BATTERY_INCONSISTENT' };
  }
  if (percent !== null && (!calibrated || !valid)) {
    return { battery: null, code: 'BATTERY_INCONSISTENT' };
  }
  return { battery: { source, present, valid, mv, percent, low, calibrated, reason }, code: null };
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
  const battery = normalizeBattery(input.battery);
  return {
    deviceId: input.deviceId,
    room: boundedText(input.room, 32, '未分配'),
    online: input.online !== false,
    monitorOnline,
    state: input.state,
    ts,
    receivedAt,
    sensors,
    /* 电量：null = 无数据/非法降级（APP 显示“电量未知”），绝不默认 0。 */
    battery: battery.battery,
    batteryRejectCode: battery.code,
    alarm: {
      id: alarmId,
      type: boundedText(alarm.type, 32),
      // 只能是“非负安全整数”：与 persistent-store 的加载校验保持一致，
      // 否则负值会先被接受、重启加载后又变 0（同一事件两个 countToday 语义）。
      countToday: Number.isSafeInteger(alarm.countToday) && alarm.countToday >= 0 ? alarm.countToday : 0,
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
    /**
     * 门磁开关事件台账：按写入顺序保存，容量上限 DOOR_EVENT_CAP。
     * 与 devices 当前状态完全独立：只记录"确认的状态变化"（含设备端补传缓存），
     * 重复上报相同状态不产生新事件；首次摄入只建立基线。
     */
    this.doorEvents = [];
    this._maxDoorEventId = 0;
    /** M100 独立 GNSS 台账；不写入 devices，避免覆盖 ESP32 状态。 */
    this.wearableLocations = new Map();
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
    /* 非法电量只降级为“无电量”，但必须留下可追踪的安全错误码（契约 §5）。
     * 绝不把 code 当电量字段透出给 APP。 */
    if (status.batteryRejectCode) {
      console.warn(`[store] BATTERY_REJECTED code=${status.batteryRejectCode} device=${status.deviceId}`);
    }
    // 先校验完所有绑定再改 devices 和 alerts；ACKED/NORMAL 重复上报也走这一步，
    // 不只是新告警快照。
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
    // 门磁事件检测必须在覆盖本设备状态之前对比"上次已确认状态"。
    this._recordDoorEvents(status, receivedAt);
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

  ingestWearableLocation(input, receivedAt = Date.now()) {
    const location = normalizeWearableLocation(input, receivedAt);
    const prior = this.wearableLocations.get(location.deviceId);
    if (prior && location.seq < prior.seq) {
      return { accepted: true, duplicate: true, stale: true, location: prior };
    }
    if (prior && location.seq === prior.seq) {
      if (JSON.stringify({ ...prior, receivedAt: 0 }) !== JSON.stringify({ ...location, receivedAt: 0 })) {
        throw new Error('location seq conflict');
      }
      return { accepted: true, duplicate: true, stale: false, location: prior };
    }
    this.wearableLocations.set(location.deviceId, location);
    return { accepted: true, duplicate: false, stale: false, location };
  }

  getWearableLocation(deviceId = WEARABLE_LOCATION_DEVICE_ID) {
    return this.wearableLocations.get(deviceId) || null;
  }

  getWearableAlertLocation(alert, now = Date.now()) {
    if (!alert || alert.type !== 'MANUAL_SOS' || alert.deviceId !== 'esp32-sos') return null;
    const record = this.getWearableLocation();
    if (!record) return { status: 'UNAVAILABLE', latitude: null, longitude: null, positionTime: 0, receivedAt: 0, ageSeconds: null };
    const ageSeconds = Math.max(0, Math.floor((now - record.receivedAt) / 1000));
    const status = record.fixValid && record.latitude !== null && record.longitude !== null
      ? (ageSeconds <= 120 ? 'LOCATED' : 'STALE') : 'UNAVAILABLE';
    return {
      status,
      latitude: status === 'UNAVAILABLE' ? null : record.latitude,
      longitude: status === 'UNAVAILABLE' ? null : record.longitude,
      positionTime: record.positionTime,
      receivedAt: record.receivedAt,
      ageSeconds
    };
  }

  /* ---- 门磁开关事件 ---- */

  /**
   * 从一次摄入里提取门磁开关事件。载荷没有 sensors.door 就什么都不做；有固件补传缓存
   * door.events 时按 (deviceId, seq) 幂等去重；没有补传时用“当前 open 与上次已确认不同”
   * 兜底；首次摄入或上次没有 door 数据时只建基线，不凭空生成事件。事件时间优先取可信
   * 设备时间并标 timeSource=device，否则用服务器接收时间并标 server，不把接收时间冒充设备时间。
   */
  _recordDoorEvents(status, receivedAt) {
    const sensors = status.sensors && typeof status.sensors === 'object' ? status.sensors : {};
    const door = sensors.door && typeof sensors.door === 'object' ? sensors.door : null;
    if (!door) return;
    const prior = this.devices.get(status.deviceId);
    const priorDoor = prior && prior.sensors && typeof prior.sensors === 'object'
      ? prior.sensors.door : null;

    // 1) 设备端补传缓存（权威事件序列，按 seq 幂等）。
    const events = Array.isArray(door.events) ? door.events : [];
    let lastEventOpen = null;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const seq = Number.isSafeInteger(ev.seq) && ev.seq > 0 ? ev.seq : 0;
      if (seq === 0) continue;                     // 无 seq 无法幂等去重，丢弃
      const open = ev.open === true;
      const deviceTs = Number.isSafeInteger(ev.ts) && ev.ts > 0 ? ev.ts : 0;
      // 无论本条是否因幂等跳过，都要跟踪"最后一条有效事件的状态"：
      // 设备补传时间线总是以最新状态结尾，只有它与当前 open 不一致时状态变化兜底才应触发，
      // 否则重试/重连/重启重传会重复生成 state-change 事件。
      lastEventOpen = open;
      if (this._doorEventExists(status.deviceId, seq)) continue;  // 重试/重连/重复上传去重
      this._appendDoorEvent({
        eventId: this._allocateDoorEventId(),
        deviceId: status.deviceId,
        room: status.room,
        open,
        occurredAt: deviceTs > 0 ? deviceTs : receivedAt,
        timeSource: deviceTs > 0 ? 'device' : 'server',
        seq,
        source: 'device-cache'
      });
      lastEventOpen = open;
    }

    // 2) 状态变化兜底：仅在"无补传事件表达该变化"时生成，
    //    避免同一变化既走 events 又走状态对比而重复记账。
    if (typeof door.open === 'boolean' && priorDoor && typeof priorDoor.open === 'boolean') {
      const lastEventCoversChange = lastEventOpen !== null && lastEventOpen === door.open;
      if (!lastEventCoversChange && door.open !== priorDoor.open) {
        const deviceTs = Number.isSafeInteger(status.ts) && status.ts > 0 ? status.ts : 0;
        this._appendDoorEvent({
          eventId: this._allocateDoorEventId(),
          deviceId: status.deviceId,
          room: status.room,
          open: door.open,
          occurredAt: deviceTs > 0 ? deviceTs : receivedAt,
          timeSource: deviceTs > 0 ? 'device' : 'server',
          seq: 0,
          source: 'state-change'
        });
      }
    }
  }

  _doorEventExists(deviceId, seq) {
    for (const record of this.doorEvents) {
      if (record.deviceId === deviceId && record.seq === seq) return true;
    }
    return false;
  }

  _appendDoorEvent(record) {
    this.doorEvents.push(record);
    this._trimDoorEvents();
  }

  /**
   * 分配门磁事件 ID。内存实现取"现有台账中的最大 ID + 1"；
   * PersistentStore 覆盖为基于 `_maxDoorEventId` 的单调分配（重启不复用）。
   */
  _allocateDoorEventId() {
    let max = 0;
    for (const record of this.doorEvents) {
      const numeric = Number(record.eventId.slice(3));
      if (Number.isSafeInteger(numeric) && numeric > max) max = numeric;
    }
    this._maxDoorEventId = Number.isSafeInteger(this._maxDoorEventId) ? Math.max(this._maxDoorEventId, max) : max;
    const next = this._maxDoorEventId + 1;
    if (!Number.isSafeInteger(next) || next <= 0 || !DOOR_EVENT_ID_RE.test(`dr-${next}`)) {
      throw new Error('door event id space exhausted');
    }
    this._maxDoorEventId = next;
    return `dr-${next}`;
  }

  /** 台账容量上限：按写入顺序淘汰最旧（必须在写盘前调用）。 */
  _trimDoorEvents() {
    if (this.doorEvents.length <= DOOR_EVENT_CAP) return;
    this.doorEvents.splice(0, this.doorEvents.length - DOOR_EVENT_CAP);
  }

  /** 门磁事件历史（跨房间）。deviceId 为空返回全部；limit 1-100，非法值回退 20。
   *  按 eventId 数值降序，最新事件在前，顺序稳定可核对。 */
  listDoorEvents(deviceId = '', limit = 20) {
    const count = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;
    return this.doorEvents
      .filter((record) => deviceId === '' || record.deviceId === deviceId)
      .slice()
      .sort((left, right) => Number(right.eventId.slice(3)) - Number(left.eventId.slice(3)))
      .slice(0, count);
  }

  /** 按事件 ID 读取；非法 ID 或不存返回 null（不抛异常）。 */
  getDoorEvent(eventId) {
    if (typeof eventId !== 'string' || !DOOR_EVENT_ID_RE.test(eventId)) return null;
    return this.doorEvents.find((record) => record.eventId === eventId) || null;
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
    const publicDevice = {
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
    /* 电量（契约 §5）：有真实数据才透出，没有时字段本身不出现，APP 依据缺失显示“电量未知”，
     * 不会被默认成 0% 或假电压。batteryRejectCode 只是内部诊断码，不进入对外序列化。 */
    if (device.battery) publicDevice.battery = device.battery;
    return publicDevice;
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

  /* ---- 告警处置结果 / 安全日志 ---- */

  /**
   * 登记一条告警处置结果（独立于 ACK）。
   *
   * 只追加安全日志，绝不碰 alerts / commands / devices，所以不会把告警改成 ACKED、
   * 不会清 ackPending、不会生成 ACK 命令。幂等键是 alarmId + clientDispositionId：
   * 同键同内容返回 duplicate，同键不同内容返回 conflict，新键才追加；未知告警返回 null
   *（路由映射为 404），不伪造记录。
   *
   * @param {{alarmId: string, clientDispositionId: string, outcome: string, note?: string}} input
   * @param {number} [now] 服务端时间，生产用 Date.now()，测试可传固定值
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
    // 命令回执只带证明 ACK 所需的字段，normalizeStatus 的默认值不能覆盖回执省略的遥测，
    // 否则会把“未知”当真值持久化。
    if (previousDevice) {
      if (rawDeviceState.monitorOnline === undefined) deviceState.monitorOnline = previousDevice.monitorOnline;
      if (rawDeviceState.sensors === undefined) deviceState.sensors = previousDevice.sensors;
      if (rawDeviceState.gps === undefined) deviceState.gps = previousDevice.gps;
      if (rawDeviceState.csq === undefined) deviceState.csq = previousDevice.csq;
      /* 部分回执（ACK 只证明状态变更）没带 battery 时保留上次真实电量，
       * 不能被 normalizeStatus 的“无电量”默认值覆盖成 null。 */
      if (rawDeviceState.battery === undefined) deviceState.battery = previousDevice.battery;
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
  BATTERY_FIELDS,
  BATTERY_MV_MAX,
  BATTERY_REASON_RE,
  BATTERY_SOURCES,
  COMMAND_ID_RE,
  DEVICE_ID_RE,
  DOOR_EVENT_CAP,
  DOOR_EVENT_ID_RE,
  EVIDENCE_ID_RE,
  MemoryStore,
  normalizeBattery,
  normalizeStatus,
  normalizeWearableLocation,
  WEARABLE_LOCATION_DEVICE_ID
};

