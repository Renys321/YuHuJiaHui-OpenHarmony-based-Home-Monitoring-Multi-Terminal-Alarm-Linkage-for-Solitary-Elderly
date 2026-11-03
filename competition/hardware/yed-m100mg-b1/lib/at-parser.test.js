'use strict';

/**
 * lib/at-parser.test.js — 通用 3GPP AT 回包解析框架单元测试
 *
 * 边界声明：lib/at-parser.js 是“通用框架”，本项目本地资料中没有 AT 证据，
 * 该模块不是 YED-M100MG-B1 的驱动。本文件只验证解析逻辑，不发送任何 AT 命令、
 * 不打开串口、不访问网络、不写文件（仅只读 fixtures/at-standard.fixture）。
 *
 * 已知偏差（BUG-1，见文件末尾说明）：
 *   模块注释（lib/at-parser.js:139-140）称“无 <stat> 字段时返回 state UNKNOWN”，
 *   但实现把单字段回包当作 <stat>（3GPP URC `+CREG: <stat>` 语义），
 *   因此 `+CEREG: 2` 得到 SEARCHING、`+CREG: 1` 得到 REGISTERED。
 *   这里固定**真实行为**并显式标注，而不是写一条必然失败的断言。
 */

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const {
  AT_PROBE_BLOCKED,
  MAX_LINES,
  MAX_LINE_BYTES,
  SIGNAL_INVALID,
  SIGNAL_UNKNOWN,
  SIGNAL_VALID,
  stripBom,
  toAtLines,
  parseFinalResult,
  extractInformational,
  parseCpinLine,
  parseRegistrationLine,
  parseCsqLine,
  parseCopsLine,
  parseAtResponse
} = require('./at-parser');

/* ------------------------------------------------------------ 阻塞说明 */

test('AT_PROBE_BLOCKED documents the no-AT-evidence blocking condition', () => {
  assert.equal(AT_PROBE_BLOCKED.blocked, true);
  assert.equal(AT_PROBE_BLOCKED.code, 'NO_LOCAL_AT_EVIDENCE');
  assert.equal(typeof AT_PROBE_BLOCKED.reason, 'string');
  assert.equal(typeof AT_PROBE_BLOCKED.action, 'string');
  assert.match(AT_PROBE_BLOCKED.reason, /no AT command set/i);
  assert.match(AT_PROBE_BLOCKED.action, /Do not send AT commands/i);
  assert.equal(Object.isFrozen(AT_PROBE_BLOCKED), true);
  // 冻结：任何试图解除阻塞的写入都必须失败。
  assert.throws(() => {
    AT_PROBE_BLOCKED.blocked = false;
  }, TypeError);

  // 每个解析结果都携带该阻塞标记，未取得证据前不得据此发送 AT 命令。
  const parsed = parseAtResponse(['OK']);
  assert.equal(parsed.blocked, AT_PROBE_BLOCKED);
  assert.equal(parsed.blocked.blocked, true);
});

/* ------------------------------------------------------------ 行清洗 */

test('stripBom removes only a leading UTF-8 BOM', () => {
  assert.equal(stripBom('\uFEFF+CPIN: READY'), '+CPIN: READY');
  assert.equal(stripBom('+CPIN: READY'), '+CPIN: READY');
  assert.equal(stripBom('\uFEFF'), '');
});

test('toAtLines strips BOM, splits CRLF/LF/CR and cleans ANSI/control chars', () => {
  assert.deepEqual(toAtLines('\uFEFF+CPIN: READY\r\nOK'), ['+CPIN: READY', 'OK']);
  assert.deepEqual(toAtLines('A\r\nB\nC\rD'), ['A', 'B', 'C', 'D']);
  assert.deepEqual(toAtLines('\u001B[31m+CSQ: 22,99\u001B[0m'), ['+CSQ: 22,99']);
  assert.deepEqual(toAtLines('\u009B1mOK'), ['OK']);
  assert.deepEqual(toAtLines('OK\u0000\u0007'), ['OK']);
  assert.deepEqual(toAtLines('  +CREG: 0,1  '), ['+CREG: 0,1']);
});

