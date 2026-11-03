'use strict';

/**
 * notify-multirecipient.test.js — 多监护人投递隔离测试（缺陷 2）
 *
 * 这些测试先于实现修复编写，用于复现两个真实缺陷：
 *   A. 多监护人共享一条全局记录：a 成功后下一轮重试又发给 a，序列变成 a,b,a,b，
 *      重复消耗 a 的一次性订阅额度。
 *   B. 一个收件人永久失败会 break 掉整轮循环，导致其他收件人根本收不到。
 *
 * 契约（修复后必须成立）：
 *   - 投递状态按 recipientRef 独立记录；幂等键 = deviceId + alarmId + recipientRef；
 *   - 已成功的收件人在后续重试中不再被发送；
 *   - 一个收件人永久失败只终止该收件人，不影响其他收件人；
 *   - token 失效是全局问题，刷新后可重试尚未成功的收件人；
 *   - 同一收件人的一次性授权只在微信确认发送成功后消耗；
 *   - 43101 把该收件人的本地可用额度校正为 0。
 *
 * 全程使用 fake provider，不访问真实微信 API，不使用真实 openid。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { NOTIFY_CODES, notifyError } = require('../src/notify-provider');
const { createNotificationDelivery, AGGREGATE_STATUS } = require('../src/notify-delivery');
const { recipientRefFor, RECIPIENT_REF_DOMAIN } = require('../src/notify-privacy');

const SECRET = 'unit-test-recipient-ref-secret-value-32';

/** 内存台账：与 PersistentStore 的多收件人契约一致（含额度消耗/校正）。 */
function createMemoryLedger() {
  const records = new Map();
  const subs = new Map();
  const key = (deviceId, alarmId, ref) => `${deviceId}\u0000${alarmId}\u0000${ref}`;
  return {
    records,
    subs,
    readNotification: (deviceId, alarmId, ref) => records.get(key(deviceId, alarmId, ref)) || null,
    listNotifications: () => [...records.values()],
    upsertNotification(record) {
      const frozen = Object.freeze({ ...record });
      records.set(key(record.deviceId, record.alarmId, record.recipientRef), frozen);
      return frozen;
    },
    readSubscription: (ref) => {
      const existing = subs.get(ref);
      if (!existing) return null;
      // remaining 是派生值，不能冻结：额度 = totalGranted - consumed - revoked。
      const revoked = existing.revoked || 0;
      return { ...existing, revoked, remaining: Math.max(0, existing.totalGranted - existing.consumed - revoked) };
    },
    listSubscriptions: () => [...subs.values()],
    upsertSubscription(record) {
      const frozen = Object.freeze({ ...record });
      subs.set(record.recipientRef, frozen);
      return frozen;
    },
    /** 与 PersistentStore.consumeSubscription 语义一致：只有确认发送成功后才调用。 */
    consumeSubscription(ref, now = 1) {
      const existing = subs.get(ref);
      if (!existing) return { ok: false, reason: 'no_grant', remaining: 0 };
      if (existing.totalGranted - existing.consumed <= 0) return { ok: false, reason: 'no_quota', remaining: 0 };
      const next = Object.freeze({
        ...existing, consumed: existing.consumed + 1, updatedAt: now
      });
      subs.set(ref, next);
      return { ok: true, remaining: Math.max(0, next.totalGranted - next.consumed) };
    },
    /** 与 PersistentStore.revokeSubscriptionQuota 语义一致：43101 时把可用额度校正为 0。 */
    revokeSubscriptionQuota(ref, now = 1) {
      const existing = subs.get(ref);
      if (!existing) return null;
      if (existing.totalGranted - existing.consumed <= 0) return existing;
      const next = Object.freeze({ ...existing, revoked: existing.totalGranted - existing.consumed, updatedAt: now });
      subs.set(ref, next);
      return next;
    },
    seedSubscription(ref, remaining, consumed = 0) {
      subs.set(ref, Object.freeze({
        recipientRef: ref, totalGranted: remaining + consumed, consumed,
        grantedAt: 1, updatedAt: 1, grantEventIds: []
      }));
    }
  };
}

