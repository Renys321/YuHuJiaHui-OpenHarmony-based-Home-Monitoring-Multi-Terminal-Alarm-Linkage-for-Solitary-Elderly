'use strict';

/**
 * 老人自述安全事件的独立存储。
 *
 * 单独一个版本化 JSON 文件，不碰 alerts/ACK 链路。文件格式固定为
 * { version, savedAt, nextSeq, events }，events 逐条走 elder-safe 的白名单校验。
 *
 * 写入：同目录临时文件（0600）→ fsync → rename，失败回滚内存再抛错。
 * 容量按最旧优先淘汰（默认 200 条），保留期默认 7 天。
 */

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteFile } = require('./activity-store');
const {
  ELDER_SAFE_CAP,
  ELDER_SAFE_RETENTION_MS,
  EVENT_ID_RE,
  publicElderSafe,
  validateElderSafeInput,
  validateStoredElderSafeEvent
} = require('./elder-safe');

const ELDER_SAFE_FILE_VERSION = 1;
const FILE_KEYS = Object.freeze(['version', 'savedAt', 'nextSeq', 'events']);
const FILE_KEY_SET = new Set(FILE_KEYS);
const CORRUPT_PREFIX = 'elder safe store corrupt: ';
const MAX_EVENTS_LIMIT = 10000;

function fail(message) {
  const error = new Error(message);
  error.code = 'ELDER_SAFE_STORE_CORRUPT';
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class ElderSafeStore {
  /**
   * @param {object} options
   * @param {string}   options.filePath       状态文件路径（必填）；父目录自动创建
   * @param {Function} [options.now]          服务端时间来源；测试可注入固定值
   * @param {Function} [options.atomicWriter] 测试注入点：(filePath, text) => void
   * @param {number}   [options.maxEvents]    容量上限（默认 200）
   * @param {number}   [options.retentionMs]  保留期（默认 7 天）
   */
  constructor(options = {}) {
    if (!isPlainObject(options)) fail('options must be a plain object');
    if (typeof options.filePath !== 'string' || options.filePath.trim() === '') {
      fail('filePath must be a non-empty string');
    }
    this.filePath = path.resolve(options.filePath);
    this.maxEvents = Number.isSafeInteger(options.maxEvents) && options.maxEvents >= 1
      ? Math.min(options.maxEvents, MAX_EVENTS_LIMIT)
      : ELDER_SAFE_CAP;
    this.retentionMs = Number.isSafeInteger(options.retentionMs) && options.retentionMs >= 1
      ? options.retentionMs
      : ELDER_SAFE_RETENTION_MS;
    /** @type {object[]} 按写入顺序（最旧在前） */
    this.events = [];
    this.nextSeq = 1;
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
        // 首次启动：保持空状态，第一次成功记录才落盘（构造函数不创建文件）。
        return;
      }
      fail(`elder safe store unreadable: ${error && error.code ? error.code : 'unknown error'}`);
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
      if (!FILE_KEY_SET.has(key)) fail(`${CORRUPT_PREFIX}unknown top-level field`);
    }
    if (document.version !== ELDER_SAFE_FILE_VERSION) {
      fail(`${CORRUPT_PREFIX}unsupported version`);
    }
    if (!Number.isSafeInteger(document.savedAt) || document.savedAt < 0) {
      fail(`${CORRUPT_PREFIX}savedAt must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(document.nextSeq) || document.nextSeq < 1) {
      fail(`${CORRUPT_PREFIX}nextSeq must be a positive safe integer`);
    }
    if (!Array.isArray(document.events)) fail(`${CORRUPT_PREFIX}events must be an array`);

    const loaded = [];
    const seen = new Set();
    let maxSeq = 0;
    for (const stored of document.events) {
      const event = validateStoredElderSafeEvent(stored);
      if (!event) fail(`${CORRUPT_PREFIX}invalid event`);
      if (seen.has(event.eventId)) fail(`${CORRUPT_PREFIX}duplicate event id`);
      seen.add(event.eventId);
      const seq = Number.parseInt(event.eventId.slice(3), 10);
      if (!Number.isSafeInteger(seq) || !EVENT_ID_RE.test(event.eventId)) {
        fail(`${CORRUPT_PREFIX}invalid event id`);
      }
      if (seq > maxSeq) maxSeq = seq;
      loaded.push(event);
    }

    this.events = this._pruned(loaded, this._now());
    this.nextSeq = Math.max(document.nextSeq, maxSeq + 1);
  }

  /* ---- 快照 / 落盘 ---- */

  _document() {
    return {
      version: ELDER_SAFE_FILE_VERSION,
      savedAt: this._now(),
      nextSeq: this.nextSeq,
      events: this.events
    };
  }

  /** 同步原子落盘（调用方负责保证内存已更新）。 */
  _flush() {
    const text = `${JSON.stringify(this._document(), null, 2)}\n`;
    this._atomicWriter(this.filePath, text);
  }

  /**
   * 先按保留期丢弃过期事件，再按容量上限丢弃最旧事件。
   * @param {object[]} events
   * @param {number} now
   * @returns {object[]}
   */
  _pruned(events, now) {
    const cutoff = now - this.retentionMs;
    const kept = events.filter((event) => event.at >= cutoff);
    return kept.length > this.maxEvents ? kept.slice(kept.length - this.maxEvents) : kept;
  }

  /* ---- 写入入口 ---- */

  /**
   * 记录一条自述安全事件。
   *
   * @param {object} input 网关请求体（白名单字段）
   * @returns {Readonly<object>} 已落盘的公开形状事件
   * @throws {Error} 校验失败 `ELDER_SAFE_INVALID`；写盘失败抛原始 fs 错误（内存已回滚）
   */
  record(input) {
    const now = this._now();
    const validated = validateElderSafeInput(input, now);
    if (!validated.ok) {
      const error = new Error('invalid elder safe event');
      error.code = 'ELDER_SAFE_INVALID';
      throw error;
    }
    const event = Object.freeze({
      eventId: `es-${this.nextSeq}`,
      ...validated.value
    });

    const snapshotEvents = this.events;
    const snapshotSeq = this.nextSeq;
    this.events = this._pruned([...this.events, event], now);
    this.nextSeq = snapshotSeq + 1;
    try {
      this._flush();
    } catch (error) {
      // 写盘失败：回滚内存，别留“内存成功、磁盘失败”的假状态。
      this.events = snapshotEvents;
      this.nextSeq = snapshotSeq;
      throw error;
    }
    return publicElderSafe(event);
  }

  /* ---- 查询入口 ---- */

  /**
   * 最新在前返回事件（默认 20，最多 100）。
   * @param {number} [limit]
   * @returns {Readonly<object>[]}
   */
  list(limit) {
    const size = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 100) : 20;
    return this.events.slice(-size).reverse().map(publicElderSafe);
  }

  /** 当前保留的事件数（诊断/测试用）。 */
  count() {
    return this.events.length;
  }
}

module.exports = {
  CORRUPT_PREFIX,
  ELDER_SAFE_FILE_VERSION,
  FILE_KEYS,
  MAX_EVENTS_LIMIT,
  ElderSafeStore
};
