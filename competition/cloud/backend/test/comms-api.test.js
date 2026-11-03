'use strict';

/**
 * comms-api.test.js — 远程交流 HTTP 接口测试
 *
 * 覆盖：
 *   - 监护人侧：鉴权 401/403、身份只能来自会话、幂等、voiceId 允许列表、
 *     路径穿越/命令字符/超长文本被拒、不能替别人创建消息；
 *   - 设备侧：只能领取自己的消息、并发领取只成功一次、租约过期可重新领取、
 *     合法状态迁移、非法回退被拒、重复回报幂等；
 *   - 交流功能异常不阻塞既有告警摄入、ACK 与健康检查；
 *   - 重启后消息与状态仍在（真实 PersistentStore）。
 *
 * 全部本地 HTTP + 临时目录，不访问真实微信、OneNET、串口或公网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApiServer } = require('../src/server');
const { PersistentStore } = require('../src/persistent-store');
const { MemoryStore } = require('../src/store');
const { createSessionToken } = require('../src/auth');
const { ownerRefFor } = require('../src/comms-core');

const TOKEN_SECRET = 'comms-api-test-secret-value-at-least-32-chars';
const INGEST_KEY = 'comms-api-test-ingest-key';
const GUARDIAN = 'comms-guardian-openid-placeholder';
const OUTSIDER = 'comms-outsider-openid-placeholder';
const DEVICE = 'dayu200-room-1';
const OTHER_DEVICE = 'dayu200-room-2';

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 让两台 DAYU 设备在台账里存在（未登记的设备拒绝创建消息）。 */
function seedDevices(store) {
  const t0 = 1_700_000_000_000;
  store.ingest({ deviceId: DEVICE, room: '客厅', state: 'NORMAL', ts: t0 });
  store.ingest({ deviceId: OTHER_DEVICE, room: '卧室', state: 'NORMAL', ts: t0 });
}

async function startServer(t, options = {}) {
  const dir = options.dir || createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  const store = options.store || new PersistentStore({ filePath });
  if (options.seedDevices !== false) seedDevices(store);
  const allowed = new Set(options.allowlist || [GUARDIAN]);
  const { server } = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => allowed.has(openid),
    ownerRefForIdentity: (openid) => ownerRefFor(TOKEN_SECRET, openid)
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    dir,
    filePath,
    store,
    url,
    tokenFor: (openid) => createSessionToken(openid, TOKEN_SECRET),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function createMessage(app, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token === undefined ? app.tokenFor(GUARDIAN) : token}`;
  const response = await fetch(`${app.url}/api/v1/communications/messages`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function claim(app, deviceId, leaseId, limit) {
  const query = new URLSearchParams({ deviceId });
  if (leaseId) query.set('leaseId', leaseId);
  if (limit) query.set('limit', String(limit));
  const response = await fetch(`${app.url}/internal/v1/communications/pending?${query}`, {
    headers: { 'x-ingest-key': INGEST_KEY }
  });
  return { status: response.status, body: await response.json() };
}

async function report(app, messageId, body) {
  const response = await fetch(`${app.url}/internal/v1/communications/${encodeURIComponent(messageId)}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

const goodBody = (overrides = {}) => ({
  clientMessageId: 'cmsg-abc12345',
  deviceId: DEVICE,
  text: '妈妈，记得吃药',
  voiceId: 'MEDICINE_REMINDER',
  requestAck: true,
  ...overrides
});

/* ------------------------------------------------------------ 鉴权 */

test('creating a message without a session token is 401', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const result = await createMessage(app, goodBody(), null);
  assert.equal(result.status, 401);
  assert.equal(app.store.countCommunications(), 0);
});

test('a non-allowlisted guardian is 403 and nothing is created', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const result = await createMessage(app, goodBody(), app.tokenFor(OUTSIDER));
  assert.equal(result.status, 403);
  assert.equal(app.store.countCommunications(), 0);
});

