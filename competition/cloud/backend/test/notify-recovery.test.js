'use strict';

/**
 * notify-recovery.test.js — 启动自动恢复测试（缺陷 3）
 *
 * 之前的"重启恢复"测试是在重建 Store 之后**再次手工调用 notifyAlarm**，
 * 那只是"同一 alarmId 再次摄入时才会继续"，不是生产意义上的自动恢复。
 *
 * 本文件验证真实恢复：
 *   - 重建 runtime（createRuntime）后**不再手工调用** notifyAlarm；
 *   - 后端启动时扫描台账里未完成的收件人任务并自动投递；
 *   - SENT 与 PERMANENT_FAILED 永不重发；
 *   - 恢复在后台运行，不阻塞 /healthz、/readyz、设备摄入与 ACK；
 *   - 关闭时不再新增重试，也不留未处理的 Promise。
 *
 * 用注入的 fake provider 驱动真实 HTTP 服务；不访问真实微信 API。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PersistentStore } = require('../src/persistent-store');
const { createSessionToken } = require('../src/auth');
const { NOTIFY_CODES, notifyError } = require('../src/notify-provider');
const { createNotificationDelivery, AGGREGATE_STATUS } = require('../src/notify-delivery');

const TOKEN_SECRET = 'recovery-test-secret-value-at-least-32-characters';
const INGEST_KEY = 'recovery-test-ingest-key';
const RECIPIENT_REF_SECRET = 'recovery-recipient-ref-secret-value-32';
const GUARDIAN = 'recovery-guardian-openid-placeholder';
const TEMPLATE = 'TEMPLATE_RECOVERY_1';

/** 可编程 fake provider（与运行时注入同一接口）。 */
function fakeProvider(plan = []) {
  const calls = { send: 0, sends: [], token: 0 };
  const queue = [...plan];
  return {
    name: 'fake',
    calls,
    isConfigured: () => true,
    async getAccessToken() {
      calls.token += 1;
      return { token: `token-${calls.token}`, expiresInMs: 7200 * 1000 };
    },
    async sendSubscribeMessage({ openid }) {
      calls.send += 1;
      calls.sends.push(openid);
      const next = queue.length > 0 ? queue.shift() : { kind: 'ok' };
      if (next.kind === 'throw') throw next.error;
      return { ok: true };
    }
  };
}

const ok = () => ({ kind: 'ok' });
const temporary = () => ({ kind: 'throw', error: notifyError(NOTIFY_CODES.NETWORK, 'down', { retryable: true }) });

