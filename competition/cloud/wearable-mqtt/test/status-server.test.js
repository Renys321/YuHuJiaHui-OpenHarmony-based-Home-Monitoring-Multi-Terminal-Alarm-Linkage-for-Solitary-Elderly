'use strict';

/**
 * status-server.test.js — 诊断端口测试（/healthz、/status、/metrics、404）。
 * 同时验证诊断 JSON 不泄露任何密钥（MQTT 密码/用户名、INGEST_KEY）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, requestJson } = require('./helpers/harness');

test('诊断端口：healthz/status/metrics 正常且不泄露密钥', async () => {
  const harness = await createHarness();
  try {
    const health = await harness.healthz();
    assert.equal(health.statusCode, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.service, 'wearable-mqtt');

    const status = await harness.status();
    assert.equal(status.statusCode, 200);
    assert.equal(status.json.service, 'wearable-mqtt');
    assert.equal(status.json.config.deviceId, 'esp32-sos');
    assert.equal(status.json.config.locationDeviceId, 'wearable-sos-001');
    assert.equal(status.json.config.hasMqttCredentials, true);
    assert.equal(status.json.config.hasIngestKey, true);
    assert.equal(status.json.broker.listening, true);
    assert.equal(status.json.adapter.latestGps, null);
    assert.equal(status.json.adapter.activeAlarm, null);
    assert.ok(status.json.counters.broker_connections >= 0);
    assert.ok(typeof status.json.counters.adapter_sosReceived === 'number');
    assert.ok(typeof status.json.counters.http_requests === 'number');
    assert.equal(status.json.state.seq, 0);

    const serialized = JSON.stringify(status.json);
    for (const secret of [
      harness.env.MQTT_PASS,
      harness.env.INGEST_KEY,
      harness.env.MQTT_USER
    ]) {
      assert.equal(serialized.includes(secret), false, '诊断 JSON 不得包含密钥/凭据');
    }

    const metrics = await requestJson(harness.statusPort, '/metrics');
    assert.equal(metrics.statusCode, 200);
    assert.match(metrics.headers['content-type'], /text\/plain/);
    assert.match(metrics.text, /wearable_mqtt_broker_connections \d+/);

    const missing = await requestJson(harness.statusPort, '/nope');
    assert.equal(missing.statusCode, 404);

    const post = await requestJson(harness.statusPort, '/status', { method: 'POST' });
    assert.equal(post.statusCode, 405);
  } finally {
    await harness.stop();
  }
});
