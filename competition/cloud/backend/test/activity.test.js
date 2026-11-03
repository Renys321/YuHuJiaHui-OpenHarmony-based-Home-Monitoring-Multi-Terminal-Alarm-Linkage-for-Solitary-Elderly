'use strict';

/**
 * activity.test.js — PIR 活动聚合单元测试（纯内存注入写入器 + 少量真实落盘）
 *
 * 覆盖：家庭时区切日/切小时、首次基线、正增量、重复上报、计数回退 reset、
 * 08:00 中途重置、23:59→00:00 跨日、hourly 只按到达小时累加（不回填历史）、
 * 无 PIR、非法 countToday、coverage 缺口与阈值、400 天保留上限、
 * 趋势三态与中性文案、comparison 各状态、严格加载校验、原子写失败回滚、
 * 真实文件重启恢复。测试全部在本机临时目录/内存中完成，不访问网络、不使用真实密钥。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ActivityStore, ACTIVITY_FILE_VERSION } = require('../src/activity-store');
const {
  COVERAGE_OK_RATIO,
  MAX_SAMPLE_GAP_MS,
  RETENTION_DAYS,
  activityToDocument,
  addDaysKey,
  createHouseholdClock,
  parseHouseholdTimezone
} = require('../src/activity');

const TZ = 'Asia/Shanghai';
const DAY = '2026-10-26';
const clock = createHouseholdClock(TZ);
const NOW = clock.startOfDay(DAY) + 12 * 3600_000; // 2026-10-26 12:00 (Asia/Shanghai)

const LIVING = 'dayu200-living';
const KITCHEN = 'esp32-kitchen';

/** 设备状态载荷（只带活动聚合需要的 deviceId/sensors；服务端真实 status 还含别的字段）。 */
function motionStatus(countToday, extra = {}) {
  const sensors = countToday === undefined
    ? (extra.sensors || {})
    : { motion: { lastActiveTs: 0, countToday, ...(extra.motion || {}) }, ...(extra.sensors || {}) };
  return { deviceId: extra.deviceId || LIVING, room: extra.room || '客厅', sensors };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 默认用内存写入器捕获 JSON 文本，避免每个样本都 fsync（几百次落盘会把测试拖慢）；
 * 需要验证真实原子写的用例显式传 realFile: true。
 */
function createStore(t, options = {}) {
  const dir = tempDir(t);
  const holder = { text: null, writes: 0, fail: false };
  const filePath = path.join(dir, 'activity-state.json');
  const store = new ActivityStore({
    filePath,
    timezone: TZ,
    now: () => NOW,
    atomicWriter: (target, text) => {
      if (holder.fail) throw new Error('disk full');
      holder.writes += 1;
      holder.text = text;
    },
    ...options
  });
  store.$writer = holder;
  store.$filePath = filePath;
  store.$dir = dir;
  return store;
}

function createRealStore(t, options = {}) {
  const dir = tempDir(t);
  const filePath = path.join(dir, 'activity-state.json');
  return new ActivityStore({ filePath, timezone: TZ, now: () => NOW, ...options });
}

function report(store, options = {}) {
  return store.getActivityReport(
    { scope: options.scope || 'day', date: options.date === undefined ? DAY : options.date },
    [
      { deviceId: LIVING, room: '客厅' },
      { deviceId: KITCHEN, room: '厨房' }
    ]
  );
}

/** 某天的活动状态文档（用于断言 resets/hourly 这类不进公开报告的内部字段）。 */
function documentOf(store) {
  return activityToDocument(store.activity);
}

function dayDoc(store, deviceId, dateKey) {
  const device = documentOf(store).devices.find((item) => item.deviceId === deviceId);
  assert.ok(device, `device ${deviceId} 必须存在`);
  return device.days.find((item) => item.date === dateKey) || null;
}

/**
 * 往某一天塞满“覆盖率足够”的样本：每 MAX_SAMPLE_GAP_MS 一个样本，
 * 前 increments 个样本各 +1，其余样本累计值不变。
 * 过去某天的窗口是完整 24h，因此 spanHours=12 时 coverageRatio = 0.5 = ok 阈值。
 */
function seedDay(store, deviceId, dateKey, options = {}) {
  const increments = options.increments === undefined ? 0 : options.increments;
  const spanHours = options.spanHours === undefined ? 12 : options.spanHours;
  const startHour = options.startHour === undefined ? 0 : options.startHour;
  const step = MAX_SAMPLE_GAP_MS;
  const gaps = Math.max(1, Math.round((spanHours * 3600_000) / step));
  let timestamp = clock.startOfDay(dateKey) + startHour * 3600_000;
  let countToday = 0;
  store.recordStatus(motionStatus(countToday, { deviceId }), timestamp);
  for (let index = 1; index <= gaps; index += 1) {
    timestamp += step;
    if (index <= increments) countToday += 1;
    store.recordStatus(motionStatus(countToday, { deviceId }), timestamp);
  }
  return timestamp;
}

/* ------------------------------------------------------------ 家庭时区 */

test('HOUSEHOLD_TIMEZONE defaults to Asia/Shanghai, canonicalizes and fails closed on invalid values', () => {
  assert.equal(parseHouseholdTimezone(undefined), 'Asia/Shanghai');
  assert.equal(parseHouseholdTimezone(''), 'Asia/Shanghai');
  assert.equal(parseHouseholdTimezone('   '), 'Asia/Shanghai');
  assert.equal(parseHouseholdTimezone('asia/shanghai'), 'Asia/Shanghai');
  assert.equal(parseHouseholdTimezone('UTC'), 'UTC');
  assert.throws(() => parseHouseholdTimezone('Mars/Phobos'), /HOUSEHOLD_TIMEZONE/);
  assert.throws(() => parseHouseholdTimezone('not a timezone'), /HOUSEHOLD_TIMEZONE/);
  assert.throws(() => parseHouseholdTimezone(42), /HOUSEHOLD_TIMEZONE/);
  assert.throws(() => new ActivityStore({ filePath: '', timezone: TZ }), /filePath/);
});

test('days and hours are cut by the household timezone, not by UTC or the server local time', () => {
  // 2026-10-26T15:59:59Z = 2026-10-26 23:59:59 (+08)，下一秒就是家庭时区的次日 0 点。
  const lastSecond = Date.UTC(2026, 9, 26, 15, 59, 59);
  assert.equal(clock.dateKey(lastSecond), '2026-10-26');
  assert.equal(clock.hour(lastSecond), 23);
  assert.equal(clock.dateKey(lastSecond + 1000), '2026-10-27');
  assert.equal(clock.hour(lastSecond + 1000), 0);
  // UTC 时区下同一时刻仍是 10-26 15:59，说明切日确实来自家庭时区配置。
  const utcClock = createHouseholdClock('UTC');
  assert.equal(utcClock.dateKey(lastSecond), '2026-10-26');
  assert.equal(utcClock.hour(lastSecond), 15);
  // 本地 0 点换算：Asia/Shanghai 的 2026-10-27 00:00 就是 UTC 2026-10-26T16:00:00Z。
  assert.equal(clock.startOfDay('2026-10-27'), Date.UTC(2026, 9, 26, 16, 0, 0));
  assert.equal(addDaysKey('2026-10-31', 1), '2026-11-01');
});

test('a sample is attributed to the household day of its arrival time (UTC date differs)', (t) => {
  const store = createStore(t);
  // 2026-10-26T16:30:00Z = 2026-10-27 00:30 (+08)：属于 10-27，不属于 10-26。
  const ts = Date.UTC(2026, 9, 26, 16, 30, 0);
  store.recordStatus(motionStatus(4), ts);
  store.recordStatus(motionStatus(6), ts + 60_000);
  const nextDay = report(store, { date: '2026-10-27' });
  assert.equal(nextDay.selected.count, 2);
  assert.equal(nextDay.selected.hourly[0], 2);
  assert.equal(nextDay.dataSince, ts);
  const sameUtcDay = report(store, { date: '2026-10-26' });
  assert.equal(sameUtcDay.selected.count, null, 'UTC 同一天不等于家庭时区同一天');
  assert.equal(sameUtcDay.selected.status, 'no_data');
});

/* ------------------------------------------------------------ 增量语义 */

test('the first observation only establishes a baseline (delta = 0, no guessed history)', (t) => {
  const store = createStore(t);
  const ts = clock.startOfDay(DAY) + 9 * 3600_000;
  const result = store.recordStatus(motionStatus(7), ts);
  assert.deepEqual(
    { kind: result.kind, delta: result.delta, recorded: result.recorded },
    { kind: 'sample', delta: 0, recorded: true }
  );
  const day = report(store);
  assert.equal(day.selected.count, 0, '首次观测只建立基线，不能把 countToday=7 当成今天新增 7');
  assert.equal(day.selected.samples, 1);
  assert.equal(day.selected.firstTs, ts);
  assert.equal(day.selected.lastTs, ts);
  assert.equal(day.dataSince, ts);
  assert.equal(day.selected.status, 'insufficient');
  // 早于 dataSince 的日期一律 no_data（count 必须是 null，不能是 0）。
  for (const item of day.days.slice(0, 6)) {
    assert.equal(item.count, null);
    assert.equal(item.status, 'no_data');
  }
  assert.equal(day.days[6].count, 0);
  assert.equal(day.summary.daysWithData, 1);
  assert.equal(day.summary.total, 0);
});

test('only positive countToday increments count; repeated reports never double count', (t) => {
  const store = createStore(t);
  const start = clock.startOfDay(DAY) + 9 * 3600_000;
  store.recordStatus(motionStatus(5), start); // 基线
  assert.equal(store.recordStatus(motionStatus(8), start + 60_000).delta, 3);
  assert.equal(store.recordStatus(motionStatus(8), start + 120_000).delta, 0, '同一累计值重复上报 delta=0');
  assert.equal(store.recordStatus(motionStatus(8), start + 180_000).delta, 0);
  assert.equal(store.recordStatus(motionStatus(10), start + 240_000).delta, 2);
  const day = report(store);
  assert.equal(day.selected.count, 5);
  assert.equal(day.selected.samples, 5);
  assert.equal(day.selected.invalidSamples, 0);
  assert.equal(day.selected.hourly[9], 5);
});

test('counter rollback is a reset with resets recorded and never a negative delta', (t) => {
  const store = createStore(t);
  const start = clock.startOfDay(DAY) + 10 * 3600_000;
  store.recordStatus(motionStatus(5), start); // 基线
  const reset = store.recordStatus(motionStatus(2), start + 60_000);
  assert.deepEqual({ delta: reset.delta, reset: reset.reset }, { delta: 2, reset: true });
  const zero = store.recordStatus(motionStatus(0), start + 120_000);
  assert.deepEqual({ delta: zero.delta, reset: zero.reset }, { delta: 0, reset: true });
  const day = report(store);
  assert.equal(day.selected.count, 2, '回退时只把本周期观测到的新值计为新增，绝不产生负数');
  const bucket = dayDoc(store, LIVING, DAY);
  assert.equal(bucket.resets, 2);
  assert.equal(bucket.count, 2);
  assert.equal(day.selected.hourly[10], 2);
});

test('a device counter reset at 08:00 mid-day is a reset, not a day rollover', (t) => {
  const store = createStore(t);
  store.recordStatus(motionStatus(9), clock.startOfDay(DAY) + 7 * 3600_000 + 59 * 60_000); // 07:59 首次观测=基线
  assert.equal(store.recordStatus(motionStatus(0), clock.startOfDay(DAY) + 8 * 3600_000).reset, true);
  assert.equal(store.recordStatus(motionStatus(2), clock.startOfDay(DAY) + 8 * 3600_000 + 30 * 60_000).delta, 2);
  const day = report(store);
  assert.equal(day.selected.count, 2);
  const bucket = dayDoc(store, LIVING, DAY);
  assert.equal(bucket.resets, 1);
  assert.equal(day.selected.hourly[8], 2);
});

test('crossing household midnight rolls the day over and attributes the new count to the new day', (t) => {
  const store = createStore(t);
  const day26 = clock.startOfDay('2026-10-26');
  store.recordStatus(motionStatus(5), day26 + 23 * 3600_000 + 58 * 60_000); // 23:58 首次观测=基线
  assert.equal(store.recordStatus(motionStatus(8), day26 + 23 * 3600_000 + 59 * 60_000).delta, 3, '23:59 仍是同一天');
  // 次日 00:01 上报 countToday=1：这一天的第一条样本，delta=1。
  const nextDayFirst = store.recordStatus(motionStatus(1), clock.startOfDay('2026-10-27') + 60_000);
  assert.equal(nextDayFirst.delta, 1);
  assert.equal(nextDayFirst.dayKey, '2026-10-27');
  const dayView26 = report(store, { date: '2026-10-26' });
  const dayView27 = report(store, { date: '2026-10-27' });
  assert.equal(dayView26.selected.count, 3, '23:58/23:59 的增量属于 10-26');
  assert.equal(dayView27.selected.count, 1);
  assert.equal(dayView27.selected.hourly[0], 1);
  assert.equal(dayView27.days[6].count, 1);
});

/* ------------------------------------------------------------ hourly / 无数据 */

test('hourly only accumulates arrival-hour increments and never backfills the daily cumulative value', (t) => {
  const store = createStore(t);
  const start = clock.startOfDay(DAY) + 9 * 3600_000;
  store.recordStatus(motionStatus(5), start); // 09:00 首次观测 countToday=5 -> 只建立基线
  store.recordStatus(motionStatus(8), clock.startOfDay(DAY) + 12 * 3600_000); // 12:00，+3
  const day = report(store);
  assert.equal(day.selected.count, 3);
  assert.equal(day.selected.hourly[9], 0, '09 点有观测但没有新增');
  assert.equal(day.selected.hourly[10], null, '10 点没有任何样本 -> null，不能补 0');
  assert.equal(day.selected.hourly[11], null);
  assert.equal(day.selected.hourly[12], 3, '增量只能计入到达时刻的小时');
  assert.equal(day.hourly.length, 24);
  assert.deepEqual(day.hourly, day.selected.hourly);
  assert.equal(day.selected.hourly.reduce((sum, value) => sum + (value === null ? 0 : value), 0), 3);
});

test('a device without PIR produces no samples and never a fake zero activity count', (t) => {
  const store = createStore(t);
  const noMotion = { deviceId: KITCHEN, room: '厨房', sensors: { gas: { ok: true } } };
  assert.equal(store.recordStatus(noMotion, clock.startOfDay(DAY) + 9 * 3600_000).recorded, false);
  assert.equal(store.recordStatus({ deviceId: KITCHEN, room: '厨房' }, clock.startOfDay(DAY) + 10 * 3600_000).recorded, false);
  const day = report(store);
  assert.equal(day.selected.count, null);
  assert.equal(day.selected.samples, 0);
  assert.equal(day.selected.status, 'no_data');
  assert.equal(day.selected.coverageRatio, null);
  assert.equal(day.summary.total, null);
  assert.equal(day.summary.daysWithData, 0);
  assert.equal(day.dataSince, 0);
  assert.match(day.historyNote, /尚未收到任何有效的 PIR 活动样本/);
  const kitchen = day.devices.find((device) => device.deviceId === KITCHEN);
  assert.deepEqual(kitchen, {
    deviceId: KITCHEN, room: '厨房', hasMotionSensor: false, count: null, status: 'no_data'
  });
});

test('missing / non-safe-integer / negative countToday and invalid sensors are invalid samples, not zero activity', (t) => {
  const store = createStore(t);
  const start = clock.startOfDay(DAY) + 9 * 3600_000;
  const invalidPayloads = [
    { deviceId: LIVING, sensors: { motion: {} } }, // countToday 缺失
    { deviceId: LIVING, sensors: { motion: { countToday: '5' } } },
    { deviceId: LIVING, sensors: { motion: { countToday: -1 } } },
    { deviceId: LIVING, sensors: { motion: { countToday: 1.5 } } },
    { deviceId: LIVING, sensors: { motion: { countToday: 4, valid: false } } },
    { deviceId: LIVING, sensors: { motion: null } }
  ];
  invalidPayloads.forEach((payload, index) => {
    const result = store.recordStatus(payload, start + index * 60_000);
    assert.equal(result.kind, 'invalid', `payload ${index} 必须记为无活动数据`);
    assert.equal(result.recorded, true);
  });
  const day = report(store);
  assert.equal(day.selected.count, null, '非法 countToday 不能写 0 次活动');
  assert.equal(day.selected.samples, 0);
  assert.equal(day.selected.invalidSamples, invalidPayloads.length);
  assert.equal(day.selected.status, 'no_data');
  assert.equal(day.dataSince, 0);
  const living = day.devices.find((device) => device.deviceId === LIVING);
  assert.equal(living.hasMotionSensor, true, '出现 motion 字段说明该设备有 PIR，只是数据无效');
  assert.equal(living.count, null);
  assert.equal(living.status, 'no_data');
  assert.equal(dayDoc(store, LIVING, DAY).invalidSamples, invalidPayloads.length);
});

/* ------------------------------------------------------------ coverage */

test('offline gaps only reduce coverage: they are never filled with zero activity', (t) => {
  const store = createStore(t, { now: () => clock.startOfDay('2026-10-27') - 1000 });
  const dayStart = clock.startOfDay('2026-10-25');
  store.recordStatus(motionStatus(0), dayStart); // 00:00
  store.recordStatus(motionStatus(1), dayStart + 120_000); // 00:02 (+1)
  store.recordStatus(motionStatus(1), dayStart + 240_000); // 00:04
  // 中午重新上线：12:00，间隔远大于 MAX_SAMPLE_GAP_MS，不计入 observedMs。
  store.recordStatus(motionStatus(3), dayStart + 12 * 3600_000); // +2
  store.recordStatus(motionStatus(3), dayStart + 12 * 3600_000 + 120_000);
  const day = report(store, { date: '2026-10-25' });
  assert.equal(day.selected.count, 3, '缺数据的时间段不能补 0，也不能丢增量');
  assert.equal(day.selected.samples, 5);
  assert.equal(day.selected.maxGapMs, 12 * 3600_000 - 240_000);
  assert.equal(day.selected.firstTs, dayStart);
  assert.equal(day.selected.lastTs, dayStart + 12 * 3600_000 + 120_000);
  // observedMs 只累加 <= MAX_SAMPLE_GAP_MS 的间隔：120s + 120s + 120s = 360s。
  assert.equal(day.selected.coverageRatio, Math.round((360_000 / (24 * 3600_000)) * 1000) / 1000);
  assert.equal(day.selected.status, 'insufficient', '覆盖率低于 partial 阈值必须是 insufficient');
});

/**
 * 覆盖率的诚实性：功能刚启用（dataSince 落在当天）时，窗口必须是“当天从 00:00 到现在”，
 * 不能只从 dataSince 起算 —— 否则几十毫秒的观测也能算出接近 100% 的覆盖率，
 * 把“当天几乎没有观测”伪装成“数据充分”，进而让趋势/对比在证据不足时下结论。
 */
test('first-day coverage is measured over the whole elapsed day, never over a tiny post-dataSince window', (t) => {
  const sixAm = clock.startOfDay(DAY) + 6 * 3600_000;
  const store = createStore(t, { now: () => sixAm });
  store.recordStatus(motionStatus(0), sixAm - 2000);
  store.recordStatus(motionStatus(1), sixAm - 1000);
  store.recordStatus(motionStatus(1), sixAm);
  const day = report(store, { date: DAY });
  assert.equal(day.dataSince, sixAm - 2000, 'dataSince 仍是首个有效样本时刻');
  assert.match(day.historyNote, new RegExp(DAY));
  // 窗口 = 00:00 -> 06:00（6h），观测到的有效间隔只有 2s。
  assert.equal(day.selected.coverageRatio, Math.round((2000 / (6 * 3600_000)) * 1000) / 1000);
  assert.equal(day.selected.coverageRatio < 0.01, true, '刚启用不得显示接近 100% 的覆盖率');
  assert.equal(day.selected.status, 'insufficient');
});

test('coverage thresholds classify ok / partial / insufficient deterministically', (t) => {
  const now = () => clock.startOfDay('2026-10-27') - 1000;

  // 过去某天窗口是完整 24h：12h 观测 -> 0.5 -> ok。
  const okStore = createStore(t, { now });
  seedDay(okStore, LIVING, '2026-10-23', { increments: 4, spanHours: 12 });
  const ok = okStore.getActivityReport({ scope: 'day', date: '2026-10-23' }, [{ deviceId: LIVING, room: '客厅' }]);
  assert.equal(ok.selected.coverageRatio, COVERAGE_OK_RATIO);
  assert.equal(ok.selected.status, 'ok');
  assert.equal(ok.selected.count, 4);

  // 3h / 24h = 0.125 -> partial（>= 10% 且 < 50%）。
  const partialStore = createStore(t, { now });
  seedDay(partialStore, LIVING, '2026-10-23', { increments: 2, spanHours: 3 });
  const partial = partialStore.getActivityReport({ scope: 'day', date: '2026-10-23' }, [{ deviceId: LIVING, room: '客厅' }]);
  assert.equal(partial.selected.status, 'partial');
  assert.ok(partial.selected.coverageRatio >= 0.1 && partial.selected.coverageRatio < 0.5);

  // 只有一个样本：不足 MIN_DAY_SAMPLES，无论如何都算 insufficient。
  const sparseStore = createStore(t, { now });
  sparseStore.recordStatus(motionStatus(1), clock.startOfDay('2026-10-23') + 3600_000);
  const sparse = sparseStore.getActivityReport({ scope: 'day', date: '2026-10-23' }, [{ deviceId: LIVING, room: '客厅' }]);
  assert.equal(sparse.selected.status, 'insufficient');
  assert.equal(sparse.selected.samples, 1);
});

test('each device keeps at most 400 day buckets and evicts the oldest by date', (t) => {
  const store = createStore(t);
  let dateKey = '2025-09-16';
  const seeded = [];
  for (let index = 0; index < RETENTION_DAYS + 5; index += 1) {
    store.recordStatus(motionStatus(0), clock.startOfDay(dateKey) + 12 * 3600_000);
    seeded.push(dateKey);
    dateKey = addDaysKey(dateKey, 1);
  }
  const document = JSON.parse(store.$writer.text);
  const device = document.activity.devices[0];
  assert.equal(device.days.length, RETENTION_DAYS);
  assert.equal(device.days[0].date, seeded[5], '最旧 5 天必须被淘汰');
  assert.equal(device.days[device.days.length - 1].date, seeded[seeded.length - 1]);
});

/* ------------------------------------------------------------ trend / comparison */

test('a sustained 3-day decrease produces a neutral down trend, never a medical conclusion', (t) => {
  const store = createStore(t, { now: () => clock.startOfDay('2026-10-26') + 12 * 3600_000 });
  seedDay(store, LIVING, '2026-10-23', { increments: 10, spanHours: 12 });
  seedDay(store, LIVING, '2026-10-24', { increments: 6, spanHours: 12 });
  seedDay(store, LIVING, '2026-10-25', { increments: 3, spanHours: 12 });
  const day = report(store, { date: '2026-10-25' });
  assert.equal(day.days.find((item) => item.date === '2026-10-23').count, 10);
  assert.equal(day.days.find((item) => item.date === '2026-10-24').count, 6);
  assert.equal(day.days.find((item) => item.date === '2026-10-25').count, 3);
  assert.equal(day.trend.state, 'down');
  assert.match(day.trend.text, /下降/);
  assert.match(day.trend.text, /联系/);
  assert.doesNotMatch(day.trend.text, /疾病|诊断|痴呆|患病|异常/);
  assert.doesNotMatch(day.trend.note, /疾病|诊断|痴呆|患病/);
  // 覆盖率足够时也应给出可比较对比（previous=6, selected=3）。
  assert.equal(day.comparison.state, 'comparable');
  assert.equal(day.comparison.delta, -3);
  assert.equal(day.comparison.pct, -50);
});

test('trend is insufficient with fewer than 3 data days or low coverage, and reports up / stable', (t) => {
  const insufficient = createStore(t);
  seedDay(insufficient, LIVING, '2026-10-24', { increments: 5, spanHours: 12 });
  seedDay(insufficient, LIVING, '2026-10-25', { increments: 3, spanHours: 12 });
  assert.equal(report(insufficient, { date: '2026-10-25' }).trend.state, 'insufficient');

  const lowCoverage = createStore(t);
  seedDay(lowCoverage, LIVING, '2026-10-24', { increments: 5, spanHours: 12 });
  seedDay(lowCoverage, LIVING, '2026-10-25', { increments: 3, spanHours: 12 });
  lowCoverage.recordStatus(motionStatus(1), clock.startOfDay('2026-10-26') + 3600_000);
  const low = report(lowCoverage, { date: '2026-10-26' });
  assert.equal(low.trend.state, 'insufficient');
  assert.match(low.trend.note, /覆盖率/);

  const up = createStore(t);
  seedDay(up, LIVING, '2026-10-23', { increments: 2, spanHours: 12 });
  seedDay(up, LIVING, '2026-10-24', { increments: 5, spanHours: 12 });
  seedDay(up, LIVING, '2026-10-25', { increments: 9, spanHours: 12 });
  assert.equal(report(up, { date: '2026-10-25' }).trend.state, 'up');

  const stable = createStore(t);
  seedDay(stable, LIVING, '2026-10-23', { increments: 5, spanHours: 12 });
  seedDay(stable, LIVING, '2026-10-24', { increments: 5, spanHours: 12 });
  seedDay(stable, LIVING, '2026-10-25', { increments: 5, spanHours: 12 });
  assert.equal(report(stable, { date: '2026-10-25' }).trend.state, 'stable');
});

test('comparison never substitutes 0 for missing data and skips pct when previous is zero', (t) => {
  const now = () => clock.startOfDay('2026-10-26') + 12 * 3600_000;
  const comparable = createStore(t, { now });
  seedDay(comparable, LIVING, '2026-10-24', { increments: 4, spanHours: 12 });
  seedDay(comparable, LIVING, '2026-10-25', { increments: 6, spanHours: 12 });
  const more = report(comparable, { date: '2026-10-25' });
  assert.equal(more.comparison.state, 'comparable');
  assert.equal(more.comparison.delta, 2);
  assert.equal(more.comparison.pct, 50);
  assert.match(more.comparison.text, /增加 2 次/);

  const previousZero = createStore(t, { now });
  seedDay(previousZero, LIVING, '2026-10-24', { increments: 0, spanHours: 12 }); // 有样本但 0 次活动
  seedDay(previousZero, LIVING, '2026-10-25', { increments: 3, spanHours: 12 });
  const zero = report(previousZero, { date: '2026-10-25' });
  assert.equal(zero.previous.count, 0);
  assert.equal(zero.comparison.state, 'previous_zero');
  assert.equal(zero.comparison.pct, null, '0 不能做分母');
  assert.equal(zero.comparison.delta, 3);

  const previousMissing = createStore(t, { now });
  seedDay(previousMissing, LIVING, '2026-10-25', { increments: 3, spanHours: 12 });
  const missing = report(previousMissing, { date: '2026-10-25' });
  assert.equal(missing.previous.count, null);
  assert.equal(missing.comparison.state, 'previous_missing');
  assert.equal(missing.comparison.delta, null);
  assert.equal(missing.comparison.pct, null);

  const selectedMissing = createStore(t, { now });
  seedDay(selectedMissing, LIVING, '2026-10-24', { increments: 3, spanHours: 12 });
  const empty = report(selectedMissing, { date: '2026-10-25' });
  assert.equal(empty.selected.count, null);
  assert.equal(empty.comparison.state, 'selected_missing');
  assert.equal(empty.comparison.delta, null);
});

/* ------------------------------------------------------------ 严格加载 / 落盘 */

/** 用一份合法文件做基底，按 mutator 改坏后断言拒绝启动。 */
function assertRejects(t, mutate, pattern) {
  const dir = tempDir(t);
  const filePath = path.join(dir, 'activity-state.json');
  const source = new ActivityStore({ filePath: path.join(dir, 'seed.json'), timezone: TZ, now: () => NOW });
  source.recordStatus(motionStatus(5), clock.startOfDay(DAY) + 9 * 3600_000);
  source.recordStatus(motionStatus(8), clock.startOfDay(DAY) + 9 * 3600_000 + 60_000);
  const document = JSON.parse(JSON.stringify({
    version: ACTIVITY_FILE_VERSION,
    savedAt: NOW,
    activity: activityToDocument(source.activity)
  }));
  mutate(document);
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
  assert.throws(() => new ActivityStore({ filePath, timezone: TZ, now: () => NOW }), pattern);
}

test('corrupt, unknown or structurally invalid activity files fail closed instead of silently resetting', (t) => {
  const dir = tempDir(t);
  const corruptPath = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{ not json', 'utf8');
  assert.throws(() => new ActivityStore({ filePath: corruptPath, timezone: TZ }), /invalid JSON/);

  assertRejects(t, (document) => { document.version = 2; }, /unsupported version/);
  assertRejects(t, (document) => { document.sessionToken = 'SECRET_MARKER'; }, /unknown top-level field/);
  assertRejects(t, (document) => { document.savedAt = -1; }, /savedAt/);
  assertRejects(t, (document) => { delete document.activity; }, /activity is required/);
  assertRejects(t, (document) => { document.activity.sessionToken = 'SECRET_MARKER'; }, /unknown field/);
  assertRejects(t, (document) => { document.activity.devices[0].days[0].hourly = [0, 1, 2]; }, /hourly/);
  assertRejects(t, (document) => { document.activity.devices[0].days[0].count = 99; }, /does not add up/);
  assertRejects(t, (document) => { document.activity.devices[0].days[0].samples = -1; }, /samples/);
  assertRejects(t, (document) => { document.activity.devicess = []; }, /unknown field/);
  assertRejects(t, (document) => { document.activity.timezone = 'Europe/Paris'; }, /timezone mismatch/);
});

test('the constructor does not create a file; the first record writes 0600 atomically and restart restores baselines', (t) => {
  const store = createRealStore(t);
  assert.equal(fs.existsSync(store.filePath), false, '只读启动不得创建文件');
  const start = clock.startOfDay(DAY) + 9 * 3600_000;
  store.recordStatus(motionStatus(5), start);
  assert.equal(fs.existsSync(store.filePath), true);
  store.recordStatus(motionStatus(8), start + 60_000); // +3
  store.recordStatus(motionStatus(8), start + 120_000); // +0

  const document = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.equal(document.version, ACTIVITY_FILE_VERSION);
  assert.equal(document.activity.timezone, TZ);
  assert.equal(document.activity.devices.length, 1);
  assert.equal(document.savedAt, NOW);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
  }
  assert.equal(fs.readdirSync(path.dirname(store.filePath)).some((name) => name.endsWith('.tmp')), false);

  // 重启：基线（8）、当日计数、dataSince、coverage 全部恢复。
  const restarted = new ActivityStore({ filePath: store.filePath, timezone: TZ, now: () => NOW });
  const before = restarted.getActivityReport({ scope: 'day', date: DAY }, [{ deviceId: LIVING, room: '客厅' }]);
  assert.equal(before.selected.count, 3);
  assert.equal(before.selected.samples, 3);
  assert.equal(before.selected.firstTs, start);
  assert.equal(before.selected.lastTs, start + 120_000);
  assert.equal(before.dataSince, start);
  const next = restarted.recordStatus(motionStatus(11), start + 180_000);
  assert.equal(next.delta, 3, '重启后必须沿用已持久化基线 8 而不是重新建基线');
  const after = restarted.getActivityReport({ scope: 'day', date: DAY });
  assert.equal(after.selected.count, 6);
});

test('a failed atomic write rolls memory back and never touches the previous file', (t) => {
  const store = createStore(t);
  const start = clock.startOfDay(DAY) + 9 * 3600_000;
  store.recordStatus(motionStatus(5), start);
  store.recordStatus(motionStatus(8), start + 60_000);
  const before = store.$writer.text;
  assert.equal(report(store).selected.count, 3);

  store.$writer.fail = true;
  assert.throws(() => store.recordStatus(motionStatus(12), start + 120_000), /disk full/);
  assert.equal(store.$writer.text, before, '写失败不得产生新的持久化文本');
  const rolledBack = report(store);
  assert.equal(rolledBack.selected.count, 3, '写失败必须回滚内存，不能虚报成功');
  assert.equal(rolledBack.selected.samples, 2);
  assert.equal(rolledBack.selected.lastTs, start + 60_000);

  store.$writer.fail = false;
  assert.equal(store.recordStatus(motionStatus(12), start + 180_000).delta, 4);
  assert.equal(report(store).selected.count, 7);
});

test('dataSince and no-data days stay null even when only a later range is reopened', (t) => {
  const store = createStore(t);
  store.recordStatus(motionStatus(2), clock.startOfDay('2026-10-24') + 9 * 3600_000);
  store.recordStatus(motionStatus(5), clock.startOfDay('2026-10-24') + 9 * 3600_000 + 60_000);
  const day = report(store, { date: '2026-10-26' });
  assert.equal(day.dataSince, clock.startOfDay('2026-10-24') + 9 * 3600_000);
  for (const item of day.days) {
    if (item.date < '2026-10-24') {
      assert.equal(item.count, null);
      assert.equal(item.status, 'no_data');
    }
  }
  // 当天之外的全是 null：绝不用 0 表示。
  assert.equal(day.days.find((item) => item.date === '2026-10-25').count, null);
  assert.equal(day.days.find((item) => item.date === '2026-10-26').count, null);
});
