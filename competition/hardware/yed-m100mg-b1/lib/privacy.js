'use strict';

/**
 * lib/privacy.js — YED-M100MG-B1 接入层统一脱敏与有界文本处理
 *
 * 单一事实来源：所有日志、JSON 输出、错误对象和调试字段都必须经过本模块。
 * 设计约束：
 *   - 纯函数、无 IO、不读取 process.env、不写文件、不含任何真实账号或密钥。
 *   - 任意输入（undefined / 循环引用 / Error / 孤立代理项 / 超长文本）都有界且不抛异常。
 *   - 默认只保留“是否存在、长度类别、后 4 位”这类结论，绝不回显完整标识。
 *   - 已知真实标识值（例如运行时读到的 IMEI）可登记为 shadow，后续按值精确屏蔽，
 *     避免短值被长度阈值漏掉。
 *
 * 覆盖的敏感类别：ICCID、IMSI、IMEI、MEID、手机号 / MSISDN、E.164、
 * 设备密钥（token/secret/password/apikey/AppSecret/psk）。
 */

/** 清洗后单行的 UTF-8 字节上限（与 probe-core.js 保持一致）。 */
const MAX_SANITIZED_BYTES = 512;

/** 单个脱敏值 / 调试字段的 UTF-8 字节上限。 */
const MAX_VALUE_BYTES = 256;

/** 通用键值字符串值的 UTF-8 字节上限。 */
const MAX_STRING_BYTES = 1024;

/** 深度净化时的最大层级与最大节点数，防止超深/超宽对象失控。 */
const MAX_DEPTH = 8;
const MAX_NODES = 512;

/* ------------------------------------------------------------ 正则 */

// ANSI CSI（含 C1 形式 0x9B）：ESC [ ... 最终字节
const ANSI_CSI_RE = /(?:\u001B\[|\u009B)[0-9;?]*[ -\/]*[@-~]/g;
// ANSI OSC：ESC ] ... BEL 或 ST
const ANSI_OSC_RE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
// 其余单字符 ESC 序列
const ANSI_SINGLE_RE = /\u001B[@-Z\\-_]/g;
// C0 控制字符、DEL、C1 控制字符
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/** 身份字段键名（大小写不敏感）。 */
const ID_KEYS = 'imei|iccid|imsi|meid|phone|tel|msisdn|mobile|simnumber';
/** 密钥字段键名（大小写不敏感）。 */
const SECRET_KEYS = 'token|secret|password|passwd|pwd|apikey|api_key|appsecret|accesskey|psk|privatekey';

const ID_KEY_SOURCE = `(?:${ID_KEYS})`;
const SECRET_KEY_SOURCE = `(?:${SECRET_KEYS})`;

// 值匹配：引号字符串、方括号占位、或到分隔符为止的非空串
const VALUE_SOURCE = `(?:\\[[^\\]]*\\]|"[^"]*"|'[^']*'|[^\\s,;|&]+|(?=[\\s,;|&]|$))`;

// config,<idkey>,ok,<value> （YED DTU 形式）
const CONFIG_ID_RE = new RegExp(
  `(config\\s*,\\s*)(${ID_KEY_SOURCE})(\\s*,\\s*)(ok|err|error|fail)?(\\s*,\\s*)([^,\\r\\n]*)`,
  'gi'
);
// <idkey> <sep> <value>
const KEYED_ID_RE = new RegExp(`\\b(${ID_KEY_SOURCE})\\b(\\s*[:=]\\s*|\\s+)${VALUE_SOURCE}`, 'gi');
// <secretkey> <sep> <value>
const KEYED_SECRET_RE = new RegExp(`\\b(${SECRET_KEY_SOURCE})\\b(\\s*[:=]\\s*|\\s+)${VALUE_SOURCE}`, 'gi');
// 裸 E.164（+ 开头，7-15 位）
const BARE_PLUS_RE = /\+\d[\d\s-]{5,17}\d/g;
// 裸中国大陆手机号
const BARE_MOBILE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
// 裸长数字标识（IMEI 15 位、ICCID 19-20 位、IMSI 14-15 位、MEID 等）
const BARE_LONG_DIGITS_RE = /(?<!\d)\d{14,20}(?!\d)/g;

/* ------------------------------------------------------------ 标签 */

function labelForKey(key) {
  const lowered = String(key).toLowerCase().replace(/[^a-z_]/g, '');
  if (lowered === 'iccid') return 'iccid';
  if (lowered === 'imsi') return 'imsi';
  if (lowered === 'imei') return 'imei';
  if (lowered === 'meid') return 'meid';
  if (
    lowered.includes('secret') ||
    lowered.includes('token') ||
    lowered.includes('password') ||
    lowered.includes('passwd') ||
    lowered.includes('apikey') ||
    lowered.includes('api_key') ||
    lowered.includes('accesskey') ||
    lowered.includes('access_key') ||
    lowered.includes('privatekey') ||
    lowered.includes('private_key') ||
    lowered === 'pwd' ||
    lowered === 'psk'
  ) {
    return 'secret';
  }
  if (
    lowered === 'phone' ||
    lowered === 'tel' ||
    lowered === 'msisdn' ||
    lowered === 'mobile' ||
    lowered === 'simnumber' ||
    lowered === 'sim_number'
  ) {
    return 'phone';
  }
  return 'value';
}

function isSecretKey(key) {
  return labelForKey(key) === 'secret';
}

/* ------------------------------------------------------------ 有界文本 */

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

/**
 * 规范化一行串口 / 日志文本：
 * - 非字符串返回空串；任意输入都不抛异常。
 * - 删除 ANSI 转义序列、CR/LF/NUL 及其他控制字符，再 trim。
 * - 结果按 UTF-8 限制在 MAX_SANITIZED_BYTES 以内。
 */
function sanitizeLine(value) {
  try {
    if (typeof value !== 'string') return '';
    const text = value
      .replace(ANSI_CSI_RE, '')
      .replace(ANSI_OSC_RE, '')
      .replace(ANSI_SINGLE_RE, '')
      .replace(CONTROL_RE, '');
    return truncateUtf8(text.trim(), MAX_SANITIZED_BYTES);
  } catch (_) {
    return '';
  }
}

/* ------------------------------------------------------------ shadow 登记 */

/** 已登记的已知敏感值（小写原文），按值精确屏蔽。 */
const knownSensitiveValues = new Set();

/**
 * 登记一个真实敏感值，使后续日志即使只出现短子串也被屏蔽。
 * 只保存值和长度类别，不保存来源；长度不足 4 的输入忽略。
 */
function registerSensitiveValue(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 4 || normalized.length > 64) return false;
  knownSensitiveValues.add(normalized);
  return true;
}

