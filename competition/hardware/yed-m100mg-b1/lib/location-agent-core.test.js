'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createLocationAgent,
  createInstanceLock,
  nextDelayMs,
  backoffForAttempt,
  DEFAULT_READ_BACKOFF_MS
} = require('./location-agent-core');

const NOW = 1792064000000;
const FIX_UTC = '2026-10-15T11:33:10Z';

function deviceWithFix() {
  return {
    signal: { csq: 26 },
    network: { state: 'REGISTERED' },
    gnss: {
      supported: true, state: 'FIXED', valid: true, reason: 'extended_flag',
      latitude: 34.7466, longitude: 113.6254, fixTimeUtc: FIX_UTC, speedKmh: 0, courseDeg: 0, altitudeM: 110
    }
  };
}

function deviceNoFix() {
  return {
    signal: { csq: 30 },
    network: { state: 'REGISTERED' },
    gnss: {
      supported: true, state: 'NO_FIX', valid: false, reason: 'flag_zero',
      latitude: null, longitude: null, fixTimeUtc: null, speedKmh: null, courseDeg: null, altitudeM: null
    }
  };
}

function harness(readResults, options = {}) {
  const published = [];
  const logs = [];
  let index = 0;
  const agent = createLocationAgent({
    readDevice: async () => {
      const entry = readResults[Math.min(index, readResults.length - 1)];
      index += 1;
      if (entry instanceof Error) throw entry;
      return entry;
    },
    publish: async (topic, payload) => { published.push({ topic, payload }); },
    now: () => NOW,
    log: (line) => logs.push(line),
    sleep: async () => {}
  }, options);
  return { agent, published, logs, reads: () => index };
}

test('有效 fix 时发布 valid:true 且坐标成对、fixTime 为 13 位毫秒', async () => {
  const h = harness([{ ok: true, device: deviceWithFix() }]);
  const result = await h.agent.pollOnce();
  assert.equal(result.ok, true);
  assert.equal(h.published.length, 1);
  const { topic, payload } = h.published[0];
  assert.equal(topic, 'home/yed-home-gateway/status');
  assert.deepEqual(payload.gps, {
    valid: true, latitude: 34.7466, longitude: 113.6254, fixTime: Date.parse(FIX_UTC)
  });
  assert.equal(payload.deviceId, 'yed-home-gateway');
  assert.equal(payload.room, '家庭网关');
});

test('室内 NO_FIX 时发布 valid:false 且不带坐标', async () => {
  const h = harness([{ ok: true, device: deviceNoFix() }]);
  await h.agent.pollOnce();
  assert.deepEqual(h.published[0].payload.gps, { valid: false, fixTime: 0 });
  assert.equal(h.published[0].payload.csq, 30);
});

test('串口超时/掉线：仍发布降级报文，并累计失败计数', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'SERIAL_COMMAND_TIMEOUT' });
  const h = harness([timeout, timeout, { ok: false, errorCode: 'SERIAL_DISCONNECTED' }]);
  const r1 = await h.agent.pollOnce();
  assert.equal(r1.ok, false);
  assert.equal(r1.errorCode, 'SERIAL_COMMAND_TIMEOUT');
  assert.deepEqual(h.published[0].payload.gps, { valid: false, fixTime: 0 });
  assert.equal(h.published[0].payload.csq, 99);
  await h.agent.pollOnce();
  await h.agent.pollOnce();
  const stats = h.agent.stats();
  assert.equal(stats.polls, 3);
  assert.equal(stats.readFailures, 3);
  assert.equal(stats.published, 3, '掉线也要发布，避免公网继续沿用旧坐标');
  assert.equal(stats.consecutiveFailures, 3);
});

test('读失败恢复后计数清零，重新发布有效定位', async () => {
  const timeout = Object.assign(new Error('timeout'), { code: 'SERIAL_COMMAND_TIMEOUT' });
  const h = harness([timeout, { ok: true, device: deviceWithFix() }]);
  await h.agent.pollOnce();
  assert.equal(h.agent.stats().consecutiveFailures, 1);
  await h.agent.pollOnce();
  assert.equal(h.agent.stats().consecutiveFailures, 0);
  assert.equal(h.published[1].payload.gps.valid, true);
});

test('退避序列有界且递增（不形成忙循环）', () => {
  const opts = { intervalMs: 30000, readBackoffMs: [5000, 10000, 30000, 60000] };
  const failed = (n) => nextDelayMs({ ok: false }, { consecutiveFailures: n }, opts);
  assert.equal(failed(1), 5000);
  assert.equal(failed(2), 10000);
  assert.equal(failed(3), 30000);
  assert.equal(failed(4), 60000);
  assert.equal(failed(99), 60000, '退避必须封顶');
  assert.equal(nextDelayMs({ ok: true }, { consecutiveFailures: 5 }, opts), 30000, '成功后回到正常间隔');
  assert.equal(backoffForAttempt(0, [5000, 10000]), 5000, '越界索引按第 1 档处理');
  assert.deepEqual(DEFAULT_READ_BACKOFF_MS, [5000, 10000, 30000, 60000]);
});

test('串口重连成功后回到正常间隔（真实循环驱动）', async () => {
  const delays = [];
  const timeout = Object.assign(new Error('timeout'), { code: 'SERIAL_COMMAND_TIMEOUT' });
  let first = true;
  let agent;
  agent = createLocationAgent({
    readDevice: async () => {
      if (first) { first = false; throw timeout; }
      return { ok: true, device: deviceNoFix() };
    },
    publish: async () => {},
    now: () => NOW,
    log: () => {},
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length >= 2) agent.stop();     // 不 await，避免自等待
    }
  }, { intervalMs: 30000 });
  agent.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await agent.stop();
  assert.equal(delays[0], 5000, '第一次失败按退避');
  assert.equal(delays[1], 30000, '恢复后回到正常间隔');
  assert.ok(delays.length <= 3, '恢复后不得继续刷退避');
});

test('日志不泄露坐标（只记 valid/fixTime/csq）', async () => {
  const h = harness([{ ok: true, device: deviceWithFix() }]);
  await h.agent.pollOnce();
  const text = h.logs.join('\n');
  assert.ok(text.includes('gps.valid=true'), text);
  assert.ok(!text.includes('34.7466'), '日志不得含纬度');
  assert.ok(!text.includes('113.6254'), '日志不得含经度');
});

test('单实例锁：第二个代理被明确拒绝，退出后锁释放', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yed-lock-'));
  const lockPath = path.join(tmp, 'agent.lock');
  const first = createInstanceLock(lockPath);
  first.acquire();
  const second = createInstanceLock(lockPath);
  assert.throws(() => second.acquire(), /already running/);
  first.release();
  assert.equal(fs.existsSync(lockPath), false);
  const third = createInstanceLock(lockPath);
  third.acquire();
  third.release();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('陈旧锁文件可被回收', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yed-lock-'));
  const lockPath = path.join(tmp, 'agent.lock');
  fs.writeFileSync(lockPath, '999999999', 'utf8');
  const lock = createInstanceLock(lockPath);
  lock.acquire();
  assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));
  lock.release();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('publish 失败不抛出，只记录错误码', async () => {
  const agent = createLocationAgent({
    readDevice: async () => ({ ok: true, device: deviceNoFix() }),
    publish: async () => { throw Object.assign(new Error('mqtt down'), { code: 'PUBLISH_FAILED' }); },
    now: () => NOW,
    log: () => {}
  });
  const result = await agent.pollOnce();
  assert.equal(result.ok, true);
  assert.equal(agent.stats().lastError, 'PUBLISH_FAILED');
});
