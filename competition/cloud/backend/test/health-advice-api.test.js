'use strict';

/**
 * health-advice-api.test.js — POST /api/v1/health-advice HTTP 集成测试
 *
 * 覆盖规格 §2.3：
 *   - Bearer 401/403、拒绝 query 参数、请求体 >8 KiB → 413；
 *   - 空请求体/{} 使用服务端已保存资料；无资料 → 409 HEALTH_PROFILE_EMPTY；
 *   - `{"profile":{...}}` 内联资料：完整白名单校验且**不落盘**；
 *   - 其它顶层字段（尤其身份字段）→ 400；
 *   - AI 未配置 → 503 AI_NOT_CONFIGURED；超时 → 504 AI_TIMEOUT；
 *     其它失败 → 502 AI_UPSTREAM_ERROR；任何失败都**绝不返回伪造建议**；
 *   - 成功 200 的响应结构与服务端强制 disclaimer；
 *   - 真实 DeepSeek 客户端 + fake fetch 的端到端接线（含内存缓存命中）；
 *   - 失败/成功全程不打印资料内容、Key、token 或 AI 原始响应。
 *
 * 全部使用临时目录、注入 fake fetch / fake client 与本地 127.0.0.1 端口，
 * 不访问真实网络、不读取真实 Key。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSessionToken } = require('../src/auth');
const { createDeepSeekClient } = require('../src/deepseek-client');
const { HEALTH_ADVICE_DISCLAIMER } = require('../src/health-advice-prompt');
const { healthOwnerRefFor } = require('../src/health-profile');
const { HealthStore } = require('../src/health-store');
const { createRuntime } = require('../src/main');
const { createApiServer } = require('../src/server');

const TOKEN_SECRET = 'health-advice-api-test-token-secret-at-least-32-chars';
const INGEST_KEY = 'health-advice-api-test-ingest-key-at-least-32-chars';
const IDENTITY = 'openid-health-advice-api';
const OTHER_IDENTITY = 'openid-health-advice-api-other';
const STRANGER_IDENTITY = 'openid-health-advice-stranger';
const API_KEY = 'test-deepseek-advice-api-key-0123456789';

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'health-advice-api-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function validProfile(extra = {}) {
  return {
    age: 72,
    medicalHistory: '高血压',
    medications: '氨氯地平',
    heightCm: 165,
    weightKg: 62,
    restingBloodPressure: '135/82',
    fastingGlucose: '6.1',
    sleep: { hours: 7, difficulty: false, nightAwakenings: 1 },
    diet: { regular: true, taste: 'light', restrictions: '少油' },
    exercise: { timesPerWeek: 4, types: '散步、太极' },
    ...extra
  };
}

function adviceBody(overrides = {}) {
  return {
    summary: '结合您填写的资料给出生活方式建议；未填写的内容已标注为信息不足。',
    diet: ['三餐规律，少油少盐。'],
    exerciseAndSleep: ['量力而行地散步。', '保持固定作息。'],
    warningSigns: ['如有明显不适，请尽快联系家属或正规医疗机构。'],
    disclaimer: '模型自带的免责声明（必须被服务端覆盖）',
    ...overrides
  };
}

/** 注入型 fake DeepSeek 客户端：记录调用参数，按 handler 返回结果。 */
function createFakeClient(handler, options = {}) {
  const calls = [];
  const client = {
    calls,
    isConfigured: () => options.configured !== false,
    getModel: () => 'deepseek-chat',
    async generateAdvice(profile, context) {
      calls.push({ profile: JSON.parse(JSON.stringify(profile)), context });
      return handler(profile, context, calls.length);
    }
  };
  return client;
}

function successResult(overrides = {}) {
  return {
    ok: true,
    advice: adviceBody(overrides),
    model: 'deepseek-chat',
    generatedAt: 1790000000000,
    cached: false
  };
}

async function startServer(t, options = {}) {
  const directory = options.directory || tempDir(t);
  const healthFile = options.healthFile || path.join(directory, 'health-state.json');
  const healthStore = options.healthStore !== undefined
    ? options.healthStore
    : new HealthStore({ filePath: healthFile, now: options.now });
  const allowed = new Set([IDENTITY, OTHER_IDENTITY]);
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (identity) => allowed.has(identity),
    healthStore,
    healthOwnerRefForIdentity: (subject) => healthOwnerRefFor(TOKEN_SECRET, subject),
    ...(options.server || {})
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    created.server.close(() => resolve());
  });
  t.after(close);
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  const headers = {
    authorization: `Bearer ${createSessionToken(IDENTITY, TOKEN_SECRET)}`,
    'content-type': 'application/json'
  };
  return { baseUrl, close, healthFile, healthStore, directory, headers };
}

