'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { runDownlinkCheck, safeCode } = require('./downlink-check');

const ENV = Object.freeze({
  ONENET_PRODUCT_ID: 'I19NBBq4xe',
  ONENET_DEVICE_NAME: 'dayu200-home-gateway',
  ONENET_DEVICE_KEY: 'unit-test-secret'
});

class FakeTransport extends EventEmitter {
  constructor(handleCommand, command = { command: 'RESET' }) {
    super();
    this.handleCommand = handleCommand;
    this.command = command;
    this.stopped = false;
  }

  start() {
    queueMicrotask(async () => {
      this.emit('connected');
      this.emit('subscribed');
      this.emit('ready');
      await new Promise((resolve) => setImmediate(resolve));
      const result = await this.handleCommand(this.command, { requestId: '123' });
      this.emit('commandHandled', {
        requestId: '123',
        command: this.command.command,
        ok: result.ok
      });
    });
  }

  async stop() {
    this.stopped = true;
  }
}

function memoryLogger() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test('accepts one RESET downlink, reports the reply and stops', async () => {
  const logger = memoryLogger();
  let transport;
  const result = await runDownlinkCheck({
    env: ENV,
    logger,
    connectTimeoutMs: 500,
    commandTimeoutMs: 500,
    transportFactory: (_env, { handleCommand }) => {
      transport = new FakeTransport(handleCommand);
      return transport;
    }
  });

  assert.deepEqual(result, {
    connected: true,
    subscribed: true,
    command: 'RESET',
    replied: true
  });
  assert.equal(transport.stopped, true);
  assert.deepEqual(logger.lines, [
    '[OneNET] START_DOWNLINK product=I19NBBq4xe device=dayu200-home-gateway',
    '[OneNET] MQTT_CONNECTED',
    '[OneNET] SUBSCRIPTIONS_OK',
    '[OneNET] WAITING_FOR_COMMAND command=RESET timeout_ms=500',
    '[OneNET] DOWNLINK_RECEIVED command=RESET',
    '[OneNET] DOWNLINK_REPLIED command=RESET code=200'
  ]);
  assert.equal(logger.lines.join('\n').includes(ENV.ONENET_DEVICE_KEY), false);
});

test('rejects a non-RESET command without claiming success', async () => {
  const logger = memoryLogger();
  let transport;
  await assert.rejects(
    runDownlinkCheck({
      env: ENV,
      logger,
      connectTimeoutMs: 500,
      commandTimeoutMs: 100,
      transportFactory: (_env, { handleCommand }) => {
        transport = new FakeTransport(handleCommand, { command: 'SET_CONFIG', config: { noMotionSec: 30 } });
        return transport;
      }
    }),
    { code: 'COMMAND_TIMEOUT' }
  );
  assert.equal(transport.stopped, true);
  assert.equal(logger.lines.includes('[OneNET] DOWNLINK_REJECTED reason=UNEXPECTED_COMMAND'), true);
  assert.equal(logger.lines.some((line) => line.includes('DOWNLINK_REPLIED')), false);
});

test('fails closed when the device key is absent', async () => {
  let created = false;
  await assert.rejects(
    runDownlinkCheck({
      env: { ...ENV, ONENET_DEVICE_KEY: '' },
      transportFactory: () => {
        created = true;
        throw new Error('must not run');
      }
    }),
    { code: 'MISSING_DEVICE_KEY' }
  );
  assert.equal(created, false);
  assert.equal(safeCode({ code: 'provider-secret-error' }), 'DOWNLINK_CHECK_FAILED');
});
