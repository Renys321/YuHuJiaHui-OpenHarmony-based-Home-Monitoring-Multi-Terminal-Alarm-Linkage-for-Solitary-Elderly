'use strict';

/**
 * 健康资料的独立存储。
 *
 * 按 ownerRef 分键，单独一个 version=1 的 JSON 文件：
 * { version, savedAt, profiles: { "h1_<base64url HMAC>": {...} } }。
 * 键只能是 `h1_` 域分离的 ownerRef，不出现 openid/sub/手机号/身份证号。
 *
 * 加载时每个 profile 都过 validateStoredHealthProfile 的严格白名单校验，不合格就拒绝启动，
 * 不静默清空历史。updatedAt 只由本存储写入服务端时间。构造函数不创建文件，首次 put 才落盘；
 * 单进程模型，同一 filePath 不支持跨进程并发写。
 *
 * 不读环境变量、不访问网络、不打日志，错误码由调用方收敛成 503。
 */

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteFile } = require('./activity-store');
const {
  isHealthOwnerRef,
  orderHealthProfile,
  validateHealthProfile,
  validateStoredHealthProfile
} = require('./health-profile');

/** 健康资料文件自身的 schema 版本（与主快照 schemaVersion 完全无关）。 */
const HEALTH_FILE_VERSION = 1;
/** 文件顶层字段白名单。 */
const HEALTH_FILE_KEYS = Object.freeze(['version', 'savedAt', 'profiles']);
const HEALTH_FILE_KEY_SET = new Set(HEALTH_FILE_KEYS);
/**
 * 防御性上限：单户部署正常只有一两个 ownerRef，这里只是防止被手工塞了巨量键的文件
 * 在启动时吃满内存。超限按文件损坏处理（fail-closed），不静默截断。
 */
const HEALTH_MAX_OWNERS = 1024;
const CORRUPT_PREFIX = 'health store corrupt: ';

