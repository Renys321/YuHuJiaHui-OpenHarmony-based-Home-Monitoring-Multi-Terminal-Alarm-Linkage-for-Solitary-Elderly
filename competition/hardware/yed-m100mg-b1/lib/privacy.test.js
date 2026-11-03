'use strict';

/**
 * lib/privacy.test.js — 统一脱敏单元测试
 *
 * 覆盖：ICCID / IMSI / IMEI / 手机号 / 设备密钥、Error 对象、
 * 对象与循环引用、超长与畸形输入、以及“任何输出都不含完整标识”的强断言。
 * 测试中使用的标识全部是**合成值**，不对应任何真实设备或账号。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_SANITIZED_BYTES,
  MAX_VALUE_BYTES,
  sanitizeLine,
  redactValue,
  redactLine,
  deepRedact,
  safeJsonStringify,
  boundText,
  registerSensitiveValue,
  resetSensitiveValues
} = require('./privacy');

/* 合成测试值（非真实设备标识）。 */
const SYNTH_ICCID = '89860012345678901234';
const SYNTH_IMSI = '310150123456789';
const SYNTH_IMEI = '867726031234567';
const SYNTH_PHONE = '13800138000';
const SYNTH_TOKEN = 'AbCdEf0123456789AbCdEf0123456789';

function assertNoLeak(text, secret) {
  assert.equal(typeof text, 'string');
  assert.equal(text.includes(secret), false, `leaked secret: ${secret}`);
}

/* ------------------------------------------------------------ 单值 / 单行 */

test('redactValue keeps only class, length class and last 4 digits', () => {
  const iccid = redactValue('iccid', SYNTH_ICCID);
  assertNoLeak(iccid, SYNTH_ICCID);
  assert.match(iccid, /^<redacted,iccid,length=20,last4=1234>$/);

  const imsi = redactValue('imsi', SYNTH_IMSI);
  assertNoLeak(imsi, SYNTH_IMSI);
  assert.match(imsi, /length=15,last4=6789/);

  const imei = redactValue('IMEI', SYNTH_IMEI);
  assertNoLeak(imei, SYNTH_IMEI);
  assert.match(imei, /^<redacted,imei,length=15,last4=4567>$/);

  const phone = redactValue('phone', SYNTH_PHONE);
  assertNoLeak(phone, SYNTH_PHONE);
  assert.match(phone, /^<redacted,phone,length=11,last4=8000>$/);
});

test('secrets are never partially exposed, not even the last 4 characters', () => {
  const secret = redactValue('deviceToken', SYNTH_TOKEN);
  assertNoLeak(secret, SYNTH_TOKEN);
  assertNoLeak(secret, SYNTH_TOKEN.slice(-4));
  assert.match(secret, /^<redacted,secret,length=32>$/);

  for (const key of ['password', 'appSecret', 'apiKey', 'accessKey', 'psk', 'privateKey']) {
    const value = redactValue(key, 'hunter2-secret-value');
    assertNoLeak(value, 'hunter2-secret-value');
    assert.match(value, /^<redacted,secret,length=\d+>$/);
  }
});

test('short or empty identifiers degrade to whole-value redaction', () => {
  assert.equal(redactValue('imei', '123'), '<redacted,imei>');
  assert.equal(redactValue('imei', ''), '<redacted,imei,empty>');
  assert.equal(redactValue('imei', null), '<redacted,imei,empty>');
  assert.equal(redactValue('imei', undefined), '<redacted,imei,empty>');
});

test('redacts YED config identifier responses and keyed forms', () => {
  for (const line of [
    `config,imei,ok,${SYNTH_IMEI}`,
    `config,iccid,ok,${SYNTH_ICCID}`,
    `config , imsi , ok , ${SYNTH_IMSI}`,
    `IMEI: ${SYNTH_IMEI}`,
    `imei=${SYNTH_IMEI}`,
    `"imei":"${SYNTH_IMEI}"`,
    `iccid ${SYNTH_ICCID}`,
    `+8613800138000`,
    `call ${SYNTH_PHONE} now`,
    `mobile: ${SYNTH_PHONE}`
  ]) {
    const out = redactLine(line);
    for (const secret of [SYNTH_IMEI, SYNTH_ICCID, SYNTH_IMSI, SYNTH_PHONE, '8613800138000']) {
      assertNoLeak(out, secret);
    }
    assert.match(out, /<redacted/);
  }
});

test('redacts secrets in keyed text without echoing any part of the value', () => {
  const out = redactLine(`token=${SYNTH_TOKEN} password: hunter2-secret-value`);
  assertNoLeak(out, SYNTH_TOKEN);
  assertNoLeak(out, 'hunter2-secret-value');
  // 值必须被替换为占位符，而不是保留任何原文字符。
  assert.match(out, /token=<redacted,secret,length=32>/);
  assert.match(out, /password: <redacted,secret,length=20>/);
  assert.equal(out.includes('AbCd'), false);
  assert.equal(out.includes('hunter2'), false);
});