/**
 * 可编程 fake provider。sendPlan 的每一项按「每次 sendSubscribeMessage 调用」顺序消费。
 */
function fakeProvider(sendPlan = []) {
  const calls = { send: 0, token: 0, sends: [] };
  const plan = [...sendPlan];
  return {
    name: 'fake',
    calls,
    isConfigured: () => true,
    async getAccessToken() {
      calls.token += 1;
      return { token: `token-${calls.token}`, expiresInMs: 7200 * 1000 };
    },
    async sendSubscribeMessage(payload) {
      calls.send += 1;
      calls.sends.push(payload.openid);
      const planned = plan.length > 0 ? plan.shift() : { kind: 'ok' };
      if (planned.kind === 'throw') throw planned.error;
      return { ok: true };
    }
  };
}

const ok = () => ({ kind: 'ok' });
const temporary = (code = NOTIFY_CODES.NETWORK) => ({
  kind: 'throw',
  error: notifyError(code, 'temporary failure', { retryable: true })
});
const permanent = (errcode = 43101) => ({
  kind: 'throw',
  error: notifyError(NOTIFY_CODES.PERMANENT, 'user refused', { errcode, permanent: true })
});

function recipients(ledger, refs) {
  return refs.map((ref) => ({
    ref,
    openid: `openid-placeholder-${ref}`,
    granted: true,
    remaining: ledger.readSubscription(ref) ? ledger.readSubscription(ref).remaining : 1
  }));
}

function alarm(overrides = {}) {
  return { deviceId: 'dayu200-room-1', alarmId: 'alarm-1', room: '客厅', type: 'FALL', createdAt: 1_700_000_000_000, ...overrides };
}

function makeDelivery(ledger, provider, extra = {}) {
  return createNotificationDelivery({
    provider,
    templateId: 'TEMPLATE_OK_1',
    ledger,
    sleepImpl: async () => {},
    maxAttempts: 3,
    ...extra
  });
}

/* ------------------------------------------------------------ 缺陷 2A */

test('a succeeds and b fails temporarily: the send sequence is a,b,b — never a,b,a,b', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-a', 1);
  ledger.seedSubscription('ref-b', 1);
  const provider = fakeProvider([ok(), temporary(), ok()]);
  const delivery = makeDelivery(ledger, provider);

  const result = await delivery.notifyAlarm(alarm(), recipients(ledger, ['ref-a', 'ref-b']));

  assert.deepEqual(provider.calls.sends, ['openid-placeholder-ref-a', 'openid-placeholder-ref-b', 'openid-placeholder-ref-b'],
    'a 成功后不得再次发送；只重试失败的 b');
  assert.equal(provider.calls.sends.filter((item) => item.endsWith('ref-a')).length, 1, 'a 只能被发送一次');
  assert.equal(result.status, AGGREGATE_STATUS.ALL_SENT);
});

test('a temporary failure does not consume quota, and the retry consumes it only on success', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-b', 1);
  const provider = fakeProvider([temporary(), ok()]);
  const delivery = makeDelivery(ledger, provider);

  await delivery.notifyAlarm(alarm(), recipients(ledger, ['ref-b']));
  assert.equal(ledger.readSubscription('ref-b').remaining, 0, '成功发送后才消耗额度');
  assert.equal(ledger.readSubscription('ref-b').consumed, 1);
});

/* ------------------------------------------------------------ 缺陷 2B */

test('a fails permanently but b still receives the notification', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-a', 1);
  ledger.seedSubscription('ref-b', 1);
  const provider = fakeProvider([permanent(43101), ok()]);
  const delivery = makeDelivery(ledger, provider);

  const result = await delivery.notifyAlarm(alarm(), recipients(ledger, ['ref-a', 'ref-b']));

  assert.deepEqual(provider.calls.sends, ['openid-placeholder-ref-a', 'openid-placeholder-ref-b'],
    'a 永久失败绝不能让 b 收不到');
  assert.equal(result.status, AGGREGATE_STATUS.PARTIAL);
  const byRef = new Map(result.recipients.map((item) => [item.recipientRef, item]));
  assert.equal(byRef.get('ref-a').status, 'PERMANENT_FAILED');
  assert.equal(byRef.get('ref-b').status, 'SENT');
});

