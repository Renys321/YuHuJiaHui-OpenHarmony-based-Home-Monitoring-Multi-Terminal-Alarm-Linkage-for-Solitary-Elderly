#!/usr/bin/env node
/**
 * 常驻家庭云网关：本地 home/+/status 经 adapter 校验归一化后聚合成家庭状态，
 * 发 OneNET property/post，新的 alarmId 额外发 event/post(safetyAlarm)。
 *
 * 下行 property/set 只做白名单校验；第一阶段仅执行网关自身 RESET，ACK / SET_CONFIG
 * 需要物模型 control 带 deviceId，暂不下推（见 README“下行范围”）。只有真实执行并
 * 收到设备回执才回 code=200，否则回失败。
 *
 * 依赖全部可注入，测试不连真实 OneNET 与 Broker；日志只含 productId / deviceName /
 * deviceId / 命令类型 / 安全错误码，不打印载荷与密钥。本地 Broker 断线只影响上云，
 * 按指数退避恢复；SIGINT/SIGTERM 时清掉连接、定时器和 pending Promise。
 *
 * 报文严格校验：超大、非法 JSON、非法 deviceId、10 位秒时间戳、未知字段一律拒绝。
 * Bridge 虽用 retain=true 发布 home/<deviceId>/status，自带 broker 转发时会剥掉 retain
 * （mqtt_broker.js:86），换成真实 Broker 又会保留，所以事件去重只按 alarmId 记忆，
 * 绝不依赖“首次见到该设备”。
 */
'use strict';

const { EventEmitter } = require('node:events');
const {
  buildTopics,
  mapPropertySet,
  makePropertySetReply,
  toAlarmEvent,
  toPropertyPost
} = require('./adapter');

const DEFAULT_STATUS_TOPIC = 'home/+/status';
const DEFAULT_BROKER_URL = 'mqtt://127.0.0.1:1883';
const DEFAULT_COMMAND_TIMEOUT_MS = 8000;
const DEFAULT_STABLE_INTERVAL_MS = 30000;
const DEFAULT_ALARM_MEMORY = 200;
const DEFAULT_OFFLINE_AFTER_MS = 12000;
const DEFAULT_OFFLINE_SCAN_MS = 3000;
const DEFAULT_RECONNECT_MIN_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30000;
const MAX_STATUS_LINE_BYTES = 16 * 1024;
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const STATUS_TOPIC_RE = /^home\/([^/]+)\/status$/;
const CONTROL_KEYS = Object.freeze(['command', 'alarmId', 'action', 'noMotionSec', 'reportIntervalSec']);

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 配置容器校验：接受 process.env 这类原型非 Object.prototype 的对象，但仍拒绝误用。 */
function isEnvLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requireNonEmptyString(value, name, maxLength = 200) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z_]{3,40}$/.test(value) ? value : 'UNKNOWN';
}

/** 13 位 UTC 毫秒时间戳范围；0 表示 ESP32 尚未完成 NTP 同步的设计值。 */
const EPOCH_MS_MIN = 1_000_000_000_000;
const EPOCH_MS_MAX = 9_999_999_999_999;

/**
 * 严格校验 13 位毫秒时间戳。adapter.js 只校验 sensors/alarm/gps 内部的毫秒字段，
 * 根级 ts 它不读（云端时间由 options.timestampMs 决定），本地 Bridge 也不校验，
 * 10 位秒值确实会出现在报文里，只能在这里拦住。
 */
function requireEpochMs(value, name) {
  if (value === 0) return 0;
  if (!Number.isSafeInteger(value) || value < EPOCH_MS_MIN || value > EPOCH_MS_MAX) {
    fail(`${name} must be a 13-digit UTC Unix timestamp in milliseconds`);
  }
  return value;
}

/* ---- 状态聚合 ---- */

/** 提取房间与告警信息：房间必须随快照上云，否则告警来源会丢；字段名与 normalizeIncoming 的扁平输出一致。 */
function describeSnapshot(normalized) {
  return {
    deviceId: normalized.deviceId,
    room: normalized.room,
    state: normalized.state,
    monitorOnline: normalized.monitorOnline,
    alarmId: normalized.alarmId || '',
    alarmType: normalized.alarmType || '',
    evidenceId: normalized.evidenceId || '',
    sensors: normalized.sensors,
    fall: normalized.fall,
    gps: normalized.gps,
    /* 电量（契约 §4）：随设备快照保留；缺失 = 该设备无电量数据，不补默认值。 */
    battery: normalized.battery,
    csq: normalized.csq
  };
}

/**
 * 读取原始传感器对象里的可选 valid。adapter.toPropertyPost 校验后会按 OneNET 合同剥离它，
 * backend 旁路要保留同一字段；只接受真实布尔值，缺失返回 undefined（false 不算缺失）。
 */
function rawSensorValid(raw, key) {
  const sensors = isPlainObject(raw.sensors) ? raw.sensors : {};
  const source = sensors[key] !== undefined ? sensors[key] : raw[key];
  if (!isPlainObject(source)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(source, 'valid')) return undefined;
  if (typeof source.valid !== 'boolean') fail(`status.${key}.valid must be boolean`);
  return source.valid;
}

/* ---- 网关主体 ---- */

