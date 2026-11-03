'use strict';

/**
 * lib/probe-device-core.test.js - tests for the diagnostic CLI core.
 *
 * Safety / boundaries (enforced by this file):
 *   - Fixture mode only: no real serial port, no `require('serialport')`, no network,
 *     no filesystem writes. `--real` is only ever parsed with a synthetic name (COM99).
 *   - The CLI entry point is invoked in-process with fixture argv; it never opens a port.
 *   - Every identifier / coordinate below is constructed test data, not real data.
 *
 * Regression guards locked in here:
 *   1. built-in fixture profiles resolve to existing files under lib/fixtures/,
 *      so the CLI entry point runs a fixture probe without ENOENT;
 *   2. `--port` without `--real` is rejected instead of silently running fixture mode;
 *   3. FailoverStateMachine._emit never throws for an event with no subscribers;
 *   4. the rendered report never contains '<redacted,circular>' for shared device samples.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  EXIT,
  FIXTURE_PROFILES,
  DEFAULT_PROFILE,
  usage,
  parseArgs,
  parseIntegerArg,
  resolveFixturePath,
  runFixtureProbe,
  runFailoverDemo,
  buildReport,
  exitCodeFor,
  renderReport,
  defaultBaseDir,
  normalizeOutPath
} = require('./probe-device-core');
const { FixtureTransport } = require('./fixture-transport');
const { FailoverStateMachine, STATES, ACTIONS, PATHS } = require('./failover');
const { SIGNAL_VALID, SIGNAL_UNKNOWN, SIGNAL_INVALID } = require('./dtu-protocol');

/** lib/ - the directory that contains this module and the built-in fixtures. */
const LIB_DIR = defaultBaseDir();
/** Package root - contains probe-device.js and the lib/ tree. */
const PACKAGE_ROOT = path.resolve(LIB_DIR, '..');
/** The only directory allowed to hold built-in fixtures. */
const FIXTURES_DIR = path.join(PACKAGE_ROOT, 'lib', 'fixtures');

/**
 * Fixture base dir contract (confirmed with the Lead): `resolveFixturePath` is
 * baseDir-relative, and its baseDir is the directory that CONTAINS `fixtures/`,
 * i.e. `lib/`. probe-device.js passes `<pkg>/lib` explicitly and `runFixtureProbe`
 * defaults to this module's own directory, so both paths land on lib/fixtures.
 */
const FIXTURE_BASE_DIR = LIB_DIR;

function fixtureArgs(...extra) {
  return parseArgs(['--fixture', ...extra]);
}

/** Run one fixture probe and return the (single) sample plus options. */
async function singleProbe(argv) {
  const options = parseArgs(argv);
  const probe = await runFixtureProbe(options, FIXTURE_BASE_DIR);
  assert.equal(probe.samples.length, 1, `${argv.join(' ')} must produce exactly one sample`);
  return { options, probe, sample: probe.samples[0] };
}

/* ------------------------------------------------------------ parseArgs */

test('parseArgs defaults describe fixture mode', () => {
  const options = parseArgs([]);
  assert.equal(options.mode, 'fixture');
  assert.equal(options.profile, null);
  assert.equal(options.fixtureFile, null);
  assert.equal(options.samples, 1);
  assert.equal(options.gnss, true);
  assert.equal(options.at, false);
  assert.equal(options.raw, false);
  assert.equal(options.pretty, false);
  assert.equal(options.out, null);
  assert.equal(options.baudRate, 115200);
  assert.equal(options.timeoutMs, 1500);
  assert.equal(options.retries, 1);
  assert.equal(options.real, false);
  assert.equal(options.port, null);
  assert.equal(options.failoverDemo, false);
  assert.equal(Object.isFrozen(options), true, 'parseArgs must return a frozen object');
});

test('parseArgs requires --real and --port together', () => {
  // `--real` alone is a usage error; it must not fall back to fixture mode.
  assert.throws(() => parseArgs(['--real']), /--port/);
  // `--port` without `--real` is the dangerous ambiguity: previously it silently ran fixtures.
  assert.throws(() => parseArgs(['--port', 'COM99']), /--real/);
  assert.throws(() => parseArgs(['--fixture', '--port', 'COM99']), /--real/);

  const real = parseArgs(['--real', '--port', 'COM99']);
  assert.equal(real.mode, 'real');
  assert.equal(real.real, true);
  assert.equal(real.port, 'COM99');
  assert.equal(parseArgs(['--real', '--port', '/dev/ttyUSB0']).mode, 'real');
  assert.throws(() => parseArgs(['--real', '--port', 'not-a-port']), /--port/);
});

