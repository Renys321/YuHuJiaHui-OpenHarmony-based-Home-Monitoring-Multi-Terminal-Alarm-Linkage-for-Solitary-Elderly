'use strict';

/**
 * command-sync.test.js — 边缘 ACK 命令同步器单元测试
 *
 * 测试边界（与 docs/AI-COLLAB.md 共享契约 v1 对齐）：
 *   轮询、严格校验、精确定向 MQTT、等待真实回执、超时失败、重复命令不重复下发。
 *
 * 所有外部依赖都是注入的假实现：不访问真实后端、不连接真实 Broker、不读任何真实密钥。
 * 假后端刻意复刻 `cloud/backend/src/store.js` 的 completeCommand 语义（含幂等与绑定校验），
 * 以便在无网络环境下验证边缘侧发出的请求确实能被真实后端接受。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCommandSync,
  createCommandSyncFromEnv,
  validateCommand,
  buildCommandPayload,
  isSafeAction,
  DEFAULT_BACKEND_URL,
  DEFAULT_ACK_TIMEOUT_MS
} = require('./command-sync');

const INGEST_KEY = 'unit-test-ingest-key-not-a-real-secret';
const DEVICE_ID = 'dayu200-room-1';
const ALARM_ID = 'alarm-001';
const ACTION = '监护人已确认';
const RESULT_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;

/** 等待条件成立；用真实时钟兜底，避免 setImmediate 空转早于定时器触发。 */
async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  } while (Date.now() < deadline);
  if (predicate()) return;
  throw new Error(`waitFor timed out: ${label}`);
}

function statusPayload(overrides = {}) {
  return Object.assign({
    deviceId: DEVICE_ID,
    room: '客厅',
    online: true,
    state: 'ACKED',
    ts: 1_700_000_000_000,
    alarm: { id: ALARM_ID }
  }, overrides);
}

function createLogger() {
  const lines = [];
  const record = (level) => (line) => { lines.push(`${level}:${line}`); };
  return { info: record('info'), warn: record('warn'), error: record('error'), lines };
}

/**
 * 可控假后端：实现 GET /internal/v1/commands 与 POST /internal/v1/commands/<id>/result。
 * 返回的 httpRequest 直接作为同步器的注入点。
 */