/** 清空 shadow 登记（测试隔离用；生产代码不应调用）。 */
function resetSensitiveValues() {
  knownSensitiveValues.clear();
}

/* ------------------------------------------------------------ 单值脱敏 */

/**
 * 屏蔽单个敏感值：只保留类别、长度类别与后 4 位。
 * 空值返回 <redacted,empty>；无法安全取值时返回 <redacted>。
 */
function redactValue(key, value) {
  const label = labelForKey(key);
  try {
    if (value === null || value === undefined) return `<redacted,${label},empty>`;
    const raw = typeof value === 'string' ? value : String(value);
    const trimmed = raw.trim();
    if (trimmed === '') return `<redacted,${label},empty>`;
    if (isSecretKey(key)) return `<redacted,secret,length=${trimmed.length}>`;

    const digits = trimmed.replace(/\D/g, '');
    if (digits.length < 4) return `<redacted,${label}>`;
    return `<redacted,${label},length=${digits.length},last4=${digits.slice(-4)}>`;
  } catch (_) {
    return `<redacted,${label}>`;
  }
}

/** 单行文本脱敏：识别身份字段、密钥字段、裸号码与裸长数字串。 */
function redactLine(line) {
  try {
    if (typeof line !== 'string' || line.length === 0) return '';
    let out = line;

    // config,<idkey>,ok,<value>
    out = out.replace(CONFIG_ID_RE, (match, prefix, key, sep1, status, sep2, value) =>
      `${prefix}${key}${sep1}${status === undefined ? '' : status}${sep2}${redactValue(key, value)}`);

    // <secretkey>: <value> （先做密钥，避免被通用 id 规则误判）
    out = out.replace(KEYED_SECRET_RE, (match, key, sep) =>
      `${key}${sep}<redacted,secret,length=${match.slice(key.length + sep.length).trim().length}>`);

    // <idkey>: <value>
    out = out.replace(KEYED_ID_RE, (match, key, sep, value) =>
      `${key}${sep}${redactValue(key, value)}`);

    // 裸 E.164 号码
    out = out.replace(BARE_PLUS_RE, (match) => redactValue('phone', match));

    // 裸中国大陆手机号
    out = out.replace(BARE_MOBILE_RE, (match) => redactValue('phone', match));

    // 已登记的真实值（兜底，容忍中间空格/连字符），只替换命中片段，保留其余上下文
    if (knownSensitiveValues.size > 0) {
      for (const known of knownSensitiveValues) {
        const pattern = known.split('').join('[\\s-]?');
        out = out.replace(new RegExp(pattern, 'gi'), () => '<redacted,registered-value>');
      }
    }

    // 裸长数字标识放在最后，避免把已脱敏占位内的数字再次处理
    out = out.replace(BARE_LONG_DIGITS_RE, (match) => redactValue('id', match));

    return truncateUtf8(out, MAX_VALUE_BYTES);
  } catch (_) {
    return '<redacted>';
  }
}