test('--at is fixture-only and cannot be combined with --real', () => {
  assert.throws(() => parseArgs(['--real', '--port', 'COM99', '--at']), /--at/);
  assert.equal(parseArgs(['--fixture', '--at']).profile, 'at');
  assert.equal(parseArgs(['--at']).at, true);
  assert.equal(parseArgs(['--at']).mode, 'fixture');
  assert.equal(parseArgs(['--fixture', '--profile', 'at', '--at']).profile, 'at');
});

test('parseArgs rejects unknown arguments and unknown profiles', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['-x']), /unknown argument/);
  assert.throws(() => parseArgs(['--profile', 'bogus']), /unknown --profile/);
  assert.throws(() => parseArgs(['--profile', '']), /unknown --profile/);
});

test('parseArgs rejects out-of-range numeric options', () => {
  assert.throws(() => parseArgs(['--baud', '1199']));
  assert.throws(() => parseArgs(['--baud', '460801']));
  assert.throws(() => parseArgs(['--baud', 'abc']));
  assert.throws(() => parseArgs(['--timeout', '199']));
  assert.throws(() => parseArgs(['--timeout', '30001']));
  assert.throws(() => parseArgs(['--retries', '11']));
  assert.throws(() => parseArgs(['--retries', '-1']));
  assert.throws(() => parseArgs(['--samples', '0']));
  assert.throws(() => parseArgs(['--samples', '51']));

  assert.equal(parseArgs(['--samples', '50']).samples, 50);
  assert.equal(parseArgs(['--retries', '0']).retries, 0);
  assert.equal(parseArgs(['--baud', '1200']).baudRate, 1200);
  assert.equal(parseArgs(['--baud', '460800']).baudRate, 460800);
  assert.equal(parseArgs(['--timeout', '200']).timeoutMs, 200);
  assert.equal(parseArgs(['--timeout', '30000']).timeoutMs, 30000);
});

test('--no-gnss and --help are honoured', () => {
  assert.equal(parseArgs(['--no-gnss']).gnss, false);
  assert.equal(parseArgs(['--fixture', '--no-gnss']).gnss, false);
  assert.equal(parseArgs(['--fixture']).gnss, true);

  const help = parseArgs(['--help']);
  assert.equal(help.help, true);
  assert.equal(Object.isFrozen(help), true);
  assert.equal(parseArgs(['-h']).help, true);

  const text = usage();
  assert.equal(typeof text, 'string');
  assert.match(text, /--fixture/);
  assert.match(text, /--real/);
});

test('parseIntegerArg enforces integers within a closed range', () => {
  assert.equal(parseIntegerArg('42', '--n', 1, 100), 42);
  assert.equal(parseIntegerArg(7, '--n', 1, 100), 7);
  assert.throws(() => parseIntegerArg('0', '--n', 1, 100), /\[1, 100\]/);
  assert.throws(() => parseIntegerArg('101', '--n', 1, 100), /\[1, 100\]/);
  assert.throws(() => parseIntegerArg('1.5', '--n', 1, 100), /integer/);
  assert.throws(() => parseIntegerArg(undefined, '--n', 1, 100), /integer/);
  assert.throws(() => parseIntegerArg('', '--n', 1, 100), /integer/);
});

/* ------------------------------------------------------------ resolveFixturePath */

test('every built-in profile resolves to an existing file under lib/fixtures/', () => {
  assert.notEqual(FIXTURE_BASE_DIR, null, 'no base dir resolves the built-in fixtures');
  const entries = Object.entries(FIXTURE_PROFILES);
  assert.equal(entries.length, 6);
  assert.equal(DEFAULT_PROFILE, 'registered');

  for (const [profile, file] of entries) {
    const resolved = resolveFixturePath({ profile, fixtureFile: null }, FIXTURE_BASE_DIR);
    assert.equal(resolved, path.join(FIXTURES_DIR, file), profile);
    assert.ok(fs.existsSync(resolved), `${profile} -> ${resolved} must exist`);
    assert.ok(resolved.startsWith(FIXTURES_DIR + path.sep), `${profile} must live under lib/fixtures`);
  }
});