function createFakeBackend(options = {}) {
  const ingestKey = options.ingestKey === undefined ? INGEST_KEY : options.ingestKey;
  const commands = [];
  const requests = [];
  const results = [];
  const rejected = [];
  let autoId = 1;

  function addCommand(overrides = {}) {
    const command = Object.assign({
      id: String(autoId++),
      createdAt: 1_700_000_000_000,
      requestedBy: 'wx-openid',
      deviceId: DEVICE_ID,
      command: 'ACK',
      alarmId: ALARM_ID,
      action: ACTION,
      status: 'PENDING'
    }, overrides);
    commands.push(command);
    return command;
  }

  // keepPending=true 时只校验并记录，不改变命令状态：用于单独验证边缘侧内存台账的幂等。
  const mark = (command, status) => {
    if (!options.keepPending) command.status = status;
  };

  function complete(id, body) {
    const command = commands.find((item) => item.id === id);
    if (!command) return 404;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 400;
    if (body.status !== 'ACKED' && body.status !== 'FAILED') return 400;
    if (command.status !== 'PENDING') {
      if (command.status !== body.status) return 409;
      return 200; // 幂等：重复同状态回写直接接受
    }
    if (body.status === 'FAILED') {
      if (typeof body.code !== 'string' || !RESULT_CODE_RE.test(body.code)) return 400;
      mark(command, 'FAILED');
      return 200;
    }
    const state = body.deviceState;
    if (!state || state.deviceId !== command.deviceId || state.state !== 'ACKED' ||
        !state.alarm || state.alarm.id !== command.alarmId) {
      return 409; // 设备回执与命令绑定不匹配
    }
    mark(command, 'ACKED');
    return 200;
  }

  function httpRequest(requestOptions, body, callback) {
    const method = requestOptions.method;
    const path = requestOptions.path;
    const headers = requestOptions.headers || {};
    let parsedBody = null;
    if (body !== undefined && body !== null) {
      try { parsedBody = JSON.parse(body.toString('utf8')); } catch { parsedBody = null; }
    }
    const entry = { method, path, headers, body: parsedBody };
    requests.push(entry);

    setImmediate(() => {
      if (typeof options.respond === 'function') {
        const custom = options.respond(entry, { commands, results });
        if (custom && custom.error) return callback(custom.error, null);
        if (custom) {
          return callback(null, {
            statusCode: custom.statusCode,
            text: custom.text === undefined ? '' : custom.text
          });
        }
      }
      if (!headers['x-ingest-key'] || headers['x-ingest-key'] !== ingestKey) {
        return callback(null, { statusCode: 401, text: JSON.stringify({ error: 'unauthorized' }) });
      }
      if (method === 'GET') {
        const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
        const after = Number.parseInt(new URLSearchParams(query).get('after') || '0', 10);
        const listed = options.alwaysReturnAll
          ? commands.slice()
          : commands.filter((item) => Number(item.id) > after);
        return callback(null, { statusCode: 200, text: JSON.stringify({ commands: listed }) });
      }
      const match = /^\/internal\/v1\/commands\/([^/]+)\/result$/.exec(path);
      if (!match) return callback(null, { statusCode: 404, text: JSON.stringify({ error: 'not found' }) });
      const id = decodeURIComponent(match[1]);
      const statusCode = complete(id, parsedBody);
      if (statusCode !== 200) {
        rejected.push({ id, statusCode, body: parsedBody });
        return callback(null, { statusCode, text: JSON.stringify({ error: 'rejected' }) });
      }
      results.push({ id, body: parsedBody });
      return callback(null, { statusCode: 200, text: JSON.stringify({ accepted: true, commandId: id }) });
    });
  }

  return { commands, requests, results, rejected, addCommand, httpRequest };
}

function createSync(backend, overrides = {}) {
  return createCommandSync(Object.assign({
    backendUrl: 'http://127.0.0.1:8080',
    ingestKey: INGEST_KEY,
    httpRequest: backend.httpRequest
  }, overrides));
}

function listRequests(backend) {
  return backend.requests.filter((item) => item.method === 'GET');
}

/* ------------------------------------------------------------ 公共接口与选项 */

test('exposes the shared contract surface with safe defaults', () => {
  assert.equal(typeof createCommandSync, 'function');
  assert.equal(typeof createCommandSyncFromEnv, 'function');
  assert.equal(DEFAULT_BACKEND_URL, 'http://127.0.0.1:8080');
  assert.equal(DEFAULT_ACK_TIMEOUT_MS, 8000);

  const sync = createCommandSync({});
  assert.equal(sync.enabled, false);
  assert.equal(sync.endpoint, 'http://127.0.0.1:8080/internal/v1/commands');
  assert.equal(sync.cursor(), 0);
  assert.equal(Object.isFrozen(sync), true);
});

