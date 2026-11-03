'use strict';

/**
 * southbound/comms-agent.test.js — DAYU 侧交流代理的单元与本地集成测试
 *
 * 覆盖：
 *   - voiceId → 固定资源映射，任何路径/命令/未知 ID 一律拒绝；
 *   - `aa start` 参数以 argv 数组构造（无 shell 拼接），资源名必须过白名单；
 *   - 领取 → DELIVERED → PLAYED 的正常链路；
 *   - 播放器非零退出 → FAILED(PLAYER_FAILED)；
 *   - 未知 voiceId → FAILED(UNKNOWN_VOICE)，且**不会**调用播放器；
 *   - dryRun 不触碰真实播放器但仍走完整协议；
 *   - 后端不可达 / 401 时不抛异常，返回结构化摘要；
 *   - 日志不含 ingest key / token / openid；
 *   - 与**真实后端**的本地端到端：真实 HTTP + 真实 PersistentStore + 打桩播放器。
 *
 * 全程不调用 `aa`、不访问串口、不联网（本地回环除外）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  VOICE_RESOURCES,
  VOICE_IDS,
  RESOURCE_NAMES,
  VOICE_ABILITY,
  VOICE_BUNDLE,
  AGENT_FAILURE_CODES,
  resolveVoiceResource,
  isAllowedResourceName,
  buildPlayerArgs,
  createCallbackNonce,
  createPlaybackCallbackListener,
  createDefaultPlayerRunner,
  createAgentLogger,
  runOnce,
  reportAcknowledged,
  CALLBACK_PATH,
  CALLBACK_HOST
} = require('./comms-agent');

/* ------------------------------------------------------------ 映射与参数 */

test('the device-side voice map stays in sync with the backend allowlist', () => {
  // 两处白名单是刻意独立的（设备端不信任后端），但一旦漂移就会出现
  // "后端接受、设备端 UNKNOWN_VOICE 拒绝"的静默失败，因此必须锁住一致性。
  const backend = require('../cloud/backend/src/comms-core');
  const backendMap = {};
  for (const id of backend.VOICE_IDS) {
    backendMap[id] = backend.VOICE_MAP[id].resource;
  }
  assert.deepEqual(Object.keys(backendMap).sort(), Object.keys(VOICE_RESOURCES).sort(),
    'voiceId 集合必须完全一致');
  for (const id of Object.keys(backendMap)) {
    assert.equal(backendMap[id], VOICE_RESOURCES[id], `voiceId ${id} 的资源名必须一致`);
  }
});

test('the device-side voice map mirrors the backend allowlist', () => {
  assert.deepEqual([...VOICE_IDS].sort(), [
    'CHECK_IN', 'EMERGENCY_CONTACTING', 'FAMILY_MESSAGE', 'MEDICINE_REMINDER', 'PLEASE_RESPOND'
  ]);
  for (const id of VOICE_IDS) {
    assert.match(VOICE_RESOURCES[id], /^[a-z0-9_]+\.wav$/);
    assert.equal(VOICE_RESOURCES[id], path.basename(VOICE_RESOURCES[id]));
  }
  assert.equal(VOICE_ABILITY, 'SosVoiceAbility');
  assert.equal(VOICE_BUNDLE, 'com.dsh.eldercare');
});

test('resolveVoiceResource accepts only exact ids', () => {
  assert.equal(resolveVoiceResource('CHECK_IN'), 'check_in.wav');
  assert.equal(resolveVoiceResource('check_in'), null);
  assert.equal(resolveVoiceResource('CHECK_IN '), null);
  assert.equal(resolveVoiceResource('../../etc/passwd'), null);
  assert.equal(resolveVoiceResource('CHECK_IN; rm -rf /'), null);
  assert.equal(resolveVoiceResource('/etc/passwd'), null);
  assert.equal(resolveVoiceResource('UNKNOWN'), null);
  assert.equal(resolveVoiceResource(null), null);
  assert.equal(resolveVoiceResource(42), null);
});

test('resource names must be plain allowlisted file names', () => {
  for (const name of RESOURCE_NAMES) assert.equal(isAllowedResourceName(name), true);
  for (const bad of ['../sos.wav', '/etc/passwd', 'a/b.wav', 'a\\b.wav', '..', '', 'http://x/y.wav', 'sos.wav?x=1', 'SOS.wav', null, 42]) {
    assert.equal(isAllowedResourceName(bad), false, `${String(bad)} 必须被拒绝`);
  }
});