test('an explicit --fixture-file resolves to the requested file', () => {
  const target = path.join(FIXTURES_DIR, 'at-standard.fixture');
  const relative = path.relative(FIXTURE_BASE_DIR, target);
  const options = parseArgs(['--fixture', '--at', '--fixture-file', relative]);

  const resolved = resolveFixturePath(options, FIXTURE_BASE_DIR);
  assert.equal(resolved, target);
  assert.ok(fs.existsSync(resolved));
});

test('runFixtureProbe accepts an explicit fixture-file and reports its basename', async () => {
  const relative = path.relative(FIXTURE_BASE_DIR, path.join(FIXTURES_DIR, 'at-standard.fixture'));
  const options = parseArgs(['--fixture', '--at', '--fixture-file', relative]);
  const probe = await runFixtureProbe(options, FIXTURE_BASE_DIR);

  assert.equal(probe.mode, 'fixture');
  assert.equal(probe.fixtureFile, 'at-standard.fixture');
  assert.equal(probe.samples.length, 1);
});

test('runFixtureProbe defaults to its own directory (lib/) and resolves built-in profiles', async () => {
  // No baseDir argument: this must behave exactly like the CLI's explicit `<pkg>/lib`.
  const options = parseArgs(['--fixture']);
  const probe = await runFixtureProbe(options);

  assert.equal(probe.mode, 'fixture');
  assert.equal(probe.fixtureFile, 'device-registered.fixture');
  assert.equal(probe.commands.length, 6);
  assert.equal(probe.samples.length, 1);

  const dtu = probe.samples[0].device.dtu;
  assert.equal(dtu.firmware, 'YED_DTU4_2.0.3');
  assert.equal(dtu.signal.csq, 26);
  assert.equal(dtu.signal.dbm, -61);
  assert.equal(dtu.network.code, 3);
  assert.equal(dtu.sim.ready, true);

  const report = buildReport({ options, probeResult: probe, failures: [] });
  assert.equal(report.summary.commandsAttempted, 6);
  assert.equal(report.summary.commandsSucceeded, 4);
  assert.equal(report.summary.commandsFailed, 2);
});

/* ------------------------------------------------------------ runFixtureProbe */

test('runFixtureProbe(registered) parses DTU state and closes the fixture transport', async () => {
  const originalDisconnect = FixtureTransport.prototype.disconnect;
  const closed = [];
  FixtureTransport.prototype.disconnect = function spyDisconnect() {
    closed.push(this);
    return originalDisconnect.call(this);
  };

  try {
    const options = fixtureArgs('--profile', 'registered');
    const probe = await runFixtureProbe(options, FIXTURE_BASE_DIR);

    assert.equal(probe.mode, 'fixture');
    assert.equal(probe.fixtureFile, 'device-registered.fixture');
    assert.equal(probe.commands.length, 6, 'default command list includes the two GNSS reads');
    assert.equal(probe.samples.length, 1);

    const sample = probe.samples[0];
    const dtu = sample.device.dtu;
    assert.equal(dtu.firmware, 'YED_DTU4_2.0.3');
    assert.equal(dtu.signal.csq, 26);
    assert.equal(dtu.signal.dbm, -61);
    assert.equal(dtu.signal.state, SIGNAL_VALID);
    assert.equal(dtu.network.code, 3);
    assert.equal(dtu.sim.ready, true);
    assert.equal(sample.port, 'FIXTURE:device-registered.fixture');

    const report = buildReport({ options, probeResult: probe, failures: [] });
    assert.ok(report.summary.commandsSucceeded > 0);
    assert.equal(report.summary.commandsSucceeded, 4, 'the registered fixture records four DTU replies');
    assert.equal(report.summary.commandsFailed, 2, 'GNSS replies are not recorded in this fixture');

    // The runner must always disconnect the fixture transport, even on success.
    assert.equal(closed.length, 1);
    assert.ok(closed[0] instanceof FixtureTransport);
    assert.equal(closed[0].isOpen, false);
  } finally {
    FixtureTransport.prototype.disconnect = originalDisconnect;
  }
});

