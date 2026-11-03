'use strict';

/**
 * PIR 活动规律聚合：按家庭时区切日、算增量、出报告。
 *
 * 数据只来自设备状态摄入里的 sensors.motion.countToday（当日累计触发次数），不做历史推断：
 * 只把 countToday 的正增量算作新增，重复上报同一个值 delta = 0；计数器回退（设备重启）
 * 按 reset 处理，delta 取本周期观测到的新值，不出负数；首次观测只建基线，同时记下 dataSince。
 * motion 缺失、countToday 缺失或非法、valid=false 都算“无活动数据”，不写 0、不计 samples，
 * 只累加 invalidSamples。hourly 只按增量到达时刻的家庭时区小时累加，历史小时不回填。
 *
 * 切日只用家庭时区（HOUSEHOLD_TIMEZONE，默认 Asia/Shanghai），靠 Intl.DateTimeFormat 换算，
 * 不依赖服务器本地时区或 UTC。
 *
 * coverage 表达“这段时间到底有没有在线观测”，缺数据不补 0：observedMs 只累加同一自然日内
 * ≤ MAX_SAMPLE_GAP_MS 的样本间隔，windowMs 是该日到查询时刻的时长，
 * coverageRatio = clamp(observedMs / windowMs)。≥ COVERAGE_OK_RATIO 为 ok，
 * ≥ COVERAGE_PARTIAL_RATIO 为 partial，否则 insufficient；samples 少于 MIN_DAY_SAMPLES
 * 直接 insufficient，没有任何样本为 no_data（count = null）。
 *
 * 每台设备最多保留 RETENTION_DAYS 个日桶，超出按日期淘汰。
 */

const DEFAULT_TIMEZONE = 'Asia/Shanghai';
/** 每台设备保留的日桶上限（约 13 个月），超出按日期淘汰最旧。 */
const RETENTION_DAYS = 400;
/** 少于 2 个样本的日期不足以判断活动水平。 */
const MIN_DAY_SAMPLES = 2;
/** 覆盖率 ≥ 50% 视为 ok。 */
const COVERAGE_OK_RATIO = 0.5;
/** 覆盖率 ≥ 10% 视为 partial，低于它算 insufficient。 */
const COVERAGE_PARTIAL_RATIO = 0.1;
/** 相邻样本间隔超过该值时视为“这一段没有观测”，不计入 observedMs。 */
const MAX_SAMPLE_GAP_MS = 120_000;
const HOURS_PER_DAY = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPES = new Set(['day', 'week', 'month']);
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 与 store.js 的 DEVICE_ID_RE 保持一致（此处独立定义，避免 activity -> store 的循环依赖）。 */
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const ACTIVITY_DOC_KEYS = ['timezone', 'devices'];
const ACTIVITY_DOC_KEY_SET = new Set(ACTIVITY_DOC_KEYS);
const ACTIVITY_DEVICE_KEYS = ['deviceId', 'hasMotionSensor', 'dataSince', 'baseline', 'days'];
const ACTIVITY_DEVICE_KEY_SET = new Set(ACTIVITY_DEVICE_KEYS);
const ACTIVITY_BASELINE_KEYS = ['countToday', 'date'];
const ACTIVITY_BASELINE_KEY_SET = new Set(ACTIVITY_BASELINE_KEYS);
const ACTIVITY_DAY_KEYS = [
  'date', 'count', 'samples', 'invalidSamples', 'firstTs', 'lastTs', 'maxGapMs', 'observedMs', 'resets', 'hourly'
];
const ACTIVITY_DAY_KEY_SET = new Set(ACTIVITY_DAY_KEYS);
const CORRUPT = 'persistent store corrupt: ';

const HISTORY_NOTE_EMPTY =
  '后端尚未收到任何有效的 PIR 活动样本；所有日期均显示为“无数据”，不会用 0 填充。';
