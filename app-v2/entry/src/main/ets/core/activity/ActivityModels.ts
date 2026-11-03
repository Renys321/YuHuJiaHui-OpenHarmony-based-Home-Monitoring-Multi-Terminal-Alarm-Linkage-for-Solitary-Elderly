/**
 * 活动报告视图模型（纯数据，不含 UI 装饰器）—— 可被 Node 测试。
 *
 * 语义约束（与 GET /api/v1/activity/report 合同一致）：
 * - 活动次数只来自服务端 count；count 缺失一律为 null，页面显示“无数据”，
 *   绝不用 0 冒充“没有活动”。
 * - status：ok 完整 / partial 部分覆盖 / insufficient 数据不足 / no_data 无数据。
 * - 时段分布由 24 小时数组汇总成 6 个时段；某个小时无数据为 null。
 * - 对比状态、趋势状态各自有独立文案，未知状态降级为 insufficient。
 * - 所有文案只描述“PIR 触发计数变化”，不做健康/疾病判断，不宣称人数或唯一动作次数。
 */

/** 查询范围（合同冻结：day|week|month）。 */
export class ActivityScope {
  static readonly DAY: string = 'day';
  static readonly WEEK: string = 'week';
  static readonly MONTH: string = 'month';
}

/** 数据状态（合同冻结）。 */
export class ActivityStatus {
  static readonly OK: string = 'ok';
  static readonly PARTIAL: string = 'partial';
  static readonly INSUFFICIENT: string = 'insufficient';
  static readonly NO_DATA: string = 'no_data';
}

/** 与前一日对比状态（合同冻结）。 */
export class ActivityComparisonState {
  static readonly COMPARABLE: string = 'comparable';
  static readonly PREVIOUS_ZERO: string = 'previous_zero';
  static readonly PREVIOUS_MISSING: string = 'previous_missing';
  static readonly SELECTED_MISSING: string = 'selected_missing';
  static readonly INSUFFICIENT: string = 'insufficient';
}

/** 趋势状态（合同冻结）。 */
export class ActivityTrendState {
  static readonly INSUFFICIENT: string = 'insufficient';
  static readonly STABLE: string = 'stable';
  static readonly UP: string = 'up';
  static readonly DOWN: string = 'down';
}

/** 活动报告加载生命周期（写入 AppStorage gv.activityStatus）。 */
export class ActivityLoadState {
  static readonly IDLE: string = 'idle';
  static readonly LOADING: string = 'loading';
  static readonly OK: string = 'ok';
  static readonly EMPTY: string = 'empty';
  static readonly ERROR: string = 'error';
  static readonly UNAUTHORIZED: string = 'unauthorized';
}

export function activityScopeLabel(scope: string): string {
  if (scope === ActivityScope.WEEK) return '周';
  if (scope === ActivityScope.MONTH) return '月';
  return '日';
}

/** 单个小时的活动计数；count=null 表示该小时无数据（不是 0 次）。 */
export class ActivityHourView {
  hour: number = 0;
  count: number | null = null;
}

/** 6 个时段之一（由 24 小时数据汇总）。 */
export class ActivityBucketView {
  key: string = '';
  label: string = '';
  rangeText: string = '';
  count: number | null = null;
  hasCount: boolean = false;
  countText: string = '无数据';
  /** 相对本组最大值的比例（0–1），仅用于条形宽度。 */
  ratio: number = 0;
  /** 该时段内有小时缺失数据（已统计的小时仍展示）。 */
  partial: boolean = false;
}

/** 每日趋势中的一天；count=null 表示当天无数据，必须显示“无数据”而不是 0。 */
export class ActivityDayView {
  date: string = '';
  label: string = '';
  count: number | null = null;
  hasCount: boolean = false;
  countText: string = '无数据';
  status: string = ActivityStatus.INSUFFICIENT;
  statusText: string = '数据不足';
  /** 相对本组最大值的比例（0–1），仅用于柱高。 */
  ratio: number = 0;
  /** 真实 0 次（count=0 且状态为 ok/partial）。 */
  isZero: boolean = false;
}

