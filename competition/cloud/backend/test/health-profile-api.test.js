'use strict';

/**
 * health-profile-api.test.js — GET/PUT /api/v1/health-profile HTTP 集成测试
 *
 * 覆盖规格 §1/§2.1/§2.2：
 *   - Bearer 401/403（沿用既有统一鉴权段）；
 *   - 不允许 query 参数；
 *   - 无资料返回 `{profile:null}`；保存返回规范化结果 + 服务端 updatedAt；
 *   - 非法年龄/身高/体重/血压/血糖/文本长度/嵌套字段 → 400 且错误信息不含原始值；
 *   - 未知字段/身份字段 400 且**绝不进入持久化文件**；
 *   - 客户端 updatedAt 400；空请求体 400；请求体 >8 KiB → 413；
 *   - 两个监护人身份资料隔离；重启后仍可读取；
 *   - 存储未配置 → 503；写盘失败 → 503 + 内存/磁盘回滚 + 只打印安全错误码；
 *   - `h1_` 域分离 ownerRef 与 comms 的 `r1_` ownerRef 互不通用；
 *   - 健康路由注册后既有接口（overview/devices/alerts/ACK）行为不变。
 *
 * 全部使用临时目录与本地 127.0.0.1 端口，不访问网络、不读取真实密钥。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSessionToken } = require('../src/auth');
const { ownerRefFor } = require('../src/comms-core');
const {
  describeHealthProfile,
  healthOwnerRefFor,
  isHealthOwnerRef
} = require('../src/health-profile');
const { HEALTH_FILE_VERSION, HealthStore } = require('../src/health-store');
const { createApiServer } = require('../src/server');

const TOKEN_SECRET = 'health-profile-api-test-token-secret-at-least-32-chars';
const INGEST_KEY = 'health-profile-api-test-ingest-key-at-least-32-chars';
const IDENTITY = 'openid-health-profile-api';
const OTHER_IDENTITY = 'openid-health-profile-api-other';
const STRANGER_IDENTITY = 'openid-health-profile-stranger';

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'health-profile-api-'));
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
    smoking: '不吸烟',
    ...extra
  };
}

async function startServer(t, options = {}) {
  const directory = options.directory || tempDir(t);
  const healthFile = options.healthFile || path.join(directory, 'health-state.json');
  const healthStore = options.healthStore !== undefined
    ? options.healthStore
    : new HealthStore({ filePath: healthFile, now: options.now });
  const allowed = new Set(options.allowed || [IDENTITY, OTHER_IDENTITY]);
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
  const headersFor = (identity) => ({
    authorization: `Bearer ${createSessionToken(identity, TOKEN_SECRET)}`,
    'content-type': 'application/json'
  });
  return {
    baseUrl,
    close,
    healthFile,
    healthStore,
    directory,
    headers: headersFor(IDENTITY),
    headersFor
  };
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

function readHealthFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/* ------------------------------------------------------------ 鉴权与 query */

test('health profile routes require a valid session like every other v1 route', async (t) => {
  const server = await startServer(t);
  for (const method of ['GET', 'PUT']) {
    const missing = await call(server.baseUrl, method, '/api/v1/health-profile', {
      body: method === 'PUT' ? validProfile() : undefined
    });
    assert.equal(missing.status, 401, `${method} without session`);
    assert.deepEqual(missing.body, { error: 'unauthorized' });

    const badToken = await call(server.baseUrl, method, '/api/v1/health-profile', {
      headers: { authorization: 'Bearer not-a-token', 'content-type': 'application/json' },
      body: method === 'PUT' ? validProfile() : undefined
    });
    assert.equal(badToken.status, 401);

    const stranger = await call(server.baseUrl, method, '/api/v1/health-profile', {
      headers: server.headersFor(STRANGER_IDENTITY),
      body: method === 'PUT' ? validProfile() : undefined
    });
    assert.equal(stranger.status, 403, `${method} with a non-allowlisted identity`);
    assert.deepEqual(stranger.body, { error: 'forbidden' });
  }
});

test('health profile routes reject any query parameter', async (t) => {
  const server = await startServer(t);
  const get = await call(server.baseUrl, 'GET', '/api/v1/health-profile?token=leak', {
    headers: server.headers
  });
  assert.equal(get.status, 400);
  assert.deepEqual(get.body, { error: 'query parameters are not allowed' });

  const put = await call(server.baseUrl, 'PUT', '/api/v1/health-profile?x=1', {
    headers: server.headers,
    body: validProfile()
  });
  assert.equal(put.status, 400);
  assert.deepEqual(put.body, { error: 'query parameters are not allowed' });
});