const DISCLAIMER =
  'PIR 活动计数是传感器触发次数，不等于人数或唯一动作次数；无数据不等于没有活动；历史仅从功能启用后开始积累。';

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function round3(value) {
  return value === null || value === undefined ? null : Math.round(value * 1000) / 1000;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDateKeyParts(dateKey) {
  if (typeof dateKey !== 'string' || !DATE_KEY_RE.test(dateKey)) return null;
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  // Date.UTC 会把 0..99 年映射到 1900+，因此必须做一次往返校验。
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function isValidDateKey(dateKey) {
  return parseDateKeyParts(dateKey) !== null;
}

/** 日期 key 的纯日历加减（与任何时区无关）。 */
function addDaysKey(dateKey, amount) {
  const parts = parseDateKeyParts(dateKey);
  if (!parts) fail(`invalid date key: ${String(dateKey)}`);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + amount * DAY_MS);
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

const PART_TYPES = new Set(['year', 'month', 'day', 'hour', 'minute', 'second']);

/**
 * 家庭时区日历时钟：把任意毫秒时间戳换算成家庭时区的日期 key（YYYY-MM-DD）与小时（0..23），
 * 并能在该时区里求“本地 0 点”的绝对时刻（处理 DST 缺失 0 点的极端情况）。
 */
function createHouseholdClock(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') fail('timezone must be a non-empty string');
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (_) {
    fail(`invalid timezone: ${timeZone}`);
  }
  const resolved = formatter.resolvedOptions().timeZone || timeZone;

  function partsAt(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp < 0) fail('invalid timestamp for household timezone');
    const values = {};
    for (const part of formatter.formatToParts(new Date(timestamp))) {
      if (PART_TYPES.has(part.type)) values[part.type] = Number(part.value);
    }
    for (const type of PART_TYPES) {
      if (!Number.isSafeInteger(values[type])) fail(`timezone parts unavailable: ${type}`);
    }
    return values;
  }

  function dateKeyAt(timestamp) {
    const parts = partsAt(timestamp);
    return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  function hourAt(timestamp) {
    return partsAt(timestamp).hour % HOURS_PER_DAY;
  }

  /** 该时刻的家庭时区偏移（秒，东为正）。 */
  function offsetSecondsAt(timestamp) {
    const parts = partsAt(timestamp);
    const asUtcSeconds = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000;
    return asUtcSeconds - Math.floor(timestamp / 1000);
  }

  function startOfDay(dateKey) {
    const parts = parseDateKeyParts(dateKey);
    if (!parts) fail(`invalid date key: ${String(dateKey)}`);
    const wallSeconds = Date.UTC(parts.year, parts.month - 1, parts.day) / 1000;
    let candidate = wallSeconds * 1000;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = (wallSeconds - offsetSecondsAt(candidate)) * 1000;
      if (next === candidate) break;
      candidate = next;
    }
    if (dateKeyAt(candidate) === dateKey) return candidate;
    // DST 起点可能跳过本地 0 点：向前/向后找第一个属于该日期的时刻。
    for (let step = 1; step <= 48; step += 1) {
      const forward = candidate + step * 3600_000;
      if (dateKeyAt(forward) === dateKey) return forward;
      const backward = candidate - step * 3600_000;
      if (dateKeyAt(backward) === dateKey) return backward;
    }
    fail(`timezone ${resolved} cannot resolve start of day ${dateKey}`);
  }

  return Object.freeze({
    timeZone: resolved,
    dateKey: dateKeyAt,
    hour: hourAt,
    startOfDay,
    nextDayStart: (dateKey) => startOfDay(addDaysKey(dateKey, 1)),
    addDays: addDaysKey
  });
}

/**
 * 解析 `HOUSEHOLD_TIMEZONE`。
 * - 未设置 / 空串 -> 默认 Asia/Shanghai
 * - 非法 IANA 时区 -> 抛错（fail-closed，绝不静默退化成服务器本地时区）
 * - 合法 -> 返回 Intl 归一化后的时区名（如 asia/shanghai -> Asia/Shanghai）
 */
function parseHouseholdTimezone(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEZONE;
  if (typeof value !== 'string') fail('HOUSEHOLD_TIMEZONE must be a string');
  const raw = value.trim();
  if (raw === '') return DEFAULT_TIMEZONE;
  let clock;
  try {
    clock = createHouseholdClock(raw);
  } catch (_) {
    fail('HOUSEHOLD_TIMEZONE must be a valid IANA timezone');
  }
  return clock.timeZone;
}

/**
 * 校验活动报告查询参数。
 * @returns {{ok:true, value:{scope:string, date:(string|null)}}|{ok:false, error:string}}
 */
function normalizeActivityQuery(query) {
  const input = isPlainObject(query) ? query : {};
  const rawScope = input.scope === undefined || input.scope === null || input.scope === ''
    ? 'day'
    : input.scope;
  if (typeof rawScope !== 'string' || !SCOPES.has(rawScope)) {
    return { ok: false, error: 'invalid scope' };
  }
  const rawDate = input.date;
  if (rawDate === undefined || rawDate === null || rawDate === '') {
    return { ok: true, value: { scope: rawScope, date: null } };
  }
  if (typeof rawDate !== 'string' || !isValidDateKey(rawDate)) {
    return { ok: false, error: 'invalid date' };
  }
  return { ok: true, value: { scope: rawScope, date: rawDate } };
}

/* ---- 内存状态 ---- */

/** 空活动状态（v1..v5 快照加载、或首次启动）。 */
function createActivityState(clock) {
  return { timezone: clock.timeZone, devices: new Map() };
}

function createDayBucket(date) {
  return {
    date,
    count: 0,
    samples: 0,
    invalidSamples: 0,
    firstTs: 0,
    lastTs: 0,
    maxGapMs: 0,
    observedMs: 0,
    resets: 0,
    hourly: new Array(HOURS_PER_DAY).fill(null)
  };
}

function ensureActivityDevice(activity, deviceId) {
  let device = activity.devices.get(deviceId);
  if (!device) {
    device = { deviceId, hasMotionSensor: false, dataSince: 0, baseline: null, days: new Map() };
    activity.devices.set(deviceId, device);
  }
  return device;
}

function ensureDayBucket(device, dateKey) {
  let bucket = device.days.get(dateKey);
  if (!bucket) {
    bucket = createDayBucket(dateKey);
    device.days.set(dateKey, bucket);
    trimDeviceDays(device);
  }
  return bucket;
}

/** 保留上限：只按日期淘汰最旧日桶，绝不影响基线/当日计数。 */
function trimDeviceDays(device) {
  if (device.days.size <= RETENTION_DAYS) return;
  const keys = [...device.days.keys()].sort();
  const excess = device.days.size - RETENTION_DAYS;
  for (let index = 0; index < excess; index += 1) device.days.delete(keys[index]);
}

/** 设备级 dataSince（首个有效活动样本的到达时刻），0 表示还没有。 */
function deviceDataSince(device) {
  return device && Number.isSafeInteger(device.dataSince) && device.dataSince > 0 ? device.dataSince : 0;
}

/** 活动状态里最早的活动样本时刻；0 表示没有任何活动数据。 */
function activityDataSince(activity) {
  let earliest = 0;
  for (const device of activity.devices.values()) {
    const value = deviceDataSince(device);
    if (value > 0 && (earliest === 0 || value < earliest)) earliest = value;
  }
  return earliest;
}

/**
 * 记录一次设备状态摄入对活动统计的影响。
 *
 * receivedAt 是服务端收到载荷的时刻，不是设备 ts 也不是告警时间：增量只能归到
 * “观测到它的那个家庭时区小时”，不能用可能被伪造或回退的设备时间反推历史分布。
 *
 * @returns {{kind:'no_motion'|'invalid'|'sample', delta:number, reset:boolean, dayKey:string}}
 */
function recordActivitySample(activity, clock, sample) {
  if (!isPlainObject(activity)) fail('activity must be an object');
  if (!isPlainObject(sample)) fail('activity sample must be an object');
  const deviceId = sample.deviceId;
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) fail('invalid activity deviceId');
  const receivedAt = sample.receivedAt;
  if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) fail('invalid activity sample timestamp');
  const sensors = isPlainObject(sample.sensors) ? sample.sensors : {};
  if (!Object.prototype.hasOwnProperty.call(sensors, 'motion')) {
    // 该载荷没有 PIR 信息（例如厨房无 PIR）：不产生样本，也不写 0 次活动。
    return { kind: 'no_motion', delta: 0, reset: false, dayKey: '' };
  }

  const device = ensureActivityDevice(activity, deviceId);
  device.hasMotionSensor = true;
  const dayKey = clock.dateKey(receivedAt);
  const bucket = ensureDayBucket(device, dayKey);
  const hour = clock.hour(receivedAt);

  const motion = isPlainObject(sensors.motion) ? sensors.motion : null;
  const countToday = motion ? motion.countToday : undefined;
  const sensorValid = !motion || motion.valid !== false;
  const countValid = Number.isSafeInteger(countToday) && countToday >= 0;
  if (!motion || !countValid || !sensorValid) {
    bucket.invalidSamples += 1;
    return { kind: 'invalid', delta: 0, reset: false, dayKey };
  }

  // 有效样本：先更新 coverage 相关字段，再算增量。
  const previousTs = bucket.lastTs;
  const gap = previousTs > 0 ? receivedAt - previousTs : 0;
  bucket.samples += 1;
  if (bucket.firstTs === 0) bucket.firstTs = receivedAt;
  bucket.lastTs = receivedAt;
  if (gap > bucket.maxGapMs) bucket.maxGapMs = gap;
  if (gap > 0 && gap <= MAX_SAMPLE_GAP_MS) bucket.observedMs += gap;
  if (bucket.hourly[hour] === null) bucket.hourly[hour] = 0;

  let delta = 0;
  let reset = false;
  if (!device.baseline) {
    // 首次观测：只建立基线，不猜测当天更早的历史。
    device.baseline = { countToday, date: dayKey };
    device.dataSince = receivedAt;
  } else if (dayKey > device.baseline.date) {
    // 自然日滚动：countToday 本来就是“当日累计”，首样本即当日新增。
    delta = countToday;
    device.baseline = { countToday, date: dayKey };
  } else if (dayKey === device.baseline.date) {
    if (countToday > device.baseline.countToday) {
      delta = countToday - device.baseline.countToday;
    } else if (countToday < device.baseline.countToday) {
      // 设备重启 / 计数器回退：本周期观测到的新值算新增，绝不产生负数。
      delta = countToday;
      reset = true;
      bucket.resets += 1;
    }
    device.baseline = { countToday, date: dayKey };
  }
  if (device.dataSince === 0) device.dataSince = receivedAt;
  bucket.count += delta;
  if (delta > 0) bucket.hourly[hour] += delta;
  return { kind: 'sample', delta, reset, dayKey };
}

