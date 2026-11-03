'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { buildConfig } = require('../src/config');
const { Mirror } = require('../src/mirror');
const { FakeApi } = require('./helpers/fake-api');
const { FakeHomemon } = require('./helpers/fake-homemon');
const { waitFor, sleep } = require('./helpers/wait');

const T0 = 1_793_100_000_000;
const GUARDIAN_ID = 'guardian-id';
const GUARDIAN_PASS = 'guardian-pass';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wearable-mirror-int-'));
}

function newApi() {
  return new FakeApi({ guardianId: GUARDIAN_ID, password: GUARDIAN_PASS });
}

function createConfig(root, apiBase, relayPort, listenPort) {
  const envFile = path.join(root, 'wearable.env');
  fs.writeFileSync(envFile, [
    'MQTT_USER=test-user',
    'MQTT_PASS=test-pass',
    'UP_TOPIC=eldercare/wearable/sos-001/up'
  ].join('\n'), 'utf8');
  const guardianFile = path.join(root, 'guardian.txt');
  fs.writeFileSync(guardianFile, `${GUARDIAN_ID}\n${GUARDIAN_PASS}\n`, 'utf8');
  return buildConfig([
    '--env-file', envFile,
    '--guardian-file', guardianFile,
    '--source', 'api',
    '--transport', 'both',
    '--relay-to', `127.0.0.1:${relayPort}`,
    '--listen-port', String(listenPort),
    '--runtime-dir', path.join(root, 'runtime'),
    '--heartbeat-ms', '150',
    '--offline-after-ms', '60000',
    '--emit-debounce-ms', '10',
    '--poll-ms', '40',
    '--api-base', apiBase
  ], {});
}

function setAlarm(api, state, acknowledgedAt = 0) {
  api.devices = [{
    id: 'esp32-sos', deviceId: 'esp32-sos', roomName: '随身求助',
    online: true, state, lastSeenTs: T0, sensors: {}, csq: 26
  }];
  api.alerts = [{
    id: 'sos-30-int', alarmId: 'sos-30-int', deviceId: 'esp32-sos', roomName: '随身求助',
    type: 'MANUAL_SOS', state, ackPending: state !== 'ACKED',
    createdAt: T0 - 1000, acknowledgedAt
  }];
  api.locations = [{
    deviceId: 'esp32-sos', latitude: 32.9668274, longitude: 112.5532608, fixTime: T0 - 2000
  }];
}

test('端到端：API → 状态机 → relay/tcp 注入；心跳不重复告警；重连补发当前状态', async (t) => {
  const root = tempDir();
  const api = await newApi().start();
  t.after(() => api.close());
  setAlarm(api, 'ALARM');
  const homemon = await new FakeHomemon().start();
  t.after(() => homemon.close());
  const listenPort = await freePort();
  const config = createConfig(root, api.base, homemon.port, listenPort);

  const logs = [];
  const mirror = new Mirror({ config, log: (line) => logs.push(line) });
  t.after(async () => {
    try { await mirror.stop('test'); } catch (err) { /* ignore */ }
  });
  await mirror.start();

  await waitFor(() => homemon.relayLines().length >= 1, {
    timeout: 6000,
    label: `relay line emitted (logs=${logs.slice(-6).join(' | ')})`
  });
  const first = homemon.relayJson()[0];
  assert.equal(first.deviceId, 'esp32-sos');
  assert.equal(first.room, '随身求助');
  assert.equal(first.state, 'ALARM');
  assert.equal(first.alarm.id, 'sos-30-int');
  assert.equal(first.alarm.type, 'MANUAL_SOS');
  assert.equal(typeof first.ts, 'number');
  assert.equal(typeof first.lastSeen, 'number');
  assert.deepEqual(first.sensors.motion, {
    lastActiveTs: 0, countToday: 0, supported: false, reported: false, reason: 'not_configured'
  });
  assert.equal(first.gps.valid, true);
  assert.equal(first.gps.latitude, 32.9668274);
  assert.equal(first.gps.longitude, 112.5532608);
  assert.ok(first.gps.fixTime > 0);

  await waitFor(() => homemon.relayLines().length >= 2, { timeout: 4000, label: 'heartbeat' });
  const alarmIds = new Set(homemon.relayJson().map((item) => item.alarm.id));
  assert.equal(alarmIds.size, 1);
  assert.equal([...alarmIds][0], 'sos-30-int');

  setAlarm(api, 'ACKED', T0 + 5000);
  await waitFor(() => homemon.relayJson().some((item) => item.state === 'ACKED'), { timeout: 4000, label: 'acked emitted' });
  const acked = homemon.relayJson().filter((item) => item.state === 'ACKED').pop();
  assert.equal(acked.alarm.id, 'sos-30-int');
  assert.equal(acked.ackTs, T0 + 5000);
  assert.equal(acked.ackSource, 'device-ack-via-backend');

  const mirror2 = new Mirror({ config, log: () => {} });
  await assert.rejects(() => mirror2.start(), (err) => err.code === 'ELOCKED');

  const relayPort = homemon.port;
  await homemon.close();
  const homemon2 = await new FakeHomemon({ port: relayPort }).start();
  t.after(() => homemon2.close());
  await waitFor(() => homemon2.relayLines().length >= 1, { timeout: 8000, label: 'relay reconnect resend' });
  const resent = homemon2.relayJson()[0];
  assert.equal(resent.alarm.id, 'sos-30-int');
  assert.equal(resent.state, 'ACKED');
  const allAlarmIds = new Set(homemon2.relayJson().map((item) => item.alarm.id));
  assert.equal(allAlarmIds.size, 1);

  const client = net.createConnection({ host: '127.0.0.1', port: listenPort });
  t.after(() => client.destroy());
  const received = [];
  client.on('data', (chunk) => received.push(chunk.toString('utf8')));
  await waitFor(() => received.join('').includes('"deviceId":"esp32-sos"'), { timeout: 4000, label: 'tcp status' });

  await waitFor(() => fs.existsSync(config.statusFile), { label: 'status file' });
  const statusText = fs.readFileSync(config.statusFile, 'utf8');
  assert.equal(statusText.includes(GUARDIAN_PASS), false);
  assert.equal(statusText.includes('test-pass'), false);
  assert.equal(statusText.includes('"phase": "ACKED"'), true);

  await mirror.stop('test-done');
});

test('数据源没有真实数据之前绝不会先推一条“一切正常”', async (t) => {
  const root = tempDir();
  const api = await newApi().start();
  t.after(() => api.close());
  api.devices = [];
  api.alerts = [];
  api.locations = [];
  const homemon = await new FakeHomemon().start();
  t.after(() => homemon.close());
  const config = createConfig(root, api.base, homemon.port, await freePort());
  const mirror = new Mirror({ config, log: () => {} });
  t.after(async () => {
    try { await mirror.stop('test'); } catch (err) { /* ignore */ }
  });
  await mirror.start();
  await sleep(400);
  assert.equal(homemon.relayLines().length, 0);

  setAlarm(api, 'ALARM');
  await waitFor(() => homemon.relayLines().length >= 1, { timeout: 6000, label: 'first real data emit' });
  assert.equal(homemon.relayJson()[0].state, 'ALARM');
});
