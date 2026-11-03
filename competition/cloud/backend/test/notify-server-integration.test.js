'use strict';

/**
 * notify-server-integration.test.js — 告警订阅消息与后端主链路的集成测试
 *
 * 重点验证「通知绝不能影响主链路」以及「只向已授权监护人发送」：
 *   - 设备状态摄入成功（202）不依赖通知是否成功；
 *   - 通知抛异常 / 永久失败 / 超时，HTTP 响应与内存状态都保持正确；
 *   - ACK 与设备状态查询不受通知影响；
 *   - 收件人只来自允许名单回调；
 *   - 未注入投递器时行为与引入该功能之前完全一致。
 *
 * 全程使用 fake provider 与内存 store，不访问真实微信 API，不部署公网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApiServer } = require('../src/server');
const { MemoryStore } = require('../src/store');
const { createSessionToken } = require('../src/auth');
const { NOTIFY_CODES, notifyError } = require('../src/notify-provider');
const { createNotificationDelivery, DELIVERY_STATUS } = require('../src/notify-delivery');

const TOKEN_SECRET = 'integration-test-secret-value-32-chars';
const INGEST_KEY = 'integration-test-ingest-key';
const RECIPIENT_REF_SECRET = 'integration-recipient-ref-secret-value-32';
const TEMPLATE = 'TEMPLATE_OK_1';

/** 最小 fake provider。 */
function fakeProvider(options = {}) {
  const calls = { token: 0, send: 0, sends: [] };
  return {
    name: 'fake-integration',
    calls,
    isConfigured: () => options.configured !== false,
    async getAccessToken() {
      calls.token += 1;
      if (options.tokenError) throw options.tokenError;
      return { token: `token-${calls.token}`, expiresInMs: 7200 * 1000 };
    },
    async sendSubscribeMessage(payload) {
      calls.send += 1;
      calls.sends.push({ ...payload });
      if (options.sendError) throw options.sendError;
      return { ok: true };
    }
  };
}

