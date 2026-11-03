'use strict';

/**
 * lib/dtu-protocol.test.js — YED DTU 协议解析单元测试
 *
 * 覆盖：CSQ 边界（0 / 31 / 99 / 非法）、SSTA 全枚举、GPS 有效与无效定位、
 * 宽松与严格格式、行清洗与有界性、以及“无证据字段不得臆造”的断言。
 * 所有坐标均为构造值，不对应真实地址。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CSQ_DBM_BASE,
  CSQ_DBM_STEP,
  SIGNAL_VALID,
  SIGNAL_UNKNOWN,
  SIGNAL_INVALID,
  GNSS_STATE_FIXED,
  GNSS_STATE_NO_FIX,
  GNSS_STATE_UNKNOWN,
  DATA_CONNECTION_QUERY_SUPPORTED,
  toResponseLines,
  parseDtuResponseLine,
  parseCsq,
  parseSsta,
  parseGpsResponseLine,
  parseGnssLines,
  parseGnssSettingsLines,
  summarizeDeviceState,
  formatUtcTimestamp
} = require('./dtu-protocol');

/* ------------------------------------------------------------ CSQ */

test('CSQ 0-31 is valid and converts to dBm with the standard formula', () => {
  for (const csq of [0, 1, 10, 15, 20, 31]) {
    const parsed = parseCsq(csq);
    assert.equal(parsed.state, SIGNAL_VALID, `csq=${csq}`);
    assert.equal(parsed.csq, csq);
    assert.equal(parsed.dbm, CSQ_DBM_BASE + CSQ_DBM_STEP * csq);
    assert.equal(parsed.raw, csq);
  }
  // 边界换算值：0 -> -113 dBm，31 -> -51 dBm。
  assert.equal(parseCsq(0).dbm, -113);
  assert.equal(parseCsq(31).dbm, -51);
  assert.equal(parseCsq('0').dbm, -113);
  assert.equal(parseCsq('31').dbm, -51);
});

test('CSQ 99 means unknown and is never treated as a strong signal', () => {
  const parsed = parseCsq(99);
  assert.equal(parsed.state, SIGNAL_UNKNOWN);
  assert.equal(parsed.raw, 99);
  assert.equal(parsed.csq, 99);
  assert.equal(parsed.dbm, null, '99 must not be converted to dBm');
  assert.equal(parsed.quality, 'UNKNOWN');
  // 必须与“20-31 强信号”明显不同，不能落到 excellent。
  assert.notEqual(parsed.quality, 'excellent');
  assert.equal(parseCsq('99').dbm, null);
});

test('out-of-range and malformed CSQ values are INVALID without dBm', () => {
  for (const value of [32, 33, 98, 100, 255, -1, 1.5, '32', 'abc', '', ' ', null, undefined, {}, [], true, NaN]) {
    const parsed = parseCsq(value);
    assert.equal(parsed.state, SIGNAL_INVALID, `value=${String(value)}`);
    assert.equal(parsed.dbm, null, `value=${String(value)}`);
    assert.equal(parsed.csq, null);
  }
});

/* ------------------------------------------------------------ SSTA */

test('SSTA enum maps to SIM / network / server conclusions with a source label', () => {
  const expectations = {
    0: { sim: false, registered: false, server: false },
    1: { sim: false, registered: false, server: false },
    2: { sim: true, registered: false, server: false },
    3: { sim: true, registered: true, server: false },
    4: { sim: true, registered: true, server: true },
    5: { sim: true, registered: true, server: false },
    6: { sim: false, registered: false, server: false }
  };
  for (const [code, expected] of Object.entries(expectations)) {
    const parsed = parseSsta(Number(code));
    assert.equal(parsed.code, Number(code));
    assert.equal(parsed.simReady, expected.sim, `ssta=${code} sim`);
    assert.equal(parsed.registered, expected.registered, `ssta=${code} registered`);
    assert.equal(parsed.serverConnected, expected.server, `ssta=${code} server`);
    assert.equal(parsed.source, 'vendor-enum:SSTA');
    assert.equal(typeof parsed.detail, 'string');
    assert.equal(parsed.detail.length > 0, true);
  }
  assert.equal(parseSsta(3).state, 'NETWORK_OK_NO_SERVER');
  assert.equal(parseSsta(4).state, 'SERVER_CONNECTED');
});

test('unknown SSTA never guesses SIM or registration state', () => {
  for (const value of [7, 9, 99, -1, 'abc', '', null, undefined, {}, []]) {
    const parsed = parseSsta(value);
    assert.equal(parsed.state, 'UNKNOWN', `value=${String(value)}`);
    assert.equal(parsed.simReady, null);
    assert.equal(parsed.registered, null);
    assert.equal(parsed.serverConnected, null);
  }
});

/* ------------------------------------------------------------ 行解析 */