test('toAtLines dedupes identical lines and returns a frozen array', () => {
  const lines = toAtLines('OK\nOK\n OK \r\nOK');
  assert.deepEqual(lines, ['OK']);
  assert.equal(Object.isFrozen(lines), true);
});

test('toAtLines bounds the line count and the bytes per line', () => {
  const many = Array.from({ length: MAX_LINES * 3 }, (_, index) => `L${index}`).join('\n');
  const lines = toAtLines(many);
  assert.equal(lines.length, MAX_LINES);
  assert.equal(lines[0], 'L0');
  assert.equal(lines[MAX_LINES - 1], `L${MAX_LINES - 1}`);

  const single = toAtLines('X'.repeat(MAX_LINE_BYTES * 4));
  assert.equal(single.length, 1);
  assert.ok(Buffer.byteLength(single[0], 'utf8') <= MAX_LINE_BYTES);

  // 多字节字符不得被从中间切断。
  const wide = toAtLines('宽'.repeat(400));
  assert.ok(Buffer.byteLength(wide[0], 'utf8') <= MAX_LINE_BYTES);
  assert.equal(wide[0].includes('\uFFFD'), false);
});

test('toAtLines never throws on non-string or hostile input', () => {
  assert.deepEqual(toAtLines(undefined), []);
  assert.deepEqual(toAtLines(null), []);
  assert.deepEqual(toAtLines(''), []);
  assert.deepEqual(toAtLines(42), ['42']);
  assert.deepEqual(
    toAtLines({
      toString() {
        throw new Error('boom');
      }
    }),
    []
  );
});

/* ------------------------------------------------------------ 最终结果码 */

test('parseFinalResult maps OK/ERROR case-insensitively and ignores everything else', () => {
  for (const value of ['OK', 'OK ', ' ok ', 'ok']) {
    assert.equal(parseFinalResult(value), 'OK', value);
  }
  for (const value of ['ERROR', 'error', ' Error ']) {
    assert.equal(parseFinalResult(value), 'ERROR', value);
  }
  for (const value of ['OKAY', '+CSQ: 1', 'RING', '', '   ', undefined, null, 42]) {
    assert.equal(parseFinalResult(value), null, String(value));
  }
});

/* ------------------------------------------------------------ payload 提取 */

test('extractInformational returns the payload with an optional leading +', () => {
  assert.equal(extractInformational('+CSQ: 22,99', 'CSQ'), '22,99');
  assert.equal(extractInformational('+CSQ: 22,99', '+csq'), '22,99');
  assert.equal(extractInformational('+CSQ:22,99', 'CSQ'), '22,99');
  assert.equal(extractInformational('  +CSQ: 22,99  ', 'CSQ'), '22,99');
  assert.equal(extractInformational('+CSQ:', 'CSQ'), '');
  assert.equal(extractInformational('+CSQ: 22,99', ''), null);
  assert.equal(extractInformational('+CSQ: 22,99', undefined), null);
  assert.equal(extractInformational('AT+CSQ: 22,99', 'CSQ'), null);
  assert.equal(extractInformational('+CPIN: READY', 'CSQ'), null);
  assert.equal(extractInformational(undefined, 'CSQ'), null);
});

/* ------------------------------------------------------------ +CPIN */

test('parseCpinLine: READY is the only ready state', () => {
  const parsed = parseCpinLine('+CPIN: READY');
  assert.deepEqual(parsed, { present: true, ready: true, state: 'READY' });
  assert.equal(Object.isFrozen(parsed), true);

  const lower = parseCpinLine('+cpin: ready');
  assert.equal(lower.ready, true);
  assert.equal(lower.state, 'READY');
});