async function call(baseUrl, method, target, options = {}) {
  const response = await fetch(`${baseUrl}${target}`, {
    method,
    headers: options.headers,
    body: options.body === undefined
      ? undefined
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
  });
  const text = await response.text();
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text, headers: response.headers };
}

function captureConsole(t) {
  const calls = [];
  const original = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    original[method] = console[method];
    console[method] = (...args) => calls.push({ method, text: args.map(String).join(' ') });
  }
  t.after(() => {
    for (const method of Object.keys(original)) console[method] = original[method];
  });
  return calls;
}

async function saveProfile(server, body = validProfile()) {
  const response = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body
  });
  assert.equal(response.status, 200);
  return response.body.profile;
}

/* ------------------------------------------------------------ 鉴权 / 参数 */

test('health advice route requires a valid session and rejects query parameters', async (t) => {
  const client = createFakeClient(async () => successResult());
  const server = await startServer(t, { server: { healthAdviceClient: client } });

  const missing = await call(server.baseUrl, 'POST', '/api/v1/health-advice');
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, { error: 'unauthorized' });

  const strangerHeaders = {
    authorization: `Bearer ${createSessionToken(STRANGER_IDENTITY, TOKEN_SECRET)}`,
    'content-type': 'application/json'
  };
  const stranger = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: strangerHeaders,
    body: {}
  });
  assert.equal(stranger.status, 403);
  assert.deepEqual(stranger.body, { error: 'forbidden' });

  await saveProfile(server);
  const query = await call(server.baseUrl, 'POST', '/api/v1/health-advice?debug=1', {
    headers: server.headers,
    body: {}
  });
  assert.equal(query.status, 400);
  assert.deepEqual(query.body, { error: 'query parameters are not allowed' });

  const oversized = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: { profile: validProfile({ medicalHistory: 'x'.repeat(9000) }) }
  });
  assert.equal(oversized.status, 413);
  assert.equal(client.calls.length, 0, 'rejected requests must never reach the AI');
});

test('no saved profile returns 409 HEALTH_PROFILE_EMPTY without calling the AI', async (t) => {
  const client = createFakeClient(async () => successResult());
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  for (const body of [{}, undefined]) {
    const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
      headers: server.headers,
      body
    });
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.deepEqual(response.body, { error: 'health profile is empty', code: 'HEALTH_PROFILE_EMPTY' });
    assert.equal('advice' in response.body, false);
  }
  assert.equal(client.calls.length, 0);
});

/* ------------------------------------------------------------ 成功路径 */

test('saved profile generates advice with the frozen response shape and forced disclaimer', async (t) => {
  const client = createFakeClient(async () => successResult());
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  const saved = await saveProfile(server);

  const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: {}
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(response.body).sort(), ['advice', 'generatedAt', 'model']);
  assert.deepEqual(Object.keys(response.body.advice).sort(), [
    'diet', 'disclaimer', 'exerciseAndSleep', 'summary', 'warningSigns'
  ]);
  assert.equal(response.body.advice.disclaimer, HEALTH_ADVICE_DISCLAIMER);
  assert.equal(response.body.advice.summary, adviceBody().summary);
  assert.deepEqual(response.body.advice.diet, adviceBody().diet);
  assert.equal(response.body.generatedAt, 1790000000000);
  assert.equal(response.body.model, 'deepseek-chat');
  assert.equal(JSON.stringify(response.body).includes('模型自带的免责声明'), false);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].profile, saved, 'the saved profile (with server updatedAt) is used');
  assert.equal(client.calls[0].context.ownerRef, healthOwnerRefFor(TOKEN_SECRET, IDENTITY));
});

test('inline profile is validated and used without being persisted', async (t) => {
  const client = createFakeClient(async () => successResult());
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  const inline = validProfile({ age: 68 });

  const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: { profile: inline }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.advice.disclaimer, HEALTH_ADVICE_DISCLAIMER);
  assert.deepEqual(client.calls[0].profile, inline);
  assert.equal(fs.existsSync(server.healthFile), false, 'inline profiles must never be persisted');

  const fetched = await call(server.baseUrl, 'GET', '/api/v1/health-profile', { headers: server.headers });
  assert.deepEqual(fetched.body, { profile: null });
});