test('the client cannot impersonate another guardian', async (t) => {
  const app = await startServer(t, { allowlist: [GUARDIAN, OUTSIDER] });
  t.after(() => app.close());

  // 试图在请求体里指定身份：必须被拒绝，而不是用它当 owner。
  for (const key of ['openid', 'owner', 'ownerRef', 'household', 'recipientRef']) {
    const result = await createMessage(app, goodBody({ [key]: OUTSIDER }), app.tokenFor(GUARDIAN));
    assert.equal(result.status, 400, `字段 ${key} 必须被拒绝`);
    assert.ok(result.body.errors && result.body.errors[key]);
  }
  assert.equal(app.store.countCommunications(), 0);

  // 正常创建后，owner 是会话身份（用另一个监护人看不到）。
  const created = await createMessage(app, goodBody(), app.tokenFor(GUARDIAN));
  assert.equal(created.status, 201);
  const listed = await fetch(`${app.url}/api/v1/communications/messages?limit=10`, {
    headers: { authorization: `Bearer ${app.tokenFor(OUTSIDER)}` }
  });
  const listedBody = await listed.json();
  assert.equal(listedBody.messages.length, 0, '别的监护人不得看到这条消息');
});

test('the response never echoes identity or secrets', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const response = await fetch(`${app.url}/api/v1/communications/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${app.tokenFor(GUARDIAN)}` },
    body: JSON.stringify(goodBody())
  });
  const text = await response.text();
  assert.equal(text.includes(GUARDIAN), false, '不得回显 openid');
  assert.equal(text.includes('openid'), false);
  assert.equal(text.includes('r1_'), false, '不得回显内部身份引用');
  assert.equal(text.includes('ownerRef'), false);
  assert.equal(text.includes('leaseId'), false);
  assert.equal(text.includes(TOKEN_SECRET), false);
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed.message).sort(), [
    'acknowledgedAt', 'createdAt', 'deliveredAt', 'deviceId', 'expiresAt', 'failureCode',
    'messageId', 'playedAt', 'requestAck', 'status', 'text', 'updatedAt', 'voiceId'
  ]);
});

/* ------------------------------------------------------------ 幂等与校验 */

test('retrying the same clientMessageId returns the same message (200, not a second one)', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());

  const first = await createMessage(app, goodBody(), undefined);
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);

  const again = await createMessage(app, goodBody(), undefined);
  assert.equal(again.status, 200, '幂等重试返回 200');
  assert.equal(again.body.created, false);
  assert.equal(again.body.message.messageId, first.body.message.messageId);
  assert.equal(app.store.countCommunications(), 1);
});

test('reusing a clientMessageId with a different payload returns 409', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const first = await createMessage(app, goodBody(), undefined);
  const conflict = await createMessage(app, goodBody({ text: '完全不同的留言' }), undefined);
  assert.equal(first.status, 201);
  assert.equal(conflict.status, 409);
  assert.equal(app.store.countCommunications(), 1);
  assert.equal(app.store.getCommunication(first.body.message.messageId).text, goodBody().text);
});

test('the same clientMessageId for a different device creates a separate message', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const first = await createMessage(app, goodBody(), undefined);
  const other = await createMessage(app, goodBody({ deviceId: OTHER_DEVICE }), undefined);
  assert.equal(other.status, 201);
  assert.notEqual(other.body.message.messageId, first.body.message.messageId, '发错设备会让监护人以为已送达');
  assert.equal(app.store.countCommunications(), 2);
});

test('an invalid voiceId is rejected before anything is persisted', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  for (const voiceId of ['', 'check_in', 'UNKNOWN', 'CHECK_IN; rm -rf /', '../../etc/passwd', 'CHECK_IN`id`', null, 42]) {
    const result = await createMessage(app, goodBody({ voiceId }), undefined);
    assert.equal(result.status, 400, `voiceId=${JSON.stringify(voiceId)} 必须被拒绝`);
    assert.ok(result.body.errors.voiceId);
  }
  assert.equal(app.store.countCommunications(), 0);
});

