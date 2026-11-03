'use strict';

/**
 * gnss-probe-core.test.js — GNSS 只读探测核心单元测试
 *
 * 纯单元测试：不联网、不开串口、不使用账号或 PowerShell；只依赖 node:assert / node:test。
 * 坐标全部为虚构测试值，用于验证"能解析但不回显"。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GNSS_QUERY_COMMAND,
  GNSS_SETTINGS_QUERY_COMMAND,
  parseGnssLines,
  safeGnssSummaryText,
  parseGnssSettingsLines,
  safeGnssSettingsText
} = require('./gnss-probe-core');

const FIXED_LINE = 'config,gps,ok,1,E,113.9739056,N,22.6927826,0,0,184,-3.6,0,2022-11-3 2:43:51';
const NO_FIX_LINE = 'config,gps,ok,0,E,113.9739056,N,22.6927826,0,0,184,-3.6,0,2022-11-3 2:43:51';
const SHORT_LINE = 'config,gps,ok,E,110.1234567,N,20.1234567';
const ZERO_LINE = 'config,gps,ok,1,E,0,N,0,0,0,184,-3.6,0,2022-11-3 2:43:51';
const OUT_OF_RANGE_LON = 'config,gps,ok,1,E,200.5,N,22.6927826,0,0,184,-3.6,0,2022-11-3 2:43:51';
const OUT_OF_RANGE_LAT = 'config,gps,ok,1,E,113.9739056,N,120.1,0,0,184,-3.6,0,2022-11-3 2:43:51';
const BAD_DIRECTION = 'config,gps,ok,1,E,113.9739056,X,22.6927826,0,0,184,-3.6,0,2022-11-3 2:43:51';

const DEFAULTS = {
  supported: false,
  fix: 'UNKNOWN',
  hasTime: false,
  hemispheresValid: false
};

const COORDINATE_FRAGMENTS = ['113.9739056', '22.6927826', '110.1234567', '20.1234567', '113.97', '22.69'];

function assertNoCoordinates(value) {
  const text = String(value);
  for (const fragment of COORDINATE_FRAGMENTS) {
    assert.equal(text.includes(fragment), false, `leaked coordinate fragment: ${fragment}`);
  }
}

test('exposes the fixed read-only query command', () => {
  assert.equal(GNSS_QUERY_COMMAND, 'config,get,gpsext');
});

test('parses a real-style extended FIXED response', () => {
  const summary = parseGnssLines([FIXED_LINE]);
  assert.deepEqual(summary, { supported: true, fix: 'FIXED', hasTime: true, hemispheresValid: true });
  assert.equal(Object.isFrozen(summary), true);
});

test('treats an explicit flag=0 as NO_FIX', () => {
  assert.deepEqual(parseGnssLines([NO_FIX_LINE]), {
    supported: true,
    fix: 'NO_FIX',
    hasTime: true,
    hemispheresValid: true
  });
});

test('never marks zero or out-of-range coordinates as FIXED', () => {
  const zero = parseGnssLines([ZERO_LINE]);
  assert.equal(zero.supported, true);
  assert.equal(zero.fix, 'NO_FIX');
  assert.equal(zero.hemispheresValid, true);

  assert.equal(parseGnssLines([OUT_OF_RANGE_LON]).fix, 'NO_FIX');
  assert.equal(parseGnssLines([OUT_OF_RANGE_LAT]).fix, 'NO_FIX');
});

test('rejects invalid hemisphere tokens and unrecognized payload shapes', () => {
  assert.deepEqual(parseGnssLines([BAD_DIRECTION]), {
    supported: true,
    fix: 'NO_FIX',
    hasTime: true,
    hemispheresValid: false
  });

  // 首字段既不是 E/W 也不是 0/1：整行不可识别，不能算 supported。
  assert.deepEqual(parseGnssLines(['config,gps,ok,X,113.9739056,N,22.6927826']), DEFAULTS);
});

test('treats a short gps response as supported but never FIXED', () => {
  assert.deepEqual(parseGnssLines([SHORT_LINE]), {
    supported: true,
    fix: 'UNKNOWN',
    hasTime: false,
    hemispheresValid: true
  });
});

test('ignores command echoes and unknown responses', () => {
  assert.deepEqual(parseGnssLines(['config,get,gpsext', 'config,get,gps', 'config,gps,ok']), DEFAULTS);
  assert.deepEqual(parseGnssLines(['AT+CGNSINF', 'garbage', '']), DEFAULTS);
});

test('uses best evidence across multiple responses', () => {
  assert.equal(parseGnssLines([NO_FIX_LINE, FIXED_LINE]).fix, 'FIXED');
  assert.equal(parseGnssLines([FIXED_LINE, NO_FIX_LINE]).fix, 'FIXED');
  assert.equal(parseGnssLines([FIXED_LINE, 'garbage']).fix, 'FIXED');
  assert.equal(parseGnssLines([NO_FIX_LINE, NO_FIX_LINE]).fix, 'NO_FIX');
  assert.equal(parseGnssLines([SHORT_LINE, NO_FIX_LINE]).fix, 'NO_FIX');
  assert.equal(parseGnssLines([SHORT_LINE, FIXED_LINE]).hasTime, true);
});

test('is total and bounded for malformed, oversized and non-array input', () => {
  const weird = [
    undefined,
    null,
    42,
    'config,gps,ok,E,1,N,2',
    {},
    [null],
    ['', 'garbage'],
    new Array(10000).fill(SHORT_LINE)
  ];
  for (const value of weird) {
    let summary;
    assert.doesNotThrow(() => { summary = parseGnssLines(value); });
    assert.equal(typeof summary.fix, 'string');
    assert.equal(typeof summary.supported, 'boolean');
    assert.equal(Object.isFrozen(summary), true);
  }

  // 字符串不是数组：不解析。
  assert.deepEqual(parseGnssLines('config,gps,ok,E,1,N,2'), DEFAULTS);
  // 超长单行：清洗后有界，且首字段不可识别，不误判。
  assert.deepEqual(parseGnssLines([`config,gps,ok,${'9'.repeat(100000)}`]), DEFAULTS);
  // 未知定位标记：忽略。
  assert.deepEqual(parseGnssLines(['config,gps,ok,2,E,113.9,N,22.6']), DEFAULTS);
  // 扩展形态字段不足：忽略。
  assert.deepEqual(parseGnssLines(['config,gps,ok,1,E']), DEFAULTS);
});

test('never returns or echoes coordinates in the summary', () => {
  const summary = parseGnssLines([FIXED_LINE, SHORT_LINE]);
  assert.deepEqual(Object.keys(summary).sort(), ['fix', 'hasTime', 'hemispheresValid', 'supported']);
  assertNoCoordinates(JSON.stringify(summary));
  assertNoCoordinates(Object.values(summary).join(' '));
});

test('renders only fixed enum text without coordinates', () => {
  assert.equal(safeGnssSummaryText(parseGnssLines(['config,get,gpsext'])), 'GNSS: UNSUPPORTED');
  assert.equal(safeGnssSummaryText(parseGnssLines([FIXED_LINE])), 'GNSS: FIXED TIME=YES HEMISPHERES=OK');
  assert.equal(safeGnssSummaryText(parseGnssLines([NO_FIX_LINE])), 'GNSS: NO_FIX');
  assert.equal(safeGnssSummaryText(parseGnssLines([SHORT_LINE])), 'GNSS: UNKNOWN');
  assert.equal(
    safeGnssSummaryText(parseGnssLines(['config,gps,ok,1,E,113.9739056,N,22.6927826,0'])),
    'GNSS: FIXED TIME=NO HEMISPHERES=OK'
  );

  for (const value of [undefined, null, 42, 'text', {}, { supported: true }, [], new Map()]) {
    let out;
    assert.doesNotThrow(() => { out = safeGnssSummaryText(value); });
    assert.equal(typeof out, 'string');
    assert.equal(/\d/.test(out), false);
  }
});

test('safeGnssSummaryText never echoes coordinate-looking fields from a forged summary', () => {
  const forged = {
    supported: true,
    fix: 'FIXED',
    hasTime: true,
    hemispheresValid: true,
    longitude: '113.9739056',
    latitude: '22.6927826',
    raw: FIXED_LINE
  };
  const text = safeGnssSummaryText(forged);
  assertNoCoordinates(text);
  assert.equal(text.includes('config,gps'), false);
  assert.equal(text.includes('config,gps,ok'), false);
});

/* ------------------------------------------------------------ GPS 配置状态 */

