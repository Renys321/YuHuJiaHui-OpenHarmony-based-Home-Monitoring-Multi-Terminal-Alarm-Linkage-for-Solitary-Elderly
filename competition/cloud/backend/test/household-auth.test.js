'use strict';

/**
 * household-auth.test.js — 单户版微信监护人授权模块单元测试
 *
 * 纯单元测试：不使用网络、真实账号或 PowerShell；只依赖 node:assert / node:test。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHouseholdAuthorizer, parseAllowedOpenIds } = require('../src/household-auth');

/* ------------------------------------------------------------ 允许名单解析 */

test('parses a JSON string array with trim and dedupe', () => {
  const allowed = parseAllowedOpenIds('[" wx_openid-1 ", "wx_openid-1", "wx_openid-2"]');
  assert.deepEqual([...allowed], ['wx_openid-1', 'wx_openid-2']);
  assert.equal(Object.isFrozen(allowed), true);
});

test('parses a comma separated list as compatibility input', () => {
  const allowed = parseAllowedOpenIds(' openid_a ,openid-b,  openid_a ');
  assert.deepEqual([...allowed], ['openid_a', 'openid-b']);
});

test('rejects non-string, empty and blank inputs', () => {
  const bad = [42, null, undefined, {}, [], '', '   ', ',', 'a,', ',a', '[]', '[ ]'];
  for (const value of bad) {
    assert.throws(() => parseAllowedOpenIds(value), /allowed openids/);
  }
});

test('rejects malformed JSON and non-string JSON elements', () => {
  assert.throws(() => parseAllowedOpenIds('["a",1]'), /only strings/);
  assert.throws(() => parseAllowedOpenIds('[["a"]]'), /only strings/);
  assert.throws(() => parseAllowedOpenIds('["a", null]'), /only strings/);
  assert.throws(() => parseAllowedOpenIds('["a"'), /JSON is invalid/);
  assert.throws(() => parseAllowedOpenIds('[a,b]'), /JSON is invalid/);
});

test('rejects control characters, oversized entries and illegal characters', () => {
  // JSON 文本里出现字面控制字符（NUL/换行）会让 JSON 本身非法：必须如实报告 JSON invalid。
  assert.throws(() => parseAllowedOpenIds('["ok","bad\u0000id"]'), /JSON is invalid/);

  // 合法 JSON 文本用转义序列编码控制字符，JSON.parse 解码后才命中条目级控制字符校验。
  assert.throws(() => parseAllowedOpenIds('["ok","bad\\u0000id"]'), /control characters/);
  assert.throws(() => parseAllowedOpenIds('["bad\\u007Fid"]'), /control characters/);
  assert.throws(() => parseAllowedOpenIds('["abc\\n"]'), /control characters/);

  // 兼容的逗号分隔分支继续拒绝字面控制字符（不经过 JSON.parse）。
  assert.throws(() => parseAllowedOpenIds('ok,bad\nid'), /control characters/);
  assert.throws(() => parseAllowedOpenIds('x'.repeat(129)), /128 bytes/);

  for (const value of ['bad/id', 'bad.id', 'bad id', 'a..b', '/etc/passwd', 'a\r\nb', '微信openid', 'bad\\id', 'bad+id']) {
    assert.throws(() => parseAllowedOpenIds(value), /allowed openids/);
  }

  // 边界内必须接受：128 个合法字符。
  const max = 'a'.repeat(128);
  assert.deepEqual([...parseAllowedOpenIds(max)], [max]);
});

test('never echoes the rejected value in error messages', () => {
  const marker = 'SECRET_OPENID_MARKER';
  const cases = [
    `goodone,${marker}/../etc`,
    `["ok","${marker}\u0000"]`,
    `["${marker}"`,
    `${marker}${'x'.repeat(200)}`
  ];

  for (const value of cases) {
    let caught = null;
    try {
      parseAllowedOpenIds(value);
    } catch (error) {
      caught = error;
    }
    assert.notEqual(caught, null, 'contains a marker case that must be rejected');
    assert.equal(String(caught.message).includes(marker), false, '错误信息不得回显原始条目');
    assert.equal(String(caught.message).includes(value), false, '错误信息不得回显原始值');
  }
});

/* ------------------------------------------------------------ 授权器 */

test('creates a frozen authorizer from string, array and object input', () => {
  const fromString = createHouseholdAuthorizer('["wx_a"," wx_b ","wx_a"]');
  assert.equal(fromString.size, 2);
  assert.equal(Object.isFrozen(fromString), true);
  assert.equal(fromString.isAllowed('wx_a'), true);
  assert.equal(fromString.isAllowed('wx_b'), true);
  assert.equal(fromString.isAllowed('wx_c'), false);

  const fromArray = createHouseholdAuthorizer([' wx_a ', 'wx_a', 'wx_b']);
  assert.equal(fromArray.size, 2);
  assert.equal(fromArray.isAllowed('wx_a'), true);

  const fromObject = createHouseholdAuthorizer({ allowedOpenIds: 'wx_a,wx_b' });
  assert.equal(fromObject.size, 2);
  assert.equal(fromObject.isAllowed('wx_b'), true);

  const fromAlias = createHouseholdAuthorizer({ allowed: ['wx_a'] });
  assert.equal(fromAlias.size, 1);
});

test('isAllowed always returns a boolean, never throws and never normalizes input', () => {
  const authorizer = createHouseholdAuthorizer(['wx_a']);
  const inputs = [
    undefined, null, 0, 1, true, {}, [], '', 'wx_a', 'wx_a ', ' wx_a', 'WX_A',
    'wx_a\n', 'wx_ax', Symbol('wx_a'), () => {}
  ];

  for (const input of inputs) {
    let result;
    assert.doesNotThrow(() => { result = authorizer.isAllowed(input); });
    assert.equal(typeof result, 'boolean');
  }

  assert.equal(authorizer.isAllowed('wx_a'), true);
  assert.equal(authorizer.isAllowed('wx_a '), false);
  assert.equal(authorizer.isAllowed(' wx_a'), false);
  assert.equal(authorizer.isAllowed('WX_A'), false);
});

test('rejects invalid authorizer configuration at construction time', () => {
  const bad = [
    undefined, null, 42, true, {}, { allowedOpenIds: undefined }, { allowedOpenIds: [] },
    '', '   ', '[]', [], ['ok', '']
  ];
  for (const value of bad) {
    assert.throws(() => createHouseholdAuthorizer(value), /allowed openids/);
  }
});
