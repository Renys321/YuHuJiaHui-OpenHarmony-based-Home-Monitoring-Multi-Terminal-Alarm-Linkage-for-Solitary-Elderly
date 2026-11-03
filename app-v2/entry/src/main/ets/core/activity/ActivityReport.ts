/**
 * 活动报告纯逻辑：防御式映射 + 日期计算 + 6 时段汇总 + 全部中性文案。
 *
 * 输入：Contracts.parseActivityReport 产出的 ActivityReportDto。
 * 输出：页面 @StorageLink 直接渲染的 ActivityReportView。
 *
 * 铁律（与比赛验收口径一致）：
 * - 无数据 ≠ 0：count=null 时所有文案显示“无数据”，不得出现“0 次活动”。
 * - 不诊断疾病、不评价健康、不宣称人数或“唯一动作次数”。
 * - 对比/趋势只描述 PIR 触发计数的变化，状态文案必须覆盖全部冻结枚举。
 */
import {
  ACTIVITY_SCOPES, ActivityComparisonDto, ActivityDayDto, ActivityDeviceDto, ActivityHourDto,
  ActivityPreviousDto, ActivityReportDto, ActivitySelectedDto, ActivityTrendDto,
  normalizeActivityComparisonState, normalizeActivityStatus, normalizeActivityScope,
  normalizeActivityTrendState
} from '../api/Contracts';
import {
  ActivityBucketView, ActivityComparisonState, ActivityComparisonView, ActivityDayView,
  ActivityDeviceView, ActivityHourView, ActivityReportView, ActivityScope, ActivityStatus,
  ActivitySummaryView, ActivityTrendState, ActivityTrendView, activityScopeLabel
} from './ActivityModels';

/** 活动报告免责声明（中性、无诊断、无人数口径）。 */
export const ACTIVITY_DISCLAIMER: string =
  '活动数据来自人体红外（PIR）触发计数，仅用于了解日常活动节律；' +
  '不构成医疗结论，也不代表人数或唯一动作次数。';

/** 时段条口径说明。 */
export const ACTIVITY_BUCKETS_NOTE: string =
  '由 24 小时活动数据汇总；某时段无数据时显示“无数据”，不按 0 计算。';

/** 分房间设备口径说明。 */
export const ACTIVITY_DEVICES_NOTE: string =
  '口径说明：PIR 触发计数 ≠ 人数，也不是唯一动作次数；无人体传感器或无数据时显示“无数据”。';

/** 无数据统一说明。 */
export const ACTIVITY_EMPTY_DESC_PREFIX: string =
  '未采集或数据不足时显示“无数据”，不会用 0 冒充真实活动。';

const ISO_DATE_RE: RegExp = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS: number = 24 * 60 * 60 * 1000;

/** scope 校验（合同冻结：day|week|month）。 */
export function isValidActivityScope(scope: string): boolean {
  if (typeof scope !== 'string') return false;
  for (let i = 0; i < ACTIVITY_SCOPES.length; i++) {
    if (ACTIVITY_SCOPES[i] === scope) return true;
  }
  return false;
}

/** YYYY-MM-DD 且必须是真实存在的日历日期（2026-02-30 非法）。 */
export function isValidIsoDate(date: string): boolean {
  if (typeof date !== 'string') return false;
  const matched: RegExpExecArray | null = ISO_DATE_RE.exec(date);
  if (matched === null) return false;
  const year: number = Number(matched[1]);
  const month: number = Number(matched[2]);
  const day: number = Number(matched[3]);
  if (!(month >= 1 && month <= 12)) return false;
  if (!(day >= 1 && day <= 31)) return false;
  const utc: Date = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day;
}