test('parseCpinLine: NOT READY and PIN lock states are present but not ready', () => {
  const cases = [
    ['NOT READY', 'NOT_READY'],
    ['NOT_READY', 'NOT_READY'],
    ['SIM PIN', 'PIN_REQUIRED'],
    ['SIM PUK', 'PUK_REQUIRED'],
    ['SIM PIN2', 'PIN2_REQUIRED'],
    ['SIM PUK2', 'PUK2_REQUIRED'],
    ['PH-SIM PIN', 'PHONE_TO_SIM_PIN_REQUIRED'],
    ['PH-NET PIN', 'NETWORK_PIN_REQUIRED']
  ];
  for (const [text, state] of cases) {
    const parsed = parseCpinLine(`+CPIN: ${text}`);
    assert.equal(parsed.present, true, text);
    assert.equal(parsed.ready, false, text);
    assert.equal(parsed.state, state, text);
  }

  // 空 payload：卡存在但未就绪，绝不当作 ready。
  const empty = parseCpinLine('+CPIN:');
  assert.equal(empty.present, true);
  assert.equal(empty.ready, false);
  assert.equal(empty.state, 'NOT_READY');
});

test('parseCpinLine: unknown SIM text yields ready=null instead of a guess', () => {
  const parsed = parseCpinLine('+CPIN: SIM LOCKED');
  assert.equal(parsed.present, true);
  assert.equal(parsed.ready, null);
  assert.equal(parsed.state, 'UNKNOWN');

  assert.equal(parseCpinLine('OK'), null);
  assert.equal(parseCpinLine('+CSQ: 22,99'), null);
  assert.equal(parseCpinLine(undefined), null);
});

/* ------------------------------------------------------------ 注册状态 */

test('parseRegistrationLine maps +CREG/+CGREG/+CEREG stat values', () => {
  const cases = [
    ['+CREG: 0,0', '+CREG', 0, 'NOT_REGISTERED', 'not_registered_not_searching'],
    ['+CREG: 0,1', '+CREG', 1, 'REGISTERED', 'registered_home'],
    ['+CGREG: 0,2', '+CGREG', 2, 'SEARCHING', 'searching'],
    ['+CEREG: 0,3', '+CEREG', 3, 'DENIED', 'registration_denied'],
    ['+CREG: 0,4', '+CREG', 4, 'UNKNOWN', 'unknown'],
    ['+CGREG: 0,5', '+CGREG', 5, 'ROAMING', 'registered_roaming']
  ];
  for (const [line, command, stat, state, detail] of cases) {
    const parsed = parseRegistrationLine(line, command);
    assert.ok(parsed, line);
    assert.equal(parsed.command, command, line);
    assert.equal(parsed.stat, stat, line);
    assert.equal(parsed.state, state, line);
    assert.equal(parsed.detail, detail, line);
    assert.equal(parsed.mode, 0, line);
    assert.equal(Object.isFrozen(parsed), true);
  }

  // 命令名可不带 '+'（extractInformational 会容错），但 command 字段原样回显
  // 调用方拼写（仅大写化）；parseAtResponse 内部始终传 '+CREG' 形式。
  const bareCommand = parseRegistrationLine('+CREG: 0,1', 'CREG');
  assert.equal(bareCommand.command, 'CREG');
  assert.equal(bareCommand.state, 'REGISTERED');
  // 越界 stat 不得被推断为已注册。
  const outOfRange = parseRegistrationLine('+CREG: 0,9', '+CREG');
  assert.equal(outOfRange.stat, 9);
  assert.equal(outOfRange.state, 'UNKNOWN');
  assert.equal(outOfRange.detail, 'unknown');
});

test('parseRegistrationLine: non-numeric payloads return UNKNOWN without inference', () => {
  for (const line of ['+CREG: abc', '+CGREG: 0,abc', '+CREG: ,', '+CEREG: --']) {
    const command = line.slice(0, line.indexOf(':'));
    const parsed = parseRegistrationLine(line, command);
    assert.ok(parsed, line);
    assert.equal(parsed.stat, null, line);
    assert.equal(parsed.mode, null, line);
    assert.equal(parsed.state, 'UNKNOWN', line);
    assert.equal(parsed.detail, 'unrecognized_registration_fields', line);
  }

  assert.equal(parseRegistrationLine('OK', '+CREG'), null);
  assert.equal(parseRegistrationLine('+CSQ: 22,99', '+CREG'), null);
  assert.equal(parseRegistrationLine(undefined, '+CREG'), null);
});

