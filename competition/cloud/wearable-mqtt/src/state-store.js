'use strict';

/**
 * state-store.js — DATA_DIR 内的持久化小状态（原子写、严格加载）。
 *
 * 持久化字段：
 *   - seq          : 已接受 GPS 固定格式定位帧的单调计数（诊断/取证用；跨重启只增不减）；
 *   - commandCursor: 已处理到的后端命令 id（`GET /internal/v1/commands?after=N` 续读）；
 *   - sosCount     : 当日 SOS 计数（仅用于 device-status.alarm.countToday 展示）；
 *   - sosDate      : 当日日期（本地时区 YYYY-MM-DD）；
 *   - device       : 适配器“最后已知设备状态”（state/alarmId/csq/lastSeen/lastBusinessUplinkAt/online，
 *                    **不含任何坐标**）。只用于进程重启后仍能如实纠正后端在线状态；
 *                    这是可丢弃的观测缓存：非法时只告警忽略，绝不因此拒绝启动。
 *
 * 为什么同步写：状态很小（<1KB），每次变更必须落盘后才能继续，
 * 避免进程崩溃/重启后计数回退或命令游标回退导致重复/漏处理。
 *
 * 损坏处理：文件存在但 JSON/schema 非法 => 抛错拒绝启动（fail-closed），
 * 绝不静默把 seq 重置为 0（会破坏单调性）。唯一例外是可选字段 `device`
 * （纯诊断缓存），非法时忽略并告警。
 */

const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;
const STATE_FILE_NAME = 'wearable-mqtt-state.json';
const MAX_SAFE_COUNTER = 9007199254740991;
/** 后端 normalizeStatus 允许的设备状态（store.js STATES）。 */
const DEVICE_STATES = new Set(['NORMAL', 'WARN', 'ALARM', 'ACKED']);
const ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

function isSafeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_COUNTER;
}

/**
 * 校验并归一化“最后已知设备状态”缓存；非法返回 null（调用方忽略该缓存）。
 * 绝不包含坐标/密钥等敏感字段。
 */
function normalizeDeviceSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = typeof value.state === 'string' ? value.state : '';
  if (!DEVICE_STATES.has(state)) return null;
  const alarmId = typeof value.alarmId === 'string' ? value.alarmId : '';
  if (alarmId !== '' && !ALARM_ID_RE.test(alarmId)) return null;
  const csq = value.csq === undefined || value.csq === null ? null : value.csq;
  if (csq !== null && !(Number.isSafeInteger(csq) && csq >= 0 && csq <= 99)) return null;
  return {
    state,
    alarmId,
    csq,
    lastSeen: isSafeCounter(value.lastSeen) ? value.lastSeen : 0,
    lastBusinessUplinkAt: isSafeCounter(value.lastBusinessUplinkAt) ? value.lastBusinessUplinkAt : 0,
    online: value.online === true
  };
}