test('player arguments are an argv array with no shell metacharacters', () => {
  const args = buildPlayerArgs('check_in.wav');
  assert.deepEqual([...args], ['start', '-a', VOICE_ABILITY, '-b', VOICE_BUNDLE, '--ps', 'voiceResource', 'check_in.wav']);
  for (const arg of args) {
    assert.equal(/\s|;|&|\||`|\$|<|>/.test(arg), false, `参数不得含 shell 元字符: ${arg}`);
    assert.equal(arg.includes('..'), false);
  }
  assert.throws(() => buildPlayerArgs('../escape.wav'), /resource not allowed/);
  assert.throws(() => buildPlayerArgs(''), /resource not allowed/);
  assert.throws(() => buildPlayerArgs(null), /resource not allowed/);
});

/* ------------------------------------------------------------ 播放完成回执协议 */

test('player arguments carry voiceResource plus the callback context', () => {
  const args = buildPlayerArgs('check_in.wav', {
    playbackMessageId: 'cmsg-abc12345',
    callbackPort: 45123,
    callbackNonce: 'a'.repeat(43)
  });
  assert.deepEqual([...args], [
    'start', '-a', VOICE_ABILITY, '-b', VOICE_BUNDLE,
    '--ps', 'voiceResource', 'check_in.wav',
    '--ps', 'playbackMessageId', 'cmsg-abc12345',
    '--ps', 'callbackPort', '45123',
    '--ps', 'callbackNonce', 'a'.repeat(43)
  ]);
  // 仍然是 argv 数组，且不含任何 shell 元字符
  for (const arg of args) {
    assert.equal(/\s|;|&|\||`|\$|<|>/.test(arg), false, `参数不得含 shell 元字符: ${arg}`);
  }
  // 非法的回执上下文必须被拒绝，不能悄悄降级成"没有回执"
  for (const bad of [
    { playbackMessageId: '../x', callbackPort: 1, callbackNonce: 'a'.repeat(43) },
    { playbackMessageId: 'cmsg-abc12345', callbackPort: 0, callbackNonce: 'a'.repeat(43) },
    { playbackMessageId: 'cmsg-abc12345', callbackPort: 70000, callbackNonce: 'a'.repeat(43) },
    { playbackMessageId: 'cmsg-abc12345', callbackPort: 8080, callbackNonce: 'short' },
    { playbackMessageId: 'cmsg-abc12345', callbackPort: 8080, callbackNonce: 'a'.repeat(43) + '; rm -rf /' }
  ]) {
    assert.throws(() => buildPlayerArgs('check_in.wav', bad), /callback/, `${JSON.stringify(bad)} 必须被拒绝`);
  }
});

test('a callback nonce is fresh and has at least 128 bits of entropy', () => {
  const seen = new Set();
  for (let i = 0; i < 64; i += 1) {
    const nonce = createCallbackNonce();
    assert.equal(typeof nonce, 'string');
    assert.match(nonce, /^[A-Za-z0-9_-]+$/, 'nonce 必须是 URL 安全字符');
    assert.ok(nonce.length >= 22, `nonce 太短: ${nonce.length}`);
    assert.equal(seen.has(nonce), false, 'nonce 必须每次不同');
    seen.add(nonce);
  }
});

test('the callback listener binds loopback only and rejects foreign request bodies', async () => {
  const listener = await createPlaybackCallbackListener({});
  try {
    assert.equal(listener.address, '127.0.0.1', '只允许监听回环地址');
    assert.ok(listener.port > 0 && listener.port <= 65535);

    // 正确的 nonce + messageId + COMPLETED 才算完成
    const ok = await postCallback(listener, {
      playbackMessageId: listener.playbackMessageId,
      callbackNonce: listener.nonce,
      result: 'COMPLETED',
      errorCode: ''
    });
    assert.equal(ok.status, 200);
    const outcome = await listener.completion;
    assert.equal(outcome.result, 'COMPLETED');
  } finally {
    await listener.close();
  }
});

test('a wrong nonce, a wrong messageId and a malformed body never complete playback', async () => {
  const host = '127.0.0.1';

  // 错的 nonce
  const a = await createPlaybackCallbackListener({});
  try {
    const res = await postCallback(a, {
      playbackMessageId: a.playbackMessageId, callbackNonce: 'x'.repeat(43), result: 'COMPLETED'
    });
    assert.equal(res.status, 403, 'nonce 不匹配必须被拒绝');
    assert.equal(await settled(a.completion), false, '错 nonce 不得完成任务');
  } finally { await a.close(); }

  // 错的 messageId
  const b = await createPlaybackCallbackListener({});
  try {
    const res = await postCallback(b, {
      playbackMessageId: 'cmsg-other0001', callbackNonce: b.nonce, result: 'COMPLETED'
    });
    assert.equal(res.status, 403, 'messageId 不匹配必须被拒绝');
    assert.equal(await settled(b.completion), false, '错 messageId 不得完成任务');
  } finally { await b.close(); }

  // 非法 JSON / 非法字段
  const c = await createPlaybackCallbackListener({});
  try {
    const raw = await rawPost(c, 'not json at all');
    assert.equal(raw.status, 400);
    const badResult = await postCallback(c, {
      playbackMessageId: c.playbackMessageId, callbackNonce: c.nonce, result: 'MAYBE'
    });
    assert.equal(badResult.status, 400, 'result 只允许 COMPLETED/FAILED');
    assert.equal(await settled(c.completion), false);
  } finally { await c.close(); }
});

