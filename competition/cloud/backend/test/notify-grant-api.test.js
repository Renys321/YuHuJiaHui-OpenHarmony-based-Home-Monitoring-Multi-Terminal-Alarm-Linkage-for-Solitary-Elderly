'use strict';

/**
 * notify-grant-api.test.js — 订阅授权登记接口测试（缺陷 1）
 *
 * 核心事实：`WECHAT_ALLOWED_OPENIDS` 只代表**允许登录**，不代表用户已经通过
 * `wx.requestSubscribeMessage` 接受了一次性订阅。因此：
 *   - 收件人 = 允许登录 ∩ 已登记授权（且仍有可用额度）；
 *   - 登记必须经现有 Bearer 会话鉴权，且**只能登记当前登录人自己**；
 *   - 客户端不能提交任意 openid；
 *   - reject / ban / cancel / failed 一律不登记；
 *   - 重复同一个 grant event 幂等；
 *   - 响应、日志、快照里绝不出现原始 openid。
 *
 * 全程 fake provider + 内存 store，不访问真实微信 API。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApiServer } = require('../src/server');
const { MemoryStore } = require('../src/store');
const { createSessionToken } = require('../src/auth');
const { createNotificationDelivery, AGGREGATE_STATUS } = require('../src/notify-delivery');

const TOKEN_SECRET = 'grant-api-test-secret-value-at-least-32-chars';
const INGEST_KEY = 'grant-api-test-ingest-key';
const RECIPIENT_REF_SECRET = 'grant-api-recipient-ref-secret-value-32';
const GUARDIAN_A = 'guardian-openid-placeholder-a';
const GUARDIAN_B = 'guardian-openid-placeholder-b';
const OUTSIDER = 'outsider-openid-placeholder-c';
const TEMPLATE = 'TEMPLATE_GRANT_OK_1';

function fakeProvider() {
  const calls = { send: 0, sends: [] };
  return {
    name: 'fake',
    calls,
    isConfigured: () => true,
    getAccessToken: async () => ({ token: 'token-1', expiresInMs: 7200 * 1000 }),
    sendSubscribeMessage: async (payload) => {
      calls.send += 1;
      calls.sends.push(payload.openid);
      return { ok: true };
    }
  };
}

/** 内存台账（收件人级 + 订阅额度）。 */
function memoryLedger() {
  const records = new Map();
  const subs = new Map();
  const remainingOf = (r) => Math.max(0, r.totalGranted - r.consumed - (r.revoked || 0));
  const key = (d, a, ref) => `${d}\u0000${a}\u0000${ref}`;
  return {
    records,
    subs,
    readNotification: (d, a, ref) => records.get(key(d, a, ref)) || null,
    listNotifications: () => [...records.values()],
    upsertNotification(record) {
      const frozen = Object.freeze({ ...record });
      records.set(key(record.deviceId, record.alarmId, record.recipientRef), frozen);
      return frozen;
    },
    readSubscription: (ref) => {
      const r = subs.get(ref);
      return r ? { ...r, remaining: remainingOf(r) } : null;
    },
    listSubscriptions: () => [...subs.values()],
    grantSubscription(ref, templateId, grantEventId) {
      const existing = subs.get(ref);
      const events = existing ? [...existing.grantEventIds] : [];
      const duplicate = events.includes(grantEventId);
      const next = Object.freeze({
        recipientRef: ref,
        templateId,
        totalGranted: (existing ? existing.totalGranted : 0) + (duplicate ? 0 : 1),
        consumed: existing ? existing.consumed : 0,
        revoked: existing ? existing.revoked || 0 : 0,
        grantEventIds: duplicate ? events : [...events, grantEventId].slice(-32),
        grantedAt: existing ? existing.grantedAt : 1,
        updatedAt: 1
      });
      subs.set(ref, next);
      return { record: next, duplicate, remaining: remainingOf(next) };
    },
    consumeSubscription(ref) {
      const r = subs.get(ref);
      if (!r || remainingOf(r) <= 0) return { ok: false, reason: 'no_quota', remaining: 0 };
      const next = Object.freeze({ ...r, consumed: r.consumed + 1 });
      subs.set(ref, next);
      return { ok: true, remaining: remainingOf(next) };
    },
    revokeSubscriptionQuota(ref) {
      const r = subs.get(ref);
      if (!r) return null;
      const next = Object.freeze({ ...r, revoked: r.totalGranted - r.consumed });
      subs.set(ref, next);
      return next;
    }
  };
}

