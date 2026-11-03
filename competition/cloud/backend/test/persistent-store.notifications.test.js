'use strict';

/**
 * persistent-store.notifications.test.js — 通知投递账本（schema v4）单元测试
 *
 * 覆盖：v1/v2/v3 快照向后兼容、v4 记录重启后逐字节往返、按收件人的交付键唯一性、
 * 字段与字符集严格校验（含 openid 等隐私字段回归防护）、upsert 幂等、
 * 写失败内存回滚、500 条上限按 updatedAt 淘汰。
 * 全部使用系统临时目录，测试结束后递归清理；不依赖网络、真实账号或微信服务。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PersistentStore, SCHEMA_VERSION, SNAPSHOT_KEYS } = require('../src/persistent-store');

/** v4 起投递记录按 recipientRef 独立：幂等键是 deviceId + alarmId + recipientRef。 */
const RECIPIENT_REF_A = 'r1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RECIPIENT_REF_B = 'r1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const NOTIFICATION_FIELD_NAMES = [
  'alarmId', 'attemptCount', 'attempts', 'deviceId', 'errorCode', 'recipientRef', 'sentAt', 'status', 'templateId', 'updatedAt'
];

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-store-notifications-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 最小合法快照；默认不带 `notifications` 键，用来模拟 v1/v2 旧文件。 */
function baseDocument(schemaVersion, extra = {}) {
  return Object.assign({
    schemaVersion,
    savedAt: 1_700_000_000_000,
    devices: [],
    alerts: [],
    commands: [],
    contacts: []
  }, extra);
}

function notificationRecord(overrides = {}) {
  return Object.assign({
    deviceId: 'dev-notify-1',
    alarmId: 'alarm-notify-1',
    recipientRef: RECIPIENT_REF_A,
    templateId: 'FALL_ALERT_TEMPLATE',
    status: 'SENT',
    attempts: 1,
    attemptCount: 1,
    sentAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    errorCode: ''
  }, overrides);
}

function writeDocument(filePath, document) {
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
}

/** 只写盘、不 fsync 的注入写入器，用于需要数百次落盘的场景（保持文件真实可解析）。 */
function fastAtomicWriter(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}

/* ------------------------------------------------------------ 向后兼容 */

test('loads a v2 snapshot without notifications and writes the current schema with an empty ledger', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  writeDocument(filePath, baseDocument(2));

  const store = new PersistentStore({ filePath });
  assert.equal(store.countNotifications(), 0, '缺失 notifications 键必须视为空账本');
  assert.deepEqual(store.listNotifications(), []);
  assert.equal(store.readNotification('dev-notify-1', 'alarm-notify-1', RECIPIENT_REF_A), null);

  store.ingest({ deviceId: 'dev-1', room: '客厅', state: 'NORMAL', ts: 1_700_000_000_100 });

  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(document.notifications, [], '写回时 notifications 必须是显式空数组');
  assert.deepEqual(Object.keys(document).sort(), [...SNAPSHOT_KEYS].sort());
});

test('loads a v1 snapshot without notifications and keeps the empty ledger', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  writeDocument(filePath, baseDocument(1));

  const store = new PersistentStore({ filePath });
  assert.equal(store.countNotifications(), 0);
  store.ingest({ deviceId: 'dev-1', room: '客厅', state: 'NORMAL', ts: 1_700_000_000_100 });
  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(document.notifications, []);
});

/* ------------------------------------------------------------ 重启往返 */

