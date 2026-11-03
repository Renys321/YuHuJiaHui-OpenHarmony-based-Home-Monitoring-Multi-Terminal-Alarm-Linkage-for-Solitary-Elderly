'use strict';

/**
 * probe-core.js — YED-M100MG-B1 串口探测的纯函数核心
 *
 * 只做三件事：命令白名单、串口响应安全清洗/脱敏、安全摘要提取。
 * 明确不做：不读取 process.env、不做串口 IO、不写文件、不记录日志、不含账号或密钥。
 *
 * 安全边界：
 *   - 默认只查询 firmwarever / csq / ssta / paramver，不默认查询 IMEI/ICCID。
 *   - imei / iccid / imsi / 手机号等身份字段在输出中不回显原值，最多保留后 4 位。
 *   - ANSI/控制字符在进入终端前被删除；超长、多字节、畸形输入一律有界且不抛异常。
 *   - 摘要只回显设备原始返回值，不推断型号、"SIM 已注册" 或 GNSS 能力。
 *
 * 已知设备响应形态（来自同目录历史 PowerShell 探测脚本的既有约定）：
 *   `config,<key>,ok,<value>`，例如 `config,imei,ok,<示意值>`。
 *   这里刻意不写任何完整的 15 位示例号码：真实 IMEI/ICCID/IMSI 从不进入本仓库。
 */

/** 默认探测命令（顺序即查询顺序）。 */
const DEFAULT_PROBE_COMMANDS = Object.freeze([
  'config,get,firmwarever',
  'config,get,csq',
  'config,get,ssta',
  'config,get,paramver'
]);

/** 仅在显式要求时才追加的身份字段查询命令。 */
const IDENTIFIER_PROBE_COMMANDS = Object.freeze([
  'config,get,imei',
  'config,get,iccid'
]);

/** 清洗后单行的 UTF-8 字节上限。 */
const MAX_SANITIZED_BYTES = 512;

/** 摘要字段值的 UTF-8 字节上限。 */
const MAX_SUMMARY_VALUE_BYTES = 128;

/* ------------------------------------------------------------ 正则 */

