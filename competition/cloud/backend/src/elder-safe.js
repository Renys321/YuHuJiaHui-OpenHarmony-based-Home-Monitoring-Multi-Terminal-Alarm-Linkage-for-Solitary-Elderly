'use strict';

/**
 * 老人自述安全事件的纯逻辑核心：只做“记录 + 读回展示”。
 *
 * 不读写告警、不生成 ACK 命令、不改 alert 状态；不接受客户端身份，
 * 也不落 openid/token/API Key/完整手机号。纯函数，无 IO。
 */

/** 与设备状态摄入一致的设备 ID 规则（避免两套口径）。 */
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 与既有告警 ID 规则一致（网关透传原始 alarmId 时可直接校验）。 */
const ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
/** 房间名最长 40 字符（与留言/处置文案口径接近）。 */
const ROOM_MAX = 40;
/** 自述文本最长 200 字符（按 UTF-16 code unit 计数）。 */
const TEXT_MAX = 200;
/** source 为短机器码（如 voice-gateway / s3 / board）。 */
const SOURCE_RE = /^[A-Za-z0-9._-]{1,32}$/;
const DEFAULT_SOURCE = 'voice-gateway';

/** 单户部署下限：只保留最近 200 条（需求：cap ~200）。 */
const ELDER_SAFE_CAP = 200;
/** 保留 7 天（需求：retention ~7 days）。 */
const ELDER_SAFE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 允许的时钟超前容差，超过就当非法 at。 */
const FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** 请求体严格白名单。 */
const ELDER_SAFE_FIELDS = Object.freeze(['deviceId', 'room', 'alarmId', 'text', 'at', 'source']);
const ELDER_SAFE_FIELD_SET = new Set(ELDER_SAFE_FIELDS);

/** 公开/持久化形状白名单（不含任何内部字段）。 */
const PUBLIC_ELDER_SAFE_FIELDS = Object.freeze([
  'eventId', 'deviceId', 'room', 'alarmId', 'text', 'at', 'source'
]);
const PUBLIC_ELDER_SAFE_FIELD_SET = new Set(PUBLIC_ELDER_SAFE_FIELDS);

const EVENT_ID_RE = /^es-[1-9][0-9]{0,15}$/;
/** C0 / DEL / C1 控制字符（换行已先归一成空格）。 */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;
/** 11 位中国大陆手机号：出现在自述文本里必须打码，绝不原样落盘。 */
const PHONE_RE = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;
/** 明显像密钥的片段：宁可拒绝记录，也不把疑似密钥写进台账。 */
const SECRET_LIKE_RE = /\bsk-[A-Za-z0-9_-]{16,}|\bbearer\s+[A-Za-z0-9._-]{16,}/i;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 手机号打码：保留前 3 后 4（与 APP 既有脱敏口径一致）。 */
function maskPhone(match) {
  return `${match.slice(0, 3)}****${match.slice(-4)}`;
}

function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n|[\r\n]/g, ' ').trim().replace(PHONE_RE, maskPhone);
  if (text.length === 0 || text.length > TEXT_MAX) return null;
  if (CONTROL_CHAR_RE.test(text)) return null;
  if (SECRET_LIKE_RE.test(text)) return null;
  return text;
}

function normalizeRoom(value) {
  if (typeof value !== 'string') return null;
  const room = value.trim();
  if (room.length === 0 || room.length > ROOM_MAX) return null;
  if (CONTROL_CHAR_RE.test(room)) return null;
  return room;
}

/**
 * 校验网关上报的一条自述安全事件。
 *
 * @param {*} input JSON 请求体（任意类型）
 * @param {number} [nowMs] 服务端当前时间（用于 at 缺省与超前校验）
 * @returns {{ok: boolean, errors: object, value: object|null}}
 *   失败时不回显提交值，只描述字段问题。
 */
