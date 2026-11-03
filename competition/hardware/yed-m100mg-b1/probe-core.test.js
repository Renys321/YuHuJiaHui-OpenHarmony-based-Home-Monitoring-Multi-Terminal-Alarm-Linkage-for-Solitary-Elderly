'use strict';

/**
 * probe-core.test.js — YED-M100MG-B1 探测核心单元测试
 *
 * 纯单元测试：不联网、不开串口、不使用账号或 PowerShell；只依赖 node:assert / node:test。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildProbeCommands,
  sanitizeResponseLine,
  redactSensitiveLine,
  summarizeProbeLines,
  MAX_SANITIZED_BYTES,
  MAX_SUMMARY_VALUE_BYTES
} = require('./probe-core');

const DEFAULT_COMMANDS = [
  'config,get,firmwarever',
  'config,get,csq',
  'config,get,ssta',
  'config,get,paramver'
];

/* ------------------------------------------------------------ 命令白名单 */

test('builds the default probe commands in order and freezes them', () => {
  const commands = buildProbeCommands();
  assert.deepEqual([...commands], DEFAULT_COMMANDS);
  assert.equal(Object.isFrozen(commands), true);
  assert.throws(() => commands.push('config,get,imei'), TypeError);
  assert.throws(() => { commands[0] = 'config,get,imei'; }, TypeError);
  assert.notEqual(buildProbeCommands(), buildProbeCommands());
});

test('only an explicit true appends identifier commands', () => {
  assert.deepEqual([...buildProbeCommands(false)], DEFAULT_COMMANDS);
  assert.deepEqual([...buildProbeCommands()], DEFAULT_COMMANDS);
  assert.deepEqual([...buildProbeCommands(undefined)], DEFAULT_COMMANDS);
  assert.deepEqual([...buildProbeCommands(1)], DEFAULT_COMMANDS);
  assert.deepEqual([...buildProbeCommands('true')], DEFAULT_COMMANDS);
  assert.deepEqual([...buildProbeCommands({})], DEFAULT_COMMANDS);

  const withIdentifiers = buildProbeCommands(true);
  assert.deepEqual([...withIdentifiers], [
    ...DEFAULT_COMMANDS,
    'config,get,imei',
    'config,get,iccid'
  ]);
  assert.equal(Object.isFrozen(withIdentifiers), true);
});

/* ------------------------------------------------------------ 清洗 */

test('sanitizeResponseLine is total for any input', () => {
  const weird = [undefined, null, 0, 1, true, {}, [], Symbol('x'), () => {}, new String('a')];
  for (const value of weird) {
    let result;
    assert.doesNotThrow(() => { result = sanitizeResponseLine(value); });
    assert.equal(result, '');
  }
});

test('strips ANSI, CR/LF, NUL and other control characters', () => {
  assert.equal(sanitizeResponseLine('\u001b[31mERROR\u001b[0m'), 'ERROR');
  assert.equal(sanitizeResponseLine('\u001b]0;title\u0007cmd'), 'cmd');
  assert.equal(sanitizeResponseLine('\u009b2Jclear'), 'clear');
  assert.equal(sanitizeResponseLine('a\u0000b\r\nc'), 'abc');
  assert.equal(sanitizeResponseLine('line\u007F'), 'line');
  assert.equal(sanitizeResponseLine('  spaced  '), 'spaced');
  assert.equal(sanitizeResponseLine('\u001b[2J\u0000  ok  \r\n'), 'ok');

  const nasty = '\u001b[31m中\u0000\r\n\u001b]0;x\u0007\u009b2J';
  const cleaned = sanitizeResponseLine(nasty);
  assert.equal(cleaned, '中');
  assert.equal(/[\u0000-\u001F\u007F-\u009F]/.test(cleaned), false);
  assert.equal(cleaned.includes('\u001b'), false);
});

test('bounds UTF-8 output without splitting multibyte characters', () => {
  assert.equal(sanitizeResponseLine('a'.repeat(100000)).length, MAX_SANITIZED_BYTES);

  const cjk = sanitizeResponseLine('中'.repeat(300));
  assert.equal(cjk, '中'.repeat(170));
  assert.equal(Buffer.byteLength(cjk, 'utf8') <= MAX_SANITIZED_BYTES, true);

  const boundary = sanitizeResponseLine(`${'a'.repeat(511)}中`);
  assert.equal(boundary, 'a'.repeat(511));
  assert.equal(Buffer.byteLength(boundary, 'utf8'), 511);

  // 畸形输入（孤立代理项）必须有界且不抛异常。
  const lone = sanitizeResponseLine('\uD800\uDFFF'.repeat(200));
  assert.equal(typeof lone, 'string');
  assert.equal(Buffer.byteLength(lone, 'utf8') <= MAX_SANITIZED_BYTES, true);
});

/* ------------------------------------------------------------ 脱敏 */