/* ---- 快照序列化 ---- */

function dayBucketToDocument(bucket) {
  return {
    date: bucket.date,
    count: bucket.count,
    samples: bucket.samples,
    invalidSamples: bucket.invalidSamples,
    firstTs: bucket.firstTs,
    lastTs: bucket.lastTs,
    maxGapMs: bucket.maxGapMs,
    observedMs: bucket.observedMs,
    resets: bucket.resets,
    hourly: bucket.hourly.slice()
  };
}

function activityToDocument(activity) {
  const deviceIds = [...activity.devices.keys()].sort();
  return {
    timezone: activity.timezone,
    devices: deviceIds.map((deviceId) => {
      const device = activity.devices.get(deviceId);
      const dayKeys = [...device.days.keys()].sort();
      return {
        deviceId: device.deviceId,
        hasMotionSensor: device.hasMotionSensor === true,
        dataSince: deviceDataSince(device),
        baseline: device.baseline ? { countToday: device.baseline.countToday, date: device.baseline.date } : null,
        days: dayKeys.map((key) => dayBucketToDocument(device.days.get(key)))
      };
    })
  };
}

function requireNonNegativeInt(value, label, prefix = CORRUPT) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${prefix}${label} must be a non-negative safe integer`);
  }
  return value;
}

function activityDayFromDocument(raw, index, deviceLabel, prefix) {
  const label = `${deviceLabel}.days[${index}]`;
  if (!isPlainObject(raw)) fail(`${prefix}${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ACTIVITY_DAY_KEY_SET.has(key)) fail(`${prefix}unknown field ${key} in ${label}`);
  }
  if (!isValidDateKey(raw.date)) fail(`${prefix}${label}.date`);
  const count = requireNonNegativeInt(raw.count, `${label}.count`, prefix);
  const samples = requireNonNegativeInt(raw.samples, `${label}.samples`, prefix);
  const invalidSamples = requireNonNegativeInt(raw.invalidSamples, `${label}.invalidSamples`, prefix);
  const resets = requireNonNegativeInt(raw.resets, `${label}.resets`, prefix);
  const firstTs = requireNonNegativeInt(raw.firstTs, `${label}.firstTs`, prefix);
  const lastTs = requireNonNegativeInt(raw.lastTs, `${label}.lastTs`, prefix);
  const maxGapMs = requireNonNegativeInt(raw.maxGapMs, `${label}.maxGapMs`, prefix);
  const observedMs = requireNonNegativeInt(raw.observedMs, `${label}.observedMs`, prefix);
  const rawHourly = raw.hourly;
  if (!Array.isArray(rawHourly) || rawHourly.length !== HOURS_PER_DAY) {
    fail(`${prefix}${label}.hourly must have exactly ${HOURS_PER_DAY} entries`);
  }
  let hourlySum = 0;
  const hourly = new Array(HOURS_PER_DAY);
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const value = rawHourly[hour];
    if (value === null) {
      hourly[hour] = null;
      continue;
    }
    hourly[hour] = requireNonNegativeInt(value, `${label}.hourly[${hour}]`, prefix);
    hourlySum += value;
  }
  // count 必须等于小时的增量之和：这是“增量只能归属到达小时”的不变量。
  if (hourlySum !== count) fail(`${prefix}${label}.hourly does not add up to count`);
  if (samples === 0) {
    if (count !== 0 || resets !== 0 || firstTs !== 0 || lastTs !== 0 || maxGapMs !== 0 || observedMs !== 0) {
      fail(`${prefix}${label} empty bucket must be zeroed`);
    }
  } else {
    if (firstTs === 0 || lastTs < firstTs) fail(`${prefix}${label} timestamps are inconsistent`);
    const span = lastTs - firstTs;
    if (maxGapMs > span || observedMs > span) fail(`${prefix}${label} coverage exceeds observed span`);
  }
  return {
    date: raw.date,
    count,
    samples,
    invalidSamples,
    firstTs,
    lastTs,
    maxGapMs,
    observedMs,
    resets,
    hourly
  };
}