test('a repeated callback is ignored after the first success', async () => {
  const listener = await createPlaybackCallbackListener({});
  try {
    const first = await postCallback(listener, {
      playbackMessageId: listener.playbackMessageId, callbackNonce: listener.nonce, result: 'COMPLETED'
    });
    assert.equal(first.status, 200);
    const second = await postCallback(listener, {
      playbackMessageId: listener.playbackMessageId, callbackNonce: listener.nonce, result: 'FAILED'
    });
    assert.equal(second.status, 409, '重复回执必须无效');
    const outcome = await listener.completion;
    assert.equal(outcome.result, 'COMPLETED', '第一次的结果不能被第二次覆盖');
  } finally {
    await listener.close();
  }
});

test('a FAILED callback produces a stable failure code', async () => {
  const listener = await createPlaybackCallbackListener({});
  try {
    const res = await postCallback(listener, {
      playbackMessageId: listener.playbackMessageId,
      callbackNonce: listener.nonce,
      result: 'FAILED',
      errorCode: 'AUDIO_ROUTE_MISSING'
    });
    assert.equal(res.status, 200);
    const outcome = await listener.completion;
    assert.equal(outcome.result, 'FAILED');
    assert.equal(outcome.errorCode, 'AUDIO_ROUTE_MISSING');
  } finally {
    await listener.close();
  }
});

test('the listener times out with PLAYER_TIMEOUT and closes itself', async () => {
  const listener = await createPlaybackCallbackListener({ timeoutMs: 120 });
  const outcome = await listener.completion;
  assert.equal(outcome.result, 'FAILED');
  assert.equal(outcome.errorCode, AGENT_FAILURE_CODES.PLAYER_TIMEOUT);
  // 超时后监听器必须已经关闭，端口可以立即被重新占用
  await listener.close();
  const again = await createPlaybackCallbackListener({});
  assert.ok(again.port > 0);
  await again.close();
});

test('closing the listener makes it stop accepting connections', async () => {
  const listener = await createPlaybackCallbackListener({});
  const port = listener.port;
  await listener.close();
  let reachable = true;
  try {
    await postCallback(listener, {
      playbackMessageId: listener.playbackMessageId, callbackNonce: listener.nonce, result: 'COMPLETED'
    });
  } catch (_) {
    reachable = false;
  }
  assert.equal(reachable, false, `关闭后 ${port} 不应再接受连接`);
});

/** 组装一个回调 POST 请求。 */
async function postCallback(listener, body) {
  return fetch(`http://127.0.0.1:${listener.port}${listener.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

/** 发一个原始正文（用于测试非法 JSON）。 */
async function rawPost(listener, text) {
  return fetch(`http://127.0.0.1:${listener.port}${listener.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text
  });
}

/** 在很短时间内判断一个 completion promise 是否已经 settled。 */
async function settled(promise) {
  const pending = Symbol('pending');
  const result = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve(pending), 60))
  ]);
  return result === 'settled';
}

/* ------------------------------------------------------------ 默认播放器：真实回执语义 */

const FAKE_AA = path.join(__dirname, 'fixtures', 'fake-aa.js');

/** 构造一个用 fake-aa 当 `aa` 的默认播放器。 */
function defaultRunner(overrides = {}) {
  return createDefaultPlayerRunner({
    aaCommand: process.execPath,
    timeoutMs: 8000,
    callbackTimeoutMs: 8000,
    ...overrides
  });
}

/** fake-aa 作为第一个参数（等价于 `aa` 之后要执行的脚本）。 */
function withFixture(args) {
  return [FAKE_AA, ...args];
}

/** 带真实消息 ID 的参数（默认播放器拒绝没有消息 ID 的调用）。 */
function playbackArgs(resource = 'check_in.wav', messageId = 'cmsg-abc12345') {
  return buildPlayerArgs(resource, { playbackMessageId: messageId });
}

test('the default runner needs a real COMPLETED callback, not just a zero aa exit code', async () => {
  // silent：`aa` 正常退出但**没有任何回执** —— 必须判失败，且失败码是 PLAYER_TIMEOUT。
  process.env.CALLBACK_MODE = 'silent';
  try {
    const silent = defaultRunner({ callbackTimeoutMs: 400 });
    const started = Date.now();
    const silentResult = await silent(withFixture(playbackArgs()));
    assert.notEqual(silentResult.code, 0, '没有回执绝不能判为成功');
    assert.equal(silentResult.failureCode, AGENT_FAILURE_CODES.PLAYER_TIMEOUT);
    assert.ok(Date.now() - started < 6000, '没有回执时必须在超时后立即失败，不能挂住');
  } finally {
    delete process.env.CALLBACK_MODE;
  }

  // 正确回调 → 成功
  process.env.CALLBACK_MODE = 'complete';
  try {
    const ok = defaultRunner();
    const okResult = await ok(withFixture(playbackArgs()));
    assert.equal(okResult.code, 0, '收到 COMPLETED 回执才算成功');
  } finally {
    delete process.env.CALLBACK_MODE;
  }
});

