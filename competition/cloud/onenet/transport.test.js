'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');

const {
  ONENET_CERT_FINGERPRINT256,
  OneNetTransport,
  checkOneNetServerIdentity,
  createTransportFromEnv,
  parseCloudReply
} = require('./transport');

const DEVICE_KEY = Buffer.from('transport-unit-test-key', 'utf8').toString('base64');
const TS = 1_791_608_811_715;

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.published = [];
    this.subscriptions = null;
    this.ended = false;
  }

  subscribe(topics, callback) {
    this.subscriptions = topics;
    queueMicrotask(() => callback(null, []));
  }

  publish(topic, payload, options, callback) {
    this.published.push({ topic, payload, options });
    queueMicrotask(() => callback(null));
  }

  end(_force, _options, callback) {
    this.ended = true;
    if (typeof callback === 'function') queueMicrotask(callback);
  }
}

function status() {
  return {
    deviceId: 'dayu200-living',
    room: '客厅',
    online: true,
    state: 'NORMAL',
    motion: { lastActiveTs: TS, countToday: 2 },
    alarm: { id: '', type: '', countToday: 0 }
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function connectedTransport(overrides = {}) {
  const clients = [];
  const calls = [];
  const transport = new OneNetTransport({
    productId: 'I19NBBq4xe',
    deviceName: 'dayu200-home-gateway',
    getDeviceKey: () => DEVICE_KEY,
    mqttConnect: (url, options) => {
      const client = new FakeMqttClient();
      clients.push(client);
      calls.push({ url, options });
      return client;
    },
    nowSec: () => 1_800_000_000,
    ackTimeoutMs: 500,
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    ...overrides
  });
  transport.start();
  await flush();
  const ready = once(transport, 'ready');
  clients[0].emit('connect');
  await ready;
  return { transport, clients, calls };
}

test('connects with TLS verification and subscribes to the canonical topics', async (t) => {
  const { transport, clients, calls } = await connectedTransport();
  t.after(() => transport.stop());
  assert.equal(calls[0].url, 'mqtts://i19nbbq4xe.mqttstls.acc.cmcconenet.cn:8883');
  assert.equal(calls[0].options.protocol, 'mqtts');
  assert.equal(calls[0].options.protocolVersion, 4);
  assert.equal(calls[0].options.rejectUnauthorized, true);
  assert.equal(calls[0].options.servername, 'i19nbbq4xe.mqttstls.acc.cmcconenet.cn');
  assert.ok(Buffer.isBuffer(calls[0].options.ca));
  assert.equal(typeof calls[0].options.checkServerIdentity, 'function');
  assert.equal(calls[0].options.username, 'I19NBBq4xe');
  assert.equal(calls[0].options.clientId, 'dayu200-home-gateway');
  assert.match(calls[0].options.password, /^version=2018-10-31&/);
  assert.equal(calls[0].options.password.includes(DEVICE_KEY), false);
  assert.deepEqual(Object.keys(clients[0].subscriptions).sort(), [
    '$sys/I19NBBq4xe/dayu200-home-gateway/thing/event/post/reply',
    '$sys/I19NBBq4xe/dayu200-home-gateway/thing/property/post/reply',
    '$sys/I19NBBq4xe/dayu200-home-gateway/thing/property/set'
  ]);
});

test('pins the official OneNET self-signed MQTT certificate', () => {
  const official = {
    fingerprint256: ONENET_CERT_FINGERPRINT256,
    subject: { CN: 'OneNET MQTTS' }
  };
  assert.equal(checkOneNetServerIdentity('mqttstls.heclouds.com', official), undefined);
  const mismatch = checkOneNetServerIdentity('mqttstls.heclouds.com', {
    fingerprint256: ONENET_CERT_FINGERPRINT256.replace(/^7D/, '00'),
    subject: { CN: 'OneNET MQTTS' }
  });
  assert.equal(mismatch.code, 'ONENET_CERT_MISMATCH');
  assert.match(mismatch.message, /pin mismatch/);
});

test('resolves an upload only after the OneNET application reply', async (t) => {
  const { transport, clients } = await connectedTransport();
  t.after(() => transport.stop());
  const pending = transport.publishProperty(status(), { id: '701', timestampMs: TS });
  await flush();
  assert.equal(clients[0].published[0].options.qos, 1);
  assert.equal(
    clients[0].published[0].topic,
    '$sys/I19NBBq4xe/dayu200-home-gateway/thing/property/post'
  );
  clients[0].emit(
    'message',
    '$sys/I19NBBq4xe/dayu200-home-gateway/thing/property/post/reply',
    Buffer.from('{"id":"701","code":200,"msg":"success"}')
  );
  assert.deepEqual(await pending, { id: '701', code: 200 });
});

test('maps an allowed downlink and publishes property/set_reply', async (t) => {
  let received;
  const { transport, clients } = await connectedTransport({
    handleCommand: async (command, context) => {
      received = { command, context };
      return { ok: true };
    }
  });
  t.after(() => transport.stop());
  const handled = once(transport, 'commandHandled');
  clients[0].emit('message', '$sys/I19NBBq4xe/dayu200-home-gateway/thing/property/set', Buffer.from(JSON.stringify({
    id: '801',
    version: '1.0',
    params: { control: { command: 'ACK', alarmId: 'alarm-1', action: '家属已确认安全' } }
  })));
  const [event] = await handled;
  assert.deepEqual(received, {
    command: { command: 'ACK', alarmId: 'alarm-1', action: '家属已确认安全' },
    context: { requestId: '801' }
  });
  assert.deepEqual(event, { requestId: '801', command: 'ACK', ok: true });
  const reply = clients[0].published.at(-1);
  assert.equal(reply.topic, '$sys/I19NBBq4xe/dayu200-home-gateway/thing/property/set_reply');
  assert.deepEqual(JSON.parse(reply.payload), { id: '801', code: 200, msg: 'success' });
});

test('rejects an invalid downlink without exposing its content', async (t) => {
  const { transport, clients } = await connectedTransport();
  t.after(() => transport.stop());
  const rejected = once(transport, 'commandRejected');
  clients[0].emit('message', '$sys/I19NBBq4xe/dayu200-home-gateway/thing/property/set', Buffer.from(JSON.stringify({
    id: '802', version: '1.0', params: { control: { command: 'SHELL', commandLine: 'sensitive text' } }
  })));
  const [event] = await rejected;
  assert.deepEqual(event, { requestId: '802', reason: 'invalid-command' });
  const reply = clients[0].published.at(-1);
  assert.deepEqual(JSON.parse(reply.payload), { id: '802', code: 400, msg: 'invalid command' });
  assert.equal(JSON.stringify(event).includes('sensitive text'), false);
});

test('reconnects with a newly generated short-lived token', async (t) => {
  let now = 1_800_000_000;
  const { transport, clients, calls } = await connectedTransport({ nowSec: () => now });
  t.after(() => transport.stop());
  const firstPassword = calls[0].options.password;
  now += 60;
  clients[0].emit('close');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].options.password, firstPassword);
  assert.match(calls[1].options.password, /et=1800003660/);
});