test('round-trips a valid v4 notification record through a restart', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const record = notificationRecord({
    status: 'FAILED',
    attempts: 2,
    attemptCount: 2,
    sentAt: 0,
    updatedAt: 1_700_000_000_500,
    errorCode: 'WECHAT_API_ERROR'
  });
  writeDocument(filePath, baseDocument(SCHEMA_VERSION, { notifications: [record] }));

  const first = new PersistentStore({ filePath });
  assert.deepEqual(first.readNotification(record.deviceId, record.alarmId, record.recipientRef), Object.freeze({ ...record }));
  assert.equal(first.countNotifications(), 1);

  // 同一条记录幂等重写：磁盘上的 notifications 数组必须逐字节不变。
  first.upsertNotification({ ...record });
  const afterUpsert = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(afterUpsert.schemaVersion, SCHEMA_VERSION);
  assert.equal(JSON.stringify(afterUpsert.notifications), JSON.stringify([record]));

  const second = new PersistentStore({ filePath });
  assert.equal(second.countNotifications(), 1);
  assert.deepEqual(second.listNotifications(), [Object.freeze({ ...record })]);
  assert.deepEqual(second.readNotification(record.deviceId, record.alarmId, record.recipientRef), Object.freeze({ ...record }));
  assert.equal(second.readNotification('dev-notify-1', 'alarm-missing', RECIPIENT_REF_A), null);
});

/* ------------------------------------------------------------ 严格校验 */

test('rejects a duplicate (deviceId, alarmId, recipientRef) delivery key as corrupt', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const record = notificationRecord();
  writeDocument(filePath, baseDocument(SCHEMA_VERSION, {
    notifications: [record, { ...record, updatedAt: 1_700_000_000_100 }]
  }));

  assert.throws(() => new PersistentStore({ filePath }), /duplicate notification delivery key/);
});

test('rejects invalid notification fields as corrupt', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const write = (overrides) => writeDocument(filePath, baseDocument(SCHEMA_VERSION, {
    notifications: [notificationRecord(overrides)]
  }));

  write({ templateId: 'bad template!' });
  assert.throws(() => new PersistentStore({ filePath }), /notification\[0\]\.templateId/);
  write({ templateId: '' });
  assert.throws(() => new PersistentStore({ filePath }), /templateId/);
  write({ templateId: 'x'.repeat(65) });
  assert.throws(() => new PersistentStore({ filePath }), /templateId/);

  write({ status: 'PENDING' });
  assert.throws(() => new PersistentStore({ filePath }), /notification\[0\]\.status/);
  write({ status: 'sent' });
  assert.throws(() => new PersistentStore({ filePath }), /status/);

  write({ attempts: 0 });
  assert.throws(() => new PersistentStore({ filePath }), /attempts/);
  write({ attempts: -2 });
  assert.throws(() => new PersistentStore({ filePath }), /attempts/);
  write({ attempts: 1.5 });
  assert.throws(() => new PersistentStore({ filePath }), /attempts/);
  write({ attemptCount: -1 });
  assert.throws(() => new PersistentStore({ filePath }), /attemptCount/);
  write({ attemptCount: '2' });
  assert.throws(() => new PersistentStore({ filePath }), /attemptCount/);

  write({ sentAt: -1 });
  assert.throws(() => new PersistentStore({ filePath }), /sentAt/);
  write({ updatedAt: 1.5 });
  assert.throws(() => new PersistentStore({ filePath }), /updatedAt/);

  write({ errorCode: 'lower_case' });
  assert.throws(() => new PersistentStore({ filePath }), /errorCode/);
  write({ deviceId: 'bad device' });
  assert.throws(() => new PersistentStore({ filePath }), /deviceId/);
  write({ alarmId: 'bad alarm!' });
  assert.throws(() => new PersistentStore({ filePath }), /alarmId/);
  write({ status: 'SENT', attempts: 1, attemptCount: 1 });
  assert.doesNotThrow(() => new PersistentStore({ filePath }));
});

