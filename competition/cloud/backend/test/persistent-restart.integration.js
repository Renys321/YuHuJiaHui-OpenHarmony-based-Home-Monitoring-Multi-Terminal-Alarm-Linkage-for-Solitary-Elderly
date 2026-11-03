'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { HOUSEHOLD_ACTOR, createApiServer } = require('../src/server');
const { PersistentStore } = require('../src/persistent-store');

const TOKEN_SECRET = 'restart-test-token-secret-at-least-32-characters';
const INGEST_KEY = 'restart-test-ingest-key';

async function start(filePath) {
  const store = new PersistentStore({ filePath });
  const created = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === 'openid-restart-test',
    wechat: {
      appId: 'wx-restart-test',
      appSecret: 'restart-test-wechat-secret',
      fetchImpl: async () => ({ ok: true, json: async () => ({ openid: 'openid-restart-test' }) })
    }
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${created.server.address().port}`,
    close: () => new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve())),
    store
  };
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/auth/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'restart_login_code' })
  });
  assert.equal(response.status, 200);
  return (await response.json()).sessionToken;
}

async function ingest(baseUrl, status) {
  return fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(status)
  });
}

test('HTTP state and command lifecycle survive two real server restarts', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-backend-restart-'));
  const filePath = path.join(directory, 'state.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const alarm = {
    deviceId: 'esp32-bedroom', room: '卧室', online: true, state: 'ALARM', ts: 1791609400000,
    alarm: { id: 'alarm-restart-1', type: 'NO_MOTION', countToday: 1 }
  };

  const first = await start(filePath);
  assert.equal((await ingest(first.baseUrl, alarm)).status, 202);
  const firstToken = await login(first.baseUrl);
  const ack = await fetch(`${first.baseUrl}/api/v1/alerts/alarm-restart-1/ack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${firstToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ note: '重启后继续处理' })
  });
  assert.equal(ack.status, 202);
  assert.equal((await ack.json()).commandId, '1');
  await first.close();

  const second = await start(filePath);
  const commands = await fetch(`${second.baseUrl}/internal/v1/commands?after=0`, {
    headers: { 'x-ingest-key': INGEST_KEY }
  });
  const pending = (await commands.json()).commands;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'PENDING');

  const completed = await fetch(`${second.baseUrl}/internal/v1/commands/1/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({ status: 'ACKED', deviceState: { ...alarm, state: 'ACKED', ts: 1791609401000 } })
  });
  assert.equal(completed.status, 200);
  await second.close();

  const third = await start(filePath);
  const thirdToken = await login(third.baseUrl);
  const alerts = await fetch(`${third.baseUrl}/api/v1/alerts`, {
    headers: { authorization: `Bearer ${thirdToken}` }
  });
  const restored = (await alerts.json()).alerts.find((item) => item.alarmId === 'alarm-restart-1');
  assert.equal(restored.state, 'ACKED');
  assert.equal(restored.acknowledgedBy, HOUSEHOLD_ACTOR);

  const secondAlarm = { ...alarm, ts: 1791609500000, alarm: { ...alarm.alarm, id: 'alarm-restart-2' } };
  assert.equal((await ingest(third.baseUrl, secondAlarm)).status, 202);
  const secondAck = await fetch(`${third.baseUrl}/api/v1/alerts/alarm-restart-2/ack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${thirdToken}`, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal((await secondAck.json()).commandId, '2');
  await third.close();

  const snapshot = fs.readFileSync(filePath, 'utf8');
  assert.ok(!snapshot.includes(TOKEN_SECRET));
  assert.ok(!snapshot.includes(INGEST_KEY));
  assert.ok(!snapshot.includes('restart-test-wechat-secret'));
  assert.ok(!snapshot.includes('openid-restart-test'));
});

test('storage failures return a generic 503 without leaking filesystem details', async () => {
  const failingStore = {
    ingest() {
      const error = new Error('ENOSPC writing C:\\private\\backend-state.json');
      error.code = 'ENOSPC';
      throw error;
    }
  };
  const created = createApiServer({ store: failingStore, ingestKey: INGEST_KEY, tokenSecret: TOKEN_SECRET });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  try {
    const response = await ingest(baseUrl, { deviceId: 'esp32-test', state: 'NORMAL' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'storage unavailable' });
  } finally {
    await new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve()));
  }
});