test('text with paths, URLs, shell metacharacters or secrets is rejected', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const hostile = [
    '/etc/passwd', '../../etc/passwd', 'C:\\Windows', 'http://evil.example/x',
    'hello; rm -rf /', 'hello && reboot', '$(id)', '`id`', 'a > /tmp/x',
    'openid=oABC123456789012345678', 'phone 13800001111', '位置 39.9042,116.4074'
  ];
  for (const text of hostile) {
    const result = await createMessage(app, goodBody({ text }), undefined);
    assert.equal(result.status, 400, `text=${JSON.stringify(text)} 必须被拒绝`);
    assert.ok(result.body.errors.text);
  }
  // 超长文本
  const tooLong = await createMessage(app, goodBody({ text: 'x'.repeat(121) }), undefined);
  assert.equal(tooLong.status, 400);
  assert.ok(tooLong.body.errors.text);

  assert.equal(app.store.countCommunications(), 0);
});

test('a valid message is stored with QUEUED status and an expiry', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const created = await createMessage(app, goodBody(), undefined);
  assert.equal(created.body.message.status, 'QUEUED');
  assert.equal(created.body.message.deviceId, DEVICE);
  assert.equal(created.body.message.voiceId, 'MEDICINE_REMINDER');
  assert.equal(created.body.message.requestAck, true);
  assert.equal(created.body.message.expiresAt > created.body.message.createdAt, true);
  assert.equal(created.body.message.deliveredAt, 0);
});

/* ------------------------------------------------------------ 设备领取 */

test('the device must present the internal key to claim', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const response = await fetch(`${app.url}/internal/v1/communications/pending?deviceId=${DEVICE}`);
  assert.equal(response.status, 401);
});

test('a device only claims its own messages', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  await createMessage(app, goodBody(), undefined);
  const other = await claim(app, OTHER_DEVICE, 'lease-other-1');
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.messages, [], '不得领取别的设备的消息');

  const mine = await claim(app, DEVICE, 'lease-mine-1');
  assert.equal(mine.body.messages.length, 1);
  assert.equal(mine.body.messages[0].deviceId, DEVICE);
  assert.equal(mine.body.messages[0].leaseId, 'lease-mine-1');
});

test('delivery reports require the active lease', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const created = await createMessage(app, goodBody(), undefined);
  const messageId = created.body.message.messageId;

  const unclaimed = await report(app, messageId, {
    deviceId: DEVICE, leaseId: 'lease-made-up', event: 'DELIVERED'
  });
  assert.equal(unclaimed.status, 409);
  assert.equal(unclaimed.body.reason, 'lease_required');

  await claim(app, DEVICE, 'lease-real-1');
  const wrong = await report(app, messageId, {
    deviceId: DEVICE, leaseId: 'lease-wrong-1', event: 'DELIVERED'
  });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.reason, 'lease_mismatch');

  const right = await report(app, messageId, {
    deviceId: DEVICE, leaseId: 'lease-real-1', event: 'DELIVERED'
  });
  assert.equal(right.status, 200);
  assert.equal(right.body.message.status, 'DELIVERED');
});

test('concurrent claims never hand the same message to two pollers', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  await createMessage(app, goodBody(), undefined);

  const [a, b] = await Promise.all([
    claim(app, DEVICE, 'lease-parallel-1'),
    claim(app, DEVICE, 'lease-parallel-2')
  ]);
  const total = a.body.messages.length + b.body.messages.length;
  assert.equal(total, 1, '并发领取只能有一个人拿到，避免重复播放');
});