test('rejects unsafe or malformed options', () => {
  assert.throws(() => createCommandSync(null), /plain object/);
  assert.throws(() => createCommandSync({ backendUrl: 'ftp://backend' }), /http or https/);
  assert.throws(() => createCommandSync({ backendUrl: 'http://user:pass@backend' }), /credentials/);
  assert.throws(() => createCommandSync({ backendUrl: 'http://backend/?after=1' }), /query or fragment/);
  assert.throws(() => createCommandSync({ backendUrl: 'not a url' }), /valid absolute URL/);
  assert.throws(() => createCommandSync({ httpRequest: 42 }), /httpRequest/);
  assert.throws(() => createCommandSync({ mqttClient: {} }), /mqttClient/);
  assert.throws(() => createCommandSync({ publisher: 7 }), /publisher/);
  assert.throws(() => createCommandSync({ publishCommand: 'nope' }), /publishCommand/);
  assert.throws(() => createCommandSync({ timeoutMs: 10 }), /timeoutMs/);
  assert.throws(() => createCommandSync({ ackTimeoutMs: 10 }), /ackTimeoutMs/);
  assert.throws(() => createCommandSync({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createCommandSync({ pollIntervalMs: 1 }), /pollIntervalMs/);
  assert.throws(() => createCommandSync({ now: 1 }), /now/);
});

test('creates a disabled client from empty env and reads configured env', () => {
  const disabled = createCommandSyncFromEnv({}, { httpRequest: () => {} });
  assert.equal(disabled.enabled, false);

  const configured = createCommandSyncFromEnv({
    BACKEND_URL: 'http://10.0.0.5:9000',
    BACKEND_INGEST_KEY: INGEST_KEY,
    BACKEND_TIMEOUT_MS: '2500'
  }, { httpRequest: () => {} });
  assert.equal(configured.enabled, true);
  assert.equal(configured.endpoint, 'http://10.0.0.5:9000/internal/v1/commands');
});

/* ------------------------------------------------------------ 严格校验 */

test('accepts a fully valid ACK command and trims the action', () => {
  const checked = validateCommand({
    id: '12', command: 'ACK', deviceId: DEVICE_ID, alarmId: ALARM_ID,
    action: `  ${ACTION}  `, status: 'PENDING'
  });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.command, { id: '12', deviceId: DEVICE_ID, alarmId: ALARM_ID, action: ACTION });
  assert.equal(Object.isFrozen(checked.command), true);
});

test('rejects every incomplete, unsupported or already-completed command', () => {
  const base = { id: '1', command: 'ACK', deviceId: DEVICE_ID, alarmId: ALARM_ID, action: ACTION };
  const cases = [
    [null, 'INVALID_COMMAND_SHAPE'],
    [[], 'INVALID_COMMAND_SHAPE'],
    ['ACK', 'INVALID_COMMAND_SHAPE'],
    [{ ...base, id: '0' }, 'INVALID_COMMAND_ID'],
    [{ ...base, id: 'abc' }, 'INVALID_COMMAND_ID'],
    [{ ...base, id: 1 }, 'INVALID_COMMAND_ID'],
    [{ ...base, command: 'RESET' }, 'UNSUPPORTED_COMMAND'],
    [{ ...base, command: 'ack' }, 'UNSUPPORTED_COMMAND'],
    [{ ...base, deviceId: '' }, 'INVALID_DEVICE_ID'],
    [{ ...base, deviceId: '../etc' }, 'INVALID_DEVICE_ID'],
    [{ ...base, deviceId: 'a/b' }, 'INVALID_DEVICE_ID'],
    [{ ...base, alarmId: '' }, 'INVALID_ALARM_ID'],
    [{ ...base, alarmId: 'a b' }, 'INVALID_ALARM_ID'],
    [{ ...base, alarmId: 'a\r\nb' }, 'INVALID_ALARM_ID'],
    [{ ...base, action: '' }, 'INVALID_ACTION'],
    [{ ...base, action: '   ' }, 'INVALID_ACTION'],
    [{ ...base, action: 'x'.repeat(121) }, 'INVALID_ACTION'],
    [{ ...base, action: 'line1\r\nline2' }, 'INVALID_ACTION'],
    [{ ...base, action: 'nul\u0000byte' }, 'INVALID_ACTION'],
    [{ ...base, action: 5 }, 'INVALID_ACTION'],
    [{ ...base, status: 'ACKED' }, 'COMMAND_NOT_PENDING'],
    [{ ...base, status: 'FAILED' }, 'COMMAND_NOT_PENDING']
  ];
  for (const [raw, code] of cases) {
    const checked = validateCommand(raw);
    assert.equal(checked.ok, false, `expected rejection for ${JSON.stringify(raw)}`);
    assert.equal(checked.code, code, `unexpected code for ${JSON.stringify(raw)}`);
  }
});

test('isSafeAction allows Chinese text but rejects control characters', () => {
  assert.equal(isSafeAction(ACTION), true);
  assert.equal(isSafeAction('  ok  '), true);
  assert.equal(isSafeAction('a\nb'), false);
  assert.equal(isSafeAction('\u0007bell'), false);
  assert.equal(isSafeAction('   '), false);
  assert.equal(isSafeAction('x'.repeat(121)), false);
  assert.equal(isSafeAction(undefined), false);
});

test('builds the exact downlink payload used by the local bridge', () => {
  assert.deepEqual(buildCommandPayload({ alarmId: ALARM_ID, action: ACTION }), {
    cmd: 'ack',
    alarmId: ALARM_ID,
    action: ACTION
  });
});

/* ------------------------------------------------------------ 轮询与定向下发 */

test('stays disabled and never touches the network without an ingest key', async () => {
  const backend = createFakeBackend();
  const sync = createCommandSync({
    backendUrl: 'http://127.0.0.1:8080',
    httpRequest: backend.httpRequest
  });
  assert.equal(sync.enabled, false);
  assert.deepEqual(await sync.pollOnce(), { ok: false, code: 'SYNC_DISABLED' });
  assert.equal(backend.requests.length, 0);
});

test('polls with the ingest key, publishes directly, waits for a real receipt, then reports ACKED', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '7' });
  const published = [];
  const logger = createLogger();
  const sync = createSync(backend, {
    publishCommand: (deviceId, payload, topic, message) => {
      published.push({ deviceId, payload, topic, message });
      return true;
    },
    logger
  });

  const poll = sync.pollOnce();
  await waitFor(() => published.length === 1, 'downlink publish');

  // 关键语义：发布之后绝不允许立即伪造成功，必须等到真实状态。
  assert.equal(backend.results.length, 0);
  assert.equal(sync.waiters(), 1);

  sync.observe(statusPayload({ monitorOnline: 0 }));
  const outcome = await poll;

  assert.equal(outcome.ok, true);
  assert.equal(outcome.processed, 1);
  assert.equal(outcome.cursor, 7);

  assert.deepEqual(published[0], {
    deviceId: DEVICE_ID,
    topic: `home/${DEVICE_ID}/cmd`,
    payload: { cmd: 'ack', alarmId: ALARM_ID, action: ACTION },
    message: JSON.stringify({ cmd: 'ack', alarmId: ALARM_ID, action: ACTION })
  });

  const listRequest = listRequests(backend)[0];
  assert.equal(listRequest.path, '/internal/v1/commands?after=0');
  assert.equal(listRequest.headers['x-ingest-key'], INGEST_KEY);
  assert.equal(listRequest.headers['content-type'], undefined);

  assert.equal(backend.results.length, 1);
  assert.equal(backend.results[0].id, '7');
  assert.equal(backend.results[0].body.status, 'ACKED');
  assert.equal(backend.results[0].body.deviceState.deviceId, DEVICE_ID);
  assert.equal(backend.results[0].body.deviceState.state, 'ACKED');
  assert.equal(backend.results[0].body.deviceState.alarm.id, ALARM_ID);
  assert.equal(backend.results[0].body.deviceState.monitorOnline, 0);

  const resultRequest = backend.requests.find((item) => item.method === 'POST');
  assert.equal(resultRequest.path, '/internal/v1/commands/7/result');
  assert.equal(resultRequest.headers['content-type'], 'application/json');
  assert.equal(resultRequest.headers['x-ingest-key'], INGEST_KEY);

  // 密钥绝不落日志。
  assert.equal(logger.lines.some((line) => line.includes(INGEST_KEY)), false);
});