test('parses config,key,status,value and rejects echoes and unknown shapes', () => {
  const parsed = parseDtuResponseLine('config,csq,ok,26');
  assert.equal(parsed.key, 'csq');
  assert.equal(parsed.status, 'ok');
  assert.deepEqual([...parsed.values], ['26']);

  assert.equal(parseDtuResponseLine('config,get,csq'), null, 'command echo must not parse as a response');
  assert.equal(parseDtuResponseLine('config,set,csq,20'), null, 'set echoes are not responses');
  assert.equal(parseDtuResponseLine('OK'), null);
  assert.equal(parseDtuResponseLine('+CSQ: 22,99'), null);
  assert.equal(parseDtuResponseLine('garbage'), null);
  assert.equal(parseDtuResponseLine(''), null);
  assert.equal(parseDtuResponseLine(null), null);
});

test('toResponseLines cleans input and separates echoes', () => {
  const { lines, echoes } = toResponseLines(
    '\u001b[31mconfig,csq,ok,26\u001b[0m\r\nconfig,get,csq\r\n\uFEFFconfig,ssta,ok,3\r\n',
    ['config,get,csq']
  );
  assert.deepEqual([...lines], ['config,csq,ok,26', 'config,ssta,ok,3']);
  assert.deepEqual([...echoes], ['config,get,csq']);
});

/* ------------------------------------------------------------ GNSS */

test('parses a valid gpsext fix with all available fields', () => {
  const parsed = parseGpsResponseLine(
    'config,gps,ok,1,E,110.1234567,N,20.1234567,0,0,184,-3.6,0,2022-11-3 2:43:51'
  );
  assert.equal(parsed.supported, true);
  assert.equal(parsed.state, GNSS_STATE_FIXED);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.latitude, 20.1234567);
  assert.equal(parsed.longitude, 110.1234567);
  assert.equal(parsed.speedKmh, 0);
  assert.equal(parsed.courseDeg, 0);
  assert.equal(parsed.altitudeM, 184);
  assert.equal(parsed.fixTimeUtc, '2022-11-03T02:43:51Z');
});

test('no fix, zero coordinates and empty fields are never reported as valid', () => {
  const noFix = parseGpsResponseLine('config,gps,ok,0,E,0,N,0,0,0,0,0,2022-11-3 2:43:51');
  assert.equal(noFix.state, GNSS_STATE_NO_FIX);
  assert.equal(noFix.valid, false);
  assert.equal(noFix.latitude, null);
  assert.equal(noFix.longitude, null);
  assert.notEqual(noFix.latitude, 0, 'invalid fix must not masquerade as (0,0)');

  const zeroWithFlagOne = parseGpsResponseLine('config,gps,ok,1,E,0,N,0,0,0,0,0,0');
  assert.equal(zeroWithFlagOne.state, GNSS_STATE_NO_FIX);
  assert.equal(zeroWithFlagOne.reason, 'invalid_coordinates');
  assert.equal(zeroWithFlagOne.valid, false);

  assert.equal(parseGpsResponseLine('config,gps,ok,1,E,,N,20.1,0,0,0,0,0'), null, 'empty field rejected');
  assert.equal(parseGpsResponseLine('config,gps,ok,0'), null);
});

test('out-of-range or non-numeric coordinates are rejected as NO_FIX', () => {
  const cases = [
    'config,gps,ok,1,E,181,N,20.1,0,0,0,0,0',
    'config,gps,ok,1,E,110.1,N,91,0,0,0,0,0',
    'config,gps,ok,1,E,abc,N,20.1,0,0,0,0,0',
    'config,gps,ok,1,E,1e9,N,20.1,0,0,0,0,0',
    'config,gps,ok,1,E,110.1,X,20.1,0,0,0,0,0',
    'config,gps,ok,1,E,110.1,N,NaN,0,0,0,0,0',
    'config,gps,ok,1,E,Infinity,N,20.1,0,0,0,0,0'
  ];
  for (const line of cases) {
    const parsed = parseGpsResponseLine(line);
    assert.equal(parsed.state, GNSS_STATE_NO_FIX, line);
    assert.equal(parsed.valid, false, line);
    assert.equal(parsed.latitude, null, line);
  }
});

test('short gps response without an explicit fix flag can only be UNKNOWN', () => {
  const parsed = parseGpsResponseLine('config,gps,ok,E,110.1234567,N,20.1234567');
  assert.equal(parsed.supported, true);
  assert.equal(parsed.state, GNSS_STATE_UNKNOWN);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.reason, 'no_explicit_fix_flag');
  assert.equal(parsed.latitude, null);
});

test('non-gps and malformed gps lines are ignored', () => {
  assert.equal(parseGpsResponseLine('config,csq,ok,26'), null);
  assert.equal(parseGpsResponseLine('config,gps,err,1,E,110,N,20'), null);
  assert.equal(parseGpsResponseLine('config,gps,ok'), null);
  assert.equal(parseGpsResponseLine(''), null);
  assert.equal(parseGpsResponseLine(null), null);
});