function activityDeviceFromDocument(raw, index, prefix) {
  const label = `activity.device[${index}]`;
  if (!isPlainObject(raw)) fail(`${prefix}${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ACTIVITY_DEVICE_KEY_SET.has(key)) fail(`${prefix}unknown field ${key} in ${label}`);
  }
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) fail(`${prefix}${label}.deviceId`);
  if (typeof raw.hasMotionSensor !== 'boolean') fail(`${prefix}${label}.hasMotionSensor`);
  const dataSince = requireNonNegativeInt(raw.dataSince === undefined ? 0 : raw.dataSince, `${label}.dataSince`, prefix);
  let baseline = null;
  if (raw.baseline !== undefined && raw.baseline !== null) {
    if (!isPlainObject(raw.baseline)) fail(`${prefix}${label}.baseline must be an object or null`);
    for (const key of Object.keys(raw.baseline)) {
      if (!ACTIVITY_BASELINE_KEY_SET.has(key)) fail(`${prefix}unknown field ${key} in ${label}.baseline`);
    }
    if (!isValidDateKey(raw.baseline.date)) fail(`${prefix}${label}.baseline.date`);
    baseline = {
      countToday: requireNonNegativeInt(raw.baseline.countToday, `${label}.baseline.countToday`, prefix),
      date: raw.baseline.date
    };
  }
  // 基线只会与 dataSince 同时建立；两者必须同真同假。
  if ((baseline !== null) !== (dataSince > 0)) {
    fail(`${prefix}${label} baseline/dataSince must be set together`);
  }
  if (baseline !== null && raw.hasMotionSensor !== true) fail(`${prefix}${label} baseline requires hasMotionSensor=true`);
  const rawDays = raw.days === undefined ? [] : raw.days;
  if (!Array.isArray(rawDays)) fail(`${prefix}${label}.days must be an array`);
  if (rawDays.length > RETENTION_DAYS) {
    fail(`${prefix}${label}.days exceeds retention cap ${RETENTION_DAYS}`);
  }
  const days = new Map();
  let previousKey = '';
  for (let dayIndex = 0; dayIndex < rawDays.length; dayIndex += 1) {
    const bucket = activityDayFromDocument(rawDays[dayIndex], dayIndex, label, prefix);
    if (days.has(bucket.date)) fail(`${prefix}duplicate activity day ${bucket.date} in ${label}`);
    if (previousKey !== '' && bucket.date <= previousKey) {
      fail(`${prefix}${label}.days must be strictly ordered by date`);
    }
    previousKey = bucket.date;
    days.set(bucket.date, bucket);
  }
  return { deviceId: raw.deviceId, hasMotionSensor: raw.hasMotionSensor === true, dataSince, baseline, days };
}

/**
 * 严格校验并还原快照里的 `activity`。
 *
 * 只允许 {timezone, devices} 两个顶层字段，设备、基线、日桶、小时数组全是字段白名单。
 * 未知字段（比如有人塞 secret 或手机号）、类型错误、负数、乱序或重复日期、hourly 长度
 * 不是 24、hourly 之和与 count 不符，都会直接拒绝启动。
 * 时区必须与当前配置一致；只有空活动状态（v1..v5 刚升级）才接受配置时区。
 */
function activityFromDocument(raw, clock, prefix = CORRUPT) {
  if (!isPlainObject(clock)) fail('activity clock is required');
  if (!isPlainObject(raw)) fail(`${prefix}activity must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ACTIVITY_DOC_KEY_SET.has(key)) fail(`${prefix}unknown field ${key} in activity`);
  }
  if (typeof raw.timezone !== 'string') fail(`${prefix}activity.timezone`);
  if (!Array.isArray(raw.devices)) fail(`${prefix}activity.devices must be an array`);
  let storedClock;
  try {
    storedClock = createHouseholdClock(raw.timezone);
  } catch (_) {
    fail(`${prefix}activity.timezone is not a valid IANA timezone`);
  }
  if (storedClock.timeZone !== clock.timeZone && raw.devices.length > 0) {
    fail(`${prefix}activity timezone mismatch (snapshot ${storedClock.timeZone} vs configured ${clock.timeZone})`);
  }
  const devices = new Map();
  for (let index = 0; index < raw.devices.length; index += 1) {
    const device = activityDeviceFromDocument(raw.devices[index], index, prefix);
    if (devices.has(device.deviceId)) fail(`${prefix}duplicate activity device ${device.deviceId}`);
    devices.set(device.deviceId, device);
  }
  const ordered = new Map([...devices.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  return { timezone: clock.timeZone, devices: ordered };
}

/* ---- 查询聚合 ---- */

function emptyAccumulator() {
  return {
    count: null,
    samples: 0,
    invalidSamples: 0,
    firstTs: 0,
    lastTs: 0,
    maxGapMs: 0,
    observedMs: 0,
    windowMs: 0,
    hourly: new Array(HOURS_PER_DAY).fill(null)
  };
}

function coverageOf(accumulator) {
  return accumulator.windowMs > 0 ? clamp01(accumulator.observedMs / accumulator.windowMs) : null;
}

function statusFrom(samples, coverageRatio) {
  if (samples <= 0) return 'no_data';
  if (samples < MIN_DAY_SAMPLES) return 'insufficient';
  if (coverageRatio === null) return 'partial';
  if (coverageRatio >= COVERAGE_OK_RATIO) return 'ok';
  if (coverageRatio >= COVERAGE_PARTIAL_RATIO) return 'partial';
  return 'insufficient';
}

/**
 * 某设备某日可观测时间窗口 = 该自然日 00:00 到统计时刻之间的时长。
 *
 * 刻意不按 dataSince 裁剪：那样功能刚启用时观测几十毫秒就能算出接近 100% 的覆盖率，
 * 把“当天几乎没观测”显示成“数据充分”。历史起点由 dataSince 和 historyNote 单独表达，
 * 不用覆盖率替代。
 */
function dayWindowMs(clock, dateKey, nowTs) {
  const dayStart = clock.startOfDay(dateKey);
  const nextStart = clock.nextDayStart(dateKey);
  const end = Math.min(nextStart, nowTs);
  return end > dayStart ? end - dayStart : 0;
}

function accumulateDeviceDay(accumulator, activity, deviceId, dateKey, clock, nowTs) {
  const device = activity.devices.get(deviceId);
  if (!device) return;
  const bucket = device.days.get(dateKey) || null;
  if (device.hasMotionSensor) {
    accumulator.windowMs += dayWindowMs(clock, dateKey, nowTs);
    if (bucket) accumulator.observedMs += bucket.observedMs;
  }
  if (!bucket) return;
  accumulator.invalidSamples += bucket.invalidSamples;
  if (bucket.samples <= 0) return;
  accumulator.samples += bucket.samples;
  if (accumulator.firstTs === 0 || bucket.firstTs < accumulator.firstTs) accumulator.firstTs = bucket.firstTs;
  if (bucket.lastTs > accumulator.lastTs) accumulator.lastTs = bucket.lastTs;
  if (bucket.maxGapMs > accumulator.maxGapMs) accumulator.maxGapMs = bucket.maxGapMs;
  accumulator.count = (accumulator.count === null ? 0 : accumulator.count) + bucket.count;
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const value = bucket.hourly[hour];
    if (value === null) continue;
    accumulator.hourly[hour] = (accumulator.hourly[hour] === null ? 0 : accumulator.hourly[hour]) + value;
  }
}