/** 分房间设备活动计数；计数口径是 PIR 触发次数，不是人数。 */
export class ActivityDeviceView {
  deviceId: string = '';
  room: string = '';
  roomText: string = '房间未知';
  hasMotionSensor: boolean = false;
  count: number | null = null;
  hasCount: boolean = false;
  countText: string = '无数据';
  status: string = ActivityStatus.INSUFFICIENT;
  statusText: string = '数据不足';
}

/** 今日/选定日期 vs 前一日的对比视图。 */
export class ActivityComparisonView {
  state: string = ActivityComparisonState.INSUFFICIENT;
  stateText: string = '数据不足，暂不对比';
  /** 完整中性文案（优先使用服务端 comparison.text，缺失时本地生成）。 */
  text: string = '';
  delta: number | null = null;
  deltaText: string = '';
  pct: number | null = null;
  pctText: string = '';
  comparable: boolean = false;
}

/** 中性趋势提示（不诊断疾病）。 */
export class ActivityTrendView {
  state: string = ActivityTrendState.INSUFFICIENT;
  stateText: string = '数据不足';
  text: string = '活动数据不足，暂不判断变化趋势';
  note: string = '';
}

/** 周/月汇总与数据覆盖。 */
export class ActivitySummaryView {
  total: number | null = null;
  hasTotal: boolean = false;
  totalText: string = '无数据';
  days: number = 0;
  daysWithData: number = 0;
  coverageRatio: number | null = null;
  coverageText: string = '覆盖未知';
}

/**
 * 活动报告完整视图（页面通过 @StorageLink('gv.activityReport') 读取）。
 * hasData=true 表示服务端确实返回了一份报告；isEmpty=true 表示报告里没有任何真实计数。
 */
export class ActivityReportView {
  hasData: boolean = false;
  isEmpty: boolean = true;
  emptyTitle: string = '暂无活动报告数据';
  emptyDescription: string = '';

  generatedAt: number = 0;
  timezone: string = '';
  scope: string = ActivityScope.DAY;
  scopeLabel: string = '日';
  today: string = '';
  selectedDate: string = '';

  rangeFrom: string = '';
  rangeTo: string = '';
  rangeDays: number = 0;
  rangeText: string = '';

  dataSince: string = '';
  hasDataSince: boolean = false;
  historyNote: string = '';
  historyText: string = '';

  // KPI
  countKpiLabel: string = '当日活动次数';
  countKpiText: string = '--';
  avgKpiLabel: string = '日均活动次数';
  avgKpiText: string = '--';
  coverageKpiLabel: string = '数据覆盖';
  coverageKpiText: string = '--';

  // 选定范围 / 前一日
  selectedDateText: string = '';
  selectedCount: number | null = null;
  selectedCountText: string = '无数据';
  selectedStatus: string = ActivityStatus.INSUFFICIENT;
  selectedStatusText: string = '数据不足';
  selectedCoverageText: string = '覆盖未知';
  selectedSamplesText: string = '';
  previousDate: string = '';
  previousCount: number | null = null;
  previousCountText: string = '无数据';
  previousStatus: string = ActivityStatus.INSUFFICIENT;
  previousStatusText: string = '数据不足';

  comparison: ActivityComparisonView = new ActivityComparisonView();
  trend: ActivityTrendView = new ActivityTrendView();

  // 24 小时 → 6 时段
  hourlyAvailable: boolean = false;
  hourlyNote: string = '';
  bucketsNote: string = '由 24 小时活动数据汇总';
  buckets: ActivityBucketView[] = [];

  // 每日趋势（最多展示最近 7 天）
  days: ActivityDayView[] = [];
  recentDays: ActivityDayView[] = [];
  daysNote: string = '';

  summary: ActivitySummaryView = new ActivitySummaryView();
  devices: ActivityDeviceView[] = [];
  devicesNote: string = 'PIR 触发计数不等于人数，也不是唯一动作次数；无数据时显示“无数据”。';
  disclaimer: string = '';
}