/* ------------------------------------------------------------ 读写主路径 */

test('GET returns a null profile before anything is saved', async (t) => {
  const server = await startServer(t);
  const response = await call(server.baseUrl, 'GET', '/api/v1/health-profile', { headers: server.headers });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { profile: null });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('PUT persists a normalized profile and GET returns it with a server updatedAt', async (t) => {
  const server = await startServer(t, { now: () => 1790000000000 });
  const saved = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: validProfile({
      medicalHistory: '  高血压  ',
      medications: '',
      vision: null,
      mood: '平稳',
      sleep: { hours: 7.5, difficulty: false, nightAwakenings: 0 },
      exercise: { timesPerWeek: 0, types: '散步、太极' }
    })
  });
  assert.equal(saved.status, 200);
  const profile = saved.body.profile;
  assert.equal(profile.updatedAt, 1790000000000);
  assert.equal(profile.medicalHistory, '高血压');
  assert.equal('medications' in profile, false);
  assert.equal('vision' in profile, false);
  assert.equal(profile.sleep.nightAwakenings, 0);
  assert.equal(profile.exercise.timesPerWeek, 0);
  assert.equal(profile.mood, '平稳');
  assert.deepEqual(Object.keys(saved.body), ['profile']);

  const fetched = await call(server.baseUrl, 'GET', '/api/v1/health-profile', { headers: server.headers });
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body.profile, profile);

  const document = JSON.parse(readHealthFile(server.healthFile));
  assert.equal(document.version, HEALTH_FILE_VERSION);
  const ownerRef = healthOwnerRefFor(TOKEN_SECRET, IDENTITY);
  assert.deepEqual(Object.keys(document.profiles), [ownerRef]);
  assert.equal(isHealthOwnerRef(ownerRef), true);
  const text = readHealthFile(server.healthFile);
  assert.equal(text.includes(IDENTITY), false, 'persisted profile must never contain sub/openid');
  assert.equal(text.includes('openid'), false);
  assert.equal(text.includes('""'), false, 'empty strings must not be persisted');
});

test('invalid scalar fields fail with 400 and path-only error messages', async (t) => {
  const server = await startServer(t);
  const cases = [
    { body: { age: 0 }, field: /^age / },
    { body: { age: 1.5 }, field: /^age / },
    { body: { age: 131 }, field: /^age / },
    { body: { age: '72' }, field: /^age / },
    { body: { heightCm: 49 }, field: /^heightCm / },
    { body: { heightCm: 300 }, field: /^heightCm / },
    { body: { heightCm: 165.55 }, field: /^heightCm .*decimal/ },
    { body: { weightKg: 19 }, field: /^weightKg / },
    { body: { weightKg: 301 }, field: /^weightKg / },
    { body: { weightKg: 62.25 }, field: /^weightKg .*decimal/ },
    { body: { restingBloodPressure: '90/100' }, field: /greater than diastolic/ },
    { body: { restingBloodPressure: '150/170' }, field: /diastolic/ },
    { body: { restingBloodPressure: 'abc' }, field: /form systolic\/diastolic/ },
    { body: { fastingGlucose: '0.5' }, field: /\[1\.0, 40\.0\]/ },
    { body: { fastingGlucose: '6.55' }, field: /decimal string/ },
    { body: { fastingGlucose: 6.1 }, field: /decimal string/ },
    { body: { medicalHistory: 'x'.repeat(501) }, field: /medicalHistory .*500/ },
    { body: { mood: 'x'.repeat(201) }, field: /mood .*200/ },
    { body: { sleep: { hours: 25 } }, field: /sleep\.hours/ },
    { body: { sleep: { nightAwakenings: 2.5 } }, field: /sleep\.nightAwakenings/ },
    { body: { diet: { taste: 'sweet' } }, field: /diet\.taste/ },
    { body: { exercise: { timesPerWeek: 22 } }, field: /exercise\.timesPerWeek/ },
    { body: { smoking: 5 }, field: /smoking must be a string/ },
    { body: { updatedAt: 1790000000000 }, field: /updatedAt/ }
  ];
  for (const item of cases) {
    const response = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
      headers: server.headers,
      body: item.body
    });
    assert.equal(response.status, 400, JSON.stringify(item.body));
    assert.equal(response.body.error, 'invalid health profile');
    assert.ok(Array.isArray(response.body.fields) && response.body.fields.length > 0);
    assert.ok(
      response.body.fields.some((field) => item.field.test(field)),
      `expected a field matching ${item.field} for ${JSON.stringify(item.body)}, got ${JSON.stringify(response.body.fields)}`
    );
  }
  // 全部失败后不得写入任何资料。
  const fetched = await call(server.baseUrl, 'GET', '/api/v1/health-profile', { headers: server.headers });
  assert.deepEqual(fetched.body, { profile: null });
  assert.equal(fs.existsSync(server.healthFile), false);
});

