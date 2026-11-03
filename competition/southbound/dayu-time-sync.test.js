'use strict';
/* dayu-time-sync.test.js — 纯逻辑单测（不碰真机、不 spawn 进程，全部注入替身） */
const assert = require('node:assert/strict');
const test = require('node:test');
const sync = require('./dayu-time-sync');

const PC_2026_MS = 1792060628021;      /* 2026-10-15T10:37:08.021Z（PC 实测） */
const DEV_2017_MS = 1501844580000;     /* 2017-08-04T11:03:00Z（板端实测） */

/* ------------------------- 1) 秒 -> 毫秒的 64 位正确性 ------------------------- */

test('seconds are converted to milliseconds without precision loss', () => {
  assert.equal(sync.normalizeEpochMs(1792060628), 1792060628000);
  assert.equal(sync.normalizeEpochMs(1501844580), 1501844580000);
  assert.ok(Number.isSafeInteger(sync.normalizeEpochMs(1792060628)), 'ms value stays a safe integer');
  /* 2100 年边界仍然精确 */
  assert.equal(sync.normalizeEpochMs(4102444800), 4102444800000);
});

/* ------------------------- 2) 2017 年必须判为不可信 ------------------------- */

test('2017 timestamps are untrusted in both second and millisecond form', () => {
  assert.equal(sync.epochMsTrusted(DEV_2017_MS), false);
  assert.equal(sync.epochMsTrusted(sync.normalizeEpochMs(1501844580)), false);
  assert.equal(sync.epochMsTrusted(0), false);
  assert.equal(sync.epochMsTrusted(-1), false);
  assert.equal(sync.epochMsTrusted(NaN), false);
  assert.equal(sync.epochMsTrusted(sync.TRUST_FLOOR_MS - 1), false);
});

/* ------------------------- 3) 2026 年有效 epoch 被接受 ------------------------- */

test('valid 2026 epoch is accepted, boundaries are inclusive', () => {
  assert.equal(sync.epochMsTrusted(PC_2026_MS), true);
  assert.equal(sync.epochMsTrusted(sync.TRUST_FLOOR_MS), true);
  assert.equal(sync.epochMsTrusted(sync.TRUST_CEIL_MS), true);
  assert.equal(sync.epochMsTrusted(sync.TRUST_CEIL_MS + 1), false);
});

/* ------------------------- 4) 秒 / 毫秒不得混淆 ------------------------- */

test('second and millisecond inputs are not confused', () => {
  assert.equal(sync.looksLikeSeconds(1792060628), true);
  assert.equal(sync.looksLikeSeconds(1792060628021), false);
  assert.equal(sync.normalizeEpochMs(1792060628), 1792060628000);
  assert.equal(sync.normalizeEpochMs(1792060628021), 1792060628021);
  /* 同一个"2017 时刻"的两种写法归一化后必须相等且都不可信 */
  assert.equal(sync.normalizeEpochMs(1501844580), sync.normalizeEpochMs(1501844580000));
  assert.equal(sync.epochMsTrusted(sync.normalizeEpochMs(1501844580)), false);
  assert.equal(sync.normalizeEpochMs(0), 0);
});

/* ------------------------- 5) UTC 不得重复 +8 小时 ------------------------- */

test('formatting is UTC and never adds the +08:00 local offset', () => {
  assert.equal(sync.formatUtc(PC_2026_MS), '2026-10-15T10:37:08.021Z');
  assert.equal(sync.formatUtc(DEV_2017_MS), '2017-08-04T11:03:00Z');
  assert.equal(sync.formatUtc(0), '1970-01-01T00:00:00Z');
  assert.equal(new Date(PC_2026_MS).getUTCHours(), 10);
  assert.ok(!sync.formatUtc(PC_2026_MS).includes('18:37'), 'no accidental +8h shift');
});

/* ------------------------- 6) 时间源不可用时的错误路径 ------------------------- */

test('missing/duplicate/misidentified targets fail closed without writing', () => {
  const onlyUart = 'COM11\t\tUART\tReady\tunknown...\thdc\nCOM9\t\tUART\tReady\tunknown...\thdc';
  const calls = [];
  const r = sync.syncOnce({
    run: (target, args) => { calls.push(args.join(' ')); return onlyUart; },
    now: () => PC_2026_MS
  });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.code, 'NO_DEVICE');
  assert.equal(calls.length, 1, 'only the target listing was attempted');
  assert.ok(!calls.some((c) => c.includes('date -s')), 'never writes the clock to a serial port');

  const twoUsb = 'AAAA USB Connected x\nBBBB USB Connected y';
  const r2 = sync.syncOnce({ run: () => twoUsb, now: () => PC_2026_MS });
  assert.equal(r2.code, 'MULTIPLE_DEVICES');
});

test('hdc failure and unreadable clock are reported, not silently ignored', () => {
  const boom = sync.syncOnce({
    run: () => { throw new Error('spawn failed'); },
    now: () => PC_2026_MS
  });
  assert.equal(boom.status, 'FAIL');
  assert.equal(boom.code, 'HDC_UNAVAILABLE');

  const oneUsb = 'ABCDEF0123456789\t\tUSB\tConnected\tlocalhost\thdc';
  const unparsable = sync.syncOnce({
    run: (target, args) => (args[0] === 'list' ? oneUsb : 'not-a-number\n'),
    now: () => PC_2026_MS
  });
  assert.equal(unparsable.code, 'READ_UNPARSABLE');
});

