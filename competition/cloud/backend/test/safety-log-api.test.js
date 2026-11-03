'use strict';

/**
 * safety-log-api.test.js — 处置结果 / 安全日志 HTTP 合同测试
 *
 * 环境：`createApiServer` + `MemoryStore` + 进程内随机生成的测试 appAuth/tokenSecret。
 * 密钥与密码都只用 `crypto.randomBytes` 现场生成，**绝不打印、绝不落盘**。
 * 不访问网络、不写数据文件、不生成任何真实 ACK/reset 命令。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { createSessionToken, parseAppGuardianConfig } = require('../src/auth');
const { createApiServer } = require('../src/server');
const { MemoryStore } = require('../src/store');
const { DISPOSITION_OUTCOMES, DISPOSITION_LABELS, PUBLIC_DISPOSITION_FIELDS } = require('../src/safety-log');

// 进程内随机测试凭据：不落盘、不输出；长度满足既有密码策略（32-256）。
const TOKEN_SECRET = crypto.randomBytes(48).toString('base64url');
const INGEST_KEY = crypto.randomBytes(48).toString('base64url');
const PASSWORD = crypto.randomBytes(48).toString('base64url');
const GUARDIAN_ID = 'safety-log-guardian';
const APP_AUTH = parseAppGuardianConfig(GUARDIAN_ID, PASSWORD);

const CLIENT_ID_1 = 'disp-http-0001';
const CLIENT_ID_2 = 'disp-http-0002';

/** 测试告警 fixture（只写入本进程内存，不来自真实设备、不触发任何告警）。 */
function seedAlerts(store) {
  store.ingest({
    deviceId: 'esp32-kitchen', room: '厨房', online: true, state: 'ALARM', ts: 1792949000000,
    alarm: { id: 'alarm-a1', type: 'SOS', countToday: 1 }
  });
  // 既有 ACK 命令（用于证明处置接口不改变/不新增命令）。
  store.requestAck('alarm-a1', '家属确认中', 'household-guardian');

  store.ingest({
    deviceId: 'esp32-bedroom', room: '卧室', online: true, state: 'ALARM', ts: 1792949001000,
    alarm: { id: 'alarm-a2', type: 'NO_MOTION', countToday: 1 }
  });

  // 先 ALARM 再被设备回执 ACKED（不走 HTTP，纯 fixture）。
  store.ingest({
    deviceId: 'esp32-living', room: '客厅', online: true, state: 'ALARM', ts: 1792949002000,
    alarm: { id: 'alarm-a3', type: 'GAS', countToday: 1 }
  });
  store.ingest({
    deviceId: 'esp32-living', room: '客厅', online: true, state: 'ACKED', ts: 1792949003000,
    alarm: { id: 'alarm-a3', type: 'GAS', countToday: 1 }
  });

  store.ingest({
    deviceId: 'esp32-bath', room: '卫生间', online: true, state: 'ALARM', ts: 1792949004000,
    alarm: { id: 'alarm-a4', type: 'FALL', countToday: 1 }
  });

  store.ingest({
    deviceId: 'esp32-empty', room: '阳台', online: true, state: 'NORMAL', ts: 1792949005000
  });
}

function createApp(options = {}) {
  const store = options.store || new MemoryStore();
  seedAlerts(store);
  const created = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    appAuth: APP_AUTH,
    authorizeIdentity: (identity) => identity === APP_AUTH.subject
  });
  return { ...created, store };
}

async function listen(created) {
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${created.server.address().port}`;
}

async function close(created) {
  await new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve()));
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/auth/app`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId: GUARDIAN_ID, password: PASSWORD })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.sessionToken;
}

const PUBLIC_KEYS = [...PUBLIC_DISPOSITION_FIELDS].sort();

function assertPublicDisposition(disposition) {
  assert.equal(Object.isFrozen(disposition), false, 'JSON 解析后不是冻结对象');
  assert.deepEqual(Object.keys(disposition).sort(), PUBLIC_KEYS);
  const text = JSON.stringify(disposition);
  assert.equal(text.includes('clientDispositionId'), false);
  assert.equal(text.includes('"actor"'), false);
}