class HomeCloudGateway extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.transport           已构造的 OneNET 传输层（由 createGateway 自动接线 handleCommand）
   * @param {object} [options.statusSource]      { subscribe(handler), close() }；默认用 mqtt.js 连本地 Broker
   * @param {number} [options.commandTimeoutMs]  等待真实设备回执的超时
   * @param {number} [options.stableIntervalMs]  稳定状态限频上云间隔
   * @param {number} [options.alarmMemory]       每设备保留的已告警 alarmId 数量
   * @param {string} [options.deviceName]        网关自身设备名，用于解析“网关自身 RESET”
   * @param {string} [options.resetMode]         'local' | 'self' | 'target'
   * @param {() => number} [options.now]
   * @param {object} [options.logger]            { info, warn, error }
   */
  constructor(options) {
    super();
    if (!isPlainObject(options)) fail('options must be a plain object');
    if (!options.transport || typeof options.transport !== 'object') fail('transport is required');
    if (typeof options.transport.publishProperty !== 'function') fail('transport.publishProperty is required');
    if (typeof options.transport.publishAlarm !== 'function') fail('transport.publishAlarm is required');

    this.transport = options.transport;
    this.statusSource = options.statusSource || null;
    this.commandTimeoutMs = requireInteger(
      options.commandTimeoutMs === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : options.commandTimeoutMs,
      'commandTimeoutMs', 100, 120000
    );
    this.stableIntervalMs = requireInteger(
      options.stableIntervalMs === undefined ? DEFAULT_STABLE_INTERVAL_MS : options.stableIntervalMs,
      'stableIntervalMs', 0, 24 * 3600 * 1000
    );
    this.alarmMemory = requireInteger(
      options.alarmMemory === undefined ? DEFAULT_ALARM_MEMORY : options.alarmMemory,
      'alarmMemory', 1, 10000
    );
    this.deviceName = typeof options.deviceName === 'string' ? options.deviceName : '';
    this.resetMode = options.resetMode || 'self';
    if (!['local', 'self', 'target'].includes(this.resetMode)) {
      fail("resetMode must be one of 'local', 'self', 'target'");
    }
    this.now = options.now || (() => Date.now());
    if (typeof this.now !== 'function') fail('now must be a function');
    // 可选：同步到可信后端（微信小程序的数据来源）。缺省为 null，表示不同步。
    this.cloudSync = options.cloudSync || null;
    // 可选：把可信后端的 ACK 队列定向下发到本地设备，并等待真实状态回执。
    this.commandSync = options.commandSync || null;
    this.logger = options.logger || {
      info: (line) => console.log(line),
      warn: (line) => console.warn(line),
      error: (line) => console.error(line)
    };

    /** @type {Map<string, {deviceId:string,room:string,state:string,online:boolean,alarmId:string,alarmType:string,alarmCountToday:number,lastSeenMs:number,ingestSeq:number,lastPublishedMs:number,lastPublishedSignature:string}>} */
    this.devices = new Map();
    /** 单调递增的全局接收序号，用于判断“回执是否发生在命令下发之后”。 */
    this.ingestSeq = 0;
    /** deviceId -> Map<alarmId, firstSeenMs>：事件去重记忆，与设备当前状态解耦。 */
    this.seenAlarms = new Map();
    /** deviceId\0alarmId -> lastAttemptMs：失败告警按稳定窗口重试，同时限制重试风暴。 */
    this.alarmAttempts = new Map();
    /** 同一设备的状态接收、离线扫描串行化，避免异步 MQTT 回调互相覆盖。 */
    this.deviceOperations = new Map();
    this.lastMessageId = 0;
    this.offlineAfterMs = requireInteger(
      options.offlineAfterMs === undefined ? DEFAULT_OFFLINE_AFTER_MS : options.offlineAfterMs,
      'offlineAfterMs', 0, 24 * 3600 * 1000
    );
    this.offlineScanMs = requireInteger(
      options.offlineScanMs === undefined ? DEFAULT_OFFLINE_SCAN_MS : options.offlineScanMs,
      'offlineScanMs', 50, 24 * 3600 * 1000
    );
    this.offlineTimer = null;
    this.running = false;
    this.unsubscribeSource = null;
    this.waiters = new Set();
    this.stoppedReason = null;

    this.onRejected = (info) => {
      this.logger.warn(`[gateway] REJECT code=${safeCode(info.code)} device=${info.deviceId || '-'}`);
    };
    if (this.transport.on) this.transport.on('commandRejected', this.onRejected);

    // 传输层用事件上报错误（如 CONNECT_SETUP_FAILED / MQTT_ERROR）。必须挂监听：
    // 否则这些错误在常驻进程里完全不可见，也无法转成安全的可观测信号。
    this.onTransportError = (info) => {
      const code = safeCode(info && info.code);
      this.logger.warn(`[gateway] CLOUD_TRANSPORT_ERROR code=${code}`);
      this.emit('cloudError', Object.freeze({ deviceId: '', code }));
    };
    if (this.transport.on) this.transport.on('transportError', this.onTransportError);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stoppedReason = null;
    if (this.statusSource && typeof this.statusSource.subscribe === 'function') {
      this.unsubscribeSource = this.statusSource.subscribe((line) => {
        void this.ingest(line).catch(() => {});
      }) || null;
    }
    if (this.commandSync && this.commandSync.enabled && typeof this.commandSync.start === 'function') {
      this.commandSync.start();
    }
    this.offlineTimer = setInterval(() => {
      void this._markOffline().catch(() => {});
    }, this.offlineScanMs);
    if (typeof this.offlineTimer.unref === 'function') this.offlineTimer.unref();
    this.logger.info(`[gateway] START mode=${this.resetMode} device=${this.deviceName || '-'}`);
    this.emit('started');
  }

  /** 正常停止：清理订阅、定时器和所有 pending 等待，绝不留下悬挂 Promise。 */
  async stop(reason = 'STOPPED') {
    this.stoppedReason = safeCode(reason);
    this.running = false;
    if (this.offlineTimer) clearInterval(this.offlineTimer);
    this.offlineTimer = null;
    if (typeof this.unsubscribeSource === 'function') {
      try { this.unsubscribeSource(); } catch { /* 忽略订阅取消失败 */ }
    }
    this.unsubscribeSource = null;
    if (this.commandSync && typeof this.commandSync.stop === 'function') {
      try { await this.commandSync.stop(this.stoppedReason); } catch { /* 命令同步停止失败不阻塞资源清理 */ }
    }
    if (this.statusSource && typeof this.statusSource.close === 'function') {
      try { await this.statusSource.close(); } catch { /* 忽略本地连接关闭失败 */ }
    }
    for (const waiter of Array.from(this.waiters)) {
      waiter.settle(false, { code: 'GATEWAY_STOPPED' });
    }
    this.waiters.clear();
    if (this.transport.off) this.transport.off('commandRejected', this.onRejected);
    if (this.transport.off && this.onTransportError) {
      this.transport.off('transportError', this.onTransportError);
    }
    this.logger.info(`[gateway] STOP reason=${this.stoppedReason}`);
    this.emit('stopped', Object.freeze({ reason: this.stoppedReason }));
  }

  /**
   * 处理一条本地 MQTT status 报文。
   * @param {Buffer|string|object} message 原始报文或已解析对象
   * @returns {Promise<{accepted:boolean, code?:string, deviceId?:string}>}
   */
  async ingest(message) {
    let text;
    try {
      text = this._toText(message);
    } catch {
      return this._reject('PAYLOAD_NOT_TEXT');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_STATUS_LINE_BYTES) {
      return this._reject('PAYLOAD_TOO_LARGE');
    }

    let raw;
    if (isPlainObject(message) && typeof message !== 'string' && !Buffer.isBuffer(message)) {
      raw = message;
    } else {
      try {
        raw = JSON.parse(text);
      } catch {
        return this._reject('INVALID_JSON');
      }
    }
    if (!isPlainObject(raw)) return this._reject('NOT_AN_OBJECT');

    const deviceId = raw.deviceId;
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      return this._reject('INVALID_DEVICE_ID');
    }
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_STATUS_LINE_BYTES) {
      return this._reject('PAYLOAD_TOO_LARGE', deviceId);
    }

    let normalized;
    try {
      normalized = normalizeIncoming(raw);
    } catch (error) {
      // adapter 已负责 13 位毫秒时间戳与未知字段/范围校验，这里只归因到安全错误码。
      const code = typeof error.message === 'string' && /timestamp/i.test(error.message)
        ? 'INVALID_TIMESTAMP'
        : 'INVALID_STATUS';
      return this._reject(code, deviceId);
    }

    // 只把通过网关完整校验的原始状态交给命令同步器。必须在异步上云之前观察，
    // 否则 OneNET 延迟可能让设备已经 ACKED，却在本地等待阶段误判超时。
    if (this.commandSync && this.commandSync.enabled && typeof this.commandSync.observe === 'function') {
      this.commandSync.observe(raw);
    }

    return this._enqueueDeviceOperation(deviceId, () => this._applyStatus(deviceId, normalized));
  }

  _enqueueDeviceOperation(deviceId, operation) {
    const previous = this.deviceOperations.get(deviceId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.deviceOperations.set(deviceId, current);
    return current.finally(() => {
      if (this.deviceOperations.get(deviceId) === current) {
        this.deviceOperations.delete(deviceId);
      }
    });
  }

  async _applyStatus(deviceId, normalized) {
    const nowMs = this.now();
    this.ingestSeq += 1;
    const seq = this.ingestSeq;
    const snapshot = describeSnapshot(normalized);
    let device = this.devices.get(deviceId);
    const isKnown = Boolean(device);
    const previousState = device ? device.state : null;
    const previousAlarmId = device ? device.alarmId : '';

    if (!device) {
      device = {
        deviceId,
        room: snapshot.room,
        state: snapshot.state,
        online: snapshot.state !== 'OFFLINE',
        monitorOnline: snapshot.monitorOnline,
        alarmId: snapshot.alarmId,
        alarmType: snapshot.alarmType,
        evidenceId: snapshot.evidenceId,
        sensors: snapshot.sensors,
        fall: snapshot.fall,
        gps: snapshot.gps,
        battery: snapshot.battery,
        csq: snapshot.csq,
        /* 原始设备 ts：仅本地严格关联/日志用；_signature 不包含它，限频逻辑不受影响 */
        deviceTs: normalized.deviceTs,
        alarmCountToday: normalized.alarmCountToday,
        lastSeenMs: nowMs,
        ingestSeq: seq,
        alarmSeq: 0,
        lastPublishAttemptMs: 0,
        lastPublishAttemptSignature: '',
        lastPublishedMs: 0,
        lastPublishedSignature: ''
      };
      this.devices.set(deviceId, device);
    } else {
      device.room = snapshot.room;
      device.state = snapshot.state;
      device.monitorOnline = snapshot.monitorOnline;
      device.alarmId = snapshot.alarmId;
      device.alarmType = snapshot.alarmType;
      device.evidenceId = snapshot.evidenceId;
      device.sensors = snapshot.sensors;
      device.fall = snapshot.fall;
      device.gps = snapshot.gps;
      device.battery = snapshot.battery;
      device.csq = snapshot.csq;
      device.deviceTs = normalized.deviceTs;
      device.alarmCountToday = normalized.alarmCountToday;
      device.online = snapshot.state !== 'OFFLINE';
      device.lastSeenMs = nowMs;
      device.ingestSeq = seq;
    }

    // 记录“当前这笔告警”被观测到的序号，供 RESET 回执判定使用：
    // 回执必须晚于该序号，否则设备“告警前”的旧 NORMAL 会被误当成 reset 回执。
    if (snapshot.state === 'ALARM' && snapshot.alarmId) {
      if (previousAlarmId !== snapshot.alarmId || !device.alarmSeq) {
        device.alarmSeq = seq;
      }
    } else {
      device.alarmSeq = 0;
    }

    const stateChanged = !isKnown || previousState !== device.state;
    const alarmChanged = previousAlarmId !== device.alarmId;
    const signature = this._signature(device);

    // 限频：状态变化立即上云；稳定状态按 stableIntervalMs 限频，避免每 5 秒无限刷云。
    const attemptedCurrentSignature = device.lastPublishAttemptSignature === signature;
    const dueForRetry = nowMs - device.lastPublishAttemptMs >= this.stableIntervalMs;
    if (!attemptedCurrentSignature || dueForRetry) {
      await this._publishProperty(device, signature, nowMs);
    }

    // 仅对新的 alarmId 发布一次 safetyAlarm。
    // 去重记忆以 deviceId+alarmId 为键、与“设备当前状态”解耦：即使设备 reset 清空状态后
    // 又收到同一条 retained 报文，也不会重复告警；设备重新产生新的 alarmId 时才再次告警。
    if (device.state === 'ALARM' && device.alarmId) {
      const key = `${deviceId}\u0000${device.alarmId}`;
      if (!this.seenAlarms.has(key)) {
        const lastAttemptMs = this.alarmAttempts.get(key);
        if (lastAttemptMs === undefined || nowMs - lastAttemptMs >= this.stableIntervalMs) {
          this.alarmAttempts.set(key, nowMs);
          this._pruneAlarmMap(this.alarmAttempts);
          const published = await this._publishAlarm(device, { countToday: device.alarmCountToday }, nowMs);
          if (published) {
            this.alarmAttempts.delete(key);
            this.seenAlarms.set(key, nowMs);
            this._pruneAlarmMap(this.seenAlarms);
          }
        }
      }
    }

    this._settleWaiters(device);

    // 同步到可信后端（旁路）：让微信小程序能拿到云数据。
    // 与 OneNET 上报一样，失败只记录安全错误码，绝不影响本地告警与聚合。
    if (this.cloudSync && this.cloudSync.enabled) {
      // 刻意不 await：后端慢或不可达时不能拖慢状态流。publish 自身从不抛异常。
      this._syncBackend(device, nowMs);
    }

    this.emit('deviceStatus', Object.freeze({
      deviceId,
      room: device.room,
      state: device.state,
      alarmId: device.alarmId,
      stateChanged,
      alarmChanged,
      online: device.online,
      monitorOnline: device.monitorOnline
    }));
    return { accepted: true, deviceId };
  }

  _signature(device) {
    return `${device.online ? '1' : '0'}|${device.state}|${device.alarmId}|${device.room}|${device.monitorOnline}`;
  }

  async _publishProperty(device, signature, nowMs) {
    // 失败不能算作“已发布”；单独记录尝试时间，在不丢重试的同时限制断线风暴。
    device.lastPublishAttemptMs = nowMs;
    device.lastPublishAttemptSignature = signature;
    try {
      await this.transport.publishProperty(this._cloudStatus(device), {
        id: this._nextMessageId(),
        timestampMs: nowMs
      });
      device.lastPublishedMs = nowMs;
      device.lastPublishedSignature = signature;
      this.emit('propertyPublished', Object.freeze({ deviceId: device.deviceId }));
      return true;
    } catch (error) {
      // 云断线不影响本地：只记录安全错误码，不中断状态聚合。
      this.logger.warn(`[gateway] CLOUD_PROPERTY_FAIL code=${safeCode(error && error.code)} device=${device.deviceId}`);
      this.emit('cloudError', Object.freeze({ deviceId: device.deviceId, code: safeCode(error && error.code) }));
      return false;
    }
  }

  async _publishAlarm(device, alarm, nowMs) {
    try {
      await this.transport.publishAlarm(this._cloudStatus(device), {
        id: this._nextMessageId(),
        timestampMs: nowMs,
        alarm: { id: device.alarmId, type: device.alarmType, countToday: alarm.countToday }
      });
      this.emit('alarmPublished', Object.freeze({ deviceId: device.deviceId, alarmId: device.alarmId }));
      return true;
    } catch (error) {
      this.logger.warn(`[gateway] CLOUD_ALARM_FAIL code=${safeCode(error && error.code)} device=${device.deviceId}`);
      this.emit('cloudError', Object.freeze({ deviceId: device.deviceId, code: safeCode(error && error.code) }));
      return false;
    }
  }

  _syncBackend(device, nowMs) {
    if (!this.cloudSync || !this.cloudSync.enabled) return;
    const status = this._cloudStatus(device);
    /* 原始设备 ts 只交给本地 backend 同步（用于严格关联日志），
     * 不进入 OneNET 上云状态对象，也不进入上传载荷。 */
    if (device.deviceTs !== undefined) status.deviceTs = device.deviceTs;
    void this.cloudSync.publish(status, nowMs).catch(() => {});
  }

  /** 把内部快照转成 adapter 能接受的云端状态结构。 */
  _cloudStatus(device) {
    const status = {
      deviceId: device.deviceId,
      room: device.room,
      online: device.online,
      // adapter.toPropertyPost 有意忽略这个本地字段，物模型不变，CloudSync 可以保留。
      monitorOnline: device.monitorOnline,
      state: device.state,
      alarm: device.alarmId
        ? { id: device.alarmId, type: device.alarmType || 'MANUAL_SOS', countToday: device.alarmCountToday || 1,
            evidenceId: device.evidenceId || '' }
        : { id: '', type: '', countToday: 0 }
    };
    if (isPlainObject(device.sensors) && Object.keys(device.sensors).length > 0) status.sensors = device.sensors;
    if (isPlainObject(device.fall)) status.fall = device.fall;
    if (isPlainObject(device.gps)) status.gps = device.gps;
    /* 电量：adapter 已归一化校验，这里只按“有就带、没有就不带”透传（契约 §4）。 */
    if (isPlainObject(device.battery)) status.battery = device.battery;
    if (device.csq !== undefined) status.csq = device.csq;
    return status;
  }

  /**
   * 生成 adapter 要求的“最多 13 位纯数字”消息 ID：(上一枚 + 1) 与当前毫秒取较大值，
   * 同一毫秒内连发递增 1，时钟回退也不会出现负值或缩短位数。
   */
  _nextMessageId() {
    const now = this.now();
    const floor = 1_000_000_000_000;
    const ceiling = 9_999_999_999_999;
    const candidate = Number.isSafeInteger(now) && now >= floor ? Math.min(now, ceiling) : floor;
    this.lastMessageId = Math.max(candidate, this.lastMessageId + 1);
    if (this.lastMessageId > ceiling) {
      // 13 位数字空间耗尽（约公元 2286 年，且同一毫秒内连发 >1 次才会触发）。
      // 宁可显式上报，也不要静默生成重复 ID 触发 DUPLICATE_MESSAGE_ID。
      this.lastMessageId = ceiling;
      this.logger.warn('[gateway] MESSAGE_ID_EXHAUSTED code=ID_SPACE_EXHAUSTED');
      this.emit('messageIdExhausted', Object.freeze({ code: 'ID_SPACE_EXHAUSTED' }));
    }
    return String(this.lastMessageId);
  }

  _toText(message) {
    if (typeof message === 'string') return message;
    if (Buffer.isBuffer(message)) return message.toString('utf8');
    if (message && typeof message.toString === 'function' && typeof message === 'object') {
      return message.toString('utf8');
    }
    fail('unsupported message type');
  }

  _reject(code, deviceId) {
    this.logger.warn(`[gateway] REJECT code=${safeCode(code)} device=${deviceId || '-'}`);
    this.emit('statusRejected', Object.freeze({ code: safeCode(code), deviceId: deviceId || '' }));
    return { accepted: false, code: safeCode(code), deviceId: deviceId || '' };
  }

  /** 每设备只保留最近 alarmMemory 条告警键，避免成功记忆或失败尝试无界增长。 */
  _pruneAlarmMap(alarmMap) {
    const perDevice = new Map();
    for (const key of alarmMap.keys()) {
      const deviceId = key.slice(0, key.indexOf('\u0000'));
      const list = perDevice.get(deviceId) || [];
      list.push(key);
      perDevice.set(deviceId, list);
    }
    for (const list of perDevice.values()) {
      for (const key of list.slice(0, Math.max(0, list.length - this.alarmMemory))) {
        alarmMap.delete(key);
      }
    }
  }

  /**
   * 按本地接收时间判在线：设备报文里没有 online 字段（ESP32 也没有），只能自己算；
   * 12 秒阈值与北向 APP 的离线判定一致。
   */
  async _markOffline() {
    const operations = [];
    for (const device of this.devices.values()) {
      operations.push(this._enqueueDeviceOperation(device.deviceId, async () => {
        const nowMs = this.now();
        if (nowMs - device.lastSeenMs <= this.offlineAfterMs) return;

        const transitioned = device.online;
        if (transitioned) {
          device.online = false;
          this.emit('deviceOffline', Object.freeze({ deviceId: device.deviceId }));
          // 后端旁路不等待 OneNET；离线转换只同步一次。
          this._syncBackend(device, nowMs);
        }

        const signature = this._signature(device);
        const pending = device.lastPublishedSignature !== signature;
        const attemptedCurrentSignature = device.lastPublishAttemptSignature === signature;
        const dueForRetry = nowMs - device.lastPublishAttemptMs >= this.stableIntervalMs;
        if (pending && (!attemptedCurrentSignature || dueForRetry)) {
          await this._publishProperty(device, signature, nowMs);
        }
      }));
    }
    await Promise.allSettled(operations);
  }

  /* ---- OneNET 下行命令（第一阶段） ---- */

  /**
   * transport 的 handleCommand 回调：返回 { ok, message? }，由 transport 转成 property/set_reply。
   */
  async handleCommand(command, context = {}) {
    if (!isPlainObject(command)) return { ok: false, message: 'invalid command' };
    const requestId = context && typeof context.requestId === 'string' ? context.requestId : '';
    const kind = command.command;

    // 纵深防御：即使调用方绕过 adapter 直接注入 handleCommand，也拒绝白名单之外的字段。
    for (const key of Object.keys(command)) {
      if (!CONTROL_KEYS.includes(key)) {
        this.logger.warn(`[gateway] DOWNLINK_REJECT code=UNKNOWN_FIELD command=${kind || '-'}`);
        return { ok: false, message: 'unsupported command' };
      }
    }

    if (command.alarmId || command.action) {
      // 第一阶段：control 物模型没有 deviceId，无法安全定向 ACK；不猜测“当前房间”。
      this.logger.warn(`[gateway] DOWNLINK_DEFERRED command=${kind || '-'} request=${requestId ? 'set' : 'unset'}`);
      return { ok: false, message: 'command not supported in this phase' };
    }

    if (kind === 'ACK' || kind === 'SET_CONFIG') {
      this.logger.warn(`[gateway] DOWNLINK_DEFERRED command=${kind}`);
      return { ok: false, message: 'command not supported in this phase' };
    }

    if (kind === 'RESET') return this._handleReset();

    return { ok: false, message: 'unsupported command' };
  }

  async _handleReset() {
    if (this.resetMode === 'local') {
      // 只复位网关自身聚合状态，绝不下发到任何房间设备。
      for (const device of this.devices.values()) {
        device.state = 'NORMAL';
        device.alarmId = '';
        device.alarmType = '';
      }
      this.logger.info('[gateway] RESET scope=local');
      return { ok: true, message: 'gateway state reset' };
    }

    const target = this._resolveResetTarget();
    if (!target) {
      this.logger.warn('[gateway] RESET_DENIED code=RESET_TARGET_UNSET');
      return { ok: false, message: 'reset target is not configured' };
    }
    if (!target.online) {
      this.logger.warn(`[gateway] RESET_DENIED code=DEVICE_OFFLINE device=${target.deviceId}`);
      return { ok: false, message: 'target device is offline' };
    }
    // RESET 的语义是“解除当前告警”，目标必须当前确实处于 ALARM；
    // 否则设备可能紧接着上报一条告警前的旧 NORMAL，被误当成 RESET 回执。
    if (target.state !== 'ALARM') {
      this.logger.warn(`[gateway] RESET_DENIED code=NO_ACTIVE_ALARM device=${target.deviceId} state=${target.state}`);
      return { ok: false, message: 'target has no active alarm to reset' };
    }

    // 回执还必须晚于当前这笔告警被观测到的时刻，
    // 否则延迟到达的旧 NORMAL 会被误当成 reset 回执。
    const alarmSeq = target.alarmSeq;
    const baselineSeq = Math.max(target.ingestSeq, Number.isSafeInteger(alarmSeq) ? alarmSeq : 0);

    const sent = await this._publishLocal(target.deviceId, 'reset');
    if (!sent) {
      this.logger.warn(`[gateway] RESET_DENIED code=LOCAL_PUBLISH_FAILED device=${target.deviceId}`);
      return { ok: false, message: 'local command channel unavailable' };
    }

    // 只有“命令下发之后新到达”的状态才算回执。
    const settled = await this._waitFor(
      target.deviceId,
      (device) => device.ingestSeq > baselineSeq && device.state !== 'ALARM'
    );
    // 日志带上序号，便于定位“没执行却回 code=200”这类问题。
    const observed = this.devices.get(target.deviceId);
    this.logger.info(
      `[gateway] RESET scope=${this.resetMode} device=${target.deviceId} result=${settled.ok ? 'OK' : settled.code}` +
      ` baselineSeq=${baselineSeq} seenSeq=${observed ? observed.ingestSeq : -1} seenState=${observed ? observed.state : '-'}`
    );
    return settled.ok
      ? { ok: true, message: 'reset confirmed by device' }
      : { ok: false, message: settled.code === 'COMMAND_TIMEOUT' ? 'device did not confirm reset' : 'reset failed' };
  }

  _resolveResetTarget() {
    if (this.resetMode === 'self') {
      return this.devices.get(this.deviceName) || null;
    }
    // target 模式需要一个明确的单台设备；多于一台时拒绝，避免误伤。
    const online = Array.from(this.devices.values()).filter((device) => device.online);
    if (online.length !== 1) return null;
    return online[0];
  }

  /**
   * 把命令发到本地下行主题 home/<deviceId>/cmd，负载必须是 JSON，例如 {"cmd":"reset"}。
   * Bridge 只认这种形式，裸命令字符串会被判为“无法解析下行命令”并静默丢弃。
   */
  async _publishLocal(deviceId, command) {
    if (!this.statusSource || typeof this.statusSource.publish !== 'function') {
      this.logger.warn('[gateway] LOCAL_PUBLISH_UNAVAILABLE');
      return false;
    }
    try {
      const result = await this.statusSource.publish(
        `home/${deviceId}/cmd`,
        JSON.stringify({ cmd: command })
      );
      return result !== false;
    } catch {
      return false;
    }
  }

  /* ---- 回执等待 ---- */

  _waitFor(deviceId, predicate) {
    if (!this.running) return Promise.resolve({ ok: false, code: 'GATEWAY_STOPPED' });
    return new Promise((resolve) => {
      const waiter = {
        deviceId,
        predicate,
        settle: (ok, info) => {
          if (!this.waiters.has(waiter)) return;
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          resolve(ok ? { ok: true } : { ok: false, code: (info && info.code) || 'COMMAND_FAILED' });
        }
      };
      waiter.timer = setTimeout(() => waiter.settle(false, { code: 'COMMAND_TIMEOUT' }), this.commandTimeoutMs);
      this.waiters.add(waiter);
    });
  }

  _settleWaiters(device) {
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.deviceId !== device.deviceId) continue;
      let matched = false;
      try { matched = Boolean(waiter.predicate(device)); } catch { matched = false; }
      if (matched) waiter.settle(true);
    }
  }
}