test('untrusted PC clock refuses to push time to the device', () => {
  const calls = [];
  const r = sync.syncOnce({
    run: (target, args) => { calls.push(args.join(' ')); return 'ABCDEF0123456789\t\tUSB\tConnected'; },
    now: () => DEV_2017_MS
  });
  assert.equal(r.code, 'PC_CLOCK_UNTRUSTED');
  assert.equal(calls.length, 0);
});

/* ------------------------- 7) 重试不得形成高速循环 ------------------------- */

test('backoff grows exponentially, stays capped and never goes below the base', () => {
  const base = sync.DEFAULT_BACKOFF_BASE_MS;
  const max = sync.DEFAULT_BACKOFF_MAX_MS;
  assert.equal(sync.backoffMs(0), base);
  assert.equal(sync.backoffMs(1), base);
  assert.equal(sync.backoffMs(2), base * 2);
  assert.equal(sync.backoffMs(3), base * 4);
  assert.ok(sync.backoffMs(50) === max, 'capped at the maximum');
  for (let i = 0; i < 20; i++) assert.ok(sync.backoffMs(i) >= base, 'never faster than base');
  assert.ok(base >= 1000, 'base interval is seconds, not milliseconds');
  assert.ok(sync.DEFAULT_INTERVAL_MS >= 10000, 'watch interval is at least 10s (no 3s polling)');
});

/* ------------------------- 注入替身下的端到端校时 ------------------------- */

function fakeHdc(initialDeviceSec, targets) {
  const state = { deviceSec: initialDeviceSec, rtc: [], calls: [] };
  const run = (target, args) => {
    const cmd = args.join(' ');
    state.calls.push({ target: target, cmd: cmd });
    if (cmd.startsWith('list targets')) return targets;
    if (cmd === 'shell date +%s%3N') return String(state.deviceSec * 1000) + '\n';
    if (cmd === 'shell date +%s') return String(state.deviceSec) + '\n';
    if (cmd.startsWith('shell date -u -s @')) { state.deviceSec = Number(cmd.split('@')[1].split('.')[0]); return ''; }
    if (cmd.startsWith('shell hwclock -w')) { state.rtc.push(cmd.split('-f ')[1] || '/dev/rtc0'); return ''; }
    throw new Error('unexpected hdc command: ' + cmd);
  };
  return { state, run };
}
const ONE_USB = 'ABCDEF0123456789\t\tUSB\tConnected\tlocalhost\thdc\nCOM9\t\tUART\tReady';

test('a 2017 device is corrected, verified and both RTCs are written', () => {
  const fake = fakeHdc(1501844580, ONE_USB);
  const r = sync.syncOnce({ run: fake.run, now: () => PC_2026_MS, toleranceMs: 5000 });
  assert.equal(r.status, 'SET');
  assert.equal(r.code, 'SYNCED');
  assert.equal(r.deviceUtcBefore, '2017-08-04T11:03:00Z');
  assert.ok(r.driftMsBefore > 290000000000, 'drift was ~3359 days');
  assert.ok(r.driftMsAfter <= 5000);
  assert.equal(sync.epochMsTrusted(r.deviceMsAfter), true);
  assert.ok(fake.state.calls.some((c) => c.cmd === 'shell date -u -s @1792060628'),
    'writes the nearest whole second (toybox truncates fractions)');
  assert.deepEqual(fake.state.rtc, ['/dev/rtc0', '/dev/rtc1']);
  assert.ok(!fake.state.rtc.includes(undefined));
});

test('an in-sync device is left untouched (no writes at all)', () => {
  const fake = fakeHdc(Math.floor(PC_2026_MS / 1000) - 2, ONE_USB);
  const r = sync.syncOnce({ run: fake.run, now: () => PC_2026_MS, toleranceMs: 5000 });
  assert.equal(r.status, 'OK');
  assert.equal(r.code, 'ALREADY_IN_SYNC');
  assert.ok(!fake.state.calls.some((c) => c.cmd.includes('date -u -s')), 'no clock write when already in sync');
  assert.equal(fake.state.rtc.length, 0, 'no RTC write when already in sync');
});

test('device ids are redacted in every reported field', () => {
  const fake = fakeHdc(1501844580, ONE_USB);
  const r = sync.syncOnce({ run: fake.run, now: () => PC_2026_MS });
  assert.ok(!JSON.stringify(r).includes('ABCDEF0123456789'), 'full device id must not leak');
  assert.equal(r.target, 'ABCD…89');
});

test('target listing keeps USB and UART apart', () => {
  const parsed = sync.parseHdcTargets('AAA\t\tUSB\tConnected\tlocalhost\thdc\nCOM9\t\tUART\tReady\tunknown\thdc');
  assert.equal(parsed.usb.length, 1);
  assert.equal(parsed.uart.length, 1);
  assert.equal(parsed.usb[0].id, 'AAA');
});

test('cli defaults are safe', () => {
  const o = sync.parseArgv(['node', 'dayu-time-sync.js']);
  assert.equal(o.mode, 'once');
  assert.equal(o.toleranceMs, sync.DEFAULT_TOLERANCE_MS);
  assert.ok(o.toleranceMs <= 5000, 'default tolerance keeps the <5s target');
  assert.equal(sync.parseArgv(['node', 'x', '--watch', '--interval-ms', '90000']).mode, 'watch');
});