test('supports an injected MQTT client with QoS 1 and retain disabled', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '21' });
  const calls = [];
  const mqttClient = {
    publish(topic, message, opts, callback) {
      calls.push({ topic, message, opts });
      setImmediate(() => callback(null));
    }
  };
  const sync = createSync(backend, { mqttClient });

  const poll = sync.pollOnce();
  await waitFor(() => calls.length === 1, 'mqtt publish');
  sync.observe(statusPayload());
  const outcome = await poll;

  assert.equal(outcome.processed, 1);
  assert.equal(calls[0].topic, `home/${DEVICE_ID}/cmd`);
  assert.deepEqual(calls[0].opts, { qos: 1, retain: false });
  assert.deepEqual(JSON.parse(calls[0].message), { cmd: 'ack', alarmId: ALARM_ID, action: ACTION });
});

test('supports the promise publisher injection point', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '22' });
  const calls = [];
  const sync = createSync(backend, {
    publisher: async (topic, payload) => {
      calls.push({ topic, payload });
      return true;
    }
  });

  const poll = sync.pollOnce();
  await waitFor(() => calls.length === 1, 'publisher call');
  sync.observe(statusPayload());
  const outcome = await poll;

  assert.equal(outcome.processed, 1);
  assert.equal(calls[0].topic, `home/${DEVICE_ID}/cmd`);
  assert.deepEqual(calls[0].payload, { cmd: 'ack', alarmId: ALARM_ID, action: ACTION });
  assert.equal(backend.results[0].body.status, 'ACKED');
});

