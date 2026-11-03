'use strict';

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MESSAGE_ID_RE = /^\d{1,13}$/;
const DEVICE_STATES = new Set(['NORMAL', 'WARN', 'ALARM', 'ACKED', 'OFFLINE']);
const ALARM_TYPES = new Set([
  'NO_MOTION', 'MANUAL_SOS', 'CLIMATE', 'GAS', 'SMOKE', 'FALL'
]);
const MAX_PAYLOAD_BYTES = 16 * 1024;
/* 门磁补传缓存上限：固件 NODE_DOOR_CACHE_MAX 默认 8 条，这里留一倍余量并防无界数组。 */
const MAX_DOOR_EVENTS = 16;
/* 电量（契约 BATTERY-CHAIN-CONTRACT.md §2/§3）：
 *   - source: "battery"（接了电池采样）| "fixed"（固定供电，不输出该字段时缺省）
 *   - mv: 0..60000 整数或 null；percent: 0..100 整数或 null；low/valid/present/calibrated: bool
 *   - reason: 短码 [A-Z_]{0,16}（"" 表示无异常）
 * 交叉校验，防止伪造值进后端/APP：
 *   - valid=true 必须 source="battery" 且 mv 为正整数（0mV 永远不是有效电池电压）
 *   - valid=false 时 mv/percent 必须为 null、low 为 false，设备不得自相矛盾
 *   - percent 非 null 时必须 calibrated=true 且 valid=true（未标定不给百分比）
 *   - source="fixed" 时 present/valid/low 必须全为 false，mv/percent 为 null
 */
const BATTERY_SOURCES = new Set(['battery', 'fixed']);
const BATTERY_FIELDS = ['source', 'present', 'valid', 'mv', 'percent', 'low', 'calibrated', 'reason'];
const BATTERY_REQUIRED_FIELDS = ['source', 'present', 'valid', 'mv', 'percent', 'low', 'calibrated'];
const BATTERY_REASON_RE = /^[A-Z_]{0,16}$/;
const BATTERY_MV_MAX = 60000;

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) fail(`${name} must be a plain object`);
  return value;
}

function requireExactKeys(value, allowed, name, required = allowed) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.includes(key)) fail(`${name} contains unknown field: ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${name}.${key} is required`);
  }
}

function requireString(value, name, minLength, maxLength) {
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    fail(`${name} must be a string of ${minLength}-${maxLength} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${name} contains control characters`);
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean`);
  return value;
}

function requireFinite(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${name} must be a finite number in [${min}, ${max}]`);
  }
  return value;
}

function requireInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requireSegment(value, name) {
  if (typeof value !== 'string' || !SEGMENT_RE.test(value)) {
    fail(`${name} must match ${SEGMENT_RE}`);
  }
  return value;
}

function requireMessageId(value) {
  if (typeof value !== 'string' || !MESSAGE_ID_RE.test(value)) {
    fail(`message id must match ${MESSAGE_ID_RE}`);
  }
  return value;
}

function utcNowMs() {
  return Date.now();
}

function requireTimestampMs(value, name = 'timestampMs', allowZero = false) {
  if (allowZero && value === 0) return 0;
  if (!Number.isSafeInteger(value) || value < 1_000_000_000_000 || value > 9_999_999_999_999) {
    fail(`${name} must be a 13-digit UTC Unix timestamp in milliseconds`);
  }
  return value;
}

function buildTopics(productId, deviceName) {
  const product = requireSegment(productId, 'productId');
  const device = requireSegment(deviceName, 'deviceName');
  const base = `$sys/${product}/${device}/thing`;
  return Object.freeze({
    propertyPost: `${base}/property/post`,
    propertyPostReply: `${base}/property/post/reply`,
    propertySet: `${base}/property/set`,
    propertySetReply: `${base}/property/set_reply`,
    eventPost: `${base}/event/post`,
    eventPostReply: `${base}/event/post/reply`
  });
}