test('an expired lease can be reclaimed', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const created = await createMessage(app, goodBody(), undefined);
  const messageId = created.body.message.messageId;

  await claim(app, DEVICE, 'lease-first-1');
  const immediate = await claim(app, DEVICE, 'lease-second-1');
  assert.deepEqual(immediate.body.messages, [], '租约未过期不得重复领取');

  // 把租约拨到过去（公开 API），模拟领取进程被中断后的租约超时。
  const original = app.store.getCommunication(messageId);
  app.store.communications.set(messageId, Object.freeze({
    ...original,
    leaseExpiresAt: 1,
    updatedAt: original.updatedAt
  }));

  const retake = await claim(app, DEVICE, 'lease-third-1');
  assert.equal(retake.body.messages.length, 1, '租约过期后必须能重新领取');
  assert.equal(retake.body.messages[0].messageId, messageId);
});

/* ------------------------------------------------------------ 状态回报 */

test('the happy path moves QUEUED -> DELIVERED -> PLAYED -> ACKED', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const created = await createMessage(app, goodBody(), undefined);
  const messageId = created.body.message.messageId;

  await claim(app, DEVICE, 'lease-happy-1');

  const delivered = await report(app, messageId, { deviceId: DEVICE, leaseId: 'lease-happy-1', event: 'DELIVERED' });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.message.status, 'DELIVERED');
  assert.equal(delivered.body.message.deliveredAt > 0, true);

  const played = await report(app, messageId, { deviceId: DEVICE, leaseId: 'lease-happy-1', event: 'PLAYED' });
  assert.equal(played.body.message.status, 'PLAYED');
  assert.equal(played.body.message.playedAt > 0, true);

  const acked = await report(app, messageId, { deviceId: DEVICE, event: 'ACKED' });
  assert.equal(acked.body.message.status, 'ACKED');
  assert.equal(acked.body.message.acknowledgedAt > 0, true);

  // 小程序能看到最终状态。
  const fetched = await fetch(`${app.url}/api/v1/communications/messages/${messageId}`, {
    headers: { authorization: `Bearer ${app.tokenFor(GUARDIAN)}` }
  });
  const fetchedBody = await fetched.json();
  assert.equal(fetchedBody.message.status, 'ACKED');
});

test('illegal transitions are refused and repeated reports are idempotent', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const created = await createMessage(app, goodBody(), undefined);
  const messageId = created.body.message.messageId;
  await claim(app, DEVICE, 'lease-illegal-1');
  await report(app, messageId, { deviceId: DEVICE, leaseId: 'lease-illegal-1', event: 'DELIVERED' });
  await report(app, messageId, { deviceId: DEVICE, leaseId: 'lease-illegal-1', event: 'PLAYED' });
  await report(app, messageId, { deviceId: DEVICE, event: 'ACKED' });

  const regression = await report(app, messageId, { deviceId: DEVICE, event: 'DELIVERED' });
  assert.equal(regression.status, 409, 'ACKED 回退必须被拒绝');
  assert.equal(regression.body.rejected, true);

  const repeat = await report(app, messageId, { deviceId: DEVICE, event: 'ACKED' });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.changed, false, '重复 ACKED 幂等');
  assert.equal(app.store.getCommunication(messageId).status, 'ACKED');

  const junk = await report(app, messageId, { deviceId: DEVICE, event: 'EXPLODE' });
  assert.equal(junk.status, 400);
});

test('a device cannot report on another device message', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const created = await createMessage(app, goodBody(), undefined);
  const messageId = created.body.message.messageId;
  await claim(app, DEVICE, 'lease-foreign-1');

  const foreign = await report(app, messageId, { deviceId: OTHER_DEVICE, event: 'DELIVERED' });
  assert.equal(foreign.status, 403);
  assert.equal(app.store.getCommunication(messageId).status, 'QUEUED');
});

test('FAILED carries a bounded failure code and is terminal', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const created = await createMessage(app, goodBody(), undefined);
  const messageId = created.body.message.messageId;
  await claim(app, DEVICE, 'lease-fail-1');

  const failed = await report(app, messageId, {
    deviceId: DEVICE, leaseId: 'lease-fail-1', event: 'FAILED', failureCode: 'AUDIO_ROUTE_MISSING'
  });
  assert.equal(failed.body.message.status, 'FAILED');
  assert.equal(failed.body.message.failureCode, 'AUDIO_ROUTE_MISSING');

  const after = await report(app, messageId, { deviceId: DEVICE, event: 'PLAYED' });
  assert.equal(after.status, 409, 'FAILED 不得复活成 PLAYED');

  const badCode = await report(app, messageId, { deviceId: DEVICE, event: 'FAILED', failureCode: 'lower case!' });
  assert.equal(badCode.status, 400);
});

