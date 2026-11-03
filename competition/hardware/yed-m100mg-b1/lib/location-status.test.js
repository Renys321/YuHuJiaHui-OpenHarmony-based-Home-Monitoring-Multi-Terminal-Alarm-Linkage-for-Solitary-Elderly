'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildGps,
  normalizeCsq,
  buildStatusPayload,
  buildUnavailablePayload,
  fixTimeToMs,
  DEFAULT_MAX_FIX_AGE_MS,
  CSQ_UNKNOWN
} = require('./location-status');

const NOW = 1792064000000;                       // 2026-10-15T11:33:20.000Z
const FIX_UTC = '2026-10-15T11:33:10Z';          // 10 秒前
const FIX_MS = Date.parse(FIX_UTC);

function gnss(overrides = {}) {
  return Object.assign({
    supported: true,
    state: 'FIXED',
    valid: true,
    reason: 'extended_flag',
    latitude: 34.7466,
    longitude: 113.6254,
    fixTimeUtc: FIX_UTC,
    speedKmh: 0,
    courseDeg: 0,
    altitudeM: 110
  }, overrides);
}

test('有效 fix：成对、非零、范围内、时间有效且新鲜 -> valid:true', () => {
  const gps = buildGps(gnss(), NOW);
  assert.deepEqual(gps, { valid: true, latitude: 34.7466, longitude: 113.6254, fixTime: FIX_MS });
  assert.equal(String(gps.fixTime).length, 13);
});

test('室内 NO_FIX：valid:false 且 fixTime=0，绝不带坐标', () => {
  const gps = buildGps(gnss({ valid: false, state: 'NO_FIX', reason: 'flag_zero', latitude: null, longitude: null, fixTimeUtc: null }), NOW);
  assert.deepEqual(gps, { valid: false, fixTime: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(gps, 'latitude'), false);
});

test('零坐标不得当作有效定位', () => {
  assert.deepEqual(buildGps(gnss({ latitude: 0, longitude: 0 }), NOW), { valid: false, fixTime: 0 });
});

test('越界坐标不得当作有效定位', () => {
  assert.deepEqual(buildGps(gnss({ latitude: 91, longitude: 113 }), NOW), { valid: false, fixTime: 0 });
  assert.deepEqual(buildGps(gnss({ latitude: 34, longitude: 181 }), NOW), { valid: false, fixTime: 0 });
  assert.deepEqual(buildGps(gnss({ latitude: Number.NaN, longitude: 113 }), NOW), { valid: false, fixTime: 0 });
});

test('非法/缺失时间不得当作有效定位', () => {
  assert.equal(fixTimeToMs('2026-13-45T99:99:99Z'), null);
  assert.equal(fixTimeToMs(''), null);
  assert.equal(fixTimeToMs(null), null);
  assert.deepEqual(buildGps(gnss({ fixTimeUtc: null }), NOW), { valid: false, fixTime: 0 });
  assert.deepEqual(buildGps(gnss({ fixTimeUtc: 'not-a-time' }), NOW), { valid: false, fixTime: 0 });
});

test('陈旧 fix 失效：超过最大年龄一律 valid:false', () => {
  const stale = gnss({ fixTimeUtc: new Date(NOW - DEFAULT_MAX_FIX_AGE_MS - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  assert.deepEqual(buildGps(stale, NOW), { valid: false, fixTime: 0 });
  const fresh = gnss({ fixTimeUtc: new Date(NOW - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  assert.equal(buildGps(fresh, NOW).valid, true);
});

test('明显来自未来的时间不得当作有效定位', () => {
  const future = gnss({ fixTimeUtc: new Date(NOW + 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  assert.deepEqual(buildGps(future, NOW), { valid: false, fixTime: 0 });
});

test('CSQ=99 与越界值表示未知，不得当成好信号', () => {
  assert.equal(normalizeCsq({ csq: 26 }), 26);
  assert.equal(normalizeCsq({ csq: 30 }), 30);
  assert.equal(normalizeCsq({ csq: 0 }), 0);
  assert.equal(normalizeCsq({ csq: 99 }), CSQ_UNKNOWN);
  assert.equal(normalizeCsq({ csq: 31 }), 31);
  assert.equal(normalizeCsq({ csq: 32 }), CSQ_UNKNOWN);
  assert.equal(normalizeCsq({ csq: -1 }), CSQ_UNKNOWN);
  assert.equal(normalizeCsq({ csq: null }), CSQ_UNKNOWN);
  assert.equal(normalizeCsq({ csq: '26' }), CSQ_UNKNOWN);
  assert.equal(normalizeCsq(undefined), CSQ_UNKNOWN);
});

test('status 报文满足既有合同字段（gateway/adapter/store 交集）', () => {
  const device = { gnss: gnss(), signal: { csq: 26 } };
  const payload = buildStatusPayload(device, { nowMs: NOW });
  assert.equal(payload.deviceId, 'yed-home-gateway');
  assert.equal(payload.room, '家庭网关');
  assert.equal(payload.ts, NOW);
  assert.equal(String(payload.ts).length, 13);
  assert.equal(payload.state, 'NORMAL');
  assert.deepEqual(Object.keys(payload.gps).sort(), ['fixTime', 'latitude', 'longitude', 'valid']);
  assert.equal(payload.csq, 26);
  assert.deepEqual(payload.alarm, { id: '', type: '', countToday: 0, evidenceId: '' });
  assert.equal(payload.monitorOnline, -1);
  const allowedStates = ['NORMAL', 'WARN', 'ALARM', 'ACKED'];
  assert.ok(allowedStates.includes(payload.state));
});

test('无定位报文的 gps 不可能通过公网"有效位置"过滤', () => {
  // store.js:207 的过滤条件是 gps.valid && latitude!==null && longitude!==null
  const payload = buildStatusPayload({ gnss: gnss({ valid: false }) }, { nowMs: NOW });
  const passes = payload.gps.valid === true &&
    payload.gps.latitude !== null && payload.gps.latitude !== undefined &&
    payload.gps.longitude !== null && payload.gps.longitude !== undefined;
  assert.equal(passes, false);
  assert.deepEqual(payload.gps, { valid: false, fixTime: 0 });
});

test('串口不可用时的降级报文同样是 valid:false，且不沿用旧坐标', () => {
  const payload = buildUnavailablePayload({ nowMs: NOW });
  assert.deepEqual(payload.gps, { valid: false, fixTime: 0 });
  assert.equal(payload.csq, 99);
  assert.equal(payload.ts, NOW);
});

test('nowMs 非 13 位毫秒时直接拒绝（不生成可疑时间）', () => {
  assert.throws(() => buildStatusPayload({ gnss: gnss() }, { nowMs: 1792064000 }), TypeError);
  assert.throws(() => buildUnavailablePayload({ nowMs: 0 }), TypeError);
});
