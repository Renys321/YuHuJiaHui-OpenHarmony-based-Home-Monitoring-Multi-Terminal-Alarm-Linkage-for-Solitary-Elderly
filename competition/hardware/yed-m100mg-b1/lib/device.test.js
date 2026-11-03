'use strict';

/**
 * lib/device.test.js — 设备探测编排单元测试
 *
 * 全部使用内存中的 stub transport：不打开串口、不加载 serialport 依赖、
 * 不访问网络、不写文件、不使用真实定时器（因此不会有悬挂的 timer / promise）。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { COMMAND_STATUS, statusForError, probeDevice, readonlyCommands } = require('./device');
const { DEFAULT_DEVICE_COMMANDS, DEFAULT_GNSS_COMMANDS } = require('./dtu-protocol');

const REPORT_KEYS = ['probedAtMs', 'port', 'baudRate', 'mode', 'commands', 'urc', 'device', 'stats'];

/**
 * 构造内存 stub transport。
 * @param {object} handlers command -> (command, options) => { lines }
 * @param {object} overrides 覆盖 port / baudRate / stats / urcLog 等
 */
function createStubTransport(handlers = {}, overrides = {}) {
  const calls = [];
  const transport = {
    port: 'COM-TEST',
    baudRate: 115200,
    stats: { mode: 'FIXTURE' },
    urcLog: [],
    calls,
    request: async (command, options) => {
      calls.push({ command, options });
      const handler = handlers[command];
      if (typeof handler === 'function') return handler(command, options);
      return { lines: [] };
    },
    ...overrides
  };
  return transport;
}

/* ------------------------------------------------------------ 前置校验 */

test('probeDevice requires a transport exposing request()', async () => {
  await assert.rejects(() => probeDevice(), TypeError);
  await assert.rejects(() => probeDevice({}), TypeError);
  await assert.rejects(() => probeDevice({ transport: null }), TypeError);
  await assert.rejects(() => probeDevice({ transport: {} }), TypeError);
  await assert.rejects(() => probeDevice({ transport: { request: 42 } }), TypeError);
  await assert.rejects(
    () => probeDevice({ transport: { request: 'not-a-function' } }),
    /probeDevice requires a transport with request\(\)/
  );
});

/* ------------------------------------------------------------ 默认探测 */

test('probeDevice runs the default read-only commands in order and returns stable fields', async () => {
  const transport = createStubTransport();
  const before = Date.now();
  const report = await probeDevice({ transport });
  const after = Date.now();

  assert.deepEqual(
    transport.calls.map((call) => call.command),
    [...DEFAULT_DEVICE_COMMANDS]
  );
  assert.deepEqual(Object.keys(report), REPORT_KEYS);
  assert.ok(Number.isSafeInteger(report.probedAtMs));
  assert.ok(report.probedAtMs >= before && report.probedAtMs <= after);
  assert.equal(report.port, 'COM-TEST');
  assert.equal(report.baudRate, 115200);
  assert.equal(report.mode, 'FIXTURE');
  assert.deepEqual(report.urc, []);
  assert.deepEqual(report.stats, { total: 4, succeeded: 4, failed: 0 });

  assert.equal(report.commands.length, DEFAULT_DEVICE_COMMANDS.length);
  for (const entry of report.commands) {
    assert.equal(entry.status, COMMAND_STATUS.OK);
    assert.equal(entry.ok, true);
    assert.deepEqual(entry.lines, []);
    assert.equal(entry.errorCode, undefined);
    assert.equal(entry.errorMessage, undefined);
  }

  for (const key of [
    'firmware',
    'paramVersion',
    'signal',
    'network',
    'sim',
    'server',
    'data',
    'operator',
    'gnssSettings',
    'gnss'
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(report.device, key), key);
  }
});

test('probeDevice nulls non-string port / non-integer baudRate and defaults mode', async () => {
  const transport = createStubTransport({}, { port: 1234, baudRate: 'fast', stats: {} });
  const report = await probeDevice({ transport });
  assert.equal(report.port, null);
  assert.equal(report.baudRate, null);
  assert.equal(report.mode, 'SERIAL');
});