test('rejects duplicate pending IDs, cloud errors and offline publishes', async (t) => {
  const { transport, clients } = await connectedTransport();
  t.after(() => transport.stop());
  const pending = transport.publishProperty(status(), { id: '901', timestampMs: TS });
  await assert.rejects(
    transport.publishProperty(status(), { id: '901', timestampMs: TS }),
    { code: 'DUPLICATE_MESSAGE_ID' }
  );
  clients[0].emit(
    'message',
    '$sys/I19NBBq4xe/dayu200-home-gateway/thing/property/post/reply',
    Buffer.from('{"id":"901","code":400,"msg":"rejected"}')
  );
  await assert.rejects(pending, { code: 'CLOUD_REJECTED' });
  clients[0].emit('close');
  await assert.rejects(
    transport.publishProperty(status(), { id: '902', timestampMs: TS }),
    { code: 'NOT_READY' }
  );
});

test('environment factory defers secret access until connection time', async () => {
  const env = { ONENET_PRODUCT_ID: 'product-1', ONENET_DEVICE_NAME: 'device-1' };
  const transport = createTransportFromEnv(env, {
    mqttConnect: () => { throw new Error('must not be reached'); },
    reconnectMinMs: 10,
    reconnectMaxMs: 10
  });
  const errorEvent = once(transport, 'transportError');
  transport.start();
  const [error] = await errorEvent;
  assert.equal(error.code, 'CONNECT_SETUP_FAILED');
  assert.equal(error.message.includes('ONENET_DEVICE_KEY'), false);
  await transport.stop();
});

test('parses only bounded OneNET reply metadata', () => {
  assert.deepEqual(parseCloudReply('{"id":"123","code":200,"msg":"ok"}'), {
    id: '123', code: 200
  });
  assert.throws(() => parseCloudReply('{"id":"bad","code":200}'), /id/);
  assert.throws(() => parseCloudReply('x'.repeat(16 * 1024 + 1)), /large/);
});
