'use strict';

/**
 * activity-api.test.js — 活动规律报告 HTTP 集成测试
 *
 * 覆盖：Bearer 鉴权与 401、非法 scope/date 400、响应契约字段完整性、
 * 无数据必须 null 不能是 0、previous_zero、周/月范围、趋势下降中性文案、
 * 摄取 202 与活动写盘失败隔离、未配置活动存储 503、
 * ActivityStore 与 PersistentStore（schema 不受影响）各自独立落盘与重启恢复、
 * main.js 装配 / HOUSEHOLD_TIMEZONE fail-closed。
 *
 * 全部使用本地临时目录与临时测试密钥，不访问网络、不读取真实密钥。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ActivityStore, ACTIVITY_FILE_VERSION } = require('../src/activity-store');
const { createSessionToken } = require('../src/auth');
const { MAX_SAMPLE_GAP_MS, createHouseholdClock } = require('../src/activity');
const { createRuntime } = require('../src/main');
const { PersistentStore, SCHEMA_VERSION } = require('../src/persistent-store');
const { createApiServer } = require('../src/server');
const { MemoryStore } = require('../src/store');

const TOKEN_SECRET = 'activity-api-test-token-secret-at-least-32-characters';
const INGEST_KEY = 'activity-api-test-ingest-key-at-least-32-characters';
const IDENTITY = 'openid-activity-api-test';
const TZ = 'Asia/Shanghai';
const clock = createHouseholdClock(TZ);
const DAY = '2026-10-26';
const FIXED_NOW = clock.startOfDay('2026-10-26') + 12 * 3600_000; // 2026-10-26 12:00 (+08)

const TOP_LEVEL_KEYS = [
  'generatedAt', 'timezone', 'scope', 'today', 'selectedDate', 'range', 'dataSince', 'historyNote',
  'selected', 'previous', 'comparison', 'days', 'summary', 'hourly', 'devices', 'trend', 'disclaimer'
];
const SELECTED_KEYS = [
  'date', 'count', 'status', 'samples', 'invalidSamples', 'firstTs', 'lastTs', 'maxGapMs', 'coverageRatio', 'hourly'
];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function motionStatus(countToday, extra = {}) {
  const sensors = countToday === undefined
    ? (extra.sensors || {})
    : { motion: { lastActiveTs: 0, countToday, ...(extra.motion || {}) } };
  return { deviceId: extra.deviceId || 'dayu200-living', room: extra.room || '客厅', sensors };
}

/** 预先向独立活动存储写入“覆盖率足够”的一天（用于 comparison/trend/range 用例）。 */
function seedDay(store, dateKey, options = {}) {
  const increments = options.increments === undefined ? 0 : options.increments;
  const spanHours = options.spanHours === undefined ? 12 : options.spanHours;
  const deviceId = options.deviceId || 'dayu200-living';
  const step = MAX_SAMPLE_GAP_MS;
  const gaps = Math.max(1, Math.round((spanHours * 3600_000) / step));
  let timestamp = clock.startOfDay(dateKey);
  let countToday = 0;
  store.recordStatus(motionStatus(countToday, { deviceId }), timestamp);
  for (let index = 1; index <= gaps; index += 1) {
    timestamp += step;
    if (index <= increments) countToday += 1;
    store.recordStatus(motionStatus(countToday, { deviceId }), timestamp);
  }
  return timestamp;
}

async function startServer(t, options) {
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (identity) => identity === IDENTITY,
    ...options
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  // 关闭必须是幂等的：测试里有“先手动关闭、模拟重启”的用例，
  // 若 t.after 再关一次会抛 ERR_SERVER_NOT_RUNNING，并让后面的清理钩子（以及
  // 后续用例的 server.close）不再执行，导致监听句柄泄漏、整个测试进程无法退出。
  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    created.server.close(() => resolve());
  });
  t.after(close);
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  return {
    baseUrl,
    server: created.server,
    close,
    headers: {
      authorization: `Bearer ${createSessionToken(IDENTITY, TOKEN_SECRET)}`,
      'content-type': 'application/json'
    }
  };
}