async function startServer(options = {}) {
  const store = options.store || new MemoryStore();
  const ledger = options.ledger || memoryLedger();
  const provider = options.provider || fakeProvider();
  const delivery = options.delivery !== undefined
    ? options.delivery
    : createNotificationDelivery({
      provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET, ledger,
      sleepImpl: async () => {}, maxAttempts: 2
    });
  const allowed = new Set(options.allowed || [GUARDIAN_A, GUARDIAN_B]);
  const { server } = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => allowed.has(openid),
    listGuardians: () => [...allowed],
    notificationDelivery: delivery
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    store, ledger, provider, delivery, allowed,
    url: `http://127.0.0.1:${port}`,
    tokenFor: (openid) => createSessionToken(openid, TOKEN_SECRET),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function postGrant(url, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${url}/api/v1/notifications/subscription`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

/* ------------------------------------------------------------ 鉴权 */

test('registration without a session token is rejected with 401', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const result = await postGrant(app.url, { grantEventId: 'grant-event-0001', templateId: TEMPLATE }, null);
  assert.equal(result.status, 401);
  assert.equal(app.ledger.listSubscriptions().length, 0, '未鉴权请求不得登记任何授权');
});

test('registration by a non-allowlisted openid is rejected with 403', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const result = await postGrant(
    app.url,
    { grantEventId: 'grant-event-0001', templateId: TEMPLATE },
    app.tokenFor(OUTSIDER)
  );
  assert.equal(result.status, 403);
  assert.equal(app.ledger.listSubscriptions().length, 0);
});

test('a guardian can only register their own subscription', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  // 客户端试图在请求体里冒充另一个 openid：必须被忽略，只登记 token 的 sub。
  const result = await postGrant(app.url, {
    grantEventId: 'grant-event-0001',
    templateId: TEMPLATE,
    openid: GUARDIAN_B,
    recipientRef: 'r1_attacker-supplied-value-that-must-be-ignored'
  }, app.tokenFor(GUARDIAN_A));

  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, true);
  assert.equal(result.body.remaining, 1);
  assert.equal(app.ledger.listSubscriptions().length, 1, '只能产生一条登记记录');

  // 登记确实属于 A：把允许名单收敛成只有 A 时仍可投递。
  const refA = app.delivery.refFor(GUARDIAN_A);
  assert.ok(app.ledger.readSubscription(refA), '登记必须落在 A 自己身上');

  // B 未被登记，因此 B 自己的登记接口调用才算第一次。
  const forB = await postGrant(app.url, { grantEventId: 'grant-event-0002', templateId: TEMPLATE }, app.tokenFor(GUARDIAN_B));
  assert.equal(forB.status, 200);
  assert.equal(app.ledger.listSubscriptions().length, 2);
});

test('the response never echoes the openid, recipientRef or the template secret', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const response = await fetch(`${app.url}/api/v1/notifications/subscription`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${app.tokenFor(GUARDIAN_A)}` },
    body: JSON.stringify({ grantEventId: 'grant-event-0001', templateId: TEMPLATE })
  });
  const text = await response.text();
  assert.equal(text.includes(GUARDIAN_A), false, '响应不得回显 openid');
  assert.equal(text.includes('r1_'), false, '响应不得回显 recipientRef');
  assert.equal(text.includes('openid'), false, '响应不得出现 openid 字段');
  const token = app.tokenFor(GUARDIAN_A);
  assert.equal(text.includes(token), false, '响应不得回显会话 token');
});

/* ------------------------------------------------------------ 幂等与拒绝 */

test('the same grant event is idempotent and only counts once', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const token = app.tokenFor(GUARDIAN_A);

  const first = await postGrant(app.url, { grantEventId: 'grant-event-0001', templateId: TEMPLATE }, token);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.remaining, 1);

  const again = await postGrant(app.url, { grantEventId: 'grant-event-0001', templateId: TEMPLATE }, token);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.remaining, 1, '重复登记不得增加额度');

  // 一次新的 accept 才会增加一次额度。
  const second = await postGrant(app.url, { grantEventId: 'grant-event-0002', templateId: TEMPLATE }, token);
  assert.equal(second.body.duplicate, false);
  assert.equal(second.body.remaining, 2);
});

