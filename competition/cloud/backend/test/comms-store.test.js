'use strict';

/**
 * comms-store.test.js — 交流消息在真实 PersistentStore 上的持久化、幂等与迁移测试
 *
 * 重点：
 *   - 幂等键 = ownerRef + deviceId + clientMessageId，重试不得产生第二条；
 *   - 重启后消息与状态仍在；
 *   - v4 快照升级到 v5 后 notifications / subscriptions 一字不差地保留；
 *   - 领取租约：并发只领取一次、过期可重新领取；
 *   - 快照里不出现 openid / token / 手机号 / 精确坐标；
 *   - 容量上限与回滚沿用既有机制。
 *
 * 全部使用系统临时目录；不访问网络、串口或真实设备。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PersistentStore, SCHEMA_VERSION, SNAPSHOT_KEYS } = require('../src/persistent-store');
const { LEASE_MS, MESSAGE_TTL_MS, DEFAULT_MESSAGE_CAP } = require('../src/comms-core');

const OWNER_A = 'r1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER_B = 'r1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const DEVICE = 'dayu200-room-1';

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeDocument(filePath, document) {
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
}

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

const composeInput = (overrides = {}) => ({
  ownerRef: OWNER_A,
  clientMessageId: 'cmsg-abc12345',
  deviceId: DEVICE,
  text: '记得吃药',
  voiceId: 'MEDICINE_REMINDER',
  requestAck: true,
  expiresAt: 1_700_000_000_000 + MESSAGE_TTL_MS,
  now: 1_700_000_000_000,
  ...overrides
});

/* ------------------------------------------------------------ 幂等与持久化 */

test('creating the same clientMessageId twice yields exactly one message', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });

  const first = store.createCommunication(composeInput());
  assert.equal(first.created, true);
  assert.equal(first.message.messageId.startsWith('cmsg-'), true);
  assert.equal(first.message.status, 'QUEUED');
  assert.equal(store.countCommunications(), 1);

  const again = store.createCommunication(composeInput());
  assert.equal(again.created, false, '同一幂等键必须复用既有消息');
  assert.equal(again.message.messageId, first.message.messageId);
  assert.equal(store.countCommunications(), 1);

  // 不同 clientMessageId 是新消息。
  const other = store.createCommunication(composeInput({ clientMessageId: 'cmsg-abc12346' }));
  assert.equal(other.created, true);
  assert.equal(store.countCommunications(), 2);
});

test('reusing an idempotency key with different content is a conflict', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  const first = store.createCommunication(composeInput());
  const conflict = store.createCommunication(composeInput({ text: '这不是原来的留言' }));
  assert.equal(first.created, true);
  assert.equal(conflict.created, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.message.text, first.message.text);
  assert.equal(store.countCommunications(), 1);
});

test('the idempotency key includes the owner and the device', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });

  const a = store.createCommunication(composeInput());
  const otherOwner = store.createCommunication(composeInput({ ownerRef: OWNER_B }));
  const otherDevice = store.createCommunication(composeInput({ deviceId: 'dayu200-room-2' }));

  assert.notEqual(otherOwner.message.messageId, a.message.messageId, '不同监护人不能共享幂等键');
  assert.notEqual(otherDevice.message.messageId, a.message.messageId, '不同设备不能共享幂等键');
  assert.equal(store.countCommunications(), 3);
});

test('messages and their state survive a restart', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');

  const first = new PersistentStore({ filePath });
  const created = first.createCommunication(composeInput());
  const claimed = first.claimCommunications(DEVICE, { now: 1_700_000_000_100, leaseId: 'lease-1' });
  assert.equal(claimed.length, 1);
  first.reportCommunication(created.message.messageId, 'DELIVERED', {
    now: 1_700_000_000_200, deviceId: DEVICE, leaseId: 'lease-1'
  });

  const second = new PersistentStore({ filePath });
  const restored = second.getCommunication(created.message.messageId);
  assert.ok(restored, '重启后必须还能读到消息');
  assert.equal(restored.status, 'DELIVERED');
  assert.equal(restored.deliveredAt, 1_700_000_000_200);
  assert.equal(restored.text, '记得吃药');
  assert.equal(restored.voiceId, 'MEDICINE_REMINDER');
  assert.equal(second.countCommunications(), 1);
});

