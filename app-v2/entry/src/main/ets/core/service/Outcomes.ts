/**
 * 登录/刷新/ACK/处置结果对象（纯逻辑，可测）。
 */
import { EvidenceImageBytes } from '../evidence/EvidenceCore';
import { ActivityReportView } from '../activity/ActivityModels';
import { DispositionView, DoorEventView } from '../view/Models';
import { HealthAdviceView } from '../health/HealthAdvice';
import { HealthFieldError, HealthProfileView } from '../health/HealthModels';
import { LocationPointDto } from '../api/Contracts';

export class LoginOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  retryAfterSeconds: number = 0;
}

export class RefreshOutcome {
  ok: boolean = false;
  partial: boolean = false;
  message: string = '';
  updatedAt: number = 0;
  unauthorized: boolean = false;
  /** 响应返回时会话已切换，本次结果被丢弃（页面不得据此更新 UI）。 */
  stale: boolean = false;
}

export class EvidenceOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  image: EvidenceImageBytes | null = null;
}

export class AckOutcome {
  accepted: boolean = false;
  kind: string = '';
  message: string = '';
  serverStatus: string = '';
}

/**
 * 登记处置结果（POST dispositions）。
 * ok=false 时绝不能显示“已保存”；created/duplicate 只来自服务端响应。
 */
export class DispositionSubmitOutcome {
  ok: boolean = false;
  /** true=首次创建(201)，false=服务端幂等重放(200) */
  created: boolean = false;
  duplicate: boolean = false;
  kind: string = '';
  message: string = '';
  disposition: DispositionView | null = null;
  /** 会话已切换，本次结果必须被页面丢弃。 */
  stale: boolean = false;
}

/** 查询单条告警的已保存处置记录（GET dispositions）。 */
export class DispositionsOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  items: DispositionView[] = [];
  stale: boolean = false;
}

/** 查询安全日志历史（GET safety-logs）。失败时不回退演示数据。 */
export class SafetyLogsOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  items: DispositionView[] = [];
  stale: boolean = false;
  loadedAt: number = 0;
}

/** 查询门磁开关事件历史（GET door-events）。失败时不回退演示数据。 */
export class DoorEventsOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  items: DoorEventView[] = [];
  stale: boolean = false;
  deviceId: string = '';
  loadedAt: number = 0;
}

/**
 * 设备最近定位（GET /api/v1/location）。
 * 仅用于 MANUAL_SOS 告警缺少 sosLocation 时的“最近定位”兜底；
 * 失败/空列表都不得伪造坐标（页面显示明确无定位状态）。
 */
export class LocationsOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  items: LocationPointDto[] = [];
  stale: boolean = false;
  loadedAt: number = 0;
}

/**
 * 活动报告加载结果（GET /api/v1/activity/report）。
 * ok=false 时页面必须保留上一次成功加载的真实报告（不得清空、不得回退演示数据）。
 */
export class ActivityReportOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  report: ActivityReportView | null = null;
  /** 会话已切换，本次结果必须被页面丢弃。 */
  stale: boolean = false;
}


/**
 * 健康资料加载/保存结果（GET/PUT /api/v1/health-profile）。
 * ok=false 时页面必须显示明确失败状态与重试按钮，且绝不显示本地伪造资料。
 */
export class HealthProfileOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  /** 与 HealthProfileStatus 一致，页面可据此显示状态。 */
  status: string = '';
  /** true = 服务端确实有资料；false = 还没有资料（200 + profile:null）。 */
  present: boolean = false;
  view: HealthProfileView | null = null;
  /** 本地校验失败时的字段错误（field/message），供页面定位输入项。 */
  fields: HealthFieldError[] = [];
  /** 会话已切换，本次结果必须被页面丢弃。 */
  stale: boolean = false;
}

/**
 * 健康科普建议生成结果（POST /api/v1/health-advice）。
 * ok=false 时 view 必须为 null：任何失败都绝不返回本地伪造建议。
 */
export class HealthAdviceOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  /** 与 HealthAdviceFlowState 一致（ok/timeout/failed/empty/not_configured/unauthorized/demo_mode）。 */
  status: string = '';
  view: HealthAdviceView | null = null;
  /** 会话已切换，本次结果必须被页面丢弃。 */
  stale: boolean = false;
}