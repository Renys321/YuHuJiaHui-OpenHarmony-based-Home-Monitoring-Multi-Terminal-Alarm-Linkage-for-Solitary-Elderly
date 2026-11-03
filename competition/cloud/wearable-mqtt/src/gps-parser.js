'use strict';

/**
 * gps-parser.js — M100MG-B1 GPS 主动上报固定格式解析（纯函数、零依赖）。
 *
 * 真实格式（2026-10-27 真机 M100+ESP32 实测确认）：
 *   主动上报内容格式 = 固定格式；格式为「经度_纬度」；
 *   真机样例：`112.55326080300_32.966827393000`
 *   （WGS84 十进制度，无时间字段；适配器用服务器收到报文的时间作为 fixTime）。
 *
 * 因此十进制度（dd.dddd）是**主路径**；契约文字里的“度分”保留兼容：
 * 本解析器在**按轴量级无歧义**时支持两种编码：
 *   - 十进制度（dd.dddd）：经度 |v| <= 180、纬度 |v| <= 90；
 *   - 度分（ddmm.mmmm）：经度 |v| > 180、纬度 |v| > 90（中国境内经度 11358.4220、
 *     纬度 2231.5626 都远大于阈值，因此不会与十进制度混淆）。
 * 度分转换：deg = trunc(v/100)，min = v - deg*100，要求 min < 60，decimal = deg + min/60。
 *
 * 严格性：
 *   - 只接受“恰好两个数值”的固定格式（`_` 分隔，可带 `GPS_` 前缀或半球自定义格式）；
 *   - 任何多余文本、字段、`config,...` 聊天式回包都判失败；
 *   - 解析失败**只返回错误码**，绝不返回猜测坐标（调用方只记诊断，不写假坐标）。
 */

const COORD_PAIR_RE = /^([+-]?\d{1,5}(?:\.\d+)?)_([+-]?\d{1,5}(?:\.\d+)?)$/;
const GPS_PREFIX_RE = /^GPS[:_]/i;
const HEMISPHERE_RE = /^GPS_([EW])_(-?\d{1,5}(?:\.\d+)?)_([NS])_(-?\d{1,5}(?:\.\d+)?)(?:_END)?$/i;
const COORDINATE_RE = /^[+-]?\d{1,5}(?:\.\d+)?$/;

function round7(value) {
  return Math.round(value * 1e7) / 1e7;
}