test('awaits an asynchronous publishCommand result instead of treating the Promise as success', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '23' });
  let resolved = false;
  const sync = createSync(backend, {
    publishCommand: () => new Promise((resolve) => {
      setImmediate(() => {
        resolved = true;
        resolve(false);
      });
    }),
    maxAttempts: 1,
    retryBackoffMs: 0
  });

  const outcome = await sync.pollOnce();
  assert.equal(resolved, true);
  assert.equal(outcome.processed, 1);
  assert.equal(backend.results.length, 1);
  assert.equal(backend.results[0].body.status, 'FAILED');
  assert.equal(backend.results[0].body.code, 'PUBLISH_FAILED');
  assert.equal(sync.stats().delivered, 0);
});

/* ------------------------------------------------------------ 回执真实性 */

test('never accepts a pre-existing ACKED state as the receipt', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '3' });
  const published = [];
  const sync = createSync(backend, {
    publishCommand: () => { published.push(1); return true; },
    ackTimeoutMs: 100,
    maxAttempts: 1,
    retryBackoffMs: 0
  });

  // 命令发布之前设备就已经是 ACKED：这是旧状态，不能算回执。
  assert.equal(sync.observe(statusPayload()).accepted, true);

  const outcome = await sync.pollOnce();
  assert.equal(published.length, 1);
  assert.equal(outcome.processed, 1);
  assert.equal(backend.results.length, 1);
  assert.equal(backend.results[0].body.status, 'FAILED');
  assert.equal(backend.results[0].body.code, 'ACK_TIMEOUT');
  assert.equal(sync.stats().acked, 0);
  assert.equal(sync.stats().failed, 1);
});

test('ignores ACKED receipts whose alarm id does not match the command', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '4' });
  const published = [];
  const sync = createSync(backend, {
    publishCommand: () => { published.push(1); return true; },
    ackTimeoutMs: 100,
    maxAttempts: 1,
    retryBackoffMs: 0
  });

  const poll = sync.pollOnce();
  await waitFor(() => published.length === 1, 'publish');
  sync.observe(statusPayload({ alarm: { id: 'alarm-999' } }));
  const outcome = await poll;

  assert.equal(outcome.processed, 1);
  assert.equal(backend.results.length, 1);
  assert.deepEqual(backend.results[0].body, { status: 'FAILED', code: 'ACK_TIMEOUT' });
});