function validateElderSafeInput(input, nowMs = Date.now()) {
  const errors = {};
  if (!isPlainObject(input)) {
    return { ok: false, errors: { body: '请求体必须是对象' }, value: null };
  }
  for (const key of Object.keys(input)) {
    if (!ELDER_SAFE_FIELD_SET.has(key)) errors[key] = '该字段不允许提交';
  }

  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : '';
  if (!DEVICE_ID_RE.test(deviceId)) errors.deviceId = 'deviceId 必须是 1-64 位字母、数字、点、下划线或连字符';

  const room = normalizeRoom(input.room);
  if (room === null) errors.room = `room 必须是 1-${ROOM_MAX} 字符且不含控制字符`;

  let alarmId = '';
  if (input.alarmId !== undefined && input.alarmId !== null && input.alarmId !== '') {
    if (typeof input.alarmId !== 'string' || !ALARM_ID_RE.test(input.alarmId.trim())) {
      errors.alarmId = 'alarmId 格式非法';
    } else {
      alarmId = input.alarmId.trim();
    }
  }

  const text = normalizeText(input.text);
  if (text === null) {
    errors.text = `text 必须是 1-${TEXT_MAX} 字符、不含控制字符或疑似密钥`;
  }

  let at = Number.isSafeInteger(nowMs) && nowMs > 0 ? nowMs : Date.now();
  if (input.at !== undefined && input.at !== null) {
    if (!Number.isSafeInteger(input.at) || input.at <= 0) {
      errors.at = 'at 必须是正整数毫秒时间戳';
    } else if (input.at > at + FUTURE_SKEW_TOLERANCE_MS) {
      errors.at = 'at 不能明显超前于服务器时间';
    } else {
      at = input.at;
    }
  }

  let source = DEFAULT_SOURCE;
  if (input.source !== undefined && input.source !== null && input.source !== '') {
    if (typeof input.source !== 'string' || !SOURCE_RE.test(input.source.trim())) {
      errors.source = 'source 必须是 1-32 位机器码';
    } else {
      source = input.source.trim();
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: {},
    value: Object.freeze({ deviceId, room, alarmId, text, at, source })
  };
}

/** 校验已持久化的事件（严格白名单；用于加载时 fail-closed）。 */
function validateStoredElderSafeEvent(value) {
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) {
    if (!PUBLIC_ELDER_SAFE_FIELD_SET.has(key)) return null;
  }
  if (typeof value.eventId !== 'string' || !EVENT_ID_RE.test(value.eventId)) return null;
  const checked = validateElderSafeInput({
    deviceId: value.deviceId,
    room: value.room,
    alarmId: value.alarmId,
    text: value.text,
    at: value.at,
    source: value.source
  }, value.at);
  if (!checked.ok) return null;
  return Object.freeze({ eventId: value.eventId, ...checked.value });
}

/** 内部记录 -> 公开形状（严格白名单，绝不外泄内部字段）。 */
function publicElderSafe(event) {
  const source = isPlainObject(event) ? event : {};
  return Object.freeze({
    eventId: typeof source.eventId === 'string' ? source.eventId : '',
    deviceId: typeof source.deviceId === 'string' ? source.deviceId : '',
    room: typeof source.room === 'string' ? source.room : '',
    alarmId: typeof source.alarmId === 'string' ? source.alarmId : '',
    text: typeof source.text === 'string' ? source.text : '',
    at: Number.isSafeInteger(source.at) && source.at > 0 ? source.at : 0,
    source: typeof source.source === 'string' ? source.source : ''
  });
}

module.exports = {
  ALARM_ID_RE,
  DEFAULT_SOURCE,
  DEVICE_ID_RE,
  ELDER_SAFE_CAP,
  ELDER_SAFE_FIELDS,
  ELDER_SAFE_RETENTION_MS,
  EVENT_ID_RE,
  FUTURE_SKEW_TOLERANCE_MS,
  PUBLIC_ELDER_SAFE_FIELDS,
  ROOM_MAX,
  TEXT_MAX,
  maskPhone,
  normalizeText,
  publicElderSafe,
  validateElderSafeInput,
  validateStoredElderSafeEvent
};