test('repeated reporting is idempotent and illegal regression is refused', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  const created = store.createCommunication(composeInput());
  const id = created.message.messageId;
  store.claimCommunications(DEVICE, { now: 50, leaseId: 'lease-repeat' });

  store.reportCommunication(id, 'DELIVERED', { now: 100, deviceId: DEVICE, leaseId: 'lease-repeat' });
  const first = store.reportCommunication(id, 'PLAYED', { now: 200, deviceId: DEVICE, leaseId: 'lease-repeat' });
  assert.equal(first.changed, true);

  const repeat = store.reportCommunication(id, 'PLAYED', { now: 300, deviceId: DEVICE });
  assert.equal(repeat.changed, false, '重复 PLAYED 必须幂等');
  assert.equal(repeat.rejected, false);
  assert.equal(store.getCommunication(id).playedAt, 200, '幂等回报不得改写既有时间戳');

  const acked = store.reportCommunication(id, 'ACKED', { now: 400, deviceId: DEVICE });
  assert.equal(acked.changed, true);
  const repeatAck = store.reportCommunication(id, 'ACKED', { now: 500, deviceId: DEVICE });
  assert.equal(repeatAck.changed, false);
  assert.equal(store.getCommunication(id).acknowledgedAt, 400);

  const regression = store.reportCommunication(id, 'DELIVERED', { now: 600, deviceId: DEVICE });
  assert.equal(regression.rejected, true, 'ACKED 不得回退');
  assert.equal(store.getCommunication(id).status, 'ACKED');

  assert.throws(() => store.reportCommunication(id, 'NOPE', { now: 700, deviceId: DEVICE }), /invalid communication event/);
});

test('an unclaimed message cannot be acknowledged', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  const created = store.createCommunication(composeInput());
  const result = store.reportCommunication(created.message.messageId, 'ACKED', { now: 100, deviceId: DEVICE });
  assert.equal(result.rejected, true, '未领取的消息不得直接 ACKED');
  assert.equal(store.getCommunication(created.message.messageId).status, 'QUEUED');
});

test('a device cannot report on another device message', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  const created = store.createCommunication(composeInput());
  store.claimCommunications(DEVICE, { now: 100, leaseId: 'lease-1' });

  const foreign = store.reportCommunication(created.message.messageId, 'DELIVERED', { now: 200, deviceId: 'esp32-bath' });
  assert.equal(foreign.rejected, true, '别的设备不能确认不属于自己的消息');
  assert.equal(foreign.reason, 'device_mismatch');
  assert.equal(store.getCommunication(created.message.messageId).status, 'QUEUED');
});

/* ------------------------------------------------------------ 领取租约 */

test('a claim is exclusive: a second concurrent poll gets nothing', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  store.createCommunication(composeInput());

  const first = store.claimCommunications(DEVICE, { now: 100, leaseId: 'lease-1' });
  assert.equal(first.length, 1);
  assert.equal(first[0].leaseId, 'lease-1');
  assert.equal(first[0].leaseExpiresAt, 100 + LEASE_MS);

  const second = store.claimCommunications(DEVICE, { now: 150, leaseId: 'lease-2' });
  assert.deepEqual(second, [], '租约未过期时不得被第二次领取（避免重复播放）');
});

test('an expired lease allows a safe re-claim', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  store.createCommunication(composeInput());

  store.claimCommunications(DEVICE, { now: 100, leaseId: 'lease-1' });
  const retake = store.claimCommunications(DEVICE, { now: 100 + LEASE_MS, leaseId: 'lease-2' });
  assert.equal(retake.length, 1, '租约过期后必须能重新领取');
  assert.equal(retake[0].leaseId, 'lease-2');
  assert.equal(store.getCommunication(retake[0].messageId).status, 'QUEUED', '重新领取不改变业务状态');
});