test('reports FAILED with a bounded code when the downlink never succeeds', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '5' });
  const sync = createSync(backend, {
    publishCommand: () => false,
    maxAttempts: 2,
    retryBackoffMs: 0
  });

  // 第一次尝试失败 -> waiting，游标不推进，不伪造回写。
  const first = await sync.pollOnce();
  assert.equal(first.blocked, true);
  assert.equal(first.cursor, 0);
  assert.equal(backend.results.length, 0);

  // 第二次仍失败 -> 结算 FAILED。
  const second = await sync.pollOnce();
  assert.equal(second.processed, 1);
  assert.equal(backend.results.length, 1);
  assert.deepEqual(backend.results[0].body, { status: 'FAILED', code: 'PUBLISH_FAILED' });
  assert.equal(sync.stats().failed, 1);
});

test('retries a failed publish and still requires a real receipt before ACKED', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '9' });
  let attempts = 0;
  const sync = createSync(backend, {
    publishCommand: () => { attempts += 1; return attempts > 1; },
    maxAttempts: 2,
    retryBackoffMs: 0
  });

  const first = await sync.pollOnce();
  assert.equal(first.blocked, true);
  assert.equal(attempts, 1);

  const second = sync.pollOnce();
  await waitFor(() => attempts === 2, 'retry publish');
  assert.equal(backend.results.length, 0);
  sync.observe(statusPayload());
  const outcome = await second;

  assert.equal(outcome.processed, 1);
  assert.equal(backend.results.length, 1);
  assert.equal(backend.results[0].body.status, 'ACKED');
});

test('a transport failure surfaces as a bounded code without throwing', async () => {
  const failedRequest = (options, body, callback) => setImmediate(
    () => callback(Object.assign(new Error('timed out'), { code: 'SYNC_TIMEOUT' }), null)
  );
  const sync = createCommandSync({
    backendUrl: 'http://127.0.0.1:8080',
    ingestKey: INGEST_KEY,
    httpRequest: failedRequest
  });
  const outcome = await sync.pollOnce();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'SYNC_TIMEOUT');
  assert.equal(sync.cursor(), 0);
  assert.equal(sync.stats().errors, 1);
});

test('surfaces list HTTP failures and bad JSON without moving the cursor', async () => {
  const httpFail = createFakeBackend({
    respond: (entry) => (entry.method === 'GET' ? { statusCode: 503, text: '{"error":"down"}' } : undefined)
  });
  const failing = createSync(httpFail);
  const failed = await failing.pollOnce();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'SYNC_HTTP_ERROR');
  assert.equal(failing.cursor(), 0);
  assert.equal(failing.stats().errors, 1);

  const badJson = createFakeBackend({
    respond: (entry) => (entry.method === 'GET' ? { statusCode: 200, text: 'not-json' } : undefined)
  });
  const broken = createSync(badJson);
  const brokenOutcome = await broken.pollOnce();
  assert.equal(brokenOutcome.ok, false);
  assert.equal(brokenOutcome.code, 'SYNC_BAD_JSON');
});

/* ------------------------------------------------------------ 结果回写重试 */

