'use strict';

const crypto = require('node:crypto');

/**
 * 远程交流第一阶段的纯逻辑核心：状态机、输入校验、预置语音映射。
 *
 * 链路：小程序 → 后台校验并持久化 → DAYU200 领取 → 播放预置语音 → 回报状态 → 小程序查看。
 * 不包含任意音频录制、实时通话、WebRTC、VoLTE、自动电话。
 *
 * 纯函数，无 IO；任何输入都不抛异常，只返回结构化结果。voiceId 只能取自允许列表
 * 并映射到固定资源文件名，客户端给不了命令、路径、文件名或 URL。
 */

/* ---- 状态机 ---- */

const MESSAGE_STATES = Object.freeze(['QUEUED', 'DELIVERED', 'PLAYED', 'ACKED', 'FAILED', 'EXPIRED']);

/** 终态：进入后不再迁移（ACKED / FAILED / EXPIRED）。 */
const TERMINAL_STATES = Object.freeze(['ACKED', 'FAILED', 'EXPIRED']);

/** 设备回报事件 -> 目标状态。设备不能直接指定目标状态，只能回报事件。 */
const EVENT_TO_STATE = Object.freeze({
  DELIVERED: 'DELIVERED',
  PLAYED: 'PLAYED',
  ACKED: 'ACKED',
  FAILED: 'FAILED',
  // 只有服务端能置 EXPIRED，设备 HTTP 路由会拒绝。
  EXPIRED: 'EXPIRED'
});

/**
 * 允许的迁移表。拒绝 ACKED→QUEUED（回退）、FAILED→PLAYED（复活）、
 * QUEUED→PLAYED/ACKED（未领取就播放或确认）。
 */
const TRANSITIONS = Object.freeze({
  QUEUED: Object.freeze(['DELIVERED', 'FAILED', 'EXPIRED']),
  DELIVERED: Object.freeze(['PLAYED', 'FAILED', 'EXPIRED']),
  PLAYED: Object.freeze(['ACKED', 'FAILED']),
  ACKED: Object.freeze([]),
  FAILED: Object.freeze([]),
  EXPIRED: Object.freeze([])
});

/** 每个目标状态对应的时间戳字段。 */
const STATE_TIMESTAMP_FIELD = Object.freeze({
  DELIVERED: 'deliveredAt',
  PLAYED: 'playedAt',
  ACKED: 'acknowledgedAt',
  FAILED: 'failedAt',
  EXPIRED: 'expiredAt'
});

function isState(value) {
  return typeof value === 'string' && MESSAGE_STATES.includes(value);
}

/**
 * 能否从 `from` 迁移到 `to`。
 * 同状态不算迁移（返回 false，由调用方按幂等处理）；未知状态一律 false。
 */