// ANSI CSI（含 C1 形式 0x9B）：ESC [ ... 最终字节
const ANSI_CSI_RE = /(?:\u001B\[|\u009B)[0-9;?]*[ -\/]*[@-~]/g;
// ANSI OSC：ESC ] ... BEL 或 ST
const ANSI_OSC_RE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
// 其余单字符 ESC 序列
const ANSI_SINGLE_RE = /\u001B[@-Z\\-_]/g;
// C0 控制字符、DEL、C1 控制字符
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

const ID_KEYS = 'imei|iccid|imsi|phone|tel|msisdn|mobile';
const CONFIG_ID_RE = new RegExp(
  `(config\\s*,\\s*)(${ID_KEYS})(\\s*,\\s*)ok(\\s*,\\s*)([^,\\r\\n]*)`,
  'gi'
);
const GENERIC_ID_RE = new RegExp(
  `\\b(${ID_KEYS})\\b(\\s*[:=]\\s*|\\s+)([^\\s,;]+)`,
  'gi'
);
const BARE_PLUS_RE = /\+[\d][\d\s-]{4,18}\d/g;
const BARE_MOBILE_RE = /\b1[3-9]\d{9}\b/g;
const BARE_LONG_DIGITS_RE = /\b\d{15,20}\b/g;

/** 摘要键映射：设备字段 -> 输出字段。只认识这四个，未知一律忽略。 */
const SUMMARY_KEY_MAP = Object.freeze({
  firmwarever: 'firmware',
  csq: 'csq',
  ssta: 'registration',
  paramver: 'paramVersion'
});

/* ------------------------------------------------------------ 内部工具 */

/** 按 UTF-8 字节上限截断，且不切断多字节字符。 */
function truncateUtf8(text, maxBytes) {
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

/** 保留后 4 位数字；不足 5 位数字时整值替换为 <redacted>，绝不回显完整标识。 */
function maskIdentifier(value) {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  return digits.length > 4 ? `<redacted,last4=${digits.slice(-4)}>` : '<redacted>';
}

/* ------------------------------------------------------------ 命令白名单 */

/**
 * 构建探测命令列表。
 * 默认仅返回 firmwarever/csq/ssta/paramver；只有 `includeIdentifiers === true`
 * 才追加 imei/iccid。返回冻结数组，调用方无法修改。
 */
function buildProbeCommands(includeIdentifiers = false) {
  if (includeIdentifiers === true) {
    return Object.freeze([...DEFAULT_PROBE_COMMANDS, ...IDENTIFIER_PROBE_COMMANDS]);
  }
  return Object.freeze([...DEFAULT_PROBE_COMMANDS]);
}

/* ------------------------------------------------------------ 清洗 */

/**
 * 规范化一行串口响应：
 * - 非字符串返回空串；任意输入都不抛异常。
 * - 删除 ANSI 转义序列、CR/LF/NUL 及其他控制字符，再 trim。
 * - 结果按 UTF-8 限制在 MAX_SANITIZED_BYTES 以内。
 */
function sanitizeResponseLine(value) {
  try {
    if (typeof value !== 'string') return '';
    let text = value
      .replace(ANSI_CSI_RE, '')
      .replace(ANSI_OSC_RE, '')
      .replace(ANSI_SINGLE_RE, '')
      .replace(CONTROL_RE, '');
    text = text.trim();
    return truncateUtf8(text, MAX_SANITIZED_BYTES);
  } catch (_) {
    return '';
  }
}

/* ------------------------------------------------------------ 脱敏 */

/**
 * 对 imei/iccid/imsi/phone/tel/msisdn/mobile 等身份字段做脱敏。
 * 大小写不敏感、容忍可选空白；无法安全识别时整值替换为 <redacted>。
 * 输出绝不包含完整标识。
 */
function redactSensitiveLine(line) {
  try {
    if (typeof line !== 'string' || line.length === 0) return '';
    let out = line;

    // config,<key>,ok,<value>
    out = out.replace(CONFIG_ID_RE, (match, prefix, key, sep1, sep2, value) =>
      `${prefix}${key}${sep1}ok${sep2}${maskIdentifier(value)}`);

    // <key>: <value> / <key>=<value> / <key> <value>
    out = out.replace(GENERIC_ID_RE, (match, key, sep, value) =>
      `${key}${sep}${maskIdentifier(value)}`);

    // 裸 +E.164 号码
    out = out.replace(BARE_PLUS_RE, (match) => maskIdentifier(match));

    // 裸中国大陆手机号
    out = out.replace(BARE_MOBILE_RE, (match) => maskIdentifier(match));

    // 裸 IMEI/IMSI/ICCID 长数字串
    out = out.replace(BARE_LONG_DIGITS_RE, (match) => maskIdentifier(match));

    return out;
  } catch (_) {
    return '<redacted>';
  }
}

/* ------------------------------------------------------------ 摘要 */

/**
 * 从已清洗/脱敏的行中提取安全摘要：firmware / csq / registration / paramVersion。
 * 只认 `config,<key>,ok,<value>`（或省略 ok）形态；未知行忽略。
 * 不推断型号、SIM 注册状态或 GNSS 能力。返回冻结对象。
 */
function summarizeProbeLines(lines) {
  const summary = {};
  try {
    if (!Array.isArray(lines)) return Object.freeze(summary);
    for (const line of lines) {
      const text = sanitizeResponseLine(line);
      if (!text) continue;
      const parts = text.split(',').map((part) => part.trim());
      for (let index = 0; index < parts.length; index += 1) {
        const field = SUMMARY_KEY_MAP[parts[index].toLowerCase()];
        if (!field || summary[field] !== undefined) continue;
        let valueIndex = index + 1;
        if (parts[valueIndex] !== undefined && parts[valueIndex].toLowerCase() === 'ok') {
          valueIndex += 1;
        }
        const value = parts[valueIndex];
        if (value === undefined || value === '') continue;
        const safe = truncateUtf8(sanitizeResponseLine(value), MAX_SUMMARY_VALUE_BYTES);
        if (safe) summary[field] = safe;
      }
    }
  } catch (_) {
    // 有界：任何异常都不外抛，返回已收集到的部分摘要。
  }
  return Object.freeze(summary);
}

module.exports = {
  buildProbeCommands,
  sanitizeResponseLine,
  redactSensitiveLine,
  summarizeProbeLines,
  MAX_SANITIZED_BYTES,
  MAX_SUMMARY_VALUE_BYTES
};