test('retries an ACKED result write-back without re-publishing or re-waiting', async () => {
  const failedBodies = [];
  let resultPosts = 0;
  const backend = createFakeBackend({
    respond: (entry) => {
      if (entry.method === 'POST' && /\/result$/.test(entry.path)) {
        resultPosts += 1;
        if (resultPosts === 1) {
          failedBodies.push(entry.body);
          return { statusCode: 503, text: '{"error":"temporarily unavailable"}' };
        }
      }
      return undefined;
    }
  });
  backend.addCommand({ id: '61' });
  const published = [];
  const sync = createSync(backend, {
    publishCommand: () => { published.push(1); return true; }
  });

  // 第一轮：设备真实 ACKED，但第一次 POST /result 因临时故障失败。
  const first = sync.pollOnce();
  await waitFor(() => published.length === 1, 'publish');
  sync.observe(statusPayload());
  const firstOutcome = await first;

  assert.equal(firstOutcome.blocked, true, '回写失败时游标不得推进');
  assert.equal(firstOutcome.processed, 0);
  assert.equal(sync.cursor(), 0);
  assert.equal(published.length, 1, 'MQTT 只发布一次');
  assert.equal(resultPosts, 1);
  assert.equal(backend.results.length, 0, '后端尚未确认');
  assert.equal(sync.stats().acked, 1, '设备确实回了 ACKED');
  assert.equal(sync.pendingResults(), 1, '结果进入待回写');
  assert.equal(sync.waiters(), 0);

  // 第二轮：只重试结果回写，不发布、不重新等待设备回执。
  const second = await sync.pollOnce();
  assert.equal(second.blocked, false);
  assert.equal(second.processed, 1);
  assert.equal(sync.cursor(), 61, '回写成功后才推进游标');
  assert.equal(published.length, 1, 'MQTT 仍只发布一次');
  assert.equal(resultPosts, 2);
  assert.equal(backend.results.length, 1);
  assert.equal(sync.pendingResults(), 0);
  assert.equal(sync.stats().resultRetries, 1);
  assert.equal(sync.stats().duplicates, 0);

  // 重试必须携带与首次完全相同的原始结果体（含 deviceState），不得伪造或丢失。
  assert.deepEqual(backend.results[0].body, failedBodies[0]);
  assert.equal(backend.results[0].body.status, 'ACKED');
  assert.equal(backend.results[0].body.deviceState.deviceId, DEVICE_ID);
  assert.equal(backend.results[0].body.deviceState.state, 'ACKED');
  assert.equal(backend.results[0].body.deviceState.alarm.id, ALARM_ID);
  assert.equal(backend.results[0].body.deviceState.room, '客厅');
});

test('retries a FAILED result write-back without re-publishing', async () => {
  let resultPosts = 0;
  const backend = createFakeBackend({
    respond: (entry) => {
      if (entry.method === 'POST' && /\/result$/.test(entry.path)) {
        resultPosts += 1;
        if (resultPosts === 1) return { statusCode: 503, text: '{"error":"temporarily unavailable"}' };
      }
      return undefined;
    }
  });
  backend.addCommand({ id: '62' });
  const published = [];
  const sync = createSync(backend, {
    publishCommand: () => { published.push(1); return true; },
    ackTimeoutMs: 100,
    maxAttempts: 1,
    retryBackoffMs: 0
  });

  // 第一轮：设备未回执超时 -> FAILED，但第一次回写失败。
  const first = await sync.pollOnce();
  assert.equal(first.blocked, true, '回写失败时游标不得推进');
  assert.equal(published.length, 1);
  assert.equal(resultPosts, 1);
  assert.equal(backend.results.length, 0);
  assert.equal(sync.pendingResults(), 1);
  assert.equal(sync.stats().failed, 1);

  // 第二轮：只重试 FAILED 回写。
  const second = await sync.pollOnce();
  assert.equal(second.processed, 1);
  assert.equal(second.blocked, false);
  assert.equal(published.length, 1, 'MQTT 只发布一次');
  assert.equal(resultPosts, 2);
  assert.equal(sync.cursor(), 62);
  assert.equal(sync.pendingResults(), 0);
  assert.deepEqual(backend.results[0].body, { status: 'FAILED', code: 'ACK_TIMEOUT' });
});

/* ------------------------------------------------------------ 幂等 */

test('never publishes or reports the same command twice within one list', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '4' });
  backend.addCommand({ id: '4' });
  const published = [];
  const sync = createSync(backend, {
    publishCommand: () => { published.push(1); return true; }
  });

  const poll = sync.pollOnce();
  await waitFor(() => published.length === 1, 'publish');
  sync.observe(statusPayload());
  const outcome = await poll;

  assert.equal(published.length, 1);
  assert.equal(backend.results.length, 1);
  assert.equal(outcome.processed, 2);
  assert.equal(sync.stats().duplicates, 1);
});