test('unknown and identity fields are rejected and never persisted', async (t) => {
  const server = await startServer(t);
  // 先保存一份合法资料，作为"后续非法请求不得覆盖/污染"的基线。
  const baseline = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: validProfile()
  });
  assert.equal(baseline.status, 200);
  const beforeText = readHealthFile(server.healthFile);

  const identityFields = [
    'idCard', 'id_card', 'ID-CARD', 'idNumber', 'phone', 'mobile', 'address', 'name',
    'token', 'apiKey', 'api_key', 'password', 'iccid', 'wifiPassword', 'openid', 'ownerRef', 'sub'
  ];
  for (const field of identityFields) {
    const response = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
      headers: server.headers,
      body: { ...validProfile(), [field]: 'SENSITIVE-IDENTITY-VALUE' }
    });
    assert.equal(response.status, 400, field);
    assert.equal(response.body.error, 'invalid health profile');
    assert.ok(
      response.body.fields.some((item) => item === `unknown field: ${field}`),
      `${field}: ${JSON.stringify(response.body.fields)}`
    );
    assert.equal(response.text.includes('SENSITIVE-IDENTITY-VALUE'), false, field);
  }

  const unknown = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: { age: 72, secretNote: 'SENSITIVE-UNKNOWN-VALUE' }
  });
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body.fields, ['unknown field: secretNote']);
  assert.equal(unknown.text.includes('SENSITIVE-UNKNOWN-VALUE'), false);

  const nestedUnknown = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: { diet: { taste: 'light', sugar: 'SENSITIVE-NESTED' } }
  });
  assert.equal(nestedUnknown.status, 400);
  assert.deepEqual(nestedUnknown.body.fields, ['unknown field: diet.sugar']);
  assert.equal(nestedUnknown.text.includes('SENSITIVE-NESTED'), false);

  // 文件内容必须与基线完全一致：未知字段没有落盘。
  assert.equal(readHealthFile(server.healthFile), beforeText);
  const text = readHealthFile(server.healthFile);
  for (const marker of ['SENSITIVE-IDENTITY-VALUE', 'SENSITIVE-UNKNOWN-VALUE', 'SENSITIVE-NESTED', 'idCard', 'openid']) {
    assert.equal(text.includes(marker), false, marker);
  }
});

test('empty bodies, empty nested objects and empty strings are rejected', async (t) => {
  const server = await startServer(t);
  for (const body of [
    {},
    { medicalHistory: '   ', medications: '' },
    { sleep: {} },
    { diet: [] },
    { sleep: { hours: null, difficulty: null } }
  ]) {
    const response = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
      headers: server.headers,
      body
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error, 'invalid health profile');
    assert.ok(response.body.fields.length > 0);
  }
  const invalidJson = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: { ...server.headers, 'content-type': 'application/json' },
    body: '{not json'
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.error, 'invalid health profile');
  assert.deepEqual(invalidJson.body.fields, ['request body must be valid JSON']);
  assert.equal(fs.existsSync(server.healthFile), false);
});

test('oversized request bodies are rejected with 413 before validation', async (t) => {
  const server = await startServer(t);
  const oversized = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: { medicalHistory: 'x'.repeat(9000) }
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(oversized.body, { error: 'request body too large' });
  assert.equal(fs.existsSync(server.healthFile), false);
});

/* ------------------------------------------------------------ 隔离与重启 */