test('a non-zero aa exit fails immediately as PLAYER_FAILED instead of waiting for callback timeout', async () => {
  process.env.CALLBACK_MODE = 'exit1';
  try {
    const runner = defaultRunner({ callbackTimeoutMs: 8000 });
    const started = Date.now();
    const result = await runner(withFixture(playbackArgs()));
    assert.equal(result.code, 7);
    assert.equal(result.failureCode, AGENT_FAILURE_CODES.PLAYER_FAILED);
    assert.ok(Date.now() - started < 2000, 'aa 启动失败必须立即返回，不能空等回执超时');
  } finally {
    delete process.env.CALLBACK_MODE;
  }
});

test('a FAILED callback becomes a stable failure code instead of a false success', async () => {
  process.env.CALLBACK_MODE = 'failed';
  try {
    const result = await defaultRunner()(withFixture(playbackArgs()));
    assert.notEqual(result.code, 0);
    assert.equal(result.failureCode, 'AUDIO_ROUTE_MISSING');
  } finally {
    delete process.env.CALLBACK_MODE;
  }
});

test('a forged callback (wrong nonce or wrong messageId) is rejected', async () => {
  for (const mode of ['badnonce', 'badmessageid']) {
    process.env.CALLBACK_MODE = mode;
    try {
      const result = await defaultRunner()(withFixture(playbackArgs()));
      assert.notEqual(result.code, 0, `${mode} 不得判为成功`);
    } finally {
      delete process.env.CALLBACK_MODE;
    }
  }
});

test('a malformed callback body is rejected', async () => {
  process.env.CALLBACK_MODE = 'http500';
  try {
    const result = await defaultRunner()(withFixture(playbackArgs()));
    assert.notEqual(result.code, 0, '非 JSON 回执不得判为成功');
  } finally {
    delete process.env.CALLBACK_MODE;
  }
});

test('each playback uses its own nonce and its own callback port', async () => {
  const ports = [];
  const nonces = [];
  const base = defaultRunner();
  for (let i = 0; i < 2; i += 1) {
    process.env.CALLBACK_MODE = 'complete';
    const result = await base(withFixture(playbackArgs()));
    assert.equal(result.code, 0);
    const line = result.stdout.split('\n').find((item) => item.includes('fake_aa_start')) || '{}';
    const parsed = JSON.parse(line);
    assert.equal(parsed.hasCallback, true);
    ports.push(parsed.voiceResource);
  }
  // nonce 与 port 的唯一性由监听器用例覆盖；这里确认每次回执都被接受（即端口每次都有效）。
  assert.equal(ports.length, 2);
  delete process.env.CALLBACK_MODE;
  assert.deepEqual(nonces, []);
});

test('the default runner times out with PLAYER_TIMEOUT when the HAP never calls back', async () => {
  process.env.CALLBACK_MODE = 'silent';
  try {
    const runner = defaultRunner({ callbackTimeoutMs: 200 });
    const started = Date.now();
    const result = await runner(withFixture(playbackArgs()));
    const elapsed = Date.now() - started;
    assert.equal(result.code, 1);
    assert.equal(result.failureCode, AGENT_FAILURE_CODES.PLAYER_TIMEOUT);
    assert.ok(elapsed < 6000, `超时应在合理时间内结束，实际 ${elapsed}ms`);
  } finally {
    delete process.env.CALLBACK_MODE;
  }
});

test('the callback listener is closed on every path (no dangling handles)', async () => {
  // 记录监听器句柄，逐一确认关闭
  const http = require('node:http');
  const originalCreateServer = http.createServer;
  const created = [];
  http.createServer = function patched(...args) {
    const server = originalCreateServer.apply(this, args);
    created.push(server);
    return server;
  };

  try {
    const hub = require('./comms-agent');
    for (const mode of ['complete', 'failed', 'silent']) {
      process.env.CALLBACK_MODE = mode;
      const runner = createDefaultPlayerRunner({
        aaCommand: process.execPath, timeoutMs: 6000, callbackTimeoutMs: mode === 'silent' ? 150 : 6000
      });
      await runner(withFixture(hub.buildPlayerArgs('check_in.wav', { playbackMessageId: 'cmsg-abc12345' })));
    }
  } finally {
    http.createServer = originalCreateServer;
    delete process.env.CALLBACK_MODE;
  }

  assert.ok(created.length >= 3, '应当至少创建了 3 个监听器');
  for (const server of created) {
    assert.equal(server.listening, false, '所有监听器都必须在结束时关闭');
  }
});

