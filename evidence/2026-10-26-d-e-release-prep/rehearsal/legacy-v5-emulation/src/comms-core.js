'use strict';

const crypto = require('node:crypto');

/**
 * comms-core.js — 远程交流（第一阶段）的纯逻辑核心：状态机、输入校验、预置语音映射
 *
 * 第一阶段能力边界（必须与结论一起引用）：
 *   监护人小程序 → 后台校验并持久化 → DAYU200 领取 → 播放**预置语音** → 回报状态 → 小程序查看。
 * 本模块**不**包含、也不得被宣称包含：任意音频录制、实时通话、WebRTC、VoLTE、自动电话。
 *
 * 设计约束：
 *   - 纯函数、无 IO、不读 process.env、不写文件、不含任何真实账号或密钥；
 *   - 任何输入（undefined / 超长 / 控制字符 / 宿主字符串）都不抛异常，只返回结构化结果；
 *   - voiceId 只允许来自固定允许列表，且只映射到**固定资源文件名**；
 *   - 客户端永远不能提供 shell 命令、路径、文件名或 URL。
 */

/* ------------------------------------------------------------ 状态机 */

const MESSAGE_STATES = Object.freeze(['QUEUED', 'DELIVERED', 'PLAYED', 'ACKED', 'FAILED', 'EXPIRED']);

/** 终态：进入后不再迁移（ACKED / FAILED / EXPIRED）。 */
const TERMINAL_STATES = Object.freeze(['ACKED', 'FAILED', 'EXPIRED']);

/** 设备回报事件 -> 目标状态。设备不能直接指定目标状态，只能回报事件。 */
const EVENT_TO_STATE = Object.freeze({
  DELIVERED: 'DELIVERED',
  PLAYED: 'PLAYED',
  ACKED: 'ACKED',
  FAILED: 'FAILED',
  // Only the service may emit EXPIRED. The device HTTP route rejects it.
  EXPIRED: 'EXPIRED'
});

/**
 * 允许的迁移表。
 * 关键拒绝项：ACKED→QUEUED（回退）、FAILED→PLAYED（复活）、
 * QUEUED→PLAYED/ACKED（未领取就播放/确认）。
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
 * 按当前时间推导有效状态（只处理过期，不改终态）。
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
  // DELIVERED means the agent accepted the work, not that playback finished. Keep the
  // lease until a terminal playback result is persisted so a crash can be reclaimed.
  if (target === 'PLAYED' || target === 'ACKED' || target === 'FAILED' || target === 'EXPIRED') {
    next.leaseId = '';
    next.leaseExpiresAt = 0;
  }
  return { changed: true, rejected: false, reason: 'ok', message: next };
}

/* ------------------------------------------------------------ 常量 */

/** 幂等 ID：字符集受限，且**不允许** `..`（杜绝任何"点号组合成路径"的解读空间）。 */
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

/* ------------------------------------------------------------ 预置语音映射 */

/**
 * 预置语音允许列表 → **固定资源文件名**。
 *
 * 这是本阶段唯一允许的"播放内容"来源：客户端只能选择一个 ID，
 * 不能提供文件路径、文件名、URL 或命令。`spokenText` 只用于老人端日志/无障碍说明，
 * 绝不参与任何 shell 拼接。
 *
 * 资源文件需随 HAP 的 resources/rawfile 一起打包（当前仓库只有 sos.wav；
 * 其余文件名是**协议约定**，DAYU 侧补齐资源前不得宣称已能播放）。
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

/**
 * 解析 voiceId。只有**精确匹配**允许列表才返回固定资源，其余一律 null。
 * 这里刻意不使用任何路径拼接或大小写归一化。
 */
function resolveVoice(voiceId) {
  if (typeof voiceId !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(VOICE_MAP, voiceId)) return null;
  const entry = VOICE_MAP[voiceId];
  return Object.freeze({ voiceId, resource: entry.resource, label: entry.label });
}

/* ------------------------------------------------------------ 输入校验 */

/** 客户端**不得**提交的字段：身份、租约、令牌、位置与时间戳都由服务端决定。 */
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
 *
 * @returns {{ok: boolean, errors: object, value: object|null}}
 *   失败时绝不回显任何提交值（避免把 openid 之类反射回去）。
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

/* ------------------------------------------------------------ 标识与公开形状 */

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
 * 把会话身份（openid）派生为**不可反查**的内部引用 `ownerRef`。
 *
 * 为什么不直接存 openid：交流台账是长期持久化的，openid 属于个人数据。
 * 用服务端 HMAC + 显式域分离得到 `r1_` 前缀的稳定引用，既能做按监护人的过滤与幂等，
 * 又无法从引用反查回 openid（裸哈希不行：openid 空间可枚举）。
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
 * 校验设备回报里的 failureCode。
 * 与状态机无关：即使当前状态已经是终态，非法代码也必须先被判为无效输入（HTTP 400），
 * 而不是被当成"迁移冲突"。
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