test('csq-invalid keeps CSQ 99 unknown and rejects out-of-range values', async () => {
  const options = parseArgs(['--fixture', '--profile', 'csq-invalid', '--samples', '5']);
  const probe = await runFixtureProbe(options, FIXTURE_BASE_DIR);
  assert.equal(probe.samples.length, 5);

  const signals = probe.samples.map((sample) => sample.device.dtu.signal);

  // Boundary values stay on the standard formula.
  assert.equal(signals[0].csq, 0);
  assert.equal(signals[0].dbm, -113);
  assert.equal(signals[0].state, SIGNAL_VALID);
  assert.equal(signals[1].csq, 31);
  assert.equal(signals[1].dbm, -51);
  assert.equal(signals[1].state, SIGNAL_VALID);

  // CSQ 99 is "unknown": no dBm, never a strong signal.
  const unknown = signals[2];
  assert.equal(unknown.csq, 99);
  assert.equal(unknown.dbm, null, 'CSQ 99 must never be converted to dBm');
  assert.equal(unknown.state, SIGNAL_UNKNOWN);
  assert.notEqual(unknown.state, SIGNAL_VALID);
  assert.notEqual(unknown.quality, 'excellent');

  // 32 and 'abc' are out of range / malformed: no dBm, INVALID.
  for (const invalid of signals.slice(3)) {
    assert.equal(invalid.dbm, null);
    assert.equal(invalid.state, SIGNAL_INVALID);
  }
  for (const signal of signals) {
    if (signal.csq === 99) assert.equal(signal.dbm, null);
  }
});

test('gnss-fixed resolves a valid fix', async () => {
  const { sample } = await singleProbe(['--fixture', '--profile', 'gnss-fixed']);
  const gnss = sample.device.dtu.gnss;

  assert.equal(gnss.valid, true);
  assert.equal(gnss.state, 'FIXED');
  assert.equal(typeof gnss.latitude, 'number');
  assert.equal(typeof gnss.longitude, 'number');
  assert.notEqual(gnss.latitude, null);
  assert.notEqual(gnss.longitude, null);
  assert.equal(gnss.latitude, 20.1234567);
  assert.equal(gnss.longitude, 110.1234567);
  assert.equal(gnss.fixTimeUtc, '2022-11-03T02:43:51Z');
});

test('no-fix reports valid:false with null coordinates', async () => {
  const { sample } = await singleProbe(['--fixture', '--profile', 'no-fix']);
  const gnss = sample.device.dtu.gnss;

  assert.equal(gnss.valid, false);
  assert.equal(gnss.state, 'NO_FIX');
  assert.equal(gnss.latitude, null);
  assert.equal(gnss.longitude, null);
});

test('error-timeout-drop records ERROR/TIMEOUT/DISCONNECTED without throwing', async () => {
  const options = parseArgs(['--fixture', '--profile', 'error-timeout-drop']);
  const probe = await runFixtureProbe(options, FIXTURE_BASE_DIR);

  // The simulated drop closes the transport, so sampling stops after the first round.
  assert.equal(probe.samples.length, 1);
  const statuses = probe.samples[0].commands.map((entry) => entry.status);
  assert.ok(statuses.includes('ERROR'), `missing ERROR in ${statuses.join(',')}`);
  assert.ok(statuses.includes('TIMEOUT'), `missing TIMEOUT in ${statuses.join(',')}`);
  assert.ok(statuses.includes('DISCONNECTED'), `missing DISCONNECTED in ${statuses.join(',')}`);

  const byCommand = Object.fromEntries(probe.samples[0].commands.map((entry) => [entry.command, entry.status]));
  assert.equal(byCommand['config,get,paramver'], 'TIMEOUT');
  assert.equal(byCommand['config,get,csq'], 'ERROR');
  assert.equal(byCommand['config,get,location,2'], 'DISCONNECTED');
  assert.equal(byCommand['config,get,gpsext'], 'NOT_OPEN', 'after the drop the fixture transport is closed');
});