test('rejects notification records carrying unknown identity fields (privacy guard)', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const write = (overrides) => writeDocument(filePath, baseDocument(SCHEMA_VERSION, {
    notifications: [notificationRecord(overrides)]
  }));

  write({ openid: 'o-privacy-marker' });
  assert.throws(() => new PersistentStore({ filePath }), /unknown field openid/);
  write({ unionid: 'u-privacy-marker' });
  assert.throws(() => new PersistentStore({ filePath }), /unknown field unionid/);
  write({ appSecret: 'WECHAT_SECRET_MARKER_9f3a' });
  assert.throws(() => new PersistentStore({ filePath }), /unknown field appSecret/);
  write({ sessionToken: 'SESSION_TOKEN_MARKER_9f3a' });
  assert.throws(() => new PersistentStore({ filePath }), /unknown field sessionToken/);
  write({ phone: '+86 13800000000' });
  assert.throws(() => new PersistentStore({ filePath }), /unknown field phone/);

  // 未知顶层字段仍然被拒绝（通知账本不得放宽白名单）。
  writeDocument(filePath, baseDocument(SCHEMA_VERSION, { notifications: [], sessionToken: 'SESSION_TOKEN_MARKER_9f3a' }));
  assert.throws(() => new PersistentStore({ filePath }), /unknown top-level field/);
});

/* ------------------------------------------------------------ upsert 语义 */

test('upsertNotification keeps exactly one entry per delivery key and updates fields', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const store = new PersistentStore({ filePath });

  const sent = store.upsertNotification(notificationRecord());
  assert.equal(sent.status, 'SENT');
  assert.equal(Object.isFrozen(sent), true, '返回的记录必须冻结');
  assert.equal(store.countNotifications(), 1);
  assert.equal(fs.existsSync(filePath), true, 'upsert 成功后必须落盘');

  const updated = store.upsertNotification(notificationRecord({
    status: 'PERMANENT_FAILED',
    attempts: 2,
    attemptCount: 3,
    sentAt: 0,
    updatedAt: 1_700_000_001_000,
    errorCode: 'WECHAT_TEMPLATE_REJECTED'
  }));
  assert.equal(store.countNotifications(), 1, '同一交付键只能保留一条记录');
  assert.equal(store.listNotifications().length, 1);
  assert.equal(store.readNotification('dev-notify-1', 'alarm-notify-1', RECIPIENT_REF_A).status, 'PERMANENT_FAILED');
  assert.equal(store.readNotification('dev-notify-1', 'alarm-notify-1', RECIPIENT_REF_A).attemptCount, 3);
  assert.equal(updated.attempts, 2);

  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.countNotifications(), 1);
  assert.deepEqual(reloaded.readNotification('dev-notify-1', 'alarm-notify-1', RECIPIENT_REF_A), updated);
  assert.deepEqual(reloaded.listNotifications(), [updated]);

  // 非法记录不得改变任何状态。
  assert.throws(() => store.upsertNotification({ ...notificationRecord(), status: 'RETRYING' }), /invalid notification/);
  assert.throws(() => store.upsertNotification({ ...notificationRecord(), attempts: 0 }), /invalid notification/);
  assert.throws(() => store.upsertNotification({ ...notificationRecord(), openid: 'o-marker' }), /unknown field openid/);
  assert.throws(() => store.upsertNotification(null), /must be an object/);
  assert.equal(store.countNotifications(), 1, '非法输入不得写入或改写账本');

  // 不同 deviceId 或不同 alarmId 是新的一条；插入顺序稳定。
  store.upsertNotification(notificationRecord({ alarmId: 'alarm-notify-2' }));
  store.upsertNotification(notificationRecord({ deviceId: 'dev-notify-2' }));
  assert.equal(store.countNotifications(), 3);
  assert.deepEqual(store.listNotifications().map((item) => `${item.deviceId}/${item.alarmId}`), [
    'dev-notify-1/alarm-notify-1',
    'dev-notify-1/alarm-notify-2',
    'dev-notify-2/alarm-notify-1'
  ]);

  // 非字符串查询参数不得抛错，直接视为不存在。
  assert.equal(store.readNotification(undefined, 'alarm-notify-1', RECIPIENT_REF_A), null);
  assert.equal(store.readNotification('dev-notify-1', 42, RECIPIENT_REF_A), null);
});