function postDisposition(baseUrl, token, alarmId, body) {
  return fetch(`${baseUrl}/api/v1/alerts/${encodeURIComponent(alarmId)}/dispositions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function getDispositions(baseUrl, token, alarmId) {
  return fetch(`${baseUrl}/api/v1/alerts/${encodeURIComponent(alarmId)}/dispositions`, {
    headers: { authorization: `Bearer ${token}` }
  });
}

function getSafetyLogs(baseUrl, token, query = '') {
  return fetch(`${baseUrl}/api/v1/safety-logs${query}`, {
    headers: { authorization: `Bearer ${token}` }
  });
}

/* ------------------------------------------------------------ 鉴权 */

test('disposition and safety-log routes require a valid household session', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));

  for (const response of [
    await fetch(`${baseUrl}/api/v1/alerts/alarm-a1/dispositions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    }),
    await fetch(`${baseUrl}/api/v1/alerts/alarm-a1/dispositions`),
    await fetch(`${baseUrl}/api/v1/safety-logs`)
  ]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }

  const garbage = { authorization: 'Bearer not-a-session-token' };
  assert.equal((await fetch(`${baseUrl}/api/v1/safety-logs`, { headers: garbage })).status, 401);

  // 合法签名但不在家庭允许名单内的身份：403（沿用既有会话鉴权语义）。
  const outsider = { authorization: `Bearer ${createSessionToken('app:outsider', TOKEN_SECRET)}` };
  const forbidden = await fetch(`${baseUrl}/api/v1/safety-logs`, { headers: outsider });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: 'forbidden' });
});

/* ------------------------------------------------------------ 404 / 400 */

test('unknown alarms return 404 and malformed alarm ids return 400', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  const unknownPost = await postDisposition(baseUrl, token, 'alarm-missing', {
    clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM'
  });
  assert.equal(unknownPost.status, 404);
  assert.deepEqual(await unknownPost.json(), { error: 'alarm not found' });

  const unknownGet = await getDispositions(baseUrl, token, 'alarm-missing');
  assert.equal(unknownGet.status, 404);
  assert.deepEqual(await unknownGet.json(), { error: 'alarm not found' });

  const unknownFilter = await getSafetyLogs(baseUrl, token, '?alarmId=alarm-missing');
  assert.equal(unknownFilter.status, 404);
  assert.deepEqual(await unknownFilter.json(), { error: 'alarm not found' });

  const badPost = await postDisposition(baseUrl, token, 'bad!id', {
    clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM'
  });
  assert.equal(badPost.status, 400);
  assert.deepEqual(await badPost.json(), { error: 'invalid alarm id' });

  const badGet = await getDispositions(baseUrl, token, 'bad!id');
  assert.equal(badGet.status, 400);
  assert.deepEqual(await badGet.json(), { error: 'invalid alarm id' });

  assert.equal(created.store.listSafetyLogs().length, 0, '失败请求不得产生任何处置记录');
});

/* ------------------------------------------------------------ 首次创建 / 幂等 / 冲突 */

test('first registration returns 201 with the contract public shape', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);
  const alert = created.store.getAlert('alarm-a1');

  const response = await postDisposition(baseUrl, token, 'alarm-a1', {
    clientDispositionId: CLIENT_ID_1,
    outcome: 'CONTACTED_FAMILY',
    note: '已联系家属，老人安全'
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.created, true);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'duplicate'), false);
  assertPublicDisposition(body.disposition);
  const { serverTime, ...fields } = body.disposition;
  assert.deepEqual(fields, {
    dispositionId: 'dsp-1',
    alarmId: 'alarm-a1',
    deviceId: 'esp32-kitchen',
    roomName: '厨房',
    alarmType: 'SOS',
    alarmCreatedAt: alert.createdAt,
    outcome: 'CONTACTED_FAMILY',
    outcomeLabel: '已联系家属',
    note: '已联系家属，老人安全',
    operator: '家庭监护人',
    operatorRole: 'household-guardian'
  });
  assert.equal(Number.isSafeInteger(serverTime), true);
  assert.ok(serverTime > 0, 'serverTime 必须来自服务端时钟');

  const list = await getDispositions(baseUrl, token, 'alarm-a1');
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { alarmId: 'alarm-a1', dispositions: [body.disposition] });
});