test('the --at fixture path parses CPIN/CSQ/registration/operator', async () => {
  const { probe, sample } = await singleProbe(['--fixture', '--profile', 'at', '--at']);

  // 夹具探测序列由 AT_QUERY_COMMANDS 定义，最后一条 AT+CGMR 对应夹具里
  // 那条 ERROR 应答，用来覆盖「设备返回 ERROR」的路径。
  assert.equal(probe.commands.length, 6);
  assert.deepEqual(probe.commands, [
    'AT+CPIN?',
    'AT+CSQ',
    'AT+CREG?',
    'AT+CEREG?',
    'AT+COPS?',
    'AT+CGMR'
  ]);
  assert.equal(sample.device.protocol, 'AT_3GPP_FRAMEWORK_ONLY');
  assert.equal(sample.device.dtu, null, 'AT mode must not fabricate a DTU state');

  const at = sample.device.at;
  assert.equal(at.pin.ready, true);
  assert.equal(at.pin.state, 'READY');
  assert.equal(at.csq.csq, 22);
  assert.equal(at.csq.dbm, -69);
  assert.equal(at.registrations['+CREG'].state, 'REGISTERED');
  assert.equal(at.registrations['+CREG'].detail, 'registered_home');
  assert.equal(at.operator.operator, 'TEST-OPERATOR');

  // AT+CGMR 在夹具中应答 ERROR：该命令必须被真实请求并记为失败。
  const cgmr = sample.commands.find((entry) => entry.command === 'AT+CGMR');
  assert.ok(cgmr, 'AT+CGMR must be requested so the ERROR path is exercised');
  assert.equal(cgmr.ok, false);
  assert.equal(cgmr.status, 'ERROR');
  assert.equal(cgmr.errorCode, 'SERIAL_COMMAND_ERROR');
  assert.equal(sample.commands.filter((entry) => entry.ok === true).length, 5);

  // 已知边界（不是本用例要修的缺陷）：失败命令不把原始回包行写进 lines，
  // 因此 parseAtResponse 看不到那行 ERROR，at.error 仍为 false。设备的 ERROR
  // 结论由上面的命令级 status 承载。
  assert.equal(at.error, false);
});

/* ------------------------------------------------------------ buildReport / renderReport */

test('buildReport + renderReport produce valid, stable, fully redacted JSON', async () => {
  const options = fixtureArgs('--profile', 'registered');
  const probe = await runFixtureProbe(options, FIXTURE_BASE_DIR);
  const report = buildReport({ options, probeResult: probe, failures: [] });

  const text = renderReport(report, false);
  assert.doesNotThrow(() => JSON.parse(text));
  const parsed = JSON.parse(text);

  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(Object.keys(parsed), [
    'schemaVersion',
    'mode',
    'protocol',
    'generatedAtMs',
    'options',
    'commands',
    'summary',
    'device',
    'deviceSamples',
    'at',
    'urc',
    'failures',
    'notes'
  ]);
  assert.equal(parsed.protocol, 'YED_DTU_CONFIG');
  assert.equal(report.summary.commandsAttempted, probe.commands.length * probe.samples.length);
  assert.equal(report.summary.samples, probe.samples.length);

  // Regression guard: a shared device object must not be mistaken for a cycle.
  assert.equal(text.includes('<redacted,circular>'), false);

  // Pretty rendering stays valid JSON as well.
  const pretty = renderReport(report, true);
  assert.equal(pretty.includes('\n  '), true);
  assert.doesNotThrow(() => JSON.parse(pretty));
});