function aggregateDay(activity, deviceIds, dateKey, clock, nowTs) {
  const accumulator = emptyAccumulator();
  for (const deviceId of deviceIds) accumulateDeviceDay(accumulator, activity, deviceId, dateKey, clock, nowTs);
  return accumulator;
}

function mergeAccumulators(accumulators) {
  const merged = emptyAccumulator();
  for (const accumulator of accumulators) {
    if (accumulator.count !== null) merged.count = (merged.count === null ? 0 : merged.count) + accumulator.count;
    merged.samples += accumulator.samples;
    merged.invalidSamples += accumulator.invalidSamples;
    if (accumulator.firstTs > 0 && (merged.firstTs === 0 || accumulator.firstTs < merged.firstTs)) {
      merged.firstTs = accumulator.firstTs;
    }
    if (accumulator.lastTs > merged.lastTs) merged.lastTs = accumulator.lastTs;
    if (accumulator.maxGapMs > merged.maxGapMs) merged.maxGapMs = accumulator.maxGapMs;
    merged.observedMs += accumulator.observedMs;
    merged.windowMs += accumulator.windowMs;
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      const value = accumulator.hourly[hour];
      if (value === null) continue;
      merged.hourly[hour] = (merged.hourly[hour] === null ? 0 : merged.hourly[hour]) + value;
    }
  }
  return merged;
}

