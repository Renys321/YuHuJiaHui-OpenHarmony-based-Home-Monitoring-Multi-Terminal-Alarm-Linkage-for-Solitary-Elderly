'use strict';

/**
 * gps.js — M100 固定格式 GPS 解析。
 *
 * 复用公网适配服务同一份解析器（competition/cloud/wearable-mqtt/src/gps-parser.js），
 * 保证 PC 镜像与 ECS 适配器对同一条真机报文的判定完全一致（含失败码），
 * 避免“镜像写了一个假坐标而云端没有”的分叉。
 *
 * 只读依赖：本模块不修改 wearable-mqtt；若该文件缺失，加载即失败（不静默降级）。
 */

const path = require('node:path');

const PARSER_PATH = path.resolve(__dirname, '..', '..', 'wearable-mqtt', 'src', 'gps-parser.js');
const parser = require(PARSER_PATH);

if (typeof parser.parseGpsFixedFormat !== 'function') {
  throw new Error('gps-parser.js does not export parseGpsFixedFormat');
}

/** 返回 {ok:true,latitude,longitude,format} 或 {ok:false,code}，绝不返回猜测坐标 */
function parseFixedFormat(payload) {
  try {
    return parser.parseGpsFixedFormat(payload);
  } catch (err) {
    return { ok: false, code: 'PARSER_EXCEPTION' };
  }
}

/**
 * 业务 JSON 里自带的 gps（契约 §3.1：{lat,lon,fix,ageMs} 可为 null）。
 * 仅在 fix===true 且经纬度都是有限数、在合法范围且不是 (0,0) 时才认为有效；
 * 否则返回 valid:false 且经纬度为 null（绝不用 0 冒充坐标）。
 */
function normalizeEventGps(raw, nowMs) {
  const invalid = { valid: false, latitude: null, longitude: null, fixTime: 0 };
  if (raw === null || raw === undefined || typeof raw !== 'object') return invalid;
  const fix = raw.fix === true || raw.valid === true;
  if (!fix) return invalid;
  let latitude = raw.lat;
  let longitude = raw.lon;
  if (latitude === undefined) latitude = raw.latitude;
  if (longitude === undefined) longitude = raw.longitude;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return invalid;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return invalid;
  if (latitude < -90 || latitude > 90) return invalid;
  if (longitude < -180 || longitude > 180) return invalid;
  if (latitude === 0 && longitude === 0) return invalid;
  let fixTime = nowMs;
  const ageMs = raw.ageMs;
  if (typeof ageMs === 'number' && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 24 * 3600 * 1000) {
    fixTime = nowMs - Math.round(ageMs);
  }
  return { valid: true, latitude, longitude, fixTime };
}

module.exports = Object.freeze({ parseFixedFormat, normalizeEventGps });