/* ---- 输入归一化 ---- */

/**
 * 借 adapter.toPropertyPost 做严格校验：它会先跑完整的 normalizeStatus，10 位秒时间戳、
 * 未知嵌套字段、超范围数值、非法 deviceId/room/state 都由同一套规则拒绝，参数载荷也正好
 * 是下一步要发给 OneNET 的内容。校验后只从原始报文选网关关心的字段，不拿合成值冒充设备状态。
 */
function normalizeIncoming(raw) {
  const { toPropertyPost } = require('./adapter');
  if (typeof toPropertyPost !== 'function') fail('adapter.toPropertyPost is required');
  const property = toPropertyPost(raw, { id: '1', timestampMs: Date.now() });
  // adapter 不读根级 ts，这里补上 13 位毫秒校验（10 位/11 位秒值一律拒绝）。
  if (raw.ts !== undefined) requireEpochMs(raw.ts, 'status.ts');
  const monitorOnline = raw.monitorOnline === undefined ? -1 : raw.monitorOnline;
  if (!Number.isSafeInteger(monitorOnline) || ![-1, 0, 1].includes(monitorOnline)) {
    fail('status.monitorOnline must be one of -1, 0, 1');
  }
  const alarm = isPlainObject(raw.alarm) ? raw.alarm : {};
  const params = property.params;
  const sensors = {};
  for (const key of ['motion', 'door', 'gas', 'smoke']) {
    if (params[key]) {
      const value = params[key].value;
      if (isPlainObject(value)) {
        const valid = rawSensorValid(raw, key);
        if (valid !== undefined) value.valid = valid;
      }
      sensors[key] = value;
    }
  }
  if (params.temperature || params.humidity) {
    sensors.climate = {};
    if (params.temperature) sensors.climate.tempC = params.temperature.value;
    if (params.humidity) sensors.climate.rh = params.humidity.value;
    const valid = rawSensorValid(raw, 'climate');
    if (valid !== undefined) sensors.climate.valid = valid;
  }
  return {
    deviceId: raw.deviceId,
    room: raw.room,
    state: raw.state,
    deviceTs: raw.ts === undefined ? undefined : raw.ts,
    monitorOnline,
    alarmId: typeof alarm.id === 'string' && alarm.id.length > 0 ? alarm.id : '',
    alarmType: typeof alarm.type === 'string' && alarm.type.length > 0 ? alarm.type : '',
    alarmCountToday: Number.isSafeInteger(alarm.countToday) ? alarm.countToday : 0,
    evidenceId: typeof alarm.evidenceId === 'string' ? alarm.evidenceId : '',
    sensors,
    fall: params.fall ? params.fall.value : undefined,
    gps: params.gps ? params.gps.value : undefined,
    /* 电量：adapter.normalizeStatus 已严格校验（契约 §3），这里只取归一化结果透传。 */
    battery: params.battery ? params.battery.value : undefined,
    csq: params.csq ? params.csq.value : undefined
  };
}

