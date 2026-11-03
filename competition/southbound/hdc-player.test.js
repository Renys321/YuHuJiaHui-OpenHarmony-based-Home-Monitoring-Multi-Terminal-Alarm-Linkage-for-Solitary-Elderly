'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlayerArgs, AGENT_FAILURE_CODES } = require('./comms-agent');
const { findSingleUsbTarget, createHdcPlayerRunner } = require('./hdc-player');

function callbackResult(result = 'COMPLETED', errorCode = '') {
  let closed = 0;
  return {
    listener: {
      port: 45678,
      nonce: 'a'.repeat(43),
      completion: Promise.resolve({ result, errorCode }),
      close: async () => { closed += 1; }
    },
    closed: () => closed
  };
}

function commandMock(overrides = {}) {
  const calls = [];
  const impl = (command, args, _options, callback) => {
    calls.push({ command, args: [...args] });
    const verb = args.includes('rport') ? 'rport'
      : args.includes('fport') ? 'fport'
        : args.includes('shell') ? 'shell'
          : 'list';
    const response = overrides[verb] || {
      list: { stdout: 'opaque-target\t\tUSB\tConnected\tlocalhost\thdc\n' },
      rport: { stdout: 'Forwardport result:OK\n' },
      shell: { stdout: 'start ability successfully.\n' },
      fport: { stdout: 'Remove forward ruler success\n' }
    }[verb];
    queueMicrotask(() => callback(response.error || null, response.stdout || '', response.stderr || ''));
    return { kill() {} };
  };
  return { impl, calls };
}

test('findSingleUsbTarget accepts exactly one connected USB device', () => {
  assert.equal(findSingleUsbTarget('id-a  USB Connected localhost hdc\n'), 'id-a');
  assert.equal(findSingleUsbTarget('id-a USB Connected x hdc\nid-b USB Connected x hdc\n'), '');
  assert.equal(findSingleUsbTarget('COM12 UART Ready x hdc\n'), '');
});

test('HDC runner maps the callback, starts the real ability, then removes the mapping', async () => {
  const commands = commandMock();
  const callback = callbackResult();
  const run = createHdcPlayerRunner({
    hdcCommand: 'hdc-test', execFileImpl: commands.impl, createListener: async () => callback.listener
  });
  const result = await run(buildPlayerArgs('medicine_reminder.wav', {
    playbackMessageId: 'cmsg-hdc00001'
  }));

  assert.equal(result.code, 0);
  assert.deepEqual(commands.calls.map((item) => item.args.includes('rport') ? 'rport'
    : item.args.includes('fport') ? 'fport'
      : item.args.includes('shell') ? 'shell' : 'list'), ['list', 'rport', 'shell', 'fport']);
  const shell = commands.calls[2].args;
  assert.deepEqual(shell.slice(0, 4), ['-t', 'opaque-target', 'shell', 'aa']);
  assert.equal(shell.includes('medicine_reminder.wav'), true);
  assert.equal(shell.includes('45678'), true);
  assert.equal(shell.includes('a'.repeat(43)), true);
  assert.equal(callback.closed(), 1);
});

test('HDC runner fails closed when there is not exactly one connected USB target', async () => {
  const commands = commandMock({ list: { stdout: 'id-a USB Connected x hdc\nid-b USB Connected x hdc\n' } });
  const run = createHdcPlayerRunner({ hdcCommand: 'hdc-test', execFileImpl: commands.impl });
  const result = await run(buildPlayerArgs('check_in.wav', { playbackMessageId: 'cmsg-hdc00002' }));
  assert.equal(result.code, 1);
  assert.equal(result.failureCode, AGENT_FAILURE_CODES.DEVICE_REQUEST_FAILED);
  assert.equal(commands.calls.length, 1);
});

test('HDC runner removes the reverse mapping when aa start fails', async () => {
  const commands = commandMock({ shell: { error: Object.assign(new Error('failed'), { code: 1 }) } });
  const callback = callbackResult();
  const run = createHdcPlayerRunner({
    hdcCommand: 'hdc-test', execFileImpl: commands.impl, createListener: async () => callback.listener
  });
  const result = await run(buildPlayerArgs('check_in.wav', { playbackMessageId: 'cmsg-hdc00003' }));
  assert.equal(result.code, 1);
  assert.equal(result.failureCode, AGENT_FAILURE_CODES.PLAYER_FAILED);
  assert.equal(commands.calls.some((item) => item.args.includes('fport')), true);
  assert.equal(callback.closed(), 1);
});

test('HDC runner preserves a stable HAP failure code', async () => {
  const commands = commandMock();
  const callback = callbackResult('FAILED', 'UNKNOWN_VOICE');
  const run = createHdcPlayerRunner({
    hdcCommand: 'hdc-test', execFileImpl: commands.impl, createListener: async () => callback.listener
  });
  const result = await run(buildPlayerArgs('check_in.wav', { playbackMessageId: 'cmsg-hdc00004' }));
  assert.equal(result.code, 1);
  assert.equal(result.failureCode, 'UNKNOWN_VOICE');
  assert.equal(callback.closed(), 1);
});

test('HDC success does not depend on localized or empty success text', async () => {
  const commands = commandMock({ rport: { stdout: '' }, shell: { stdout: '' } });
  const callback = callbackResult('COMPLETED');
  const run = createHdcPlayerRunner({
    hdcCommand: 'hdc-test', execFileImpl: commands.impl, createListener: async () => callback.listener
  });
  const result = await run(buildPlayerArgs('check_in.wav', { playbackMessageId: 'cmsg-hdc00005' }));
  assert.equal(result.code, 0, '真实完成回执才是成功依据，HDC 文本不是');
  assert.equal(callback.closed(), 1);
});