/** YYYY-MM-DD → UTC 毫秒；非法返回 null。 */
export function parseIsoDateMs(date: string): number | null {
  if (!isValidIsoDate(date)) return null;
  const matched: RegExpExecArray | null = ISO_DATE_RE.exec(date);
  if (matched === null) return null;
  return Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** UTC 毫秒 → YYYY-MM-DD。 */
export function formatIsoDate(ms: number): string {
  if (typeof ms !== 'number' || !isFinite(ms)) return '';
  const utc: Date = new Date(ms);
  return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
}

/**
 * 日期加减（跨月/跨年/闰年由 UTC 日历计算保证）：
 * shiftIsoDate('2026-10-01', -1) === '2026-09-30'；非法日期返回 ''。
 */
export function shiftIsoDate(date: string, deltaDays: number): string {
  const ms: number | null = parseIsoDateMs(date);
  if (ms === null) return '';
  if (typeof deltaDays !== 'number' || !isFinite(deltaDays)) return '';
  return formatIsoDate(ms + Math.floor(deltaDays) * DAY_MS);
}

/** a 是否晚于 b（按日历日，UTC 比较）；任一非法返回 false（页面用于禁止选择未来日期）。 */
export function isIsoDateAfter(a: string, b: string): boolean {
  const left: number | null = parseIsoDateMs(a);
  const right: number | null = parseIsoDateMs(b);
  if (left === null || right === null) return false;
  return left > right;
}

/**
 * epoch 毫秒 → 设备本地时区 `YYYY-MM-DD HH:mm`（dataSince 新格式的后备展示）。
 * 非法/非正数返回 ''，绝不显示 1970-01-01。
 */
export function formatLocalDateTimeText(ms: number): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
  const value: Date = new Date(Math.floor(ms));
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())} ` +
    `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
}

/** 数据状态文案。 */
export function formatActivityStatus(status: string): string {
  const normalized: string = normalizeActivityStatus(status);
  if (normalized === ActivityStatus.OK) return '数据完整';
  if (normalized === ActivityStatus.PARTIAL) return '数据部分覆盖';
  if (normalized === ActivityStatus.NO_DATA) return '无数据';
  return '数据不足';
}

/** 覆盖比例文案：null→覆盖未知；0–1→百分比；1–100 视为已是百分数。 */
export function formatCoverageRatio(ratio: number | null): string {
  if (ratio === null || typeof ratio !== 'number' || !isFinite(ratio) || ratio < 0) {
    return '覆盖未知';
  }
  let percent: number = ratio;
  if (ratio <= 1) percent = ratio * 100;
  if (percent > 100) return '覆盖未知';
  return `${Math.round(percent)}%`;
}

/** 活动计数文案：null 必须是“无数据”，不能是“0 次”。 */
export function formatActivityCount(count: number | null): string {
  if (count === null || typeof count !== 'number' || !isFinite(count) || count < 0) {
    return '无数据';
  }
  return `${Math.floor(count)} 次`;
}

class BucketDef {
  key: string = '';
  label: string = '';
  fromHour: number = 0;
  toHour: number = 0;
  rangeText: string = '';
}

function makeBucketDef(key: string, label: string, fromHour: number, toHour: number): BucketDef {
  const def = new BucketDef();
  def.key = key;
  def.label = label;
  def.fromHour = fromHour;
  def.toHour = toHour;
  def.rangeText = `${pad2(fromHour)}:00–${pad2(toHour === 24 ? 24 : toHour)}:00`;
  return def;
}

/** 6 个时段的冻结划分（需求指定：夜间/早晨/上午/下午/晚间/深夜）。 */
function bucketDefs(): BucketDef[] {
  return [
    makeBucketDef('night', '夜间', 0, 6),
    makeBucketDef('morning', '早晨', 6, 9),
    makeBucketDef('forenoon', '上午', 9, 12),
    makeBucketDef('afternoon', '下午', 12, 18),
    makeBucketDef('evening', '晚间', 18, 22),
    makeBucketDef('lateNight', '深夜', 22, 24)
  ];
}