test('an identical replay is idempotent (200 duplicate) and creates no second record', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);
  const payload = {
    clientDispositionId: CLIENT_ID_1,
    outcome: 'CONTACTED_COMMUNITY',
    note: '社区已上门'
  };

  const first = await postDisposition(baseUrl, token, 'alarm-a1', payload);
  assert.equal(first.status, 201);
  const createdBody = await first.json();

  const replay = await postDisposition(baseUrl, token, 'alarm-a1', payload);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.created, false);
  assert.equal(replayBody.duplicate, true);
  assert.deepEqual(replayBody.disposition, createdBody.disposition);
  assert.equal(created.store.listSafetyLogs().length, 1);
  // 同一幂等键在**另一个**告警下是独立记录（不是冲突）。
  const otherAlarm = await postDisposition(baseUrl, token, 'alarm-a2', payload);
  assert.equal(otherAlarm.status, 201);
  assert.equal(created.store.listSafetyLogs().length, 2);
});

test('reusing clientDispositionId with different content returns 409 without overwriting', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  const first = await postDisposition(baseUrl, token, 'alarm-a1', {
    clientDispositionId: CLIENT_ID_1, outcome: 'CONTACTED_FAMILY', note: '原记录'
  });
  assert.equal(first.status, 201);
  const original = (await first.json()).disposition;

  const conflictOutcome = await postDisposition(baseUrl, token, 'alarm-a1', {
    clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', note: '原记录'
  });
  assert.equal(conflictOutcome.status, 409);
  assert.deepEqual(await conflictOutcome.json(), { error: 'clientDispositionId payload conflict' });

  const conflictNote = await postDisposition(baseUrl, token, 'alarm-a1', {
    clientDispositionId: CLIENT_ID_1, outcome: 'CONTACTED_FAMILY', note: '改了说明'
  });
  assert.equal(conflictNote.status, 409);

  const list = await (await getDispositions(baseUrl, token, 'alarm-a1')).json();
  assert.equal(list.dispositions.length, 1);
  assert.deepEqual(list.dispositions[0], original);
});

/* ------------------------------------------------------------ 输入校验 */