test('probeDevice passes collected lines to the default DTU parser', async () => {
  const transport = createStubTransport({
    'config,get,csq': async () => ({ lines: ['config,csq,ok,26'] }),
    'config,get,ssta': async () => ({ lines: ['config,ssta,ok,4'] })
  });
  const report = await probeDevice({ transport });

  assert.equal(report.device.signal.csq, 26);
  assert.equal(report.device.signal.dbm, -61);
  assert.equal(report.device.signal.state, 'VALID');
  assert.equal(report.device.sim.ready, true);
  assert.equal(report.device.server.connected, true);
  assert.deepEqual(report.stats, { total: 4, succeeded: 4, failed: 0 });
});

test('probeDevice accepts a custom parser and feeds it deduplicated cleaned lines', async () => {
  const transport = createStubTransport({
    'config,get,csq': async () => ({ lines: ['config,csq,ok,26', 'config,csq,ok,26'] }),
    'config,get,ssta': async () => ({ lines: ['config,ssta,ok,4'] })
  });
  const seen = [];
  const report = await probeDevice({
    transport,
    parser: (lines) => {
      seen.push([...lines]);
      return { count: lines.length };
    }
  });

  assert.deepEqual(report.device, { count: 2 });
  assert.deepEqual(seen[0], ['config,csq,ok,26', 'config,ssta,ok,4']);
});

test('probeDevice tolerates a transport that resolves undefined', async () => {
  const transport = createStubTransport({}, { request: async () => undefined });
  const report = await probeDevice({ transport, commands: ['config,get,csq'] });
  assert.equal(report.commands[0].status, 'OK');
  assert.deepEqual(report.commands[0].lines, []);
  assert.equal(report.stats.total, 1);
});

/* ------------------------------------------------------------ 错误映射 */

test('statusForError maps every documented transport error code', () => {
  const table = [
    ['SERIAL_COMMAND_TIMEOUT', 'TIMEOUT'],
    ['SERIAL_DISCONNECTED', 'DISCONNECTED'],
    ['SERIAL_NOT_OPEN', 'NOT_OPEN'],
    ['SERIAL_TRANSPORT_CLOSED', 'CLOSED'],
    ['SERIAL_COMMAND_ERROR', 'ERROR']
  ];
  for (const [code, expected] of table) {
    assert.equal(statusForError({ code }), expected, code);
    assert.equal(COMMAND_STATUS[expected], expected, code);
  }

  assert.equal(statusForError(Object.assign(new Error('boom'), { code: 'SERIAL_COMMAND_TIMEOUT' })), 'TIMEOUT');
  // 无 code：稳定的 ERROR，而不是 undefined / 空串。
  assert.equal(statusForError(new Error('boom')), 'ERROR');
  assert.equal(statusForError(undefined), 'ERROR');
  assert.equal(statusForError(null), 'ERROR');
  assert.equal(statusForError({}), 'ERROR');
  // code 不是字符串时同样退化为 ERROR。
  assert.equal(statusForError({ code: 42 }), 'ERROR');
  // 未知但存在的 code 原样透出，便于上游定位。
  assert.equal(statusForError({ code: 'E_CUSTOM' }), 'E_CUSTOM');
});

test('probeDevice reports each transport failure with its mapped status', async () => {
  const failures = [
    ['SERIAL_COMMAND_TIMEOUT', 'TIMEOUT'],
    ['SERIAL_DISCONNECTED', 'DISCONNECTED'],
    ['SERIAL_NOT_OPEN', 'NOT_OPEN'],
    ['SERIAL_TRANSPORT_CLOSED', 'CLOSED'],
    ['SERIAL_COMMAND_ERROR', 'ERROR']
  ];

  for (const [code, expected] of failures) {
    const transport = createStubTransport({
      'config,get,firmwarever': async () => {
        const error = new Error('stub failure');
        error.code = code;
        throw error;
      }
    });
    const report = await probeDevice({ transport });

    assert.equal(report.commands[0].status, expected, code);
    assert.equal(report.commands[0].ok, false, code);
    assert.equal(report.commands[0].errorCode, code, code);
    assert.equal(report.commands[0].errorMessage, 'stub failure', code);
  }
});