/* ------------------------------------------------------------ 写失败回滚 */

test('rolls back in-memory notification state when the atomic write fails', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  let failing = false;
  const store = new PersistentStore({
    filePath,
    atomicWriter: (target, text) => {
      if (failing) throw new Error('disk full');
      fastAtomicWriter(target, text);
    }
  });

  const sent = store.upsertNotification(notificationRecord());
  const before = fs.readFileSync(filePath, 'utf8');

  failing = true;
  assert.throws(() => store.upsertNotification(notificationRecord({
    status: 'FAILED',
    attempts: 2,
    attemptCount: 2,
    updatedAt: 1_700_000_002_000,
    errorCode: 'WECHAT_API_ERROR'
  })), /disk full/);

  const restored = store.readNotification('dev-notify-1', 'alarm-notify-1', RECIPIENT_REF_A);
  assert.deepEqual(restored, sent, '写失败必须回滚到失败前的记录');
  assert.equal(restored.status, 'SENT');
  assert.equal(store.countNotifications(), 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before, '写失败不得产生虚假持久状态');

  // 失败的新交付键不得留在内存里。
  assert.throws(() => store.upsertNotification(notificationRecord({ alarmId: 'alarm-notify-9' })), /disk full/);
  assert.equal(store.readNotification('dev-notify-1', 'alarm-notify-9', RECIPIENT_REF_A), null);
  assert.equal(store.countNotifications(), 1);

  failing = false;
  const retried = store.upsertNotification(notificationRecord({
    status: 'FAILED',
    attempts: 2,
    attemptCount: 2,
    updatedAt: 1_700_000_002_000,
    errorCode: 'WECHAT_API_ERROR'
  }));
  assert.equal(retried.status, 'FAILED');
  assert.deepEqual(
    new PersistentStore({ filePath }).readNotification('dev-notify-1', 'alarm-notify-1', RECIPIENT_REF_A),
    retried
  );
});

/* ------------------------------------------------------------ 上限淘汰 */

test('caps the ledger at 500 entries and drops the oldest by updatedAt', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const store = new PersistentStore({ filePath, atomicWriter: fastAtomicWriter });

  // 插入顺序与 updatedAt 顺序恰好相反：最早插入的 updatedAt 最大，最后插入的最小。
  for (let index = 0; index < 500; index += 1) {
    store.upsertNotification(notificationRecord({
      alarmId: `alarm-cap-${String(index).padStart(4, '0')}`,
      updatedAt: 1_000_000 - index
    }));
  }
  assert.equal(store.countNotifications(), 500);
  assert.equal(store.readNotification('dev-notify-1', 'alarm-cap-0000', RECIPIENT_REF_A).updatedAt, 1_000_000);
  assert.equal(store.readNotification('dev-notify-1', 'alarm-cap-0499', RECIPIENT_REF_A).updatedAt, 999_501);

  // 第 501 条：必须淘汰 updatedAt 最小的 alarm-cap-0499，而不是最早插入的 alarm-cap-0000。
  store.upsertNotification(notificationRecord({ alarmId: 'alarm-cap-0500', updatedAt: 2_000_000 }));
  assert.equal(store.countNotifications(), 500);
  assert.equal(store.readNotification('dev-notify-1', 'alarm-cap-0499', RECIPIENT_REF_A), null, '必须按 updatedAt 淘汰最旧记录');
  assert.equal(store.readNotification('dev-notify-1', 'alarm-cap-0000', RECIPIENT_REF_A).attemptCount, 1);
  assert.equal(store.readNotification('dev-notify-1', 'alarm-cap-0500', RECIPIENT_REF_A).updatedAt, 2_000_000);

  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.equal(document.notifications.length, 500, '落盘也必须遵守上限');
  assert.equal(document.notifications.some((item) => item.alarmId === 'alarm-cap-0499'), false);
  assert.equal(document.notifications.some((item) => item.alarmId === 'alarm-cap-0500'), true);

  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.countNotifications(), 500);
  assert.equal(reloaded.readNotification('dev-notify-1', 'alarm-cap-0499', RECIPIENT_REF_A), null);
  assert.equal(reloaded.readNotification('dev-notify-1', 'alarm-cap-0500', RECIPIENT_REF_A).updatedAt, 2_000_000);

  // 上限内重复 upsert 同一条不得增长。
  reloaded.upsertNotification(notificationRecord({ alarmId: 'alarm-cap-0500', updatedAt: 2_000_000 }));
  assert.equal(reloaded.countNotifications(), 500);
});

