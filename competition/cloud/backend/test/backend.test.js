'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createSessionToken, exchangeWechatCode, verifySessionToken } = require('../src/auth');
const { EvidenceStore } = require('../src/evidence-store');
const { HOUSEHOLD_ACTOR, createApiServer } = require('../src/server');
const { normalizeDashboard } = require('../../../mobile/wechat-miniprogram/utils/validators');

const TOKEN_SECRET = 'test-token-secret-that-is-at-least-32-characters';
const INGEST_KEY = 'test-ingest-secret';
let baseUrl;
let server;
let authHeader;

before(async () => {
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === 'openid-route-test' || openid === 'openid-test',
    wechat: {
      appId: 'wx-test',
      appSecret: 'test-server-secret',
      fetchImpl: async () => ({ ok: true, json: async () => ({ openid: 'openid-route-test' }) })
    }
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  authHeader = { authorization: `Bearer ${createSessionToken('openid-test', TOKEN_SECRET)}` };
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('session tokens verify and expire', () => {
  const token = createSessionToken('openid-1', TOKEN_SECRET, 1000, 500);
  assert.equal(verifySessionToken(token, TOKEN_SECRET, 1200).sub, 'openid-1');
  assert.equal(verifySessionToken(token, TOKEN_SECRET, 1600), null);
  assert.equal(verifySessionToken(`${token}x`, TOKEN_SECRET, 1200), null);
});

test('WeChat code exchange keeps secret on the server request', async () => {
  let requested;
  const identity = await exchangeWechatCode('login_code_1', {
    appId: 'wx-app',
    appSecret: 'server-secret',
    fetchImpl: async (url) => {
      requested = url;
      return { ok: true, json: async () => ({ openid: 'openid-2' }) };
    }
  });
  assert.equal(identity.openid, 'openid-2');
  assert.equal(requested.searchParams.get('secret'), 'server-secret');
});

test('health and readiness are public but device data requires authentication', async () => {
  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/v1/overview`)).status, 401);
});

test('readiness fails closed without exposing the storage error', async () => {
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    readyCheck: () => { throw new Error('do not expose C:\\private\\state.json'); }
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${created.server.address().port}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'storage unavailable' });
  } finally {
    await new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('WeChat login route returns the sessionToken expected by the Mini Program', async () => {
  const response = await fetch(`${baseUrl}/api/v1/auth/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'single_use_code' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.sessionToken, 'string');
  assert.equal(verifySessionToken(body.sessionToken, TOKEN_SECRET).sub, 'openid-route-test');
});

test('unknown household identities cannot log in and receive no token', async () => {
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: () => false,
    wechat: {
      appId: 'wx-test',
      appSecret: 'test-server-secret',
      fetchImpl: async () => ({ ok: true, json: async () => ({ openid: 'openid-not-allowed' }) })
    }
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${created.server.address().port}/api/v1/auth/wechat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'denied_code' })
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'forbidden' });
  } finally {
    await new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('an existing token loses access immediately after its identity is removed', async () => {
  const allowed = new Set(['openid-removable']);
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => allowed.has(openid)
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${created.server.address().port}/api/v1/overview`;
  const headers = { authorization: `Bearer ${createSessionToken('openid-removable', TOKEN_SECRET)}` };
  try {
    assert.equal((await fetch(url, { headers })).status, 200);
    allowed.clear();
    const denied = await fetch(url, { headers });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'forbidden' });
  } finally {
    await new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('missing household authorization fails closed without disabling internal ingest', async () => {
  const created = createApiServer({ tokenSecret: TOKEN_SECRET, ingestKey: INGEST_KEY });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const isolatedUrl = `http://127.0.0.1:${created.server.address().port}`;
  try {
    const household = await fetch(`${isolatedUrl}/api/v1/overview`, {
      headers: { authorization: `Bearer ${createSessionToken('any-openid', TOKEN_SECRET)}` }
    });
    assert.equal(household.status, 403);

    const internal = await fetch(`${isolatedUrl}/internal/v1/device-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
      body: JSON.stringify({ deviceId: 'internal-only-node', room: '测试', state: 'NORMAL' })
    });
    assert.equal(internal.status, 202);
  } finally {
    await new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('protected ingest creates room, alert, location and an ACK command', async () => {
  const status = {
    deviceId: 'esp32-bath',
    room: '卫生间',
    online: true,
    monitorOnline: 0,
    state: 'ALARM',
    ts: 1791609077775,
    sensors: { motion: { countToday: 3 }, gas: { ok: true } },
    alarm: { id: 'alarm-1', type: 'NO_MOTION', countToday: 1 },
    gps: { valid: true, latitude: 34.75, longitude: 113.62, fixTime: 1791609077000 },
    csq: 25
  };
  const denied = await fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(status)
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(status)
  });
  assert.equal(accepted.status, 202);

  const rooms = await (await fetch(`${baseUrl}/api/v1/rooms`, { headers: authHeader })).json();
  assert.equal(rooms.rooms[0].name, '卫生间');
  assert.equal(rooms.rooms[0].devices[0].id, 'esp32-bath');
  const location = await (await fetch(`${baseUrl}/api/v1/location`, { headers: authHeader })).json();
  assert.equal(location.locations[0].latitude, 34.75);

  const devices = await (await fetch(`${baseUrl}/api/v1/devices`, { headers: authHeader })).json();
  const alerts = await (await fetch(`${baseUrl}/api/v1/alerts`, { headers: authHeader })).json();
  const dashboard = normalizeDashboard({
    rooms: rooms.rooms,
    devices: devices.devices,
    alarms: alerts.alerts
  });
  assert.equal(dashboard.rooms.length, 1);
  assert.equal(dashboard.devices[0].id, 'esp32-bath');
  assert.equal(dashboard.devices[0].monitorOnline, 0);
  assert.equal(dashboard.alarms[0].id, 'alarm-1');
  const overview = await (await fetch(`${baseUrl}/api/v1/overview`, { headers: authHeader })).json();
  assert.equal(overview.monitorOfflineCount, 1);

  const ack = await fetch(`${baseUrl}/api/v1/alerts/alarm-1/ack`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ note: '已电话确认\n老人安全' })
  });
  assert.equal(ack.status, 202);
  assert.deepEqual(await ack.json(), { accepted: true, status: 'PENDING', commandId: '1' });

  const commands = await (await fetch(`${baseUrl}/internal/v1/commands?after=0`, {
    headers: { 'x-ingest-key': INGEST_KEY }
  })).json();
  assert.equal(commands.commands.length, 1);
  assert.equal(commands.commands[0].deviceId, 'esp32-bath');
  assert.equal(commands.commands[0].action, '已电话确认 老人安全');
});

test('invalid identifiers and unknown alarms are rejected', async () => {
  const invalid = await fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({ deviceId: '../bad', room: 'x', state: 'NORMAL' })
  });
  assert.equal(invalid.status, 400);

  const invalidMonitor = await fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({ deviceId: 'valid-node', room: 'x', state: 'NORMAL', monitorOnline: 2 })
  });
  assert.equal(invalidMonitor.status, 400);

  const missing = await fetch(`${baseUrl}/api/v1/alerts/missing/ack`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: '{}'
  });
  assert.equal(missing.status, 404);
});

test('FALL evidence uploads before status, binds exactly, and only authorized households can read it', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-evidence-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === 'openid-evidence',
    evidenceStore: new EvidenceStore({ directory })
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve())));
  const local = `http://127.0.0.1:${created.server.address().port}`;
  const evidenceId = 'fall-1791609077775-7';
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9]);

  const noKey = await fetch(`${local}/internal/v1/evidence/${evidenceId}`, {
    method: 'PUT', headers: { 'content-type': 'image/jpeg', 'x-device-id': 'dayu200-living' }, body: jpeg
  });
  assert.equal(noKey.status, 401);

  const upload = await fetch(`${local}/internal/v1/evidence/${evidenceId}`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/jpeg',
      'x-device-id': 'dayu200-living',
      'x-ingest-key': INGEST_KEY
    },
    body: jpeg
  });
  assert.equal(upload.status, 201);
  assert.deepEqual(await upload.json(), { accepted: true, created: true, bound: false });

  const status = await fetch(`${local}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      deviceId: 'dayu200-living', room: '客厅', state: 'ALARM', ts: 1791609078000,
      alarm: { id: 'a-1791609078-1', type: 'FALL', countToday: 1, evidenceId }
    })
  });
  assert.equal(status.status, 202);

  assert.equal((await fetch(`${local}/api/v1/alerts/a-1791609078-1/evidence/content`)).status, 401);
  assert.equal((await fetch(`${local}/api/v1/alerts/a-1791609078-1/evidence/content?token=bad`)).status, 401);
  const household = {
    authorization: `Bearer ${createSessionToken('openid-evidence', TOKEN_SECRET)}`
  };
  const alerts = await (await fetch(`${local}/api/v1/alerts`, { headers: household })).json();
  assert.deepEqual(alerts.alerts[0].evidence, {
    available: true,
    evidenceId,
    bytes: jpeg.length,
    capturedAt: 1791609077775
  });
  assert.equal(Object.prototype.hasOwnProperty.call(alerts.alerts[0], 'evidenceId'), false);

  const metadataResponse = await fetch(`${local}/api/v1/alerts/a-1791609078-1/evidence`, { headers: household });
  assert.equal(metadataResponse.status, 200);
  const metadata = (await metadataResponse.json()).evidence;
  assert.equal(metadata.alarmId, 'a-1791609078-1');
  assert.equal(metadata.deviceId, 'dayu200-living');
  assert.equal(typeof metadata.sha256, 'string');
  assert.equal(JSON.stringify(metadata).includes(directory), false);

  const content = await fetch(`${local}/api/v1/alerts/a-1791609078-1/evidence/content`, { headers: household });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('content-type'), 'image/jpeg');
  assert.equal(content.headers.get('cache-control'), 'private, no-store');
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), jpeg);

  const secondEvidenceId = 'fall-1791609088888-na';
  const statusFirst = await fetch(`${local}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      deviceId: 'dayu200-living', room: '客厅', state: 'ALARM', ts: 1791609089000,
      alarm: { id: 'a-1791609089-2', type: 'FALL', countToday: 2, evidenceId: secondEvidenceId }
    })
  });
  assert.equal(statusFirst.status, 202);
  const uploadSecond = await fetch(`${local}/internal/v1/evidence/${secondEvidenceId}`, {
    method: 'PUT',
    headers: {
      'content-type': 'image/jpeg',
      'x-device-id': 'dayu200-living',
      'x-ingest-key': INGEST_KEY
    },
    body: jpeg
  });
  assert.equal(uploadSecond.status, 201);
  assert.deepEqual(await uploadSecond.json(), { accepted: true, created: true, bound: true });
  assert.equal((await fetch(`${local}/api/v1/alerts/a-1791609089-2/evidence/content`, {
    headers: household
  })).status, 200);

  const tooLarge = await fetch(`${local}/internal/v1/evidence/fall-1791609089999-na`, {
    method: 'PUT', headers: {
      'content-type': 'image/jpeg', 'x-device-id': 'dayu200-living', 'x-ingest-key': INGEST_KEY
    }, body: Buffer.alloc(2 * 1024 * 1024 + 1)
  });
  assert.equal(tooLarge.status, 413);
  const forbidden = await fetch(`${local}/api/v1/alerts/a-1791609078-1/evidence/content`, {
    headers: { authorization: `Bearer ${createSessionToken('other-household', TOKEN_SECRET)}` }
  });
  assert.equal(forbidden.status, 403);
});