/**
 * 统一脱敏入口：
 * - 字符串按行脱敏；
 * - Error 只保留 name / code / 脱敏 message / 脱敏 stack；
 * - 对象与数组深度净化（密钥键整体替换，身份键脱敏，未知键递归）。
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
      return isSecretKey(key) ? redactValue(key, value) : redactLine(value);
    }
    if (type === 'number' || type === 'boolean') {
      return isSecretKey(key) ? redactValue(key, value) : value;
    }
    if (type === 'bigint') return String(value);
    if (type === 'function' || type === 'symbol') return `<redacted,${type}>`;

    // 只把“祖先链上的重复引用”判定为循环。全局 seen 会把同一次输出里
    // 被多处共享的同一对象误标成 circular，深度脱敏因此不是幂等的。
    if (state.ancestors.has(value)) return '<redacted,circular>';
    if (depth >= maxDepth) return '<redacted,depth-limit>';
    state.ancestors.add(value);

    try {
      if (value instanceof Error) {
        const code = typeof value.code === 'string' || typeof value.code === 'number' ? value.code : undefined;
        return {
          name: redactLine(String(value.name || 'Error')),
          ...(code === undefined ? {} : { code }),
          message: redactLine(String(value.message || '')),
          stack: redactLine(String(value.stack || ''))
        };
      }
      if (Array.isArray(value)) {
        return value.slice(0, maxNodes).map((item) => walk(item, key, depth + 1));
      }
      if (value instanceof Map) {
        const result = [];
        for (const [mapKey, mapValue] of value) {
          if (result.length >= maxNodes) break;
          result.push([walk(mapKey, 'key', depth + 1), walk(mapValue, String(mapKey), depth + 1)]);
        }
        return result;
      }
      if (value instanceof Set) {
        const result = [];
        for (const item of value) {
          if (result.length >= maxNodes) break;
          result.push(walk(item, key, depth + 1));
        }
        return result;
      }

      const output = {};
      for (const objectKey of Object.keys(value)) {
        if (state.nodes >= maxNodes) break;
        if (isSecretKey(objectKey)) {
          output[objectKey] = '<redacted,secret>';
          state.nodes += 1;
          continue;
        }
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
 * 生成可安全打印的 JSON。任何序列化失败都退化为固定字符串，不抛异常。
 */
function safeJsonStringify(value, space = 0) {
  try {
    return JSON.stringify(deepRedact(value), null, space);
  } catch (_) {
    return '"<redacted,unserializable>"';
  }
}

/** 有界截断工具（供其他模块统一使用）。 */
function boundText(value, maxBytes = MAX_STRING_BYTES) {
  try {
    if (typeof value !== 'string') return '';
    return truncateUtf8(value, maxBytes);
  } catch (_) {
    return '';
  }
}

module.exports = {
  MAX_SANITIZED_BYTES,
  MAX_VALUE_BYTES,
  MAX_STRING_BYTES,
  MAX_DEPTH,
  MAX_NODES,
  truncateUtf8,
  sanitizeLine,
  redactValue,
  redactLine,
  deepRedact,
  safeJsonStringify,
  boundText,
  registerSensitiveValue,
  resetSensitiveValues
};