test('parseRegistrationLine: single-field payload (URC form) — characterizes BUG-1', () => {
  // 任务书与模块注释（lib/at-parser.js:139-140）期望单字段 -> state UNKNOWN。
  // 实测实现把唯一字段当作 <stat>（等价 3GPP URC `+CREG: <stat>`）。
  // 这里固定真实行为，同时断言最关键的安全属性：`+CEREG: 2` 不是“已注册”。
  const searching = parseRegistrationLine('+CEREG: 2', '+CEREG');
  assert.equal(searching.mode, null);
  assert.equal(searching.stat, 2);
  assert.equal(searching.state, 'SEARCHING');
  assert.notEqual(searching.state, 'REGISTERED');

  const notRegistered = parseRegistrationLine('+CREG: 0', '+CREG');
  assert.equal(notRegistered.stat, 0);
  assert.equal(notRegistered.state, 'NOT_REGISTERED');

  // 若源实现按注释修正为 UNKNOWN，下面三条断言必须同步更新（BUG-1）。
  const homeLike = parseRegistrationLine('+CREG: 1', '+CREG');
  assert.equal(homeLike.mode, null);
  assert.equal(homeLike.stat, 1);
  assert.equal(homeLike.state, 'REGISTERED');
});

/* ------------------------------------------------------------ +CSQ */

test('parseCsqLine converts 0..31 to dBm with the standard formula', () => {
  const cases = [
    [22, -69],
    [0, -113],
    [31, -51]
  ];
  for (const [csq, dbm] of cases) {
    const parsed = parseCsqLine(`+CSQ: ${csq},99`);
    assert.equal(parsed.present, true);
    assert.equal(parsed.state, SIGNAL_VALID, `csq=${csq}`);
    assert.equal(parsed.csq, csq);
    assert.equal(parsed.raw, csq);
    assert.equal(parsed.dbm, dbm, `csq=${csq}`);
    assert.equal(Object.isFrozen(parsed), true);
  }
  assert.equal(parseCsqLine('+CSQ: 22,99').quality, 'excellent');
  assert.equal(parseCsqLine('+csq: 10,99').state, SIGNAL_VALID);
});

test('parseCsqLine: 99 means UNKNOWN and is never a strong signal', () => {
  const parsed = parseCsqLine('+CSQ: 99,99');
  assert.equal(parsed.state, SIGNAL_UNKNOWN);
  assert.equal(parsed.csq, 99);
  assert.equal(parsed.raw, 99);
  assert.equal(parsed.dbm, null);
  assert.equal(parsed.quality, 'UNKNOWN');
  assert.notEqual(parsed.quality, 'excellent');
  assert.notEqual(parsed.dbm, -113 + 2 * 99);
});

test('parseCsqLine: out-of-range and malformed values are INVALID with null dBm', () => {
  for (const payload of ['32,99', '-1,99', 'abc', '100', '1e2']) {
    const parsed = parseCsqLine(`+CSQ: ${payload}`);
    assert.ok(parsed, payload);
    assert.equal(parsed.state, SIGNAL_INVALID, payload);
    assert.equal(parsed.dbm, null, payload);
    assert.equal(parsed.csq, null, payload);
    assert.equal(parsed.raw, null, payload);
  }
  assert.equal(parseCsqLine('+CSQ: -1,99').reason, 'malformed_csq_field');
  assert.equal(parseCsqLine('OK'), null);
  assert.equal(parseCsqLine(undefined), null);
});

/* ------------------------------------------------------------ +COPS */