test('does not mangle non-sensitive diagnostic lines', () => {
  for (const line of [
    'config,firmwarever,ok,YED_DTU4_2.0.3',
    'config,csq,ok,26',
    'config,ssta,ok,3',
    'config,gps,ok,1,E,110.1234567,N,20.1234567,0,0,184,-3.6,0,2022-11-3 2:43:51',
    'AT+CSQ',
    '+CSQ: 22,99'
  ]) {
    assert.equal(redactLine(line), line);
  }
});

test('registered real values are masked even when they appear in context', () => {
  resetSensitiveValues();
  try {
    assert.equal(registerSensitiveValue(SYNTH_IMEI), true);
    const out = redactLine(`device says ${SYNTH_IMEI} online`);
    assertNoLeak(out, SYNTH_IMEI);
    assert.match(out, /registered-value/);
    // 太短的值不登记，避免误伤正常文本。
    assert.equal(registerSensitiveValue('12'), false);
  } finally {
    resetSensitiveValues();
  }
});

/* ------------------------------------------------------------ 清洗 / 有界 */

test('sanitizeLine strips ANSI and control characters and is total', () => {
  assert.equal(sanitizeLine('\u001b[31mERROR\u001b[0m'), 'ERROR');
  assert.equal(sanitizeLine('a\u0000b\r\nc'), 'abc');
  assert.equal(sanitizeLine('  spaced  '), 'spaced');
  for (const value of [undefined, null, 0, 1, true, {}, [], Symbol('x'), () => {}]) {
    assert.equal(sanitizeLine(value), '');
    assert.equal(redactLine(value), '');
  }
});

test('bounds output bytes without splitting multibyte characters', () => {
  assert.equal(sanitizeLine('a'.repeat(100000)).length, MAX_SANITIZED_BYTES);
  const cjk = sanitizeLine('中'.repeat(300));
  assert.equal(Buffer.byteLength(cjk, 'utf8') <= MAX_SANITIZED_BYTES, true);
  assert.equal(boundText('x'.repeat(100000), 32).length, 32);
  const redacted = redactLine('y'.repeat(100000));
  assert.equal(Buffer.byteLength(redacted, 'utf8') <= MAX_VALUE_BYTES, true);
});

/* ------------------------------------------------------------ 深度脱敏 */

test('deepRedact cleans nested identifiers, secrets and errors', () => {
  const error = new Error(`failed while reading ${SYNTH_IMEI} from ${SYNTH_ICCID}`);
  error.code = 'E_DEVICE';
  const input = {
    imei: SYNTH_IMEI,
    nested: {
      iccid: SYNTH_ICCID,
      list: [SYNTH_IMSI, { phone: SYNTH_PHONE }],
      token: SYNTH_TOKEN
    },
    message: `raw ${SYNTH_ICCID}`,
    error
  };
  const output = deepRedact(input);
  const serialized = JSON.stringify(output);
  for (const secret of [SYNTH_IMEI, SYNTH_ICCID, SYNTH_IMSI, SYNTH_PHONE, SYNTH_TOKEN]) {
    assertNoLeak(serialized, secret);
  }
  assert.equal(output.nested.token, '<redacted,secret>');
  assert.equal(output.error.name, 'Error');
  assert.equal(output.error.code, 'E_DEVICE');
  assert.match(output.error.message, /<redacted/);
  assert.match(output.error.stack, /<redacted/);
  assertNoLeak(output.error.stack, SYNTH_IMEI);
});

test('deepRedact is total for cycles, depth, exotic values and huge objects', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  const output = deepRedact(cyclic);
  assert.equal(output.self, '<redacted,circular>');
  assert.equal(output.name, 'root');

  let deep = { value: 1 };
  for (let index = 0; index < 40; index += 1) deep = { nested: deep };
  assert.doesNotThrow(() => deepRedact(deep));

  const withFunctions = deepRedact({ fn: () => {}, sym: Symbol('x'), big: 10n, date: new Date(0) });
  assert.equal(withFunctions.fn, '<redacted,function>');
  assert.equal(withFunctions.sym, '<redacted,symbol>');
  assert.equal(withFunctions.big, '10');

  const huge = {};
  for (let index = 0; index < 5000; index += 1) huge[`k${index}`] = index;
  const bounded = deepRedact(huge);
  const size = Object.keys(bounded).length;
  assert.equal(size > 0 && size <= 600, true);
});

test('safeJsonStringify always returns valid JSON and never leaks', () => {
  const text = safeJsonStringify({ imei: SYNTH_IMEI, error: new Error(SYNTH_ICCID) });
  assertNoLeak(text, SYNTH_IMEI);
  assertNoLeak(text, SYNTH_ICCID);
  assert.doesNotThrow(() => JSON.parse(text));

  const cyclic = {};
  cyclic.self = cyclic;
  const cyclicText = safeJsonStringify(cyclic);
  assert.doesNotThrow(() => JSON.parse(cyclicText));

  assert.equal(typeof safeJsonStringify(() => {}), 'string');
});