/** 把 24 小时数据汇总为 6 个时段；全部小时缺失时该时段 count=null。 */
export function summarizeHourBuckets(hours: ActivityHourView[]): ActivityBucketView[] {
  const defs: BucketDef[] = bucketDefs();
  const result: ActivityBucketView[] = [];
  for (let i = 0; i < defs.length; i++) {
    const def: BucketDef = defs[i];
    const view = new ActivityBucketView();
    view.key = def.key;
    view.label = def.label;
    view.rangeText = def.rangeText;
    let sum: number = 0;
    let hasCount: boolean = false;
    let missingHour: boolean = false;
    for (let hour = def.fromHour; hour < def.toHour; hour++) {
      const item: ActivityHourView | null = hour < hours.length ? hours[hour] : null;
      const count: number | null = item !== null ? item.count : null;
      if (count === null) {
        missingHour = true;
      } else {
        hasCount = true;
        sum += count;
      }
    }
    view.hasCount = hasCount;
    view.count = hasCount ? sum : null;
    view.countText = hasCount ? `${sum} 次` : '无数据';
    view.partial = hasCount && missingHour;
    if (view.partial) view.countText = `${sum} 次（部分小时无数据）`;
    result.push(view);
  }
  return result;
}

function toHourViews(list: ActivityHourDto[]): ActivityHourView[] {
  const result: ActivityHourView[] = [];
  for (let i = 0; i < 24; i++) {
    const item = new ActivityHourView();
    item.hour = i;
    if (i < list.length) {
      const count: number | null = list[i].count;
      item.count = count !== null && isFinite(count) && count >= 0 ? Math.floor(count) : null;
    }
    result.push(item);
  }
  return result;
}

function hasHourlyData(list: ActivityHourDto[]): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i].count !== null) return true;
  }
  return false;
}

function dayLabel(date: string): string {
  if (typeof date === 'string' && date.length === 10) {
    return `${date.substring(5, 7)}/${date.substring(8, 10)}`;
  }
  return date.length > 0 ? date : '日期未知';
}

/**
 * 对比视图。scope=day 时与“前一日”对比；week/month 时服务端 previous 是
 * “上一等长周期”（7/30 天），因此文案必须用“上一周期/所选周期”，不能误称“前一日”。
 */
function buildComparison(scope: string, dto: ActivityComparisonDto, selected: ActivitySelectedDto,
  previous: ActivityPreviousDto): ActivityComparisonView {
  const isDay: boolean = normalizeActivityScope(scope) === ActivityScope.DAY;
  const periodLabel: string = isDay ? '前一日' : '上一周期';
  const selectedLabel: string = isDay ? '所选日期' : '所选周期';
  const view = new ActivityComparisonView();
  view.state = normalizeActivityComparisonState(dto.state);
  view.comparable = view.state === ActivityComparisonState.COMPARABLE;
  let delta: number | null = dto.delta;
  let pct: number | null = dto.pct;
  if (view.comparable) {
    if (delta === null && selected.count !== null && previous.count !== null) {
      delta = selected.count - previous.count;
    }
    if (pct === null && delta !== null && previous.count !== null && previous.count > 0) {
      pct = (delta / previous.count) * 100;
    }
  } else {
    delta = null;
    pct = null;
  }
  view.delta = delta;
  view.pct = pct;
  let localText: string = '';
  if (view.state === ActivityComparisonState.COMPARABLE) {
    view.stateText = `与${periodLabel}可比`;
    if (delta === null) {
      localText = `${periodLabel}对比数据不完整，暂不计算增减`;
    } else if (delta > 0) {
      localText = `较${periodLabel}增加 ${delta} 次`;
    } else if (delta < 0) {
      localText = `较${periodLabel}减少 ${-delta} 次`;
    } else {
      localText = `与${periodLabel}持平，活动次数未变化`;
    }
    if (delta !== null) {
      view.deltaText = delta > 0 ? `较${periodLabel} +${delta} 次`
        : (delta < 0 ? `较${periodLabel} ${delta} 次` : `与${periodLabel}持平`);
    }
    if (pct !== null) {
      view.pctText = pct > 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
      localText = `${localText}（${view.pctText}）`;
    }
  } else if (view.state === ActivityComparisonState.PREVIOUS_ZERO) {
    view.stateText = `${periodLabel}活动次数为 0`;
    localText = `${periodLabel}活动次数为 0，无法计算百分比对比`;
  } else if (view.state === ActivityComparisonState.PREVIOUS_MISSING) {
    view.stateText = `${periodLabel}无数据`;
    localText = `${periodLabel}未采集到活动数据，不做对比`;
  } else if (view.state === ActivityComparisonState.SELECTED_MISSING) {
    view.stateText = `${selectedLabel}无数据`;
    localText = `${selectedLabel}无活动数据，无法与${periodLabel}对比`;
  } else {
    view.state = ActivityComparisonState.INSUFFICIENT;
    view.stateText = '数据不足，暂不对比';
    localText = '数据不足，暂不进行增减对比';
  }
  view.text = dto.text.length > 0 ? dto.text : localText;
  return view;
}