test('parseCopsLine parses the operator and bounds it to 64 bytes', () => {
  const parsed = parseCopsLine('+COPS: 0,0,"TEST-OPERATOR",7');
  assert.equal(parsed.present, true);
  assert.equal(parsed.state, 'PARSED');
  assert.equal(parsed.mode, 0);
  assert.equal(parsed.format, 0);
  assert.equal(parsed.operator, 'TEST-OPERATOR');
  assert.equal(Object.isFrozen(parsed), true);

  const long = parseCopsLine(`+COPS: 0,0,"${'A'.repeat(120)}",7`);
  assert.equal(Buffer.byteLength(long.operator, 'utf8'), 64);
  assert.equal(long.operator.length, 64);
});

test('parseCopsLine: short or malformed payloads stay UNKNOWN', () => {
  for (const line of ['+COPS: 0,0', '+COPS: 0', '+COPS:']) {
    const parsed = parseCopsLine(line);
    assert.ok(parsed, line);
    assert.equal(parsed.present, true, line);
    assert.equal(parsed.state, 'UNKNOWN', line);
    assert.equal(parsed.operator, undefined, line);
  }
  assert.equal(parseCopsLine('OK'), null);
  assert.equal(parseCopsLine(undefined), null);
});

/* ------------------------------------------------------------ 整窗解析 */

test('parseAtResponse parses a full standard window into typed fields', () => {
  const sentCommands = ['AT+CPIN?', 'AT+CSQ', 'AT+COPS?', 'AT+CREG?', 'AT+CGREG?', 'AT+CEREG?'];
  const parsed = parseAtResponse(
    [
      'AT+CPIN?',
      '+CPIN: READY',
      'AT+CSQ',
      '+CSQ: 22,99',
      'AT+COPS?',
      '+COPS: 0,0,"TEST-OPERATOR",7',
      'AT+CREG?',
      '+CREG: 0,1',
      'AT+CGREG?',
      '+CGREG: 0,5',
      'AT+CEREG?',
      '+CEREG: 0,3',
      'RING',
      '+CMTI: "SM",1',
      'OK'
    ],
    { sentCommands }
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.error, false);
  assert.equal(parsed.pin.ready, true);
  assert.equal(parsed.csq.csq, 22);
  assert.equal(parsed.csq.dbm, -69);
  assert.equal(parsed.operator.operator, 'TEST-OPERATOR');
  assert.equal(parsed.registrations['+CREG'].state, 'REGISTERED');
  assert.equal(parsed.registrations['+CGREG'].state, 'ROAMING');
  assert.equal(parsed.registrations['+CEREG'].state, 'DENIED');
  assert.deepEqual([...parsed.unrecognized], ['RING', '+CMTI: "SM",1']);
  assert.equal(parsed.blocked, AT_PROBE_BLOCKED);
});

test('parseAtResponse parses only the six documented commands', () => {
  const parsed = parseAtResponse(['+GMI: TEST-VENDOR', '+CGSN: 123', '+CMTI: "SM",1', '+CPIN: READY', 'OK']);
  assert.equal(parsed.pin.ready, true);
  assert.deepEqual([...parsed.unrecognized], ['+GMI: TEST-VENDOR', '+CGSN: 123', '+CMTI: "SM",1']);
});

test('parseAtResponse skips command echoes only when declared via sentCommands', () => {
  const lines = ['AT+CPIN?', '+CPIN: READY', 'OK'];

  const withEcho = parseAtResponse(lines, { sentCommands: ['at+cpin?'] });
  assert.equal(withEcho.pin.state, 'READY');
  assert.deepEqual([...withEcho.unrecognized], []);

  const withoutEcho = parseAtResponse(lines);
  assert.deepEqual([...withoutEcho.unrecognized], ['AT+CPIN?']);

  // sentCommands 不是数组时忽略，回显仍进入 unrecognized。
  const invalidOption = parseAtResponse(lines, { sentCommands: 'AT+CPIN?' });
  assert.deepEqual([...invalidOption.unrecognized], ['AT+CPIN?']);
});