/**
 * 用注入的依赖组装一个网关实例，并把网关自己的 handleCommand 接进 transport。
 *
 * @param {object} options
 * @param {object} options.env                用于读取本地 Broker 与网关配置；默认 process.env
 * @param {object} [options.transport]        已构造的 transport；省略时用 createTransportFromEnv
 * @param {Function} [options.createTransport] (env, overrides) => transport
 * @param {Function} [options.createStatusSource] (options) => { subscribe, publish, close }
 * @returns {HomeCloudGateway}
 */
function createGateway(options = {}) {
  if (!isPlainObject(options)) fail('options must be a plain object');
  const env = options.env || process.env;
  // env 是配置容器（生产入口就是 process.env），不是不可信载荷；它的原型不是
  // Object.prototype，用 isPlainObject 会把生产入口挡死，所以只要求非 null 对象且非数组。
  if (!isEnvLike(env)) fail('env must be an object');

  const deviceName = options.deviceName || env.ONENET_DEVICE_NAME || '';
  const resetMode = options.resetMode || env.GATEWAY_RESET_MODE || 'self';
  const statusTopic = options.statusTopic || env.GATEWAY_STATUS_TOPIC || DEFAULT_STATUS_TOPIC;
  const brokerUrl = options.brokerUrl || env.GATEWAY_BROKER_URL || DEFAULT_BROKER_URL;

  let gateway = null;
  const overrides = {
    handleCommand: (command, context) => {
      if (!gateway) return Promise.resolve({ ok: false, message: 'gateway not ready' });
      return gateway.handleCommand(command, context);
    }
  };
  if (options.transport) {
    if (typeof options.transport.setCommandHandler === 'function') {
      options.transport.setCommandHandler(overrides.handleCommand);
    }
  }

  const transport = options.transport
    || (options.createTransport || defaultCreateTransport)(env, overrides);

  const statusSource = options.statusSource
    || (options.createStatusSource || defaultCreateStatusSource)({ brokerUrl, statusTopic });

  // 可信后端同步：显式传 cloudSync 就用它；显式传 null 表示明确关闭；
  // 未指定时按环境变量决定（缺 BACKEND_INGEST_KEY 会得到一个 disabled 客户端，不报错）。
  let cloudSync = options.cloudSync;
  if (cloudSync === undefined) {
    const { createCloudSyncFromEnv } = require('./cloud-sync');
    cloudSync = createCloudSyncFromEnv(env, options.cloudSyncOptions);
  }

  // 后端 ACK 命令同步器与网关复用同一个本地 MQTT 状态源。缺 ingest key 时它保持 disabled，
  // 不发 HTTP、不启动轮询；启用后下行仍只允许精确的 home/<deviceId>/cmd 主题。
  let commandSync = options.commandSync;
  if (commandSync === undefined) {
    const { createCommandSyncFromEnv } = require('./command-sync');
    const commandSyncOptions = Object.assign({
      logger: options.logger,
      publishCommand: (_deviceId, _payload, topic, message) => {
        if (!statusSource || typeof statusSource.publish !== 'function') return false;
        return statusSource.publish(topic, message);
      }
    }, options.commandSyncOptions);
    commandSync = createCommandSyncFromEnv(env, commandSyncOptions);
  }

  gateway = new HomeCloudGateway({
    transport,
    statusSource,
    deviceName,
    resetMode,
    commandTimeoutMs: options.commandTimeoutMs,
    stableIntervalMs: options.stableIntervalMs,
    alarmMemory: options.alarmMemory,
    now: options.now,
    logger: options.logger,
    cloudSync,
    commandSync
  });
  gateway.brokerUrl = brokerUrl;
  gateway.statusTopic = statusTopic;
  return gateway;
}