test('request body top-level whitelist only allows profile', async (t) => {
  const client = createFakeClient(async () => successResult());
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  await saveProfile(server);

  for (const extra of [
    { openid: 'openid-someone-else' },
    { token: 'leak' },
    { ownerRef: 'h1_leak' },
    { age: 72 },
    { profile: validProfile(), extra: true }
  ]) {
    const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
      headers: server.headers,
      body: { ...extra }
    });
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.equal(response.body.error, 'invalid health advice request');
    assert.ok(response.body.fields.some((field) => field.startsWith('unknown field:')));
  }

  const invalidProfile = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: { profile: { age: 999 } }
  });
  assert.equal(invalidProfile.status, 400);
  assert.equal(invalidProfile.body.error, 'invalid health profile');
  assert.ok(invalidProfile.body.fields.some((field) => /^age /.test(field)));

  const nullProfile = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: { profile: null }
  });
  assert.equal(nullProfile.status, 400);
  assert.equal(nullProfile.body.error, 'invalid health profile');
  assert.equal(client.calls.length, 0);
});

/* ------------------------------------------------------------ 失败语义 */

test('AI not configured returns 503 AI_NOT_CONFIGURED instead of fake advice', async (t) => {
  const realClient = createDeepSeekClient({ apiKey: '' });
  const server = await startServer(t, { server: { healthAdviceClient: realClient } });
  await saveProfile(server);

  const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: {}
  });
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { error: 'ai service unavailable', code: 'AI_NOT_CONFIGURED' });
  assert.equal('advice' in response.body, false);

  // 没有注入任何客户端时同样是 503，绝不伪造。
  const noClientServer = await startServer(t);
  await saveProfile(noClientServer);
  const noClient = await call(noClientServer.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: noClientServer.headers,
    body: {}
  });
  assert.equal(noClient.status, 503);
  assert.deepEqual(noClient.body, { error: 'ai service unavailable', code: 'AI_NOT_CONFIGURED' });
});

test('AI timeout maps to 504 AI_TIMEOUT with no advice payload', async (t) => {
  const client = createFakeClient(async () => ({ ok: false, code: 'AI_TIMEOUT' }));
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  await saveProfile(server);
  const calls = captureConsole(t);

  const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: {}
  });
  assert.equal(response.status, 504);
  assert.deepEqual(response.body, { error: 'ai service timeout', code: 'AI_TIMEOUT' });
  assert.equal(response.text.includes('advice'), false);
  assert.deepEqual(
    calls.filter((entry) => entry.text.includes('HEALTH_ADVICE')).map((entry) => entry.text),
    ['[backend] HEALTH_ADVICE_FAILED code=AI_TIMEOUT']
  );
});

test('AI upstream failures map to 502 AI_UPSTREAM_ERROR and never fabricate advice', async (t) => {
  const failures = [
    { ok: false, code: 'AI_UPSTREAM_ERROR' },
    { ok: false },
    { ok: true },
    {},
    null
  ];
  for (const failure of failures) {
    const client = createFakeClient(async () => failure);
    const server = await startServer(t, { server: { healthAdviceClient: client } });
    await saveProfile(server);
    const calls = captureConsole(t);
    const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
      headers: server.headers,
      body: {}
    });
    assert.equal(response.status, 502, JSON.stringify(failure));
    assert.deepEqual(response.body, { error: 'ai service failed', code: 'AI_UPSTREAM_ERROR' });
    assert.equal('advice' in response.body, false);
    assert.deepEqual(
      calls.filter((entry) => entry.text.includes('HEALTH_ADVICE')).map((entry) => entry.text),
      ['[backend] HEALTH_ADVICE_FAILED code=AI_UPSTREAM_ERROR']
    );
  }
});