/* ------------------------------------------------------------ 隐私防泄漏 */

test('never writes openid/unionid markers into the snapshot text', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const store = new PersistentStore({ filePath });

  assert.throws(() => store.upsertNotification({ ...notificationRecord(), openid: 'OPENID_MARKER_9f3a' }),
    /unknown field openid/);

  store.upsertNotification(notificationRecord({
    status: 'FAILED',
    attempts: 2,
    attemptCount: 2,
    updatedAt: 1_700_000_003_000,
    errorCode: 'WECHAT_API_ERROR'
  }));
  store.ingest({
    deviceId: 'dev-notify-1',
    room: '客厅',
    state: 'ALARM',
    ts: 1_700_000_000_000,
    alarm: { id: 'alarm-notify-1', type: 'MANUAL_SOS' }
  });
  store.requestAck('alarm-notify-1', '确认', 'household-member');

  const text = fs.readFileSync(filePath, 'utf8');
  assert.equal(text.includes('openid'), false, '快照 JSON 不得包含 openid');
  assert.equal(text.includes('unionid'), false, '快照 JSON 不得包含 unionid');
  assert.equal(text.includes('OPENID_MARKER_9f3a'), false);
  assert.equal(text.includes('WECHAT_SECRET_MARKER_9f3a'), false);

  const document = JSON.parse(text);
  assert.equal(document.notifications.length, 1);
  assert.deepEqual(Object.keys(document.notifications[0]).sort(), NOTIFICATION_FIELD_NAMES);
});

/* ------------------------------------------------------------ 订阅授权账本（v4） */

test('grant events accumulate quota, are idempotent, and survive a restart', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const store = new PersistentStore({ filePath });

  const first = store.grantSubscription(RECIPIENT_REF_A, 'FALL_ALERT_TEMPLATE', 'grant-event-0001', 1_700_000_000_000);
  assert.equal(first.duplicate, false);
  assert.equal(first.remaining, 1);
  assert.equal(first.record.totalGranted, 1);
  assert.equal(first.record.consumed, 0);
  assert.equal(first.record.revoked, 0);

  // 同一个 grant event 重复登记：幂等，不增加额度。
  const again = store.grantSubscription(RECIPIENT_REF_A, 'FALL_ALERT_TEMPLATE', 'grant-event-0001', 1_700_000_000_100);
  assert.equal(again.duplicate, true);
  assert.equal(again.remaining, 1);
  assert.equal(again.record.totalGranted, 1);

  // 新的一次 accept：额度 +1。
  const second = store.grantSubscription(RECIPIENT_REF_A, 'FALL_ALERT_TEMPLATE', 'grant-event-0002', 1_700_000_000_200);
  assert.equal(second.duplicate, false);
  assert.equal(second.remaining, 2);

  // 不同收件人各自独立。
  store.grantSubscription(RECIPIENT_REF_B, 'FALL_ALERT_TEMPLATE', 'grant-event-0003', 1_700_000_000_300);
  assert.equal(store.countSubscriptions(), 2);

  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.countSubscriptions(), 2);
  const restored = reloaded.readSubscription(RECIPIENT_REF_A);
  assert.equal(restored.totalGranted, 2);
  assert.equal(restored.grantEventIds.length, 2);
  assert.equal(reloaded.readSubscription(RECIPIENT_REF_B).totalGranted, 1);
});