function defaultCreateTransport(env, overrides) {
  const { createTransportFromEnv } = require('./transport');
  return createTransportFromEnv(env, overrides);
}

/**
 * 默认本地状态源：mqtt.js 客户端连本地 Broker，订阅 home/+/status。
 * 采用指数退避重连；Broker 断线只影响上云，不影响本地告警与 APP。
 */
function defaultCreateStatusSource({ brokerUrl, statusTopic, logger = console }) {
  const mqtt = require('mqtt');
  const handlers = new Set();
  let closed = false;
  let attempt = 0;
  let timer = null;

  const client = mqtt.connect(brokerUrl, {
    clientId: `home-cloud-gateway-${Date.now() % 100000}`,
    clean: true,
    reconnectPeriod: 0
  });

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(DEFAULT_RECONNECT_MAX_MS, DEFAULT_RECONNECT_MIN_MS * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      logger.warn(`[gateway] LOCAL_RECONNECT attempt=${attempt}`);
      try { client.reconnect(); } catch { scheduleReconnect(); }
    }, delay);
  };

  client.on('connect', () => {
    attempt = 0;
    client.subscribe(statusTopic, { qos: 0 }, (error) => {
      if (error) logger.warn(`[gateway] LOCAL_SUBSCRIBE_FAIL code=SUBSCRIBE_FAILED`);
      else logger.info(`[gateway] LOCAL_SUBSCRIBED topic=${statusTopic}`);
    });
  });
  client.on('message', (topic, payload) => {
    const match = STATUS_TOPIC_RE.exec(topic);
    if (!match) return;
    for (const handler of Array.from(handlers)) {
      try { handler(payload, match[1]); } catch { /* 单个订阅者异常不影响其他人 */ }
    }
  });
  client.on('close', () => {
    logger.warn('[gateway] LOCAL_DISCONNECTED code=BROKER_CLOSED');
    scheduleReconnect();
  });
  client.on('error', () => {
    logger.warn('[gateway] LOCAL_ERROR code=BROKER_ERROR');
  });

  return {
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    publish(topic, message) {
      if (!client.connected) return Promise.resolve(false);
      return new Promise((resolve) => {
        try {
          /* 本地命令走 QoS0，避免 Broker 的 QoS1 握手阻塞 command-sync 的发布回调；
             ACK 是否完成仍由同一 deviceId + alarmId 的 ACKED 观测决定，HTTP 202 只代表受理。 */
          client.publish(topic, message, { qos: 0, retain: false }, (error) => {
            resolve(!error);
          });
        } catch {
          resolve(false);
        }
      });
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      handlers.clear();
      return new Promise((resolve) => client.end(false, {}, resolve));
    }
  };
}