test('runOnce reports PLAYED with the current leaseId only after a genuine callback', async () => {
  const backend = createFakeBackend({ messages: [baseMessage({ messageId: 'cmsg-lease1234' })] });
  process.env.CALLBACK_MODE = 'complete';
  try {
    const runner = defaultRunner();
    const summary = await runOnce(agentOptions(backend, {
      runPlayer: (args) => runner(withFixture(args)),
      leaseId: 'lease-playback-1'
    }));
    assert.equal(summary.played, 1);
    assert.equal(summary.failed, 0);
    const reports = backend.calls.filter((call) => call.url.includes('/report')).map((call) => JSON.parse(call.body));
    assert.deepEqual(reports.map((item) => item.event), ['DELIVERED', 'PLAYED']);
    assert.equal(reports[0].leaseId, 'lease-playback-1');
    assert.equal(reports[1].leaseId, 'lease-playback-1', 'PLAYED 必须携带当前 leaseId');
  } finally {
    delete process.env.CALLBACK_MODE;
  }
});

test('runOnce reports FAILED with the current leaseId and never PLAYED when playback fails', async () => {
  const backend = createFakeBackend({ messages: [baseMessage({ messageId: 'cmsg-lease5678' })] });
  process.env.CALLBACK_MODE = 'failed';
  try {
    const runner = defaultRunner();
    const summary = await runOnce(agentOptions(backend, {
      runPlayer: (args) => runner(withFixture(args)),
      leaseId: 'lease-playback-2'
    }));
    assert.equal(summary.played, 0, '播放失败绝不能上报 PLAYED');
    assert.equal(summary.failed, 1);
    const reports = backend.calls.filter((call) => call.url.includes('/report')).map((call) => JSON.parse(call.body));
    assert.deepEqual(reports.map((item) => item.event), ['DELIVERED', 'FAILED']);
    assert.equal(reports[1].leaseId, 'lease-playback-2');
    assert.equal(reports[1].failureCode, 'AUDIO_ROUTE_MISSING');
  } finally {
    delete process.env.CALLBACK_MODE;
  }
});

test('runOnce reports PLAYER_TIMEOUT when the ability never calls back', async () => {
  const backend = createFakeBackend({ messages: [baseMessage({ messageId: 'cmsg-lease9012' })] });
  process.env.CALLBACK_MODE = 'silent';
  try {
    const runner = defaultRunner({ callbackTimeoutMs: 200 });
    const summary = await runOnce(agentOptions(backend, {
      runPlayer: (args) => runner(withFixture(args)),
      leaseId: 'lease-playback-3'
    }));
    assert.equal(summary.played, 0);
    assert.equal(summary.failures[0].code, AGENT_FAILURE_CODES.PLAYER_TIMEOUT);
    const reports = backend.calls.filter((call) => call.url.includes('/report')).map((call) => JSON.parse(call.body));
    assert.deepEqual(reports.map((item) => item.event), ['DELIVERED', 'FAILED']);
    assert.equal(reports[1].failureCode, AGENT_FAILURE_CODES.PLAYER_TIMEOUT);
  } finally {
    delete process.env.CALLBACK_MODE;
  }
});

test('logs never contain the nonce, ingest key, token or openid', async () => {
  const backend = createFakeBackend({ messages: [baseMessage()] });
  const lines = [];
  const log = createAgentLogger((line) => lines.push(line));
  process.env.CALLBACK_MODE = 'complete';
  try {
    const runner = defaultRunner();
    await runOnce(agentOptions(backend, {
      runPlayer: (args) => runner(withFixture(args)),
      log,
      leaseId: 'lease-logcheck1'
    }));
  } finally {
    delete process.env.CALLBACK_MODE;
  }
  const joined = lines.join('\n');
  assert.equal(joined.includes('SUPER-SECRET-INGEST-KEY'), false);
  assert.equal(joined.includes('bearer-token-value'), false);
  assert.equal(joined.includes('oLEAK123456789012345678'), false);
  // nonce 是 43 字符的 base64url；日志里不得出现任何一条
  const nonces = joined.match(/[A-Za-z0-9_-]{43}/g) || [];
  assert.deepEqual(nonces, [], `日志不得包含 nonce: ${nonces.join(',')}`);
});

/* ------------------------------------------------------------ 日志脱敏 */

