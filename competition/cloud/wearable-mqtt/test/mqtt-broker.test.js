'use strict';

/**
 * mqtt-broker.test.js — 内置 MQTT 3.1.1 Broker 测试（真实 TCP，裸客户端）。
 * 覆盖：错误密码被拒、Client ID 白名单、订阅/发布/QoS1 PUBACK、通配符、
 * Ping、retain 不崩、Keep Alive 1.5 倍超时、畸形报文不影响进程。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { MqttBroker } = require('../src/mqtt-broker');
const { RawMqttClient } = require('./helpers/raw-mqtt-client');
const { createLogger } = require('../src/logger');
const { waitFor, sleep } = require('./helpers/harness');

const CREDENTIALS = Object.freeze({
  username: 'wearable-user',
  password: 'wearable-pass',
  clientId: 'test-device'
});

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

async function startBroker() {
  const broker = new MqttBroker({
    host: '127.0.0.1',
    port: 0,
    username: CREDENTIALS.username,
    password: CREDENTIALS.password,
    clientIds: ['test-device', 'test-device-2', 'wearable-sos-001'],
    logger: silentLogger(),
    connectTimeoutMs: 2000
  });
  const address = await broker.start();
  return { broker, port: address.port };
}

function connectClient(port, overrides = {}) {
  const client = new RawMqttClient();
  const promise = client.connect({
    port,
    clientId: overrides.clientId || `client-${Math.random().toString(16).slice(2, 8)}`,
    username: overrides.username === undefined ? CREDENTIALS.username : overrides.username,
    password: overrides.password === undefined ? CREDENTIALS.password : overrides.password,
    keepAlive: overrides.keepAlive === undefined ? 60 : overrides.keepAlive,
    cleanSession: overrides.cleanSession !== false
  });
  return { client, connected: promise };
}

test('MQTT Broker 基础能力', async (t) => {
  const { broker, port } = await startBroker();
  t.after(() => broker.close());

  await t.test('用户名/密码错误被拒绝（CONNACK rc=4）', async () => {
    const client = new RawMqttClient();
    const result = await client.connect({
      port,
      clientId: 'test-device',
      username: CREDENTIALS.username,
      password: 'wrong-password'
    });
    assert.equal(result.returnCode, 4);
    await client.waitForClose(3000);
    client.destroy();
    assert.ok(broker.counters.authFailures >= 1);
  });

  await t.test('Client ID 不在白名单被拒绝（CONNACK rc=5）', async () => {
    const client = new RawMqttClient();
    const result = await client.connect({
      port,
      clientId: 'not-allowed-device',
      username: CREDENTIALS.username,
      password: CREDENTIALS.password
    });
    assert.equal(result.returnCode, 5);
    await client.waitForClose(3000);
    client.destroy();
    assert.ok(broker.counters.clientIdRejected >= 1);
  });

  await t.test('正确凭据 + 白名单 Client ID 连接成功（CONNACK rc=0）', async () => {
    const { client, connected } = connectClient(port, { clientId: 'test-device' });
    const result = await connected;
    assert.equal(result.returnCode, 0);
    assert.equal(result.sessionPresent, false);
    await client.disconnect();
    await waitFor(() => client.closed);
  });

  await t.test('SUBSCRIBE/SUBACK + PUBLISH QoS1 + PUBACK + 通配符', async () => {
    const subscriber = new RawMqttClient();
    await subscriber.connect({
      port,
      clientId: 'test-device-2',
      username: CREDENTIALS.username,
      password: CREDENTIALS.password
    });
    const suback = await subscriber.subscribe([
      { filter: 'eldercare/wearable/+/up', qos: 1 },
      { filter: 'eldercare/wearable/sos-001/down', qos: 0 }
    ]);
    assert.deepEqual(suback.codes, [1, 0]);

    const publisher = new RawMqttClient();
    await publisher.connect({
      port,
      clientId: 'test-device',
      username: CREDENTIALS.username,
      password: CREDENTIALS.password
    });
    const puback = await publisher.publish('eldercare/wearable/sos-001/up', '{"v":1,"t":"hb"}', { qos: 1 });
    assert.ok(puback.packetId >= 1);

    const message = await subscriber.waitForMessage((item) => item.topic === 'eldercare/wearable/sos-001/up');
    assert.equal(message.payload, '{"v":1,"t":"hb"}');
    assert.equal(message.qos, 1, '订阅 QoS1 且发布 QoS1 时应为 QoS1');
    // 通配符不应匹配不相关主题
    await publisher.publish('other/topic', 'x', { qos: 0 });
    assert.equal(subscriber.messages.filter((item) => item.topic === 'other/topic').length, 0);
    // # 通配
    const hashAck = await subscriber.subscribe([{ filter: 'eldercare/#', qos: 1 }]);
    assert.deepEqual(hashAck.codes, [1]);
    await publisher.publish('eldercare/wearable/other', 'y', { qos: 0 });
    const hashMessage = await subscriber.waitForMessage((item) => item.topic === 'eldercare/wearable/other');
    assert.equal(hashMessage.payload, 'y');

    await publisher.disconnect();
    await subscriber.disconnect();
  });

  await t.test('QoS0 发布不回 PUBACK，QoS1 回 PUBACK', async () => {
    const { client, connected } = connectClient(port, { clientId: 'test-device' });
    await connected;
    const qos0 = await client.publish('a/b', 'qos0', { qos: 0 });
    assert.equal(qos0.packetId, null);
    const qos1 = await client.publish('a/b', 'qos1', { qos: 1 });
    assert.ok(qos1.packetId >= 1);
    await client.disconnect();
  });

  await t.test('PINGREQ -> PINGRESP', async () => {
    const { client, connected } = connectClient(port, { clientId: 'test-device' });
    await connected;
    await client.ping();
    await client.disconnect();
  });

  await t.test('retain 报文可接受且不崩（不保存 retained 消息）', async () => {
    const { client, connected } = connectClient(port, { clientId: 'test-device' });
    await connected;
    await client.publish('retain/topic', 'retained-payload', { retain: true, qos: 0 });
    await sleep(50);
    const snapshot = broker.snapshot();
    assert.equal(snapshot.listening, true);
    await client.disconnect();
  });

  await t.test('Keep Alive 1.5 倍超时断开（keepAlive=1s -> 约 1.5s）', async () => {
    const { client, connected } = connectClient(port, { clientId: 'test-device', keepAlive: 1 });
    await connected;
    const startedAt = Date.now();
    await client.waitForClose(5000);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 1200, `应在 ~1.5s 后断开，实际 ${elapsed}ms`);
    assert.ok(broker.counters.keepaliveTimeouts >= 1);
  });

  await t.test('畸形报文只断开该连接，broker 继续服务', async () => {
    await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.write(Buffer.from([0x00, 0x01, 0x02, 0x03]));
      });
      socket.on('close', resolve);
      socket.on('error', () => {});
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 2000);
    });
    assert.ok(broker.counters.protocolErrors >= 1);
    const { client, connected } = connectClient(port, { clientId: 'test-device-2' });
    const result = await connected;
    assert.equal(result.returnCode, 0);
    await client.disconnect();
  });

  await t.test('同 Client ID 新连接接管旧连接', async () => {
    const first = new RawMqttClient();
    await first.connect({
      port,
      clientId: 'test-device',
      username: CREDENTIALS.username,
      password: CREDENTIALS.password
    });
    const second = new RawMqttClient();
    const result = await second.connect({
      port,
      clientId: 'test-device',
      username: CREDENTIALS.username,
      password: CREDENTIALS.password
    });
    assert.equal(result.returnCode, 0);
    await first.waitForClose(3000);
    assert.ok(broker.counters.takeover >= 1);
    await second.disconnect();
  });

  await t.test('broker.publish() 内部投递到订阅者（适配器下行通道）', async () => {
    const subscriber = new RawMqttClient();
    await subscriber.connect({
      port,
      clientId: 'test-device-2',
      username: CREDENTIALS.username,
      password: CREDENTIALS.password
    });
    await subscriber.subscribe([{ filter: 'eldercare/wearable/sos-001/down', qos: 1 }]);
    const published = broker.publish('eldercare/wearable/sos-001/down', '{"v":1,"t":"ack"}', { qos: 1 });
    assert.equal(published.matched, 1);
    const message = await subscriber.waitForMessage(() => true);
    assert.equal(message.payload, '{"v":1,"t":"ack"}');
    await subscriber.disconnect();
  });
});