test('consumeSubscription decrements quota and never goes negative', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const store = new PersistentStore({ filePath });
  store.grantSubscription(RECIPIENT_REF_A, 'FALL_ALERT_TEMPLATE', 'grant-event-0001', 1);

  assert.deepEqual(store.consumeSubscription(RECIPIENT_REF_A, 2), { ok: true, remaining: 0 });
  assert.deepEqual(store.consumeSubscription(RECIPIENT_REF_A, 3), { ok: false, reason: 'no_quota', remaining: 0 });
  assert.equal(store.readSubscription(RECIPIENT_REF_A).consumed, 1, '额度绝不能被消耗成负数');
  assert.deepEqual(store.consumeSubscription('r1_unknown-recipient-value-0000000000000000', 4),
    { ok: false, reason: 'no_grant', remaining: 0 });
});

test('revokeSubscriptionQuota zeroes remaining without faking a consumption', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const store = new PersistentStore({ filePath });
  store.grantSubscription(RECIPIENT_REF_A, 'FALL_ALERT_TEMPLATE', 'grant-event-0001', 1);
  store.grantSubscription(RECIPIENT_REF_A, 'FALL_ALERT_TEMPLATE', 'grant-event-0002', 2);

  const revoked = store.revokeSubscriptionQuota(RECIPIENT_REF_A, 3);
  assert.equal(revoked.revoked, 2, '用独立的 revoked 计数');
  assert.equal(revoked.consumed, 0, '永久拒收不是一次成功发送');
  assert.equal(revoked.totalGranted - revoked.consumed - revoked.revoked, 0, '可用额度必须归零');

  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.readSubscription(RECIPIENT_REF_A).revoked, 2);
  // 已归零后再 revoke 是幂等的。
  assert.equal(reloaded.revokeSubscriptionQuota(RECIPIENT_REF_A, 4).revoked, 2);
});

test('subscription records reject openid and other unknown fields', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const store = new PersistentStore({ filePath });
  store.grantSubscription(RECIPIENT_REF_A, 'FALL_ALERT_TEMPLATE', 'grant-event-0001', 1);

  const text = fs.readFileSync(filePath, 'utf8');
  assert.equal(text.includes('openid'), false, '订阅账本不得写入 openid');
  const document = JSON.parse(text);
  assert.deepEqual(Object.keys(document.subscriptions[0]).sort(), [
    'consumed', 'grantEventIds', 'grantedAt', 'recipientRef', 'revoked', 'templateId', 'totalGranted', 'updatedAt'
  ]);

  assert.throws(() => store.grantSubscription(RECIPIENT_REF_A, 'FALL_ALERT_TEMPLATE', 'bad event id!', 1),
    /grant event id/);
  assert.throws(() => store.grantSubscription('not-a-ref', 'FALL_ALERT_TEMPLATE', 'grant-event-0009', 1),
    /recipientRef/);

  // 快照里带 openid 的订阅记录必须在加载时被拒绝（隐私回归防护）。
  const withOpenid = {
    ...document.subscriptions[0],
    openid: 'OPENID_MARKER_9f3a'
  };
  const poisoned = baseDocument(SCHEMA_VERSION, { subscriptions: [withOpenid] });
  writeDocument(filePath, poisoned);
  assert.throws(() => new PersistentStore({ filePath }), /unknown field openid/);
});

test('a v3 snapshot with legacy 2-field notification records is rejected, not silently migrated', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  // v3 的记录没有 recipientRef：v4 必须明确拒绝，而不是猜测收件人。
  const legacy = notificationRecord();
  delete legacy.recipientRef;
  writeDocument(filePath, baseDocument(3, { notifications: [legacy] }));
  assert.throws(() => new PersistentStore({ filePath }), /recipientRef/);
});
