/**
 * 健康科普建议：响应解析、状态机、UI 文案与视图（纯逻辑，Node 测试直接执行）。
 *
 * 唯一事实来源：`competition/docs/AI-HEALTH-ASSESSMENT-SPEC.md` §2.3 / §5.1。
 *
 * 铁律：
 * - **任何失败都绝不伪造建议**：解析失败/红线词/缺免责声明一律返回 null，
 *   页面只能显示失败状态与重试按钮；
 * - 免责声明固定为 `HEALTH_ADVICE_DISCLAIMER`，忽略服务端返回的其他文本；
 * - 服务端可能返回未来新增字段：忽略未知字段，不让缺字段/类型错误把页面打崩；
 * - 红线词二次防御：即使服务端漏检，客户端也不会把越界文本交给页面展示。
 */
import { hasOwn, isRecord, parseJsonObject } from '../util/Json';
import { ApiErrorKinds } from '../api/Errors';
import {
  fillHealthProfileDto, HEALTH_ADVICE_DISCLAIMER, HealthProfileDto
} from './HealthModels';

// ------------------------------------------------------------- 红线词

/**
 * 建议四段文本里的红线词（与后端 §3.5 同一集合）。
 * 命中任意一个即视为越界：解析返回 null，页面显示失败，绝不展示该内容。
 */
export const HEALTH_ADVICE_RED_LINE_TERMS: string[] = [
  '你患有',
  '确诊为',
  '诊断结果',
  '建议服用',
  '请服用',
  '应服用',
  '停止用药',
  '停药',
  '调整剂量',
  '加大剂量',
  '减少剂量',
  '处方',
  '治疗方案',
  '病情等级',
  '患病概率',
  '治愈率'
];

/** 扫描红线词；返回命中列表（稳定顺序、去重）。 */
export function scanHealthAdviceRedLines(text: string): string[] {
  const hits: string[] = [];
  if (typeof text !== 'string' || text.length === 0) {
    return hits;
  }
  for (let i = 0; i < HEALTH_ADVICE_RED_LINE_TERMS.length; i++) {
    const term: string = HEALTH_ADVICE_RED_LINE_TERMS[i];
    if (text.indexOf(term) >= 0) {
      hits.push(term);
    }
  }
  return hits;
}

// ------------------------------------------------------------- DTO

/** 健康建议四段（§2.3）。 */
export class HealthAdviceDto {
  summary: string = '';
  diet: string[] = [];
  exerciseAndSleep: string[] = [];
  warningSigns: string[] = [];
  disclaimer: string = HEALTH_ADVICE_DISCLAIMER;
}

/** 单段建议的展示结构（页面结果面板使用）。 */
export class HealthAdviceSection {
  key: string = '';
  title: string = '';
  note: string = '';
  items: string[] = [];
}

/** GET /api/v1/health-profile 解析结果：present=false 表示“还没有资料”。 */
export class HealthProfileParseResult {
  present: boolean = false;
  profile: HealthProfileDto = new HealthProfileDto();
}

/** POST /api/v1/health-advice 解析结果。 */
export class HealthAdviceParseResult {
  advice: HealthAdviceDto = new HealthAdviceDto();
  generatedAt: number = 0;
  model: string = '';
}

/** 解析 `{"profile": <HealthProfile>|null}`；结构非法返回 null，缺字段不崩。 */
export function parseHealthProfileResponse(text: string): HealthProfileParseResult | null {
  const root: any = parseJsonObject(text);
  if (root === null) {
    return null;
  }
  if (!hasOwn(root, 'profile')) {
    return null;
  }
  const raw: any = root['profile'];
  const result = new HealthProfileParseResult();
  if (raw === null || raw === undefined) {
    result.present = false;
    return result;
  }
  if (!isRecord(raw)) {
    return null;
  }
  result.present = true;
  result.profile = fillHealthProfileDto(raw);
  return result;
}

function readAdviceList(value: any): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length < 1 || value.length > 8) {
    return null;
  }
  const items: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item: any = value[i];
    if (typeof item !== 'string') {
      return null;
    }
    const trimmed: string = item.trim();
    if (trimmed.length === 0 || trimmed.length > 300) {
      return null;
    }
    items.push(trimmed);
  }
  return items;
}

/**
 * 解析 POST /api/v1/health-advice 响应。
 *
 * 返回 null 的条件（任一命中）：非 JSON 对象；缺 advice；summary 缺失/空/超长；
 * 三个列表缺失/为空/超 8 条/元素非法；缺 disclaimer；四段文本命中红线词。
 */