test('the report redacts identifier-like fixture literals and shared device samples', () => {
  // --raw is what actually embeds the fixture lines in the report; they must be redacted.
  const options = fixtureArgs('--profile', 'registered', '--no-gnss', '--raw');
  const imeiLine = 'config,imei,ok,861234567890123';
  const iccidLine = 'config,iccid,ok,89860012345678901234';
  const bareLine = 'module id 861234567890123 reported';

  // The same device object is intentionally shared by `device` and both deviceSamples entries.
  const sharedDtu = { firmware: 'YED_DTU4_2.0.3' };
  const sample = {
    commands: [
      {
        command: 'config,get,firmwarever',
        status: 'OK',
        ok: true,
        lines: [imeiLine, iccidLine, bareLine]
      }
    ],
    device: { dtu: sharedDtu },
    urc: []
  };
  const probeResult = {
    mode: 'fixture',
    fixtureFile: 'synthetic.fixture',
    commands: ['config,get,firmwarever'],
    samples: [sample, sample]
  };

  const report = buildReport({ options, probeResult, failures: [] });
  const text = renderReport(report, false);
  const parsed = JSON.parse(text);

  assert.equal(parsed.summary.commandsAttempted, probeResult.commands.length * probeResult.samples.length);
  assert.equal(parsed.deviceSamples.length, 2);
  assert.deepEqual(parsed.device, parsed.deviceSamples[0]);
  assert.deepEqual(parsed.deviceSamples[0], parsed.deviceSamples[1]);
  assert.equal(parsed.device.firmware, 'YED_DTU4_2.0.3');
  assert.equal(parsed.options.includeRawLines, true);
  assert.ok(Array.isArray(parsed.rawLines), 'raw fixture lines must be present when --raw is set');

  assert.equal(text.includes('861234567890123'), false, 'IMEI-like literal must not survive');
  assert.equal(text.includes('89860012345678901234'), false, 'ICCID-like literal must not survive');
  assert.equal(text.includes('<redacted,circular>'), false);
  assert.ok(text.includes('<redacted'), 'redaction markers must be present');
});

/* ------------------------------------------------------------ exitCodeFor */

test('exitCodeFor maps success, partial failure, total failure and no commands', () => {
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.FAILED, 1);
  assert.equal(EXIT.PARTIAL, 2);
  assert.equal(EXIT.USAGE, 64);

  assert.equal(exitCodeFor({ summary: { commandsAttempted: 3, commandsSucceeded: 3, commandsFailed: 0 } }), EXIT.OK);
  assert.equal(exitCodeFor({ summary: { commandsAttempted: 3, commandsSucceeded: 2, commandsFailed: 1 } }), EXIT.PARTIAL);
  assert.equal(exitCodeFor({ summary: { commandsAttempted: 3, commandsSucceeded: 0, commandsFailed: 3 } }), EXIT.FAILED);
  assert.equal(exitCodeFor({ summary: { commandsAttempted: 0, commandsSucceeded: 0, commandsFailed: 0 } }), EXIT.FAILED);
  assert.equal(exitCodeFor({}), EXIT.FAILED);
});

test('a fully successful fixture probe exits 0', async () => {
  const options = parseArgs(['--fixture', '--profile', 'registered', '--no-gnss']);
  const probe = await runFixtureProbe(options, FIXTURE_BASE_DIR);
  const report = buildReport({ options, probeResult: probe, failures: [] });

  assert.equal(report.summary.commandsAttempted, 4);
  assert.equal(report.summary.commandsFailed, 0);
  assert.equal(exitCodeFor(report), EXIT.OK);
});

/* ------------------------------------------------------------ failover */

test('runFailoverDemo degrades to OFFLINE and only returns to Wi-Fi after the stable window', () => {
  const options = parseArgs(['--failover-demo']);
  const demo = runFailoverDemo(options);

  assert.equal(demo.mode, 'failover-demo');
  assert.equal(demo.claims.realWifiToCellularTakeoverVerified, false);
  assert.deepEqual(
    { step: demo.timeline[0].step, state: demo.timeline[0].state },
    { step: 'wifi_up', state: STATES.WIFI_PRIMARY }
  );

  // A 4G attempt starts after the debounce window and is retried until OFFLINE.
  assert.ok(demo.timeline.some((entry) => entry.state === STATES.CELLULAR_CONNECTING));
  assert.ok(demo.timeline.some((entry) => entry.state === STATES.OFFLINE));

  // Nothing may switch before the debounce window elapses.
  const firstCellular = demo.timeline.findIndex((entry) => entry.state === STATES.CELLULAR_CONNECTING);
  assert.ok(firstCellular > 0);
  for (const entry of demo.timeline.slice(0, firstCellular)) {
    assert.equal(entry.state, STATES.WIFI_PRIMARY, `${entry.step} must not switch before the debounce window`);
  }

  // Wi-Fi recovered but is not yet stable: stay off Wi-Fi (hysteresis proof).
  const notStableIndex = demo.timeline.findIndex((entry) => entry.step === 'wifi_not_stable_yet');
  assert.ok(notStableIndex >= 0, 'wifi_not_stable_yet must be recorded');
  assert.notEqual(demo.timeline[notStableIndex].state, STATES.WIFI_PRIMARY);
  assert.equal(demo.timeline[notStableIndex].state, STATES.OFFLINE);

  const wifiBackIndex = demo.timeline.findIndex((entry) => entry.step === 'wifi_back');
  assert.ok(wifiBackIndex >= 0);
  const wifiStableIndex = demo.timeline.findIndex((entry) => entry.step === 'wifi_stable');
  assert.ok(wifiStableIndex > wifiBackIndex);
  assert.equal(demo.timeline[wifiStableIndex].state, STATES.WIFI_PRIMARY);
  for (const entry of demo.timeline.slice(wifiBackIndex, wifiStableIndex)) {
    assert.notEqual(entry.state, STATES.WIFI_PRIMARY, `${entry.step} must stay off Wi-Fi until wifiStableMs`);
  }

  assert.equal(demo.timeline[demo.timeline.length - 1].state, STATES.WIFI_PRIMARY);
  assert.equal(demo.finalState.state, STATES.WIFI_PRIMARY);

  assert.ok(
    demo.transitions.some((event) => event.from === STATES.WIFI_PRIMARY && event.to === STATES.CELLULAR_CONNECTING)
  );
  assert.ok(demo.transitions.some((event) => event.to === STATES.OFFLINE));
  assert.ok(demo.transitions.some((event) => event.from === STATES.OFFLINE && event.to === STATES.WIFI_PRIMARY));
  assert.ok(demo.actions.some((event) => event.action === ACTIONS.CONNECT_CELLULAR));
  assert.ok(demo.actions.some((event) => event.action === ACTIONS.SWITCH_TO_WIFI));
});