function enumerateDays(fromKey, toKey) {
  const keys = [];
  let cursor = fromKey;
  while (cursor <= toKey && keys.length <= RETENTION_DAYS) {
    keys.push(cursor);
    cursor = addDaysKey(cursor, 1);
  }
  if (cursor <= toKey) fail('activity range exceeds retention cap');
  return keys;
}

function activityDeviceIds(activity, devices) {
  const ids = [];
  const seen = new Set();
  for (const deviceId of devices.keys()) {
    seen.add(deviceId);
    ids.push(deviceId);
  }
  for (const deviceId of activity.devices.keys()) {
    if (seen.has(deviceId)) continue;
    seen.add(deviceId);
    ids.push(deviceId);
  }
  return ids;
}

function dayView(dateKey, accumulator) {
  return {
    date: dateKey,
    count: accumulator.count,
    status: statusFrom(accumulator.samples, coverageOf(accumulator)),
    coverageRatio: round3(coverageOf(accumulator))
  };
}

function buildCoverageText(daysWithData, daysCount, coverageRatio) {
  if (daysCount === 0) return '暂无可统计日期。';
  const base = `${daysCount} 天中有 ${daysWithData} 天收到活动数据。`;
  if (coverageRatio === null) return `${base}暂无可用的数据覆盖率。`;
  return `${base}平均数据覆盖率 ${Math.round(coverageRatio * 100)}%。`;
}