test('43101 zeroes the local quota for that recipient only', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-a', 1);
  ledger.seedSubscription('ref-b', 1);
  const provider = fakeProvider([permanent(43101), ok()]);
  const delivery = makeDelivery(ledger, provider);

  await delivery.notifyAlarm(alarm(), recipients(ledger, ['ref-a', 'ref-b']));
  const grantA = ledger.readSubscription('ref-a');
  const grantB = ledger.readSubscription('ref-b');
  assert.equal(grantA.remaining, 0, '43101 必须把本地额度校正为 0');
  assert.equal(grantA.revoked, 1, '用独立的 revoked 计数，而不是把 consumed 拉满');
  assert.equal(grantA.consumed, 0, '永久失败不算一次成功发送');
  assert.equal(grantB.remaining, 0, 'b 成功发送后也消耗掉');
  assert.equal(grantB.consumed, 1);
});

/* ------------------------------------------------------------ 按收件人幂等 */

test('per-recipient idempotency: a SENT recipient is not re-sent across a restart', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-a', 1);
  ledger.seedSubscription('ref-b', 1);

  const firstProvider = fakeProvider([ok(), temporary(), ok()]);
  await makeDelivery(ledger, firstProvider).notifyAlarm(alarm(), recipients(ledger, ['ref-a', 'ref-b']));
  assert.deepEqual(firstProvider.calls.sends, ['openid-placeholder-ref-a', 'openid-placeholder-ref-b', 'openid-placeholder-ref-b']);

  // 新进程：全新 delivery 实例，同一个持久台账。
  const secondProvider = fakeProvider([ok()]);
  const second = await makeDelivery(ledger, secondProvider).notifyAlarm(alarm(), recipients(ledger, ['ref-a', 'ref-b']));

  assert.equal(secondProvider.calls.send, 0, '全部收件人都已完成时不得再发送任何消息');
  assert.equal(second.status, AGGREGATE_STATUS.ALL_SENT);
});

test('different recipients of the same alarm are idempotent independently', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-a', 1);
  ledger.seedSubscription('ref-b', 1);
  const provider = fakeProvider([ok(), temporary(), temporary(), temporary()]);
  const delivery = makeDelivery(ledger, provider, { maxAttempts: 2 });

  const result = await delivery.notifyAlarm(alarm(), recipients(ledger, ['ref-a', 'ref-b']));
  assert.equal(result.status, AGGREGATE_STATUS.PARTIAL);
  const byRef = new Map(result.recipients.map((item) => [item.recipientRef, item]));
  assert.equal(byRef.get('ref-a').status, 'SENT');
  assert.equal(byRef.get('ref-b').status, 'FAILED');

  // b 的失败状态独立于 a 的成功状态。
  assert.equal(ledger.readNotification('dayu200-room-1', 'alarm-1', 'ref-a').status, 'SENT');
  assert.equal(ledger.readNotification('dayu200-room-1', 'alarm-1', 'ref-b').status, 'FAILED');
});

test('a recipient without a usable grant is skipped and never sent to', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-a', 1);
  ledger.seedSubscription('ref-b', 0);
  const provider = fakeProvider([ok()]);
  const delivery = makeDelivery(ledger, provider);

  const result = await delivery.notifyAlarm(alarm(), recipients(ledger, ['ref-a', 'ref-b']));
  assert.deepEqual(provider.calls.sends, ['openid-placeholder-ref-a']);
  const byRef = new Map(result.recipients.map((item) => [item.recipientRef, item]));
  assert.equal(byRef.get('ref-b').status, 'SKIPPED');
  assert.equal(byRef.get('ref-b').reason, 'no_quota');
});