test('runFailoverDemo reaches OFFLINE for small --max-attempts values too', () => {
  for (const maxAttempts of [1, 2, 3]) {
    const demo = runFailoverDemo(parseArgs(['--failover-demo', '--max-attempts', String(maxAttempts)]));
    assert.equal(demo.config.maxAttemptsBeforeOffline, maxAttempts);
    assert.ok(
      demo.timeline.some((entry) => entry.state === STATES.OFFLINE),
      `--max-attempts ${maxAttempts} must still reach OFFLINE`
    );
    assert.equal(demo.timeline[demo.timeline.length - 1].state, STATES.WIFI_PRIMARY);
  }
});

test('runFailoverDemo backoff samples follow base*2^n capped at max', () => {
  const options = parseArgs(['--failover-demo']);
  const demo = runFailoverDemo(options);

  for (const entry of demo.backoffSamples) {
    const expected = Math.min(
      options.backoffMaxMs,
      Math.max(options.backoffBaseMs, options.backoffBaseMs * 2 ** entry.attempt)
    );
    assert.equal(entry.delayMs, expected, `attempt ${entry.attempt}`);
  }
  assert.deepEqual(
    demo.backoffSamples.map((entry) => entry.delayMs),
    [1000, 2000, 4000, 8000, 16000, 32000, 60000]
  );

  const custom = runFailoverDemo(
    parseArgs(['--failover-demo', '--backoff-base', '500', '--backoff-max', '5000', '--wifi-down-delay', '1000', '--wifi-stable', '2000'])
  );
  assert.deepEqual(
    custom.backoffSamples.map((entry) => entry.delayMs),
    [500, 1000, 2000, 4000, 5000, 5000, 5000]
  );
  assert.equal(custom.config.wifiDownDelayMs, 1000);
  assert.equal(custom.config.wifiStableMs, 2000);
});

test('FailoverStateMachine emits events without throwing when nothing is subscribed', () => {
  const machine = new FailoverStateMachine();

  assert.doesNotThrow(() => {
    machine.reportWifi(true, 0);
    machine.reportWifi(false, 1000); // '_emit("wifi", ...)' with no 'wifi' subscriber
    machine.tick(5000);
    machine.reportCellular(false, 6000);
    machine.reportCellular(true, 7000);
    machine.forceWifi(8000);
    machine.forceCellular(9000);
    machine.disableCellular(10000);
    machine.off('transition', () => {});
    machine.on('wifi', () => {});
  });
});