async function ingest(baseUrl, status) {
  return fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(status)
  });
}

async function getReport(baseUrl, headers, query = '') {
  const response = await fetch(`${baseUrl}/api/v1/activity/report${query}`, { headers });
  const body = await response.json();
  return { status: response.status, body };
}

/* ------------------------------------------------------------ 鉴权与参数校验 */

test('activity report uses the same Bearer segment as /api/v1/devices', async (t) => {
  const directory = tempDir(t);
  const activityStore = new ActivityStore({
    filePath: path.join(directory, 'activity-state.json'),
    timezone: TZ,
    now: () => FIXED_NOW
  });
  const { baseUrl, headers } = await startServer(t, { activityStore, store: new MemoryStore() });

  assert.equal((await fetch(`${baseUrl}/api/v1/activity/report`)).status, 401, '无 token 必须 401');
  assert.equal((await fetch(`${baseUrl}/api/v1/activity/report`, {
    headers: { authorization: 'Bearer not-a-valid-token' }
  })).status, 401);
  const ok = await getReport(baseUrl, headers, `?scope=day&date=${DAY}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.timezone, TZ);
  assert.equal(ok.body.selectedDate, DAY);
});

test('an unknown household identity is forbidden (403) on the activity report', async (t) => {
  const directory = tempDir(t);
  const activityStore = new ActivityStore({ filePath: path.join(directory, 'a.json'), timezone: TZ });
  const { baseUrl } = await startServer(t, { activityStore, store: new MemoryStore(), authorizeIdentity: () => false });
  const response = await fetch(`${baseUrl}/api/v1/activity/report`, {
    headers: { authorization: `Bearer ${createSessionToken('openid-not-allowed', TOKEN_SECRET)}` }
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'forbidden' });
});

test('invalid scope and invalid calendar dates are rejected with 400', async (t) => {
  const directory = tempDir(t);
  const activityStore = new ActivityStore({ filePath: path.join(directory, 'a.json'), timezone: TZ, now: () => FIXED_NOW });
  const { baseUrl, headers } = await startServer(t, { activityStore, store: new MemoryStore() });

  for (const query of ['?scope=year', '?scope=DAY', '?scope=week&date=2026-02-30', '?scope=day&date=2026-13-01',
    '?date=2026-1-1', '?date=abc', '?date=2026-10-26T00:00:00Z']) {
    const result = await getReport(baseUrl, headers, query);
    assert.equal(result.status, 400, `${query} 必须 400`);
    assert.equal(typeof result.body.error, 'string');
  }
  for (const query of ['?scope=day', '?scope=week&date=2026-10-26', '?scope=month&date=2026-10-26']) {
    assert.equal((await getReport(baseUrl, headers, query)).status, 200, `${query} 必须 200`);
  }
});

/* ------------------------------------------------------------ 契约与摄取接线 */

test('HTTP ingest records PIR increments and the report honours the full response contract', async (t) => {
  const directory = tempDir(t);
  // 固定时钟：覆盖率取决于“已过了多少自然日时间”，用真实时钟会让本用例随运行时刻漂移。
  const activityStore = new ActivityStore({
    filePath: path.join(directory, 'activity-state.json'), timezone: TZ, now: () => FIXED_NOW
  });
  const { baseUrl, headers } = await startServer(t, { activityStore, store: new MemoryStore() });

  assert.equal((await ingest(baseUrl, { ...motionStatus(5), state: 'NORMAL' })).status, 202);
  assert.equal((await ingest(baseUrl, { ...motionStatus(8), state: 'NORMAL' })).status, 202);
  // 厨房没有 PIR：载荷不含 motion，不得被写成 0 次活动。
  assert.equal((await ingest(baseUrl, { deviceId: 'esp32-kitchen', room: '厨房', state: 'NORMAL', sensors: { gas: { ok: true } } })).status, 202);

  const today = DAY;
  const result = await getReport(baseUrl, headers, `?scope=day&date=${today}`);
  assert.equal(result.status, 200);
  const body = result.body;
  assert.equal(Object.keys(body).length, TOP_LEVEL_KEYS.length);
  for (const key of TOP_LEVEL_KEYS) assert.ok(Object.prototype.hasOwnProperty.call(body, key), `缺少字段 ${key}`);
  assert.deepEqual(Object.keys(body.selected).sort(), [...SELECTED_KEYS].sort());
  assert.equal(typeof body.generatedAt, 'number');
  assert.equal(body.generatedAt, FIXED_NOW);
  assert.equal(body.timezone, TZ);
  assert.equal(body.scope, 'day');
  assert.equal(body.today, today);
  assert.equal(body.selectedDate, today);
  assert.deepEqual(Object.keys(body.range), ['from', 'to', 'days']);
  assert.equal(body.range.to, today);
  // day 范围的 range/summary 只能是“当天”，不能把 7 天趋势序列当成查询窗口。
  assert.deepEqual(body.range, { from: today, to: today, days: 1 });
  assert.equal(body.summary.days, 1);
  // days[] 是趋势序列（day/week 固定 7 天），与 range.days 语义不同。
  assert.equal(body.days.length, 7);
  assert.equal(body.days[6].date, today);
  assert.equal(body.selected.date, today);
  assert.equal(body.selected.count, 3, '基线 5 -> 8 必须只计 3 次增量');
  assert.equal(body.selected.samples, 2);
  assert.equal(body.selected.invalidSamples, 0);
  assert.equal(body.selected.hourly.length, 24);
  assert.equal(body.selected.count, body.hourly.reduce((sum, value) => sum + (value === null ? 0 : value), 0));
  assert.equal(body.summary.total, 3, 'day 汇总只能等于当天次数');
  assert.equal(body.summary.daysWithData, 1);
  assert.equal(body.previous.date, body.days[5].date);
  assert.equal(body.previous.count, null, '前一天没有任何样本 -> null，不能是 0');
  assert.equal(body.comparison.state, 'previous_missing');
  assert.equal(body.comparison.delta, null);
  assert.equal(body.comparison.pct, null);
  assert.equal(body.devices.length, 2);
  const living = body.devices.find((item) => item.deviceId === 'dayu200-living');
  assert.deepEqual(living, {
    deviceId: 'dayu200-living', room: '客厅', hasMotionSensor: true, count: 3, status: 'insufficient'
  });
  const kitchen = body.devices.find((item) => item.deviceId === 'esp32-kitchen');
  assert.deepEqual(kitchen, {
    deviceId: 'esp32-kitchen', room: '厨房', hasMotionSensor: false, count: null, status: 'no_data'
  });
  assert.equal(body.trend.state, 'insufficient');
  assert.equal(typeof body.historyNote, 'string');
  assert.match(body.disclaimer, /不等于人数/);
  assert.match(body.disclaimer, /无数据不等于没有活动/);
  assert.match(body.disclaimer, /仅从功能启用后开始积累/);
  // 只新增接口：既有 /api/v1/devices 的响应字段不变。
  const devices = await (await fetch(`${baseUrl}/api/v1/devices`, { headers })).json();
  assert.deepEqual(
    Object.keys(devices.devices[0]).sort(),
    ['csq', 'deviceId', 'id', 'lastSeenTs', 'location', 'monitorOnline', 'name', 'online', 'roomId', 'roomName', 'sensors', 'state']
  );
});

test('no data is reported as null everywhere and never as zero activity', async (t) => {
  const directory = tempDir(t);
  const activityStore = new ActivityStore({ filePath: path.join(directory, 'a.json'), timezone: TZ, now: () => FIXED_NOW });
  const { baseUrl, headers } = await startServer(t, { activityStore, store: new MemoryStore() });
  // 只有一台无 PIR 设备：设备存在，但活动数据必须为空。
  assert.equal((await ingest(baseUrl, { deviceId: 'esp32-kitchen', room: '厨房', state: 'NORMAL' })).status, 202);

  const result = await getReport(baseUrl, headers, `?scope=day&date=${DAY}`);
  const body = result.body;
  assert.equal(body.selected.count, null);
  assert.equal(body.selected.samples, 0);
  assert.equal(body.selected.status, 'no_data');
  assert.equal(body.selected.coverageRatio, null);
  assert.ok(body.hourly.every((value) => value === null));
  assert.equal(body.summary.total, null, '无数据时 summary.total 必须是 null');
  assert.equal(body.summary.daysWithData, 0);
  assert.ok(body.days.every((item) => item.count === null && item.status === 'no_data'));
  assert.equal(body.dataSince, 0);
  assert.equal(body.trend.state, 'insufficient');
  assert.deepEqual(body.devices, [{
    deviceId: 'esp32-kitchen', room: '厨房', hasMotionSensor: false, count: null, status: 'no_data'
  }]);
});

/* ------------------------------------------------------------ comparison / 范围 / trend */

test('previous_zero comparison keeps pct null and never divides by zero', async (t) => {
  const directory = tempDir(t);
  const activityStore = new ActivityStore({
    filePath: path.join(directory, 'a.json'),
    timezone: TZ,
    now: () => FIXED_NOW,
    atomicWriter: () => { /* 预置数据不需要真实落盘 */ }
  });
  const store = new MemoryStore();
  seedDay(activityStore, '2026-10-24', { increments: 0 }); // 有样本、0 次活动
  seedDay(activityStore, '2026-10-25', { increments: 3 });
  store.ingest({ deviceId: 'dayu200-living', room: '客厅', state: 'NORMAL' }, clock.startOfDay('2026-10-24'));
  const { baseUrl, headers } = await startServer(t, { activityStore, store });

  const body = (await getReport(baseUrl, headers, '?scope=day&date=2026-10-25')).body;
  assert.equal(body.previous.date, '2026-10-24');
  assert.equal(body.previous.count, 0);
  assert.equal(body.selected.count, 3);
  assert.equal(body.comparison.state, 'previous_zero');
  assert.equal(body.comparison.pct, null);
  assert.equal(body.comparison.delta, 3);
  assert.match(body.comparison.text, /0 次/);
});

test('week and month scopes expose the exact explicit range', async (t) => {
  const directory = tempDir(t);
  const activityStore = new ActivityStore({
    filePath: path.join(directory, 'a.json'),
    timezone: TZ,
    now: () => FIXED_NOW,
    atomicWriter: () => { /* 预置数据不需要真实落盘 */ }
  });
  seedDay(activityStore, '2026-10-24', { increments: 2 });
  seedDay(activityStore, '2026-10-25', { increments: 4 });
  const { baseUrl, headers } = await startServer(t, { activityStore, store: new MemoryStore() });

  const week = (await getReport(baseUrl, headers, '?scope=week&date=2026-10-26')).body;
  assert.equal(week.scope, 'week');
  assert.deepEqual(week.range, { from: '2026-10-20', to: '2026-10-26', days: 7 });
  assert.equal(week.days.length, 7);
  assert.equal(week.days[6].date, '2026-10-26');
  assert.equal(week.summary.days, 7);
  assert.equal(week.previous.date, '2026-10-19');

  const month = (await getReport(baseUrl, headers, '?scope=month&date=2026-10-26')).body;
  assert.equal(month.scope, 'month');
  assert.deepEqual(month.range, { from: '2026-09-27', to: '2026-10-26', days: 30 });
  assert.equal(month.days.length, 30);
  assert.equal(month.summary.days, 30);
  // seedDay 预置了 2026-10-24 / 2026-10-25，两天都落在滚动 30 天窗口内。
  assert.equal(month.summary.daysWithData, 2);
  assert.equal(month.summary.total, 2 + 4);
  assert.equal(month.hourly.length, 24);
});

test('the 3-day decline trend returns a neutral message over HTTP, never a diagnosis', async (t) => {
  const directory = tempDir(t);
  const activityStore = new ActivityStore({
    filePath: path.join(directory, 'a.json'),
    timezone: TZ,
    now: () => FIXED_NOW,
    atomicWriter: () => { /* 预置数据不需要真实落盘 */ }
  });
  seedDay(activityStore, '2026-10-23', { increments: 10 });
  seedDay(activityStore, '2026-10-24', { increments: 6 });
  seedDay(activityStore, '2026-10-25', { increments: 3 });
  const { baseUrl, headers } = await startServer(t, { activityStore, store: new MemoryStore() });

  const result = await getReport(baseUrl, headers, '?scope=day&date=2026-10-25');
  assert.equal(result.status, 200);
  assert.equal(result.body.trend.state, 'down');
  assert.match(result.body.trend.text, /下降/);
  assert.match(result.body.trend.text, /联系/);
  const serialized = JSON.stringify(result.body);
  assert.doesNotMatch(serialized, /疾病|诊断|痴呆|患病/);
  assert.equal(result.body.comparison.state, 'comparable');
  assert.equal(result.body.comparison.delta, -3);
});

/* ------------------------------------------------------------ 失败隔离 / 未配置 */

test('activity store write failures never change ingest semantics (still 202)', async (t) => {
  const directory = tempDir(t);
  const activityStore = new ActivityStore({
    filePath: path.join(directory, 'a.json'),
    timezone: TZ,
    atomicWriter: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
  });
  const store = new MemoryStore();
  const { baseUrl, headers } = await startServer(t, { activityStore, store });

  const first = await ingest(baseUrl, { ...motionStatus(5), state: 'NORMAL' });
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: true, deviceId: 'dayu200-living' });
  const second = await ingest(baseUrl, { ...motionStatus(8), state: 'NORMAL' });
  assert.equal(second.status, 202, '活动写盘失败绝不改变设备状态摄取的 202 语义');
  // 设备状态本身仍然成功落库（内存 MemoryStore），活动统计保持回滚后的旧状态。
  const devices = await (await fetch(`${baseUrl}/api/v1/devices`, { headers })).json();
  assert.equal(devices.devices.length, 1);
  const report = (await getReport(baseUrl, headers, `?scope=day&date=${activityStore.clock.dateKey(Date.now())}`)).body;
  assert.equal(report.selected.count, null, '写盘失败必须回滚内存，不能留下虚假活动');
});

test('the report route returns 503 when no activity store is configured', async (t) => {
  const { baseUrl, headers } = await startServer(t, { store: new MemoryStore() });
  const response = await fetch(`${baseUrl}/api/v1/activity/report`, { headers });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'activity report unavailable' });
});

/* ------------------------------------------------------------ 独立持久化 / 重启 */

test('activity persistence is independent of the main schema v6 snapshot and survives restarts', async (t) => {
  const directory = tempDir(t);
  const dataFile = path.join(directory, 'backend-state.json');
  const activityFile = path.join(directory, 'activity-state.json');
  const createStores = () => ({
    store: new PersistentStore({ filePath: dataFile }),
    activityStore: new ActivityStore({ filePath: activityFile, timezone: TZ })
  });

  const first = createStores();
  const serverOne = await startServer(t, first);
  assert.equal((await ingest(serverOne.baseUrl, { ...motionStatus(5), state: 'ALARM', alarm: { id: 'alarm-activity-1', type: 'NO_MOTION', countToday: 1 } })).status, 202);
  assert.equal((await ingest(serverOne.baseUrl, { ...motionStatus(8), state: 'NORMAL' })).status, 202);

  // 主快照仍是 PersistentStore 自己的 schema，绝不能被活动功能塞入 activity 字段。
  const mainDocument = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(mainDocument.schemaVersion, SCHEMA_VERSION);
  assert.equal(Object.prototype.hasOwnProperty.call(mainDocument, 'activity'), false, '主快照 schema 未被活动功能触碰');
  assert.equal(Object.prototype.hasOwnProperty.call(mainDocument.devices[0], 'activity'), false);
  // 活动状态写在独立文件里，且不含测试密钥。
  const activityDocument = JSON.parse(fs.readFileSync(activityFile, 'utf8'));
  assert.equal(activityDocument.version, ACTIVITY_FILE_VERSION);
  assert.equal(activityDocument.activity.timezone, TZ);
  assert.equal(activityDocument.activity.devices[0].baseline.countToday, 8);
  for (const document of [JSON.stringify(mainDocument), JSON.stringify(activityDocument)]) {
    assert.equal(document.includes(TOKEN_SECRET), false);
    assert.equal(document.includes(INGEST_KEY), false);
  }
  // 用幂等的 close() 关闭（t.after 里同样会调用一次，重复关闭必须无害）。
  await serverOne.close();

  // 重启：主存储与活动存储分别从各自文件恢复，报告数值一致。
  const second = createStores();
  const serverTwo = await startServer(t, second);
  const today = second.activityStore.clock.dateKey(Date.now());
  const restored = (await getReport(serverTwo.baseUrl, serverTwo.headers, `?scope=day&date=${today}`)).body;
  assert.equal(restored.selected.count, 3);
  assert.equal(restored.selected.samples, 2);
  assert.equal(restored.dataSince, restored.selected.firstTs);
  assert.equal(restored.devices[0].room, '客厅', '主存储恢复的设备 room 仍用于报告展示');
  // 重启后继续上报：必须沿用已持久化基线 8（+3），而不是重新建基线。
  assert.equal((await ingest(serverTwo.baseUrl, { ...motionStatus(11), state: 'NORMAL' })).status, 202);
  const continued = (await getReport(serverTwo.baseUrl, serverTwo.headers, `?scope=day&date=${today}`)).body;
  assert.equal(continued.selected.count, 6);
});

/* ------------------------------------------------------------ main.js 装配 */

test('main runtime wires the activity store and fails closed on an invalid HOUSEHOLD_TIMEZONE', (t) => {
  const directory = tempDir(t);
  const baseEnv = {
    BACKEND_DATA_FILE: path.join(directory, 'state.json'),
    BACKEND_EVIDENCE_DIR: path.join(directory, 'evidence'),
    API_TOKEN_SECRET: 'activity-runtime-token-secret-at-least-32-characters',
    INGEST_KEY: 'activity-runtime-ingest-key-at-least-32-characters',
    APP_GUARDIAN_ID: 'family-guardian',
    APP_GUARDIAN_PASSWORD: 'activity-runtime-app-password-at-least-32-characters'
  };

  const runtime = createRuntime(baseEnv);
  assert.ok(runtime.activityStore instanceof ActivityStore);
  assert.equal(runtime.householdTimezone, 'Asia/Shanghai');
  assert.equal(runtime.activityStore.clock.timeZone, 'Asia/Shanghai');
  assert.equal(runtime.activityFile, path.resolve(path.join(directory, 'activity-state.json')), '默认与主数据文件同目录');
  assert.equal(fs.existsSync(runtime.activityFile), false, '启动不得创建活动状态文件');
  assert.deepEqual(fs.readdirSync(directory), ['evidence'], '就绪探测不得留下文件');

  assert.throws(() => createRuntime({ ...baseEnv, HOUSEHOLD_TIMEZONE: 'Mars/Phobos' }), /HOUSEHOLD_TIMEZONE/);
  assert.throws(() => createRuntime({ ...baseEnv, HOUSEHOLD_TIMEZONE: 'not a timezone' }), /HOUSEHOLD_TIMEZONE/);

  const customDirectory = tempDir(t);
  const custom = createRuntime({
    ...baseEnv,
    BACKEND_DATA_FILE: path.join(customDirectory, 'state.json'),
    BACKEND_EVIDENCE_DIR: path.join(customDirectory, 'evidence'),
    BACKEND_ACTIVITY_FILE: path.join(customDirectory, 'custom-activity.json'),
    HOUSEHOLD_TIMEZONE: 'America/New_York'
  });
  assert.equal(custom.activityFile, path.resolve(path.join(customDirectory, 'custom-activity.json')));
  assert.equal(custom.householdTimezone, 'America/New_York');
  assert.equal(custom.activityStore.clock.timeZone, 'America/New_York');
});