/* ---- 常驻入口 ---- */

/**
 * 启动前只校验非敏感必填项。库函数要能在测试里用合成配置，所以不在 createGateway 里强制；
 * 但缺 productId/deviceName 时 MQTT CONNECT 会以难懂的原因失败，常驻进程看着在跑却没意义。
 * 这里只报变量名，不打印密钥；设备密钥允许运行期注入，不在此强制。
 */
function assertRequiredEnv(env) {
  const missing = [];
  if (!env.ONENET_PRODUCT_ID) missing.push('ONENET_PRODUCT_ID');
  if (!env.ONENET_DEVICE_NAME) missing.push('ONENET_DEVICE_NAME');
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`missing required configuration: ${missing.join(', ')}`),
      { code: 'MISSING_CONFIGURATION' }
    );
  }
  return { productId: env.ONENET_PRODUCT_ID, deviceName: env.ONENET_DEVICE_NAME };
}

async function main() {
  const config = assertRequiredEnv(process.env);
  const gateway = createGateway({});
  // 只打印非敏感元数据；绝不含设备密钥。
  console.log(`[gateway] CONFIG productId=${config.productId} deviceName=${config.deviceName}`);
  console.log(`[gateway] CONFIG deviceKey=${process.env.ONENET_DEVICE_KEY ? 'set' : 'unset'}`);
  const shutdown = async (signal) => {
    await gateway.stop(signal);
    if (gateway.transport && typeof gateway.transport.stop === 'function') {
      try { await gateway.transport.stop(); } catch { /* 忽略传输层关闭异常 */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  gateway.start();
  if (gateway.transport && typeof gateway.transport.start === 'function') gateway.transport.start();
}

if (require.main === module) {
  main().catch((error) => {
    const code = safeCode(error && error.code);
    // 允许用 GATEWAY_DEBUG=1 打印堆栈；默认只输出安全错误码与消息，避免把载荷带进日志。
    console.error(`[gateway] FATAL code=${code} message=${(error && error.message) || 'unknown'}`);
    if (process.env.GATEWAY_DEBUG === '1' && error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
}

module.exports = Object.freeze({
  HomeCloudGateway,
  createGateway,
  describeSnapshot,
  assertRequiredEnv,
  CONTROL_KEYS,
  DEFAULT_STATUS_TOPIC,
  DEFAULT_BROKER_URL
});