test('reporting a missing message is 404', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());
  const result = await report(app, 'cmsg-doesnotexist01', { deviceId: DEVICE, event: 'DELIVERED' });
  assert.equal(result.status, 404);
});

/* ------------------------------------------------------------ 不阻塞主链路 / 重启 */

test('communications failures never break alarm ingest, ACK or health checks', async (t) => {
  const app = await startServer(t);
  t.after(() => app.close());

  // 既有主链路仍然工作。
  const health = await fetch(`${app.url}/healthz`);
  assert.equal(health.status, 200);

  const ingest = await fetch(`${app.url}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      deviceId: 'esp32-bath', room: '卫生间', state: 'ALARM', ts: 1_700_000_000_000,
      alarm: { id: 'alarm-comms-1', type: 'FALL' }
    })
  });
  assert.equal(ingest.status, 202);

  const ack = await fetch(`${app.url}/api/v1/alerts/alarm-comms-1/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${app.tokenFor(GUARDIAN)}` },
    body: JSON.stringify({ note: '已确认' })
  });
  assert.equal(ack.status, 202);

  // 交流接口的坏输入也不影响主链路。
  await createMessage(app, goodBody({ voiceId: 'BOGUS' }), undefined);
  await report(app, 'not-a-message-id', { deviceId: DEVICE, event: 'DELIVERED' });

  const healthAgain = await fetch(`${app.url}/healthz`);
  assert.equal(healthAgain.status, 200);
  const alerts = await fetch(`${app.url}/api/v1/alerts`, {
    headers: { authorization: `Bearer ${app.tokenFor(GUARDIAN)}` }
  });
  assert.equal(alerts.status, 200);
});

test('messages and their state survive a real backend restart', async (t) => {
  const dir = createTempDir(t);
  const first = await startServer(t, { dir });
  const created = await createMessage(first, goodBody(), undefined);
  const messageId = created.body.message.messageId;
  await claim(first, DEVICE, 'lease-restart-1');
  await report(first, messageId, { deviceId: DEVICE, leaseId: 'lease-restart-1', event: 'DELIVERED' });
  await first.close();

  const second = await startServer(t, { dir });
  t.after(() => second.close());
  const fetched = await fetch(`${second.url}/api/v1/communications/messages/${messageId}`, {
    headers: { authorization: `Bearer ${second.tokenFor(GUARDIAN)}` }
  });
  const body = await fetched.json();
  assert.equal(body.message.status, 'DELIVERED');
  assert.equal(body.message.deliveredAt > 0, true);

  // 重启后同一个 clientMessageId 仍然幂等。
  const again = await createMessage(second, goodBody(), undefined);
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);

  // 模拟原代理在 DELIVERED 后崩溃且租约超时；重启后必须能重新领取并完成闭环。
  const persisted = second.store.getCommunication(messageId);
  second.store.communications.set(messageId, Object.freeze({ ...persisted, leaseExpiresAt: 1 }));
  const reclaimed = await claim(second, DEVICE, 'lease-restart-2');
  assert.equal(reclaimed.body.messages.length, 1);
  const played = await report(second, messageId, { deviceId: DEVICE, leaseId: 'lease-restart-2', event: 'PLAYED' });
  assert.equal(played.body.message.status, 'PLAYED');
  await second.close();
});

test('an unauthenticated list request is 401 and a MemoryStore still works', async (t) => {
  const app = await startServer(t, { store: new MemoryStore() });
  t.after(() => app.close());
  const response = await fetch(`${app.url}/api/v1/communications/messages`);
  assert.equal(response.status, 401);
});
