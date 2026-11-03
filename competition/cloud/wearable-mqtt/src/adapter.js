'use strict';

/**
 * adapter.js — 设备 MQTT 报文 ↔ 可信后端契约的适配器（与 broker 同进程）。
 *
 * 职责（严格按 DESIGN-CONTRACT.md 第 3/4/5 节）：
 *   上行 SOS   -> POST /internal/v1/device-status（ALARM + MANUAL_SOS + GPS），本地短时去重；
 *   上行 hb    -> 更新设备在线状态（NORMAL/ALARM），保证 APP 可见 online/lastSeen；
 *   上行 boot  -> 设备重启后立即恢复在线状态；
 *   上行 GPS   -> M100 固定格式（经度_纬度，WGS84）-> GET /api/v1/ingest/wearable/location；
 *   下行 ACK   -> 轮询 /internal/v1/commands?after=N，只领取本设备 PENDING ACK 命令并发布到 down 主题；
 *   设备回执   -> 只有收到设备真实 `t:"ack"` 且 alarm/cmd 匹配，才 POST /commands/<id>/result(ACKED)。
 *
 * 断连自愈（2026-10-27 修复，见 evidence/2026-10-27-reconnect-dayu-sos/wearable-link）：
 *   1) 链路恢复事件驱动：broker clientConnect 或任一业务上行（boot/hb/sos/ack）到达时，
 *      立即把 parked 的 ACK 命令恢复为“可重投”，不再等 60s/5min 定时器，也不需要 docker restart；
 *   2) 业务上行静默看门狗：sos/hb/boot/ack 连续静默超过 DEVICE_ALIVE_TIMEOUT_MS（默认 120s）
 *      才如实上报 online=false（恢复时首个业务上行立即 online=true），避免 M100 短暂重连抖动；
 *      M100 自己主动上报的 GPS 固定格式行不算“设备存活”，否则 ESP32 断电会被掩盖；
 *   3) 设备重启时 boot 不再盲目把状态报成 NORMAL：仍存在未确认告警时保持 ALARM（不伪造“已解除”）；
 *      只有设备后续明确上报 IDLE 心跳才清除本地未确认事件（并计数/告警日志，绝不代报 ACKED）。
 *
 * 绝不做的三件事（安全/语义边界）：
 *   1. 无设备回执时**绝不**代报 ACKED/FAILED，后端命令保持 PENDING；
 *   2. 解析失败**绝不**写入假坐标（只记诊断码）；
 *   3. 其他 deviceId 的命令**绝不**猜设备下发（只推进游标，不广播）。
 */

const { parseGpsFixedFormat } = require('./gps-parser');
const { safeErrorCode } = require('./logger');

const ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const COMMAND_ID_RE = /^[1-9][0-9]{0,15}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const MAX_DEDUPE_ENTRIES = 512;
const MAX_SETTLED_ENTRIES = 1024;
const MAX_PARKED_ENTRIES = 64;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numericCommandId(value) {
  if (typeof value === 'string' && COMMAND_ID_RE.test(value)) return Number(value);
  return 0;
}

class WearableAdapter {
  /**
   * @param {object} options
   * @param {import('./mqtt-broker').MqttBroker} options.broker
   * @param {import('./backend-client').BackendClient} options.backend
   * @param {import('./state-store').StateStore} options.state
   * @param {object} options.config loadConfig() 结果
   * @param {object} [options.logger]
   * @param {() => number} [options.now]
   */
  constructor(options) {
    if (!options || !options.broker || !options.backend || !options.state || !options.config) {
      throw new TypeError('WearableAdapter requires broker, backend, state and config');
    }
    this.broker = options.broker;
    this.backend = options.backend;
    this.state = options.state;
    this.config = options.config;
    this.logger = options.logger || null;
    this.now = typeof options.now === 'function' ? options.now : Date.now;

    /** alarmId -> {status:'inflight'|'sent'|'failed', at, countToday} */
    this.dedupe = new Map();
    /** commandId -> {command:{id,alarmId,action}, attempts, round, nextAt, timer} */
    this.inflight = new Map();
    /** commandId -> {command, round, parkedAt, nextCheckAt} */
    this.parked = new Map();
    /** commandId -> {command, body, attempts, nextAt, inFlight} */
    this.pendingResults = new Map();
    /** commandId -> {status, at} 已成功回写 */
    this.settled = new Map();

    this.device = {
      deviceId: this.config.deviceId,
      room: this.config.room,
      online: false,
      state: 'NORMAL',
      alarmId: '',
      ts: 0,
      lastSeen: 0,
      /**
       * 最后一次“业务上行”（sos/hb/boot/ack；不含 M100 固定格式 GPS 行）的时间。
       * 离线看门狗只看这个字段，防止 M100 仍在上报 GPS 时掩盖 ESP32 已断电。
       */
      lastBusinessUplinkAt: 0,
      /** 是否从设备收到过任何业务上行（含从持久化缓存恢复）。 */
      known: false,
      csq: null,
      source: 'init'
    };
    /**
     * 最新一次有效 GPS 定位（M100 固定格式解析结果）。
     * @type {{latitude:number, longitude:number, fixTime:number, receivedAt:number, format:string, seq:number}|null}
     */
    this.latestGps = null;
    /**
     * 当前未 ACK 的求助事件快照：
     * {alarmId, startedAt, eventGps:{valid,latitude,longitude,fixTime}}。
     * 事件未 ACK 前所有 device-status 的 gps 都用 eventGps（求助时刻位置），
     * 不被后续 GPS 报文覆盖；设备真实 ack 后清除并恢复发最新位置。
     * @type {{alarmId:string, startedAt:number, eventGps:object}|null}
     */
    this.activeAlarm = null;
    this.lastUplinkAt = 0;
    this.lastPoll = { at: 0, ok: false, code: 'NEVER', after: 0 };
    this.running = false;
    this.startedAt = 0;
    this._pollTimer = null;
    this._polling = false;
    this._pollFailures = 0;
    /** 业务上行静默看门狗（离线判定去抖用）。 */
    this._aliveTimer = null;
    /** 已向上报过 online=false（同一段静默期只报一次，避免刷接口）。 */
    this._offlineReported = false;
    this._onMessageBound = (message) => this._onMessage(message);
    this._onClientConnectBound = (info) => this._onClientConnect(info);
    this._onClientDisconnectBound = (info) => this._onClientDisconnect(info);

    this.counters = {
      uplinks: 0,
      ignoredTopic: 0,
      ignoredPayload: 0,
      malformedJson: 0,
      unknownType: 0,
      invalidMessage: 0,
      sosReceived: 0,
      sosDuplicates: 0,
      sosInvalid: 0,
      deviceStatusOk: 0,
      deviceStatusFailed: 0,
      hbReceived: 0,
      bootReceived: 0,
      gpsMessages: 0,
      gpsParsed: 0,
      gpsParseFailures: 0,
      gpsEventSnapshots: 0,
      gpsEventLocked: 0,
      sosGpsFromPayload: 0,
      sosGpsFromLatest: 0,
      sosGpsUnavailable: 0,
      ackReceipts: 0,
      ackReceiptRejected: 0,
      ackReceiptUnknown: 0,
      ackReceiptDuplicate: 0,
      commandPolls: 0,
      commandPollFailed: 0,
      commandsReceived: 0,
      commandsIgnored: 0,
      commandsPublished: 0,
      commandPublishFailures: 0,
      commandPublishNoSubscriber: 0,
      commandsParked: 0,
      commandsExpired: 0,
      commandsRedelivered: 0,
      commandResultOk: 0,
      commandResultFailed: 0,
      /* ---- 断连自愈相关（2026-10-27） ---- */
      deviceLinkUps: 0,
      deviceLinkDowns: 0,
      deviceOfflineReports: 0,
      deviceStateRestored: 0,
      parkedRecoveryTriggers: 0,
      parkedLookupMissing: 0,
      activeEventClearedByDevice: 0,
      activeEventReplacedByDevice: 0,
      stateWriteFailures: 0,
      lastErrorCode: '',
      lastErrorAt: 0
    };
  }