const SETTINGS_ENABLED_LINE = 'config,location,ok,1,60,1,0,0';
const SETTINGS_DISABLED_LINE = 'config,location,ok,0,0,0,0,0';
const SETTINGS_DEFAULTS = { supported: false, enabled: 'UNKNOWN' };

test('exposes the fixed GPS settings query command', () => {
  assert.equal(GNSS_SETTINGS_QUERY_COMMAND, 'config,get,location,2');
});

test('parses GPS settings enabled/disabled and freezes the result', () => {
  const enabled = parseGnssSettingsLines([SETTINGS_ENABLED_LINE]);
  assert.deepEqual(enabled, { supported: true, enabled: 'ENABLED' });
  assert.equal(Object.isFrozen(enabled), true);

  const disabled = parseGnssSettingsLines([SETTINGS_DISABLED_LINE]);
  assert.deepEqual(disabled, { supported: true, enabled: 'DISABLED' });
  assert.equal(Object.isFrozen(disabled), true);
});

test('ignores malformed, echoed and unrecognized GPS settings lines', () => {
  assert.deepEqual(parseGnssSettingsLines(['config,get,location,2']), SETTINGS_DEFAULTS);
  assert.deepEqual(parseGnssSettingsLines(['config,location,ok,2,0,0']), SETTINGS_DEFAULTS);
  assert.deepEqual(parseGnssSettingsLines(['config,location,ok']), SETTINGS_DEFAULTS);
  assert.deepEqual(parseGnssSettingsLines(['config,location,ok,']), SETTINGS_DEFAULTS);
  assert.deepEqual(parseGnssSettingsLines(['config,gps,ok,1,E,113.9,N,22.6']), SETTINGS_DEFAULTS);
  assert.deepEqual(parseGnssSettingsLines([]), SETTINGS_DEFAULTS);
});

