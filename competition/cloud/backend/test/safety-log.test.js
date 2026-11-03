'use strict';

/**
 * safety-log.test.js — 处置结果纯模块的合同边界测试
 *
 * 覆盖：outcome 枚举/文案、note 长度与控制字符、OTHER 必填说明、
 * clientDispositionId 规则（含 `..`）、请求体字段白名单、公开形状白名单。
 * 纯内存、无 IO、无网络、无密钥。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DISPOSITION_OUTCOMES,
  DISPOSITION_LABELS,
  DISPOSITION_ID_RE,
  DISPOSITION_FIELDS,
  PUBLIC_DISPOSITION_FIELDS,
  SAFETY_LOG_FIELDS,
  DISPOSITION_ACTOR,
  DISPOSITION_NOTE_MAX,
  SAFETY_LOG_CAP,
  isDispositionOutcome,
  isValidClientDispositionId,
  normalizeDispositionNote,
  validateDispositionInput,
  publicDisposition
} = require('../src/safety-log');

const VALID = Object.freeze({
  clientDispositionId: 'disp-1730000000000-a1b2',
  outcome: 'CONTACTED_FAMILY',
  note: '已联系家属，老人安全'
});

function validBody(overrides = {}) {
  return { ...VALID, ...overrides };
}

/* ------------------------------------------------------------ 枚举与文案 */

test('exposes exactly the five contract outcomes with fixed labels', () => {
  assert.deepEqual([...DISPOSITION_OUTCOMES], [
    'CONTACTED_FAMILY', 'CONTACTED_COMMUNITY', 'ON_SITE_CONFIRMED_NORMAL', 'FALSE_ALARM', 'OTHER'
  ]);
  assert.deepEqual(DISPOSITION_LABELS, {
    CONTACTED_FAMILY: '已联系家属',
    CONTACTED_COMMUNITY: '已联系社区',
    ON_SITE_CONFIRMED_NORMAL: '现场确认正常',
    FALSE_ALARM: '误报',
    OTHER: '其他说明'
  });
  for (const outcome of DISPOSITION_OUTCOMES) {
    assert.equal(isDispositionOutcome(outcome), true);
    assert.equal(typeof DISPOSITION_LABELS[outcome], 'string');
    assert.ok(DISPOSITION_LABELS[outcome].length > 0);
  }
  assert.equal(isDispositionOutcome('UNKNOWN'), false);
  assert.equal(isDispositionOutcome('contacted_family'), false);
  assert.equal(isDispositionOutcome(undefined), false);
  assert.equal(isDispositionOutcome(null), false);
  assert.equal(SAFETY_LOG_FIELDS.length, 10);
  assert.equal(DISPOSITION_FIELDS.length, 3);
  assert.ok(SAFETY_LOG_CAP >= 2000);
});

test('exports the contract disposition id grammar', () => {
  for (const value of ['dsp-1', 'dsp-9', 'dsp-1730000000000', 'dsp-1234567890123456']) {
    assert.equal(DISPOSITION_ID_RE.test(value), true, value);
  }
  for (const value of ['', 'dsp-0', 'dsp-01', 'dsp-', 'dsp-abc', 'dsp-12345678901234567', 'DSP-1', ' dsp-1']) {
    assert.equal(DISPOSITION_ID_RE.test(value), false, value);
  }
});

/* ------------------------------------------------------------ 合法输入与归一化 */

test('accepts the contract example and normalizes note', () => {
  const result = validateDispositionInput(validBody());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.value, {
    clientDispositionId: VALID.clientDispositionId,
    outcome: 'CONTACTED_FAMILY',
    note: '已联系家属，老人安全'
  });
  assert.equal(Object.isFrozen(result.value), true);
});