function parseObjectPayload(payload, name) {
  if (Buffer.isBuffer(payload)) {
    if (payload.length > MAX_PAYLOAD_BYTES) fail(`${name} exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    payload = payload.toString('utf8');
  }
  if (typeof payload === 'string') {
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      fail(`${name} exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    try {
      payload = JSON.parse(payload);
    } catch {
      fail(`${name} is not valid JSON`);
    }
  }
  return requirePlainObject(payload, name);
}

function oneJsonValue(value, time) {
  return { value, time };
}

function optionalObject(value, name) {
  if (value === undefined) return undefined;
  return requirePlainObject(value, name);
}

function normalizeMotion(status) {
  const sensors = optionalObject(status.sensors, 'status.sensors');
  const motion = status.motion !== undefined
    ? requirePlainObject(status.motion, 'status.motion')
    : sensors && sensors.motion !== undefined
      ? requirePlainObject(sensors.motion, 'status.sensors.motion')
      : undefined;
  if (!motion) return undefined;
  /* DAYU 侧 homemon 重启后会额外上报 supported/reported/reason（能力声明，例如客厅没有
   * PIR 时 supported=false、reason="not_configured"）。这些字段只做类型校验，不透传给
   * 上云载荷或后端合同，处理方式和 climate.valid 一致。 */
  requireExactKeys(
    motion,
    ['lastActiveTs', 'countToday', 'supported', 'reported', 'reason'],
    'motion',
    ['lastActiveTs', 'countToday']
  );
  if (motion.supported !== undefined) requireBoolean(motion.supported, 'motion.supported');
  if (motion.reported !== undefined) requireBoolean(motion.reported, 'motion.reported');
  if (motion.reason !== undefined) requireString(motion.reason, 'motion.reason', 0, 32);
  return {
    lastActiveTs: requireTimestampMs(motion.lastActiveTs, 'motion.lastActiveTs', true),
    countToday: requireInteger(motion.countToday, 'motion.countToday', 0, 1_000_000_000)
  };
}

function normalizeDoor(status) {
  const sensors = optionalObject(status.sensors, 'status.sensors');
  const door = status.door !== undefined
    ? requirePlainObject(status.door, 'status.door')
    : sensors && sensors.door !== undefined
      ? requirePlainObject(sensors.door, 'status.sensors.door')
      : undefined;
  if (!door) return undefined;
  /* 门磁 v7 契约（后端 schema v7）：open/lastOpenTs 必须保留，lastCloseTs/seq/events 可选。
   * 扩展字段只做严格类型校验后透传，不补默认值、不猜状态。 */
  requireExactKeys(
    door,
    ['open', 'lastOpenTs', 'lastCloseTs', 'seq', 'events'],
    'door',
    ['open', 'lastOpenTs']
  );
  const normalized = {
    /* open 允许 null：固件上电基线未知时明确表达“未知”，不得默认成关闭。 */
    open: door.open === null ? null : requireBoolean(door.open, 'door.open'),
    lastOpenTs: requireTimestampMs(door.lastOpenTs, 'door.lastOpenTs', true)
  };
  if (door.lastCloseTs !== undefined) {
    normalized.lastCloseTs = requireTimestampMs(door.lastCloseTs, 'door.lastCloseTs', true);
  }
  if (door.seq !== undefined) {
    normalized.seq = requireInteger(door.seq, 'door.seq', 0, Number.MAX_SAFE_INTEGER);
  }
  if (door.events !== undefined) {
    if (!Array.isArray(door.events)) fail('door.events must be an array');
    if (door.events.length > MAX_DOOR_EVENTS) {
      fail(`door.events must contain at most ${MAX_DOOR_EVENTS} entries`);
    }
    normalized.events = door.events.map((event, index) => {
      const name = `door.events[${index}]`;
      requirePlainObject(event, name);
      requireExactKeys(event, ['seq', 'open', 'ts'], name);
      return {
        seq: requireInteger(event.seq, `${name}.seq`, 1, Number.MAX_SAFE_INTEGER),
        open: requireBoolean(event.open, `${name}.open`),
        ts: requireTimestampMs(event.ts, `${name}.ts`, true)
      };
    });
  }
  return normalized;
}

function normalizeOkSensor(status, key) {
  const sensors = optionalObject(status.sensors, 'status.sensors');
  const source = status[key] !== undefined ? status[key] : sensors && sensors[key];
  if (source === undefined) return undefined;
  if (typeof source === 'boolean') return { ok: source, raw: 0 };
  const sensor = requirePlainObject(source, `status.${key}`);
  /* 兼容新增的布尔字段 valid（本次读取成功才为 true）：只校验类型，不透传给上云载荷，
   * 后端合同保持不变。 */
  requireExactKeys(sensor, ['ok', 'raw', 'valid'], key, ['ok', 'raw']);
  const out = {
    ok: requireBoolean(sensor.ok, `${key}.ok`),
    raw: requireFinite(sensor.raw, `${key}.raw`, 0, 1_000_000_000)
  };
  if (sensor.valid !== undefined) requireBoolean(sensor.valid, `${key}.valid`);
  return out;
}

function normalizeClimate(status) {
  const sensors = optionalObject(status.sensors, 'status.sensors');
  const climate = sensors && sensors.climate !== undefined
    ? requirePlainObject(sensors.climate, 'status.sensors.climate')
    : undefined;
  /* 兼容新增的 climate.valid：校验类型，不透传 */
  if (climate && climate.valid !== undefined) requireBoolean(climate.valid, 'status.sensors.climate.valid');
  const temperature = status.temperature !== undefined
    ? status.temperature
    : climate && climate.tempC;
  const humidity = status.humidity !== undefined
    ? status.humidity
    : climate && climate.rh;
  return {
    temperature: temperature === undefined
      ? undefined
      : requireFinite(temperature, 'temperature', -50, 100),
    humidity: humidity === undefined
      ? undefined
      : requireFinite(humidity, 'humidity', 0, 100)
  };
}

function normalizeAlarm(value, required) {
  if (value === undefined) {
    if (required) fail('alarm is required');
    return undefined;
  }
  const alarm = requirePlainObject(value, 'alarm');
  requireExactKeys(alarm, ['id', 'type', 'countToday', 'detail', 'evidenceId'], 'alarm', ['id', 'type', 'countToday']);
  // evidenceId 在入口校验，但有意不映射进 OneNET 物模型：图片证据只走可信家庭 API。
  if (alarm.evidenceId !== undefined && (typeof alarm.evidenceId !== 'string' ||
      (alarm.evidenceId !== '' && !/^fall-[0-9]{1,16}-(?:na|[0-9]{1,12})$/.test(alarm.evidenceId)))) {
    fail('alarm.evidenceId is invalid');
  }
  const id = requireString(alarm.id, 'alarm.id', required ? 1 : 0, 96);
  const type = requireString(alarm.type, 'alarm.type', required ? 1 : 0, 32);
  if (type && !ALARM_TYPES.has(type)) fail(`alarm.type is not supported: ${type}`);
  const out = {
    id,
    type,
    countToday: requireInteger(alarm.countToday, 'alarm.countToday', 0, 1_000_000)
  };
  if (alarm.detail !== undefined) out.detail = requireString(alarm.detail, 'alarm.detail', 0, 256);
  return out;
}

function normalizeGps(value) {
  if (value === undefined) return undefined;
  const gps = requirePlainObject(value, 'gps');
  requireExactKeys(gps, ['valid', 'latitude', 'longitude', 'altitude', 'fixTime'], 'gps', []);
  const valid = gps.valid === undefined ? true : requireBoolean(gps.valid, 'gps.valid');
  if (valid && (gps.latitude === undefined || gps.longitude === undefined)) {
    fail('valid gps requires latitude and longitude');
  }
  const out = {
    valid,
    fixTime: gps.fixTime === undefined ? 0 : requireTimestampMs(gps.fixTime, 'gps.fixTime', true)
  };
  if (gps.latitude !== undefined) {
    out.latitude = requireFinite(gps.latitude, 'gps.latitude', -90, 90);
  }
  if (gps.longitude !== undefined) {
    out.longitude = requireFinite(gps.longitude, 'gps.longitude', -180, 180);
  }
  if (gps.altitude !== undefined) {
    out.altitude = requireFinite(gps.altitude, 'gps.altitude', -1000, 100000);
  }
  return out;
}

function normalizeFall(value) {
  if (value === undefined) return undefined;
  const fall = requirePlainObject(value, 'fall');
  requireExactKeys(fall, ['detected', 'confidence', 'detectedAt'], 'fall');
  const detected = requireBoolean(fall.detected, 'fall.detected');
  const detectedAt = requireTimestampMs(fall.detectedAt, 'fall.detectedAt', true);
  if (detected && detectedAt === 0) fail('detected fall requires a detection timestamp');
  return {
    detected,
    confidence: requireFinite(fall.confidence, 'fall.confidence', 0, 1),
    detectedAt
  };
}

/* 电量归一化（严格）：未知字段拒绝、类型/范围校验，并做交叉校验保证不自相矛盾。
 * 缺失（undefined）返回 undefined -> normalizeStatus 返回 battery: undefined；
 * 后端/APP 把“缺失”当“该设备没有电量数据”，绝不默认成 0 或任何百分比。 */
function normalizeBattery(value) {
  if (value === undefined) return undefined;
  const battery = requirePlainObject(value, 'status.battery');
  requireExactKeys(battery, BATTERY_FIELDS, 'battery', BATTERY_REQUIRED_FIELDS);
  const source = battery.source;
  if (typeof source !== 'string' || !BATTERY_SOURCES.has(source)) {
    fail('battery.source must be "battery" or "fixed"');
  }
  const present = requireBoolean(battery.present, 'battery.present');
  const valid = requireBoolean(battery.valid, 'battery.valid');
  const low = requireBoolean(battery.low, 'battery.low');
  const calibrated = requireBoolean(battery.calibrated, 'battery.calibrated');
  const mv = battery.mv === null ? null : requireInteger(battery.mv, 'battery.mv', 0, BATTERY_MV_MAX);
  const percent = battery.percent === null
    ? null
    : requireInteger(battery.percent, 'battery.percent', 0, 100);
  const reason = battery.reason === undefined ? '' : battery.reason;
  if (typeof reason !== 'string' || !BATTERY_REASON_RE.test(reason)) {
    fail('battery.reason must match [A-Z_]{0,16}');
  }
  if (source === 'fixed') {
    if (present || valid || low || mv !== null || percent !== null) {
      fail('fixed power supply must not report battery presence/voltage/percent');
    }
  }
  if (valid) {
    if (source !== 'battery') fail('valid battery requires source "battery"');
    if (mv === null || mv <= 0) fail('valid battery requires a positive mv reading');
  } else if (mv !== null || percent !== null || low) {
    /* 无效读数不得带电压/百分比/低电量结论（否则下游会拿 null-valid 的数当真） */
    fail('invalid battery must not carry mv/percent/low');
  }
  if (percent !== null && (!calibrated || !valid)) {
    fail('battery.percent requires calibrated=true and valid=true');
  }
  return { source, present, valid, mv, percent, low, calibrated, reason };
}

function normalizeStatus(status) {
  requirePlainObject(status, 'status');
  const deviceId = requireSegment(status.deviceId, 'status.deviceId');
  const room = requireString(status.room, 'status.room', 1, 64);
  const state = requireString(status.state, 'status.state', 1, 16);
  if (!DEVICE_STATES.has(state)) fail(`status.state is not supported: ${state}`);
  const online = status.online === undefined ? state !== 'OFFLINE' : requireBoolean(status.online, 'status.online');
  const motion = normalizeMotion(status);
  const door = normalizeDoor(status);
  const climate = normalizeClimate(status);
  const gas = normalizeOkSensor(status, 'gas');
  const smoke = normalizeOkSensor(status, 'smoke');
  const fall = normalizeFall(status.fall);
  const alarm = normalizeAlarm(status.alarm, false);
  const gps = normalizeGps(status.gps);
  const battery = normalizeBattery(status.battery);
  const csq = status.csq === undefined ? undefined : requireInteger(status.csq, 'status.csq', 0, 99);
  if (csq !== undefined && csq > 31 && csq !== 99) fail('status.csq must be 0-31 or 99');
  return { deviceId, room, online, state, motion, door, ...climate, gas, smoke, fall, alarm, gps, battery, csq };
}

function makeEnvelope(params, options = {}) {
  requirePlainObject(options, 'options');
  requireExactKeys(options, ['id', 'timestampMs'], 'options', []);
  const time = options.timestampMs === undefined
    ? utcNowMs()
    : requireTimestampMs(options.timestampMs);
  const id = options.id === undefined ? String(time) : requireMessageId(options.id);
  return { id, version: '1.0', params, time };
}

function toPropertyPost(status, options = {}) {
  const normalized = normalizeStatus(status);
  const envelope = makeEnvelope({}, options);
  const time = envelope.time;
  const params = {
    deviceId: oneJsonValue(normalized.deviceId, time),
    room: oneJsonValue(normalized.room, time),
    online: oneJsonValue(normalized.online, time),
    state: oneJsonValue(normalized.state, time)
  };
  for (const key of ['motion', 'door', 'temperature', 'humidity', 'gas', 'smoke', 'fall', 'alarm', 'gps', 'battery', 'csq']) {
    if (normalized[key] !== undefined) params[key] = oneJsonValue(normalized[key], time);
  }
  return { id: envelope.id, version: envelope.version, params };
}

function toAlarmEvent(status, options = {}) {
  const normalized = normalizeStatus(status);
  const alarm = normalizeAlarm(status.alarm, true);
  if (normalized.state !== 'ALARM') fail('alarm event requires status.state to be ALARM');
  const envelope = makeEnvelope({}, options);
  const value = {
    deviceId: normalized.deviceId,
    room: normalized.room,
    alarmId: alarm.id,
    type: alarm.type,
    countToday: alarm.countToday
  };
  if (alarm.detail !== undefined) value.detail = alarm.detail;
  if (normalized.gps !== undefined) value.gps = normalized.gps;
  return {
    id: envelope.id,
    version: envelope.version,
    params: { safetyAlarm: oneJsonValue(value, envelope.time) }
  };
}

function unwrapControl(value) {
  const control = requirePlainObject(value, 'params.control');
  if (Object.keys(control).length === 1 && Object.prototype.hasOwnProperty.call(control, 'value')) {
    return requirePlainObject(control.value, 'params.control.value');
  }
  return control;
}

function mapAck(control) {
  requireExactKeys(control, ['command', 'alarmId', 'action'], 'control');
  return Object.freeze({
    command: 'ACK',
    alarmId: requireString(control.alarmId, 'control.alarmId', 1, 96),
    action: requireString(control.action, 'control.action', 1, 120)
  });
}

function mapReset(control) {
  requireExactKeys(control, ['command', 'alarmId', 'action'], 'control', ['command']);
  for (const key of ['alarmId', 'action']) {
    if (control[key] !== undefined && control[key] !== '') {
      fail(`control.${key} must be empty for RESET`);
    }
  }
  return Object.freeze({ command: 'RESET' });
}

function mapSetConfig(control) {
  requireExactKeys(
    control,
    ['command', 'noMotionSec', 'reportIntervalSec'],
    'control',
    ['command']
  );
  if (control.noMotionSec === undefined && control.reportIntervalSec === undefined) {
    fail('SET_CONFIG must contain at least one allowed setting');
  }
  const mapped = {};
  if (control.noMotionSec !== undefined) {
    mapped.noMotionSec = requireInteger(control.noMotionSec, 'control.noMotionSec', 30, 86400);
  }
  if (control.reportIntervalSec !== undefined) {
    mapped.reportIntervalSec = requireInteger(control.reportIntervalSec, 'control.reportIntervalSec', 1, 3600);
  }
  return Object.freeze({ command: 'SET_CONFIG', config: Object.freeze(mapped) });
}

function mapPropertySet(payload) {
  const root = parseObjectPayload(payload, 'property/set payload');
  requireExactKeys(root, ['id', 'version', 'params'], 'property/set payload');
  const id = requireMessageId(root.id);
  if (root.version !== '1.0') fail('property/set payload.version must be 1.0');
  const params = requirePlainObject(root.params, 'property/set payload.params');
  requireExactKeys(params, ['control'], 'property/set payload.params');
  const control = unwrapControl(params.control);
  const command = requireString(control.command, 'control.command', 1, 16);
  let mapped;
  if (command === 'ACK') mapped = mapAck(control);
  else if (command === 'RESET') mapped = mapReset(control);
  else if (command === 'SET_CONFIG') mapped = mapSetConfig(control);
  else fail(`unsupported command: ${command}`);
  return Object.freeze({ requestId: id, command: mapped });
}

function makePropertySetReply(requestId, result) {
  const id = requireMessageId(requestId);
  requirePlainObject(result, 'result');
  requireExactKeys(result, ['ok', 'message'], 'result', ['ok']);
  const ok = requireBoolean(result.ok, 'result.ok');
  const reply = { id, code: ok ? 200 : 400, msg: ok ? 'success' : 'rejected' };
  if (result.message !== undefined) {
    reply.msg = requireString(result.message, 'result.message', 1, 128);
  }
  return reply;
}

module.exports = Object.freeze({
  ALARM_TYPES,
  DEVICE_STATES,
  buildTopics,
  makePropertySetReply,
  mapPropertySet,
  toAlarmEvent,
  toPropertyPost,
  utcNowMs
});