test('a matching device receipt completes the queued ACK and is idempotent', async () => {
  const status = {
    deviceId: 'esp32-kitchen', room: '厨房', online: true, monitorOnline: 0,
    state: 'ALARM', ts: 1791609200000, sensors: { gas: { ok: false, raw: 700 } }, csq: 18,
    alarm: { id: 'alarm-kitchen-1', type: 'GAS', countToday: 1 }
  };
  await fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(status)
  });
  const ack = await fetch(`${baseUrl}/api/v1/alerts/alarm-kitchen-1/ack`, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ note: '已确认厨房安全' })
  });
  const commandId = (await ack.json()).commandId;
  const receipt = {
    status: 'ACKED',
    deviceState: {
      deviceId: status.deviceId,
      room: status.room,
      online: true,
      state: 'ACKED',
      ts: 1791609201000,
      alarm: status.alarm
    }
  };
  const endpoint = `${baseUrl}/internal/v1/commands/${commandId}/result`;
  const first = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(receipt)
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, 'ACKED');
  const second = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(receipt)
  });
  assert.equal(second.status, 200);
  const alerts = await (await fetch(`${baseUrl}/api/v1/alerts`, { headers: authHeader })).json();
  const alert = alerts.alerts.find((item) => item.id === 'alarm-kitchen-1');
  assert.equal(alert.state, 'ACKED');
  assert.equal(alert.ackPending, false);
  assert.equal(alert.acknowledgedBy, HOUSEHOLD_ACTOR);
  const devices = await (await fetch(`${baseUrl}/api/v1/devices`, { headers: authHeader })).json();
  const device = devices.devices.find((item) => item.id === status.deviceId);
  assert.equal(device.monitorOnline, 0, 'partial ACK receipt must not hide an existing monitor outage');
  assert.deepEqual(device.sensors, status.sensors);
  assert.equal(device.csq, status.csq);
});