test('invalid bodies return 400 invalid disposition and write nothing', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  const invalidBodies = [
    {},
    { clientDispositionId: CLIENT_ID_1, outcome: 'NOT_AN_OUTCOME' },
    { clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', note: 'a'.repeat(201) },
    { clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', note: '用药\u0000确认' },
    { clientDispositionId: CLIENT_ID_1, outcome: 'OTHER', note: '   ' },
    { clientDispositionId: 'short', outcome: 'FALSE_ALARM' },
    { clientDispositionId: 'disp-..-0001', outcome: 'FALSE_ALARM' },
    // 客户端不得提交身份/设备/时间字段。
    { clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', alarmId: 'alarm-a1' },
    { clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', deviceId: 'esp32-kitchen' },
    { clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', operator: '我自己' },
    { clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', serverTime: 1 },
    { clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', openid: 'oLEAK' },
    { clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', ownerRef: 'r1_x' },
    { clientDispositionId: CLIENT_ID_1, outcome: 'FALSE_ALARM', household: 'other' }
  ];
  for (const body of invalidBodies) {
    const response = await postDisposition(baseUrl, token, 'alarm-a1', body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(await response.json(), { error: 'invalid disposition' });
  }

  // 8 KiB 请求体上限：超限必须是 400，不能 5xx，也不能落库。
  const oversized = await postDisposition(baseUrl, token, 'alarm-a1', {
    clientDispositionId: CLIENT_ID_1,
    outcome: 'OTHER',
    note: 'a'.repeat(9000)
  });
  assert.equal(oversized.status, 400);

  assert.equal(created.store.listSafetyLogs().length, 0, '非法请求不得写台账');
  assert.equal(created.store.listCommands(0).length, 1, '非法请求不得生成 ACK 命令');
});

test('all five contract outcomes are accepted', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  for (let index = 0; index < DISPOSITION_OUTCOMES.length; index += 1) {
    const outcome = DISPOSITION_OUTCOMES[index];
    const response = await postDisposition(baseUrl, token, 'alarm-a2', {
      clientDispositionId: `disp-outcome-${String(index).padStart(4, '0')}`,
      outcome,
      note: outcome === 'OTHER' ? '其他说明必须非空' : ''
    });
    assert.equal(response.status, 201, outcome);
    const body = await response.json();
    assert.equal(body.disposition.outcome, outcome);
    assert.equal(body.disposition.outcomeLabel, DISPOSITION_LABELS[outcome]);
  }
  assert.equal(created.store.listDispositions('alarm-a2').length, DISPOSITION_OUTCOMES.length);
});

/* ------------------------------------------------------------ 查询排序 / 过滤 */

test('GET dispositions sorts by serverTime desc then dispositionId desc', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  const older = created.store.createDisposition({
    alarmId: 'alarm-a2', clientDispositionId: 'disp-order-0001', outcome: 'FALSE_ALARM', note: ''
  }, 3000);
  const oldest = created.store.createDisposition({
    alarmId: 'alarm-a2', clientDispositionId: 'disp-order-0002', outcome: 'OTHER', note: '说明'
  }, 1000);
  const sameTimeNewer = created.store.createDisposition({
    alarmId: 'alarm-a2', clientDispositionId: 'disp-order-0003', outcome: 'CONTACTED_FAMILY', note: ''
  }, 3000);

  const response = await getDispositions(baseUrl, token, 'alarm-a2');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.alarmId, 'alarm-a2');
  assert.deepEqual(body.dispositions.map((item) => item.dispositionId), [
    sameTimeNewer.disposition.dispositionId,
    older.disposition.dispositionId,
    oldest.disposition.dispositionId
  ]);
  for (const disposition of body.dispositions) assertPublicDisposition(disposition);
});

test('GET dispositions returns an empty array for an alarm without records', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);
  const response = await getDispositions(baseUrl, token, 'alarm-a4');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { alarmId: 'alarm-a4', dispositions: [] });
});

test('GET safety-logs honors limit (1-200, default 50), sorting and alarmId filter', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  const ids = [];
  const specs = [
    ['alarm-a1', 'disp-logs-0001', 5000],
    ['alarm-a2', 'disp-logs-0002', 9000],
    ['alarm-a1', 'disp-logs-0003', 7000],
    ['alarm-a2', 'disp-logs-0004', 9000],
    ['alarm-a3', 'disp-logs-0005', 1000]
  ];
  for (const [alarmId, clientDispositionId, now] of specs) {
    const result = created.store.createDisposition({
      alarmId, clientDispositionId, outcome: 'FALSE_ALARM', note: ''
    }, now);
    ids.push(result.disposition.dispositionId);
  }

  const all = await (await getSafetyLogs(baseUrl, token)).json();
  assert.equal(all.logs.length, 5);
  const times = all.logs.map((item) => item.serverTime);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), '必须按 serverTime 降序');
  for (const log of all.logs) assertPublicDisposition(log);
  // 每条日志都带对应告警的展示上下文（来自 alerts，不是客户端提交）。
  assert.ok(all.logs.every((item) => typeof item.roomName === 'string' && item.roomName.length > 0));

  const topTwo = await (await getSafetyLogs(baseUrl, token, '?limit=2')).json();
  assert.equal(topTwo.logs.length, 2);
  assert.deepEqual(topTwo.logs.map((item) => item.serverTime), [9000, 9000]);

  // 非法 limit 回退默认 50（而不是 0 条或报错）。
  for (const query of ['?limit=0', '?limit=201', '?limit=abc', '?limit=-5', '?limit=']) {
    const fallback = await getSafetyLogs(baseUrl, token, query);
    assert.equal(fallback.status, 200, query);
    assert.equal((await fallback.json()).logs.length, 5, query);
  }
  assert.equal((await (await getSafetyLogs(baseUrl, token, '?limit=200')).json()).logs.length, 5);
  assert.equal((await (await getSafetyLogs(baseUrl, token, '?limit=1')).json()).logs.length, 1);

  const filtered = await (await getSafetyLogs(baseUrl, token, '?alarmId=alarm-a1')).json();
  assert.equal(filtered.logs.length, 2);
  assert.ok(filtered.logs.every((item) => item.alarmId === 'alarm-a1'));

  // 空 alarmId 参数视为"不过滤"。
  const emptyFilter = await getSafetyLogs(baseUrl, token, '?alarmId=');
  assert.equal(emptyFilter.status, 200);
  assert.equal((await emptyFilter.json()).logs.length, 5);

  const badFilter = await getSafetyLogs(baseUrl, token, '?alarmId=bad!id');
  assert.equal(badFilter.status, 400);
  assert.deepEqual(await badFilter.json(), { error: 'invalid alarm id' });
  assert.ok(ids.length === 5);
});

