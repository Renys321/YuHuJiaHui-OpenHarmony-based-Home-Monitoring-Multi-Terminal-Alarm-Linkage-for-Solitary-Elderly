'use strict';

/**
 * lib/location-status.js — YED 定位状态的纯逻辑（无 IO，可确定性单测）
 *
 * 职责：把 lib/dtu-protocol.js 的严格解析结果，转成两份现有合同的字段：
 *   1) 本地 MQTT home/<deviceId>/status（Bridge/public-sync 消费）；
 *   2) 公网 device-status 摄取里 store.js 规范化的 gps 字段
 *      （只认 valid / latitude / longitude / fixTime）。
 *
 * 诚信约束（本工作包核心）：
 *   - 没有有效 fix 一律 gps = { valid:false, fixTime:0 }，绝不写 0 坐标；
 *   - 只有显式 valid、经纬度成对、非零、范围合法、fixTime 是 13 位毫秒且不过期/不来自未来，
 *     才允许 valid:true；
 *   - 公网后端在报文缺 gps 时会沿用上一份 gps（store.js:299），所以**每次都必须带 gps 字段**，
 *     否则旧坐标会被当成当前定位一直留着。
 *   - csq 只接受 0-31；99 与越界值一律表示"未知"，不得当成好信号。
 */

/** fix 允许的最大年龄（毫秒）；超过即视为陈旧，不得冒充当前定位。 */
const DEFAULT_MAX_FIX_AGE_MS = 120000;
/** 允许的时钟超前容差（毫秒）。 */
const FUTURE_TOLERANCE_MS = 60000;
const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;
const CSQ_UNKNOWN = 99;
const EPOCH_MS_MIN = 1000000000000;
const EPOCH_MS_MAX = 9999999999999;

const DEFAULT_DEVICE_ID = 'yed-home-gateway';
const DEFAULT_ROOM = '家庭网关';

function isValidEpochMs(value) {
  return Number.isSafeInteger(value) && value >= EPOCH_MS_MIN && value <= EPOCH_MS_MAX;
}

/** DTU 给的是 'YYYY-MM-DDTHH:MM:SSZ' 字符串；这里只做严格转换，不做宽松修正。 */
function fixTimeToMs(fixTimeUtc) {
  if (typeof fixTimeUtc !== 'string' || fixTimeUtc.length === 0 || fixTimeUtc.length > 32) return null;
  const parsed = Date.parse(fixTimeUtc);
  if (!Number.isFinite(parsed)) return null;
  const ms = Math.trunc(parsed);
  return isValidEpochMs(ms) ? ms : null;
}

/**
 * 生成合同要求的 gps 对象。
 * @param {object} gnss    dtu-protocol.summarizeDeviceState().gnss
 * @param {number} nowMs   当前时间（13 位毫秒）
 * @param {object} [options] { maxFixAgeMs }
 */
function buildGps(gnss, nowMs, options = {}) {
  const invalid = { valid: false, fixTime: 0 };
  if (!gnss || typeof gnss !== 'object' || gnss.valid !== true) return invalid;
  if (!isValidEpochMs(nowMs)) return invalid;

  const latitude = gnss.latitude;
  const longitude = gnss.longitude;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return invalid;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return invalid;
  // 零坐标不是"在几内亚湾"，而是"没有定位"。
  if (latitude === 0 && longitude === 0) return invalid;
  if (Math.abs(latitude) > MAX_LATITUDE || Math.abs(longitude) > MAX_LONGITUDE) return invalid;

  const fixTime = fixTimeToMs(gnss.fixTimeUtc);
  if (fixTime === null) return invalid;

  const maxFixAgeMs = Number.isSafeInteger(options.maxFixAgeMs) && options.maxFixAgeMs > 0
    ? options.maxFixAgeMs
    : DEFAULT_MAX_FIX_AGE_MS;
  if (nowMs - fixTime > maxFixAgeMs) return invalid;          // 陈旧
  if (fixTime - nowMs > FUTURE_TOLERANCE_MS) return invalid;  // 明显来自未来

  return { valid: true, latitude, longitude, fixTime };
}

/** 0-31 为有效信号；其余（含 99、null、字符串、越界）统一为"未知"。 */
function normalizeCsq(signal) {
  const value = signal && typeof signal === 'object' ? signal.csq : null;
  if (Number.isSafeInteger(value) && value >= 0 && value <= 31) return value;
  return CSQ_UNKNOWN;
}

/**
 * 组装本地 MQTT 状态报文（字段与 homemon 已验证报文同构，额外带 gps/csq）。
 * @param {object} device  dtu-protocol.summarizeDeviceState() 的结果
 * @param {object} options { nowMs, deviceId, room, maxFixAgeMs }
 */
function buildStatusPayload(device, options = {}) {
  const nowMs = options.nowMs;
  if (!isValidEpochMs(nowMs)) throw new TypeError('nowMs must be a 13-digit millisecond timestamp');
  const deviceId = typeof options.deviceId === 'string' && options.deviceId.length > 0
    ? options.deviceId : DEFAULT_DEVICE_ID;
  const room = typeof options.room === 'string' && options.room.length > 0 ? options.room : DEFAULT_ROOM;
  const source = device && typeof device === 'object' ? device : {};
  return {
    deviceId,
    room,
    ts: nowMs,
    state: 'NORMAL',
    monitorOnline: -1,
    alarm: { id: '', type: '', countToday: 0, evidenceId: '' },
    gps: buildGps(source.gnss, nowMs, options),
    csq: normalizeCsq(source.signal)
  };
}

/** 串口读失败/掉线时使用的降级报文：明确"无有效定位"，而不是沿用旧坐标。 */
function buildUnavailablePayload(options = {}) {
  const nowMs = options.nowMs;
  if (!isValidEpochMs(nowMs)) throw new TypeError('nowMs must be a 13-digit millisecond timestamp');
  const deviceId = typeof options.deviceId === 'string' && options.deviceId.length > 0
    ? options.deviceId : DEFAULT_DEVICE_ID;
  const room = typeof options.room === 'string' && options.room.length > 0 ? options.room : DEFAULT_ROOM;
  return {
    deviceId,
    room,
    ts: nowMs,
    state: 'NORMAL',
    monitorOnline: -1,
    alarm: { id: '', type: '', countToday: 0, evidenceId: '' },
    gps: { valid: false, fixTime: 0 },
    csq: CSQ_UNKNOWN
  };
}

module.exports = {
  DEFAULT_MAX_FIX_AGE_MS,
  FUTURE_TOLERANCE_MS,
  CSQ_UNKNOWN,
  DEFAULT_DEVICE_ID,
  DEFAULT_ROOM,
  isValidEpochMs,
  fixTimeToMs,
  buildGps,
  normalizeCsq,
  buildStatusPayload,
  buildUnavailablePayload
};