test('a throwing AI client is contained as a 502 and does not affect other routes', async (t) => {
  const client = {
    isConfigured: () => true,
    getModel: () => 'deepseek-chat',
    async generateAdvice() {
      const error = new Error('boom SENSITIVE-UPSTREAM-DETAIL');
      error.code = 'ECONNRESET';
      throw error;
    }
  };
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  await saveProfile(server);
  const calls = captureConsole(t);
  const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: {}
  });
  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: 'ai service failed', code: 'AI_UPSTREAM_ERROR' });
  assert.equal(response.text.includes('SENSITIVE-UPSTREAM-DETAIL'), false);
  assert.ok(calls.every((entry) => entry.text === '[backend] HEALTH_ADVICE_FAILED code=AI_UPSTREAM_ERROR'));

  const overview = await call(server.baseUrl, 'GET', '/api/v1/overview', { headers: server.headers });
  assert.equal(overview.status, 200);
  const profile = await call(server.baseUrl, 'GET', '/api/v1/health-profile', { headers: server.headers });
  assert.equal(profile.body.profile.age, 72);
});

test('inline profile AI failure never falls back to the saved profile', async (t) => {
  const client = createFakeClient(async () => ({ ok: false, code: 'AI_TIMEOUT' }));
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  await saveProfile(server, validProfile({ age: 72 }));

  const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: { profile: validProfile({ age: 68 }) }
  });
  assert.equal(response.status, 504);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].profile.age, 68);
});

/* ------------------------------------------------------------ 真实客户端 + fake fetch 接线 */

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

function deepseekResponse(overrides = {}) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(adviceBody(overrides)) } }]
  });
}

test('wired real DeepSeek client produces a 200 with forced disclaimer, then serves the cache', async (t) => {
  const requests = [];
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    now: () => 1790000000000,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return deepseekResponse();
    }
  });
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  const saved = await saveProfile(server);
  const calls = captureConsole(t);

  const first = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: {}
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.advice.disclaimer, HEALTH_ADVICE_DISCLAIMER);
  assert.equal(first.body.model, 'deepseek-chat');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].body.messages[1].content, JSON.stringify(saved));
  assert.equal(requests[0].body.messages[1].content.includes(IDENTITY), false);
  assert.equal(requests[0].body.messages[1].content.includes('openid'), false);
  // 快照里绝不出现 API Key。
  assert.equal(fs.readFileSync(server.healthFile, 'utf8').includes(API_KEY), false);

  const second = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: {}
  });
  assert.equal(second.status, 200);
  assert.equal(requests.length, 1, 'same profile must hit the in-memory cache');
  assert.equal(second.body.advice.disclaimer, HEALTH_ADVICE_DISCLAIMER);
  assert.equal(second.body.generatedAt, first.body.generatedAt);
  assert.deepEqual(calls, [], 'success path must not log');
  assert.equal(JSON.stringify(first.body).includes(API_KEY), false);
});

test('wired real DeepSeek client maps timeout/upstream failures to 504/502', async (t) => {
  const timeoutClient = createDeepSeekClient({
    apiKey: API_KEY,
    timeoutMs: 1000,
    maxRetries: 0,
    fetchImpl: async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    }
  });
  const timeoutServer = await startServer(t, { server: { healthAdviceClient: timeoutClient } });
  await saveProfile(timeoutServer);
  const timeout = await call(timeoutServer.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: timeoutServer.headers,
    body: {}
  });
  assert.equal(timeout.status, 504);
  assert.deepEqual(timeout.body, { error: 'ai service timeout', code: 'AI_TIMEOUT' });

  const upstreamClient = createDeepSeekClient({
    apiKey: API_KEY,
    maxRetries: 0,
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '不是 JSON' } }] })
  });
  const upstreamServer = await startServer(t, { server: { healthAdviceClient: upstreamClient } });
  await saveProfile(upstreamServer);
  const upstream = await call(upstreamServer.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: upstreamServer.headers,
    body: {}
  });
  assert.equal(upstream.status, 502);
  assert.deepEqual(upstream.body, { error: 'ai service failed', code: 'AI_UPSTREAM_ERROR' });
});

test('response and logs never contain the API key, token, profile content or raw AI output', async (t) => {
  const marker = 'SENSITIVE-PROFILE-MARKER';
  const client = createFakeClient(async () => ({
    ok: false,
    code: 'AI_UPSTREAM_ERROR',
    raw: `raw upstream ${marker}`,
    key: API_KEY
  }));
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  await saveProfile(server, validProfile({ medicalHistory: marker }));
  const calls = captureConsole(t);
  const response = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: {}
  });
  assert.equal(response.status, 502);
  for (const secret of [marker, API_KEY, createSessionToken(IDENTITY, TOKEN_SECRET), IDENTITY]) {
    assert.equal(response.text.includes(secret), false, 'response must not leak sensitive values');
  }
  assert.ok(calls.length > 0);
  for (const entry of calls) {
    assert.equal(entry.text.includes(marker), false);
    assert.equal(entry.text.includes(API_KEY), false);
    assert.equal(entry.text.includes(IDENTITY), false);
    assert.equal(entry.text.includes(TOKEN_SECRET), false);
    assert.match(entry.text, /^\[backend\] HEALTH_ADVICE_FAILED code=[A-Z_]+$/);
  }
});