test('a global token failure retries every unfinished recipient after a forced refresh', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-a', 1);
  ledger.seedSubscription('ref-b', 1);
  const provider = fakeProvider([
    { kind: 'throw', error: notifyError(NOTIFY_CODES.TOKEN_INVALID, 'token expired', { errcode: 40001, refreshToken: true, retryable: true }) },
    ok(),
    ok()
  ]);
  const delivery = makeDelivery(ledger, provider);
  const result = await delivery.notifyAlarm(alarm(), recipients(ledger, ['ref-a', 'ref-b']));

  // token 失效是**全局**问题：两个收件人都必须最终成功，且各自只应被计一次成功。
  assert.equal(result.status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(provider.calls.sends.filter((item) => item.endsWith('ref-a')).length >= 1, true);
  assert.equal(provider.calls.sends.filter((item) => item.endsWith('ref-b')).length >= 1, true);
  assert.equal(provider.calls.sends.length, 3, '共 3 次发送：一次 token 失败 + 两个收件人各一次成功');
  assert.equal(provider.calls.token >= 2, true, 'token 失效后必须刷新');
  assert.equal(ledger.readNotification('dayu200-room-1', 'alarm-1', 'ref-a').status, 'SENT');
  assert.equal(ledger.readNotification('dayu200-room-1', 'alarm-1', 'ref-b').status, 'SENT');
  assert.equal(ledger.readSubscription('ref-a').consumed, 1, '只消耗一次');
  assert.equal(ledger.readSubscription('ref-b').consumed, 1, '只消耗一次');
});

/* ------------------------------------------------------------ 聚合与隐私 */

test('no recipients yields NO_RECIPIENTS and sends nothing', async () => {
  const ledger = createMemoryLedger();
  const provider = fakeProvider([ok()]);
  const result = await makeDelivery(ledger, provider).notifyAlarm(alarm(), []);
  assert.equal(result.status, AGGREGATE_STATUS.NO_RECIPIENTS);
  assert.equal(provider.calls.send, 0);
});

test('all recipients permanently failing yields FAILED', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-a', 1);
  const provider = fakeProvider([permanent(40003)]);
  const result = await makeDelivery(ledger, provider).notifyAlarm(alarm(), recipients(ledger, ['ref-a']));
  assert.equal(result.status, AGGREGATE_STATUS.FAILED);
});

test('persisted records never contain the raw openid', async () => {
  const ledger = createMemoryLedger();
  ledger.seedSubscription('ref-a', 1);
  const provider = fakeProvider([ok()]);
  await makeDelivery(ledger, provider).notifyAlarm(alarm(), recipients(ledger, ['ref-a']));

  const text = JSON.stringify(ledger.listNotifications()) + JSON.stringify(ledger.listSubscriptions());
  assert.equal(text.includes('openid-placeholder-ref-a'), false, '持久记录不得含原始 openid');
  assert.equal(text.includes('openid'), false, '持久记录不得出现 openid 字段名');
});

test('recipientRef is a domain-separated HMAC, never a bare hash of the openid', () => {
  const ref = recipientRefFor(SECRET, 'openid-placeholder-ref-a');
  assert.match(ref, /^r1_[A-Za-z0-9_-]{32,64}$/);
  assert.equal(ref, recipientRefFor(SECRET, 'openid-placeholder-ref-a'), '同一输入必须稳定');
  assert.notEqual(ref, recipientRefFor('another-secret-value-at-least-32-chars', 'openid-placeholder-ref-a'),
    '不同密钥必须产生不同 ref');
  assert.notEqual(ref, recipientRefFor(SECRET, 'openid-placeholder-ref-b'));
  assert.equal(ref.includes('openid'), false);
  assert.equal(RECIPIENT_REF_DOMAIN.includes('notify'), true, '域分离字符串必须可识别');

  // 裸 SHA-256 会被拒绝：这是必须避免的写法。
  const crypto = require('node:crypto');
  const bare = crypto.createHash('sha256').update('openid-placeholder-ref-a').digest('base64url');
  assert.notEqual(ref, bare);
  assert.equal(ref.startsWith('r1_'), true, '必须以带域分离版本的稳定前缀开头');
});
