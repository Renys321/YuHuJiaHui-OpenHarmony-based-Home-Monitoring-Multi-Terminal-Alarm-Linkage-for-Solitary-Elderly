'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  buildGatewaySnapshot,
  createMessageContext,
  runLiveCheck,
  safeCode
} = require('./live-check');

const ENV = Object.freeze({
  ONENET_PRODUCT_ID: 'I19NBBq4xe',
  ONENET_DEVICE_NAME: 'dayu200-home-gateway',
  ONENET_DEVICE_KEY: 'unit-test-secret'
});
const TS = 1_791_608_811_715;

class FakeTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.started = false;
    this.stopped = false;
    this.published = null;
  }

  start() {
    this.started = true;
    queueMicrotask(() => {
      if (this.options.errorCode) {
        const error = new Error('sensitive provider detail');
        error.code = this.options.errorCode;
        this.emit('transportError', error);
        return;
      }
      this.emit('connected');
      this.emit('subscribed');
      this.emit('ready');
    });
  }

  async publishProperty(status, context) {
    this.published = { status, context };
    if (this.options.publishError) throw this.options.publishError;
    return { id: context.id, code: 200 };
  }

  async stop() {
    this.stopped = true;
  }
}

function memoryLogger() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test('builds the bounded non-alarm gateway activation snapshot', () => {
  assert.deepEqual(buildGatewaySnapshot(), {
    deviceId: 'dayu200-home-gateway',
    room: '家庭网关',
    online: true,
    state: 'NORMAL',
    motion: { lastActiveTs: 0, countToday: 0 },
    door: { open: false, lastOpenTs: 0 },
    fall: { detected: false, confidence: 0, detectedAt: 0 },
    alarm: { id: '', type: '', countToday: 0 },
    gps: { valid: false, fixTime: 0 },
    csq: 99
  });
});

test('creates a numeric message ID no longer than 13 digits', () => {
  assert.deepEqual(createMessageContext(() => TS), { id: String(TS), timestampMs: TS });
  assert.throws(() => createMessageContext(() => 123), { code: 'INVALID_CLOCK' });
});

test('runs one upload through an injected transport and always stops it', async () => {
  const logger = memoryLogger();
  const transport = new FakeTransport();
  let receivedEnv;
  const result = await runLiveCheck({
    env: ENV,
    logger,
    now: () => TS,
    postAckHoldMs: 0,
    transportFactory: (env) => {
      receivedEnv = env;
      return transport;
    }
  });

  assert.equal(receivedEnv, ENV);
  assert.equal(transport.started, true);
  assert.equal(transport.stopped, true);
  assert.deepEqual(transport.published, {
    status: buildGatewaySnapshot(),
    context: { id: String(TS), timestampMs: TS }
  });
  assert.deepEqual(result, { connected: true, subscribed: true, accepted: true, code: 200 });
  assert.deepEqual(logger.lines, [
    '[OneNET] START product=I19NBBq4xe device=dayu200-home-gateway',
    '[OneNET] MQTT_CONNECTED',
    '[OneNET] SUBSCRIPTIONS_OK',
    `[OneNET] PROPERTY_ACCEPTED code=200 id=${TS}`
  ]);
  assert.equal(logger.lines.join('\n').includes(ENV.ONENET_DEVICE_KEY), false);
});

test('returns only a safe code for a transport failure and still stops', async () => {
  const logger = memoryLogger();
  const transport = new FakeTransport({ errorCode: 'MQTT_ERROR' });
  await assert.rejects(
    runLiveCheck({
      env: ENV,
      logger,
      now: () => TS,
      postAckHoldMs: 0,
      transportFactory: () => transport
    }),
    { code: 'MQTT_ERROR', message: 'MQTT_ERROR' }
  );
  assert.equal(transport.stopped, true);
  assert.equal(logger.lines.join('\n').includes('sensitive provider detail'), false);
});

test('rejects missing credentials without printing or creating a transport', async () => {
  let created = false;
  await assert.rejects(
    runLiveCheck({
      env: { ...ENV, ONENET_DEVICE_KEY: '' },
      postAckHoldMs: 0,
      transportFactory: () => {
        created = true;
        return new FakeTransport();
      }
    }),
    { code: 'MISSING_DEVICE_KEY' }
  );
  assert.equal(created, false);
  assert.equal(safeCode({ code: 'unexpected-secret-bearing-error' }), 'LIVE_CHECK_FAILED');
});