export function parseHealthAdviceResponse(text: string): HealthAdviceParseResult | null {
  const root: any = parseJsonObject(text);
  if (root === null) {
    return null;
  }
  const raw: any = root['advice'];
  if (!isRecord(raw)) {
    return null;
  }
  const summaryRaw: any = raw['summary'];
  if (typeof summaryRaw !== 'string') {
    return null;
  }
  const summary: string = summaryRaw.trim();
  if (summary.length === 0 || summary.length > 2000) {
    return null;
  }
  const diet: string[] | null = readAdviceList(raw['diet']);
  if (diet === null) {
    return null;
  }
  const exerciseAndSleep: string[] | null = readAdviceList(raw['exerciseAndSleep']);
  if (exerciseAndSleep === null) {
    return null;
  }
  const warningSigns: string[] | null = readAdviceList(raw['warningSigns']);
  if (warningSigns === null) {
    return null;
  }
  const disclaimerRaw: any = raw['disclaimer'];
  if (typeof disclaimerRaw !== 'string' || disclaimerRaw.trim().length === 0) {
    return null;
  }
  // 红线词二次防御：只扫描四段正文（免责声明是固定常量，不参与扫描）。
  const scanned: string = [summary].concat(diet).concat(exerciseAndSleep).concat(warningSigns)
    .join('\n');
  if (scanHealthAdviceRedLines(scanned).length > 0) {
    return null;
  }
  const result = new HealthAdviceParseResult();
  result.advice.summary = summary;
  result.advice.diet = diet;
  result.advice.exerciseAndSleep = exerciseAndSleep;
  result.advice.warningSigns = warningSigns;
  // 服务端应强制固定免责声明；客户端同样强制固定，绝不展示服务端变体。
  result.advice.disclaimer = HEALTH_ADVICE_DISCLAIMER;
  const generatedAt: any = root['generatedAt'];
  result.generatedAt =
    typeof generatedAt === 'number' && isFinite(generatedAt) && generatedAt > 0 ? generatedAt : 0;
  const model: any = root['model'];
  result.model = typeof model === 'string' ? model : '';
  return result;
}

// ------------------------------------------------------------- 状态机

/** 健康资料加载/保存状态（写入 AppStorage gv.healthStatus）。 */
export class HealthProfileStatus {
  static readonly IDLE: string = 'idle';
  static readonly LOADING: string = 'loading';
  static readonly OK: string = 'ok';
  /** 200 + {"profile":null}：还没有任何健康资料。 */
  static readonly EMPTY: string = 'empty';
  static readonly ERROR: string = 'error';
  static readonly UNAUTHORIZED: string = 'unauthorized';
  static readonly DEMO: string = 'demo_mode';
}

/** 健康建议流程状态（写入 AppStorage gv.healthAdviceStatus）。 */
export class HealthAdviceFlowState {
  static readonly IDLE: string = 'idle';
  static readonly LOADING: string = 'loading';
  static readonly OK: string = 'ok';
  /** AI 超时（504 AI_TIMEOUT 或传输层超时）。 */
  static readonly TIMEOUT: string = 'timeout';
  /** AI 未配置（503 AI_NOT_CONFIGURED）。 */
  static readonly NOT_CONFIGURED: string = 'not_configured';
  /** 无可用资料（409 HEALTH_PROFILE_EMPTY）。 */
  static readonly EMPTY: string = 'empty';
  /** 其他失败（502/网络/非法响应）。 */
  static readonly FAILED: string = 'failed';
  static readonly UNAUTHORIZED: string = 'unauthorized';
  static readonly DEMO: string = 'demo_mode';
}

export const HEALTH_ADVICE_TIMEOUT_MESSAGE: string = '暂时无法生成建议，请稍后重试';
export const HEALTH_ADVICE_FAILED_MESSAGE: string = '暂时无法生成建议，请稍后重试';
export const HEALTH_ADVICE_EMPTY_MESSAGE: string = '还没有健康资料，请先填写并保存';
export const HEALTH_ADVICE_UNAVAILABLE_MESSAGE: string = '健康建议服务暂未开放';
export const HEALTH_ADVICE_UNAUTHORIZED_MESSAGE: string = '会话已过期，请重新登录';
export const HEALTH_ADVICE_GENERATING_MESSAGE: string = '正在生成健康科普建议…';
export const HEALTH_ADVICE_DEMO_MESSAGE: string = '演示模式不调用网络，请退出演示后使用健康评估';