test('an unclaimed message cannot report delivery or playback', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  const created = store.createCommunication(composeInput());
  const delivered = store.reportCommunication(created.message.messageId, 'DELIVERED', {
    now: 100, deviceId: DEVICE, leaseId: 'lease-never-issued'
  });
  assert.equal(delivered.rejected, true);
  assert.equal(delivered.reason, 'lease_required');
  assert.equal(store.getCommunication(created.message.messageId).status, 'QUEUED');
});

test('a DELIVERED message is reclaimed after lease expiry and rejects the stale claimant', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  const created = store.createCommunication(composeInput());
  const id = created.message.messageId;
  store.claimCommunications(DEVICE, { now: 100, leaseId: 'lease-old' });
  const delivered = store.reportCommunication(id, 'DELIVERED', {
    now: 200, deviceId: DEVICE, leaseId: 'lease-old'
  });
  assert.equal(delivered.changed, true);
  assert.equal(delivered.message.leaseId, 'lease-old');

  const retake = store.claimCommunications(DEVICE, {
    now: 100 + LEASE_MS, leaseId: 'lease-new'
  });
  assert.equal(retake.length, 1, '播放前崩溃后必须可重新领取 DELIVERED 消息');
  assert.equal(retake[0].leaseId, 'lease-new');

  const stale = store.reportCommunication(id, 'PLAYED', {
    now: 100 + LEASE_MS + 1, deviceId: DEVICE, leaseId: 'lease-old'
  });
  assert.equal(stale.rejected, true);
  assert.equal(stale.reason, 'lease_mismatch');
  assert.equal(store.getCommunication(id).status, 'DELIVERED');
});

test('claiming only returns messages for that device, in FIFO order, within the limit', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  store.createCommunication(composeInput({ clientMessageId: 'cmsg-00000001', now: 100 }));
  store.createCommunication(composeInput({ clientMessageId: 'cmsg-00000002', now: 200 }));
  store.createCommunication(composeInput({ clientMessageId: 'cmsg-00000003', now: 300 }));
  store.createCommunication(composeInput({ clientMessageId: 'cmsg-00000004', deviceId: 'dayu200-room-2', now: 400 }));

  const claimed = store.claimCommunications(DEVICE, { now: 1000, leaseId: 'lease-1', limit: 2 });
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((item) => item.text), ['记得吃药', '记得吃药']);
  assert.equal(claimed.every((item) => item.deviceId === DEVICE), true, '不得返回其他设备的消息');
  const createds = claimed.map((item) => item.createdAt);
  assert.deepEqual(createds, [...createds].sort((a, b) => a - b), '必须按创建时间先进先出');
});

test('expired messages are not claimable and are reported as EXPIRED', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  const created = store.createCommunication(composeInput({ expiresAt: 500 }));

  const late = store.claimCommunications(DEVICE, { now: 1000, leaseId: 'lease-1' });
  assert.deepEqual(late, [], '过期消息不得再被领取');
  assert.equal(store.getCommunication(created.message.messageId).status, 'EXPIRED');
});

/* ------------------------------------------------------------ 容量、回滚、快照形状 */

test('the ledger is bounded and drops the oldest by updatedAt', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({
    filePath: path.join(dir, 'state.json'),
    atomicWriter: (target, text) => { fs.writeFileSync(target, text, 'utf8'); }
  });

  const cap = 12;
  for (let index = 0; index < cap; index += 1) {
    store.createCommunication(composeInput({
      clientMessageId: `cmsg-cap${String(index).padStart(5, '0')}`,
      now: 1_000_000 + index,
      messageCap: cap
    }));
  }
  assert.equal(store.countCommunications(), cap);

  store.createCommunication(composeInput({ clientMessageId: 'cmsg-cap99999', now: 2_000_000, messageCap: cap }));
  assert.equal(store.countCommunications(), cap, '超过上限必须淘汰最旧记录');

  const document = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(document.communications.length, cap);
  assert.equal(DEFAULT_MESSAGE_CAP >= cap, true);
});