test('redacts config identifier responses and never echoes the full value', () => {
  const imei = '867726031234567';
  const iccid = '89860012345678901234';
  const imsi = '310150123456789';

  const redactedImei = redactSensitiveLine(`config,imei,ok,${imei}`);
  assert.equal(redactedImei.includes(imei), false);
  assert.equal(redactedImei, 'config,imei,ok,<redacted,last4=4567>');

  const redactedIccid = redactSensitiveLine(`config,iccid,ok,${iccid}`);
  assert.equal(redactedIccid.includes(iccid), false);
  assert.equal(redactedIccid.includes('<redacted,last4=1234>'), true);

  const redactedImsi = redactSensitiveLine(`config,imsi,ok,${imsi}`);
  assert.equal(redactedImsi.includes(imsi), false);
  assert.equal(redactedImsi.includes('<redacted,last4=6789>'), true);
});

test('redacts keyed and bare phone numbers', () => {
  const phone = '13800138000';

  const keyed = redactSensitiveLine(`config,tel,ok,${phone}`);
  assert.equal(keyed.includes(phone), false);
  assert.equal(keyed.includes('<redacted,last4=8000>'), true);

  const bare = redactSensitiveLine(`call ${phone} now`);
  assert.equal(bare.includes(phone), false);
  assert.equal(bare.includes('<redacted'), true);

  const e164 = redactSensitiveLine('+8613800138000');
  assert.equal(e164.includes('8613800138000'), false);
  assert.equal(e164.includes('<redacted'), true);
});

test('handles case, whitespace and malformed sensitive fields conservatively', () => {
  const imei = '867726031234567';

  for (const line of [
    `IMEI: ${imei}`,
    `imei=${imei}`,
    `config , imei , ok , ${imei}`,
    `config,IMEI,ok,${imei}`
  ]) {
    const out = redactSensitiveLine(line);
    assert.equal(out.includes(imei), false, `full identifier leaked for: ${line}`);
    assert.equal(out.includes('<redacted'), true);
  }

  // 长度不足 5 位的"标识"不得保留后 4 位（那等于完整回显）。
  assert.equal(redactSensitiveLine('config,imei,ok,1234'), 'config,imei,ok,<redacted>');

  // 无法识别的敏感值整值替换。
  assert.equal(redactSensitiveLine('imei: unknown'), 'imei: <redacted>');
});

test('does not touch non-sensitive lines and is total for any input', () => {
  assert.equal(redactSensitiveLine('config,firmwarever,ok,Y100E_V1.2.3'), 'config,firmwarever,ok,Y100E_V1.2.3');
  assert.equal(redactSensitiveLine('config,csq,ok,23'), 'config,csq,ok,23');
  assert.equal(redactSensitiveLine('config,paramver,ok,param-7'), 'config,paramver,ok,param-7');

  for (const value of [undefined, null, 42, {}, [], true, Symbol('x')]) {
    assert.equal(redactSensitiveLine(value), '');
  }
});

/* ------------------------------------------------------------ 安全摘要 */

test('summarizes only the known safe fields and freezes the result', () => {
  const summary = summarizeProbeLines([
    'config,firmwarever,ok,Y100E_V1.2.3',
    'config,csq,ok,23',
    'config,ssta,ok,1',
    'config,paramver,ok,param-7',
    'AT+CGMR',
    '',
    'config,unknown,ok,value'
  ]);

  assert.deepEqual(summary, {
    firmware: 'Y100E_V1.2.3',
    csq: '23',
    registration: '1',
    paramVersion: 'param-7'
  });
  assert.equal(Object.isFrozen(summary), true);
  assert.deepEqual(Object.keys(summary).sort(), ['csq', 'firmware', 'paramVersion', 'registration']);
});

test('never guesses model, SIM registration or GNSS capability', () => {
  const summary = summarizeProbeLines([
    'config,model,ok,M100MG-B1',
    'YED-M100MG-B1 detected',
    'GNSS: fixed',
    'SIM registered',
    'config,csq,99'
  ]);

  assert.deepEqual(Object.keys(summary).sort(), ['csq']);
  assert.equal(summary.csq, '99');
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'model'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'gnss'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'simRegistered'), false);
});

test('ignores command echoes, unknown lines and non-array input', () => {
  assert.deepEqual(summarizeProbeLines(['config,get,firmwarever', 'config,get,csq', 'garbage', '']), {});
  assert.deepEqual(summarizeProbeLines([]), {});
  assert.deepEqual(summarizeProbeLines('config,csq,ok,23'), {});
  assert.deepEqual(summarizeProbeLines(null), {});
  assert.equal(Object.isFrozen(summarizeProbeLines(null)), true);
});

test('sanitizes summary values and bounds their size', () => {
  const summary = summarizeProbeLines(['config,csq,ok,\u001b[31m23\u001b[0m']);
  assert.equal(summary.csq, '23');

  const long = summarizeProbeLines([`config,firmwarever,ok,${'x'.repeat(500)}`]);
  assert.equal(Buffer.byteLength(long.firmware, 'utf8'), MAX_SUMMARY_VALUE_BYTES);

  // 已脱敏的标识符不会进入摘要，也不会泄漏原值。
  const redacted = summarizeProbeLines(['config,imei,ok,<redacted,last4=4567>']);
  assert.deepEqual(redacted, {});
});
