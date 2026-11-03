'use strict';

/**
 * gps-parser.test.js — M100 GPS 固定格式解析单元测试。
 * 覆盖：度分→十进制、WGS84 范围校验、坏报文降级、零坐标拒绝、格式严格性。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGpsFixedFormat, parseCoordinate } = require('../src/gps-parser');

test('官方固定格式 经度_纬度（十进制度）', () => {
  const parsed = parseGpsFixedFormat('113.9737_22.69271');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.longitude, 113.9737);
  assert.equal(parsed.latitude, 22.69271);
  assert.equal(parsed.format, 'dd');
});

test('真机实测样例：112.55326080300_32.966827393000（WGS84 十进制度，无时间字段）', () => {
  const parsed = parseGpsFixedFormat('112.55326080300_32.966827393000');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, 'dd', '十进制分支是主路径');
  // 精度归一化到 7 位小数（约 1cm），不引入度分换算误差。
  assert.equal(parsed.longitude, 112.5532608);
  assert.equal(parsed.latitude, 32.9668274);
  assert.ok(Math.abs(parsed.longitude - 112.553260803) < 1e-6);
  assert.ok(Math.abs(parsed.latitude - 32.966827393) < 1e-6);
  // 无时间字段：适配器固定用“收到报文的时间”作为 fixTime（见 adapter）。
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'fixTime'), false);
});

test('行尾 CRLF / NUL / 空白不影响解析', () => {
  const parsed = parseGpsFixedFormat('113.9737_22.69271\r\n\u0000');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.latitude, 22.69271);
});

test('兼容 GPS: / GPS_ 前缀', () => {
  const colon = parseGpsFixedFormat('GPS:113.9737_22.69271');
  assert.equal(colon.ok, true);
  const underscore = parseGpsFixedFormat('GPS_113.9737_22.69271');
  assert.equal(underscore.ok, true);
});

test('度分 ddmm.mmmm 转十进制度（经度 11358.4220 -> 113.9737）', () => {
  const parsed = parseGpsFixedFormat('11358.4220_2231.5626');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, 'ddmm');
  assert.ok(Math.abs(parsed.longitude - 113.9737) < 1e-4, String(parsed.longitude));
  assert.ok(Math.abs(parsed.latitude - 22.5260433) < 1e-4, String(parsed.latitude));
});

test('度分分钟数 >= 60 判非法', () => {
  const parsed = parseGpsFixedFormat('11360.0_2231.5');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'INVALID_MINUTES');
});

test('自定义半球格式 GPS_E_lon_N_lat_END', () => {
  const east = parseGpsFixedFormat('GPS_E_113.9735_N_22.69085_END');
  assert.equal(east.ok, true);
  assert.equal(east.longitude, 113.9735);
  assert.equal(east.latitude, 22.69085);
  const westSouth = parseGpsFixedFormat('GPS_W_113.9735_S_22.69085_END');
  assert.equal(westSouth.ok, true);
  assert.equal(westSouth.longitude, -113.9735);
  assert.equal(westSouth.latitude, -22.69085);
});

test('WGS84 范围校验：纬度超 90、经度超 180 均拒绝', () => {
  const badLat = parseGpsFixedFormat('113.9737_95.0');
  assert.equal(badLat.ok, false);
  const badLon = parseGpsFixedFormat('200.0_22.69271');
  assert.equal(badLon.ok, false);
  assert.equal(badLon.code, 'OUT_OF_RANGE');
});

test('(0,0) 不是有效定位（不写假坐标）', () => {
  const parsed = parseGpsFixedFormat('0.0_0.0');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'ZERO_COORDINATE');
});

test('坏报文/非 GPS 行一律降级为错误码，不返回坐标', () => {
  const badInputs = [
    ['', 'EMPTY'],
    ['config,gps,ok,1,E,113.', 'NOT_GPS_FIXED_FORMAT'],
    ['config,get,location,2', 'NOT_GPS_FIXED_FORMAT'],
    ['113.9737', 'NOT_GPS_FIXED_FORMAT'],
    ['113.9737_', 'NOT_GPS_FIXED_FORMAT'],
    ['abc_22.69271', 'NOT_GPS_FIXED_FORMAT'],
    ['113.9737_22.69271_extra', 'NOT_GPS_FIXED_FORMAT'],
    ['{"t":"hb"}', 'JSON_NOT_GPS']
  ];
  for (const [input, code] of badInputs) {
    const parsed = parseGpsFixedFormat(input);
    assert.equal(parsed.ok, false, input);
    assert.equal(parsed.code, code, input);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'latitude'), false);
  }
});

test('parseCoordinate 边界：90/180 合法，91/181 非法', () => {
  assert.deepEqual(parseCoordinate('90.0', 'latitude'), { ok: true, value: 90, format: 'dd' });
  assert.deepEqual(parseCoordinate('180.0', 'longitude'), { ok: true, value: 180, format: 'dd' });
  assert.equal(parseCoordinate('91.0', 'latitude').ok, false);
  assert.equal(parseCoordinate('181.0', 'longitude').ok, false);
});