test('a failed write rolls back communication state', (t) => {
  const dir = createTempDir(t);
  let failing = false;
  const store = new PersistentStore({
    filePath: path.join(dir, 'state.json'),
    atomicWriter: (target, text) => {
      if (failing) throw new Error('disk full');
      fs.writeFileSync(target, text, 'utf8');
    }
  });
  const created = store.createCommunication(composeInput());
  store.claimCommunications(DEVICE, { now: 100, leaseId: 'lease-1' });

  failing = true;
  assert.throws(() => store.reportCommunication(created.message.messageId, 'DELIVERED', {
    now: 200, deviceId: DEVICE, leaseId: 'lease-1'
  }), /disk full/);
  const after = store.getCommunication(created.message.messageId);
  assert.equal(after.status, 'QUEUED', '写失败必须回滚状态');
  assert.equal(after.leaseId, 'lease-1', '写失败必须回滚租约');
});

test('communications are whitelisted, bounded and carry no identity data', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  const store = new PersistentStore({ filePath });
  store.createCommunication(composeInput({ text: '记得吃药' }));
  store.reportCommunication(store.listCommunications()[0].messageId, 'DELIVERED', { now: 200, deviceId: DEVICE });

  const text = fs.readFileSync(filePath, 'utf8');
  const document = JSON.parse(text);
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(Object.keys(document).sort(), [...SNAPSHOT_KEYS].sort());
  assert.equal(Array.isArray(document.communications), true);
  for (const banned of ['openid', 'unionid', 'access_token', 'appSecret', 'sessionToken', 'phone', 'iccid', 'imei', 'latitude', 'longitude']) {
    assert.equal(text.includes(banned), false, `快照不得出现 ${banned}`);
  }

  const record = document.communications[0];
  assert.deepEqual(Object.keys(record).sort(), [
    'acknowledgedAt', 'attempts', 'clientMessageId', 'createdAt', 'deliveredAt', 'deviceId',
    'expiredAt', 'expiresAt', 'failedAt', 'failureCode', 'leaseExpiresAt', 'leaseId', 'messageId', 'ownerRef',
    'playedAt', 'requestAck', 'status', 'text', 'updatedAt', 'voiceId'
  ]);
  assert.equal(record.ownerRef.startsWith('r1_'), true, '内部身份只用 recipientRef 形式的不可反查引用');
});

test('unknown fields in a communication record are rejected as corrupt', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  const store = new PersistentStore({ filePath });
  store.createCommunication(composeInput());

  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  document.communications[0].openid = 'oLEAK123456789012345678';
  writeDocument(filePath, document);
  assert.throws(() => new PersistentStore({ filePath }), /unknown field openid/);
});

/* ------------------------------------------------------------ v4 → 当前 schema 迁移 */

function v4Document() {
  return {
    schemaVersion: 4,
    savedAt: 1_700_000_000_000,
    devices: [],
    alerts: [],
    commands: [],
    contacts: [],
    notifications: [{
      deviceId: 'dayu200-room-1',
      alarmId: 'alarm-migrate-1',
      recipientRef: OWNER_A,
      templateId: 'TEMPLATE_MIGRATE_1',
      status: 'SENT',
      attempts: 1,
      attemptCount: 1,
      sentAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      errorCode: ''
    }],
    subscriptions: [{
      recipientRef: OWNER_A,
      templateId: 'TEMPLATE_MIGRATE_1',
      totalGranted: 2,
      consumed: 1,
      revoked: 0,
      grantEventIds: ['grant-event-0001'],
      grantedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000
    }]
  };
}