test('gnss window aggregation prefers a valid fix and never invents one', () => {
  const fixed = parseGnssLines([
    'config,gps,ok,0,E,0,N,0,0,0,0,0,0',
    'config,gps,ok,1,E,110.1234567,N,20.1234567,0,0,184,-3.6,0,2022-11-3 2:43:51'
  ]);
  assert.equal(fixed.state, GNSS_STATE_FIXED);
  assert.equal(fixed.valid, true);
  assert.equal(fixed.latitude, 20.1234567);
  assert.equal(fixed.longitude, 110.1234567);

  const noFix = parseGnssLines(['config,gps,ok,0,E,0,N,0,0,0,0,0,0']);
  assert.equal(noFix.state, GNSS_STATE_NO_FIX);
  assert.equal(noFix.valid, false);
  assert.equal(noFix.latitude, null);

  const none = parseGnssLines([]);
  assert.equal(none.state, GNSS_STATE_UNKNOWN);
  assert.equal(none.valid, false);
  assert.equal(parseGnssLines(null).supported, false);
  assert.equal(parseGnssLines('config,gps,ok,1,E,1,N,1,0,0,0,0,0').supported, false);
});

test('location settings parsing keeps only the enabled flag', () => {
  const enabled = parseGnssSettingsLines(['config,location,ok,1,30,1,0,0']);
  assert.equal(enabled.supported, true);
  assert.equal(enabled.enabled, true);

  const disabled = parseGnssSettingsLines(['config,location,ok,0,30,1,0,0']);
  assert.equal(disabled.enabled, false);

  const unknown = parseGnssSettingsLines(['config,location,ok,9,30']);
  assert.equal(unknown.supported, false);
  assert.equal(unknown.enabled, null);
  assert.equal(parseGnssSettingsLines(['config,get,location,2']).supported, false);
});

test('UTC timestamp formatting validates ranges strictly', () => {
  assert.equal(formatUtcTimestamp('2022-11-3 2:43:51'), '2022-11-03T02:43:51Z');
  assert.equal(formatUtcTimestamp('2024-01-09 23:59:59'), '2024-01-09T23:59:59Z');
  assert.equal(formatUtcTimestamp('2022-13-3 2:43:51'), null);
  assert.equal(formatUtcTimestamp('1999-01-01 00:00:00'), null);
  assert.equal(formatUtcTimestamp('2022-11-3 24:00:00'), null);
  assert.equal(formatUtcTimestamp('not-a-time'), null);
  assert.equal(formatUtcTimestamp(null), null);
});

/* ------------------------------------------------------------ 汇总 */

test('summarizeDeviceState labels every value with its evidence source', () => {
  const state = summarizeDeviceState([
    'config,firmwarever,ok,YED_DTU4_2.0.3',
    'config,paramver,ok,0',
    'config,csq,ok,26',
    'config,ssta,ok,3'
  ]);

  assert.equal(state.firmware, 'YED_DTU4_2.0.3');
  assert.equal(state.paramVersion, '0');
  assert.equal(state.signal.csq, 26);
  assert.equal(state.signal.dbm, -61);
  assert.equal(state.signal.state, SIGNAL_VALID);
  assert.equal(state.signal.source, 'config,get,csq');
  assert.equal(state.network.registered, true);
  assert.equal(state.network.source, 'vendor-enum:SSTA');
  assert.equal(state.sim.ready, true);
  assert.equal(state.sim.source, 'vendor-enum:SSTA');
  assert.equal(state.server.connected, false);
  assert.equal(Object.isFrozen(state), true);
});

test('fields without local evidence stay unknown, never invented', () => {
  const state = summarizeDeviceState(['config,csq,ok,26']);
  assert.equal(state.network.registered, null);
  assert.equal(state.sim.ready, null);
  assert.equal(state.sim.state, 'UNKNOWN');
  assert.equal(state.server.connected, null);
  assert.equal(state.operator.supported, false);
  assert.equal(state.operator.value, null);
  assert.equal(DATA_CONNECTION_QUERY_SUPPORTED, false);
  assert.equal(state.data.supported, false);
  assert.equal(state.data.state, 'UNKNOWN');
  assert.equal(state.data.reason, 'no_local_evidence_for_data_connection_query');
});

test('summary tolerates garbage, missing fields and oversized input', () => {
  const state = summarizeDeviceState([
    '',
    'OK',
    'config,csq,err,26',
    'YED-M100MG-B1 detected',
    `config,firmwarever,ok,${'x'.repeat(4000)}`
  ]);
  assert.equal(state.signal.csq, null, 'err responses must not be used as data');
  assert.equal(state.signal.source, null);
  assert.equal(Buffer.byteLength(state.firmware, 'utf8') <= 128, true);
  assert.equal(summarizeDeviceState(null).firmware, null);
  assert.equal(summarizeDeviceState('config,csq,ok,26').signal.csq, null);
});