/* ------------------------------------------------------------ 与 ACK 完全解耦 */

test('registering a disposition never changes alert state, ackPending or ACK commands', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  const alertBefore = JSON.stringify(created.store.getAlert('alarm-a4'));
  const devicesBefore = JSON.stringify(created.store.listDevices());
  const commandsBefore = JSON.stringify(created.store.listCommands(0));
  assert.equal(created.store.listCommands(0).length, 1);

  const response = await postDisposition(baseUrl, token, 'alarm-a4', {
    clientDispositionId: CLIENT_ID_1, outcome: 'ON_SITE_CONFIRMED_NORMAL', note: '现场确认老人一切正常'
  });
  assert.equal(response.status, 201);

  assert.equal(JSON.stringify(created.store.getAlert('alarm-a4')), alertBefore, '处置不得改变告警状态');
  assert.equal(JSON.stringify(created.store.listDevices()), devicesBefore, '处置不得改变设备状态');
  assert.equal(JSON.stringify(created.store.listCommands(0)), commandsBefore, '处置绝不生成 ACK 命令');
  const alert = created.store.getAlert('alarm-a4');
  assert.equal(alert.status, 'ALARM');
  assert.equal(alert.ackPending, false);
});

test('an ACKED alarm still accepts a disposition and stays ACKED', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  const before = created.store.getAlert('alarm-a3');
  assert.equal(before.status, 'ACKED');
  const response = await postDisposition(baseUrl, token, 'alarm-a3', {
    clientDispositionId: CLIENT_ID_2, outcome: 'CONTACTED_FAMILY', note: '家属已到现场'
  });
  assert.equal(response.status, 201);
  assert.equal(created.store.getAlert('alarm-a3').status, 'ACKED');
  assert.equal(created.store.getAlert('alarm-a3').ackPending, false);
  const list = await (await getDispositions(baseUrl, token, 'alarm-a3')).json();
  assert.equal(list.dispositions.length, 1);
});

test('the existing ACK endpoint still returns 202 PENDING with unchanged semantics', async (t) => {
  const created = createApp();
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  const commandsBefore = created.store.listCommands(0).length;
  const logsBefore = created.store.listSafetyLogs().length;
  const ack = await fetch(`${baseUrl}/api/v1/alerts/alarm-a4/ack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ note: '已电话确认\n老人安全' })
  });
  assert.equal(ack.status, 202);
  assert.deepEqual(await ack.json(), { accepted: true, status: 'PENDING', commandId: '2' });
  assert.equal(created.store.listCommands(0).length, commandsBefore + 1);
  assert.equal(created.store.getAlert('alarm-a4').ackPending, true);
  assert.equal(created.store.listSafetyLogs().length, logsBefore, 'ACK 不得写入处置台账');
  // 处置与 ACK 各走各的账，告警状态仍由设备回执决定。
  assert.equal(created.store.getAlert('alarm-a4').status, 'ALARM');
});

test('a storage failure surfaces as a sanitized 503 without leaking paths', async (t) => {
  // 只覆盖 createDisposition 的落盘失败：其余查询语义沿用 MemoryStore。
  class FailingDispositionStore extends MemoryStore {
    createDisposition() {
      const error = new Error('ENOSPC writing C:\\private\\backend-state.json');
      error.code = 'ENOSPC';
      throw error;
    }
  }
  const created = createApp({ store: new FailingDispositionStore() });
  const baseUrl = await listen(created);
  t.after(() => close(created));
  const token = await login(baseUrl);

  const response = await postDisposition(baseUrl, token, 'alarm-a1', {
    clientDispositionId: CLIENT_ID_1, outcome: 'CONTACTED_FAMILY', note: '已联系家属'
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body, { error: 'storage unavailable' });
  assert.equal(JSON.stringify(body).includes('private'), false, '不得泄露文件系统路径');
  assert.equal(created.store.listCommands(0).length, 1, '存储失败不得生成 ACK 命令');
});