function buildTrend(dto: ActivityTrendDto): ActivityTrendView {
  const view = new ActivityTrendView();
  view.state = normalizeActivityTrendState(dto.state);
  if (view.state === ActivityTrendState.STABLE) {
    view.stateText = '平稳';
  } else if (view.state === ActivityTrendState.UP) {
    view.stateText = '上升';
  } else if (view.state === ActivityTrendState.DOWN) {
    view.stateText = '下降';
  } else {
    view.state = ActivityTrendState.INSUFFICIENT;
    view.stateText = '数据不足';
  }
  let localText: string = '活动数据不足，暂不判断变化趋势';
  if (view.state === ActivityTrendState.STABLE) {
    localText = '近期活动量基本平稳';
  } else if (view.state === ActivityTrendState.UP) {
    localText = '近期活动量较前期增加';
  } else if (view.state === ActivityTrendState.DOWN) {
    localText = '近期活动量较前期减少';
  }
  view.text = dto.text.length > 0 ? dto.text : localText;
  view.note = dto.note.length > 0 ? dto.note
    : '趋势只描述活动次数变化，不构成医疗结论；数据不足时不给出方向性判断。';
  return view;
}

function buildDays(list: ActivityDayDto[]): ActivityDayView[] {
  const result: ActivityDayView[] = [];
  for (let i = 0; i < list.length; i++) {
    const dto: ActivityDayDto = list[i];
    const view = new ActivityDayView();
    view.date = dto.date;
    view.label = dayLabel(dto.date);
    view.status = normalizeActivityStatus(dto.status);
    view.hasCount = dto.count !== null;
    view.count = dto.count;
    view.countText = formatActivityCount(dto.count);
    view.statusText = formatActivityStatus(dto.status);
    view.isZero = dto.count !== null && dto.count === 0 &&
      (view.status === ActivityStatus.OK || view.status === ActivityStatus.PARTIAL);
    result.push(view);
  }
  let max: number = 0;
  for (let i = 0; i < result.length; i++) {
    const count: number | null = result[i].count;
    if (count !== null && count > max) max = count;
  }
  for (let i = 0; i < result.length; i++) {
    const count: number | null = result[i].count;
    result[i].ratio = count !== null && max > 0 ? count / max : 0;
  }
  return result;
}

function buildDevices(list: ActivityDeviceDto[]): ActivityDeviceView[] {
  const result: ActivityDeviceView[] = [];
  for (let i = 0; i < list.length; i++) {
    const dto: ActivityDeviceDto = list[i];
    const view = new ActivityDeviceView();
    view.deviceId = dto.deviceId;
    view.room = dto.room;
    view.roomText = dto.room.length > 0 ? dto.room : '房间未知';
    view.hasMotionSensor = dto.hasMotionSensor;
    view.hasCount = dto.count !== null;
    view.count = dto.count;
    view.countText = formatActivityCount(dto.count);
    view.status = normalizeActivityStatus(dto.status);
    view.statusText = formatActivityStatus(dto.status);
    result.push(view);
  }
  return result;
}

function selectedSamplesText(dto: ActivitySelectedDto): string {
  if (!dto.samplesPresent) return '';
  let text: string = `样本 ${dto.samples} 条`;
  if (dto.invalidSamplesPresent && dto.invalidSamples > 0) {
    text = `${text}（无效 ${dto.invalidSamples} 条）`;
  }
  return text;
}

/**
 * DTO → 页面视图。nowMs 仅用于未来可能的时间显示；当前不依赖系统时间，
 * 因此测试可传 0 得到稳定结果。
 */