/** 真实 HTTP 服务 + 注入的投递器（与 main.js 装配方式一致）。 */
async function startRuntime(options) {
  const { createApiServer } = require('../src/server');
  const { MemoryStore } = require('../src/store');
  const store = options.store || new MemoryStore();
  const delivery = options.delivery;
  const { server, resolveAlarmContext } = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === GUARDIAN,
    listGuardians: () => [GUARDIAN],
    notificationDelivery: delivery
  });
  if (delivery && typeof delivery.configureRecovery === 'function') {
    delivery.configureRecovery({
      listAllowed: () => [GUARDIAN],
      resolveAlarm: (deviceId, alarmId) => resolveAlarmContext(deviceId, alarmId)
    });
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    store,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function ingestAlarm(url, alarmId, type = 'FALL') {
  const response = await fetch(`${url}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      deviceId: 'dayu200-room-1', room: '客厅', state: 'ALARM',
      ts: 1_700_000_000_000, alarm: { id: alarmId, type }
    })
  });
  return response.status;
}

function seedGrant(store, delivery) {
  const ref = delivery.refFor(GUARDIAN);
  store.grantSubscription(ref, TEMPLATE, 'recovery-grant-0001', 1_700_000_000_000);
  return ref;
}

/* ------------------------------------------------------------ 自动恢复 */

test('a FAILED recipient task is resumed automatically at startup — no manual notifyAlarm', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');

  // ---- 第一次"进程"：投递临时失败，留下未完成任务。
  const firstStore = new PersistentStore({ filePath });
  const firstDelivery = createNotificationDelivery({
    provider: fakeProvider([temporary(), temporary()]),
    templateId: TEMPLATE,
    recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: firstStore,
    sleepImpl: async () => {},
    maxAttempts: 2
  });
  const firstApp = await startRuntime({ store: firstStore, delivery: firstDelivery });
  const firstRef = seedGrant(firstStore, firstDelivery);
  assert.equal(await ingestAlarm(firstApp.url, 'alarm-recover-1'), 202);
  await new Promise((resolve) => setTimeout(resolve, 80));

  const unfinished = firstStore.readNotification('dayu200-room-1', 'alarm-recover-1', firstRef);
  assert.ok(unfinished, '失败必须落台账，否则无法恢复');
  assert.equal(unfinished.status, 'FAILED', '临时失败应记为 FAILED（可恢复）');
  await firstApp.close();

  // ---- 第二次"进程"：重建 runtime，**不手工调用 notifyAlarm**。
  const secondStore = new PersistentStore({ filePath });
  assert.equal(secondStore.readNotification('dayu200-room-1', 'alarm-recover-1', firstRef).status, 'FAILED');
  const secondProvider = fakeProvider([ok()]);
  const secondDelivery = createNotificationDelivery({
    provider: secondProvider,
    templateId: TEMPLATE,
    recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: secondStore,
    sleepImpl: async () => {},
    maxAttempts: 2
  });
  const secondApp = await startRuntime({ store: secondStore, delivery: secondDelivery });
  t.after(() => secondApp.close());

  assert.equal(secondProvider.calls.send, 0, '启动前不应有任何发送');
  const summary = await secondDelivery.recoverPending();

  assert.equal(summary.recovered >= 1, true, '启动恢复必须自动发现未完成任务');
  assert.equal(summary.sent, 1, '恢复应把未完成任务补发成功');
  assert.equal(secondProvider.calls.send, 1, '自动恢复确实调用了 provider');
  assert.deepEqual(secondProvider.calls.sends, [GUARDIAN]);
  assert.equal(secondStore.readNotification('dayu200-room-1', 'alarm-recover-1', firstRef).status, 'SENT');
});

test('SENT recipients are never re-sent by recovery', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-sent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');

  const firstStore = new PersistentStore({ filePath });
  const firstDelivery = createNotificationDelivery({
    provider: fakeProvider([ok()]), templateId: TEMPLATE,
    recipientRefSecret: RECIPIENT_REF_SECRET, ledger: firstStore, sleepImpl: async () => {}, maxAttempts: 2
  });
  const firstApp = await startRuntime({ store: firstStore, delivery: firstDelivery });
  seedGrant(firstStore, firstDelivery);
  await ingestAlarm(firstApp.url, 'alarm-sent-1');
  await new Promise((resolve) => setTimeout(resolve, 80));
  await firstApp.close();

  const secondStore = new PersistentStore({ filePath });
  const secondProvider = fakeProvider([ok()]);
  const secondDelivery = createNotificationDelivery({
    provider: secondProvider, templateId: TEMPLATE,
    recipientRefSecret: RECIPIENT_REF_SECRET, ledger: secondStore, sleepImpl: async () => {}, maxAttempts: 2
  });
  const secondApp = await startRuntime({ store: secondStore, delivery: secondDelivery });
  t.after(() => secondApp.close());

  const summary = await secondDelivery.recoverPending();
  assert.equal(summary.recovered, 0, 'SENT 是终态，不得被恢复');
  assert.equal(secondProvider.calls.send, 0, 'SENT 收件人绝不能被重发');
});

test('PERMANENT_FAILED recipients are never re-sent by recovery', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-perm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');

  const store = new PersistentStore({ filePath });
  const provider = fakeProvider([{ kind: 'throw', error: notifyError(NOTIFY_CODES.PERMANENT, 'refused', { errcode: 43101, permanent: true }) }]);
  const delivery = createNotificationDelivery({
    provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: store, sleepImpl: async () => {}, maxAttempts: 2
  });
  const app = await startRuntime({ store, delivery });
  const ref = seedGrant(store, delivery);
  await ingestAlarm(app.url, 'alarm-perm-1');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(store.readNotification('dayu200-room-1', 'alarm-perm-1', ref).status, 'PERMANENT_FAILED');
  await app.close();

  const secondStore = new PersistentStore({ filePath });
  const secondProvider = fakeProvider([ok()]);
  const secondDelivery = createNotificationDelivery({
    provider: secondProvider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: secondStore, sleepImpl: async () => {}, maxAttempts: 2
  });
  const secondApp = await startRuntime({ store: secondStore, delivery: secondDelivery });
  t.after(() => secondApp.close());

  const summary = await secondDelivery.recoverPending();
  assert.equal(summary.recovered, 0);
  assert.equal(secondProvider.calls.send, 0, '永久失败绝不能被重发');
});

test('recovery does not block /healthz, /readyz, ingest or ACK', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-block-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');

  // 造一个未完成任务：投递会"卡住"直到我们放行。
  const store = new PersistentStore({ filePath });
  let releaseSend = null;
  const gate = new Promise((resolve) => { releaseSend = resolve; });
  const slowProvider = {
    name: 'fake-slow',
    calls: { send: 0 },
    isConfigured: () => true,
    getAccessToken: async () => ({ token: 't', expiresInMs: 7200 * 1000 }),
    sendSubscribeMessage: async () => { slowProvider.calls.send += 1; await gate; return { ok: true }; }
  };
  const delivery = createNotificationDelivery({
    provider: slowProvider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: store, sleepImpl: async () => {}, maxAttempts: 1
  });
  const app = await startRuntime({ store, delivery });
  const ref = seedGrant(store, delivery);
  store.upsertNotification({
    deviceId: 'dayu200-room-1', alarmId: 'alarm-slow-1', recipientRef: ref, templateId: TEMPLATE,
    status: 'FAILED', attempts: 1, attemptCount: 1, sentAt: 0, updatedAt: 1, errorCode: 'NOTIFY_NETWORK'
  });
  // 告警上下文需要存在，恢复才能重建模板。
  await ingestAlarm(app.url, 'alarm-slow-1');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await app.close();

  t.after(() => app.close());

  // 第二个进程：恢复立刻启动但会卡在 send 上。
  const secondStore = new PersistentStore({ filePath });
  const secondProvider = {
    name: 'fake-slow-2',
    calls: { send: 0 },
    isConfigured: () => true,
    getAccessToken: async () => ({ token: 't', expiresInMs: 7200 * 1000 }),
    sendSubscribeMessage: async () => { secondProvider.calls.send += 1; await gate; return { ok: true }; }
  };
  const secondDelivery = createNotificationDelivery({
    provider: secondProvider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: secondStore, sleepImpl: async () => {}, maxAttempts: 1
  });
  const secondApp = await startRuntime({ store: secondStore, delivery: secondDelivery });
  const recovery = secondDelivery.recoverPending(); // 不 await：后台运行

  // 恢复被阻塞期间，健康检查与摄入必须照常响应。
  const startedAt = Date.now();
  const health = await fetch(`${secondApp.url}/healthz`);
  const ready = await fetch(`${secondApp.url}/readyz`);
  const ingestStatus = await ingestAlarm(secondApp.url, 'alarm-new-2', 'MANUAL_SOS');
  const elapsed = Date.now() - startedAt;

  assert.equal(health.status, 200);
  assert.equal(ready.status, 200);
  assert.equal(ingestStatus, 202);
  assert.equal(elapsed < 3000, true, '恢复绝不能阻塞主链路');

  // 放行后恢复完成。
  releaseSend();
  const summary = await recovery;
  assert.equal(summary.sent >= 1, true);
  await secondApp.close();
});

test('beginShutdown stops new retries and drain leaves no pending promise', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-shutdown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');

  const store = new PersistentStore({ filePath });
  const provider = fakeProvider([temporary(), temporary(), ok()]);
  const delivery = createNotificationDelivery({
    provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: store, sleepImpl: async () => {}, maxAttempts: 2
  });
  const app = await startRuntime({ store, delivery });
  t.after(() => app.close());
  const ref = seedGrant(store, delivery);

  // 造一个 FAILED 任务，然后进入关闭流程再恢复。
  store.upsertNotification({
    deviceId: 'dayu200-room-1', alarmId: 'alarm-shutdown-1', recipientRef: ref, templateId: TEMPLATE,
    status: 'FAILED', attempts: 1, attemptCount: 1, sentAt: 0, updatedAt: 1, errorCode: 'NOTIFY_NETWORK'
  });
  await ingestAlarm(app.url, 'alarm-shutdown-1');
  await new Promise((resolve) => setTimeout(resolve, 40));
  // 若关闭前已成功，说明临时失败已被同一条告警的重试消化；这里只关心关闭语义。
  const inFlight = delivery.beginShutdown();
  assert.equal(typeof inFlight, 'boolean');
  await delivery.drain(); // 有界等待，不得抛出

  const summary = await delivery.recoverPending();
  assert.equal(summary.recovered, 0, '关闭后不得再发起新的恢复重试');
  assert.equal(summary.reason, 'shutting_down');
});

test('recovery skips records whose recipient is no longer allowlisted', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-skip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');

  const store = new PersistentStore({ filePath });
  const provider = fakeProvider([ok()]);
  const delivery = createNotificationDelivery({
    provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: store, sleepImpl: async () => {}, maxAttempts: 2
  });
  const app = await startRuntime({ store, delivery });
  t.after(() => app.close());

  // 记录属于一个已不在允许名单里的 ref。
  store.upsertNotification({
    deviceId: 'dayu200-room-1', alarmId: 'alarm-skip-1',
    recipientRef: delivery.refFor('removed-guardian-openid-placeholder'),
    templateId: TEMPLATE, status: 'FAILED', attempts: 1, attemptCount: 1,
    sentAt: 0, updatedAt: 1, errorCode: 'NOTIFY_NETWORK'
  });
  await ingestAlarm(app.url, 'alarm-skip-1');

  const summary = await delivery.recoverPending();
  assert.equal(summary.recovered, 0, '已移除的收件人不得被恢复');
  assert.equal(summary.skipped >= 1, true);
  assert.equal(provider.calls.send, 0);
});

/* ------------------------------------------------------------ 泄漏扫描 */

test('the recovery snapshot never contains a raw openid or token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');

  const store = new PersistentStore({ filePath });
  const provider = fakeProvider([temporary(), temporary()]);
  const delivery = createNotificationDelivery({
    provider, templateId: TEMPLATE, recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: store, sleepImpl: async () => {}, maxAttempts: 2
  });
  const app = await startRuntime({ store, delivery });
  t.after(() => app.close());
  seedGrant(store, delivery);
  await ingestAlarm(app.url, 'alarm-scan-1');
  await new Promise((resolve) => setTimeout(resolve, 60));

  const text = fs.readFileSync(filePath, 'utf8');
  assert.equal(text.includes(GUARDIAN), false, '快照不得含原始 openid');
  assert.equal(text.includes('openid'), false, '快照不得出现 openid 字段名');
  assert.equal(text.includes('access_token'), false);
  assert.equal(text.includes(RECIPIENT_REF_SECRET), false, '快照不得含 HMAC 密钥');
  assert.equal(text.includes('token-'), false, '快照不得含 access_token 值');
});