function localDateKey(nowMs) {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

class StateStore {
  /**
   * @param {object} options
   * @param {string} options.dataDir
   * @param {object} options.logger
   * @param {() => number} [options.now]
   */
  constructor(options) {
    if (!options || typeof options.dataDir !== 'string' || options.dataDir.length === 0) {
      throw new TypeError('StateStore requires dataDir');
    }
    this.dataDir = path.resolve(options.dataDir);
    this.filePath = path.join(this.dataDir, STATE_FILE_NAME);
    this.logger = options.logger || null;
    this.now = typeof options.now === 'function' ? options.now : Date.now;

    this.seq = 0;
    this.commandCursor = 0;
    this.sosCount = 0;
    this.sosDate = localDateKey(this.now());
    /** 最后已知设备状态缓存（不含坐标）；进程重启后用于如实纠正后端在线态。 */
    this.deviceSnapshot = null;
    this._loaded = false;
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this._loaded = true;
        return this.snapshot();
      }
      throw stateError('STATE_READ_FAILED');
    }

    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw stateError('STATE_FILE_CORRUPT_JSON');
    }
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      throw stateError('STATE_FILE_CORRUPT_SHAPE');
    }
    if (document.version !== STATE_VERSION) {
      throw stateError('STATE_FILE_UNSUPPORTED_VERSION');
    }
    if (!isSafeCounter(document.seq)) throw stateError('STATE_FILE_INVALID_SEQ');
    if (!isSafeCounter(document.commandCursor)) throw stateError('STATE_FILE_INVALID_CURSOR');
    if (!isSafeCounter(document.sosCount)) throw stateError('STATE_FILE_INVALID_SOS_COUNT');
    if (typeof document.sosDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(document.sosDate)) {
      throw stateError('STATE_FILE_INVALID_SOS_DATE');
    }
    this.seq = document.seq;
    this.commandCursor = document.commandCursor;
    this.sosCount = document.sosCount;
    this.sosDate = document.sosDate;
    // 可选诊断缓存：非法只告警忽略，绝不因此拒绝启动（它不是命令/计数正确性的一环）。
    if (document.device !== undefined && document.device !== null) {
      const snapshot = normalizeDeviceSnapshot(document.device);
      if (snapshot) {
        this.deviceSnapshot = snapshot;
      } else if (this.logger) {
        this.logger.warn('STATE_DEVICE_SNAPSHOT_IGNORED', { code: 'INVALID_DEVICE_SNAPSHOT' });
      }
    }
    this._loaded = true;

    // 跨天后当日计数归零；不改变 seq/cursor。
    const today = localDateKey(this.now());
    if (this.sosDate !== today) {
      this.sosDate = today;
      this.sosCount = 0;
      this._persist();
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      seq: this.seq,
      commandCursor: this.commandCursor,
      sosCount: this.sosCount,
      sosDate: this.sosDate,
      device: this.deviceSnapshot ? { ...this.deviceSnapshot } : null,
      dataDir: this.dataDir,
      stateFile: this.filePath
    };
  }

  /** 分配下一个位置 seq（先落盘再返回；写盘失败直接抛错，不返回未持久化的值）。 */
  nextSeq() {
    if (!this._loaded) throw stateError('STATE_NOT_LOADED');
    const next = this.seq + 1;
    if (!Number.isSafeInteger(next)) throw stateError('STATE_SEQ_EXHAUSTED');
    this.seq = next;
    this._persist();
    return next;
  }

  /** 推进命令游标；只在值变化时写盘。 */
  setCommandCursor(cursor) {
    if (!this._loaded) throw stateError('STATE_NOT_LOADED');
    if (!isSafeCounter(cursor)) throw stateError('STATE_INVALID_CURSOR');
    if (cursor === this.commandCursor) return false;
    this.commandCursor = cursor;
    this._persist();
    return true;
  }

  /** 记录一次新告警，返回当日累计值（跨天自动归零）。 */
  noteSos() {    if (!this._loaded) throw stateError('STATE_NOT_LOADED');
    const today = localDateKey(this.now());
    if (this.sosDate !== today) {
      this.sosDate = today;
      this.sosCount = 0;
    }
    this.sosCount += 1;
    this._persist();
    return this.sosCount;
  }

  todaySosCount() {
    if (this.sosDate !== localDateKey(this.now())) return 0;
    return this.sosCount;
  }

  /**
   * 记录“最后已知设备状态”缓存（state/alarmId/csq/时间戳，绝不含坐标）。
   * 只用于进程重启后仍能如实纠正后端在线态；写盘失败抛错（调用方降级为诊断计数）。
   * @returns {boolean} 是否实际发生变化并落盘
   */
  setDeviceSnapshot(value) {
    if (!this._loaded) throw stateError('STATE_NOT_LOADED');
    const snapshot = normalizeDeviceSnapshot(value);
    if (!snapshot) throw stateError('STATE_INVALID_DEVICE_SNAPSHOT');
    if (this.deviceSnapshot && JSON.stringify(this.deviceSnapshot) === JSON.stringify(snapshot)) {
      return false;
    }
    this.deviceSnapshot = snapshot;
    this._persist();
    return true;
  }

  /** 最后已知设备状态（副本；无缓存返回 null）。 */
  getDeviceSnapshot() {
    return this.deviceSnapshot ? { ...this.deviceSnapshot } : null;
  }

  _persist() {
    const document = {
      version: STATE_VERSION,
      seq: this.seq,
      commandCursor: this.commandCursor,
      sosCount: this.sosCount,
      sosDate: this.sosDate,
      // 可选诊断缓存：老版本读到会忽略；新版本加载时非法则忽略不致命。
      device: this.deviceSnapshot ? { ...this.deviceSnapshot } : null,
      updatedAt: this.now()
    };
    const body = `${JSON.stringify(document, null, 2)}\n`;
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      // fsync 保证 rename 前内容已落盘，避免掉电后留下空/半截状态文件。
      const handle = fs.openSync(tempPath, 'w', 0o600);
      try {
        fs.writeFileSync(handle, body);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* 忽略清理失败 */
      }
      if (this.logger) this.logger.error('STATE_WRITE_FAILED', { code: error && error.code ? error.code : 'UNKNOWN' });
      throw stateError('STATE_WRITE_FAILED');
    }
  }
}

function stateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = Object.freeze({
  StateStore,
  STATE_FILE_NAME,
  STATE_VERSION,
  normalizeDeviceSnapshot,
  localDateKey
});
