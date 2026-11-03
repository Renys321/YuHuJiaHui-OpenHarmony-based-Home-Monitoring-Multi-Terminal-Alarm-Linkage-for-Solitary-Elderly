'use strict';

/**
 * PIR 活动聚合的独立存储。
 *
 * 活动聚合只追加，和主快照（PersistentStore，schema v6）不是一回事，所以单独落一个
 * 版本化 JSON 文件，免得两套 schema 互相绑。
 *
 * 文件格式：{ version, savedAt, activity }，activity 内部同样严格白名单。
 * 未知字段、日桶越界、hourly 长度不是 24、hourly 之和与 count 不符、时区与当前配置
 * 不一致（已有数据时）都会拒绝启动，不静默清空历史。
 *
 * 写入：同目录临时文件（0600）→ fsync → rename，失败回滚内存再抛错。
 * 单进程模型，同一 filePath 不支持多实例并发写。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  activityFromDocument,
  activityToDocument,
  buildActivityReport,
  createActivityState,
  createHouseholdClock,
  normalizeActivityQuery,
  parseHouseholdTimezone,
  recordActivitySample
} = require('./activity');

/** 活动状态文件自身的 schema 版本，与主快照 schemaVersion 无关。 */
const ACTIVITY_FILE_VERSION = 1;
/** 文件顶层字段白名单。 */
const FILE_KEYS = ['version', 'savedAt', 'activity'];
const FILE_KEY_SET = new Set(FILE_KEYS);
const CORRUPT = 'activity store corrupt: ';

let tempCounter = 0;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 原子写入：同目录临时文件（0600）→ fsync → rename。
 * 目标文件要么是旧内容，要么是完整新内容。
 */
function atomicWriteFile(filePath, text) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  tempCounter += 1;
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${tempCounter}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 保留原始错误 */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* 临时文件可能尚未创建 */ }
    throw error;
  }
  try {
    const dirFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* Windows 上目录 fsync 可能不被支持，尽力而为 */ }
}

class ActivityStore {
  /**
   * @param {object} options
   * @param {string}   options.filePath        状态文件路径（必填）；父目录自动创建
   * @param {string}   [options.timezone]      家庭时区；默认 Asia/Shanghai，非法 fail-closed
   * @param {Function} [options.now]           查询/落盘时间来源；测试可注入固定值
   * @param {Function} [options.atomicWriter]  测试注入点：(filePath, text) => void
   */
  constructor(options = {}) {
    if (!isPlainObject(options)) fail('options must be a plain object');
    if (typeof options.filePath !== 'string' || options.filePath.trim() === '') {
      fail('filePath must be a non-empty string');
    }
    const timezone = parseHouseholdTimezone(options.timezone === undefined ? '' : options.timezone);
    this.filePath = path.resolve(options.filePath);
    this.clock = createHouseholdClock(timezone);
    this.activity = createActivityState(this.clock);
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
      fail(`activity store unreadable: ${error && error.message ? error.message : String(error)}`);
    }
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      fail(`${CORRUPT}invalid JSON`);
    }
    this._loadDocument(document);
  }

  _loadDocument(document) {
    if (!isPlainObject(document)) fail(`${CORRUPT}root must be an object`);
    for (const key of Object.keys(document)) {
      if (!FILE_KEY_SET.has(key)) fail(`${CORRUPT}unknown top-level field ${key}`);
    }
    if (document.version !== ACTIVITY_FILE_VERSION) {
      fail(`${CORRUPT}unsupported version: ${String(document.version)}`);
    }
    if (!Number.isSafeInteger(document.savedAt) || document.savedAt < 0) {
      fail(`${CORRUPT}savedAt must be a non-negative safe integer`);
    }
    if (document.activity === undefined) fail(`${CORRUPT}activity is required`);
    this.activity = activityFromDocument(document.activity, this.clock, CORRUPT);
  }

  /* ---- 快照 / 落盘 ---- */

  _document() {
    return {
      version: ACTIVITY_FILE_VERSION,
      savedAt: this._now(),
      activity: activityToDocument(this.activity)
    };
  }

  /** 同步原子落盘（调用方负责保证内存已更新）。 */
  _flush() {
    const text = `${JSON.stringify(this._document(), null, 2)}\n`;
    this._atomicWriter(this.filePath, text);
  }

  /* ---- 写入入口 ---- */

  /**
   * 记录一次设备状态摄入对活动统计的影响。
   *
   * 载荷里没有 sensors.motion（比如厨房没装 PIR）时什么也不写，不补 0；
   * 有效样本和非法样本都会推进状态并同步落盘；落盘失败回滚内存并抛出，
   * 由 server 收敛成安全错误码，不影响设备状态摄入的 202 语义。
   *
   * @param {object} status  `store.ingest` 归一化后的设备状态
   * @param {number} [receivedAt] 服务端收到载荷的时刻（默认取注入时钟）
   * @returns {{recorded:boolean, kind:'no_motion'|'invalid'|'sample', delta:number, reset:boolean, dayKey:string}}
   */
  recordStatus(status, receivedAt) {
    if (!isPlainObject(status)) fail('activity status must be an object');
    const timestamp = Number.isSafeInteger(receivedAt) ? receivedAt : this._now();
    const snapshot = activityToDocument(this.activity);
    const result = recordActivitySample(this.activity, this.clock, {
      deviceId: status.deviceId,
      receivedAt: timestamp,
      sensors: status.sensors
    });
    if (result.kind === 'no_motion') return { recorded: false, ...result };
    try {
      this._flush();
    } catch (error) {
      // 写盘失败：回滚内存，别留“内存成功、磁盘失败”的假状态。
      this.activity = activityFromDocument(snapshot, this.clock, CORRUPT);
      throw error;
    }
    return { recorded: true, ...result };
  }

  /* ---- 查询入口 ---- */

  /**
   * GET /api/v1/activity/report 的响应体。
   *
   * @param {{scope?: string, date?: string}} query
   * @param {Map<string, object>|Array<object>} [devices]
   *        设备列表，只用于 room 展示和“无 PIR 设备也出现在 devices[]”；传 store.listDevices() 即可。
   */
  getActivityReport(query = {}, devices) {
    const validated = normalizeActivityQuery(query);
    if (!validated.ok) {
      const error = new Error(validated.error);
      error.code = 'ACTIVITY_QUERY_INVALID';
      throw error;
    }
    const deviceMap = new Map();
    if (devices instanceof Map) {
      for (const [deviceId, value] of devices) deviceMap.set(deviceId, value);
    } else if (Array.isArray(devices)) {
      for (const value of devices) {
        if (isPlainObject(value) && typeof value.deviceId === 'string') deviceMap.set(value.deviceId, value);
      }
    }
    return buildActivityReport({
      activity: this.activity,
      clock: this.clock,
      devices: deviceMap,
      now: this._now(),
      scope: validated.value.scope,
      date: validated.value.date
    });
  }
}

module.exports = {
  ACTIVITY_FILE_VERSION,
  ActivityStore,
  atomicWriteFile
};