test('a settled command reappearing in a later poll is skipped', async () => {
  // keepPending 模拟后端仍把该命令当作 PENDING 返回，专门验证本地台账幂等。
  const backend = createFakeBackend({ alwaysReturnAll: true, keepPending: true });
  backend.addCommand({ id: '11' });
  const published = [];
  const sync = createSync(backend, {
    publishCommand: () => { published.push(1); return true; }
  });

  const first = sync.pollOnce();
  await waitFor(() => published.length === 1, 'publish');
  sync.observe(statusPayload());
  await first;
  assert.equal(sync.cursor(), 11);

  const second = await sync.pollOnce();
  assert.equal(second.ok, true);
  assert.equal(published.length, 1);
  assert.equal(backend.results.length, 1);
  assert.equal(sync.stats().duplicates, 1);
});

test('ignores invalid commands without publishing or reporting anything', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '31', command: 'RESET' });
  backend.addCommand({ id: '32', deviceId: '../bad' });
  backend.addCommand({ id: '33', action: 'x\r\ny' });
  backend.addCommand({ id: '34', status: 'ACKED' });
  const published = [];
  const sync = createSync(backend, {
    publishCommand: () => { published.push(1); return true; }
  });

  const outcome = await sync.pollOnce();
  assert.equal(published.length, 0);
  assert.equal(backend.results.length, 0);
  assert.equal(sync.stats().ignored, 4);
  assert.equal(outcome.processed, 0);
  assert.equal(outcome.cursor, 34);
});

/* ------------------------------------------------------------ 观测与生命周期 */

test('observe rejects malformed device status without throwing', () => {
  const sync = createCommandSync({});
  assert.deepEqual(sync.observe('{not json'), { accepted: false, code: 'INVALID_JSON' });
  assert.deepEqual(sync.observe(42), { accepted: false, code: 'INVALID_STATUS' });
  assert.deepEqual(sync.observe({ deviceId: '../x', state: 'ACKED' }), { accepted: false, code: 'INVALID_DEVICE_ID' });
  assert.deepEqual(sync.observe({ deviceId: DEVICE_ID, state: 'BOOM' }), { accepted: false, code: 'INVALID_STATE' });
  assert.deepEqual(
    sync.observe({ deviceId: DEVICE_ID, state: 'ACKED', alarm: { id: 'a b' } }),
    { accepted: false, code: 'INVALID_ALARM_ID' }
  );
  assert.deepEqual(
    sync.observe({ deviceId: DEVICE_ID, state: 'ACKED', monitorOnline: '0', alarm: { id: ALARM_ID } }),
    { accepted: false, code: 'INVALID_MONITOR_STATUS' }
  );
  assert.equal(sync.observations(), 0);

  assert.deepEqual(sync.observe(Buffer.from(JSON.stringify(statusPayload()))), { accepted: true });
  assert.equal(sync.observations(), 1);
});

test('stop cancels in-flight receipts without reporting a fake failure', async () => {
  const backend = createFakeBackend();
  backend.addCommand({ id: '41' });
  const published = [];
  const sync = createSync(backend, {
    publishCommand: () => { published.push(1); return true; },
    ackTimeoutMs: 30000,
    maxAttempts: 1
  });

  const poll = sync.pollOnce();
  await waitFor(() => published.length === 1, 'publish');
  assert.equal(sync.waiters(), 1);

  assert.equal(await sync.stop('TEST_STOP'), 'TEST_STOP');
  const outcome = await poll;

  assert.equal(outcome.blocked, true);
  assert.equal(backend.results.length, 0);
  assert.equal(sync.stoppedReason(), 'TEST_STOP');
  assert.equal(sync.waiters(), 0);
});

test('start polls repeatedly and stop halts the loop', async () => {
  const backend = createFakeBackend();
  // 非法命令让每轮立即结束，测试只关注调度本身。
  backend.addCommand({ id: '51', command: 'RESET' });
  const sync = createSync(backend, { pollIntervalMs: 50 });

  sync.start(50);
  await waitFor(() => listRequests(backend).length >= 2, 'two polls');
  await sync.stop('DONE');

  const settledCount = listRequests(backend).length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(listRequests(backend).length, settledCount);
  assert.equal(sync.stoppedReason(), 'DONE');
});