test('note is trimmed and CR/LF are normalized to a single space', () => {
  const result = validateDispositionInput(validBody({ outcome: 'OTHER', note: '  第一行\r\n第二行\n第三行\r第四行  ' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.note, '第一行 第二行 第三行 第四行');
  assert.equal(normalizeDispositionNote('a\r\nb'), 'a b');
  assert.equal(normalizeDispositionNote('a\tb'), null, '制表符属于控制字符，必须拒绝');
  assert.equal(normalizeDispositionNote(42), null);
});

test('note is optional and may be empty for non-OTHER outcomes', () => {
  const result = validateDispositionInput({
    clientDispositionId: 'disp-1730000000000-a1b2',
    outcome: 'FALSE_ALARM'
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.note, '');
  assert.equal(validateDispositionInput(validBody({ note: '' })).ok, true);
  assert.equal(validateDispositionInput(validBody({ note: '   ' })).value.note, '');
});

test('accepts exactly 200 characters but rejects 201', () => {
  const atLimit = 'a'.repeat(DISPOSITION_NOTE_MAX);
  assert.equal(normalizeDispositionNote(atLimit), atLimit);
  const overLimit = validateDispositionInput(validBody({ note: 'a'.repeat(DISPOSITION_NOTE_MAX + 1) }));
  assert.equal(overLimit.ok, false);
  assert.ok(overLimit.errors.note);
  assert.equal(overLimit.value, null);
});

/* ------------------------------------------------------------ 非法 outcome / OTHER */

test('rejects unknown, lowercase, empty and non-string outcomes', () => {
  for (const outcome of ['UNKNOWN', 'contacted_family', '', ' CONTACTED_FAMILY', 42, null, undefined]) {
    const result = validateDispositionInput(validBody({ outcome }));
    assert.equal(result.ok, false, String(outcome));
    assert.ok(result.errors.outcome, String(outcome));
  }
});

test('requires a non-empty note when outcome is OTHER', () => {
  for (const note of ['', '   ', '\r\n', undefined]) {
    const result = validateDispositionInput(validBody({ outcome: 'OTHER', note }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.note, `note=${JSON.stringify(note)}`);
  }
  assert.equal(validateDispositionInput(validBody({ outcome: 'OTHER', note: '老人已自行外出' })).ok, true);
});

/* ------------------------------------------------------------ 控制字符 */

test('rejects C0/DEL/C1 control characters in note', () => {
  for (const code of [0x00, 0x01, 0x09, 0x0b, 0x0c, 0x1f, 0x7f, 0x80, 0x85, 0x9f]) {
    const note = `用药${String.fromCharCode(code)}确认`;
    const result = validateDispositionInput(validBody({ note }));
    assert.equal(result.ok, false, `control 0x${code.toString(16)}`);
    assert.ok(result.errors.note);
  }
  // \r / \n 不拒绝，而是被归一化成空格。
  assert.equal(validateDispositionInput(validBody({ note: 'a\rb' })).ok, true);
});

/* ------------------------------------------------------------ clientDispositionId */

test('clientDispositionId must be 8-64 chars of [A-Za-z0-9._-] without ..', () => {
  assert.equal(isValidClientDispositionId('disp-1730000000000-a1b2'), true);
  assert.equal(isValidClientDispositionId('aaaaaaaa'), true);
  assert.equal(isValidClientDispositionId('a'.repeat(64)), true);
  for (const value of [
    '', 'a'.repeat(7), 'a'.repeat(65), 'has space', 'has/slash', 'has:colon', '..',
    'disp-..-1730', '中文中文中文中文', 42, null, undefined
  ]) {
    assert.equal(isValidClientDispositionId(value), false, String(value));
    const result = validateDispositionInput(validBody({ clientDispositionId: value }));
    assert.equal(result.ok, false, String(value));
    assert.ok(result.errors.clientDispositionId, String(value));
  }
  // 首尾空白被 trim 后合法。
  assert.equal(validateDispositionInput(validBody({ clientDispositionId: '  disp-abcdefgh  ' })).ok, true);
});

/* ------------------------------------------------------------ 字段白名单 */

test('rejects every field outside the request whitelist', () => {
  for (const field of [
    'alarmId', 'deviceId', 'operator', 'operatorRole', 'actor', 'serverTime', 'createdAt',
    'outcomeLabel', 'openid', 'ownerRef', 'household', 'token', 'status', 'ackPending'
  ]) {
    const body = validBody();
    body[field] = 'x';
    const result = validateDispositionInput(body);
    assert.equal(result.ok, false, field);
    assert.ok(result.errors[field], field);
  }
});

test('rejects non-object bodies instead of throwing', () => {
  for (const body of [null, undefined, [], 'payload', 42, true]) {
    const result = validateDispositionInput(body);
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
  }
});

/* ------------------------------------------------------------ 公开形状 */

test('publicDisposition exposes only contract fields and maps labels/actor/createdAt', () => {
  const record = Object.freeze({
    dispositionId: 'dsp-7',
    clientDispositionId: 'disp-1730000000000-a1b2',
    alarmId: 'alarm-a1',
    deviceId: 'esp32-kitchen',
    room: '厨房',
    type: 'SOS',
    outcome: 'CONTACTED_FAMILY',
    note: '已联系家属，老人安全',
    actor: DISPOSITION_ACTOR,
    serverTime: 1792949100000
  });
  const alert = { alarmId: 'alarm-a1', deviceId: 'esp32-kitchen', createdAt: 1792949000000 };
  const published = publicDisposition(record, alert);
  assert.equal(Object.isFrozen(published), true);
  assert.deepEqual(Object.keys(published).sort(), [...PUBLIC_DISPOSITION_FIELDS].sort());
  assert.deepEqual({ ...published }, {
    dispositionId: 'dsp-7',
    alarmId: 'alarm-a1',
    deviceId: 'esp32-kitchen',
    roomName: '厨房',
    alarmType: 'SOS',
    alarmCreatedAt: 1792949000000,
    outcome: 'CONTACTED_FAMILY',
    outcomeLabel: '已联系家属',
    note: '已联系家属，老人安全',
    operator: '家庭监护人',
    operatorRole: 'household-guardian',
    serverTime: 1792949100000
  });
  // 内部字段绝不外泄。
  const text = JSON.stringify(published);
  assert.equal(text.includes('clientDispositionId'), false);
  assert.equal(text.includes('actor'), false);
});

test('publicDisposition is defensive for missing fields and unknown outcomes', () => {
  const empty = publicDisposition(null, null);
  assert.equal(empty.dispositionId, '');
  assert.equal(empty.outcome, '');
  assert.equal(empty.outcomeLabel, '');
  assert.equal(empty.alarmCreatedAt, 0);
  assert.equal(empty.serverTime, 0);
  assert.equal(empty.operatorRole, 'household-guardian');

  const unknown = publicDisposition({ outcome: 'NOT_IN_CONTRACT', dispositionId: 'dsp-1' }, { createdAt: 0 });
  assert.equal(unknown.outcome, '');
  assert.equal(unknown.outcomeLabel, '');
  assert.equal(unknown.alarmCreatedAt, 0, 'serverTime=0/alarmCreatedAt=0 不得被伪造为有效时间');
});