test('FailoverStateMachine delivers transition/action events to subscribers', () => {
  const transitions = [];
  const actions = [];
  const machine = new FailoverStateMachine(
    { wifiDownDelayMs: 1000 },
    {
      onTransition: (event) => transitions.push(event),
      onAction: (event) => actions.push(event)
    }
  );

  machine.reportWifi(false, 0);
  machine.tick(2000);

  assert.ok(transitions.some((event) => event.to === STATES.CELLULAR_CONNECTING));
  assert.ok(actions.some((event) => event.action === ACTIONS.CONNECT_CELLULAR));
});

test('failover reaches OFFLINE once failures hit maxAttemptsBeforeOffline', () => {
  const machine = new FailoverStateMachine({ wifiDownDelayMs: 1000, maxAttemptsBeforeOffline: 3 });

  machine.reportWifi(false, 0);
  machine.tick(2000);
  assert.equal(machine.getStatus().state, STATES.CELLULAR_CONNECTING);
  assert.equal(machine.getStatus().activePath, PATHS.NONE);

  machine.reportCellular(false, 3000);
  machine.reportCellular(false, 4000);
  assert.equal(machine.getStatus().state, STATES.CELLULAR_CONNECTING, 'still below maxAttempts');

  machine.reportCellular(false, 5000);
  const status = machine.getStatus();
  assert.equal(status.state, STATES.OFFLINE);
  assert.equal(status.attempt, 3);
  assert.equal(status.nextAttemptAtMs, null);
  assert.equal(status.activePath, PATHS.NONE);

  // Wi-Fi recovery resets the machine back to the primary path.
  machine.reportWifi(true, 9000);
  machine.tick(9000 + 10000);
  assert.equal(machine.getStatus().state, STATES.WIFI_PRIMARY);
});

test('cellularEnabled=false degrades to OFFLINE instead of crashing', () => {
  const machine = new FailoverStateMachine({ cellularEnabled: false, wifiDownDelayMs: 1000 });
  machine.reportWifi(false, 0);

  const status = machine.tick(2000);
  assert.equal(status.state, STATES.OFFLINE);
  assert.equal(status.activePath, PATHS.NONE);
  assert.equal(machine.shouldAttemptCellular(3000), false);

  // runFailoverDemo never forwards cellularEnabled, so the disabled path is covered directly.
  const demo = runFailoverDemo(parseArgs(['--failover-demo']));
  assert.equal(demo.config.cellularEnabled, true);
});

/* ------------------------------------------------------------ normalizeOutPath */

test('normalizeOutPath resolves relative paths, preserves absolute ones and strips control chars', () => {
  const cwd = process.cwd();

  assert.equal(normalizeOutPath('out.json', cwd), path.resolve(cwd, 'out.json'));
  const absolute = path.resolve('probe-out.json');
  assert.equal(normalizeOutPath(absolute, cwd), absolute);

  assert.equal(normalizeOutPath('', cwd), null);
  assert.equal(normalizeOutPath('   ', cwd), null);
  assert.equal(normalizeOutPath(undefined, cwd), null);
  assert.equal(normalizeOutPath(null, cwd), null);

  assert.equal(normalizeOutPath('\u001b[31mout.json\u001b[0m', cwd), path.resolve(cwd, 'out.json'));
  assert.equal(normalizeOutPath('a\u0000b.json', cwd), path.resolve(cwd, 'ab.json'));

  assert.equal(normalizeOutPath('out.json'), path.resolve(process.cwd(), 'out.json'));
});

/* ------------------------------------------------------------ CLI entry point */

test('the CLI entry runs a fixture probe end to end and rejects --real without a port', async () => {
  const { main } = require('../probe-device');

  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    err += String(chunk);
    return true;
  };

  try {
    // Built-in fixture profiles must resolve from the CLI without ENOENT.
    const code = await main(['--fixture', '--profile', 'registered', '--no-gnss']);
    assert.equal(code, EXIT.OK, `CLI fixture probe failed; stderr=${err}`);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.device.firmware, 'YED_DTU4_2.0.3');
    assert.equal(parsed.summary.commandsAttempted, 4);
    assert.equal(parsed.summary.commandsFailed, 0);

    // No real port is ever provided: this must stop at the usage-error exit code.
    out = '';
    err = '';
    const usageCode = await main(['--real']);
    assert.equal(usageCode, EXIT.USAGE);
    assert.match(err, /--port/);
    assert.equal(out, '');
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
});
