'use strict';
/*
 * command-sync-scope.test.js — ACK 命令作用域白名单回归（2026-10-27）
 *
 * 事故背景：随身求助 esp32-sos 走 4G→ECS，不经过本机 Bridge/homemon。若 public-sync
 * 侧的 ACK 命令同步器也去领它的命令，会把命令发布到 home/esp32-sos/cmd（本机没有
 * 消费者），后端永远等不到 ACKED，演示时表现为"ACK 发了但设备没反应"。
 *
 * 本测试证明：
 *   1. 白名单内的房间设备（esp32-kitchen）行为完全不变：真实下发 + 观测 ACKED + 回写 202；
 *   2. 白名单外的设备（esp32-sos）与未知 deviceId 只推进游标，不下发、不回写，计数进 outOfScope；
 *   3. 不配置白名单时行为与旧版一致（全部处理）；
 *   4. 非法白名单在创建时 fail-closed；
 *   5. COMMAND_SYNC_ALLOWED_DEVICES 环境变量可覆盖；public-sync 默认白名单是三台房间设备。
 *
 * 全部依赖注入：假后端 + 假发布通道，不访问网络、不读真实密钥。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createCommandSync, createCommandSyncFromEnv, DEVICE_ID_RE } = require('./command-sync');
const { DEFAULT_LOCAL_DEVICE_IDS, resolveLocalDeviceIds } = require('./public-sync');

const INGEST_KEY = 'unit-test-ingest-key-not-a-real-secret';
const ALARM_ID = 'alarm-scope-1';
const ACTION = '监护人已确认';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('等待超时: ' + label);
    await sleep(5);
  }
}

/** 假后端：GET 返回 after 之后的 PENDING 命令；POST /result 记录并置 DONE。 */
function createFakeBackend(commands) {
  const state = { commands, results: [], done: new Set() };
  const httpRequest = (options, body, callback) => {
    if (options.method === 'GET') {
      const after = Number(new URL('http://x' + options.path).searchParams.get('after') || '0');
      const list = state.commands
        .filter((c) => Number(c.id) > after && !state.done.has(c.id))
        .map((c) => Object.assign({}, c));
      callback(null, { statusCode: 200, text: JSON.stringify({ commands: list }) });
      return;
    }
    const match = /\/commands\/([^/]+)\/result$/.exec(options.path);
    if (match) {
      state.results.push({ id: match[1], body: body ? JSON.parse(body.toString('utf8')) : null });
      state.done.add(match[1]);
      callback(null, { statusCode: 200, text: '{}' });
      return;
    }
    callback(null, { statusCode: 404, text: '{}' });
  };
  return { state, httpRequest };
}

function command(id, deviceId, alarmId = ALARM_ID) {
  return {
    id: String(id),
    createdAt: 1_700_000_000_000,
    requestedBy: 'wx-openid',
    deviceId,
    command: 'ACK',
    alarmId,
    action: ACTION,
    status: 'PENDING'
  };
}

function createHarness(options = {}) {
  const delivered = [];
  const lines = [];
  const events = [];
  let sync = null;
  const backend = createFakeBackend(options.commands || []);
  sync = createCommandSync(Object.assign({
    backendUrl: 'http://127.0.0.1:9',
    ingestKey: INGEST_KEY,
    httpRequest: backend.httpRequest,
    publishCommand: (deviceId, payload, topic) => {
      delivered.push({ deviceId, payload, topic });
      /* 模拟真实设备：命令下发后立刻产生 ACKED 状态（alarmId 精确匹配）。 */
      setTimeout(() => {
        sync.observe({ deviceId, state: 'ACKED', ts: Date.now(), alarm: { id: payload.alarmId } });
      }, 2);
      return true;
    },
    logger: {
      info: (line) => lines.push('info:' + line),
      warn: (line) => lines.push('warn:' + line),
      error: (line) => lines.push('error:' + line)
    },
    onEvent: (event) => events.push(event),
    ackTimeoutMs: 500,
    pollIntervalMs: 60000
  }, options.syncOptions || {}));
  return { sync, backend, delivered, lines, events };
}