/** 状态 → 中文 UI 文案（失败只描述失败，绝不生成/伪造建议）。 */
export function healthAdviceMessage(status: string): string {
  if (typeof status !== 'string') {
    return '';
  }
  if (status === HealthAdviceFlowState.TIMEOUT) {
    return HEALTH_ADVICE_TIMEOUT_MESSAGE;
  }
  if (status === HealthAdviceFlowState.EMPTY) {
    return HEALTH_ADVICE_EMPTY_MESSAGE;
  }
  if (status === HealthAdviceFlowState.NOT_CONFIGURED) {
    return HEALTH_ADVICE_UNAVAILABLE_MESSAGE;
  }
  if (status === HealthAdviceFlowState.FAILED) {
    return HEALTH_ADVICE_FAILED_MESSAGE;
  }
  if (status === HealthAdviceFlowState.UNAUTHORIZED) {
    return HEALTH_ADVICE_UNAUTHORIZED_MESSAGE;
  }
  if (status === HealthAdviceFlowState.DEMO) {
    return HEALTH_ADVICE_DEMO_MESSAGE;
  }
  if (status === HealthAdviceFlowState.LOADING) {
    return HEALTH_ADVICE_GENERATING_MESSAGE;
  }
  return '';
}

/**
 * ApiError(kind) + HTTP status → 健康建议流程状态。
 * 409=资料为空；503=AI 未配置；504=AI 超时；502/网络/其他=通用失败。
 */
export function healthAdviceFlowForError(kind: string, status: number): string {
  if (kind === ApiErrorKinds.UNAUTHORIZED || kind === ApiErrorKinds.FORBIDDEN) {
    return HealthAdviceFlowState.UNAUTHORIZED;
  }
  if (status === 409) {
    return HealthAdviceFlowState.EMPTY;
  }
  if (status === 503) {
    return HealthAdviceFlowState.NOT_CONFIGURED;
  }
  if (status === 504 || kind === ApiErrorKinds.TIMEOUT) {
    return HealthAdviceFlowState.TIMEOUT;
  }
  return HealthAdviceFlowState.FAILED;
}

// ------------------------------------------------------------- 视图

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatAdviceTime(ms: number): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) {
    return '';
  }
  const date: Date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 结果面板视图（固定 4 段 + 固定免责声明）。 */
export class HealthAdviceView {
  hasAdvice: boolean = false;
  summary: string = '';
  diet: string[] = [];
  exerciseAndSleep: string[] = [];
  warningSigns: string[] = [];
  disclaimer: string = HEALTH_ADVICE_DISCLAIMER;
  generatedAt: number = 0;
  generatedAtText: string = '';
  model: string = '';

  /** 固定 4 段：顺序与文案不随服务端响应变化。 */
  sections(): HealthAdviceSection[] {
    const items: HealthAdviceSection[] = [];
    const current = new HealthAdviceSection();
    current.key = 'summary';
    current.title = '当前情况小结';
    current.note = '仅依据您填写并保存的资料';
    current.items = this.summary.length > 0 ? [this.summary] : [];
    items.push(current);
    const diet = new HealthAdviceSection();
    diet.key = 'diet';
    diet.title = '饮食建议';
    diet.note = '健康科普参考';
    diet.items = this.diet;
    items.push(diet);
    const exercise = new HealthAdviceSection();
    exercise.key = 'exerciseAndSleep';
    exercise.title = '运动与作息建议';
    exercise.note = '健康科普参考';
    exercise.items = this.exerciseAndSleep;
    items.push(exercise);
    const warning = new HealthAdviceSection();
    warning.key = 'warningSigns';
    warning.title = '需要留意的预警信号';
    warning.note = '出现以下情况请及时就医';
    warning.items = this.warningSigns;
    items.push(warning);
    return items;
  }
}

export function emptyHealthAdviceView(): HealthAdviceView {
  return new HealthAdviceView();
}

/** 由已解析的四段 + 元信息构造视图（GuardianService 的响应信封走这里）。 */
export function healthAdviceViewFromResult(advice: HealthAdviceDto, generatedAt: number,
  model: string): HealthAdviceView {
  const view = new HealthAdviceView();
  if (advice === null || advice === undefined) {
    return view;
  }
  view.hasAdvice = advice.summary.length > 0;
  view.summary = advice.summary;
  view.diet = advice.diet;
  view.exerciseAndSleep = advice.exerciseAndSleep;
  view.warningSigns = advice.warningSigns;
  // 固定免责声明：忽略服务端返回的其他文本。
  view.disclaimer = HEALTH_ADVICE_DISCLAIMER;
  view.generatedAt = generatedAt > 0 ? generatedAt : 0;
  view.generatedAtText = formatAdviceTime(view.generatedAt);
  view.model = model;
  return view;
}

export function healthAdviceViewFrom(result: HealthAdviceParseResult): HealthAdviceView {
  if (result === null || result === undefined) {
    return emptyHealthAdviceView();
  }
  return healthAdviceViewFromResult(result.advice, result.generatedAt, result.model);
}
