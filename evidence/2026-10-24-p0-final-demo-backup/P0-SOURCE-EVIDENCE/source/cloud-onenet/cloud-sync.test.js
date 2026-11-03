'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCloudSync, createCloudSyncFromEnv, buildIngestPayload, SYNC_STATES } = require('./cloud-sync');

const NOW = 1791609077775;

function device(overrides = {}) {
  return Object.assign({
    deviceId: 'dayu200-living',
    room: '客厅',
    online: true,
    state: 'NORMAL',
    alarm: { id: '', type: '', countToday: 0 }
  }, overrides);
}

/** 伪 HTTP：记录调用，按脚本返回结果。 */
function makeHttp(script = {}) {
  const calls = [];
  const httpRequest = (options, body, callback) => {
    calls.push({ options, body: body.toString('utf8') });
    if (script.error) return setImmediate(() => callback(script.error));
    setImmediate(() => callback(null, { statusCode: script.statusCode === undefined ? 200 : script.statusCode }));
  };
  return { calls, httpRequest };
}

test('requires an ingest key to be enabled, and stays inert without one', async () => {
  const sync = createCloudSync({ ingestKey: '' });
  assert.equal(sync.enabled, false);
  const result = await sync.publish(device());
  assert.deepEqual(result, { ok: false, code: 'SYNC_DISABLED' });
});

test('posts the exact payload shape the trusted backend ingests', async () => {
  const { calls, httpRequest } = makeHttp();
  const sync = createCloudSync({ ingestKey: 'k', httpRequest, backendUrl: 'http://127.0.0.1:8080' });

  const result = await sync.publish(device({ state: 'ALARM', alarm: { id: 'a-1-2', type: 'MANUAL_SOS', countToday: 3 } }), NOW);

  assert.deepEqual(result, { ok: true, statusCode: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.path, '/internal/v1/device-status');
  assert.equal(calls[0].options.headers['x-ingest-key'], 'k');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), {
    deviceId: 'dayu200-living',
    room: '客厅',
    online: true,
    monitorOnline: -1,
    state: 'ALARM',
    ts: NOW,
    alarm: { id: 'a-1-2', type: 'MANUAL_SOS', countToday: 3, evidenceId: '' }
  });
});

test('preserves validated sensors, GPS and CSQ for the trusted backend', () => {
  const sensors = {
    motion: { lastActiveTs: NOW, countToday: 4 },
    gas: { raw: 17, ok: true },
    smoke: { raw: 8, ok: false }
  };
  const gps = { valid: true, latitude: 34.75, longitude: 113.62, fixTime: NOW };
  const payload = buildIngestPayload(device({ sensors, gps, csq: 25 }), NOW);
  assert.deepEqual(payload.sensors, sensors);
  assert.notEqual(payload.sensors, sensors, 'payload must not retain a mutable caller reference');
  assert.deepEqual(payload.gps, gps);
  assert.equal(payload.csq, 25);
  assert.throws(() => buildIngestPayload(device({ sensors: [] }), NOW), /plain object/);
  assert.throws(() => buildIngestPayload(device({ sensors: { extra: 'x'.repeat(17 * 1024) } }), NOW), /too large/);
  assert.throws(() => buildIngestPayload(device({ csq: 32 }), NOW), /0-31 or 99/);
});

test('preserves the bounded FALL evidence association key', () => {
  const payload = buildIngestPayload(device({
    state: 'ALARM',
    alarm: {
      id: 'a-2-1',
      type: 'FALL',
      countToday: 1,
      evidenceId: 'fall-1791609077775-7'
    }
  }), NOW);
  assert.equal(payload.alarm.evidenceId, 'fall-1791609077775-7');
});

test('rejects an invalid evidence association before network I/O', async () => {
  const { calls, httpRequest } = makeHttp();
  const sync = createCloudSync({ ingestKey: 'k', httpRequest });
  const result = await sync.publish(device({
    state: 'ALARM',
    alarm: { id: 'a-1', type: 'FALL', countToday: 1, evidenceId: '../../reset' }
  }), NOW);
  assert.deepEqual(result, { ok: false, code: 'SYNC_INVALID_STATUS' });
  assert.equal(calls.length, 0);
});

test('every synced state is one the backend accepts', async () => {
  for (const state of ['NORMAL', 'WARN', 'ALARM', 'ACKED']) {
    const payload = buildIngestPayload(device({ state }), NOW);
    assert.ok(SYNC_STATES.has(payload.state), `${state} must be accepted by the backend`);
    assert.equal(payload.state, state);
  }
});