test('two guardian identities have isolated health profiles', async (t) => {
  const server = await startServer(t);
  const first = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: validProfile({ age: 72 })
  });
  assert.equal(first.status, 200);
  const otherHeaders = server.headersFor(OTHER_IDENTITY);
  const otherEmpty = await call(server.baseUrl, 'GET', '/api/v1/health-profile', { headers: otherHeaders });
  assert.deepEqual(otherEmpty.body, { profile: null });

  const second = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: otherHeaders,
    body: validProfile({ age: 66, medicalHistory: '糖尿病' })
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.profile.age, 66);

  const firstAgain = await call(server.baseUrl, 'GET', '/api/v1/health-profile', { headers: server.headers });
  assert.equal(firstAgain.body.profile.age, 72);
  const document = JSON.parse(readHealthFile(server.healthFile));
  assert.equal(Object.keys(document.profiles).length, 2);
  assert.equal(Object.keys(document.profiles).includes(healthOwnerRefFor(TOKEN_SECRET, IDENTITY)), true);
  assert.equal(Object.keys(document.profiles).includes(healthOwnerRefFor(TOKEN_SECRET, OTHER_IDENTITY)), true);
});

test('saved profiles survive a backend restart', async (t) => {
  const directory = tempDir(t);
  const healthFile = path.join(directory, 'health-state.json');
  const firstServer = await startServer(t, { directory, healthFile });
  const saved = await call(firstServer.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: firstServer.headers,
    body: validProfile({ age: 71 })
  });
  assert.equal(saved.status, 200);
  await firstServer.close();

  // 模拟重启：新的 HealthStore 从同一文件加载，新的 server 实例读取。
  const secondServer = await startServer(t, { directory, healthFile });
  const fetched = await call(secondServer.baseUrl, 'GET', '/api/v1/health-profile', {
    headers: secondServer.headers
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.profile.age, 71);
  assert.deepEqual(fetched.body.profile, saved.body.profile);
});

/* ------------------------------------------------------------ 存储失败 */

test('missing health storage or owner-ref capability fails closed with 503', async (t) => {
  const noStore = await startServer(t, { server: { healthStore: null } });
  const get = await call(noStore.baseUrl, 'GET', '/api/v1/health-profile', { headers: noStore.headers });
  assert.equal(get.status, 503);
  assert.deepEqual(get.body, { error: 'storage unavailable' });
  const put = await call(noStore.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: noStore.headers,
    body: validProfile()
  });
  assert.equal(put.status, 503);

  const noOwnerRef = await startServer(t, { server: { healthOwnerRefForIdentity: null } });
  const get2 = await call(noOwnerRef.baseUrl, 'GET', '/api/v1/health-profile', { headers: noOwnerRef.headers });
  assert.equal(get2.status, 503);
  assert.deepEqual(get2.body, { error: 'storage unavailable' });
});

test('storage write failures converge to 503 without leaking paths or profile content', async (t) => {
  const directory = tempDir(t);
  const state = { fail: false };
  const atomicWriter = (target, text) => {
    if (state.fail) {
      const error = new Error('C:\\secret\\deploy\\path\\health-state.json cannot be written');
      error.code = 'EIO';
      throw error;
    }
    fs.writeFileSync(target, text);
  };
  const healthStore = new HealthStore({ filePath: path.join(directory, 'health-state.json'), atomicWriter });
  const server = await startServer(t, { directory, healthStore });
  assert.equal((await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: validProfile({ age: 72 })
  })).status, 200);

  const calls = captureConsole(t);
  state.fail = true;
  const failed = await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: validProfile({ age: 73, medicalHistory: 'SENSITIVE-FAILURE-TEXT' })
  });
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, { error: 'storage unavailable' });
  assert.equal(failed.text.includes('SENSITIVE-FAILURE-TEXT'), false);
  assert.equal(failed.text.includes('secret'), false);

  const saveLogs = calls.filter((entry) => entry.text.includes('HEALTH_PROFILE_SAVE_FAILED'));
  assert.equal(saveLogs.length, 1);
  assert.equal(saveLogs[0].text, '[backend] HEALTH_PROFILE_SAVE_FAILED code=EIO');
  assert.equal(calls.some((entry) => entry.text.includes('SENSITIVE-FAILURE-TEXT')), false);
  assert.equal(calls.some((entry) => entry.text.includes('secret')), false);

  // 写失败后内存/磁盘都保持旧资料；其它接口完全不受影响。
  const fetched = await call(server.baseUrl, 'GET', '/api/v1/health-profile', { headers: server.headers });
  assert.equal(fetched.body.profile.age, 72);
  const overview = await call(server.baseUrl, 'GET', '/api/v1/overview', { headers: server.headers });
  assert.equal(overview.status, 200);
});

