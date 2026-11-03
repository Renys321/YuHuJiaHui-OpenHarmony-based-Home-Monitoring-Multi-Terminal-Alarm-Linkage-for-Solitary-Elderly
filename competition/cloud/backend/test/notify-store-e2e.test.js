'use strict';

/**
 * notify-store-e2e.test.js — 真实 PersistentStore + 真实投递器的端到端测试
 *
 * 目的：前面的多收件人/授权/恢复测试都用了内存台账替身。内存替身可能比真实实现"宽容"，
 * 因此这里用**真实 PersistentStore** 跑一遍关键路径，确保：
 *   - 生产装配（grant → toRecipients → notifyAlarm）在真实存储上成立；
 *   - 按 recipientRef 的幂等键在真实快照里生效；
 *   - 整个快照文本不含原始 openid、token 或 HMAC 密钥。
 *
 * fake provider only；不访问真实微信 API。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PersistentStore, SCHEMA_VERSION } = require('../src/persistent-store');
const { NOTIFY_CODES, notifyError } = require('../src/notify-provider');
const { createNotificationDelivery, AGGREGATE_STATUS, DELIVERY_STATUS } = require('../src/notify-delivery');

const RECIPIENT_REF_SECRET = 'e2e-recipient-ref-secret-value-at-least-32';
const TEMPLATE = 'TEMPLATE_E2E_1';
const GUARDIAN_A = 'e2e-guardian-openid-placeholder-a';
const GUARDIAN_B = 'e2e-guardian-openid-placeholder-b';

function fakeProvider(plan = []) {
  const calls = { send: 0, sends: [] };
  const queue = [...plan];
  return {
    name: 'fake',
    calls,
    isConfigured: () => true,
    getAccessToken: async () => ({ token: 'access-token-value-1', expiresInMs: 7200 * 1000 }),
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

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');
  return { filePath, store: new PersistentStore({ filePath }) };
}

function deliveryFor(store, provider, extra = {}) {
  return createNotificationDelivery({
    provider,
    templateId: TEMPLATE,
    recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: store,
    sleepImpl: async () => {},
    maxAttempts: 3,
    ...extra
  });
}

const alarm = (alarmId) => ({
  deviceId: 'dayu200-room-1', alarmId, room: '客厅', type: 'FALL', createdAt: 1_700_000_000_000
});

test('grant → toRecipients → notifyAlarm works against the real store', async (t) => {
  const { store } = tempStore(t);
  const provider = fakeProvider();
  const delivery = deliveryFor(store, provider);

  // 允许登录 ≠ 已订阅：只有登记过的才是收件人。
  assert.deepEqual(delivery.toRecipients([GUARDIAN_A, GUARDIAN_B]), [], '没人登记时没有收件人');

  assert.equal(delivery.recordSubscription(GUARDIAN_A, 'grant-event-0001').ok, true);
  const recipients = delivery.toRecipients([GUARDIAN_A, GUARDIAN_B]);
  assert.equal(recipients.length, 1, '只有已登记的 A 是可投递收件人');
  assert.equal(recipients[0].openid, GUARDIAN_A);
  assert.equal(recipients[0].remaining, 1);

  const result = await delivery.notifyAlarm(alarm('alarm-e2e-1'), recipients);
  assert.equal(result.status, AGGREGATE_STATUS.ALL_SENT);
  assert.deepEqual(provider.calls.sends, [GUARDIAN_A]);

  // 真实 store：额度被消耗，台账按 recipientRef 记录。
  const refA = delivery.refFor(GUARDIAN_A);
  const grant = store.readSubscription(refA);
  assert.equal(grant.totalGranted, 1);
  assert.equal(grant.consumed, 1);
  assert.equal(store.readNotification('dayu200-room-1', 'alarm-e2e-1', refA).status, DELIVERY_STATUS.SENT);
  assert.deepEqual(delivery.toRecipients([GUARDIAN_A]), [], '额度用完后不再是收件人');
});

test('the a,b,a,b duplicate-send defect is gone with the real store', async (t) => {
  const { store } = tempStore(t);
  const provider = fakeProvider([ok(), temporary(), ok()]);
  const delivery = deliveryFor(store, provider);

  delivery.recordSubscription(GUARDIAN_A, 'grant-event-0001');
  delivery.recordSubscription(GUARDIAN_B, 'grant-event-0002');
  const result = await delivery.notifyAlarm(alarm('alarm-e2e-2'), delivery.toRecipients([GUARDIAN_A, GUARDIAN_B]));

  assert.deepEqual(provider.calls.sends, [GUARDIAN_A, GUARDIAN_B, GUARDIAN_B],
    'a 成功后不得重发；只重试失败的 b');
  assert.equal(result.status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(provider.calls.sends.filter((item) => item === GUARDIAN_A).length, 1);
});

test('a permanent failure for one recipient does not block the other (real store)', async (t) => {
  const { store } = tempStore(t);
  const provider = fakeProvider([
    { kind: 'throw', error: notifyError(NOTIFY_CODES.PERMANENT, 'refused', { errcode: 43101, permanent: true }) },
    ok()
  ]);
  const delivery = deliveryFor(store, provider);
  delivery.recordSubscription(GUARDIAN_A, 'grant-event-0001');
  delivery.recordSubscription(GUARDIAN_B, 'grant-event-0002');

  const result = await delivery.notifyAlarm(alarm('alarm-e2e-3'), delivery.toRecipients([GUARDIAN_A, GUARDIAN_B]));
  assert.deepEqual(provider.calls.sends, [GUARDIAN_A, GUARDIAN_B], 'b 必须仍然收到');
  assert.equal(result.status, AGGREGATE_STATUS.PARTIAL);

  const refA = delivery.refFor(GUARDIAN_A);
  const refB = delivery.refFor(GUARDIAN_B);
  assert.equal(store.readNotification('dayu200-room-1', 'alarm-e2e-3', refA).status, DELIVERY_STATUS.PERMANENT_FAILED);
  assert.equal(store.readNotification('dayu200-room-1', 'alarm-e2e-3', refB).status, DELIVERY_STATUS.SENT);
  assert.equal(store.readSubscription(refA).revoked, 1, '43101 把 A 的本地额度校正为 0');
  assert.equal(store.readSubscription(refB).consumed, 1);
  assert.deepEqual(
    delivery.toRecipients([GUARDIAN_A]),
    [],
    '43101 作废额度后，A 不得在下一条新告警中再次进入发送名单'
  );
});

test('per-recipient state survives a real store restart and never carries an openid', async (t) => {
  const { filePath, store } = tempStore(t);
  const provider = fakeProvider([ok(), temporary(), temporary()]);
  const delivery = deliveryFor(store, provider, { maxAttempts: 2 });
  delivery.recordSubscription(GUARDIAN_A, 'grant-event-0001');
  delivery.recordSubscription(GUARDIAN_B, 'grant-event-0002');

  const first = await delivery.notifyAlarm(alarm('alarm-e2e-4'), delivery.toRecipients([GUARDIAN_A, GUARDIAN_B]));
  assert.equal(first.status, AGGREGATE_STATUS.PARTIAL);

  // 重启：新 store + 新 delivery。
  const reloaded = new PersistentStore({ filePath });
  const refA = delivery.refFor(GUARDIAN_A);
  const refB = delivery.refFor(GUARDIAN_B);
  assert.equal(reloaded.readNotification('dayu200-room-1', 'alarm-e2e-4', refA).status, DELIVERY_STATUS.SENT);
  assert.equal(reloaded.readNotification('dayu200-room-1', 'alarm-e2e-4', refB).status, DELIVERY_STATUS.FAILED);

  const secondProvider = fakeProvider([ok()]);
  const secondDelivery = deliveryFor(reloaded, secondProvider);
  const second = await secondDelivery.notifyAlarm(alarm('alarm-e2e-4'), secondDelivery.toRecipients([GUARDIAN_A, GUARDIAN_B]));
  assert.equal(second.status, AGGREGATE_STATUS.ALL_SENT);
  assert.deepEqual(secondProvider.calls.sends, [GUARDIAN_B], 'A 已 SENT，重启后不得重发');

  // 快照全文隐私扫描。
  const text = fs.readFileSync(filePath, 'utf8');
  assert.equal(text.includes(GUARDIAN_A), false, '快照不得含原始 openid');
  assert.equal(text.includes(GUARDIAN_B), false, '快照不得含原始 openid');
  assert.equal(text.includes('openid'), false, '快照不得出现 openid 字段名');
  assert.equal(text.includes('access-token-value-1'), false, '快照不得含 access_token');
  assert.equal(text.includes(RECIPIENT_REF_SECRET), false, '快照不得含 HMAC 密钥');
  assert.equal(JSON.parse(text).schemaVersion, SCHEMA_VERSION);
});

test('no authorized recipient means NO_RECIPIENTS and nothing is persisted', async (t) => {
  const { store } = tempStore(t);
  const provider = fakeProvider();
  const delivery = deliveryFor(store, provider);
  const result = await delivery.notifyAlarm(alarm('alarm-e2e-5'), delivery.toRecipients([GUARDIAN_A]));
  assert.equal(result.status, AGGREGATE_STATUS.NO_RECIPIENTS);
  assert.equal(provider.calls.send, 0);
  assert.equal(store.countNotifications(), 0);
  assert.equal(store.countSubscriptions(), 0);
});

test('an accept registered twice via different grant events only grants quota twice', async (t) => {
  const { store } = tempStore(t);
  const delivery = deliveryFor(store, fakeProvider());

  const first = delivery.recordSubscription(GUARDIAN_A, 'grant-event-0001');
  assert.equal(first.remaining, 1);
  const duplicate = delivery.recordSubscription(GUARDIAN_A, 'grant-event-0001');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.remaining, 1, '同一次 accept 重复登记不得增加额度');
  const second = delivery.recordSubscription(GUARDIAN_A, 'grant-event-0002');
  assert.equal(second.remaining, 2, '新的 accept 才增加额度');

  // 重启后额度保持。
  const reloaded = new PersistentStore({ filePath: store.filePath });
  const ref = delivery.refFor(GUARDIAN_A);
  const restored = reloaded.readSubscription(ref);
  assert.equal(restored.totalGranted, 2);
  assert.equal(restored.consumed, 0);
});