test('a v4 snapshot loads unchanged and upgrades to the current schema on the next write', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  writeDocument(filePath, v4Document());

  const store = new PersistentStore({ filePath });
  // v4 的 notifications / subscriptions 必须一字不差地保留。
  assert.equal(store.countNotifications(), 1);
  assert.equal(store.listNotifications()[0].alarmId, 'alarm-migrate-1');
  assert.equal(store.listNotifications()[0].recipientRef, OWNER_A);
  assert.equal(store.countSubscriptions(), 1);
  assert.equal(store.listSubscriptions()[0].totalGranted, 2);
  assert.equal(store.readSubscription(OWNER_A).consumed, 1);
  assert.equal(store.countCommunications(), 0, 'v4 没有 communications 键 -> 视为空账本');

  // 第一次成功变更后写当前 schema（v6，含 safetyLogs 空台账），notifications/subscriptions 保持不变。
  store.createCommunication(composeInput());
  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(document.safetyLogs, [], 'v4 升级后安全日志台账为空');
  assert.deepEqual(document.notifications, v4Document().notifications);
  assert.deepEqual(document.subscriptions, v4Document().subscriptions);
  assert.equal(document.communications.length, 1);

  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.countNotifications(), 1);
  assert.equal(reloaded.countSubscriptions(), 1);
  assert.equal(reloaded.countCommunications(), 1);
});

test('a v1/v2/v3 snapshot still loads and gains an empty communications ledger', (t) => {
  const dir = createTempDir(t);
  for (const version of [1, 2, 3]) {
    const filePath = path.join(dir, `state-v${version}.json`);
    writeDocument(filePath, baseDocument(version));
    const store = new PersistentStore({ filePath });
    assert.equal(store.countCommunications(), 0, `v${version} 必须能加载`);
    store.createCommunication(composeInput({ clientMessageId: `cmsg-v${version}000001` }));
    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(document.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(document.communications.length, 1);
  }
});

test('features above the current schema version are still rejected', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  writeDocument(filePath, baseDocument(SCHEMA_VERSION + 1));
  assert.throws(() => new PersistentStore({ filePath }), /schemaVersion/);
});

/* ------------------------------------------------------------ 查询 */

test('listing filters by owner and device without leaking other households', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  store.createCommunication(composeInput({ clientMessageId: 'cmsg-list0001' }));
  store.createCommunication(composeInput({ clientMessageId: 'cmsg-list0002', ownerRef: OWNER_B }));
  store.createCommunication(composeInput({ clientMessageId: 'cmsg-list0003', deviceId: 'dayu200-room-2' }));

  // 同一个 clientMessageId 发给**不同设备**是两条独立消息（幂等键包含 deviceId）：
  // 否则监护人给第二个房间发消息会静默复用第一条，消息就发错设备了。
  store.createCommunication(composeInput({ clientMessageId: 'cmsg-list0001', deviceId: 'dayu200-room-2' }));
  assert.equal(store.countCommunications(), 4);

  const mine = store.listCommunications({ ownerRef: OWNER_A, limit: 10 });
  assert.equal(mine.length, 3, '只能看到自己创建的消息');
  assert.equal(mine.every((item) => item.ownerRef === OWNER_A), true);

  const otherOwner = store.listCommunications({ ownerRef: OWNER_B, limit: 10 });
  assert.equal(otherOwner.length, 1);
  assert.equal(otherOwner[0].deviceId, DEVICE);

  const forDevice = store.listCommunications({ deviceId: DEVICE, limit: 10 });
  assert.equal(forDevice.length, 2, '每台设备各自只看到发给自己的消息');
  assert.equal(forDevice.every((item) => item.deviceId === DEVICE), true);

  const otherDevice = store.listCommunications({ deviceId: 'dayu200-room-2', limit: 10 });
  assert.equal(otherDevice.length, 2);

  const all = store.listCommunications({ limit: 10 });
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((item) => item.createdAt), [...all.map((item) => item.createdAt)].sort((a, b) => b - a), '最新在前');
});

test('countCommunications and getCommunication tolerate junk input', (t) => {
  const dir = createTempDir(t);
  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  assert.equal(store.getCommunication(undefined), null);
  assert.equal(store.getCommunication(42), null);
  assert.equal(store.getCommunication('../escape'), null);
  assert.equal(store.countCommunications(), 0);
});