  /* ---------------------------------------------------------------- 生命周期 */

  start() {
    if (this.running) return this;
    this.running = true;
    this.startedAt = this.now();
    this.broker.on('message', this._onMessageBound);
    // 链路事件：设备（M100）重连后立即恢复未确认 ACK 命令的重投（无需重启容器）。
    this.broker.on('clientConnect', this._onClientConnectBound);
    this.broker.on('clientDisconnect', this._onClientDisconnectBound);
    // 进程重启：用持久化的“最后已知设备状态”（不含坐标）恢复认知；
    // 若设备此后一直不回来，看门狗会如实上报 online=false（而不是让后端永远保留旧 online=true）。
    this._restoreDeviceSnapshot();
    this._schedulePoll(0);
    this._log('info', 'ADAPTER_STARTED', {
      deviceId: this.config.deviceId,
      deviceClientId: this.config.deviceClientId,
      upTopic: this.config.upTopic,
      downTopic: this.config.downTopic,
      deviceAliveTimeoutMs: this.config.device.aliveTimeoutMs
    });
    return this;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._aliveTimer) {
      clearTimeout(this._aliveTimer);
      this._aliveTimer = null;
    }
    for (const runtime of this.inflight.values()) {
      if (runtime.timer) clearTimeout(runtime.timer);
    }
    this.inflight.clear();
    this.broker.removeListener('message', this._onMessageBound);
    this.broker.removeListener('clientConnect', this._onClientConnectBound);
    this.broker.removeListener('clientDisconnect', this._onClientDisconnectBound);
    this._log('info', 'ADAPTER_STOPPED', {});
  }

  /* ------------------------------------------------------- 链路/在线自愈 */

  _isDeviceClient(info) {
    return Boolean(info) && typeof info.clientId === 'string' &&
      info.clientId === this.config.deviceClientId;
  }

  /**
   * 设备（M100）MQTT 链路重新建立。
   *
   * 这里**不**改写在线态、也不代发任何上行：在线/状态只由设备真实报文（boot/hb）决定。
   * 只做一件事——把 parked 的 ACK 命令恢复为“立即可重投”，这正是以前必须
   * `docker restart wearable-mqtt` 才能达到的效果（重启=清空内存 parked 后重新领取）。
   */
  _onClientConnect(info) {
    if (!this.running || !this._isDeviceClient(info)) return;
    this.counters.deviceLinkUps += 1;
    this._log('info', 'DEVICE_LINK_UP', { clientId: this.config.deviceClientId });
    this._recoverParkedCommands('LINK_UP');
  }

  _onClientDisconnect(info) {
    if (!this.running || !this._isDeviceClient(info)) return;
    this.counters.deviceLinkDowns += 1;
    // 不立即报 offline：M100 短暂重连很常见，直接上报会让 APP 闪“离线”。
    // 统一由“业务上行静默看门狗”去抖（默认 120s ≈ 4 个心跳周期）后判定。
    this._log('info', 'DEVICE_LINK_DOWN', {
      clientId: this.config.deviceClientId,
      code: typeof info.code === 'string' ? info.code : '',
      clean: info.clean === true
    });
  }

  /**
   * 业务上行（sos/hb/boot/ack）到达：刷新存活、持久化最后已知状态、恢复 parked 命令。
   * @param {string} source 上行业务类型（诊断用）
   * @param {number} [atMs] 该报文被处理的服务器时间（由调用方传入，保证与 device-status.ts 完全一致）
   */
  _noteDeviceAlive(source, atMs) {
    const nowMs = Number.isFinite(atMs) ? atMs : this.now();
    this.device = { ...this.device, known: true, lastBusinessUplinkAt: nowMs };
    this._offlineReported = false;
    this._armAliveWatchdog();
    this._persistDeviceSnapshot();
    this._recoverParkedCommands(source);
  }

  /**
   * 设备刚被证明存活：把 parked 命令的“下次回读时间”清零并重置轮次，
   * 让下一次轮询（默认 ≤1s）立即回读后端并重投；同时把 slow 慢速重投降回正常节奏。
   * 只影响本地投递节奏，不改后端命令状态、不代报结果。
   */
  _recoverParkedCommands(source) {
    if (!this.running || this.parked.size === 0) return 0;
    const maxRounds = Math.max(1, this.config.poll.maxRounds);
    for (const entry of this.parked.values()) {
      entry.nextCheckAt = 0;
      entry.slow = false;
      if (entry.round >= maxRounds) entry.round = Math.max(1, maxRounds - 1);
    }
    const count = this.parked.size;
    this.counters.parkedRecoveryTriggers += count;
    this._log('info', 'PARKED_RECOVERY_TRIGGERED', { source, count });
    return count;
  }

  _armAliveWatchdog(delayMs) {
    if (!this.running) return;
    if (this._aliveTimer) {
      clearTimeout(this._aliveTimer);
      this._aliveTimer = null;
    }
    const timeoutMs = this.config.device.aliveTimeoutMs;
    const delay = Math.max(1, delayMs === undefined ? timeoutMs : delayMs);
    this._aliveTimer = setTimeout(() => {
      this._aliveTimer = null;
      this._onAliveTimeout();
    }, delay);
    if (typeof this._aliveTimer.unref === 'function') this._aliveTimer.unref();
  }

  /** 业务上行静默超时：如实上报 online=false（保持最后已知 state/alarm，不伪造设备时间）。 */
  _onAliveTimeout() {
    if (!this.running) return;
    if (this._offlineReported) return;
    if (!this.device.known) return;
    const timeoutMs = this.config.device.aliveTimeoutMs;
    const silentMs = this.device.lastBusinessUplinkAt > 0
      ? this.now() - this.device.lastBusinessUplinkAt
      : Number.POSITIVE_INFINITY;
    // 去抖：定时器即便提前触发，也必须真正静默够 timeout 才报离线。
    if (silentMs < timeoutMs) {
      this._armAliveWatchdog(timeoutMs - silentMs);
      return;
    }
    this._offlineReported = true;
    this.counters.deviceOfflineReports += 1;
    this.device = { ...this.device, online: false, source: 'timeout' };
    const body = this._buildStatusBody(this.device.state, false, this._activeAlarmId());
    // 不使用 PC 当前时间冒充设备时间：ts 用最后一次真实业务上行时间。
    body.ts = this.device.lastBusinessUplinkAt > 0 ? this.device.lastBusinessUplinkAt : this.device.lastSeen;
    this._postDeviceStatus(body, 'DEVICE_OFFLINE').catch(() => {});
    this._persistDeviceSnapshot();
    this._log('warn', 'DEVICE_UPLINK_TIMEOUT', {
      silentMs: Number.isFinite(silentMs) ? silentMs : -1,
      timeoutMs,
      state: this.device.state,
      hasActiveAlarm: this.activeAlarm !== null
    });
  }

  _activeAlarmId() {
    if (this.activeAlarm) return this.activeAlarm.alarmId;
    return typeof this.device.alarmId === 'string' ? this.device.alarmId : '';
  }

  /** 构造 device-status 载荷（boot/离线等通用路径；SOS/hb/回执照旧各自构造以保持既有字段）。 */
  _buildStatusBody(state, online, alarmId) {
    const nowMs = this.now();
    const body = {
      deviceId: this.config.deviceId,
      room: this.config.room,
      state,
      online,
      monitorOnline: -1,
      ts: nowMs,
      alarm: { id: '' },
      gps: this._gpsForStatus()
    };
    if (alarmId && (state === 'ALARM' || state === 'ACKED')) {
      let countToday = 1;
      try {
        countToday = Math.max(1, this.state.todaySosCount());
      } catch {
        countToday = 1;
      }
      body.alarm = { id: alarmId, type: 'MANUAL_SOS', countToday };
    }
    if (Number.isInteger(this.device.csq) && this.device.csq >= 0 && this.device.csq <= 99) {
      body.csq = this.device.csq;
    }
    return body;
  }

  /** 恢复持久化的“最后已知设备状态”（不含坐标）；不据此声称 online=true。 */
  _restoreDeviceSnapshot() {
    let snapshot = null;
    try {
      if (typeof this.state.getDeviceSnapshot === 'function') snapshot = this.state.getDeviceSnapshot();
    } catch (error) {
      this.counters.stateWriteFailures += 1;
      this._recordError(safeErrorCode(error, 'STATE_WRITE_FAILED'));
      this._log('warn', 'DEVICE_SNAPSHOT_RESTORE_FAILED', { code: safeErrorCode(error) });
      return;
    }
    if (!snapshot) return;
    this.device = {
      ...this.device,
      online: false,
      state: snapshot.state,
      alarmId: snapshot.alarmId || '',
      csq: snapshot.csq === undefined ? null : snapshot.csq,
      ts: snapshot.lastSeen || 0,
      lastSeen: snapshot.lastSeen || 0,
      lastBusinessUplinkAt: snapshot.lastBusinessUplinkAt || 0,
      known: true,
      source: 'persisted'
    };
    this.counters.deviceStateRestored += 1;
    this._log('info', 'DEVICE_STATE_RESTORED', {
      state: snapshot.state,
      hasAlarmId: Boolean(snapshot.alarmId),
      lastSeen: snapshot.lastSeen || 0
    });
    this._armAliveWatchdog();
  }

  /** 持久化最后已知设备状态（绝不含坐标/密钥）；失败只计数，不影响上行主链路。 */
  _persistDeviceSnapshot() {
    if (typeof this.state.setDeviceSnapshot !== 'function') return;
    const snapshot = {
      state: this.device.state,
      alarmId: this._activeAlarmId(),
      csq: Number.isInteger(this.device.csq) ? this.device.csq : null,
      lastSeen: Number.isSafeInteger(this.device.lastSeen) && this.device.lastSeen > 0 ? this.device.lastSeen : 0,
      lastBusinessUplinkAt: Number.isSafeInteger(this.device.lastBusinessUplinkAt) && this.device.lastBusinessUplinkAt > 0
        ? this.device.lastBusinessUplinkAt
        : 0,
      online: this.device.online === true
    };
    try {
      this.state.setDeviceSnapshot(snapshot);
    } catch (error) {
      this.counters.stateWriteFailures += 1;
      this._recordError(safeErrorCode(error, 'STATE_WRITE_FAILED'));
      this._log('error', 'DEVICE_SNAPSHOT_PERSIST_FAILED', { code: safeErrorCode(error) });
    }
  }

  /* --------------------------------------------------------------- 上行入口 */

  _onMessage(message) {
    if (!this.running) return;
    try {
      if (!message || message.topic !== this.config.upTopic) {
        this.counters.ignoredTopic += 1;
        return;
      }
      this.counters.uplinks += 1;
      this.lastUplinkAt = this.now();
      const text = Buffer.isBuffer(message.payload)
        ? message.payload.toString('utf8')
        : String(message.payload === undefined ? '' : message.payload);
      const trimmed = text.replace(/\u0000/g, '').trim();
      if (trimmed === '') {
        this.counters.ignoredPayload += 1;
        return;
      }
      // 契约 §4：先尝试 JSON 解析（业务协议）；非 JSON 且不含 `{` 才交给 GPS 固定格式解析器。
      if (trimmed.includes('{')) {
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          this.counters.malformedJson += 1;
          this._recordError('MALFORMED_JSON');
          this._log('warn', 'UPLINK_MALFORMED_JSON', { length: trimmed.length });
          return;
        }
        if (!isPlainObject(parsed)) {
          this.counters.invalidMessage += 1;
          return;
        }
        this._handleBusinessObject(parsed);
        return;
      }
      this._handleGpsLine(trimmed);
    } catch (error) {
      // MQTT 回调入口绝不能抛异常（会打挂 broker 的 message 事件）。
      this._recordError(safeErrorCode(error, 'ADAPTER_HANDLER_FAILED'));
      this._log('error', 'ADAPTER_HANDLER_FAILED', { code: safeErrorCode(error) });
    }
  }

  _handleBusinessObject(object) {
    if (object.v !== undefined && object.v !== 1) {
      this.counters.invalidMessage += 1;
      this._recordError('UNSUPPORTED_PROTOCOL_VERSION');
      return;
    }
    if (typeof object.dev === 'string' && object.dev !== this.config.deviceId) {
      this.counters.invalidMessage += 1;
      this._log('warn', 'UPLINK_FOREIGN_DEVICE', { code: 'FOREIGN_DEVICE' });
      return;
    }
    const type = typeof object.t === 'string' ? object.t.toLowerCase() : '';
    switch (type) {
      case 'sos':
        this._handleSos(object);
        return;
      case 'hb':
        this._handleHeartbeat(object);
        return;
      case 'boot':
        this._handleBoot(object);
        return;
      case 'ack':
        this._handleDeviceAck(object);
        return;
      default:
        this.counters.unknownType += 1;
        this._log('info', 'UPLINK_UNKNOWN_TYPE', { type: type.slice(0, 16) || 'EMPTY' });
    }
  }

  /* ------------------------------------------------------------------- SOS */

  _handleSos(object) {
    this.counters.sosReceived += 1;
    const alarmId = typeof object.alarm === 'string' ? object.alarm : '';
    if (!ALARM_ID_RE.test(alarmId)) {
      this.counters.sosInvalid += 1;
      this._recordError('INVALID_ALARM_ID');
      this._log('warn', 'SOS_INVALID_ALARM', { code: 'INVALID_ALARM_ID' });
      return;
    }
    const nowMs = this.now();
    this._updateDevice({ online: true, state: 'ALARM', alarmId, ts: nowMs, lastSeen: nowMs, source: 'sos' });
    // 设备重启后固件会用原 alarmId 每 10s 重发；重复包同样证明设备存活，先刷新存活再判去重。
    this._noteDeviceAlive('sos', nowMs);

    const existing = this.dedupe.get(alarmId);
    if (this.activeAlarm && this.activeAlarm.alarmId !== alarmId) {
      // 设备侧开始了新事件（例如 NVS 丢失后重新生成 alarmId）：保留旧告警在后端不去动它，
      // 只记录诊断；绝不代报旧告警任何状态。
      this.counters.activeEventReplacedByDevice += 1;
      this._log('warn', 'ACTIVE_EVENT_REPLACED', { previous: this.activeAlarm.alarmId, next: alarmId });
    }
    if (existing && existing.status !== 'failed' && nowMs - existing.at < this.config.sos.dedupeTtlMs) {
      this.counters.sosDuplicates += 1;
      this._log('debug', 'SOS_DUPLICATE_SUPPRESSED', { alarmId, status: existing.status });
      return;
    }

    let countToday;
    if (existing && Number.isSafeInteger(existing.countToday) && existing.countToday > 0) {
      countToday = existing.countToday;
    } else {
      try {
        countToday = this.state.noteSos();
      } catch (error) {
        this.counters.stateWriteFailures += 1;
        this._recordError(safeErrorCode(error, 'STATE_WRITE_FAILED'));
        countToday = this.state.todaySosCount() || 1;
      }
    }

    const entry = { status: 'inflight', at: nowMs, countToday };
    this.dedupe.set(alarmId, entry);
    this._trimDedupe(nowMs);

    const eventGps = this._snapshotEventGps(object.gps, nowMs);
    this.activeAlarm = { alarmId, startedAt: nowMs, eventGps };
    const body = {
      deviceId: this.config.deviceId,
      room: this.config.room,
      state: 'ALARM',
      online: true,
      monitorOnline: -1,
      ts: nowMs,
      alarm: { id: alarmId, type: 'MANUAL_SOS', countToday },
      gps: { ...eventGps }
    };
    if (Number.isInteger(this.device.csq) && this.device.csq >= 0 && this.device.csq <= 99) {
      body.csq = this.device.csq;
    }
    this._postDeviceStatus(body, 'SOS').then((ok) => {
      entry.status = ok ? 'sent' : 'failed';
      if (!ok) this._log('warn', 'SOS_STATUS_NOT_ACCEPTED', { alarmId });
    }).catch(() => {
      entry.status = 'failed';
    });
  }

  /**
   * 求助事件位置快照（契约 §5.1 gps）。
   *
   * 优先级：SOS 包自带的有效 gps（固件可能经 M100 取得）与 M100 最新固定格式定位，
   * 取 fixTime 更新者；都没有则 {valid:false,...}，绝不用 (0,0) 冒充定位。
   * 一旦事件建立，该快照在设备真实 ACK 前不再被后续 GPS 报文覆盖。
   */
  _snapshotEventGps(sosGpsRaw, nowMs) {
    const payloadGps = this._extractDeviceGps(sosGpsRaw, nowMs);
    const latest = this.latestGps
      ? {
        valid: true,
        latitude: this.latestGps.latitude,
        longitude: this.latestGps.longitude,
        fixTime: this.latestGps.fixTime
      }
      : null;
    if (payloadGps.valid && latest) {
      if (payloadGps.fixTime >= latest.fixTime) {
        this.counters.sosGpsFromPayload += 1;
        return { ...payloadGps };
      }
      this.counters.sosGpsFromLatest += 1;
      return latest;
    }
    if (payloadGps.valid) {
      this.counters.sosGpsFromPayload += 1;
      return { ...payloadGps };
    }
    if (latest) {
      this.counters.sosGpsFromLatest += 1;
      return latest;
    }
    this.counters.sosGpsUnavailable += 1;
    return this._invalidGps();
  }

  /** 当前 device-status 应使用的 gps：未 ACK 事件期间固定为求助时刻快照，否则用最新位置。 */
  _gpsForStatus() {
    if (this.activeAlarm && this.activeAlarm.eventGps) return { ...this.activeAlarm.eventGps };
    if (this.latestGps) {
      return {
        valid: true,
        latitude: this.latestGps.latitude,
        longitude: this.latestGps.longitude,
        fixTime: this.latestGps.fixTime
      };
    }
    return this._invalidGps();
  }

  _invalidGps() {
    return { valid: false, latitude: null, longitude: null, fixTime: 0 };
  }

  /**
   * 固件 SOS 的 gps 字段为 {lat,lon,fix,ageMs}（契约 §3.1）。
   * 设备无 RTC：用服务器接收时间减 ageMs 得到 fixTime，不伪造设备墙钟。
   */
  _extractDeviceGps(raw, nowMs) {
    if (!isPlainObject(raw)) return { valid: false };
    const valid = raw.fix === true || raw.valid === true;
    if (!valid) return { valid: false };
    const latitude = typeof raw.lat === 'number' ? raw.lat
      : (typeof raw.latitude === 'number' ? raw.latitude : Number.NaN);
    const longitude = typeof raw.lon === 'number' ? raw.lon
      : (typeof raw.longitude === 'number' ? raw.longitude : Number.NaN);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { valid: false };
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return { valid: false };
    if (latitude === 0 && longitude === 0) return { valid: false };
    const ageMs = Number.isSafeInteger(raw.ageMs) && raw.ageMs >= 0 && raw.ageMs <= 24 * 60 * 60 * 1000
      ? raw.ageMs
      : 0;
    return { valid: true, latitude, longitude, fixTime: Math.max(0, nowMs - ageMs) };
  }

  async _postDeviceStatus(body, reason) {
    let result;
    try {
      result = await this.backend.postDeviceStatus(body);
    } catch (error) {
      this.counters.deviceStatusFailed += 1;
      this._recordError(safeErrorCode(error, 'BACKEND_REQUEST_FAILED'));
      return false;
    }
    if (!result.ok) {
      this.counters.deviceStatusFailed += 1;
      this._recordError(result.code || `HTTP_${result.statusCode || 0}`);
      this._log('warn', 'DEVICE_STATUS_POST_FAILED', {
        reason,
        code: result.code || 'HTTP_ERROR',
        statusCode: result.statusCode || 0
      });
      return false;
    }
    this.counters.deviceStatusOk += 1;
    return true;
  }

  /* --------------------------------------------------------------- hb / boot */

  _handleHeartbeat(object) {
    const rawState = typeof object.state === 'string' ? object.state.toUpperCase() : '';
    let state;
    if (rawState === 'ALARM') state = 'ALARM';
    else if (rawState === 'IDLE' || rawState === 'NORMAL') state = 'NORMAL';
    else {
      this.counters.invalidMessage += 1;
      this._recordError('INVALID_HB_STATE');
      return;
    }
    const alarmId = typeof object.alarm === 'string' ? object.alarm : '';
    if (alarmId !== '' && !ALARM_ID_RE.test(alarmId)) {
      this.counters.invalidMessage += 1;
      this._recordError('INVALID_ALARM_ID');
      return;
    }
    const csq = Number.isInteger(object.csq) && object.csq >= 0 && object.csq <= 99 ? object.csq : null;
    const nowMs = this.now();
    this.counters.hbReceived += 1;
    this._updateDevice({
      online: true,
      state,
      alarmId: state === 'ALARM' ? alarmId : '',
      csq,
      ts: nowMs,
      lastSeen: nowMs,
      source: 'hb'
    });
    // IDLE/NORMAL 心跳是设备“当前无未确认事件”的明确声明：
    // 若本地还挂着未确认事件（例如设备重启后 NVS 丢了事件、只恢复了已确认备忘），
    // 只能清除本地事件快照并记诊断——绝不代报 ACKED/FAILED，后端告警保持原状（人仍能看到）。
    if (state === 'NORMAL' && this.activeAlarm) {
      this.counters.activeEventClearedByDevice += 1;
      this._log('warn', 'ACTIVE_EVENT_CLEARED_BY_DEVICE', {
        alarmId: this.activeAlarm.alarmId,
        note: '设备明确上报 IDLE：本地事件快照清除；后端告警未被代报，仍保持未确认'
      });
      this.activeAlarm = null;
    }
    this._noteDeviceAlive('hb', nowMs);
    // 心跳既刷新在线状态也补建告警：若 SOS 的 POST 曾失败，ALARM 心跳可兜底让后端建告警。
    if (state === 'ALARM' && alarmId && (!this.activeAlarm || this.activeAlarm.alarmId !== alarmId)) {
      // 设备/适配器重启后从 ALARM 心跳恢复未完成事件：用当前最新位置做事件快照。
      this.activeAlarm = {
        alarmId,
        startedAt: nowMs,
        eventGps: this.latestGps
          ? {
            valid: true,
            latitude: this.latestGps.latitude,
            longitude: this.latestGps.longitude,
            fixTime: this.latestGps.fixTime
          }
          : this._invalidGps()
      };
      this.counters.gpsEventSnapshots += 1;
      this._log('info', 'EVENT_RESTORED_FROM_HEARTBEAT', { alarmId });
    }
    const body = {
      deviceId: this.config.deviceId,
      room: this.config.room,
      state,
      online: true,
      monitorOnline: -1,
      ts: nowMs,
      alarm: state === 'ALARM'
        ? { id: alarmId, type: 'MANUAL_SOS', countToday: Math.max(1, this.state.todaySosCount()) }
        : { id: '' },
      gps: this._gpsForStatus()
    };
    if (csq !== null) body.csq = csq;
    this._postDeviceStatus(body, 'HB').catch(() => {});
  }

  _handleBoot(object) {
    const nowMs = this.now();
    this.counters.bootReceived += 1;
    // 设备重启：若本地存在未确认事件，绝不把状态伪造成 NORMAL（那会让 APP 误以为一切解除）。
    // 固件重启后若事件仍在 NVS 里，会立即用原 alarmId 重发 SOS，状态随后自然维持 ALARM；
    // 若事件确实丢了，设备会在下一个 30s IDLE 心跳中明确声明，届时只清本地快照、后端告警保留。
    const activeAlarmId = this._activeAlarmId();
    const state = activeAlarmId ? 'ALARM' : 'NORMAL';
    this._updateDevice({
      online: true,
      state,
      alarmId: state === 'ALARM' ? activeAlarmId : '',
      ts: nowMs,
      lastSeen: nowMs,
      source: 'boot'
    });
    this._noteDeviceAlive('boot', nowMs);
    const body = this._buildStatusBody(state, true, activeAlarmId);
    this._postDeviceStatus(body, 'BOOT').catch(() => {});
    this._log('info', 'DEVICE_BOOT', {
      fw: typeof object.fw === 'string' ? object.fw.slice(0, 32) : '',
      reportedState: state,
      persistedEvent: state === 'ALARM'
    });
  }

  /* ------------------------------------------------------------------- GPS */

  /**
   * M100 固定格式 GPS 报文（非 JSON）：
   *   1) 只更新“最新位置”（含 WGS84 十进制/度分双兼容解析与范围校验）；
   *   2) 不调用任何 HTTP：公网现网后端没有 wearable location 路由，
   *      位置统一随 device-status 的 gps 字段上报；
   *   3) 未 ACK 事件期间最新位置照常维护，但事件快照不被覆盖（gpsEventLocked）。
   *   解析失败只记诊断码，绝不写假坐标。
   */
  _handleGpsLine(text) {
    this.counters.gpsMessages += 1;
    const parsed = parseGpsFixedFormat(text);
    if (!parsed.ok) {
      this.counters.gpsParseFailures += 1;
      this._recordError(`GPS_${parsed.code}`);
      this._log('debug', 'GPS_PARSE_REJECTED', { code: parsed.code, length: text.length });
      return;
    }
    this.counters.gpsParsed += 1;
    const nowMs = this.now();
    let seq = 0;
    try {
      // seq 仅作为“已接受定位帧数”的诊断计数持久化到 DATA_DIR（跨重启单调）。
      seq = this.state.nextSeq();
    } catch (error) {
      this.counters.stateWriteFailures += 1;
      this._recordError(safeErrorCode(error, 'STATE_WRITE_FAILED'));
    }
    this.latestGps = {
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      fixTime: nowMs,
      receivedAt: nowMs,
      format: parsed.format,
      seq
    };
    if (this.activeAlarm) {
      // 本事件未 ACK 前 gps 固定为求助时刻快照；这里只更新“最新位置”，不影响事件位置。
      this.counters.gpsEventLocked += 1;
    }
    this._log('debug', 'GPS_FIX_ACCEPTED', {
      format: parsed.format,
      seq,
      eventLocked: this.activeAlarm !== null
    });
  }

  /* -------------------------------------------------------------- ACK 命令 */

  _schedulePoll(delayMs) {
    if (!this.running) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      this._pollCycle();
    }, Math.max(0, delayMs));
  }

  async _pollCycle() {
    if (!this.running || this._polling) return;
    this._polling = true;
    let nextDelay = this.config.poll.intervalMs;
    try {
      await this._flushPendingResults();
      await this._checkParked();
      const after = this.state.commandCursor;
      const result = await this.backend.getCommands(after);
      this.counters.commandPolls += 1;
      this.lastPoll = {
        at: this.now(),
        ok: result.ok === true,
        code: result.ok ? '' : (result.code || `HTTP_${result.statusCode || 0}`),
        after
      };
      if (!result.ok) {
        this.counters.commandPollFailed += 1;
        this._pollFailures += 1;
        this._recordError(result.code || `HTTP_${result.statusCode || 0}`);
        nextDelay = Math.min(
          this.config.poll.backoffMaxMs,
          this.config.poll.intervalMs * (2 ** Math.min(this._pollFailures, 10))
        );
        this._log('warn', 'COMMAND_POLL_FAILED', {
          code: result.code || 'HTTP_ERROR',
          statusCode: result.statusCode || 0,
          after,
          nextDelayMs: nextDelay
        });
        return;
      }
      this._pollFailures = 0;
      const commands = result.json && Array.isArray(result.json.commands) ? result.json.commands : null;
      if (!commands) {
        this.counters.commandPollFailed += 1;
        this._recordError('COMMANDS_BAD_RESPONSE');
        this._log('warn', 'COMMAND_POLL_BAD_RESPONSE', { statusCode: result.statusCode || 0 });
        return;
      }
      this._processCommandList(commands);
    } catch (error) {
      this._pollFailures += 1;
      this.counters.commandPollFailed += 1;
      this._recordError(safeErrorCode(error, 'COMMAND_POLL_FAILED'));
      this._log('error', 'COMMAND_POLL_EXCEPTION', { code: safeErrorCode(error) });
      nextDelay = Math.min(
        this.config.poll.backoffMaxMs,
        this.config.poll.intervalMs * (2 ** Math.min(this._pollFailures, 10))
      );
    } finally {
      this._polling = false;
      if (this.running) this._schedulePoll(nextDelay);
    }
  }

  /**
   * 逐条分类命令并推进游标。
   *
   * 游标只推进到“本地已终态”的命令（其他设备/非 ACK/已完成/已回写/已过期）；
   * 一旦遇到本设备仍处于投递中/等待回执/结果回写中的命令，就停在该命令之前。
   * 这样进程崩溃/重启后，`after` 续读会重新看到未完成命令，不会“投递过但没回执”地丢命令。
   */
  _processCommandList(list) {
    let cursor = this.state.commandCursor;
    let blocked = false;
    for (const raw of list) {
      if (blocked) break;
      if (!isPlainObject(raw)) {
        this.counters.commandsIgnored += 1;
        continue;
      }
      const numericId = numericCommandId(raw.id);
      if (numericId <= cursor) continue;

      const classification = this._classifyCommand(raw);
      if (classification.kind === 'terminal') {
        this.counters.commandsIgnored += 1;
        if (classification.log) {
          this._log('warn', 'COMMAND_IGNORED', {
            code: classification.code,
            commandId: raw.id
          });
        }
        cursor = numericId;
        continue;
      }
      if (classification.kind === 'blocked') {
        blocked = true;
        continue;
      }

      // 新命令：立即登记并开始第 1 次下发；游标停在该 id 之前。
      const command = classification.command;
      this.counters.commandsReceived += 1;
      const entry = { command, attempts: 0, round: 1, nextAt: 0, timer: null };
      this.inflight.set(command.id, entry);
      this._log('info', 'COMMAND_ACCEPTED', {
        commandId: command.id,
        alarmId: command.alarmId,
        attemptRound: 1
      });
      this._scheduleDelivery(entry, 0);
      blocked = true;
    }

    if (cursor > this.state.commandCursor) {
      try {
        this.state.setCommandCursor(cursor);
      } catch (error) {
        this.counters.stateWriteFailures += 1;
        this._recordError(safeErrorCode(error, 'STATE_WRITE_FAILED'));
        this._log('error', 'COMMAND_CURSOR_PERSIST_FAILED', { code: safeErrorCode(error) });
      }
    }
  }

  /** @returns {{kind:'accept', command:object}|{kind:'blocked'}|{kind:'terminal', code:string, log?:boolean}} */
  _classifyCommand(raw) {
    const checked = this._validateCommand(raw);
    if (!checked.ok) {
      // 其他设备/非 ACK 命令与我们无关：推进游标即可，绝不猜设备下发。
      return {
        kind: 'terminal',
        code: checked.code,
        log: checked.code !== 'OTHER_DEVICE' && checked.code !== 'NOT_PENDING'
      };
    }
    const command = checked.command;
    if (this.pendingResults.has(command.id)) return { kind: 'blocked' };
    if (this.inflight.has(command.id) || this.parked.has(command.id)) return { kind: 'blocked' };
    if (this.settled.has(command.id)) {
      return { kind: 'terminal', code: 'ALREADY_HANDLED' };
    }
    return { kind: 'accept', command };
  }

  /** 严格校验后端命令；返回 {ok:true, command} 或 {ok:false, code}。 */
  _validateCommand(raw) {
    if (typeof raw.id !== 'string' || !COMMAND_ID_RE.test(raw.id)) return { ok: false, code: 'INVALID_COMMAND_ID' };
    if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) {
      return { ok: false, code: 'INVALID_DEVICE_ID' };
    }
    if (raw.deviceId !== this.config.deviceId) return { ok: false, code: 'OTHER_DEVICE' };
    // 真实后端 schema 是 command:'ACK'（store.js requestAck）；
    // 兼容契约文字里的 type:'ack'，但两者都不匹配时绝不猜测。
    const isAck = raw.command === 'ACK' ||
      (typeof raw.type === 'string' && raw.type.toLowerCase() === 'ack');
    if (!isAck) return { ok: false, code: 'UNSUPPORTED_COMMAND' };
    if (typeof raw.alarmId !== 'string' || !ALARM_ID_RE.test(raw.alarmId)) {
      return { ok: false, code: 'INVALID_ALARM_ID' };
    }
    if (raw.status !== undefined && raw.status !== 'PENDING') return { ok: false, code: 'NOT_PENDING' };
    return {
      ok: true,
      command: Object.freeze({
        id: raw.id,
        alarmId: raw.alarmId,
        action: typeof raw.action === 'string' ? raw.action.slice(0, 120) : ''
      })
    };
  }

  _scheduleDelivery(runtime, delayMs) {
    if (!this.running) return;
    if (runtime.timer) clearTimeout(runtime.timer);
    const delay = Math.max(0, delayMs);
    runtime.nextAt = this.now() + delay;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      this._deliver(runtime);
    }, delay);
    if (typeof runtime.timer.unref === 'function') runtime.timer.unref();
  }

  _deliver(runtime) {
    if (!this.running) return;
    if (this.inflight.get(runtime.command.id) !== runtime) return;
    runtime.attempts += 1;
    // M100 MQTT 透传下行**原样写串口、不追加换行**；ESP32 固件按行解析，
    // 必须由服务端补 '\n'，否则 ACK 会卡在行缓冲里不处理（真机已复现）。
    // 上行方向设备自带 '\n'，适配器入口统一 trim。
    const payload = `${JSON.stringify({
      v: 1,
      t: 'ack',
      alarm: runtime.command.alarmId,
      cmd: runtime.command.id
    })}\n`;
    let matched = 0;
    try {
      const published = this.broker.publish(this.config.downTopic, payload, { qos: 1 });
      matched = published && typeof published.matched === 'number' ? published.matched : 0;
      this.counters.commandsPublished += 1;
      if (matched === 0) this.counters.commandPublishNoSubscriber += 1;
    } catch (error) {
      this.counters.commandPublishFailures += 1;
      this._recordError(safeErrorCode(error, 'COMMAND_PUBLISH_FAILED'));
    }
    this._log('info', 'COMMAND_ACK_SENT', {
      commandId: runtime.command.id,
      alarmId: runtime.command.alarmId,
      attempt: runtime.attempts,
      round: runtime.round,
      subscribers: matched
    });

    if (this.inflight.get(runtime.command.id) !== runtime) return;
    if (runtime.attempts < this.config.poll.maxAttempts) {
      this._scheduleDelivery(runtime, this.config.poll.retryIntervalMs);
      return;
    }
    // 本轮 3 次投递完成仍无设备回执：本地进入 parked（后端保持 PENDING，绝不代报）。
    this.inflight.delete(runtime.command.id);
    if (runtime.timer) {
      clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    if (this.parked.size >= MAX_PARKED_ENTRIES) {
      const oldest = this.parked.keys().next();
      if (!oldest.done) this.parked.delete(oldest.value);
    }
    this.counters.commandsParked += 1;
    const slow = runtime.round >= this.config.poll.maxRounds;
    this.parked.set(runtime.command.id, {
      command: runtime.command,
      round: runtime.round,
      slow,
      parkedAt: this.now(),
      nextCheckAt: this.now() + (slow ? this.config.poll.slowRetryMs : this.config.poll.parkedRetryMs)
    });
    if (slow) {
      // 已达到最大轮次仍无回执：保持后端 PENDING，改为低频慢速重投（用户重新点击后仍能等到下发）。
      this.counters.commandsExpired += 1;
      this._log('warn', 'COMMAND_LOCAL_TIMEOUT', {
        commandId: runtime.command.id,
        alarmId: runtime.command.alarmId,
        rounds: runtime.round,
        slowRetryMs: this.config.poll.slowRetryMs
      });
    } else {
      this._log('warn', 'COMMAND_PARKED', {
        commandId: runtime.command.id,
        alarmId: runtime.command.alarmId,
        round: runtime.round,
        maxRounds: this.config.poll.maxRounds
      });
    }
  }

  /** 已投递 3 次仍未回执的命令：到点回读后端，命令仍 PENDING 才允许再次下发（用户重新点击场景）。 */
  async _checkParked() {
    if (this.parked.size === 0) return;
    const nowMs = this.now();
    const due = [];
    let minId = Number.MAX_SAFE_INTEGER;
    for (const [id, entry] of this.parked) {
      const numeric = Number(id);
      if (entry.nextCheckAt <= nowMs) due.push([id, entry]);
      if (numeric < minId) minId = numeric;
    }
    if (due.length === 0) return;
    for (const [, entry] of due) {
      const delay = entry.slow ? this.config.poll.slowRetryMs : this.config.poll.parkedRetryMs;
      entry.nextCheckAt = nowMs + delay;
    }

    const result = await this.backend.getCommands(minId - 1);
    if (!result.ok || !result.json || !Array.isArray(result.json.commands)) {
      this._recordError(result.ok ? 'PARKED_BAD_RESPONSE' : (result.code || 'PARKED_FETCH_FAILED'));
      return;
    }
    const byId = new Map();
    for (const raw of result.json.commands) {
      if (isPlainObject(raw) && typeof raw.id === 'string') byId.set(raw.id, raw);
    }
    for (const [id, entry] of due) {
      if (this.parked.get(id) !== entry) continue;
      const raw = byId.get(id);
      if (!raw) {
        // 后端响应里没有这条命令：**绝不能**当作“已结算”直接丢弃（那会静默丢掉未确认 ACK）。
        // 保留 parked，按原节奏继续回读；只有明确看到非 PENDING 状态才算外部结算。
        // （真实后端 listCommands 返回全量，不设上限；这里是防御部署/响应异常的兜底。）
        this.counters.parkedLookupMissing += 1;
        this._log('warn', 'COMMAND_PARKED_LOOKUP_MISSING', { commandId: id });
        continue;
      }
      if (raw.status !== undefined && raw.status !== 'PENDING') {
        this.parked.delete(id);
        this._log('info', 'COMMAND_CLEARED_EXTERNALLY', { commandId: id });
        continue;
      }
      // 后端仍 PENDING：允许再次投递。轮次用尽后进入“低频慢速重投”，
      // 这样用户重新点击（后端仍返回同一条 PENDING 命令）最终也能下发；
      // 依旧绝不代报 ACKED/FAILED。
      const nextRound = entry.round >= this.config.poll.maxRounds
        ? this.config.poll.maxRounds
        : entry.round + 1;
      this.parked.delete(id);
      const runtime = { command: entry.command, attempts: 0, round: nextRound, nextAt: 0, timer: null };
      this.inflight.set(id, runtime);
      this.counters.commandsRedelivered += 1;
      this._log('info', entry.slow ? 'COMMAND_SLOW_REDELIVER' : 'COMMAND_REDELIVERED', {
        commandId: id,
        alarmId: entry.command.alarmId,
        round: runtime.round
      });
      this._scheduleDelivery(runtime, 0);
    }
  }

  /* ---------------------------------------------------------------- 设备回执 */

  _handleDeviceAck(object) {
    const alarmId = typeof object.alarm === 'string' ? object.alarm : '';
    let commandId = '';
    if (typeof object.cmd === 'string') commandId = object.cmd;
    else if (typeof object.cmd === 'number' && Number.isSafeInteger(object.cmd)) commandId = String(object.cmd);

    if (!ALARM_ID_RE.test(alarmId) || !COMMAND_ID_RE.test(commandId)) {
      this.counters.ackReceiptRejected += 1;
      this._recordError('INVALID_ACK_RECEIPT');
      return;
    }

    const runtime = this.inflight.get(commandId) || null;
    if (!runtime) {
      const parkedEntry = this.parked.get(commandId);
      if (parkedEntry) {
        // 迟到的设备回执：仍真实上报，不做代报以外的任何猜测。
        this.parked.delete(commandId);
        this._log('info', 'COMMAND_RECEIPT_AFTER_PARK', { commandId, alarmId });
        this._acceptReceipt(parkedEntry.command, alarmId, commandId);
        return;
      }
      if (this.settled.has(commandId)) {
        this.counters.ackReceiptDuplicate += 1;
      } else {
        this.counters.ackReceiptUnknown += 1;
      }
      this._log('warn', 'ACK_RECEIPT_UNMATCHED', {
        commandId,
        code: this.settled.has(commandId) ? 'DUPLICATE' : 'UNKNOWN_COMMAND'
      });
      return;
    }
    if (runtime.command.alarmId !== alarmId) {
      this.counters.ackReceiptRejected += 1;
      this._recordError('ACK_ALARM_MISMATCH');
      this._log('warn', 'ACK_RECEIPT_MISMATCH', { commandId, code: 'ALARM_MISMATCH' });
      return;
    }
    this._acceptReceipt(runtime.command, alarmId, commandId);
  }

  _acceptReceipt(command, alarmId, commandId) {
    this.counters.ackReceipts += 1;
    const runtime = this.inflight.get(commandId);
    if (runtime) {
      this.inflight.delete(commandId);
      if (runtime.timer) {
        clearTimeout(runtime.timer);
        runtime.timer = null;
      }
    }
    const nowMs = this.now();
    this._updateDevice({ online: true, state: 'ACKED', alarmId, ts: nowMs, lastSeen: nowMs, source: 'ack' });

    // 设备真实 ACK：事件结束，恢复发送“最新位置”（而不是求助时刻快照）。
    if (this.activeAlarm && this.activeAlarm.alarmId === alarmId) {
      this.activeAlarm = null;
    }
    // 回执就是设备的真实业务上行：刷新存活（首个业务上行立即恢复 online=true）并持久化最后已知状态。
    this._noteDeviceAlive('ack', nowMs);

    const dedupeEntry = this.dedupe.get(alarmId);
    const countToday = dedupeEntry && Number.isSafeInteger(dedupeEntry.countToday) && dedupeEntry.countToday > 0
      ? dedupeEntry.countToday
      : Math.max(1, this.state.todaySosCount());
    const gps = this._gpsForStatus();

    // 先向 device-status 报一次 ACKED（带 alarm.id 与最新位置），让 APP 立即看到设备已确认；
    // 命令结算 result 仍只由真实回执触发，二者独立失败域。
    this._postDeviceStatus({
      deviceId: this.config.deviceId,
      room: this.config.room,
      state: 'ACKED',
      online: true,
      monitorOnline: -1,
      ts: nowMs,
      alarm: { id: alarmId, type: 'MANUAL_SOS', countToday },
      gps: { ...gps }
    }, 'ACK_RECEIPT').catch(() => {});

    const body = {
      status: 'ACKED',
      deviceState: {
        deviceId: this.config.deviceId,
        room: this.config.room,
        online: true,
        state: 'ACKED',
        ts: nowMs,
        alarm: { id: alarmId, type: 'MANUAL_SOS', countToday },
        gps: { ...gps }
      }
    };
    if (this.pendingResults.has(commandId)) return;
    this.pendingResults.set(commandId, {
      command,
      body,
      attempts: 0,
      nextAt: 0,
      inFlight: false
    });
    this._log('info', 'COMMAND_RECEIPT_ACCEPTED', { commandId, alarmId });
    this._flushPendingResults().catch(() => {});
  }

  async _flushPendingResults() {
    if (this.pendingResults.size === 0) return;
    const nowMs = this.now();
    for (const [commandId, pending] of this.pendingResults) {
      if (pending.inFlight) continue;
      if (pending.nextAt > nowMs) continue;
      pending.inFlight = true;
      let result;
      try {
        result = await this.backend.postCommandResult(pending.command.id, pending.body);
      } catch (error) {
        result = { ok: false, statusCode: 0, code: safeErrorCode(error, 'COMMAND_RESULT_FAILED') };
      }
      pending.inFlight = false;
      if (result.ok) {
        this.pendingResults.delete(commandId);
        this.settled.set(commandId, { status: 'ACKED', at: this.now() });
        this._trimSettled();
        this.counters.commandResultOk += 1;
        this._log('info', 'COMMAND_RESULT_ACKED', { commandId, alarmId: pending.command.alarmId });
        continue;
      }
      pending.attempts += 1;
      this.counters.commandResultFailed += 1;
      this._recordError(result.code || `HTTP_${result.statusCode || 0}`);
      const delay = Math.min(
        this.config.http.backoffMaxMs,
        Math.max(200, this.config.http.backoffBaseMs) * (2 ** Math.min(pending.attempts - 1, 6))
      );
      pending.nextAt = this.now() + delay;
      this._log('warn', 'COMMAND_RESULT_POST_FAILED', {
        commandId,
        code: result.code || 'HTTP_ERROR',
        statusCode: result.statusCode || 0,
        attempts: pending.attempts,
        nextDelayMs: delay
      });
    }
  }

  /* -------------------------------------------------------------------- 工具 */

  _updateDevice(partial) {
    const nowMs = partial && typeof partial.lastSeen === 'number' ? partial.lastSeen : this.now();
    this.device = {
      ...this.device,
      ...partial,
      lastSeen: nowMs,
      ts: typeof partial.ts === 'number' ? partial.ts : nowMs
    };
  }

  _trimDedupe(nowMs) {
    for (const [key, entry] of this.dedupe) {
      if (nowMs - entry.at > this.config.sos.dedupeTtlMs * 2) this.dedupe.delete(key);
    }
    while (this.dedupe.size > MAX_DEDUPE_ENTRIES) {
      const oldest = this.dedupe.keys().next();
      if (oldest.done) break;
      this.dedupe.delete(oldest.value);
    }
  }

  _trimSettled() {
    while (this.settled.size > MAX_SETTLED_ENTRIES) {
      const oldest = this.settled.keys().next();
      if (oldest.done) break;
      this.settled.delete(oldest.value);
    }
  }

  _recordError(code) {
    this.counters.lastErrorCode = safeErrorCode({ code }, 'UNKNOWN');
    this.counters.lastErrorAt = this.now();
  }

  _log(level, code, fields) {
    if (!this.logger || typeof this.logger[level] !== 'function') return;
    this.logger[level](code, fields || {});
  }

  snapshot() {
    return {
      expectedDeviceId: this.config.deviceId,
      locationDeviceId: this.config.locationDeviceId,
      room: this.config.room,
      device: { ...this.device },
      link: {
        deviceClientId: this.config.deviceClientId,
        aliveTimeoutMs: this.config.device.aliveTimeoutMs,
        watchdogArmed: this._aliveTimer !== null,
        offlineReported: this._offlineReported === true
      },
      lastUplinkAt: this.lastUplinkAt,
      latestGps: this.latestGps ? { ...this.latestGps } : null,
      activeAlarm: this.activeAlarm
        ? {
          alarmId: this.activeAlarm.alarmId,
          startedAt: this.activeAlarm.startedAt,
          eventGps: { ...this.activeAlarm.eventGps }
        }
        : null,
      counters: { ...this.counters },
      commands: {
        cursor: this.state.commandCursor,
        inflight: Array.from(this.inflight.values()).map((runtime) => ({
          commandId: runtime.command.id,
          alarmId: runtime.command.alarmId,
          attempts: runtime.attempts,
          round: runtime.round,
          nextAt: runtime.nextAt
        })),
        parked: Array.from(this.parked.values()).map((entry) => ({
          commandId: entry.command.id,
          alarmId: entry.command.alarmId,
          round: entry.round,
          slow: entry.slow === true,
          parkedAt: entry.parkedAt,
          nextCheckAt: entry.nextCheckAt
        })),
        pendingResults: Array.from(this.pendingResults.keys()),
        settled: this.settled.size,
        lastPoll: { ...this.lastPoll }
      }
    };
  }
}

module.exports = Object.freeze({
  WearableAdapter,
  ALARM_ID_RE,
  COMMAND_ID_RE,
  DEVICE_ID_RE
});
