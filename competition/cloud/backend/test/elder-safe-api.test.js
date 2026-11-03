'use strict';

/**
 * elder-safe-api.test.js — 老人自述安全事件 HTTP 接口合同测试
 *
 * 覆盖：正常写入/读回、严格输入校验、401 鉴权、容量淘汰、跨重启持久化、
 * 手机号脱敏，以及“上报不改变原告警状态”这一核心约束。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createSessionToken } = require('../src/auth');
const { createApiServer } = require('../src/server');
const { ElderSafeStore } = require('../src/elder-safe-store');

const TOKEN_SECRET = 'test-token-secret-that-is-at-least-32-characters';
const INGEST_KEY = 'test-ingest-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

let directory;
let filePath;
let baseUrl;
let server;
let authHeader;
let elderSafeStore;

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elder-safe-api-'));
  filePath = path.join(directory, 'elder-safe-state.json');
  // 容量收紧到 3，便于验证淘汰；生产默认 200。
  elderSafeStore = new ElderSafeStore({ filePath, maxEvents: 3 });
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    elderSafeStore,
    authorizeIdentity: (openid) => openid === 'openid-test'
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  authHeader = { authorization: `Bearer ${createSessionToken('openid-test', TOKEN_SECRET)}` };
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});

function postElderSafe(body) {
  return fetch(`${baseUrl}/internal/v1/elder-safe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(body)
  });
}

function validBody(overrides = {}) {
  return {
    deviceId: 'esp32-kitchen',
    room: '厨房',
    alarmId: 'a-1791609078-1',
    text: '我没事',
    at: Date.now(),
    source: 'voice-gateway',
    ...overrides
  };
}

async function listEvents(limit = 20) {
  const response = await fetch(`${baseUrl}/api/v1/elder-safe?limit=${limit}`, { headers: authHeader });
  assert.equal(response.status, 200);
  return (await response.json()).events;
}

test('elder-safe endpoints require ingest key and bearer auth', async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/elder-safe`)).status, 401);
  const noKey = await fetch(`${baseUrl}/internal/v1/elder-safe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody())
  });
  assert.equal(noKey.status, 401);
  const wrongKey = await fetch(`${baseUrl}/internal/v1/elder-safe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': 'wrong-key' },
    body: JSON.stringify(validBody())
  });
  assert.equal(wrongKey.status, 401);
});

test('valid report is persisted and readable with the public shape', async () => {
  const body = validBody({ text: '我没事' });
  const response = await postElderSafe(body);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, eventId: 'es-1' });

  const events = await listEvents();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    eventId: 'es-1',
    deviceId: 'esp32-kitchen',
    room: '厨房',
    alarmId: 'a-1791609078-1',
    text: '我没事',
    at: body.at,
    source: 'voice-gateway'
  });
});

test('invalid input is rejected without echoing values or writing records', async () => {
  const cases = [
    validBody({ deviceId: '../escape' }),
    validBody({ room: '' }),
    validBody({ room: '厨'.repeat(41) }),
    validBody({ text: '' }),
    validBody({ text: 'a'.repeat(201) }),
    validBody({ text: 'token sk-abcdefghijklmnopqrstuvwxyz' }),
    validBody({ at: 0 }),
    validBody({ at: 'yesterday' }),
    validBody({ at: Date.now() + 10 * 60 * 1000 }),
    validBody({ alarmId: 'bad id with spaces' }),
    validBody({ source: 'voice gateway' }),
    { ...validBody(), openid: 'openid-test' }
  ];
  for (const body of cases) {
    const response = await postElderSafe(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const text = await response.text();
    assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz'));
    assert.ok(!text.includes('openid-test'));
  }
  const events = await listEvents();
  assert.equal(events.length, 1, 'invalid reports must not be stored');
});

test('phone numbers are masked before persisting', async () => {
  const response = await postElderSafe(validBody({ text: '我没事，有事打 13800001234' }));
  assert.equal(response.status, 202);
  const events = await listEvents();
  assert.equal(events[0].text, '我没事，有事打 138****1234');
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.ok(!raw.includes('13800001234'), 'full phone number must never reach disk');
});

test('recording an elder-safe event never changes the pending alert', async () => {
  const ingest = await fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      deviceId: 'esp32-kitchen',
      room: '厨房',
      online: true,
      state: 'ALARM',
      ts: Date.now(),
      sensors: {},
      alarm: { id: 'alarm-kitchen-1', type: 'GAS', countToday: 1 }
    })
  });
  assert.equal(ingest.status, 202);

  const response = await postElderSafe(validBody({ alarmId: 'alarm-kitchen-1' }));
  assert.equal(response.status, 202);

  const alerts = await (await fetch(`${baseUrl}/api/v1/alerts`, { headers: authHeader })).json();
  const alert = alerts.alerts.find((item) => item.alarmId === 'alarm-kitchen-1');
  assert.ok(alert, 'original alert must still exist');
  // 告警仍处于 ALARM 且未确认：自述安全只记录，绝不自动 ACK。
  assert.equal(alert.state, 'ALARM');
  assert.equal(alert.acknowledgedAt, 0);
  const commands = await (await fetch(`${baseUrl}/internal/v1/commands`, {
    headers: { 'x-ingest-key': INGEST_KEY }
  })).json();
  assert.deepEqual(commands.commands, [], 'no ACK command may be created by an elder-safe report');
});

test('capacity trimming keeps only the newest events', async () => {
  // 目前台账里有 es-1、es-2、es-3；再写 3 条，容量 3 只保留最新的 es-4/5/6。
  for (let i = 0; i < 3; i++) {
    assert.equal((await postElderSafe(validBody({ text: `我没事 ${i}` }))).status, 202);
  }
  const events = await listEvents(100);
  assert.deepEqual(events.map((event) => event.eventId), ['es-6', 'es-5', 'es-4']);
  assert.equal(elderSafeStore.count(), 3);
});

test('limit is clamped and invalid values fall back to 20', async () => {
  assert.equal((await listEvents(0)).length, 3);
  assert.equal((await listEvents(999)).length, 3);
  const response = await fetch(`${baseUrl}/api/v1/elder-safe?limit=abc`, { headers: authHeader });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).events.length, 3);
});

test('events survive a store restart and numbering continues', async () => {
  const reloaded = new ElderSafeStore({ filePath, maxEvents: 3 });
  assert.deepEqual(reloaded.list(20).map((event) => event.eventId), ['es-6', 'es-5', 'es-4']);
  const next = reloaded.record(validBody({ text: '重启后' }));
  assert.equal(next.eventId, 'es-7');
});

test('events older than the retention window are dropped', () => {
  const now = 1_800_000_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elder-safe-retention-'));
  try {
    const store = new ElderSafeStore({
      filePath: path.join(dir, 'state.json'),
      retentionMs: 7 * DAY_MS,
      now: () => now
    });
    store.record(validBody({ text: '八天前', at: now - 8 * DAY_MS }));
    assert.equal(store.count(), 0);
    store.record(validBody({ text: '刚刚', at: now - 1000 }));
    assert.deepEqual(store.list(20).map((event) => event.text), ['刚刚']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