test('a device OFFLINE state is expressed as online=false with an accepted state', () => {
  const payload = buildIngestPayload(device({ state: 'OFFLINE', online: false }), NOW);
  assert.equal(payload.online, false);
  assert.ok(SYNC_STATES.has(payload.state), 'OFFLINE is a gateway-local state and must not be forwarded as-is');
});

test('preserves strict monitor status for the trusted backend and rejects invalid values', async () => {
  assert.equal(buildIngestPayload(device({ monitorOnline: 0 }), NOW).monitorOnline, 0);
  assert.equal(buildIngestPayload(device(), NOW).monitorOnline, -1);

  const { calls, httpRequest } = makeHttp();
  const sync = createCloudSync({ ingestKey: 'k', httpRequest });
  assert.deepEqual(await sync.publish(device({ monitorOnline: 2 }), NOW), {
    ok: false,
    code: 'SYNC_INVALID_STATUS'
  });
  assert.equal(calls.length, 0);
});

test('backend failures never throw and are reduced to safe codes', async () => {
  const { httpRequest } = makeHttp({ error: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const sync = createCloudSync({ ingestKey: 'k', httpRequest });
  const result = await sync.publish(device(), NOW);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ECONNREFUSED');
});

test('non-2xx responses are reported as a safe HTTP error code, not a success', async () => {
  const { httpRequest } = makeHttp({ statusCode: 401 });
  const sync = createCloudSync({ ingestKey: 'k', httpRequest });
  const result = await sync.publish(device(), NOW);
  assert.deepEqual(result, { ok: false, code: 'SYNC_HTTP_ERROR', statusCode: 401 });
});

test('a throwing http transport is contained instead of crashing the gateway', async () => {
  const sync = createCloudSync({
    ingestKey: 'k',
    httpRequest: () => { throw new Error('transport exploded'); }
  });
  const result = await sync.publish(device(), NOW);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SYNC_REQUEST_FAILED');
});

test('an invalid device is rejected locally without any network call', async () => {
  const { calls, httpRequest } = makeHttp();
  const sync = createCloudSync({ ingestKey: 'k', httpRequest });
  const result = await sync.publish({ deviceId: '', room: 'x', state: 'NORMAL', alarm: {} }, NOW);
  assert.deepEqual(result, { ok: false, code: 'SYNC_INVALID_STATUS' });
  assert.equal(calls.length, 0);
});

test('the ingest key never appears in logs', async () => {
  const secret = 'backend-ingest-secret-value';
  const logged = [];
  const { httpRequest } = makeHttp({ statusCode: 500 });
  const sync = createCloudSync({
    ingestKey: secret,
    httpRequest,
    logger: { warn: (m) => logged.push(m), info: (m) => logged.push(m) }
  });
  await sync.publish(device(), NOW);
  const joined = logged.join('\n');
  assert.ok(joined.includes('SYNC_HTTP_ERROR'), 'the safe code is logged');
  assert.ok(!joined.includes(secret), 'the ingest key must never be logged');
});

test('rejects a backend URL carrying credentials, query or fragment', () => {
  assert.throws(() => createCloudSync({ ingestKey: 'k', backendUrl: 'http://user:pass@127.0.0.1:8080' }), /credential/);
  assert.throws(() => createCloudSync({ ingestKey: 'k', backendUrl: 'http://127.0.0.1:8080/?a=1' }), /query/);
  assert.throws(() => createCloudSync({ ingestKey: 'k', backendUrl: 'ftp://127.0.0.1' }), /http/);
});

test('createCloudSyncFromEnv reads BACKEND_URL and BACKEND_INGEST_KEY', () => {
  const disabled = createCloudSyncFromEnv({});
  assert.equal(disabled.enabled, false);

  const enabled = createCloudSyncFromEnv({ BACKEND_URL: 'http://127.0.0.1:9090', BACKEND_INGEST_KEY: 'k' });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.endpoint, 'http://127.0.0.1:9090/internal/v1/device-status');
});

/* -------------------------------------------------- 与网关的接线（旁路语义） */

test('the gateway syncs aggregated state to the backend without blocking on it', async () => {
  const { HomeCloudGateway } = require('./gateway');
  const synced = [];
  const cloudSync = {
    enabled: true,
    publish: (status, ts) => { synced.push({ status, ts }); return Promise.resolve({ ok: true }); }
  };
  const transport = { publishProperty: () => Promise.resolve({ id: '1', code: 200 }), publishAlarm: () => Promise.resolve({ id: '1', code: 200 }), on() {}, off() {} };
  const statusSource = { subscribe: () => () => {}, publish() {}, close: () => Promise.resolve() };

  let clock = NOW;
  const gateway = new HomeCloudGateway({
    transport, statusSource, cloudSync,
    deviceName: 'dayu200-living', resetMode: 'self',
    now: () => (clock += 1000),
    logger: { info() {}, warn() {}, error() {} }
  });
  gateway.start();
  await gateway.ingest(JSON.stringify({
    deviceId: 'dayu200-living', room: '客厅', ts: NOW, state: 'ALARM',
    sensors: { motion: { lastActiveTs: NOW, countToday: 1 }, door: { open: false, lastOpenTs: 0 }, climate: { tempC: 20, rh: 40, ok: true }, gas: { raw: 1, ok: true }, smoke: { raw: 1, ok: true } },
    history: [0, 0, 0, 0, 0, 0, 0], slots: [0, 0, 0, 0],
    alarm: { id: 'a-1-1', type: 'FALL', countToday: 1, evidenceId: 'fall-1791609077775-7' }
  }));
  await new Promise((r) => setImmediate(r));

  assert.equal(synced.length, 1, 'the aggregated status must be synced once');
  assert.equal(synced[0].status.deviceId, 'dayu200-living');
  assert.equal(synced[0].status.room, '客厅');
  assert.equal(synced[0].status.state, 'ALARM');
  assert.equal(synced[0].status.alarm.id, 'a-1-1');
  assert.equal(synced[0].status.alarm.evidenceId, 'fall-1791609077775-7',
    'evidenceId must survive real gateway validation and aggregation');
  assert.deepEqual(synced[0].status.sensors.motion, { lastActiveTs: NOW, countToday: 1 });
  assert.deepEqual(synced[0].status.sensors.gas, { raw: 1, ok: true });
  const { toPropertyPost } = require('./adapter');
  const property = toPropertyPost(synced[0].status, { id: '1', timestampMs: NOW });
  assert.equal(Object.hasOwn(property.params.alarm.value, 'evidenceId'), false,
    'private evidence association must not change the OneNET thing model');
  await gateway.stop('T');
});

test('a broken backend sync cannot break local ingestion or alarm dedup', async () => {
  const { HomeCloudGateway } = require('./gateway');
  const cloudSync = {
    enabled: true,
    publish: () => Promise.reject(new Error('backend down'))
  };
  const calls = { property: 0, alarm: 0 };
  const transport = {
    publishProperty: () => { calls.property += 1; return Promise.resolve({ id: '1', code: 200 }); },
    publishAlarm: () => { calls.alarm += 1; return Promise.resolve({ id: '1', code: 200 }); },
    on() {}, off() {}
  };
  const statusSource = { subscribe: () => () => {}, publish() {}, close: () => Promise.resolve() };
  let clock = NOW;
  const gateway = new HomeCloudGateway({
    transport, statusSource, cloudSync,
    deviceName: 'dayu200-living', resetMode: 'self',
    now: () => (clock += 1000),
    logger: { info() {}, warn() {}, error() {} }
  });
  gateway.start();
  const line = JSON.stringify({
    deviceId: 'dayu200-living', room: '客厅', ts: NOW, state: 'ALARM',
    sensors: { motion: { lastActiveTs: NOW, countToday: 1 }, door: { open: false, lastOpenTs: 0 }, climate: { tempC: 20, rh: 40, ok: true }, gas: { raw: 1, ok: true }, smoke: { raw: 1, ok: true } },
    history: [0, 0, 0, 0, 0, 0, 0], slots: [0, 0, 0, 0],
    alarm: { id: 'a-2-1', type: 'MANUAL_SOS', countToday: 1 }
  });
  const result = await gateway.ingest(line);
  await new Promise((r) => setImmediate(r));

  assert.equal(result.accepted, true, 'local ingestion must still succeed');
  assert.equal(calls.alarm, 1, 'the OneNET alarm path must still fire');
  assert.equal(gateway.devices.get('dayu200-living').state, 'ALARM');
  await gateway.stop('T');
});