test('parseAtResponse: ERROR sets ok=false/error=true and is sticky', () => {
  const errorOnly = parseAtResponse(['ERROR']);
  assert.equal(errorOnly.error, true);
  assert.equal(errorOnly.ok, false);

  const okThenError = parseAtResponse(['OK', 'ERROR']);
  assert.equal(okThenError.ok, false);
  assert.equal(okThenError.error, true);

  const errorThenOk = parseAtResponse(['ERROR', 'OK']);
  assert.equal(errorThenOk.ok, false, 'later OK must not clear an earlier ERROR');
  assert.equal(errorThenOk.error, true);

  const okOnly = parseAtResponse(['OK']);
  assert.equal(okOnly.ok, true);
  assert.equal(okOnly.error, false);
});

test('parseAtResponse: URC interleaving is deterministic and counts transitions', () => {
  const parsed = parseAtResponse([
    'RING',
    '+CREG: 0,2',
    '+CSQ: 18,99',
    '+CREG: 0,1',
    '+CMTI: "SM",1',
    'OK'
  ]);

  assert.equal(parsed.registrations['+CREG'].stat, 1);
  assert.equal(parsed.registrations['+CREG'].state, 'REGISTERED');
  assert.equal(parsed.registrations.transitions, 1, 'same-domain stat change must be counted once');
  assert.equal(parsed.csq.csq, 18);
  assert.equal(parsed.csq.dbm, -77);
  assert.deepEqual([...parsed.unrecognized], ['RING', '+CMTI: "SM",1']);

  // 相同 stat 不增加 transitions。
  const stable = parseAtResponse(['+CREG: 0,1', '+CREG: 0,1']);
  assert.equal(stable.registrations.transitions, undefined);
});

test('parseAtResponse returns a frozen, bounded result and never throws on garbage', () => {
  for (const input of [undefined, null, 'not-an-array', 42, {}, [null, undefined, 42, {}, 'x']]) {
    assert.doesNotThrow(() => parseAtResponse(input), String(input));
  }

  const empty = parseAtResponse(undefined);
  assert.equal(empty.ok, null);
  assert.equal(empty.error, false);
  assert.equal(empty.pin, null);
  assert.equal(empty.csq, null);
  assert.equal(empty.operator, null);
  assert.deepEqual(empty.registrations, {});
  assert.deepEqual([...empty.unrecognized], []);
  assert.equal(empty.blocked, AT_PROBE_BLOCKED);

  const withLines = parseAtResponse(['x']);
  assert.equal(Object.isFrozen(withLines), true);
  assert.equal(Object.isFrozen(withLines.registrations), true);
  assert.equal(Object.isFrozen(withLines.unrecognized), true);

  const mixed = parseAtResponse([null, undefined, 42, {}, 'x']);
  assert.deepEqual([...mixed.unrecognized], ['x']);
});

/* ------------------------------------------------------------ 夹具（只读） */

test('parseAtResponse reproduces the read-only AT fixture window', () => {
  const raw = readFileSync(join(__dirname, 'fixtures', 'at-standard.fixture'), 'utf8');
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  const sentCommands = rows
    .filter((line) => line.startsWith('>>> '))
    .map((line) => line.slice(4).trim());
  const responseLines = rows.filter((line) => !line.startsWith('>>> '));

  const parsed = parseAtResponse(responseLines, { sentCommands });
  assert.deepEqual(sentCommands, ['AT+CPIN?', 'AT+CSQ', 'AT+CREG?', 'AT+CEREG?', 'AT+COPS?', 'AT+CGMR']);
  assert.equal(parsed.pin.ready, true);
  assert.equal(parsed.csq.csq, 22);
  assert.equal(parsed.csq.dbm, -69);
  assert.equal(parsed.registrations['+CREG'].state, 'REGISTERED');
  assert.equal(parsed.registrations['+CEREG'].state, 'ROAMING');
  assert.equal(parsed.operator.operator, 'TEST-OPERATOR');
  // 夹具最后一个块是 ERROR：整窗结论必须是失败，且回显不进 unrecognized。
  assert.equal(parsed.error, true);
  assert.equal(parsed.ok, false);
  assert.deepEqual([...parsed.unrecognized], []);
});