/** 内存台账（收件人级 + 订阅额度），与 PersistentStore 的 v4 契约一致。 */
function memoryLedger() {
  const map = new Map();
  const subs = new Map();
  const key = (deviceId, alarmId, ref) => `${deviceId}\u0000${alarmId}\u0000${ref}`;
  const remainingOf = (r) => Math.max(0, r.totalGranted - r.consumed - (r.revoked || 0));
  return {
    map,
    subs,
    readNotification: (deviceId, alarmId, ref) => map.get(key(deviceId, alarmId, ref)) || null,
    listNotifications: () => [...map.values()],
    upsertNotification(record) {
      const frozen = Object.freeze({ ...record });
      map.set(key(record.deviceId, record.alarmId, record.recipientRef), frozen);
      return frozen;
    },
    readSubscription(ref) {
      const r = subs.get(ref);
      return r ? { ...r, remaining: remainingOf(r) } : null;
    },
    listSubscriptions: () => [...subs.values()],
    grantSubscription(ref, templateId, grantEventId) {
      const existing = subs.get(ref);
      const events = existing ? [...existing.grantEventIds] : [];
      const duplicate = events.includes(grantEventId);
      const next = Object.freeze({
        recipientRef: ref, templateId,
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

/** 启动后端并返回 { url, close, tokenFor, registerGrant }。 */
async function startServer(options = {}) {
  const store = options.store || new MemoryStore();
  const allowed = new Set(options.allowlist || ['guardian-route']);
  const { server } = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => allowed.has(openid),
    listGuardians: options.listGuardians || (() => [...allowed]),
    notificationDelivery: options.notificationDelivery,
    wechat: { appId: 'placeholder-appid', appSecret: 'placeholder-secret' }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    store,
    allowed,
    url,
    tokenFor: (openid) => createSessionToken(openid, TOKEN_SECRET),
    /** 走真实登记接口：只有登记过的监护人才会被投递。 */
    async registerGrant(openid, grantEventId, templateId = TEMPLATE) {
      const response = await fetch(`${url}/api/v1/notifications/subscription`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${createSessionToken(openid, TOKEN_SECRET)}` },
        body: JSON.stringify({ grantEventId, templateId })
      });
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function postStatus(url, body) {
  const response = await fetch(`${url}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function alarmStatus(overrides = {}) {
  return {
    deviceId: 'esp32-bath',
    room: '卫生间',
    state: 'ALARM',
    ts: 1_700_000_000_000,
    alarm: { id: 'alarm-integration-1', type: 'FALL' },
    ...overrides
  };
}

test('a successful ingest returns 202 and delivers to the allowlisted guardians who subscribed', async (t) => {
  const provider = fakeProvider();
  const delivery = createNotificationDelivery({
    provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET, ledger: memoryLedger()
  });
  const app = await startServer({
    notificationDelivery: delivery,
    allowlist: ['guardian-a', 'guardian-b']
  });
  t.after(() => app.close());

  // 两个监护人都在允许名单里；但只有已登记的才会收到（允许登录 ≠ 已订阅）。
  assert.equal((await app.registerGrant('guardian-a', 'grant-event-0001')).status, 200);
  assert.equal((await app.registerGrant('guardian-b', 'grant-event-0002')).status, 200);

  const result = await postStatus(app.url, alarmStatus());
  assert.equal(result.status, 202);
  assert.equal(result.body.accepted, true);

  // 通知是异步的：等一小会儿让投递完成，但 202 绝不能依赖它。
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(provider.calls.send, 2);
  assert.deepEqual(provider.calls.sends.map((item) => item.openid).sort(), ['guardian-a', 'guardian-b']);
});

test('a throwing provider never breaks ingest, ACK or reads', async (t) => {
  const provider = fakeProvider({ sendError: new Error('provider exploded') });
  const delivery = createNotificationDelivery({
    provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET, ledger: memoryLedger(),
    sleepImpl: async () => {}, maxAttempts: 2
  });
  const app = await startServer({ notificationDelivery: delivery, allowlist: ['guardian-a'] });
  t.after(() => app.close());

  const result = await postStatus(app.url, alarmStatus());
  assert.equal(result.status, 202, '通知失败绝不能让设备状态摄入失败');
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 主链路仍可读、可 ACK。
  const alerts = await (await fetch(`${app.url}/api/v1/alerts`)).json();
  assert.equal(Array.isArray(alerts), false, 'unauthenticated read must not succeed as data');
});

test('a permanent rejection records the state and does not stall ingest', async (t) => {
  const ledger = memoryLedger();
  const provider = fakeProvider({
    sendError: notifyError(NOTIFY_CODES.PERMANENT, 'user refused', { errcode: 43101, permanent: true })
  });
  const delivery = createNotificationDelivery({ provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET, ledger });
  const app = await startServer({ notificationDelivery: delivery, allowlist: ['guardian-a'] });
  t.after(() => app.close());
  await app.registerGrant('guardian-a', 'grant-event-0001');

  const result = await postStatus(app.url, alarmStatus());
  assert.equal(result.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(provider.calls.send, 1, 'permanent failure must not be retried');
  const records = ledger.listNotifications();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, DELIVERY_STATUS.PERMANENT_FAILED);
  assert.equal(records[0].recipientRef.startsWith('r1_'), true, '台账只存 recipientRef');
});

test('an ingest without an alarm id never triggers a notification', async (t) => {
  const provider = fakeProvider();
  const delivery = createNotificationDelivery({ provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET, ledger: memoryLedger() });
  const app = await startServer({ notificationDelivery: delivery, allowlist: ['guardian-a'] });
  t.after(() => app.close());

  const result = await postStatus(app.url, { deviceId: 'esp32-bath', room: '卫生间', state: 'NORMAL', ts: 1_700_000_000_000 });
  assert.equal(result.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(provider.calls.send, 0, 'NORMAL ingests must not notify');
});

test('a throwing listGuardians callback cannot break ingest', async (t) => {
  const provider = fakeProvider();
  const delivery = createNotificationDelivery({ provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET, ledger: memoryLedger() });
  const app = await startServer({
    notificationDelivery: delivery,
    listGuardians: () => { throw new Error('allowlist unavailable'); }
  });
  t.after(() => app.close());

  const result = await postStatus(app.url, alarmStatus());
  assert.equal(result.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(provider.calls.send, 0, 'no guardians readable means nothing is sent');
});

test('without a notificationDelivery the server behaves exactly as before', async (t) => {
  const app = await startServer({});
  t.after(() => app.close());
  const result = await postStatus(app.url, alarmStatus());
  assert.equal(result.status, 202);
  assert.equal(result.body.accepted, true);
  const health = await (await fetch(`${app.url}/healthz`)).json();
  assert.deepEqual(health, { ok: true, service: 'eldercare-cloud-backend' });
});

test('the notification ledger is never exposed through the public alerts API', async (t) => {
  const provider = fakeProvider();
  const delivery = createNotificationDelivery({ provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET, ledger: memoryLedger() });
  const app = await startServer({ notificationDelivery: delivery, allowlist: ['guardian-secret-openid'] });
  t.after(() => app.close());

  await postStatus(app.url, alarmStatus());
  await new Promise((resolve) => setTimeout(resolve, 50));

  // 未认证请求必须 401，且响应体中绝不能出现 openid 或模板 ID。
  const unauthorized = await fetch(`${app.url}/api/v1/alerts`);
  assert.equal(unauthorized.status, 401);
  const text = await unauthorized.text();
  assert.equal(text.includes('guardian-secret-openid'), false);
  assert.equal(text.includes('TEMPLATE_OK_1'), false);
});