function fail(message) {
  const error = new Error(message);
  error.code = 'HEALTH_STORE_CORRUPT';
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

class HealthStore {
  /**
   * @param {object} options
   * @param {string}   options.filePath       状态文件路径（必填）；父目录自动创建
   * @param {Function} [options.now]          服务端时间来源；测试可注入固定值
   * @param {Function} [options.atomicWriter] 测试注入点：(filePath, text) => void
   */
  constructor(options = {}) {
    if (!isPlainObject(options)) fail('options must be a plain object');
    if (typeof options.filePath !== 'string' || options.filePath.trim() === '') {
      fail('filePath must be a non-empty string');
    }
    this.filePath = path.resolve(options.filePath);
    /** @type {Record<string, object>} ownerRef -> 已规范化资料（含 updatedAt） */
    this.profiles = Object.create(null);
    this._now = typeof options.now === 'function' ? options.now : Date.now;
    this._atomicWriter = typeof options.atomicWriter === 'function' ? options.atomicWriter : atomicWriteFile;
    this._load();
  }

  /* ---- 启动加载 ---- */

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // 首次启动：保持空状态，第一次成功保存才落盘（构造函数不创建文件）。
        return;
      }
      fail(`health store unreadable: ${error && error.code ? error.code : 'unknown error'}`);
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      fail(`${CORRUPT_PREFIX}invalid JSON`);
    }
    this._loadDocument(document);
  }

  _loadDocument(document) {
    if (!isPlainObject(document)) fail(`${CORRUPT_PREFIX}root must be an object`);
    for (const key of Object.keys(document)) {
      if (!HEALTH_FILE_KEY_SET.has(key)) fail(`${CORRUPT_PREFIX}unknown top-level field`);
    }
    if (document.version !== HEALTH_FILE_VERSION) {
      fail(`${CORRUPT_PREFIX}unsupported version`);
    }
    if (!Number.isSafeInteger(document.savedAt) || document.savedAt < 0) {
      fail(`${CORRUPT_PREFIX}savedAt must be a non-negative safe integer`);
    }
    if (!isPlainObject(document.profiles)) fail(`${CORRUPT_PREFIX}profiles must be an object`);
    const loaded = Object.create(null);
    let count = 0;
    for (const [ownerRef, storedProfile] of Object.entries(document.profiles)) {
      // 键名非法时不回显键本身，即使是 HMAC 也不把可疑输入带进启动日志。
      if (!isHealthOwnerRef(ownerRef)) fail(`${CORRUPT_PREFIX}invalid owner ref key`);
      count += 1;
      if (count > HEALTH_MAX_OWNERS) fail(`${CORRUPT_PREFIX}too many profiles`);
      const validated = validateStoredHealthProfile(storedProfile);
      if (!validated.ok) {
        fail(`${CORRUPT_PREFIX}invalid profile (${validated.fields[0] || 'unknown reason'})`);
      }
      loaded[ownerRef] = validated.value;
    }
    this.profiles = loaded;
  }

  /* ---- 快照 / 落盘 ---- */

  _document() {
    const profiles = {};
    for (const ownerRef of Object.keys(this.profiles)) profiles[ownerRef] = this.profiles[ownerRef];
    return {
      version: HEALTH_FILE_VERSION,
      savedAt: this._now(),
      profiles
    };
  }

  /** 同步原子落盘（调用方负责保证内存已更新）。 */
  _flush() {
    const text = `${JSON.stringify(this._document(), null, 2)}\n`;
    this._atomicWriter(this.filePath, text);
  }

  /* ---- 读写入口 ---- */

  /**
   * 读取某 ownerRef 的资料，返回深拷贝；无资料或键非法返回 null。
   *
   * @param {string} ownerRef `h1_` 域分离键
   * @returns {object|null}
   */
  get(ownerRef) {
    if (!isHealthOwnerRef(ownerRef)) return null;
    if (!Object.prototype.hasOwnProperty.call(this.profiles, ownerRef)) return null;
    return cloneJson(this.profiles[ownerRef]);
  }

  /**
   * 保存某 ownerRef 的资料（整份覆盖）。updatedAt 由服务端写入，入参里的同名字段直接丢弃。
   *
   * 校验失败抛 HEALTH_PROFILE_INVALID；写盘失败抛原始 fs 错误，内存已回滚。
   *
   * @param {string} ownerRef `h1_` 域分离键
   * @param {object} profile 白名单资料
   * @returns {object} 落盘后的规范化资料（含服务端 updatedAt）
   */
  put(ownerRef, profile) {
    if (!isHealthOwnerRef(ownerRef)) {
      const error = new Error('invalid health owner ref');
      error.code = 'HEALTH_PROFILE_INVALID';
      throw error;
    }
    const input = isPlainObject(profile) ? { ...profile } : profile;
    if (!isPlainObject(input)) {
      const error = new Error('health profile must be an object');
      error.code = 'HEALTH_PROFILE_INVALID';
      throw error;
    }
    // updatedAt 只能由服务端写入：无论调用方传了什么，一律丢弃后用本存储时钟。
    delete input.updatedAt;
    const validated = validateHealthProfile(input);
    if (!validated.ok) {
      const error = new Error('invalid health profile');
      error.code = 'HEALTH_PROFILE_INVALID';
      throw error;
    }
    if (
      !Object.prototype.hasOwnProperty.call(this.profiles, ownerRef) &&
      Object.keys(this.profiles).length >= HEALTH_MAX_OWNERS
    ) {
      const error = new Error('health store is full');
      error.code = 'HEALTH_STORE_FULL';
      throw error;
    }
    const stored = orderHealthProfile(validated.value);
    stored.updatedAt = this._now();

    const snapshot = { ...this.profiles };
    this.profiles[ownerRef] = stored;
    try {
      this._flush();
    } catch (error) {
      // 写盘失败：回滚内存，别留“内存成功、磁盘失败”的假状态。
      this.profiles = snapshot;
      throw error;
    }
    return cloneJson(stored);
  }

  /** 已保存资料的 ownerRef 数量（诊断/测试用；不含任何身份信息）。 */
  count() {
    return Object.keys(this.profiles).length;
  }

  /** 是否存在某 ownerRef 的资料（键非法返回 false）。 */
  has(ownerRef) {
    return isHealthOwnerRef(ownerRef) && Object.prototype.hasOwnProperty.call(this.profiles, ownerRef);
  }
}

module.exports = {
  CORRUPT_PREFIX,
  HEALTH_FILE_KEYS,
  HEALTH_FILE_VERSION,
  HEALTH_MAX_OWNERS,
  HealthStore
};