test('白名单内设备行为不变，白名单外设备只推进游标', async () => {
  const harness = createHarness({
    commands: [
      command(1, 'esp32-sos', 'alarm-sos-1'),
      command(2, 'esp32-kitchen', 'alarm-kitchen-1'),
      command(3, 'esp32-unknown-9', 'alarm-x-1')
    ],
    syncOptions: { allowedDeviceIds: ['esp32-kitchen', 'esp32-bath', 'dayu200-living'] }
  });

  const result = await harness.sync.pollOnce();
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.equal(result.cursor, 3, '游标必须越过被跳过的命令，否则每轮重复拉取');
  assert.equal(harness.backend.state.results.length, 1, '只有白名单内设备会被回写');
  assert.equal(harness.backend.state.results[0].id, '2');
  assert.equal(harness.backend.state.results[0].body.status, 'ACKED');
  assert.equal(harness.delivered.length, 1, '只允许下发 1 条（esp32-kitchen）');
  assert.equal(harness.delivered[0].deviceId, 'esp32-kitchen');
  assert.equal(harness.delivered[0].topic, 'home/esp32-kitchen/cmd');
  assert.equal(harness.sync.stats().outOfScope, 2, 'esp32-sos + 未知设备各计一次 outOfScope');
  assert.ok(harness.lines.some((l) => l.indexOf('COMMAND_SKIPPED code=DEVICE_OUT_OF_SCOPE') >= 0));
  assert.ok(harness.events.some((e) => e.type === 'out-of-scope' && e.deviceId === 'esp32-sos'));
  /* 被跳过的命令不得出现在任何下行主题里 */
  assert.equal(harness.delivered.some((d) => d.deviceId === 'esp32-sos'), false);
});

test('不配置白名单时保持旧行为：全部命令照常处理', async () => {
  const harness = createHarness({
    commands: [command(1, 'esp32-sos', 'alarm-sos-2'), command(2, 'dayu200-room-1', 'alarm-room-1')]
  });
  const result = await harness.sync.pollOnce();
  assert.equal(result.ok, true);
  assert.equal(result.cursor, 2);
  assert.equal(harness.delivered.length, 2);
  assert.equal(harness.sync.stats().outOfScope, 0);
});

test('非法白名单 fail-closed；合法 deviceId 校验口径与协议一致', () => {
  assert.throws(() => createCommandSync({
    backendUrl: 'http://127.0.0.1:9',
    ingestKey: INGEST_KEY,
    allowedDeviceIds: []
  }), /allowedDeviceIds/);
  assert.throws(() => createCommandSync({
    backendUrl: 'http://127.0.0.1:9',
    ingestKey: INGEST_KEY,
    allowedDeviceIds: ['bad/id']
  }), /allowedDeviceIds/);
  assert.equal(DEVICE_ID_RE.test('esp32-sos'), true);
  assert.equal(DEVICE_ID_RE.test('bad/id'), false);
});

test('COMMAND_SYNC_ALLOWED_DEVICES 环境变量覆盖白名单', async () => {
  const envHarness = createHarness({
    commands: [command(1, 'esp32-sos', 'alarm-sos-3'), command(2, 'esp32-bath', 'alarm-bath-1')]
  });
  const fromEnv = createCommandSyncFromEnv({
    BACKEND_URL: 'http://127.0.0.1:9',
    BACKEND_INGEST_KEY: INGEST_KEY,
    COMMAND_SYNC_ALLOWED_DEVICES: 'esp32-kitchen,esp32-bath,dayu200-living'
  }, {
    httpRequest: envHarness.backend.httpRequest,
    publishCommand: (deviceId, payload, topic) => {
      envHarness.delivered.push({ deviceId, payload, topic });
      setTimeout(() => {
        fromEnv.observe({ deviceId, state: 'ACKED', ts: Date.now(), alarm: { id: payload.alarmId } });
      }, 2);
      return true;
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ackTimeoutMs: 500,
    pollIntervalMs: 60000
  });
  const result = await fromEnv.pollOnce();
  assert.equal(result.cursor, 2);
  assert.equal(envHarness.delivered.length, 1);
  assert.equal(envHarness.delivered[0].deviceId, 'esp32-bath');
  assert.equal(fromEnv.stats().outOfScope, 1);
});

test('public-sync 默认白名单是三台本机房间设备，且可用环境变量覆盖', () => {
  assert.deepEqual(DEFAULT_LOCAL_DEVICE_IDS.slice(), ['dayu200-living', 'esp32-kitchen', 'esp32-bath']);
  assert.deepEqual(resolveLocalDeviceIds({}), ['dayu200-living', 'esp32-kitchen', 'esp32-bath']);
  assert.deepEqual(
    resolveLocalDeviceIds({ COMMAND_SYNC_ALLOWED_DEVICES: ' esp32-kitchen , dayu200-living ' }),
    ['esp32-kitchen', 'dayu200-living']
  );
});