test('reject / ban / cancel / failed never produce a registration', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const token = app.tokenFor(GUARDIAN_A);

  // 这些状态在小程序侧被拦下，不会调用后端接口；即使被调用也必须拒绝非法事件 ID。
  for (const bad of ['', 'short', 'bad id with spaces', 'x'.repeat(65)]) {
    const result = await postGrant(app.url, { grantEventId: bad, templateId: TEMPLATE }, token);
    assert.equal(result.status, 400, `grantEventId=${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(app.ledger.listSubscriptions().length, 0, 'reject/ban 等不得产生任何登记');
});

test('a mismatching template id fails closed with 409', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  const result = await postGrant(
    app.url,
    { grantEventId: 'grant-event-0001', templateId: 'TEMPLATE_OTHER_9' },
    app.tokenFor(GUARDIAN_A)
  );
  assert.equal(result.status, 409);
  assert.equal(app.ledger.listSubscriptions().length, 0);
});

test('an unconfigured subscribe feature reports 503 instead of faking success', async (t) => {
  const app = await startServer({ delivery: null });
  t.after(() => app.close());
  const result = await postGrant(
    app.url,
    { grantEventId: 'grant-event-0001', templateId: TEMPLATE },
    app.tokenFor(GUARDIAN_A)
  );
  assert.equal(result.status, 503);
});

/* ------------------------------------------------------------ 允许登录 ≠ 已订阅 */

test('only allowlisted guardians that actually registered receive notifications', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  // 只有 A 登记了订阅；B 在允许名单里但没登记。
  await postGrant(app.url, { grantEventId: 'grant-event-0001', templateId: TEMPLATE }, app.tokenFor(GUARDIAN_A));

  const recipients = app.delivery.toRecipients([...app.allowed]);
  assert.equal(recipients.length, 1, '只有已登记的 A 是可投递收件人');
  assert.equal(recipients[0].openid, GUARDIAN_A);
  assert.equal(recipients[0].remaining, 1);

  const response = await fetch(`${app.url}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      deviceId: 'esp32-bath', room: '卫生间', state: 'ALARM', ts: 1_700_000_000_000,
      alarm: { id: 'alarm-grant-1', type: 'FALL' }
    })
  });
  assert.equal(response.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(app.provider.calls.sends, [GUARDIAN_A], '绝不能发给未登记的 B');
});

test('an allowlisted but unregistered guardian gets NO_RECIPIENTS and nothing is sent', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  assert.deepEqual(app.delivery.toRecipients([...app.allowed]), [], '没人登记时没有收件人');

  const response = await fetch(`${app.url}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      deviceId: 'esp32-bath', room: '卫生间', state: 'ALARM', ts: 1_700_000_000_000,
      alarm: { id: 'alarm-grant-2', type: 'FALL' }
    })
  });
  assert.equal(response.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(app.provider.calls.send, 0, '未登记订阅的监护人不得收到推送');
  assert.equal(app.ledger.listNotifications().length, 0, '未登记时不留投递记录');
});

test('quota is consumed after a successful send, so the next alarm has no recipient', async (t) => {
  const app = await startServer();
  t.after(() => app.close());
  await postGrant(app.url, { grantEventId: 'grant-event-0001', templateId: TEMPLATE }, app.tokenFor(GUARDIAN_A));

  const ingest = (alarmId) => fetch(`${app.url}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      deviceId: 'esp32-bath', room: '卫生间', state: 'ALARM', ts: 1_700_000_000_000,
      alarm: { id: alarmId, type: 'FALL' }
    })
  });

  await ingest('alarm-q1');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(app.provider.calls.send, 1, '第一次告警消耗掉唯一一次授权');

  // 一次性订阅：额度已用完，第二次告警不再投递。
  assert.deepEqual(app.delivery.toRecipients([...app.allowed]), []);
  await ingest('alarm-q2');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(app.provider.calls.send, 1, '额度用完后不得再发送');

  // 用户再次点击订阅 -> 新额度 -> 可以再收一条。
  await postGrant(app.url, { grantEventId: 'grant-event-0002', templateId: TEMPLATE }, app.tokenFor(GUARDIAN_A));
  assert.equal(app.delivery.toRecipients([...app.allowed]).length, 1);
  await ingest('alarm-q3');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(app.provider.calls.send, 2);
});

test('the aggregate result expresses ALL_SENT / PARTIAL / NO_RECIPIENTS clearly', async (t) => {
  const app = await startServer();
  t.after(() => app.close());

  // NO_RECIPIENTS：没人登记。
  const none = await app.delivery.notifyAlarm(
    { deviceId: 'dev-1', alarmId: 'a-none', room: '客厅', type: 'FALL', createdAt: 1 }, []
  );
  assert.equal(none.status, AGGREGATE_STATUS.NO_RECIPIENTS);

  // ALL_SENT：A、B 都登记，都能成功。
  const tokenA = app.tokenFor(GUARDIAN_A);
  const tokenB = app.tokenFor(GUARDIAN_B);
  await postGrant(app.url, { grantEventId: 'grant-event-0001', templateId: TEMPLATE }, tokenA);
  await postGrant(app.url, { grantEventId: 'grant-event-0002', templateId: TEMPLATE }, tokenB);
  const all = await app.delivery.notifyAlarm(
    { deviceId: 'dev-1', alarmId: 'a-all', room: '客厅', type: 'FALL', createdAt: 1 },
    app.delivery.toRecipients([...app.allowed])
  );
  assert.equal(all.status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(all.sent, 2);
});
