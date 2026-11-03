'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { GNSS_QUERY_COMMAND, GNSS_SETTINGS_QUERY_COMMAND } = require('./gnss-probe-core');
const { collectGnssResponse, parseArgs, usage } = require('./probe-gnss');

class FakePort extends EventEmitter {
  constructor(chunks) {
    super();
    this.chunks = chunks;
    this.writes = [];
  }

  flush(callback) { callback(null); }

  write(value, callback) {
    this.writes.push(value);
    callback(null);
    setImmediate(() => {
      for (const chunk of this.chunks) this.emit('data', Buffer.from(chunk));
    });
  }

  drain(callback) { callback(null); }
}

test('parses bounded GNSS CLI options without environment access', () => {
  assert.deepEqual(parseArgs(['--port', 'COM7']), {
    baudRate: 115200,
    port: 'COM7',
    timeoutMs: 5000
  });
  assert.deepEqual(parseArgs([
    '--port', '/dev/ttyUSB0', '--baud', '9600', '--timeout', '12000'
  ]), {
    baudRate: 9600,
    port: '/dev/ttyUSB0',
    timeoutMs: 12000
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.match(usage(), /Coordinates and raw GNSS responses are never printed/);
});

test('rejects missing, malformed and out-of-range GNSS CLI values', () => {
  assert.throws(() => parseArgs([]), /--port/);
  assert.throws(() => parseArgs(['--port', 'not-a-port']), /--port/);
  assert.throws(() => parseArgs(['--port', 'COM7', '--baud', '0']), /--baud/);
  assert.throws(() => parseArgs(['--port', 'COM7', '--timeout', '30001']), /--timeout/);
  assert.throws(() => parseArgs(['--unknown']), /^Error: unknown argument$/);
});

test('collects a bounded response in memory and removes the command echo', async () => {
  const port = new FakePort([
    `${GNSS_QUERY_COMMAND}\r\nconfig,gps,ok,1,E,113.`,
    '9739056,N,22.6927826,0,0,184,-3.6,0,2026-10-11 04:30:00\r\n'
  ]);
  const lines = await collectGnssResponse(port, GNSS_QUERY_COMMAND, 15);
  assert.deepEqual(port.writes, [`${GNSS_QUERY_COMMAND}\r\n`]);
  assert.equal(lines.includes(GNSS_QUERY_COMMAND), false);
  assert.equal(lines.length, 1);
  assert.equal(Object.isFrozen(lines), true);
});

test('bounds unexpected line floods and strips terminal controls', async () => {
  const chunks = Array.from({ length: 30 }, (_, index) => `\u001b[31mline-${index}\u001b[0m\r\n`);
  const lines = await collectGnssResponse(new FakePort(chunks), GNSS_QUERY_COMMAND, 15);
  assert.equal(lines.length, 16);
  assert.equal(lines.some((line) => line.includes('\u001b')), false);
});

test('allows only the two frozen read-only GNSS commands', async () => {
  const settingsPort = new FakePort(['config,location,ok,1,60,0,0,0\r\n']);
  await collectGnssResponse(settingsPort, GNSS_SETTINGS_QUERY_COMMAND, 15);
  assert.deepEqual(settingsPort.writes, [`${GNSS_SETTINGS_QUERY_COMMAND}\r\n`]);

  await assert.rejects(
    collectGnssResponse(new FakePort([]), 'config,set,location,2,1,60,0,0,0', 15),
    /GNSS_COMMAND_NOT_ALLOWED/
  );
});