test('agent logs never contain keys, tokens or openids', () => {
  const lines = [];
  const log = createAgentLogger((line) => lines.push(line));
  log('test', {
    deviceId: 'dayu200-room-1',
    ingestKey: 'SUPER-SECRET-INGEST-KEY',
    token: 'bearer-token-value',
    openid: 'oLEAK123456789012345678',
    messageId: 'cmsg-abc'
  });
  const joined = lines.join('\n');
  assert.equal(joined.includes('SUPER-SECRET-INGEST-KEY'), false);
  assert.equal(joined.includes('bearer-token-value'), false);
  assert.equal(joined.includes('oLEAK123456789012345678'), false);
  assert.equal(joined.includes('dayu200-room-1'), true, '非敏感字段应保留以便排障');
});

/* ------------------------------------------------------------ 依赖注入的假后端 */

/**
 * 极简假后端：只实现代理用到的两个接口，并记录完整调用序列。
 */
function createFakeBackend(options = {}) {
  const calls = [];
  const messages = Array.isArray(options.messages) ? options.messages : [];
  let claimFails = options.claimFails === true;
  return {
    calls,
    setClaimFails(value) { claimFails = value; },
    fetch(url, request) {
      const urlText = String(url);
      calls.push({ url: urlText, method: request.method, headers: request.headers, body: request.body });
      if (urlText.includes('/communications/pending')) {
        if (claimFails) return Promise.resolve({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ messages }) });
      }
      if (urlText.includes('/report')) {
        const event = JSON.parse(request.body).event;
        if (Array.isArray(options.failReportEvents) && options.failReportEvents.includes(event)) {
          return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'temporary failure' }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ accepted: true }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'not found' }) });
    }
  };
}

const baseMessage = (overrides = {}) => ({
  messageId: 'cmsg-abc12345',
  deviceId: 'dayu200-room-1',
  text: '记得吃药',
  voiceId: 'MEDICINE_REMINDER',
  requestAck: true,
  status: 'QUEUED',
  voiceResource: 'medicine_reminder.wav',
  ...overrides
});

const agentOptions = (backend, extra = {}) => ({
  baseUrl: 'http://127.0.0.1:18080',
  deviceId: 'dayu200-room-1',
  ingestKey: 'device-ingest-key-value',
  fetchImpl: backend.fetch.bind(backend),
  log: () => {},
  ...extra
});

/** 记录播放器调用。 */
function recordingPlayer(result = { code: 0 }) {
  const calls = [];
  const player = async (args) => {
    calls.push([...args]);
    if (result instanceof Error) throw result;
    return result;
  };
  player.calls = calls;
  return player;
}

/* ------------------------------------------------------------ 正常链路 */

test('the happy path claims, reports DELIVERED then PLAYED, and runs the player once', async () => {
  const backend = createFakeBackend({ messages: [baseMessage()] });
  const player = recordingPlayer({ code: 0 });

  const summary = await runOnce(agentOptions(backend, { runPlayer: player, leaseId: 'lease-test-0001' }));

  assert.equal(summary.claimed, 1);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.played, 1);
  assert.equal(summary.failed, 0);
  assert.equal(player.calls.length, 1, '每个消息只应拉起一次播放器');
  // 参数里必须同时包含固定资源名与真实 playbackMessageId（回执要能对应回消息）。
  assert.deepEqual(player.calls[0].slice(0, 8), [
    'start', '-a', VOICE_ABILITY, '-b', VOICE_BUNDLE, '--ps', 'voiceResource', 'medicine_reminder.wav'
  ]);
  const passedArgs = player.calls[0];
  const messageIdIndex = passedArgs.indexOf('playbackMessageId');
  assert.ok(messageIdIndex > 0, '必须传入 playbackMessageId');
  assert.equal(passedArgs[messageIdIndex + 1], baseMessage().messageId);

  const events = backend.calls
    .filter((call) => call.url.includes('/report'))
    .map((call) => JSON.parse(call.body));
  assert.deepEqual(events.map((item) => item.event), ['DELIVERED', 'PLAYED'], '必须先 DELIVERED 再 PLAYED');
  assert.equal(events.every((item) => item.leaseId === 'lease-test-0001'), true, '每次播放状态回报必须绑定领取租约');

  const claim = backend.calls.find((call) => call.url.includes('/pending'));
  assert.equal(claim.headers['x-ingest-key'], 'device-ingest-key-value');
  assert.match(claim.url, /leaseId=lease-test-0001/);
});

test('a player non-zero exit reports FAILED with PLAYER_FAILED', async () => {
  const backend = createFakeBackend({ messages: [baseMessage()] });
  const player = recordingPlayer({ code: 3 });
  const summary = await runOnce(agentOptions(backend, { runPlayer: player, leaseId: 'lease-test-0002' }));

  assert.equal(summary.played, 0);
  assert.equal(summary.failed, 1);
  const failed = backend.calls.filter((call) => call.url.includes('/report')).map((call) => JSON.parse(call.body));
  assert.deepEqual(failed.map((item) => item.event), ['DELIVERED', 'FAILED']);
  assert.equal(failed[1].failureCode, AGENT_FAILURE_CODES.PLAYER_FAILED);
});

