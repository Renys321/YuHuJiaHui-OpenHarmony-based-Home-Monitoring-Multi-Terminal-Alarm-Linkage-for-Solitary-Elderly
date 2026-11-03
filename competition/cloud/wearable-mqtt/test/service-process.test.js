'use strict';

/**
 * service-process.test.js — 真实子进程冒烟测试：
 * 用 `node server.js`（容器 entrypoint 同一入口）启动完整服务，
 * 然后通过真实 TCP 连接 MQTT、发 SOS/GPS、读诊断端口、SIGTERM 退出。
 * 证明 main/server.js 的 env 解析、端口绑定、生命周期是真实可用的。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { FakeBackend } = require('./helpers/fake-backend');
const { RawMqttClient } = require('./helpers/raw-mqtt-client');
const { waitFor, requestJson, sleep } = require('./helpers/harness');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

test('node server.js 完整进程：启动 -> MQTT SOS/GPS -> /healthz -> SIGTERM', async () => {
  const fake = new FakeBackend();
  await fake.start();
  const mqttPort = await freePort();
  const statusPort = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wearable-mqtt-proc-'));
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    MQTT_PORT: String(mqttPort),
    MQTT_USER: 'proc-user',
    MQTT_PASS: 'proc-pass',
    MQTT_CLIENT_ID: 'wearable-sos-001',
    UP_TOPIC: 'eldercare/wearable/sos-001/up',
    DOWN_TOPIC: 'eldercare/wearable/sos-001/down',
    BACKEND_BASE: fake.url,
    INGEST_KEY: fake.ingestKey,
    DATA_DIR: dataDir,
    STATUS_HOST: '127.0.0.1',
    STATUS_PORT: String(statusPort),
    LOG_LEVEL: 'error'
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: 'ignore'
  });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const device = new RawMqttClient();
  try {
    await waitFor(async () => {
      try {
        const health = await requestJson(statusPort, '/healthz');
        return health.statusCode === 200 && health.json && health.json.ok === true;
      } catch {
        return false;
      }
    }, { timeoutMs: 10000 });

    await device.connect({
      port: mqttPort,
      clientId: 'wearable-sos-001',
      username: env.MQTT_USER,
      password: env.MQTT_PASS,
      keepAlive: 60
    });
    await device.publish(env.UP_TOPIC, '113.9737_22.69271', { qos: 1 });
    await device.publish(env.UP_TOPIC, JSON.stringify({
      v: 1,
      t: 'sos',
      dev: 'esp32-sos',
      alarm: 'sos-proc-1',
      uptimeMs: 1000,
      seq: 1,
      gps: null
    }), { qos: 1 });
    await waitFor(() => fake.count('device-status') === 1, { timeoutMs: 5000 });
    assert.equal(fake.records('device-status')[0].body.alarm.id, 'sos-proc-1');
    assert.equal(fake.records('device-status')[0].body.gps.longitude, 113.9737);

    await device.publish(env.UP_TOPIC, JSON.stringify({
      v: 1, t: 'hb', dev: 'esp32-sos', state: 'ALARM', alarm: 'sos-proc-1', uptimeMs: 2
    }), { qos: 1 });
    await waitFor(() => fake.count('device-status') === 2, { timeoutMs: 5000 });
    const heartbeat = fake.records('device-status')[1].body;
    assert.equal(heartbeat.gps.valid, true);
    assert.equal(heartbeat.gps.longitude, 113.9737);
    assert.equal(fake.count('location'), 0, '位置只随 device-status 上报，不调用 location 路由');

    const status = await requestJson(statusPort, '/status');
    assert.equal(status.statusCode, 200);
    assert.equal(status.json.broker.listening, true);
    assert.equal(status.json.adapter.device.state, 'ALARM');
    assert.equal(status.json.adapter.counters.sosReceived, 1);
    assert.equal(status.json.adapter.latestGps.longitude, 113.9737);

    child.kill();
    await waitFor(() => exited !== null, { timeoutMs: 8000 });
    assert.ok(exited, '服务进程必须能退出');
  } finally {
    device.destroy();
    if (!exited) {
      child.kill();
      await sleep(100);
    }
    await fake.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