/* ------------------------------------------------------------ 未配置存储 */

test('advice with a saved profile requires the health store and owner-ref capability', async (t) => {
  const client = createFakeClient(async () => successResult());
  const noStore = await startServer(t, { server: { healthAdviceClient: client, healthStore: null } });
  const missingStore = await call(noStore.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: noStore.headers,
    body: {}
  });
  assert.equal(missingStore.status, 503);
  assert.deepEqual(missingStore.body, { error: 'storage unavailable' });

  const noOwnerRef = await startServer(t, { server: { healthAdviceClient: client, healthOwnerRefForIdentity: null } });
  const missingRef = await call(noOwnerRef.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: noOwnerRef.headers,
    body: {}
  });
  assert.equal(missingRef.status, 503);
  assert.deepEqual(missingRef.body, { error: 'storage unavailable' });
  assert.equal(client.calls.length, 0);
});

test('advice requests never log on validation failures', async (t) => {
  const client = createFakeClient(async () => successResult());
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  const calls = captureConsole(t);
  await call(server.baseUrl, 'POST', '/api/v1/health-advice', { headers: server.headers, body: {} });
  await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: { profile: { age: 0 } }
  });
  await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: { openid: 'x' }
  });
  assert.deepEqual(calls, []);
});

test('advice never crosses owners: each session only sees its own saved profile', async (t) => {
  const client = createFakeClient(async () => successResult());
  const server = await startServer(t, { server: { healthAdviceClient: client } });
  const otherHeaders = {
    authorization: `Bearer ${createSessionToken(OTHER_IDENTITY, TOKEN_SECRET)}`,
    'content-type': 'application/json'
  };
  await saveProfile(server, validProfile({ age: 72 }));

  // B 没有资料：即使 A 有资料也必须 409，绝不串户。
  const empty = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: otherHeaders,
    body: {}
  });
  assert.equal(empty.status, 409);
  assert.deepEqual(empty.body, { error: 'health profile is empty', code: 'HEALTH_PROFILE_EMPTY' });
  assert.equal(client.calls.length, 0);

  const saveB = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: otherHeaders,
    body: validProfile({ age: 66 })
  });
  assert.equal(saveB.status, 200);

  const adviceB = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: otherHeaders,
    body: {}
  });
  assert.equal(adviceB.status, 200);
  assert.equal(client.calls[client.calls.length - 1].profile.age, 66);

  const adviceA = await call(server.baseUrl, 'POST', '/api/v1/health-advice', {
    headers: server.headers,
    body: {}
  });
  assert.equal(adviceA.status, 200);
  assert.equal(client.calls[client.calls.length - 1].profile.age, 72);
});

/* ------------------------------------------------------------ main.js 装配 */

const APP_SUBJECT = 'app:family-guardian';

function runtimeEnv(directory, extra = {}) {
  return {
    BACKEND_DATA_FILE: path.join(directory, 'state.json'),
    BACKEND_EVIDENCE_DIR: path.join(directory, 'evidence'),
    BACKEND_ACTIVITY_FILE: path.join(directory, 'activity-state.json'),
    HEALTH_DATA_FILE: path.join(directory, 'health-state.json'),
    API_TOKEN_SECRET: TOKEN_SECRET,
    INGEST_KEY: INGEST_KEY,
    APP_GUARDIAN_ID: 'family-guardian',
    APP_GUARDIAN_PASSWORD: 'runtime-health-test-password-at-least-32-chars',
    ...extra
  };
}

async function startRuntime(t, env) {
  const runtime = createRuntime(env);
  t.after(async () => {
    if (runtime.server.listening) {
      await new Promise((resolve) => runtime.server.close(() => resolve()));
    }
  });
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  const headers = {
    authorization: `Bearer ${createSessionToken(APP_SUBJECT, TOKEN_SECRET)}`,
    'content-type': 'application/json'
  };
  return { runtime, baseUrl, headers };
}