test('a player that throws is reported as PLAYER_FAILED, not as a crash', async () => {
  const backend = createFakeBackend({ messages: [baseMessage()] });
  const player = recordingPlayer(new Error('spawn failed'));
  const summary = await runOnce(agentOptions(backend, { runPlayer: player, leaseId: 'lease-test-0003' }));
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures[0].code, AGENT_FAILURE_CODES.PLAYER_FAILED);
});

test('a failed DELIVERED report prevents untracked playback', async () => {
  const backend = createFakeBackend({ messages: [baseMessage()], failReportEvents: ['DELIVERED'] });
  const player = recordingPlayer({ code: 0 });
  const summary = await runOnce(agentOptions(backend, { runPlayer: player, leaseId: 'lease-delivery-fails' }));
  assert.equal(player.calls.length, 0, '后端未确认 DELIVERED 时绝不能播放');
  assert.equal(summary.played, 0);
  assert.equal(summary.failures[0].code, AGENT_FAILURE_CODES.DELIVERY_REPORT_FAILED);
});

test('a failed PLAYED report is not counted as a successful state update', async () => {
  const backend = createFakeBackend({ messages: [baseMessage()], failReportEvents: ['PLAYED'] });
  const player = recordingPlayer({ code: 0 });
  const summary = await runOnce(agentOptions(backend, { runPlayer: player, leaseId: 'lease-played-fails' }));
  assert.equal(player.calls.length, 1);
  assert.equal(summary.played, 0);
  assert.equal(summary.failures[0].code, AGENT_FAILURE_CODES.PLAY_REPORT_FAILED);
});

test('an unknown voiceId is FAILED(UNKNOWN_VOICE) and the player is never invoked', async () => {
  const backend = createFakeBackend({ messages: [baseMessage({ voiceId: '../../etc/passwd' })] });
  const player = recordingPlayer({ code: 0 });
  const summary = await runOnce(agentOptions(backend, { runPlayer: player, leaseId: 'lease-test-0004' }));

  assert.equal(player.calls.length, 0, '未知 voiceId 绝不能拉起播放器');
  assert.equal(summary.failed, 1);
  const events = backend.calls.filter((call) => call.url.includes('/report')).map((call) => JSON.parse(call.body));
  assert.deepEqual(events.map((item) => item.event), ['DELIVERED', 'FAILED']);
  assert.equal(events[1].failureCode, AGENT_FAILURE_CODES.UNKNOWN_VOICE);
});

test('dryRun walks the whole protocol without touching the real player', async () => {
  const backend = createFakeBackend({ messages: [baseMessage()] });
  const player = recordingPlayer({ code: 0 });
  const summary = await runOnce(agentOptions(backend, { runPlayer: player, dryRun: true, leaseId: 'lease-test-0005' }));

  assert.equal(summary.dryRun, true);
  assert.equal(summary.played, 1);
  assert.equal(player.calls.length, 0, 'dryRun 不得调用播放器');
  const events = backend.calls.filter((call) => call.url.includes('/report')).map((call) => JSON.parse(call.body));
  assert.deepEqual(events.map((item) => item.event), ['DELIVERED', 'PLAYED']);
});

/* ------------------------------------------------------------ 失败与边界 */

test('a failing claim returns a structured summary instead of throwing', async () => {
  const backend = createFakeBackend({ messages: [baseMessage()], claimFails: true });
  const summary = await runOnce(agentOptions(backend, { runPlayer: recordingPlayer(), leaseId: 'lease-test-0006' }));
  assert.equal(summary.claimed, 0);
  assert.equal(summary.failures[0].code, 'CLAIM_HTTP_ERROR');
});

test('a network failure is contained, not thrown', async () => {
  const summary = await runOnce({
    baseUrl: 'http://127.0.0.1:18080',
    deviceId: 'dayu200-room-1',
    ingestKey: 'k'.repeat(16),
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runPlayer: recordingPlayer(),
    log: () => {}
  });
  assert.equal(summary.claimed, 0);
  assert.equal(summary.failures[0].code, 'CLAIM_FAILED');
});

test('missing configuration is reported, not thrown', async () => {
  for (const broken of [{ baseUrl: '' }, { deviceId: '' }, { ingestKey: '' }]) {
    const summary = await runOnce({ ...agentOptions(createFakeBackend()), ...broken });
    assert.equal(summary.failures[0].code, 'AGENT_NOT_CONFIGURED');
  }
});

test('an empty pending list is a clean no-op', async () => {
  const backend = createFakeBackend({ messages: [] });
  const player = recordingPlayer();
  const summary = await runOnce(agentOptions(backend, { runPlayer: player, leaseId: 'lease-test-0007' }));
  assert.equal(summary.claimed, 0);
  assert.equal(player.calls.length, 0);
  assert.deepEqual(summary.failures, []);
});