test('probeDevice defaults to ERROR and a bounded message for uncoded / non-Error rejections', async () => {
  const plain = createStubTransport({
    'config,get,firmwarever': async () => {
      throw new Error('plain failure');
    }
  });
  const plainReport = await probeDevice({ transport: plain });
  assert.equal(plainReport.commands[0].status, 'ERROR');
  assert.equal(plainReport.commands[0].errorCode, undefined);
  assert.equal(plainReport.commands[0].errorMessage, 'plain failure');

  const nonError = createStubTransport({
    'config,get,csq': async () => {
      throw 'nope';
    }
  });
  const nonErrorReport = await probeDevice({ transport: nonError });
  assert.equal(nonErrorReport.commands[2].status, 'ERROR');
  assert.equal(nonErrorReport.commands[2].errorCode, undefined);
  assert.equal(nonErrorReport.commands[2].errorMessage, 'command failed');

  const customCode = createStubTransport({
    'config,get,firmwarever': async () => {
      throw Object.assign(new Error('custom'), { code: 'E_CUSTOM' });
    }
  });
  const customReport = await probeDevice({ transport: customCode });
  assert.equal(customReport.commands[0].status, 'E_CUSTOM');
  assert.equal(customReport.commands[0].errorCode, 'E_CUSTOM');
});

test('a failing command does not abort the remaining commands', async () => {
  const order = ['config,get,csq', 'config,get,ssta', 'config,get,firmwarever'];
  const transport = createStubTransport(
    {
      'config,get,ssta': async () => {
        const error = new Error('timeout');
        error.code = 'SERIAL_COMMAND_TIMEOUT';
        throw error;
      }
    },
    {}
  );

  const report = await probeDevice({ transport, commands: order });
  assert.deepEqual(
    transport.calls.map((call) => call.command),
    order
  );
  assert.equal(report.commands.length, 3);
  assert.deepEqual(
    report.commands.map((entry) => entry.status),
    ['OK', 'TIMEOUT', 'OK']
  );
  assert.equal(report.commands[1].errorCode, 'SERIAL_COMMAND_TIMEOUT');
  assert.deepEqual(report.stats, { total: 3, succeeded: 2, failed: 1 });
  // 失败之后的命令仍然拿到了结果行。
  assert.equal(report.device.firmware, null);
});

/* ------------------------------------------------------------ URC */

test('probeDevice collects transport.urcLog into urc without duplicates', async () => {
  const transport = createStubTransport({}, { urcLog: ['RING', 'RING', '+CMTI: 1'] });
  const report = await probeDevice({ transport });
  assert.deepEqual(report.urc, ['RING', '+CMTI: 1']);

  const missing = await probeDevice({ transport: createStubTransport() });
  assert.deepEqual(missing.urc, []);

  const nonArray = await probeDevice({ transport: createStubTransport({}, { urcLog: 'RING' }) });
  assert.deepEqual(nonArray.urc, []);
});

/* ------------------------------------------------------------ 命令覆盖 */

test('probeDevice honours an explicit commands override', async () => {
  const custom = ['config,get,csq', 'config,get,ssta'];
  const transport = createStubTransport();
  const report = await probeDevice({ transport, commands: custom });
  assert.deepEqual(
    transport.calls.map((call) => call.command),
    custom
  );
  assert.equal(report.stats.total, 2);
});

test('probeDevice falls back to defaults for empty / invalid commands', async () => {
  for (const commands of [[], 'config,get,csq', null, undefined]) {
    const transport = createStubTransport();
    const report = await probeDevice({ transport, commands });
    assert.deepEqual(
      transport.calls.map((call) => call.command),
      [...DEFAULT_DEVICE_COMMANDS],
      String(commands)
    );
    assert.equal(report.stats.total, DEFAULT_DEVICE_COMMANDS.length);
  }

  // 非字符串命令经 String() 规范化。
  const numeric = createStubTransport();
  const numericReport = await probeDevice({ transport: numeric, commands: [7] });
  assert.deepEqual(
    numeric.calls.map((call) => call.command),
    ['7']
  );
  assert.equal(numericReport.commands[0].command, '7');
});

