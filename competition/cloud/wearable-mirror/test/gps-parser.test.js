'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFixedFormat, normalizeEventGps } = require('../src/gps');

test('真机 M100 固定格式样例：经度_纬度 → WGS84 十进制度', () => {
  const result = parseFixedFormat('112.55326080300_32.966827393000');
  assert.deepEqual(result, { ok: true, latitude: 32.9668274, longitude: 112.5532608, format: 'dd' });
});

test('允许 GPS_ 前缀与 NUL/换行，但拒绝多余文本', () => {
  assert.equal(parseFixedFormat('GPS_112.55326080300_32.966827393000').ok, true);
  assert.equal(parseFixedFormat('112.55326080300_32.966827393000\r\n').ok, true);
  assert.equal(parseFixedFormat('112.55326080300_32.966827393000_END').ok, false);
  assert.equal(parseFixedFormat('config,set,paramsrc,1').ok, false);
});

test('非法/越界/(0,0) 一律失败且不返回坐标', () => {
  for (const payload of ['', 'abc', '0_0', '200.1_32.9', '112.5_100.0', '112.5,32.9', '112_999']) {
    const result = parseFixedFormat(payload);
    assert.equal(result.ok, false, `should reject: ${payload}`);
    assert.equal(result.latitude, undefined);
    assert.equal(result.longitude, undefined);
  }
});

test('度分编码（非十进制度量级）兼容解析', () => {
  const result = parseFixedFormat('11358.4220_2231.5626');
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.longitude - (113 + 58.422 / 60)) < 1e-6);
  assert.ok(Math.abs(result.latitude - (22 + 31.5626 / 60)) < 1e-6);
});

test('normalizeEventGps：只有 fix=true 且合法坐标才 valid，否则 null 坐标', () => {
  const now = 1_793_100_000_000;
  assert.deepEqual(normalizeEventGps({ lat: 32.1, lon: 112.2, fix: true, ageMs: 1000 }, now), {
    valid: true, latitude: 32.1, longitude: 112.2, fixTime: now - 1000
  });
  assert.deepEqual(normalizeEventGps({ lat: 32.1, lon: 112.2, fix: false }, now),
    { valid: false, latitude: null, longitude: null, fixTime: 0 });
  assert.deepEqual(normalizeEventGps({ lat: 0, lon: 0, fix: true }, now),
    { valid: false, latitude: null, longitude: null, fixTime: 0 });
  assert.deepEqual(normalizeEventGps(null, now),
    { valid: false, latitude: null, longitude: null, fixTime: 0 });
  assert.deepEqual(normalizeEventGps({ latitude: 32.1, longitude: 112.2, valid: true }, now), {
    valid: true, latitude: 32.1, longitude: 112.2, fixTime: now
  });
});