/**
 * 趋势：必须最近连续 3 个“有数据日”都达到 ok 级别覆盖率才判断；
 * 逐日严格下降 -> down，严格上升 -> up，否则 stable；不足 3 天 -> insufficient。
 * 文案只做中性提示，禁止任何医学诊断或结论。
 */
function buildTrend(days) {
  let run = [];
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (days[index].count === null) break;
    run.unshift(days[index]);
  }
  if (run.length < 3) {
    return {
      state: 'insufficient',
      text: '活动数据不足，暂不判断趋势。',
      note: '连续有活动数据的日期不足 3 天，暂不判断趋势。'
    };
  }
  const last3 = run.slice(-3);
  const coverageEnough = last3.every((day) => day.coverageRatio !== null && day.coverageRatio >= COVERAGE_OK_RATIO);
  if (!coverageEnough) {
    return {
      state: 'insufficient',
      text: '活动数据不足，暂不判断趋势。',
      note: '最近 3 个有数据日的覆盖率不足 50%，暂不判断趋势。'
    };
  }
  const [oldest, middle, newest] = last3.map((day) => day.count);
  const dates = last3.map((day) => day.date).join('、');
  const note = `基于最近 3 个有数据日（${dates}）的活动次数，覆盖率均不低于 50%；不做医学判断。`;
  if (oldest > middle && middle > newest) {
    return { state: 'down', text: '近 3 天活动次数持续下降，可主动联系老人了解情况。', note };
  }
  if (oldest < middle && middle < newest) {
    return { state: 'up', text: '近 3 天活动次数呈上升趋势。', note };
  }
  return { state: 'stable', text: '近 3 天活动次数基本平稳。', note };
}

/**
 * 对比规则，绝不用 0 代替缺失数据：
 * selected/previous 任一 count 为 null 时 delta 和 pct 都是 null；
 * 任一侧覆盖率不足 -> insufficient；previous.count 为 0 时 pct 必须是 null（0 不能做分母）。
 */
function buildComparison(scope, selectedView, previousView) {
  const label = scope === 'day' ? '前一天' : '上一周期';
  const subject = scope === 'day' ? '所选日期' : '所选周期';
  if (selectedView.count === null) {
    return { state: 'selected_missing', delta: null, pct: null, text: `${subject}无活动数据，无法比较。` };
  }
  if (previousView.count === null) {
    return { state: 'previous_missing', delta: null, pct: null, text: `${label}无活动数据，无法比较。` };
  }
  if (selectedView.status === 'insufficient' || previousView.status === 'insufficient') {
    return { state: 'insufficient', delta: null, pct: null, text: '数据覆盖率不足，暂不做对比。' };
  }
  const delta = selectedView.count - previousView.count;
  if (previousView.count === 0) {
    return { state: 'previous_zero', delta, pct: null, text: `${label}活动为 0 次，无法计算变化百分比。` };
  }
  const pct = Math.round((delta / previousView.count) * 1000) / 10;
  let text;
  if (delta > 0) text = `较${label}增加 ${delta} 次（+${pct}%）。`;
  else if (delta < 0) text = `较${label}减少 ${-delta} 次（${pct}%）。`;
  else text = `与${label}持平。`;
  return { state: 'comparable', delta, pct, text };
}

function viewFromAccumulator(dateKey, accumulator) {
  return {
    date: dateKey,
    count: accumulator.count,
    status: statusFrom(accumulator.samples, coverageOf(accumulator)),
    samples: accumulator.samples,
    invalidSamples: accumulator.invalidSamples,
    firstTs: accumulator.firstTs,
    lastTs: accumulator.lastTs,
    maxGapMs: accumulator.maxGapMs,
    coverageRatio: round3(coverageOf(accumulator)),
    hourly: accumulator.hourly.slice()
  };
}

function historyNoteFor(clock, dataSince) {
  if (dataSince > 0) {
    return `活动历史仅从 ${clock.dateKey(dataSince)} 起累计；更早日期与无样本日期一律显示为“无数据”，不会用 0 填充。`;
  }
  return HISTORY_NOTE_EMPTY;
}

/**
 * 生成 `GET /api/v1/activity/report` 的响应体（字段与顺序即对外契约）。
 *
 * @param {object} options
 * @param {object} options.activity   MemoryStore/PersistentStore 的活动状态
 * @param {object} options.clock      家庭时区时钟
 * @param {Map}    options.devices    设备快照（用于 room / hasMotionSensor 兜底）
 * @param {number} options.now        查询时刻（毫秒）
 * @param {string} options.scope      day | week | month
 * @param {string|null} options.date  选中日期（YYYY-MM-DD），null 表示家庭时区的今天
 */