test('probeDevice forwards timeout / retries only when they are valid', async () => {
  const forwarded = createStubTransport();
  await probeDevice({ transport: forwarded, commandTimeoutMs: 250, retries: 3 });
  for (const call of forwarded.calls) {
    assert.deepEqual(call.options, { timeoutMs: 250, retries: 3 });
  }

  const invalid = createStubTransport();
  await probeDevice({ transport: invalid, commandTimeoutMs: 0, retries: -1 });
  for (const call of invalid.calls) {
    assert.deepEqual(call.options, {});
  }

  const fractional = createStubTransport();
  await probeDevice({ transport: fractional, commandTimeoutMs: 1.5, retries: 2.5 });
  for (const call of fractional.calls) {
    assert.deepEqual(call.options, {});
  }
});

/* ------------------------------------------------------------ 只读清单 */

test('readonlyCommands exposes only read-only config,get commands', () => {
  const all = readonlyCommands();
  assert.equal(Object.isFrozen(all), true);
  assert.deepEqual([...all], [...DEFAULT_DEVICE_COMMANDS, ...DEFAULT_GNSS_COMMANDS]);
  assert.ok(all.includes('config,get,location,2'));
  assert.ok(all.includes('config,get,gpsext'));

  const withoutGnss = readonlyCommands({ includeGnss: false });
  assert.equal(Object.isFrozen(withoutGnss), true);
  assert.deepEqual([...withoutGnss], [...DEFAULT_DEVICE_COMMANDS]);
  for (const gnssCommand of DEFAULT_GNSS_COMMANDS) {
    assert.equal(withoutGnss.includes(gnssCommand), false, gnssCommand);
  }
  assert.ok(readonlyCommands({ includeGnss: true }).includes('config,get,gpsext'));
  assert.ok(readonlyCommands({}).includes('config,get,gpsext'));

  for (const command of readonlyCommands()) {
    assert.ok(command.startsWith('config,get,'), command);
    assert.equal(command.includes('config,set'), false, command);
    assert.equal(/\bset\b/.test(command), false, command);
  }
  for (const command of withoutGnss) {
    assert.ok(command.startsWith('config,get,'), command);
    assert.equal(command.includes('config,set'), false, command);
  }
});

/* ------------------------------------------------------------ 脱敏与 JSON 安全 */

test('probeDevice report is JSON-safe and never emits identifiers verbatim', async () => {
  const imei = '867890012345678';
  const iccid = '89860012345678901234';
  const msisdn = '13800138000';

  const transport = createStubTransport({
    'config,get,firmwarever': async () => ({
      lines: [`config,imei,ok,${imei}`, `config,iccid,ok,${iccid}`, `msisdn ${msisdn}`]
    })
  });

  const report = await probeDevice({ transport });
  const serialized = JSON.stringify(report);
  assert.ok(serialized.length > 0);
  assert.deepEqual(JSON.parse(serialized), JSON.parse(JSON.stringify(report)));

  for (const identifier of [imei, iccid, msisdn]) {
    assert.equal(serialized.includes(identifier), false, `leaked ${identifier}`);
  }

  // 值确实进入过回包，只是被替换成脱敏占位符。
  const lines = report.commands[0].lines.join('\n');
  assert.match(lines, /<redacted,imei/);
  assert.match(lines, /<redacted,iccid/);
  assert.match(lines, /<redacted,phone/);
  assert.equal(lines.includes(imei), false);
  assert.equal(lines.includes(iccid), false);
});

test('probeDevice redacts identity values inside error messages', async () => {
  const imei = '867890012345678';
  const transport = createStubTransport({
    'config,get,firmwarever': async () => {
      const error = new Error(`timeout for ${imei}`);
      error.code = 'SERIAL_COMMAND_TIMEOUT';
      throw error;
    }
  });

  const report = await probeDevice({ transport });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(imei), false);
  assert.equal(report.commands[0].status, 'TIMEOUT');
  assert.match(report.commands[0].errorMessage, /<redacted/);
});