export function mapActivityReport(dto: ActivityReportDto, nowMs: number = 0): ActivityReportView {
  const view = new ActivityReportView();
  view.hasData = true;
  view.generatedAt = dto.generatedAt;
  view.timezone = dto.timezone;
  view.scope = normalizeActivityScope(dto.scope);
  view.scopeLabel = activityScopeLabel(view.scope);
  view.today = dto.today;
  view.selectedDate = dto.selectedDate.length > 0 ? dto.selectedDate : dto.selected.date;
  view.rangeFrom = dto.range.from;
  view.rangeTo = dto.range.to;
  view.rangeDays = dto.range.days;
  if (dto.range.from.length > 0 && dto.range.to.length > 0) {
    view.rangeText = `${dto.range.from} ~ ${dto.range.to}（${dto.range.days} 天）`;
  } else if (dto.range.days > 0) {
    view.rangeText = `${dto.range.days} 天`;
  } else {
    view.rangeText = '范围未知';
  }
  // dataSince 兼容三种形态：新 dataSinceText（家庭时区文本）>
  // 新 dataSinceMs（epoch 毫秒，按设备本地时区格式化）> 旧 string。
  let dataSinceDisplay: string = '';
  if (dto.dataSinceText.length > 0) {
    dataSinceDisplay = dto.dataSinceText;
  } else if (dto.dataSinceMs > 0) {
    dataSinceDisplay = formatLocalDateTimeText(dto.dataSinceMs);
  } else if (dto.dataSince.length > 0) {
    dataSinceDisplay = dto.dataSince;
  }
  view.dataSince = dataSinceDisplay;
  view.hasDataSince = dataSinceDisplay.length > 0;
  view.historyNote = dto.historyNote;
  view.historyText = dataSinceDisplay.length > 0 ? `数据自 ${dataSinceDisplay} 起` : '数据起始时间未知';

  // 选定日期 / 前一日
  view.selectedDateText = dto.selected.date.length > 0 ? dto.selected.date
    : (view.selectedDate.length > 0 ? view.selectedDate : '日期未知');
  view.selectedCount = dto.selected.count;
  view.selectedCountText = formatActivityCount(dto.selected.count);
  view.selectedStatus = normalizeActivityStatus(dto.selected.status);
  view.selectedStatusText = formatActivityStatus(dto.selected.status);
  view.selectedCoverageText = formatCoverageRatio(dto.selected.coverageRatio);
  view.selectedSamplesText = selectedSamplesText(dto.selected);
  view.previousDate = dto.previous.date;
  view.previousCount = dto.previous.count;
  view.previousCountText = formatActivityCount(dto.previous.count);
  view.previousStatus = normalizeActivityStatus(dto.previous.status);
  view.previousStatusText = formatActivityStatus(dto.previous.status);

  // 对比 / 趋势
  view.comparison = buildComparison(view.scope, dto.comparison, dto.selected, dto.previous);
  view.trend = buildTrend(dto.trend);

  // 24 小时 → 6 时段（顶层 hourly 优先；顶层全空时回退 selected.hourly，避免两份数据不一致）
  let hourlyDto: ActivityHourDto[] = dto.hourly;
  if (!hasHourlyData(hourlyDto) && hasHourlyData(dto.selected.hourly)) {
    hourlyDto = dto.selected.hourly;
  }
  const hours: ActivityHourView[] = toHourViews(hourlyDto);
  view.hourlyAvailable = hasHourlyData(hourlyDto);
  view.buckets = summarizeHourBuckets(hours);
  let bucketMax: number = 0;
  for (let i = 0; i < view.buckets.length; i++) {
    const count: number | null = view.buckets[i].count;
    if (count !== null && count > bucketMax) bucketMax = count;
  }
  for (let i = 0; i < view.buckets.length; i++) {
    const count: number | null = view.buckets[i].count;
    view.buckets[i].ratio = count !== null && bucketMax > 0 ? count / bucketMax : 0;
  }
  view.hourlyNote = view.hourlyAvailable
    ? '小时分布来自服务端 24 小时桶，按 6 个时段汇总展示。'
    : '服务端未返回小时分布，无法展示时段分布。';
  view.bucketsNote = ACTIVITY_BUCKETS_NOTE;

  // 每日趋势（页面最多展示最近 7 天）
  view.days = buildDays(dto.days);
  const recent: ActivityDayView[] = [];
  const startIndex: number = view.days.length > 7 ? view.days.length - 7 : 0;
  for (let i = startIndex; i < view.days.length; i++) {
    recent.push(view.days[i]);
  }
  view.recentDays = recent;
  view.daysNote = view.days.length === 0
    ? '服务端未返回每日趋势数据。'
    : '无数据日显示“无数据”，不按 0 计算。';

  // 汇总 / KPI
  const summary = new ActivitySummaryView();
  summary.total = dto.summary.total;
  summary.hasTotal = dto.summary.total !== null;
  summary.totalText = formatActivityCount(dto.summary.total);
  summary.days = dto.summary.days;
  summary.daysWithData = dto.summary.daysWithData;
  summary.coverageRatio = dto.summary.coverageRatio;
  summary.coverageText = dto.summary.coverageText.length > 0
    ? dto.summary.coverageText : formatCoverageRatio(dto.summary.coverageRatio);
  view.summary = summary;

  // 后端 week/month 是“截至所选日的滚动 7/30 天”，不是自然周/自然月；
  // 标签必须写成滚动窗口，避免被读成周一至周日或自然月。
  if (view.scope === ActivityScope.WEEK) {
    view.countKpiLabel = '近 7 日活动次数';
  } else if (view.scope === ActivityScope.MONTH) {
    view.countKpiLabel = '近 30 日活动次数';
  } else {
    view.countKpiLabel = '当日活动次数';
  }
  let kpiCount: number | null = dto.selected.count;
  if (view.scope !== ActivityScope.DAY) {
    kpiCount = dto.summary.total !== null ? dto.summary.total : dto.selected.count;
  } else if (kpiCount === null) {
    kpiCount = dto.summary.total;
  }
  view.countKpiText = formatActivityCount(kpiCount);
  view.avgKpiText = (dto.summary.total !== null && dto.summary.daysWithData > 0)
    ? `${(dto.summary.total / dto.summary.daysWithData).toFixed(1)} 次/日` : '--';
  view.coverageKpiText = summary.coverageText;

  // 设备分房间
  view.devices = buildDevices(dto.devices);
  view.devicesNote = ACTIVITY_DEVICES_NOTE;

  view.disclaimer = dto.disclaimer.length > 0 ? dto.disclaimer : ACTIVITY_DISCLAIMER;

  // 空态判定：只有确认没有任何真实计数时才为空
  let anyCount: boolean = dto.selected.count !== null || dto.summary.total !== null ||
    view.hourlyAvailable;
  if (!anyCount) {
    for (let i = 0; i < view.recentDays.length; i++) {
      if (view.recentDays[i].count !== null) {
        anyCount = true;
        break;
      }
    }
  }
  if (!anyCount) {
    for (let i = 0; i < view.devices.length; i++) {
      if (view.devices[i].count !== null) {
        anyCount = true;
        break;
      }
    }
  }
  view.isEmpty = !anyCount;
  if (view.isEmpty) {
    if (view.selectedStatus === ActivityStatus.NO_DATA) {
      view.emptyTitle = '该日期无活动数据';
    } else if (view.selectedStatus === ActivityStatus.INSUFFICIENT) {
      view.emptyTitle = '活动数据不足';
    } else {
      view.emptyTitle = '暂无活动报告数据';
    }
    const coverage: string = summary.coverageText.length > 0 ? summary.coverageText : '覆盖未知';
    const note: string = dto.historyNote.length > 0 ? `${dto.historyNote} ` : '';
    view.emptyDescription = `${note}数据覆盖 ${coverage}。${ACTIVITY_EMPTY_DESC_PREFIX}`;
  }
  return view;
}

/** 空报告视图（首次进入/未加载时使用；不伪造任何数字）。 */
export function emptyActivityReportView(): ActivityReportView {
  const view = new ActivityReportView();
  view.isEmpty = true;
  view.emptyTitle = '活动报告尚未加载';
  view.emptyDescription = '选择日期与范围后加载真实活动数据。';
  view.disclaimer = ACTIVITY_DISCLAIMER;
  view.devicesNote = ACTIVITY_DEVICES_NOTE;
  view.bucketsNote = ACTIVITY_BUCKETS_NOTE;
  return view;
}
