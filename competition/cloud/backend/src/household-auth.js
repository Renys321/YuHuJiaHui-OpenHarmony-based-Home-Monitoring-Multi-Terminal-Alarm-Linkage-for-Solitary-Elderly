'use strict';

/**
 * 单户微信监护人授权。
 *
 * 允许名单由部署方通过环境变量提供（优先 JSON 数组，兼容逗号分隔），启动时解析成
 * 冻结集合；之后每个请求只做一次 isAllowed(openid) 判断。解析失败直接抛错，
 * 错误信息里不带原始值或条目内容。
 */

/** 保守 openid 字符集：仅字母/数字/下划线/连字符。空白、斜杠、点号、CR/LF 一律不允许。 */
const OPENID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** C0 控制字符、DEL、C1 控制字符。 */
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;

const MAX_OPENID_BYTES = 128;

function fail(message) {
  throw new Error(message);
}

function typeFail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 校验并规范化一组候选 openid：逐个 trim、按首次出现顺序去重，返回冻结数组。
 * 空元素、非字符串、控制字符、超长和非法字符集都拒绝，错误信息不回显内容。
 */
function collectOpenIds(entries) {
  if (!Array.isArray(entries)) typeFail('allowed openids must be an array');
  if (entries.length === 0) fail('allowed openids must not be empty');

  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string') typeFail('allowed openids must contain only strings');
    // 先拒绝控制字符再 trim：避免把 CR/LF 之类“洗掉”后当成合法值。
    if (CONTROL_RE.test(entry)) fail('allowed openids must not contain control characters');
    const openid = entry.trim();
    if (openid.length === 0) fail('allowed openids must not contain empty entries');
    if (openid.length > MAX_OPENID_BYTES || Buffer.byteLength(openid, 'utf8') > MAX_OPENID_BYTES) {
      fail('allowed openids entry exceeds 128 bytes');
    }
    if (!OPENID_RE.test(openid)) fail('allowed openids entry is not a valid openid');
    seen.add(openid);
  }
  if (seen.size === 0) fail('allowed openids must not be empty');
  return Object.freeze([...seen]);
}

/**
 * 解析部署环境字符串：以 `[` 开头按 JSON 数组处理，否则按逗号分隔。
 *
 * @param {string} value
 * @returns {readonly string[]} 冻结的去重 openid 列表
 */
function parseAllowedOpenIds(value) {
  if (typeof value !== 'string') typeFail('allowed openids must be a string');

  const raw = value.trim();
  if (raw.length === 0) fail('allowed openids must not be empty');

  if (raw.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      fail('allowed openids JSON is invalid');
    }
    if (!Array.isArray(parsed)) fail('allowed openids JSON must be an array');
    return collectOpenIds(parsed);
  }

  return collectOpenIds(raw.split(','));
}

/**
 * 接受环境字符串、已分组的 `string[]`，或 `{ allowedOpenIds }`（也认 `allowed` 别名）。
 *
 * @returns {Readonly<{ size: number, isAllowed(openid: unknown): boolean }>}
 */
function createHouseholdAuthorizer(input) {
  let allowed;
  if (typeof input === 'string') {
    allowed = parseAllowedOpenIds(input);
  } else if (Array.isArray(input)) {
    allowed = collectOpenIds(input);
  } else if (isPlainObject(input)) {
    const candidate = input.allowedOpenIds !== undefined ? input.allowedOpenIds : input.allowed;
    if (candidate === undefined) fail('allowed openids must be provided');
    allowed = typeof candidate === 'string' ? parseAllowedOpenIds(candidate) : collectOpenIds(candidate);
  } else {
    typeFail('allowed openids must be provided as a string, array or object');
  }

  const lookup = new Set(allowed);
  const size = allowed.length;

  const authorizer = {
    size,
    /** 精确匹配，不做 trim 或大小写转换；任何输入只返回布尔值。 */
    isAllowed(openid) {
      if (typeof openid !== 'string') return false;
      if (openid.length === 0 || openid.length > MAX_OPENID_BYTES) return false;
      return lookup.has(openid);
    },
    /**
     * 已授权 openid 的冻结副本。告警订阅的收件人只能取自这里，
     * 调用方不得写进日志、响应或持久化快照。
     */
    listAllowed() {
      return Object.freeze([...allowed]);
    }
  };

  return Object.freeze(authorizer);
}

module.exports = {
  createHouseholdAuthorizer,
  parseAllowedOpenIds
};