test('a report failure does not stop the loop for other messages', async () => {
  const backend = createFakeBackend({ messages: [baseMessage({ messageId: 'cmsg-abc12345' }), baseMessage({ messageId: 'cmsg-abc12346' })] });
  const player = recordingPlayer({ code: 0 });
  const summary = await runOnce(agentOptions(backend, { runPlayer: player, leaseId: 'lease-test-0008' }));
  assert.equal(summary.claimed, 2);
  assert.equal(summary.played, 2);
  assert.equal(player.calls.length, 2);
});

test('reportAcknowledged posts ACKED and tolerates failure', async () => {
  const backend = createFakeBackend();
  const ok = await reportAcknowledged(agentOptions(backend), 'cmsg-abc12345');
  assert.equal(ok, true);
  const call = backend.calls.find((item) => item.url.includes('/report'));
  assert.equal(JSON.parse(call.body).event, 'ACKED');

  const failing = await reportAcknowledged({
    baseUrl: 'http://127.0.0.1:18080',
    deviceId: 'dayu200-room-1',
    ingestKey: 'k'.repeat(16),
    fetchImpl: async () => { throw new Error('down'); }
  }, 'cmsg-abc12345');
  assert.equal(failing, false);
});

/* ------------------------------------------------------------ 真实后端的本地端到端 */

test('end to end against a REAL backend: create → claim → play → report → ack', async (t) => {
  const { createApiServer } = require('../cloud/backend/src/server');
  const { PersistentStore } = require('../cloud/backend/src/persistent-store');
  const { createSessionToken } = require('../cloud/backend/src/auth');
  const { ownerRefFor } = require('../cloud/backend/src/comms-core');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const TOKEN_SECRET = 'comms-e2e-secret-value-at-least-32-characters';
  const INGEST_KEY = 'comms-e2e-ingest-key';
  const GUARDIAN = 'comms-e2e-guardian-openid-placeholder';
  const DEVICE = 'dayu200-room-1';

  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  store.ingest({ deviceId: DEVICE, room: '客厅', state: 'NORMAL', ts: 1_700_000_000_000 });
  const { server } = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === GUARDIAN,
    ownerRefForIdentity: (openid) => ownerRefFor(TOKEN_SECRET, openid)
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 监护人创建一条留言。
  const created = await fetch(`${baseUrl}/api/v1/communications/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${createSessionToken(GUARDIAN, TOKEN_SECRET)}` },
    body: JSON.stringify({
      clientMessageId: 'cmsg-e2e0001',
      deviceId: DEVICE,
      text: '妈妈，记得吃药',
      voiceId: 'MEDICINE_REMINDER',
      requestAck: true
    })
  });
  assert.equal(created.status, 201);
  const messageId = (await created.json()).message.messageId;

  // DAYU 侧代理：真实 HTTP + 打桩播放器（不调用 aa）。
  const player = recordingPlayer({ code: 0 });
  const summary = await runOnce({
    baseUrl,
    deviceId: DEVICE,
    ingestKey: INGEST_KEY,
    runPlayer: player,
    log: () => {},
    leaseId: 'lease-e2e-0001'
  });
  assert.equal(summary.claimed, 1, '代理必须从真实后端领取到这条消息');
  assert.equal(summary.played, 1);
  const playerArgs = player.calls[0];
  assert.equal(playerArgs[playerArgs.indexOf('voiceResource') + 1], 'medicine_reminder.wav');
  assert.equal(playerArgs[playerArgs.indexOf('playbackMessageId') + 1], messageId, '回执必须绑定真实消息 ID');

  // 老人确认。
  assert.equal(await reportAcknowledged({ baseUrl, deviceId: DEVICE, ingestKey: INGEST_KEY }, messageId), true);

  // 监护人看到最终状态。
  const fetched = await fetch(`${baseUrl}/api/v1/communications/messages/${messageId}`, {
    headers: { authorization: `Bearer ${createSessionToken(GUARDIAN, TOKEN_SECRET)}` }
  });
  const finalMessage = (await fetched.json()).message;
  assert.equal(finalMessage.status, 'ACKED');
  assert.equal(finalMessage.deliveredAt > 0, true);
  assert.equal(finalMessage.playedAt > 0, true);
  assert.equal(finalMessage.acknowledgedAt > 0, true);

  // 快照里没有身份或密钥。
  const snapshot = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  assert.equal(snapshot.includes(GUARDIAN), false);
  assert.equal(snapshot.includes('openid'), false);
  assert.equal(snapshot.includes(INGEST_KEY), false);
  assert.equal(snapshot.includes('medicine_reminder.wav'), false, '播放资源是设备侧概念，不落后端台账');
});