function buildActivityReport(options) {
  const { activity, clock, devices, scope } = options;
  const nowTs = Number.isSafeInteger(options.now) ? options.now : Date.now();
  const today = clock.dateKey(nowTs);
  const selectedDate = options.date || today;
  /**
   * 两个窗口要分开，否则 day 范围会把自己的 7 天趋势当成查询窗口：
   *   - 趋势序列 days[]：day/week 取截至选中日的最近 7 天，month 取 30 天，长度固定；
   *   - 所选统计窗口 range/summary/hourly：day 1 天，week 7 天，month 30 天。
   */
  const trendDays = scope === 'month' ? 30 : 7;
  const trendFrom = addDaysKey(selectedDate, -(trendDays - 1));
  const to = selectedDate;
  const range = scope === 'day'
    ? { from: selectedDate, to: selectedDate, days: 1 }
    : { from: trendFrom, to, days: trendDays };
  const deviceIds = activityDeviceIds(activity, devices);
  const dayKeys = enumerateDays(trendFrom, to);
  const dayAccumulators = dayKeys.map((key) => aggregateDay(activity, deviceIds, key, clock, nowTs));
  const days = dayKeys.map((key, index) => dayView(key, dayAccumulators[index]));
  const rangeAccumulator = mergeAccumulators(dayAccumulators);

  let selectedAccumulator;
  if (scope === 'day') selectedAccumulator = dayAccumulators[dayAccumulators.length - 1];
  else selectedAccumulator = rangeAccumulator;
  const selected = viewFromAccumulator(selectedDate, selectedAccumulator);

  let previousDate;
  let previousAccumulator;
  if (scope === 'day') {
    previousDate = addDaysKey(selectedDate, -1);
    previousAccumulator = aggregateDay(activity, deviceIds, previousDate, clock, nowTs);
  } else {
    const previousTo = addDaysKey(trendFrom, -1);
    const previousFrom = addDaysKey(previousTo, -(trendDays - 1));
    previousDate = previousTo;
    previousAccumulator = mergeAccumulators(
      enumerateDays(previousFrom, previousTo).map((key) => aggregateDay(activity, deviceIds, key, clock, nowTs))
    );
  }
  const previous = {
    date: previousDate,
    count: previousAccumulator.count,
    status: statusFrom(previousAccumulator.samples, coverageOf(previousAccumulator))
  };

  const deviceRows = deviceIds.map((deviceId) => {
    const deviceAccumulator = scope === 'day'
      ? aggregateDay(activity, [deviceId], selectedDate, clock, nowTs)
      : mergeAccumulators(dayKeys.map((key) => aggregateDay(activity, [deviceId], key, clock, nowTs)));
    const device = activity.devices.get(deviceId);
    const snapshot = devices.get(deviceId);
    return {
      deviceId,
      room: snapshot ? (snapshot.room || snapshot.roomName || '未分配') : '未分配',
      hasMotionSensor: Boolean(device && device.hasMotionSensor),
      count: deviceAccumulator.samples > 0 ? deviceAccumulator.count : null,
      status: statusFrom(deviceAccumulator.samples, coverageOf(deviceAccumulator))
    };
  }).sort((a, b) => a.room.localeCompare(b.room, 'zh-CN') || a.deviceId.localeCompare(b.deviceId));

  /**
   * summary 描述的是 range（所选统计窗口），不是趋势序列：day 只统计选中那一天，
   * 不能把 7 天趋势的总量当成“当日”汇总。
   */
  const summaryAccumulator = scope === 'day' ? selectedAccumulator : rangeAccumulator;
  const daysWithData = scope === 'day'
    ? (summaryAccumulator.count === null ? 0 : 1)
    : days.filter((day) => day.count !== null).length;
  const total = summaryAccumulator.count;
  const summaryCoverage = round3(coverageOf(summaryAccumulator));
  const dataSince = activityDataSince(activity);

  return {
    generatedAt: nowTs,
    timezone: activity.timezone,
    scope,
    today,
    selectedDate,
    range,
    dataSince,
    historyNote: historyNoteFor(clock, dataSince),
    selected,
    previous,
    comparison: buildComparison(scope, selected, previous),
    days,
    summary: {
      total,
      days: range.days,
      daysWithData,
      coverageRatio: summaryCoverage,
      coverageText: buildCoverageText(daysWithData, range.days, summaryCoverage)
    },
    hourly: selected.hourly.slice(),
    devices: deviceRows,
    trend: buildTrend(days),
    disclaimer: DISCLAIMER
  };
}

module.exports = {
  DEFAULT_TIMEZONE,
  RETENTION_DAYS,
  MIN_DAY_SAMPLES,
  COVERAGE_OK_RATIO,
  COVERAGE_PARTIAL_RATIO,
  MAX_SAMPLE_GAP_MS,
  DISCLAIMER,
  HISTORY_NOTE_EMPTY,
  addDaysKey,
  activityDataSince,
  activityFromDocument,
  activityToDocument,
  buildActivityReport,
  createActivityState,
  createHouseholdClock,
  isValidDateKey,
  normalizeActivityQuery,
  parseHouseholdTimezone,
  recordActivitySample
};