test('failed, unknown, mismatched and conflicting command results fail closed', async () => {
  const createAlarm = async (id) => {
    await fetch(`${baseUrl}/internal/v1/device-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
      body: JSON.stringify({
        deviceId: 'esp32-bedroom', room: '卧室', online: true, state: 'ALARM', ts: 1791609300000,
        alarm: { id, type: 'NO_MOTION', countToday: 1 }
      })
    });
    const response = await fetch(`${baseUrl}/api/v1/alerts/${id}/ack`, {
      method: 'POST', headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ note: '家属处理中' })
    });
    return (await response.json()).commandId;
  };

  const mismatchId = await createAlarm('alarm-bedroom-mismatch');
  const mismatch = await fetch(`${baseUrl}/internal/v1/commands/${mismatchId}/result`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      status: 'ACKED',
      deviceState: {
        deviceId: 'esp32-other', room: '卧室', online: true, state: 'ACKED', ts: 1791609301000,
        alarm: { id: 'alarm-bedroom-mismatch', type: 'NO_MOTION' }
      }
    })
  });
  assert.equal(mismatch.status, 400);

  const failedId = await createAlarm('alarm-bedroom-failed');
  const failedEndpoint = `${baseUrl}/internal/v1/commands/${failedId}/result`;
  const failed = await fetch(failedEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({ status: 'FAILED', code: 'DEVICE_TIMEOUT' })
  });
  assert.equal(failed.status, 200);
  assert.equal((await failed.json()).status, 'FAILED');
  const conflict = await fetch(failedEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({
      status: 'ACKED',
      deviceState: {
        deviceId: 'esp32-bedroom', room: '卧室', online: true, state: 'ACKED', ts: 1791609302000,
        alarm: { id: 'alarm-bedroom-failed', type: 'NO_MOTION' }
      }
    })
  });
  assert.equal(conflict.status, 400);

  const missing = await fetch(`${baseUrl}/internal/v1/commands/999999/result`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({ status: 'FAILED', code: 'DEVICE_TIMEOUT' })
  });
  assert.equal(missing.status, 404);
  const invalid = await fetch(`${baseUrl}/internal/v1/commands/not-a-number/result`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({ status: 'FAILED', code: 'DEVICE_TIMEOUT' })
  });
  assert.equal(invalid.status, 400);

  const alerts = await (await fetch(`${baseUrl}/api/v1/alerts`, { headers: authHeader })).json();
  const failedAlert = alerts.alerts.find((item) => item.id === 'alarm-bedroom-failed');
  assert.equal(failedAlert.state, 'ALARM');
  assert.equal(failedAlert.ackPending, false);
});