test('main runtime wires the independent health store, owner refs and AI-disabled behaviour', async (t) => {
  const directory = tempDir(t);
  const { runtime, baseUrl, headers } = await startRuntime(t, runtimeEnv(directory));

  assert.ok(runtime.healthStore instanceof HealthStore);
  assert.equal(runtime.healthFile, path.resolve(path.join(directory, 'health-state.json')));
  assert.equal(runtime.healthAdviceClient.isConfigured(), false, 'missing key disables AI, not the backend');
  assert.equal(fs.existsSync(runtime.healthFile), false, 'startup must not create a false health snapshot');

  const get = await call(baseUrl, 'GET', '/api/v1/health-profile', { headers });
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, { profile: null });

  const save = await call(baseUrl, 'PUT', '/api/v1/health-profile', { headers, body: validProfile() });
  assert.equal(save.status, 200);
  assert.equal(fs.existsSync(runtime.healthFile), true);

  const advice = await call(baseUrl, 'POST', '/api/v1/health-advice', { headers, body: {} });
  assert.equal(advice.status, 503);
  assert.deepEqual(advice.body, { error: 'ai service unavailable', code: 'AI_NOT_CONFIGURED' });

  // 未配置 Key 时健康接口仍可用、既有接口也完全不受影响。
  const overview = await call(baseUrl, 'GET', '/api/v1/overview', { headers });
  assert.equal(overview.status, 200);
});

test('main runtime reports configured=true with a key and never logs or exposes it', async (t) => {
  const directory = tempDir(t);
  const apiKey = 'runtime-health-test-deepseek-key-0123456789';
  const calls = captureConsole(t);
  const runtime = createRuntime(runtimeEnv(directory, { DEEPSEEK_API_KEY: apiKey }));
  assert.equal(runtime.healthAdviceClient.isConfigured(), true);
  assert.deepEqual(calls, [], 'createRuntime must not log the key or any config values');
  assert.equal(JSON.stringify(runtime.healthAdviceClient.describe()).includes(apiKey), false);
  assert.equal(JSON.stringify(runtime.healthAdviceClient).includes(apiKey), false);
  // 构造成功后不主动调用 AI，因此不会产生任何网络请求。
  t.after(() => {
    if (runtime.server.listening) runtime.server.close();
  });
});

test('main runtime fails closed on corrupt health state or invalid health/AI env', (t) => {
  const directory = tempDir(t);
  const baseEnv = runtimeEnv(directory);
  fs.writeFileSync(baseEnv.HEALTH_DATA_FILE, '{not json');
  assert.throws(() => createRuntime(baseEnv), /health store corrupt: invalid JSON/);
  fs.rmSync(baseEnv.HEALTH_DATA_FILE);

  const invalid = [
    ['DEEPSEEK_BASE_URL', 'http://api.deepseek.com', /https/],
    ['DEEPSEEK_BASE_URL', 'not-a-url', /valid https URL/],
    ['DEEPSEEK_MODEL', 'bad model!', /DEEPSEEK_MODEL/],
    ['DEEPSEEK_TIMEOUT_MS', '999', /DEEPSEEK_TIMEOUT_MS/],
    ['DEEPSEEK_TIMEOUT_MS', '15001', /DEEPSEEK_TIMEOUT_MS/],
    ['DEEPSEEK_MAX_RETRIES', '2', /DEEPSEEK_MAX_RETRIES/],
    ['HEALTH_ADVICE_CACHE_TTL_MS', '-1', /HEALTH_ADVICE_CACHE_TTL_MS/],
    ['HEALTH_ADVICE_CACHE_TTL_MS', '3600001', /HEALTH_ADVICE_CACHE_TTL_MS/],
    ['HEALTH_ADVICE_CACHE_MAX', '0', /HEALTH_ADVICE_CACHE_MAX/],
    ['HEALTH_ADVICE_CACHE_MAX', '257', /HEALTH_ADVICE_CACHE_MAX/],
    ['DEEPSEEK_API_KEY', 'short-key', /at least 20 characters/]
  ];
  for (const [name, value, pattern] of invalid) {
    assert.throws(
      () => createRuntime({ ...baseEnv, [name]: value }),
      pattern,
      `${name}=${value} must fail closed`
    );
  }
});