test('uses best evidence across multiple GPS settings responses', () => {
  assert.equal(parseGnssSettingsLines([SETTINGS_DISABLED_LINE, SETTINGS_ENABLED_LINE]).enabled, 'ENABLED');
  assert.equal(parseGnssSettingsLines([SETTINGS_ENABLED_LINE, SETTINGS_DISABLED_LINE]).enabled, 'ENABLED');
  assert.equal(parseGnssSettingsLines([SETTINGS_DISABLED_LINE, SETTINGS_DISABLED_LINE]).enabled, 'DISABLED');
  assert.equal(parseGnssSettingsLines(['config,get,location,2', SETTINGS_DISABLED_LINE]).enabled, 'DISABLED');
});

test('is total and bounded for GPS settings input', () => {
  const weird = [undefined, null, 42, 'config,location,ok,1', {}, [null], ['', 'garbage']];
  for (const value of weird) {
    let summary;
    assert.doesNotThrow(() => { summary = parseGnssSettingsLines(value); });
    assert.equal(typeof summary.enabled, 'string');
    assert.equal(typeof summary.supported, 'boolean');
    assert.equal(Object.isFrozen(summary), true);
  }

  // 字符串不是数组：不解析。
  assert.deepEqual(parseGnssSettingsLines('config,location,ok,1'), SETTINGS_DEFAULTS);
  // 超长单行：清洗后有界，首字段不可识别，不误判。
  assert.deepEqual(parseGnssSettingsLines([`config,location,ok,${'1'.repeat(100000)}`]), SETTINGS_DEFAULTS);
  // 超多行：有界处理。
  assert.deepEqual(
    parseGnssSettingsLines(new Array(10000).fill(SETTINGS_ENABLED_LINE)),
    { supported: true, enabled: 'ENABLED' }
  );
});

test('never leaks GPS settings tail fields or the raw line', () => {
  const line = 'config,location,ok,1,60,3,PERIOD_MARKER,CHANNEL_MARKER';
  const summary = parseGnssSettingsLines([line]);
  assert.deepEqual(summary, { supported: true, enabled: 'ENABLED' });
  assert.deepEqual(Object.keys(summary).sort(), ['enabled', 'supported']);

  const json = JSON.stringify(summary);
  for (const fragment of ['60', '3', 'PERIOD_MARKER', 'CHANNEL_MARKER', 'config,location', line]) {
    assert.equal(json.includes(fragment), false, `leaked settings fragment: ${fragment}`);
  }
});

test('renders fixed GPS settings text without echoing input', () => {
  assert.equal(safeGnssSettingsText(parseGnssSettingsLines([])), 'GNSS SETTINGS: UNSUPPORTED');
  assert.equal(safeGnssSettingsText(parseGnssSettingsLines([SETTINGS_ENABLED_LINE])), 'GNSS SETTINGS: ENABLED');
  assert.equal(safeGnssSettingsText(parseGnssSettingsLines([SETTINGS_DISABLED_LINE])), 'GNSS SETTINGS: DISABLED');
  assert.equal(safeGnssSettingsText({ supported: true, enabled: 'WEIRD' }), 'GNSS SETTINGS: UNKNOWN');

  for (const value of [undefined, null, 42, 'text', {}, [], new Map()]) {
    let out;
    assert.doesNotThrow(() => { out = safeGnssSettingsText(value); });
    assert.equal(typeof out, 'string');
    assert.equal(/\d/.test(out), false);
    assert.equal(out.includes('config'), false);
  }

  const forged = {
    supported: true,
    enabled: 'ENABLED',
    raw: 'config,location,ok,1,60,3',
    channel: 'CHANNEL_MARKER'
  };
  const text = safeGnssSettingsText(forged);
  assert.equal(text, 'GNSS SETTINGS: ENABLED');
  assert.equal(text.includes('CHANNEL_MARKER'), false);
  assert.equal(text.includes('config'), false);
});