test('health profile requests never log when they succeed or fail validation', async (t) => {
  const server = await startServer(t);
  const calls = captureConsole(t);
  await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: validProfile()
  });
  await call(server.baseUrl, 'GET', '/api/v1/health-profile', { headers: server.headers });
  await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: { age: 999, idCard: 'SENSITIVE' }
  });
  assert.deepEqual(calls, []);
});

/* ------------------------------------------------------------ 域分离 / 脱敏 */

test('health owner refs use a domain-separated h1_ HMAC, never the comms r1_ ref', () => {
  const subject = 'openid-domain-separation';
  const healthRef = healthOwnerRefFor(TOKEN_SECRET, subject);
  const commsRef = ownerRefFor(TOKEN_SECRET, subject);
  assert.match(healthRef, /^h1_[A-Za-z0-9_-]{43}$/);
  assert.match(commsRef, /^r1_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(healthRef, commsRef);
  assert.equal(isHealthOwnerRef(healthRef), true);
  assert.equal(isHealthOwnerRef(commsRef), false);
  assert.equal(healthOwnerRefFor(TOKEN_SECRET, subject), healthRef, 'deterministic');
  assert.equal(healthOwnerRefFor(TOKEN_SECRET, subject.trim()), healthRef, 'subject is trimmed');
  assert.notEqual(healthOwnerRefFor(TOKEN_SECRET, `${subject}-2`), healthRef);
  assert.notEqual(
    healthOwnerRefFor('another-health-test-secret-at-least-32-chars', subject),
    healthRef,
    'different secret must yield different ref'
  );
  assert.throws(() => healthOwnerRefFor('short', subject), /at least 32 characters/);
  assert.throws(() => healthOwnerRefFor(TOKEN_SECRET, '   '), /subject is required/);
  assert.equal(healthRef.includes(subject), false);
});

test('describeHealthProfile reports only field names and text size (no values)', () => {
  const described = describeHealthProfile(validProfile({ medicalHistory: 'SENSITIVE-TEXT' }));
  assert.ok(described.fields.includes('medicalHistory'));
  assert.equal(JSON.stringify(described).includes('SENSITIVE-TEXT'), false);
  assert.ok(described.textBytes > 0);
  assert.deepEqual(describeHealthProfile(null), { fields: [], textBytes: 0 });
});

/* ------------------------------------------------------------ 既有链路不受影响 */

test('registering health routes does not change existing device/alarm/ACK behaviour', async (t) => {
  const server = await startServer(t);
  // 保存健康资料不应影响既有接口。
  assert.equal((await call(server.baseUrl, 'PUT', '/api/v1/health-profile', {
    headers: server.headers,
    body: validProfile()
  })).status, 200);

  const status = {
    deviceId: 'esp32-health-smoke',
    room: '卧室',
    online: true,
    state: 'ALARM',
    ts: 1791609077775,
    sensors: { motion: { countToday: 3 } },
    alarm: { id: 'alarm-health-smoke', type: 'NO_MOTION', countToday: 1 }
  };
  const ingest = await fetch(`${server.baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(status)
  });
  assert.equal(ingest.status, 202);

  const devices = await call(server.baseUrl, 'GET', '/api/v1/devices', { headers: server.headers });
  assert.equal(devices.status, 200);
  assert.ok(devices.body.devices.some((device) => device.deviceId === status.deviceId));

  const alerts = await call(server.baseUrl, 'GET', '/api/v1/alerts', { headers: server.headers });
  assert.equal(alerts.status, 200);
  assert.ok(alerts.body.alerts.some((alert) => alert.alarmId === 'alarm-health-smoke'));

  const ack = await call(server.baseUrl, 'POST', '/api/v1/alerts/alarm-health-smoke/ack', {
    headers: server.headers,
    body: { note: '健康路由冒烟测试' }
  });
  assert.equal(ack.status, 202);
  assert.equal(ack.body.accepted, true);
  assert.equal(ack.body.status, 'PENDING');

  const doorEvents = await call(server.baseUrl, 'GET', '/api/v1/door-events', { headers: server.headers });
  assert.equal(doorEvents.status, 200);
  assert.ok(Array.isArray(doorEvents.body.events));

  const communications = await call(server.baseUrl, 'GET', '/api/v1/communications/messages', {
    headers: server.headers
  });
  // 未注入 comms ownerRef 能力时既有语义是 503，健康功能不得改变它。
  assert.equal(communications.status, 503);
});