function canTransition(from, to) {
  if (!isState(from) || !isState(to)) return false;
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

/**
 * 按当前时间推导有效状态，只处理过期，不改终态。
 */
function deriveStatus(message, nowMs) {
  const current = message && typeof message.status === 'string' ? message.status : '';
  if (!isState(current)) return 'QUEUED';
  if (TERMINAL_STATES.includes(current)) return current;
  const expiresAt = Number.isSafeInteger(message.expiresAt) ? message.expiresAt : 0;
  if (expiresAt > 0 && Number.isFinite(nowMs) && nowMs >= expiresAt) return 'EXPIRED';
  return current;
}

/**
 * 应用一个设备事件。
 *
 * @returns {{changed: boolean, rejected: boolean, reason: string, message: object}}
 *   - changed=true：合法迁移已完成，`message` 是新对象；
 *   - changed=false & rejected=false：重复回报同一状态，幂等；
 *   - changed=false & rejected=true：非法迁移（回退/跳级/终态后继续），`message` 原样返回。
 */
function applyEvent(message, event, nowMs, options = {}) {
  const base = message && typeof message === 'object' ? { ...message } : {};
  const target = EVENT_TO_STATE[event];
  if (!target) {
    return { changed: false, rejected: true, reason: 'unknown_event', message: base };
  }
  const current = isState(base.status) ? base.status : 'QUEUED';
  const at = Number.isSafeInteger(nowMs) ? nowMs : 0;

  // 同状态重复回报：幂等（例如重复 PLAYED / 重复 ACKED）。
  if (current === target) {
    return { changed: false, rejected: false, reason: 'already_in_state', message: base };
  }
  if (!canTransition(current, target)) {
    return { changed: false, rejected: true, reason: `illegal_transition:${current}->${target}`, message: base };
  }

  const next = { ...base, status: target, updatedAt: at };
  const stamp = STATE_TIMESTAMP_FIELD[target];
  if (stamp) next[stamp] = at;

  if (target === 'FAILED') {
    const code = options.failureCode === undefined || options.failureCode === null || options.failureCode === ''
      ? ''
      : String(options.failureCode);
    if (code !== '' && !/^[A-Z][A-Z0-9_]{2,39}$/.test(code)) {
      return { changed: false, rejected: true, reason: 'invalid_failure_code', message: base };
    }
    next.failureCode = code;
  } else if (target === 'DELIVERED') {
    next.failureCode = '';
  }
  // DELIVERED 只代表设备收下了任务，不代表播放完成。租约要留到终态播放结果落盘，
  // 这样进程崩了还能被重新领取。
  if (target === 'PLAYED' || target === 'ACKED' || target === 'FAILED' || target === 'EXPIRED') {
    next.leaseId = '';
    next.leaseExpiresAt = 0;
  }
  return { changed: true, rejected: false, reason: 'ok', message: next };
}

/* ---- 常量 ---- */

/** 幂等 ID：字符集受限，且不允许 `..`。 */
function isValidClientMessageId(value) {
  return typeof value === 'string' && CLIENT_MESSAGE_ID_RE.test(value) && !value.includes('..');
}

const MESSAGE_TEXT_MAX = 120;
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MESSAGE_ID_RE = /^cmsg-[A-Za-z0-9._-]{6,58}$/;
const FAILURE_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;

/** 设备租约：领取后多久未回报即可被其他轮询重新领取。 */
const LEASE_MS = 60 * 1000;
/** 消息生存期：超时后推导为 EXPIRED，不再投递。 */
const MESSAGE_TTL_MS = 30 * 60 * 1000;
/** 交流消息容量上限（有界，按 updatedAt 淘汰最旧）。 */
const DEFAULT_MESSAGE_CAP = 300;

/* ---- 预置语音映射 ---- */

/**
 * 预置语音允许列表 → 固定资源文件名。
 *
 * 客户端只能选一个 ID，给不了路径、文件名、URL 或命令；spokenText 只用于老人端
 * 日志和无障碍播报，不参与任何 shell 拼接。资源随 HAP 的 resources/rawfile 打包，
 * 目前仓库只有 sos.wav，其余文件名是协议约定。
 */
const VOICE_MAP = Object.freeze({
  CHECK_IN: Object.freeze({
    label: '日常问候',
    resource: 'check_in.wav',
    spokenText: '家里在问候您，请回应一下'
  }),
  PLEASE_RESPOND: Object.freeze({
    label: '请回应',
    resource: 'please_respond.wav',
    spokenText: '请按一下按钮回应家人'
  }),
  MEDICINE_REMINDER: Object.freeze({
    label: '用药提醒',
    resource: 'medicine_reminder.wav',
    spokenText: '该吃药了，请按时服药'
  }),
  FAMILY_MESSAGE: Object.freeze({
    label: '家人留言',
    resource: 'family_message.wav',
    spokenText: '家人给您留了一句话'
  }),
  EMERGENCY_CONTACTING: Object.freeze({
    label: '正在联系家人',
    resource: 'emergency_contacting.wav',
    spokenText: '正在联系家人，请稍等'
  })
});

const VOICE_IDS = Object.freeze(Object.keys(VOICE_MAP));

/** 只精确匹配允许列表，其余一律 null；不做路径拼接，也不归一化大小写。 */
function resolveVoice(voiceId) {
  if (typeof voiceId !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(VOICE_MAP, voiceId)) return null;
  const entry = VOICE_MAP[voiceId];
  return Object.freeze({ voiceId, resource: entry.resource, label: entry.label });
}

/* ---- 输入校验 ---- */

/** 客户端不得提交的字段：身份、租约、令牌、位置、时间戳都由服务端决定。 */
const FORBIDDEN_INPUT_FIELDS = Object.freeze([
  'openid', 'openId', 'unionid', 'unionId', 'recipientRef', 'owner', 'ownerRef', 'household', 'householdId',
  'token', 'accessToken', 'access_token', 'sessionToken', 'secret',
  'phone', 'mobile', 'tel', 'imsi', 'imei', 'iccid',
  'latitude', 'longitude', 'lat', 'lon', 'lng', 'coords',
  'status', 'messageId', 'leaseId', 'leaseExpiresAt', 'createdAt', 'updatedAt',
  'deliveredAt', 'playedAt', 'acknowledgedAt', 'failureCode', 'attempts'
]);

/** 显示文本里禁止出现的内容：URL、路径、shell 元字符、身份/密钥样式片段。 */
const TEXT_DENY_RULES = Object.freeze([
  Object.freeze({ name: 'url', re: /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)/i }),
  Object.freeze({ name: 'path', re: /(?:\.\.[\\/]|[\\/])/ }),
  Object.freeze({ name: 'windows_path', re: /[A-Za-z]:\\/ }),
  Object.freeze({ name: 'shell', re: /[;&|`$<>*?{}[\]()!#~^]/ }),
  Object.freeze({ name: 'quote', re: /["']/ }),
  Object.freeze({ name: 'secret_keyword', re: /\b(?:openid|unionid|token|secret|appsecret|access_?token|imei|iccid|imsi|password)\b/i }),
  Object.freeze({ name: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ }),
  Object.freeze({ name: 'coordinate', re: /\d{1,3}\.\d{4,}\s*,\s*\d{1,3}\.\d{4,}/ }),
  Object.freeze({ name: 'control', re: /[\u0000-\u001F\u007F-\u009F]/ }),
  Object.freeze({ name: 'backslash', re: /\\/ })
]);

/**
 * 校验并规范化一条监护人提交的交流消息。
 * 失败时不回显任何提交值，免得把 openid 之类反射回去。
 *
 * @returns {{ok: boolean, errors: object, value: object|null}}
 */
function validateComposeInput(input) {
  const errors = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { body: '请求体必须是对象' }, value: null };
  }

  for (const field of FORBIDDEN_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined) {
      errors[field] = '该字段不允许由客户端提交';
    }
  }

  const clientMessageId = typeof input.clientMessageId === 'string' ? input.clientMessageId.trim() : '';
  if (!isValidClientMessageId(clientMessageId)) {
    errors.clientMessageId = '幂等 ID 必须是 8-64 位字母、数字、点、下划线或连字符，且不能包含 ..';
  }

  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : '';
  if (!DEVICE_ID_RE.test(deviceId)) {
    errors.deviceId = '设备 ID 格式无效';
  }

  let text = '';
  if (typeof input.text !== 'string') {
    errors.text = '留言内容必须是字符串';
  } else {
    text = input.text.trim();
    if (text.length === 0) errors.text = '留言内容不能为空';
    else if (text.length > MESSAGE_TEXT_MAX) errors.text = `留言内容不能超过 ${MESSAGE_TEXT_MAX} 个字符`;
  }
  if (!errors.text) {
    for (const rule of TEXT_DENY_RULES) {
      if (rule.re.test(text)) {
        errors.text = '留言内容包含不允许的内容（链接、路径、命令字符或敏感标识）';
        break;
      }
    }
  }

  if (resolveVoice(input.voiceId) === null) {
    errors.voiceId = '必须是服务端允许的预置语音 ID';
  }

  if (typeof input.requestAck !== 'boolean') {
    errors.requestAck = 'requestAck 必须是布尔值';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: {},
    value: Object.freeze({
      clientMessageId,
      deviceId,
      text,
      voiceId: input.voiceId,
      requestAck: input.requestAck
    })
  };
}

/* ---- 标识与公开形状 ---- */

let idCounter = 0;

/**
 * 生成一个消息 ID：`cmsg-<base36 时间>-<序号>-<随机>`，字符集满足 MESSAGE_ID_RE。
 * 只用于内部标识，不携带任何个人信息。
 */
function createMessageId(nowMs = Date.now()) {
  const stamp = Math.max(0, Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now()).toString(36);
  idCounter = (idCounter + 1) % 0xffffff;
  const seq = idCounter.toString(36).padStart(4, '0');
  const random = Math.floor(Math.random() * 0xffffff).toString(36).padStart(4, '0');
  return `cmsg-${stamp}-${seq}${random}`;
}

/** 公开给小程序/设备的消息形状白名单：内部字段（ownerRef/租约/openid）一律不外泄。 */
const PUBLIC_MESSAGE_FIELDS = Object.freeze([
  'messageId', 'deviceId', 'text', 'voiceId', 'requestAck', 'status',
  'createdAt', 'updatedAt', 'deliveredAt', 'playedAt', 'acknowledgedAt',
  'expiresAt', 'failureCode'
]);

/**
 * 把存储记录投影成公开形状。未知字段被丢弃，因此 openid/ownerRef/leaseId 不会外泄。
 */
function publicMessage(message) {
  const source = message && typeof message === 'object' ? message : {};
  const out = {};
  for (const field of PUBLIC_MESSAGE_FIELDS) {
    const value = source[field];
    if (field === 'requestAck') out[field] = value === true;
    else if (typeof value === 'string') out[field] = value;
    else if (Number.isSafeInteger(value)) out[field] = value;
    else out[field] = field === 'text' || field === 'failureCode' || field === 'voiceId' || field === 'deviceId' || field === 'messageId' || field === 'status' ? '' : 0;
  }
  return Object.freeze(out);
}

/**
 * 把 openid 派生为不可反查的 ownerRef：r1_ + HMAC-SHA256(密钥, 域串 + openid)。
 *
 * 不存裸 openid 是因为台账长期持久化；也不能用裸哈希，openid 空间可枚举。
 * 域分离保证同一密钥在别的用途下算不出同样的值。
 *
 * @param {string} secret 服务端密钥（≥32 字符），只存在于内存/Secret
 * @param {string} openid
 */
function ownerRefFor(secret, openid) {
  const key = typeof secret === 'string' ? secret : '';
  const value = typeof openid === 'string' ? openid.trim() : '';
  if (key.length < 32) throw new Error('owner ref secret must be at least 32 characters');
  if (value === '' || value.length > 512) throw new Error('openid is required to derive an owner ref');
  const digest = crypto.createHmac('sha256', key).update(`eldercare-comms-owner:v1\u0000${value}`, 'utf8').digest('base64url');
  return `r1_${digest}`;
}

/** 校验一个 ownerRef 是否为本模块生成的形状。 */
function isOwnerRef(value) {
  return typeof value === 'string' && /^r1_[A-Za-z0-9_-]{32,64}$/.test(value);
}

/**
 * 设备回报里的 failureCode。即使当前已是终态，非法代码也要先按无效输入处理（HTTP 400），
 * 不能当成迁移冲突。
 */
function isValidFailureCode(value) {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'string' && FAILURE_CODE_RE.test(value);
}

module.exports = {
  MESSAGE_STATES,
  TERMINAL_STATES,
  EVENT_TO_STATE,
  TRANSITIONS,
  STATE_TIMESTAMP_FIELD,
  MESSAGE_TEXT_MAX,
  CLIENT_MESSAGE_ID_RE,
  DEVICE_ID_RE,
  MESSAGE_ID_RE,
  FAILURE_CODE_RE,
  LEASE_MS,
  MESSAGE_TTL_MS,
  DEFAULT_MESSAGE_CAP,
  VOICE_MAP,
  VOICE_IDS,
  FORBIDDEN_INPUT_FIELDS,
  TEXT_DENY_RULES,
  PUBLIC_MESSAGE_FIELDS,
  isState,
  canTransition,
  deriveStatus,
  applyEvent,
  resolveVoice,
  validateComposeInput,
  isValidClientMessageId,
  createMessageId,
  publicMessage,
  ownerRefFor,
  isOwnerRef,
  isValidFailureCode
};