function parseCoordinate(raw, axis) {
  if (typeof raw !== 'string' || !COORDINATE_RE.test(raw)) {
    return { ok: false, code: 'INVALID_NUMBER' };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return { ok: false, code: 'INVALID_NUMBER' };

  const limit = axis === 'latitude' ? 90 : 180;
  if (Math.abs(value) <= limit) {
    // 十进制度（真实固定格式路径）
    return { ok: true, value: round7(value), format: 'dd' };
  }

  // 度分编码 ddmm.mmmm：数值量级 >= 1000 才按度分解释。
  // 该阈值保证不会被“超出范围的十进制度”误判（如 200.0 必须是错误，而不是 2°00'）；
  // 中国境内经纬度度分值都 >= 1000（经度 113xx、纬度 22xx/32xx），因此无歧义。
  if (Math.abs(value) < 1000) return { ok: false, code: 'OUT_OF_RANGE' };
  const magnitude = Math.abs(value);
  const degrees = Math.trunc(magnitude / 100);
  const minutes = magnitude - degrees * 100;
  if (minutes >= 60) return { ok: false, code: 'INVALID_MINUTES' };
  const decimal = degrees + minutes / 60;
  if (decimal > limit) return { ok: false, code: 'OUT_OF_RANGE' };
  const signed = value < 0 ? -decimal : decimal;
  return { ok: true, value: round7(signed), format: 'ddmm' };
}

function applyHemisphere(value, hemisphere, axis) {
  if (axis === 'latitude') {
    if (hemisphere !== 'N' && hemisphere !== 'S') return null;
    return hemisphere === 'S' ? -Math.abs(value) : Math.abs(value);
  }
  if (hemisphere !== 'E' && hemisphere !== 'W') return null;
  return hemisphere === 'W' ? -Math.abs(value) : Math.abs(value);
}

/**
 * 解析非 JSON 的 GPS 固定格式报文。
 *
 * @param {string|Buffer} input MQTT payload（单行文本）
 * @returns {{ok:true, latitude:number, longitude:number, format:'dd'|'ddmm'}|{ok:false, code:string}}
 */
function parseGpsFixedFormat(input) {
  let text;
  if (Buffer.isBuffer(input)) {
    text = input.toString('utf8');
  } else if (typeof input === 'string') {
    text = input;
  } else {
    return { ok: false, code: 'INVALID_INPUT' };
  }

  // 去掉 NUL / 行尾 CRLF / 首尾空白；固定格式本身是单行。
  text = text.replace(/\u0000/g, '').trim();
  if (text === '') return { ok: false, code: 'EMPTY' };
  if (text.length > 512) return { ok: false, code: 'TOO_LONG' };
  if (text.includes('{') || text.includes('}')) return { ok: false, code: 'JSON_NOT_GPS' };

  // 自定义带半球格式：GPS_E_113.9735_N_22.69085_END
  const hemisphereMatch = HEMISPHERE_RE.exec(text);
  if (hemisphereMatch) {
    const lonParsed = parseCoordinate(hemisphereMatch[2], 'longitude');
    if (!lonParsed.ok) return lonParsed;
    const latParsed = parseCoordinate(hemisphereMatch[4], 'latitude');
    if (!latParsed.ok) return latParsed;
    const longitude = applyHemisphere(lonParsed.value, hemisphereMatch[1].toUpperCase(), 'longitude');
    const latitude = applyHemisphere(latParsed.value, hemisphereMatch[3].toUpperCase(), 'latitude');
    return finalize(latitude, longitude, lonParsed.format === 'ddmm' || latParsed.format === 'ddmm' ? 'ddmm' : 'dd');
  }

  // 官方固定格式：经度_纬度（可能带 GPS: / GPS_ 前缀）。
  const stripped = text.replace(GPS_PREFIX_RE, '');
  const pairMatch = COORD_PAIR_RE.exec(stripped);
  if (!pairMatch) {
    // 只有两个数值但分隔符不是 '_'（例如逗号）也判失败：避免把 config 回包误判为坐标。
    return { ok: false, code: 'NOT_GPS_FIXED_FORMAT' };
  }
  const lonParsed = parseCoordinate(pairMatch[1], 'longitude');
  if (!lonParsed.ok) return lonParsed;
  const latParsed = parseCoordinate(pairMatch[2], 'latitude');
  if (!latParsed.ok) return latParsed;
  const format = lonParsed.format === 'ddmm' || latParsed.format === 'ddmm' ? 'ddmm' : 'dd';
  return finalize(latParsed.value, lonParsed.value, format);
}

function finalize(latitude, longitude, format) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, code: 'INVALID_NUMBER' };
  }
  if (latitude < -90 || latitude > 90) return { ok: false, code: 'LATITUDE_OUT_OF_RANGE' };
  if (longitude < -180 || longitude > 180) return { ok: false, code: 'LONGITUDE_OUT_OF_RANGE' };
  // (0,0) 不是有效 GNSS 定位；后端也会拒绝 fixValid=1 的零坐标。
  if (latitude === 0 && longitude === 0) return { ok: false, code: 'ZERO_COORDINATE' };
  return {
    ok: true,
    latitude: round7(latitude),
    longitude: round7(longitude),
    format
  };
}

module.exports = Object.freeze({
  parseGpsFixedFormat,
  parseCoordinate,
  COORD_PAIR_RE
});
