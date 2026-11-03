'use strict';

const crypto = require('node:crypto');

/**
 * notify-privacy.js — 告警订阅消息链路的统一脱敏与有界文本处理
 * * 设计约束（与 `hardware/yed-m100mg-b1/lib/privacy.js` 同一套原则）：
 *   - 纯函数、无 IO、不读取 process.env、不写文件、不含任何真实账号或密钥。
 *   - 任意输入（undefined / 循环引用 / Error / 超长文本）都有界且不抛异常。
 *   - 微信相关的敏感类别：openid / unionid、AppSecret、access_token、
 *     手机号、以及模板消息体里的精确经纬度。
 *
 * 为什么单独一个模块：告警推送是**唯一**需要同时接触 openid 和 access_token 的
 * 后端链路，必须有一处集中屏蔽，避免这些值经日志、错误响应或持久化调试信息泄漏。
 * 持久化的投递台账只允许出现 deviceId / alarmId / templateId 这类非敏感标识。
 */

/** 单行文本的 UTF-8 字节上限。 */
const MAX_LINE_BYTES = 512;

/** 深度净化的最大层级与最大节点数。 */
const MAX_DEPTH = 6;
const MAX_NODES = 256;

/* ------------------------------------------------------------ 正则 */

const ANSI_CSI_RE = /(?:\u001B\[|\u009B)[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
/** openid / unionid：微信 openid 形如 28 位字母数字下划线连字符。 */
const OPENID_KEY_RE = /\b(openid|open_id|unionid|union_id)\b(\s*[:=]\s*)("?)([A-Za-z0-9_-]{6,64})\3/gi;
/** AppSecret / access_token / 各类密钥。 */
const SECRET_KEY_RE = /\b(app_?secret|appsecret|secret|access_?token|accesstoken|token|api_?key|apikey|session_?key)\b(\s*[:=]\s*)("?)([A-Za-z0-9._-]{6,512})\3/gi;
/** URL 查询串里的 secret / access_token。 */
const URL_SECRET_RE = /([?&](?:secret|access_token|appsecret|app_secret|session_key)=)([^&\s"']+)/gi;
/** 裸的中国大陆手机号。 */
const BARE_MOBILE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
/** 精确经纬度：限定小数形式，避免误伤普通计数。 */
const COORDINATE_RE = /(?<![\d.])(?:1[0-7]\d|1[0-8]?\d|\d{1,2})\.\d{4,}(?![\d])/g;

/** 已登记的已知敏感值（小写原文），按值精确屏蔽。 */
const knownSensitiveValues = new Set();

/* ------------------------------------------------------------ recipientRef */

/**
 * recipientRef 的域分离前缀。
 *
 * 为什么需要它：持久化台账里必须有一个稳定的「收件人标识」来做按人幂等，
 * 但**绝不能**保存原始 openid。openid 空间是有限的、可枚举的，因此
 * 裸 SHA-256(openid) 等于可被字典反查的匿名标识（违反"openid 空间可被关联"）。
 * 因此这里用服务端 HMAC + 显式域分离，并且用带版本的前缀把用途写进标识本身。
 */
const RECIPIENT_REF_DOMAIN = 'eldercare-notify-recipient:v1';
const RECIPIENT_REF_PREFIX = 'r1_';

/** 稳定的 HMAC 长度校验：过短的密钥无法提供有效保护。 */
const MIN_REF_SECRET_LENGTH = 32;

/**
 * 为一个 openid 生成稳定的收件人标识。
 *
 * 安全性要点：
 *   - HMAC-SHA256（带密钥），不是裸 hash：不知道密钥就无法从 openid 算出 ref，
 *     也无法从 ref 反查 openid；
 *   - 显式域分离（RECIPIENT_REF_DOMAIN），避免同一密钥在其他用途下产生可关联标识；
 *   - 输出带版本前缀 `r1_`，便于将来轮换算法；
 *   - 从不在标识里回显任何 openid 片段。
 *
 * @param {string} secret  服务端密钥（至少 32 字符），只存在于内存/Secret
 * @param {string} openid
 * @returns {string} 形如 `r1_<43 个 base64url 字符>`
 */
function recipientRefFor(secret, openid) {
  const key = typeof secret === 'string' ? secret : '';
  const value = typeof openid === 'string' ? openid.trim() : '';
  if (key.length < MIN_REF_SECRET_LENGTH) {
    throw new Error(`recipient ref secret must be at least ${MIN_REF_SECRET_LENGTH} characters`);
  }
  if (value === '' || value.length > 512) throw new Error('openid is required to derive a recipient ref');
  const digest = crypto.createHmac('sha256', key).update(`${RECIPIENT_REF_DOMAIN}\u0000${value}`, 'utf8').digest('base64url');
  return `${RECIPIENT_REF_PREFIX}${digest}`;
}

/** 校验一个 recipientRef 是否是本模块生成的形状（不校验它属于谁）。 */
function isRecipientRef(value) {
  return typeof value === 'string' && /^r1_[A-Za-z0-9_-]{32,64}$/.test(value);
}

/** 按 UTF-8 字节上限截断，且不切断多字节字符。 */
function truncateUtf8(text, maxBytes) {
  if (typeof text !== 'string' || text.length === 0) return '';
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/** 有界截断工具。 */
function boundText(value, maxBytes = MAX_LINE_BYTES) {
  try {
    if (typeof value !== 'string') return '';
    return truncateUtf8(value, maxBytes);
  } catch (_) {
    return '';
  }
}

/**
 * 规范化一行日志文本：删除 ANSI 转义与控制字符，再 trim 并按字节截断。
 * 任何输入都不抛异常。
 */
function sanitizeLine(value) {
  try {
    if (typeof value !== 'string') return '';
    const text = value.replace(ANSI_CSI_RE, '').replace(CONTROL_RE, '');
    return truncateUtf8(text.trim(), MAX_LINE_BYTES);
  } catch (_) {
    return '';
  }
}

/**
 * 登记一个真实敏感值，使后续日志即使只出现子串也会被屏蔽。
 * 只保存长度足够的原文（小写），不保存来源。长度不足 6 的输入忽略。
 */
function registerSensitiveValue(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (normalized.length < 6 || normalized.length > 512) return false;
  knownSensitiveValues.add(normalized.toLowerCase());
  return true;
}

/** 清空 shadow 登记（仅测试使用）。 */
function resetSensitiveValues() {
  knownSensitiveValues.clear();
}

/** 单个敏感值的占位符：只保留类别与长度，绝不回显原文。 */
function redactValue(kind, value) {
  try {
    const raw = value === null || value === undefined ? '' : String(value);
    if (raw.trim() === '') return `<redacted,${kind},empty>`;
    return `<redacted,${kind},length=${raw.trim().length}>`;
  } catch (_) {
    return `<redacted,${kind}>`;
  }
}

/** 已知敏感键名 -> 脱敏类别。 */
const SENSITIVE_KEY_RULES = Object.freeze([
  [/^(openid|open_id|unionid|union_id)$/i, 'openid'],
  [/^(access_?token|accesstoken|session_?key|app_?secret|appsecret|secret|token|api_?key|apikey)$/i, 'secret'],
  [/^(phone|tel|mobile|msisdn)$/i, 'phone'],
  [/^(latitude|longitude|lat|lon|lng)$/i, 'coordinate']
]);

/** 判定一个对象键是否本身代表敏感字段。 */
function sensitiveKindForKey(key) {
  const name = String(key == null ? '' : key).trim();
  if (!name) return null;
  for (const [pattern, kind] of SENSITIVE_KEY_RULES) {
    if (pattern.test(name)) return kind;
  }
  return null;
}

/** 裸长令牌（openid/access_token 等）：≥16 位字母数字下划线连字符。 */
const BARE_TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,512}(?![A-Za-z0-9_-])/g;

/** 内部日志字段名：值来自代码里的固定常量，不是用户数据。 */
const INTERNAL_LOG_KEYS = new Set(['stage', 'event', 'code', 'provider', 'reason']);

/**
 * 对「不含键名」的裸字符串做兜底脱敏。
 *
 * 与 `redactLine` 的区别：不解析 `key=value` 结构，因此不会把普通文本里的
 * 短英文单词误判成密钥；只处理裸手机号、裸长令牌与精确经纬度。
 * 用于对象值位置——那里键名已经由 `sensitiveKindForKey` 单独判定。
 *
 * `aggressive`：是否连**裸**长令牌一起屏蔽。默认开启；只有代码自有的
 * 固定常量字段（stage/event/code 等）才传 false，避免把
 * `recovery_complete` 这类标签误脱敏成 `<redacted,token>` 而失去可调试性。
 */
function redactPlainText(value, aggressive = true) {
  try {
    if (typeof value !== 'string' || value.length === 0) return '';
    let out = value;
    out = out.replace(BARE_MOBILE_RE, (match) => redactValue('phone', match));
    out = out.replace(COORDINATE_RE, (match) => redactValue('coordinate', match));
    if (aggressive) out = out.replace(BARE_TOKEN_RE, (match) => redactValue('token', match));
    if (knownSensitiveValues.size > 0) {
      for (const known of knownSensitiveValues) {
        if (!known) continue;
        const pattern = known.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(pattern, 'gi'), () => '<redacted,registered-value>');
      }
    }
    return truncateUtf8(out, MAX_LINE_BYTES);
  } catch (_) {
    return '<redacted>';
  }
}

/**
 * 单行脱敏：识别 openid/unionid、密钥、URL 查询串密钥、裸手机号、精确经纬度，
 * 以及已登记的已知敏感值。输出有界。
 */
function redactLine(line) {
  try {
    if (typeof line !== 'string' || line.length === 0) return '';
    let out = line;

    out = out.replace(OPENID_KEY_RE, (match, key, sep) => `${key}${sep}${redactValue('openid', match.slice(key.length + sep.length))}`);
    out = out.replace(SECRET_KEY_RE, (match, key, sep) => `${key}${sep}${redactValue('secret', match.slice(key.length + sep.length))}`);
    out = out.replace(URL_SECRET_RE, (match, prefix) => `${prefix}${redactValue('secret', match.slice(prefix.length))}`);
    out = out.replace(BARE_MOBILE_RE, (match) => redactValue('phone', match));
    out = out.replace(COORDINATE_RE, (match) => redactValue('coordinate', match));

    if (knownSensitiveValues.size > 0) {
      for (const known of knownSensitiveValues) {
        if (!known) continue;
        const pattern = known.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(pattern, 'gi'), () => '<redacted,registered-value>');
      }
    }

    return truncateUtf8(out, MAX_LINE_BYTES);
  } catch (_) {
    return '<redacted>';
  }
}

/**
 * 统一脱敏入口：
 *   - 字符串按行脱敏；
 *   - Error 只保留 name / code / 脱敏 message（stack 默认不输出，避免夹带请求上下文）；
 *   - 对象与数组深度净化，广度与深度都有界，循环引用安全。
 */
function deepRedact(input, options = {}) {
  const maxDepth = Number.isSafeInteger(options.maxDepth) ? options.maxDepth : MAX_DEPTH;
  const maxNodes = Number.isSafeInteger(options.maxNodes) ? options.maxNodes : MAX_NODES;
  const state = { ancestors: new Set(), nodes: 0 };

  const walk = (value, key, depth) => {
    if (state.nodes >= maxNodes) return '<redacted,truncated>';
    state.nodes += 1;

    if (value === null || value === undefined) return null;
    const type = typeof value;
    if (type === 'string') {
      // 键名本身是敏感字段时按值脱敏；否则按裸文本兜底脱敏，
      // 避免把普通字符串里的短英文单词误判成密钥。
      const kind = sensitiveKindForKey(key);
      if (kind) return redactValue(kind, value);
      return redactPlainText(value, !INTERNAL_LOG_KEYS.has(String(key || '')));
    }
    if (type === 'number' || type === 'boolean') {
      const kind = sensitiveKindForKey(key);
      // 手机号等可能以数字形式出现。
      if (kind === 'phone') return redactValue(kind, String(value));
      return value;
    }
    if (type === 'bigint') return String(value);
    if (type === 'function' || type === 'symbol') return `<redacted,${type}>`;

    if (state.ancestors.has(value)) return '<redacted,circular>';
    if (depth >= maxDepth) return '<redacted,depth-limit>';
    state.ancestors.add(value);
    try {
      if (value instanceof Error) {
        const code = typeof value.code === 'string' || typeof value.code === 'number' ? value.code : undefined;
        return {
          name: redactLine(String(value.name || 'Error')),
          ...(code === undefined ? {} : { code }),
          message: redactLine(String(value.message || ''))
        };
      }
      if (Array.isArray(value)) {
        return value.slice(0, maxNodes).map((item) => walk(item, '', depth + 1));
      }
      const output = {};
      for (const objectKey of Object.keys(value)) {
        if (state.nodes >= maxNodes) break;
        output[objectKey] = walk(value[objectKey], objectKey, depth + 1);
      }
      return output;
    } finally {
      state.ancestors.delete(value);
    }
  };

  try {
    return walk(input, '', 0);
  } catch (_) {
    return { error: '<redacted>' };
  }
}

/**
 * 生成可安全打印的一行日志。任何序列化失败都退化为固定字符串，不抛异常。
 * 输出固定带 `[notify] ` 前缀，方便在部署日志里检索。
 */
function safeLogLine(value, space = 0) {
  try {
    return `[notify] ${JSON.stringify(deepRedact(value), null, space)}`;
  } catch (_) {
    return '[notify] "<redacted,unserializable>"';
  }
}

module.exports = {
  MAX_LINE_BYTES,
  MAX_DEPTH,
  MAX_NODES,
  RECIPIENT_REF_DOMAIN,
  RECIPIENT_REF_PREFIX,
  MIN_REF_SECRET_LENGTH,
  recipientRefFor,
  isRecipientRef,
  truncateUtf8,
  boundText,
  sanitizeLine,
  redactValue,
  redactLine,
  deepRedact,
  safeLogLine,
  registerSensitiveValue,
  resetSensitiveValues
};
