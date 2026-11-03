'use strict';

/**
 * household-auth.js — 单户版微信监护人授权模块
 *
 * 作用：把“哪些微信 openid 属于这一户的合法监护人”这一件事收敛到一个纯函数模块里。
 * 部署方通过环境变量提供允许名单（优先 JSON 字符串数组，兼容逗号分隔），
 * 进程启动时解析成不可变集合；之后每个请求只做一次 `isAllowed(openid)` 布尔判断。
 *
 * 边界与约束（与 docs/AI-COLLAB.md 的“当前家庭授权轮次”一致）：
 *   1. 纯模块：**不读取 process.env**、不写日志、不处理 token、不接触持久化文件。
 *   2. 名单只在内存里，构造后冻结；不会出现在设备快照或公开响应里（由接入方保证）。
 *   3. 解析失败一律 fail-fast，且**绝不把原始值或条目内容写进错误信息**。
 *   4. 查询 `isAllowed` 对任何输入都只返回布尔值，绝不抛异常、绝不记录输入。
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
 * 校验并规范化一组候选 openid（数组来源）。
 * - trim 每个元素；空元素、非字符串、控制字符、超长、非法字符集一律拒绝。
 * - 去重且保持首次出现顺序；返回冻结数组。
 * 错误信息只描述问题类型，不回显元素内容。
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
 * 解析部署环境字符串。
 * 首选 JSON 字符串数组（以 `[` 开头）；否则按逗号分隔作为兼容输入。
 * trim + 去重；空列表、空元素、非字符串、控制字符、超 128 字节或非法 openid 一律抛错，
 * 且错误信息不回显原始值。
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
 * 创建单户监护人授权器。
 *
 * 接受的输入形式：
 * - `string`：部署环境字符串（JSON 数组或逗号分隔）。
 * - `string[]`：已经分好组的候选列表。
 * - `{ allowedOpenIds: string | string[] }`（也接受 `allowed` 别名）。
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
    /**
     * 精确匹配查询（不做 trim/大小写转换）。
     * 对任何输入都只返回布尔值，绝不抛异常、绝不记录输入。
     */
    isAllowed(openid) {
      if (typeof openid !== 'string') return false;
      if (openid.length === 0 || openid.length > MAX_OPENID_BYTES) return false;
      return lookup.has(openid);
    },
    /**
     * 已授权的监护人 openid 列表（冻结副本）。
     *
     * 用途：告警订阅消息的收件人集合必须**只**来自这一份允许名单。
     * 调用方不得把它写进日志、响应或持久化快照——它只在内存里用于投递。
     *
     * @returns {readonly string[]}
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
