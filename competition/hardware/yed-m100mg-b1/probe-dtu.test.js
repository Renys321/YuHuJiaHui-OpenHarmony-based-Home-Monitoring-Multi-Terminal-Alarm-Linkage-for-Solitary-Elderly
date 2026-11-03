'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { collectPassive, collectResponse, parseArgs, usage } = require('./probe-dtu');

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

test('parses bounded CLI options without consulting the environment', () => {
  assert.deepEqual(parseArgs(['--port', 'COM11']), {
    baudRate: 115200,
    includeIdentifiers: false,
    list: false,
    listen: false,
    quick: false,
    port: 'COM11',
    timeoutMs: 1800
  });
  assert.deepEqual(parseArgs([
    '--port', '/dev/ttyUSB0', '--baud', '9600', '--timeout', '500', '--include-identifiers'
  ]), {
    baudRate: 9600,
    includeIdentifiers: true,
    list: false,
    listen: false,
    quick: false,
    port: '/dev/ttyUSB0',
    timeoutMs: 500
  });
  assert.equal(parseArgs(['--list']).list, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--listen', '--port', 'COM11']).listen, true);
  assert.equal(parseArgs(['--quick', '--port', 'COM11']).quick, true);
  assert.match(usage(), /never requests IMEI or ICCID/);
});

test('rejects missing, malformed and out-of-range CLI values', () => {
  assert.throws(() => parseArgs([]), /--port/);
  assert.throws(() => parseArgs(['--port', 'not-a-port']), /--port/);
  assert.throws(() => parseArgs(['--port', 'COM11', '--baud', '0']), /--baud/);
  assert.throws(() => parseArgs(['--port', 'COM11', '--timeout', '10001']), /--timeout/);
  assert.throws(() => parseArgs(['--unknown']), /^Error: unknown argument$/);
});

test('collectResponse handles split lines, removes echoes and redacts identifiers', async () => {
  const port = new FakePort([
    'config,get,firmwarever\r\nconfig,firmwarever,ok,Y100',
    'E-v1\r\nconfig,imei,ok,123456789012345\r\n',
    'config,csq,ok,25\r\nconfig,csq,ok,25\r\n'
  ]);
  const lines = await collectResponse(port, 'config,get,firmwarever', 15);
  assert.deepEqual(port.writes, ['config,get,firmwarever\r\n']);
  assert.equal(lines.some((line) => line.includes('123456789012345')), false);
  assert.equal(lines.some((line) => line.includes('last4=2345')), true);
  assert.equal(lines.filter((line) => line === 'config,csq,ok,25').length, 1);
  assert.equal(lines.includes('config,get,firmwarever'), false);
});

test('collectPassive reads and redacts data without writing to the port', async () => {
  const port = new FakePort([]);
  setImmediate(() => {
    port.emit('data', Buffer.from('$GNRMC,invalid\r\nIMEI: 123456789012345\r\n'));
  });
  const lines = await collectPassive(port, 15);
  assert.deepEqual(port.writes, []);
  assert.equal(lines.includes('$GNRMC,invalid'), true);
  assert.equal(lines.some((line) => line.includes('123456789012345')), false);
  assert.equal(lines.some((line) => line.includes('last4=2345')), true);
});
