/**
 * 监护人 APP 真实 API 接入的唯一服务入口。
 *
 * 职责：
 * - 真实登录（POST /api/v1/auth/app）、会话恢复/过期、登出；
 * - 统一刷新 overview/rooms/devices/alerts/contacts 并写入 AppStorage（gv.*）；
 * - 30s 非重叠轮询、页面退出/登出清理；
 * - 告警 ACK：202 后只进入“等待设备确认”，不会被本地改成 ACKED；
 * - 安全存储 token（Asset Store），不可用时仅内存会话。
 *
 * 安全：不记录/持久化密码；不打印 token；不调用 /internal/v1；不包含 INGEST_KEY。
 */
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ApiError, ApiErrorKinds, ApiResult } from '../core/api/Errors';
import { ApiClient } from '../core/api/ApiClient';
import {
  AckDto, ActivityReportDto, AlertDto, ContactDto, DeviceDto, DispositionDto, DispositionResultDto,
  DoorEventDto, ElderSafeEventDto, HealthAdviceEnvelopeDto, HealthProfileEnvelopeDto, LocationPointDto,
  LoginDto, OverviewDto, RoomDto, SafetyLogDto,
  DISPOSITION_NOTE_MAX, DISPOSITION_OUTCOME_OTHER,
  hasDispositionNoteControlChars, normalizeDispositionNote, normalizeSafetyLogLimit,
  validClientDispositionId, validDispositionAlarmId, validDispositionOutcome
} from '../core/api/Contracts';
import {
  AckOutcome, ActivityReportOutcome, DispositionSubmitOutcome, DispositionsOutcome,
  DoorEventsOutcome, EvidenceOutcome, HealthAdviceOutcome, HealthProfileOutcome, LocationsOutcome,
  LoginOutcome, RefreshOutcome, SafetyLogsOutcome
} from '../core/service/Outcomes';
import { Poller } from '../core/polling/Poller';
import { shouldRefreshOnShow } from '../core/polling/RefreshPolicy';
import { SessionCore } from '../core/session/SessionCore';
import { RequestGuard, SessionCommit, SessionTicket } from '../core/session/RequestGuard';
import { ScopedSingleFlight } from '../core/session/ScopedSingleFlight';
import {
  SecureSession, SecureSessionVault, SessionRecoveryCoordinator
} from '../core/session/SessionRecoveryCoordinator';
import { MemorySessionPort, SessionRestorer } from '../core/session/SessionRestorer';
import {
  AppKeys, AlertView, ContactView, DeviceView, DataSource, DoorEventView, ElderSafeEventView,
  ElderSafeLoadState, NetworkState, OverviewView, RoomView, RunMode
} from '../core/view/Models';
import {
  ActivityLoadState, ActivityReportView, ActivityScope
} from '../core/activity/ActivityModels';
import {
  emptyActivityReportView, isValidActivityScope, isValidIsoDate, mapActivityReport
} from '../core/activity/ActivityReport';
import {
  countNeedsAttention, DeviceSplit, householdRooms, mapAlerts, mapContacts, mapDevices,
  mapDisposition, mapDispositions, mapDoorEvents, mapElderSafeEvents, mapOverview, mapRooms,
  mapSafetyLogs, splitDevices
} from '../core/view/ViewMapper';
import {
  emptyHealthAdviceView, HEALTH_ADVICE_DEMO_MESSAGE, HealthAdviceDto, HealthAdviceFlowState,
  HealthAdviceView, healthAdviceFlowForError, healthAdviceMessage, healthAdviceViewFromResult
} from '../core/health/HealthAdvice';
import {
  emptyHealthProfileView, HEALTH_DEMO_MESSAGE, HEALTH_FORM_EMPTY_MESSAGE,
  HEALTH_GENERATING_MESSAGE, HEALTH_LOADING_MESSAGE, HEALTH_PROFILE_EMPTY_MESSAGE,
  HEALTH_SAVING_MESSAGE, HealthProfileBody, HealthProfileView,
  healthProfileViewFrom
} from '../core/health/HealthModels';
import { HealthProfileStatus } from '../core/health/HealthAdvice';
import { HarmonyHttpTransport } from '../net/HarmonyHttpTransport';
import { HttpRawResponse, HttpRequestSpec } from '../core/api/HttpTransport';
import { VideoConfig, relayHttpUrl } from '../core/video/VideoConfig';
import {
  VideoEndOutcome, VideoTicketOutcome, endOutcomeForResponse, shouldRequestVideoSession,
  ticketOutcomeForNoToken, ticketOutcomeForResponse
} from '../core/video/VideoRelay';
import { StoredSession, TokenVault } from '../auth/TokenVault';
import {
  EvidenceImageBytes, EvidenceMemoryCache, EvidenceRequestCancellation, validEvidenceAlarmId
} from '../core/evidence/EvidenceCore';

const API_BASE_URL: string = 'https://api.luxunacc.xyz';
const POLL_INTERVAL_MS: number = 30 * 1000;
const GUARDIAN_ID_RE: RegExp = /^[A-Za-z0-9._-]{3,64}$/;
const PASSWORD_MIN: number = 8;
const PASSWORD_MAX: number = 256;
const NOTE_MAX: number = 120;

class FetchReport {
  ok: boolean = false;
  /** 响应返回时会话已切换，本报告必须被丢弃（不提交、不触发 401）。 */
  stale: boolean = false;
  kind: string = '';
  status: number = 0;
  retryAfterSeconds: number = 0;
  /** 仅本批请求持有的房间/设备 DTO，避免跨会话共享内部缓存。 */
  rooms: RoomDto[] | null = null;
  devices: DeviceView[] | null = null;
  /** 首页 overview 原始 DTO：只在其设备明细成功时用于保留 latestAlert/location。 */
  overview: OverviewDto | null = null;
}

/** 生产安全存储端口：把 TokenVault/AssetStore 包装成核心恢复编排可用的接口。 */
class TokenVaultAdapter implements SecureSessionVault {
  async load(): Promise<SecureSession | null> {
    const stored: StoredSession | null = await TokenVault.loadSecure();
    if (stored === null) {
      return null;
    }
    const session = new SecureSession();
    session.token = stored.token;
    session.guardianId = stored.guardianId;
    session.expiresAt = stored.expiresAt;
    return session;
  }

  async save(session: SecureSession): Promise<boolean> {
    const stored = new StoredSession();
    stored.token = session.token;
    stored.guardianId = session.guardianId;
    stored.expiresAt = session.expiresAt;
    return await TokenVault.saveSecure(stored);
  }

  async clear(): Promise<void> {
    await TokenVault.clearSecure();
  }
}

/** 生产内存会话端口：复用 SessionCore 与 AppStorage 同步逻辑。 */
class GuardianMemorySessionPort implements MemorySessionPort {
  isActive(nowMs: number): boolean {
    return GuardianService.memorySessionActive(nowMs);
  }

  applyRestored(token: string, guardianId: string, expiresAt: number, nowMs: number): void {
    GuardianService.applyRestoredMemorySession(token, guardianId, expiresAt, nowMs);
  }

  syncSessionState(): void {
    GuardianService.syncSessionAppState();
  }
}

export class GuardianService {
  static readonly BASE_URL: string = API_BASE_URL;
  static readonly POLL_MS: number = POLL_INTERVAL_MS;

  private static initialized: boolean = false;
  private static api: ApiClient | null = null;
  private static session: SessionCore = new SessionCore();
  private static guard: RequestGuard | null = null;
  private static commitGate: SessionCommit | null = null;
  private static poller: Poller | null = null;
  /** 刷新去重按“会话代际”隔离；旧任务的 finally 不得清掉新会话的锁。 */
  private static refreshLock: ScopedSingleFlight<RefreshOutcome> = new ScopedSingleFlight<RefreshOutcome>();
  private static alertsLock: ScopedSingleFlight<RefreshOutcome> = new ScopedSingleFlight<RefreshOutcome>();
  /** 恢复/保存/清除安全存储的同一串行编排（含会话生命周期 epoch）。 */
  private static recovery: SessionRecoveryCoordinator | null = null;
  /** 恢复结果解析（提交前用当前时间复验有效期），页面恢复入口实际调用。 */
  private static restorer: SessionRestorer | null = null;
  /**
   * 最近一次成功解析的 rooms/devices 原始 DTO。
   * 用途：设备请求失败（断网/超时）时，用“当前时间”重新映射新鲜度，
   * 避免把上次成功快照里的旧 online/旧读数继续显示成实时（设备断开重启/网关恢复窗口）。
   * 仅内存缓存，登录/登出/401 时清空；不落盘、不含 token。
   */
  private static lastRoomDtos: RoomDto[] = [];
  private static lastDeviceDtos: DeviceDto[] = [];
  private static hostContext: common.Context | null = null;
  /** 只保存当前进程内的压缩 JPEG；账号切换、鉴权失效和登出都会清空。 */
  private static evidenceCache: EvidenceMemoryCache = new EvidenceMemoryCache();
  /**
   * 健康资料/建议的内存缓存（与 AppStorage 同步写入）。
   * 登录、登出、401/403 与“清除业务数据”时必须一起清空，避免上一位老人资料残留。
   */
  private static healthProfileCache: HealthProfileView = new HealthProfileView();
  private static healthAdviceCache: HealthAdviceView = new HealthAdviceView();

  private static recoveryCoordinator(): SessionRecoveryCoordinator {
    if (GuardianService.recovery === null) {
      GuardianService.recovery = new SessionRecoveryCoordinator(new TokenVaultAdapter());
    }
    return GuardianService.recovery;
  }

  private static sessionRestorer(): SessionRestorer {
    if (GuardianService.restorer === null) {
      GuardianService.restorer = new SessionRestorer(
        GuardianService.recoveryCoordinator(),
        new GuardianMemorySessionPort(),
        (): number => Date.now());
    }
    return GuardianService.restorer;
  }

  private static requestGuard(): RequestGuard {
    if (GuardianService.guard === null) {
      GuardianService.guard = new RequestGuard(GuardianService.session);
    }
    return GuardianService.guard;
  }

  private static sessionCommit(): SessionCommit {
    if (GuardianService.commitGate === null) {
      GuardianService.commitGate = new SessionCommit(GuardianService.requestGuard());
    }
    return GuardianService.commitGate;
  }

  // ---------------------------------------------------------------- init

  static init(ctx: common.Context): void {
    GuardianService.hostContext = ctx;
    if (GuardianService.initialized) {
      return;
    }
    GuardianService.initialized = true;
    GuardianService.api = new ApiClient(API_BASE_URL, new HarmonyHttpTransport(API_BASE_URL));
    GuardianService.writeDefaultState();
  }

  private static writeDefaultState(): void {
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.DEVICES, []);
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.UNRECOGNIZED_DEVICES, []);
    AppStorage.setOrCreate<RoomView[]>(AppKeys.ROOMS, []);
    AppStorage.setOrCreate<AlertView[]>(AppKeys.ALERTS, []);
    AppStorage.setOrCreate<ContactView[]>(AppKeys.CONTACTS, []);
    AppStorage.setOrCreate<OverviewView>(AppKeys.OVERVIEW, new OverviewView());
    AppStorage.setOrCreate<string>(AppKeys.NET_STATUS, NetworkState.UNKNOWN);
    AppStorage.setOrCreate<string>(AppKeys.NET_MESSAGE, '');
    AppStorage.setOrCreate<number>(AppKeys.LAST_UPDATED_AT, 0);
    AppStorage.setOrCreate<string>(AppKeys.DATA_SOURCE, DataSource.NONE);
    AppStorage.setOrCreate<string>(AppKeys.GUARDIAN_ID, '');
    AppStorage.setOrCreate<string>(AppKeys.TOKEN_STORAGE, 'memory');
    AppStorage.setOrCreate<string>(AppKeys.MODE, RunMode.NONE);
    AppStorage.setOrCreate<ActivityReportView>(AppKeys.ACTIVITY_REPORT, emptyActivityReportView());
    AppStorage.setOrCreate<string>(AppKeys.ACTIVITY_STATUS, ActivityLoadState.IDLE);
    AppStorage.setOrCreate<string>(AppKeys.ACTIVITY_MESSAGE, '');
    // 老人自述安全：默认无记录，不伪造样例；加载状态由真实接口决定。
    AppStorage.setOrCreate<ElderSafeEventView[]>(AppKeys.ELDER_SAFE_EVENTS, []);
    AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_STATUS, ElderSafeLoadState.IDLE);
    AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_MESSAGE, '');
    // 健康科普评估：默认空资料 + 空建议（不显示上一位老人的任何资料/建议）。
    GuardianService.resetHealthState();
  }

  private static apiClient(): ApiClient | null {
    return GuardianService.api;
  }

  private static now(): number {
    return Date.now();
  }

  private static setNet(status: string, message: string): void {
    AppStorage.setOrCreate<string>(AppKeys.NET_STATUS, status);
    AppStorage.setOrCreate<string>(AppKeys.NET_MESSAGE, message);
  }

  /** 清空账号相关业务缓存（避免下次登录短暂显示上一账号数据）。 */
  private static clearBusinessData(): void {
    GuardianService.evidenceCache.clearAll();
    GuardianService.lastRoomDtos = [];
    GuardianService.lastDeviceDtos = [];
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.DEVICES, []);
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.UNRECOGNIZED_DEVICES, []);
    AppStorage.setOrCreate<RoomView[]>(AppKeys.ROOMS, []);
    AppStorage.setOrCreate<AlertView[]>(AppKeys.ALERTS, []);
    AppStorage.setOrCreate<ContactView[]>(AppKeys.CONTACTS, []);
    AppStorage.setOrCreate<OverviewView>(AppKeys.OVERVIEW, new OverviewView());
    AppStorage.setOrCreate<number>(AppKeys.LAST_UPDATED_AT, 0);
    AppStorage.setOrCreate<string>(AppKeys.DATA_SOURCE, DataSource.NONE);
    AppStorage.setOrCreate<string>(AppKeys.GUARDIAN_ID, '');
    AppStorage.setOrCreate<string>(AppKeys.TOKEN_STORAGE, 'memory');
    AppStorage.setOrCreate<string>(AppKeys.MODE, RunMode.NONE);
    // 活动报告属于账号业务数据：换账号/登录失效时清空，避免短暂显示上一账号报告。
    AppStorage.setOrCreate<ActivityReportView>(AppKeys.ACTIVITY_REPORT, emptyActivityReportView());
    AppStorage.setOrCreate<string>(AppKeys.ACTIVITY_STATUS, ActivityLoadState.IDLE);
    AppStorage.setOrCreate<string>(AppKeys.ACTIVITY_MESSAGE, '');
    // 老人自述安全属于账号业务数据：换账号/登录失效时清空，避免残留上一位老人的记录。
    AppStorage.setOrCreate<ElderSafeEventView[]>(AppKeys.ELDER_SAFE_EVENTS, []);
    AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_STATUS, ElderSafeLoadState.IDLE);
    AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_MESSAGE, '');
    // 健康资料/建议属于账号业务数据：换账号/登录失效时清空，上一位老人资料不得残留。
    GuardianService.resetHealthState();
  }

  /** 仅用于“当前会话”的 401/403 或明确过期；调用方必须先确认 ticket 仍属当前会话。 */
  private static setUnauthorized(message: string): void {
    // 内存会话立即失效；restore 在用户重新登录前一律 blocked。
    GuardianService.recoveryCoordinator().invalidate();
    GuardianService.session.clear();
    TokenVault.clearMemory();
    void GuardianService.recoveryCoordinator().clearSecure();
    GuardianService.stopAutoRefresh();
    GuardianService.clearBusinessData();
    GuardianService.setNet(NetworkState.UNAUTHORIZED, message);
  }

  // -------------------------------------------------------------- session

  static isLoggedIn(): boolean {
    return GuardianService.session.isActive(GuardianService.now());
  }

  static guardianId(): string {
    return GuardianService.session.guardianId();
  }

  static tokenStorageMode(): string {
    return GuardianService.session.storageMode();
  }

  // ------------------------------------------------------------ 视频探望

  /**
   * 是否具备申请视频会话的条件（仅内存会话 token）。
   * 无 token 时页面/服务直接失败，不发起任何网络请求（不新造登录态）。
   */
  static canRequestVideoSession(): boolean {
    return shouldRequestVideoSession(GuardianService.session.token());
  }

  /**
   * 用当前会话 token 向 relay 申请一次性观看 ticket（POST /video/session）。
   * token 只在 Authorization 头内使用：不返回、不写 AppStorage、不打印日志。
   */
  static async requestVideoTicket(relayBase: string): Promise<VideoTicketOutcome> {
    const token: string = GuardianService.session.token();
    if (!shouldRequestVideoSession(token)) {
      return ticketOutcomeForNoToken();
    }
    const url: string = relayHttpUrl(relayBase, VideoConfig.SESSION_PATH);
    if (url.length === 0) {
      return VideoTicketOutcome.failure('config', '视频中继地址配置无效，请检查 video.relayBase 配置');
    }
    const transport = new HarmonyHttpTransport(relayBase);
    const request = new HttpRequestSpec('POST', VideoConfig.SESSION_PATH, token, '',
      VideoConfig.SESSION_TIMEOUT_MS);
    try {
      const response: HttpRawResponse = await transport.send(request);
      return ticketOutcomeForResponse(response.status, response.bodyText, response.timedOut,
        response.networkError);
    } catch (error) {
      return VideoTicketOutcome.failure('network', '无法连接视频服务，请检查网络后重试');
    }
  }

  /**
   * 结束本次观看（POST /video/session/end）：离开页面/点“结束探望”必须调用，
   * 让 relay 在最后一个 viewer 关闭后尽快通知 DAYU200 停止取帧。
   */
  static async endVideoSession(relayBase: string): Promise<VideoEndOutcome> {
    const token: string = GuardianService.session.token();
    if (!shouldRequestVideoSession(token)) {
      const outcome = new VideoEndOutcome();
      outcome.ok = false;
      outcome.kind = 'no_token';
      outcome.message = '登录已失效，无法结束视频会话';
      return outcome;
    }
    if (relayHttpUrl(relayBase, VideoConfig.SESSION_END_PATH).length === 0) {
      const outcome = new VideoEndOutcome();
      outcome.ok = false;
      outcome.kind = 'config';
      outcome.message = '视频中继地址配置无效';
      return outcome;
    }
    const transport = new HarmonyHttpTransport(relayBase);
    const request = new HttpRequestSpec('POST', VideoConfig.SESSION_END_PATH, token, '',
      VideoConfig.END_TIMEOUT_MS);
    try {
      const response: HttpRawResponse = await transport.send(request);
      return endOutcomeForResponse(response.status, response.timedOut, response.networkError);
    } catch (error) {
      const outcome = new VideoEndOutcome();
      outcome.ok = false;
      outcome.kind = 'network';
      outcome.message = '结束会话请求网络失败';
      return outcome;
    }
  }

  static async restoreSession(): Promise<boolean> {
    // 由核心 SessionRestorer 完成：load 与 clear 同队列；提交前用当前时间重新校验 expiresAt；
    // 拒绝过期记录时不写入内存会话/AppStorage，返回真实登录状态。
    return await GuardianService.sessionRestorer().restore();
  }

  /** 供内存会话端口使用：当前内存会话是否仍有效。 */
  static memorySessionActive(nowMs: number): boolean {
    return GuardianService.session.isActive(nowMs);
  }

  /** 供内存会话端口使用：用安全存储的绝对 expiresAt 恢复会话（不做过期兜底）。 */
  static applyRestoredMemorySession(token: string, guardianId: string, expiresAt: number,
    nowMs: number): void {
    GuardianService.session.setWithExpiry(token, guardianId, expiresAt, nowMs, 'secure');
  }

  static syncSessionAppState(): void {
    AppStorage.setOrCreate<string>(AppKeys.GUARDIAN_ID, GuardianService.session.guardianId());
    AppStorage.setOrCreate<string>(AppKeys.TOKEN_STORAGE, GuardianService.session.storageMode());
  }

  private static validGuardianId(id: string): boolean {
    return GUARDIAN_ID_RE.test(id);
  }

  static async login(guardianId: string, password: string, remember: boolean): Promise<LoginOutcome> {
    const outcome = new LoginOutcome();
    const cleanId: string = guardianId.trim();
    if (!GuardianService.validGuardianId(cleanId)) {
      outcome.kind = 'bad_request';
      outcome.message = '监护人账号需为 3–64 位字母、数字或 . _ -';
      return outcome;
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      outcome.kind = 'bad_request';
      outcome.message = `登录口令长度需为 ${PASSWORD_MIN}–${PASSWORD_MAX} 位（由项目负责人提供）`;
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      outcome.kind = 'unknown';
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    // 每次登录尝试都开启新 epoch；登出/新登录/鉴权失效会继续递增，旧响应与旧 restore 作废。
    const coordinator: SessionRecoveryCoordinator = GuardianService.recoveryCoordinator();
    const attempt: number = coordinator.beginLoginAttempt();
    const result: ApiResult<LoginDto> = await api.login(cleanId, password);
    if (!coordinator.isAttemptCurrent(attempt)) {
      coordinator.endLoginAttempt(attempt);
      outcome.kind = 'stale';
      outcome.message = '登录已取消（会话已切换）';
      return outcome;
    }
    if (!result.ok) {
      coordinator.endLoginAttempt(attempt);
      const error: ApiError = result.error as ApiError;
      outcome.kind = error.kind;
      outcome.retryAfterSeconds = error.retryAfterSeconds;
      outcome.message = GuardianService.loginMessage(error);
      return outcome;
    }
    const dto: LoginDto = result.value as LoginDto;
    let storageMode: string = 'memory';
    const secureSession = new SecureSession();
    secureSession.token = dto.sessionToken;
    secureSession.guardianId = cleanId;
    const expiresIn: number = dto.expiresIn > 0 ? dto.expiresIn : 7200;
    secureSession.expiresAt = GuardianService.now() + expiresIn * 1000;

    // 保存/清除与 restore 的 load 共用同一串行队列；epoch 变化则本次不落盘。
    const secureSaved: boolean = await coordinator.saveForLogin(secureSession, attempt, remember);
    if (!coordinator.isAttemptCurrent(attempt)) {
      coordinator.endLoginAttempt(attempt);
      outcome.kind = 'stale';
      outcome.message = '登录已取消（会话已切换）';
      return outcome;
    }
    // 内存会话始终持有本次 token（安全存储只决定冷启动能否恢复）。
    const stored = new StoredSession();
    stored.token = secureSession.token;
    stored.guardianId = secureSession.guardianId;
    stored.expiresAt = secureSession.expiresAt;
    TokenVault.setMemory(stored);
    if (remember && secureSaved) {
      storageMode = 'secure';
    } else {
      storageMode = 'memory';
    }
    // 新会话建立前清空上一账号业务缓存；随后 set 会递增会话代际，旧在途响应全部作废。
    GuardianService.clearBusinessData();
    // 先提交生命周期（epoch++、invalidated=false），旧 restore 的 submit 校验将失败。
    coordinator.markLoginCommitted();
    GuardianService.session.set(dto.sessionToken, cleanId, expiresIn,
      GuardianService.now(), storageMode);
    GuardianService.syncSessionAppState();
    AppStorage.setOrCreate<string>(AppKeys.MODE, RunMode.REAL);
    AppStorage.setOrCreate<string>(AppKeys.NET_STATUS, NetworkState.UNKNOWN);
    AppStorage.setOrCreate<string>(AppKeys.NET_MESSAGE, '');
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.message = '登录成功';
    return outcome;
  }

  static async logout(): Promise<void> {
    // 内存会话与生命周期立即失效；安全存储清除排在同一串行队列。
    const coordinator: SessionRecoveryCoordinator = GuardianService.recoveryCoordinator();
    coordinator.invalidate();
    GuardianService.stopAutoRefresh();
    GuardianService.session.clear();
    GuardianService.evidenceCache.clearAll();
    TokenVault.clearMemory();
    const clearTask: Promise<void> = coordinator.clearSecure();
    GuardianService.writeDefaultState();
    await clearTask;
  }

  private static loginMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '账号或口令错误';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '账号已被服务端停用';
    if (error.kind === ApiErrorKinds.RATE_LIMITED) {
      const seconds: number = error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60;
      return `尝试过多，请 ${seconds} 秒后再试`;
    }
    if (error.kind === ApiErrorKinds.SERVICE_UNAVAILABLE) return '服务端登录未配置';
    return GuardianService.businessMessage(error);
  }

  private static businessMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.TIMEOUT) return '请求超时，请检查网络后重试';
    if (error.kind === ApiErrorKinds.NETWORK) return '网络不可用，请检查连接';
    if (error.kind === ApiErrorKinds.RATE_LIMITED) {
      const seconds: number = error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60;
      return `操作过于频繁，请 ${seconds} 秒后再试`;
    }
    if (error.kind === ApiErrorKinds.SERVER) return '服务端错误，请稍后重试';
    if (error.kind === ApiErrorKinds.SERVICE_UNAVAILABLE) return '服务暂不可用，请稍后重试';
    if (error.kind === ApiErrorKinds.NOT_FOUND) return '对象不存在或已失效';
    if (error.kind === ApiErrorKinds.CONFLICT) return '状态已变化，请刷新后重试';
    if (error.kind === ApiErrorKinds.BAD_REQUEST) return '请求被拒绝，请检查输入';
    if (error.kind === ApiErrorKinds.MALFORMED) return '服务端响应异常，请稍后重试';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '账号已被服务端停用';
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，请重新登录';
    return '操作失败，请稍后重试';
  }

  private static requiresRelogin(error: ApiError): boolean {
    return error.kind === ApiErrorKinds.UNAUTHORIZED || error.kind === ApiErrorKinds.FORBIDDEN;
  }

  // -------------------------------------------------------------- refresh

  static refreshAll(): Promise<RefreshOutcome> {
    const scope: number = GuardianService.session.generationId();
    return GuardianService.refreshLock.run(scope, (): Promise<RefreshOutcome> => {
      return GuardianService.doRefreshAll();
    });
  }

  /**
   * 页面重新显示 / APP 回到前台时按需立即刷新（纯判断见 core/polling/RefreshPolicy）。
   * - 12s 内刚成功刷新且网络状态 ok → 返回 null（不重复请求）；
   * - 上次失败/从未刷新/超过 12s/时钟异常 → 发起刷新（由会话代际单飞保护，不并发）。
   * 未登录返回 null（页面自行回登录页）。
   */
  static refreshOnShow(): Promise<RefreshOutcome> | null {
    if (!GuardianService.isLoggedIn()) return null;
    const lastUpdatedAt: number = AppStorage.get<number>(AppKeys.LAST_UPDATED_AT) ?? 0;
    const netStatus: string = AppStorage.get<string>(AppKeys.NET_STATUS) ?? NetworkState.UNKNOWN;
    if (!shouldRefreshOnShow(lastUpdatedAt, netStatus, GuardianService.now())) {
      return null;
    }
    return GuardianService.refreshAll();
  }

  /**
   * 设备请求失败时：用最近一次成功解析的原始 DTO 按“当前时间”重新计算在线新鲜度，
   * 让超过新鲜期（90s）的设备立即显示离线/上次读数，而不是保留旧 online 标志冒充实时。
   * 只在有缓存时生效；不写 lastUpdatedAt（它只代表“最后一次成功刷新”）。
   */
  private static remapCachedDevicesForNow(): void {
    if (GuardianService.lastDeviceDtos.length === 0) return;
    const now: number = GuardianService.now();
    const allDevices: DeviceView[] = mapDevices(GuardianService.lastDeviceDtos, now);
    const split: DeviceSplit = splitDevices(allDevices);
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.DEVICES, split.household);
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.UNRECOGNIZED_DEVICES, split.unrecognized);
    if (GuardianService.lastRoomDtos.length > 0) {
      AppStorage.setOrCreate<RoomView[]>(AppKeys.ROOMS,
        mapRooms(householdRooms(GuardianService.lastRoomDtos, split.household), split.household));
    }
  }

  private static staleOutcome(): RefreshOutcome {
    const outcome = new RefreshOutcome();
    outcome.stale = true;
    return outcome;
  }

  /**
   * 老人自述安全（GET /api/v1/elder-safe）。
   * 与核心刷新并行，但**独立失败域**：接口失败只把卡片标成“加载失败”，
   * 不把整次刷新降级为 partial，也绝不清空/伪造记录。
   */
  private static async fetchElderSafe(ticket: SessionTicket): Promise<void> {
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_STATUS, ElderSafeLoadState.ERROR);
      AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_MESSAGE, '服务未初始化，老人自述安全加载失败');
      return;
    }
    const result: ApiResult<ElderSafeEventDto[]> = await api.elderSafeEvents(ticket.token, 20);
    if (!GuardianService.requestGuard().isCurrent(ticket, GuardianService.now())) {
      return;
    }
    if (!result.ok) {
      AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_STATUS, ElderSafeLoadState.ERROR);
      AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_MESSAGE,
        GuardianService.elderSafeMessage(result.error as ApiError));
      return;
    }
    AppStorage.setOrCreate<ElderSafeEventView[]>(AppKeys.ELDER_SAFE_EVENTS,
      mapElderSafeEvents(result.value as ElderSafeEventDto[], GuardianService.now()));
    AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_STATUS, ElderSafeLoadState.OK);
    AppStorage.setOrCreate<string>(AppKeys.ELDER_SAFE_MESSAGE, '');
  }

  private static elderSafeMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.NETWORK) return '网络不可用，老人自述安全加载失败';
    if (error.kind === ApiErrorKinds.TIMEOUT) return '请求超时，老人自述安全加载失败';
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，老人自述安全加载失败';
    if (error.kind === ApiErrorKinds.NOT_FOUND) return '服务端暂未提供老人自述安全接口，加载失败';
    return `老人自述安全加载失败：${GuardianService.businessMessage(error)}`;
  }

  /** 旧会话响应：不写页面、不写网络状态、不清新会话。 */
  private static async doRefreshAll(): Promise<RefreshOutcome> {
    const outcome = new RefreshOutcome();
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      // 已登出：本次结果无意义，也不能清任何东西。
      return GuardianService.staleOutcome();
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        outcome.unauthorized = true;
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.stale = true;
      }
      return outcome;
    }
    GuardianService.setNet(NetworkState.LOADING, '正在刷新…');
    // 自述安全与核心数据并行；它有自己的加载状态，失败不影响核心刷新的成败判定。
    const elderSafePending: Promise<void> = GuardianService.fetchElderSafe(ticket);
    const reports: FetchReport[] = await Promise.all([
      GuardianService.fetchOverview(ticket),
      GuardianService.fetchRooms(ticket),
      GuardianService.fetchDevices(ticket),
      GuardianService.fetchAlerts(ticket)
    ]);
    await elderSafePending;
    const now: number = GuardianService.now();
    if (!guard.isCurrent(ticket, now)) {
      // 会话在请求期间切换/失效：丢弃整批结果。
      return GuardianService.staleOutcome();
    }
    let staleCount: number = 0;
    let successCount: number = 0;
    let relogin: boolean = false;
    let firstError: FetchReport | null = null;
    let roomsDto: RoomDto[] | null = null;
    let devicesView: DeviceView[] | null = null;
    let overviewDto: OverviewDto | null = null;
    for (let i = 0; i < reports.length; i++) {
      const report: FetchReport = reports[i];
      if (report.stale) {
        staleCount += 1;
        continue;
      }
      if (report.rooms !== null) roomsDto = report.rooms;
      if (report.devices !== null) devicesView = report.devices;
      if (report.overview !== null) overviewDto = report.overview;
      if (report.ok) {
        successCount += 1;
      } else if (firstError === null) {
        firstError = report;
      }
      if (report.kind === ApiErrorKinds.UNAUTHORIZED || report.kind === ApiErrorKinds.FORBIDDEN) {
        relogin = true;
      }
    }
    if (staleCount > 0) {
      return GuardianService.staleOutcome();
    }
    if (relogin) {
      GuardianService.setUnauthorized('会话已过期，请重新登录');
      outcome.unauthorized = true;
      outcome.message = '会话已过期，请重新登录';
      return outcome;
    }
    // 所有写页面/网络状态的副作用都在二次会话校验之后。
    if (!guard.isCurrent(ticket, now)) {
      return GuardianService.staleOutcome();
    }
    if (!GuardianService.sessionCommit().commitIfCurrent(ticket, now, (): void => {})) {
      return GuardianService.staleOutcome();
    }
    /* 设备这一批请求失败（断网/超时/503）而其它接口成功时，也必须按“当前时间”重算缓存设备
       的新鲜度：否则上次快照里的 online=true 会在断连窗口继续显示“在线”/旧读数当实时。 */
    if (devicesView === null) {
      GuardianService.remapCachedDevicesForNow();
    }
    if (roomsDto !== null || devicesView !== null) {
      const rooms: RoomDto[] = roomsDto !== null ? roomsDto : [];
      const devices: DeviceView[] = devicesView !== null
        ? devicesView
        : (AppStorage.get<DeviceView[]>(AppKeys.DEVICES) ?? []);
      // 只保留确实包含家庭设备的房间：后端测试/历史房间不显示成家庭房间。
      AppStorage.setOrCreate<RoomView[]>(AppKeys.ROOMS, mapRooms(householdRooms(rooms, devices), devices));
    }
    /* 首页/监测页必须使用同一批带新鲜度判断的 devices 派生在线数；
       即使服务端 overview 仍返回旧的 onlineCount，也用 devices 覆盖，
       避免“设备已离线、首页仍显示在线”。仅有 devices 成功返回时才派生；
       全部请求失败时保持原状态，不把网络失败批量改成离线。
       注意：deviceCount/onlineCount 只统计"已核实家庭设备"，后端测试/历史记录不计入。 */
    if (devicesView !== null) {
      const derived: OverviewView = new OverviewView();
      derived.hasData = true;
      derived.generatedAt = GuardianService.now();
      derived.deviceCount = devicesView.length;
      let derivedOnline: number = 0;
      let derivedMonitorOffline: number = 0;
      for (let i = 0; i < devicesView.length; i++) {
        const d: DeviceView = devicesView[i];
        if (d.online) {
          derivedOnline += 1;
          if (d.monitorOnline === 0) derivedMonitorOffline += 1;
        }
      }
      derived.onlineCount = derivedOnline;
      derived.monitorOfflineCount = derivedMonitorOffline;
      // 保留服务端 overview 的真实告警统计与位置，不因重算设备数而丢失。
      const latestOverview: OverviewView | null = overviewDto !== null
        ? mapOverview(overviewDto)
        : (AppStorage.get<OverviewView>(AppKeys.OVERVIEW) ?? null);
      derived.activeAlertCount = latestOverview !== null ? latestOverview.activeAlertCount : 0;
      derived.latestAlert = latestOverview !== null ? latestOverview.latestAlert : null;
      derived.locationText = latestOverview !== null ? latestOverview.locationText : '';
      AppStorage.setOrCreate<OverviewView>(AppKeys.OVERVIEW, derived);
    }
    const total: number = reports.length;
    if (successCount === total) {
      AppStorage.setOrCreate<string>(AppKeys.NET_STATUS, NetworkState.OK);
      AppStorage.setOrCreate<string>(AppKeys.NET_MESSAGE, '');
      AppStorage.setOrCreate<number>(AppKeys.LAST_UPDATED_AT, GuardianService.now());
      AppStorage.setOrCreate<string>(AppKeys.DATA_SOURCE, DataSource.API);
      outcome.ok = true;
      outcome.updatedAt = GuardianService.now();
      return outcome;
    }
    if (successCount > 0) {
      AppStorage.setOrCreate<string>(AppKeys.NET_STATUS, NetworkState.PARTIAL);
      AppStorage.setOrCreate<string>(AppKeys.NET_MESSAGE,
        '部分数据获取失败，已显示上次/部分数据');
      AppStorage.setOrCreate<number>(AppKeys.LAST_UPDATED_AT, GuardianService.now());
      AppStorage.setOrCreate<string>(AppKeys.DATA_SOURCE, DataSource.API);
      outcome.partial = true;
      outcome.ok = true;
      outcome.updatedAt = GuardianService.now();
      outcome.message = '部分数据获取失败，已显示上次/部分数据';
      return outcome;
    }
    const error: FetchReport = firstError !== null ? firstError : new FetchReport();
    const apiError = new ApiError(error.kind, error.status, '', error.retryAfterSeconds);
    outcome.message = GuardianService.businessMessage(apiError);
    if (error.kind === ApiErrorKinds.NETWORK || error.kind === ApiErrorKinds.TIMEOUT) {
      AppStorage.setOrCreate<string>(AppKeys.NET_STATUS, NetworkState.OFFLINE);
      AppStorage.setOrCreate<string>(AppKeys.NET_MESSAGE, '网络不可用，显示上次数据');
    } else {
      AppStorage.setOrCreate<string>(AppKeys.NET_STATUS, NetworkState.ERROR);
      AppStorage.setOrCreate<string>(AppKeys.NET_MESSAGE, outcome.message);
    }
    return outcome;
  }

  private static reportFailure(report: FetchReport, error: ApiError): FetchReport {
    report.kind = error.kind;
    report.status = error.status;
    report.retryAfterSeconds = error.retryAfterSeconds;
    return report;
  }

  private static async fetchOverview(ticket: SessionTicket): Promise<FetchReport> {
    const report = new FetchReport();
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) return report;
    const result: ApiResult<OverviewDto> = await api.overview(ticket.token);
    if (!GuardianService.requestGuard().isCurrent(ticket, GuardianService.now())) {
      report.stale = true;
      return report;
    }
    if (!result.ok) {
      return GuardianService.reportFailure(report, result.error as ApiError);
    }
    const overview: OverviewDto = result.value as OverviewDto;
    report.overview = overview;
    AppStorage.setOrCreate<OverviewView>(AppKeys.OVERVIEW, mapOverview(overview));
    report.ok = true;
    return report;
  }

  private static async fetchRooms(ticket: SessionTicket): Promise<FetchReport> {
    const report = new FetchReport();
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) return report;
    const result: ApiResult<RoomDto[]> = await api.rooms(ticket.token);
    if (!GuardianService.requestGuard().isCurrent(ticket, GuardianService.now())) {
      report.stale = true;
      return report;
    }
    if (!result.ok) {
      return GuardianService.reportFailure(report, result.error as ApiError);
    }
    report.rooms = result.value as RoomDto[];
    // 缓存原始 DTO：设备请求失败时用于按当前时间重算房间内设备的新鲜度。
    GuardianService.lastRoomDtos = report.rooms;
    report.ok = true;
    return report;
  }

  private static async fetchDevices(ticket: SessionTicket): Promise<FetchReport> {
    const report = new FetchReport();
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) return report;
    const result: ApiResult<DeviceDto[]> = await api.devices(ticket.token);
    if (!GuardianService.requestGuard().isCurrent(ticket, GuardianService.now())) {
      report.stale = true;
      return report;
    }
    if (!result.ok) {
      return GuardianService.reportFailure(report, result.error as ApiError);
    }
    const allDevices: DeviceView[] = mapDevices(result.value as DeviceDto[], GuardianService.now());
    // 缓存原始 DTO：设备请求失败时按当前时间重新映射，避免旧 online/旧读数冒充实时。
    GuardianService.lastDeviceDtos = result.value as DeviceDto[];
    // 家庭设备清单是唯一"受监护设备"口径：未识别的后端记录只如实列出，不计入统计。
    const split: DeviceSplit = splitDevices(allDevices);
    report.devices = split.household;
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.DEVICES, split.household);
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.UNRECOGNIZED_DEVICES, split.unrecognized);
    report.ok = true;
    return report;
  }

  private static async fetchAlerts(ticket: SessionTicket): Promise<FetchReport> {
    const report = new FetchReport();
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) return report;
    const result: ApiResult<AlertDto[]> = await api.alerts(ticket.token);
    if (!GuardianService.requestGuard().isCurrent(ticket, GuardianService.now())) {
      report.stale = true;
      return report;
    }
    if (!result.ok) {
      return GuardianService.reportFailure(report, result.error as ApiError);
    }
    AppStorage.setOrCreate<AlertView[]>(AppKeys.ALERTS, mapAlerts(result.value as AlertDto[]));
    report.ok = true;
    return report;
  }

  private static async fetchContacts(ticket: SessionTicket): Promise<FetchReport> {
    const report = new FetchReport();
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) return report;
    const result: ApiResult<ContactDto[]> = await api.contacts(ticket.token);
    if (!GuardianService.requestGuard().isCurrent(ticket, GuardianService.now())) {
      report.stale = true;
      return report;
    }
    if (!result.ok) {
      return GuardianService.reportFailure(report, result.error as ApiError);
    }
    AppStorage.setOrCreate<ContactView[]>(AppKeys.CONTACTS,
      mapContacts(result.value as ContactDto[]));
    report.ok = true;
    return report;
  }

  /** 只刷新告警（ACK 后轮询用），同样按会话代际单飞。 */
  static refreshAlerts(): Promise<RefreshOutcome> {
    const scope: number = GuardianService.session.generationId();
    return GuardianService.alertsLock.run(scope, (): Promise<RefreshOutcome> => {
      return GuardianService.doRefreshAlerts();
    });
  }

  private static async doRefreshAlerts(): Promise<RefreshOutcome> {
    const outcome = new RefreshOutcome();
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    if (ticket.token.length === 0) {
      return GuardianService.staleOutcome();
    }
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        outcome.unauthorized = true;
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.stale = true;
      }
      return outcome;
    }
    const report: FetchReport = await GuardianService.fetchAlerts(ticket);
    if (report.stale) {
      return GuardianService.staleOutcome();
    }
    if (report.ok) {
      outcome.ok = true;
      outcome.updatedAt = GuardianService.now();
      return outcome;
    }
    if (report.kind === ApiErrorKinds.UNAUTHORIZED || report.kind === ApiErrorKinds.FORBIDDEN) {
      GuardianService.setUnauthorized('会话已过期，请重新登录');
      outcome.unauthorized = true;
      outcome.message = '会话已过期，请重新登录';
      return outcome;
    }
    const apiError = new ApiError(report.kind, report.status, '', report.retryAfterSeconds);
    outcome.message = GuardianService.businessMessage(apiError);
    return outcome;
  }

  static async loadContacts(): Promise<boolean> {
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    if (ticket.token.length === 0) return false;
    const report: FetchReport = await GuardianService.fetchContacts(ticket);
    return report.ok && !report.stale;
  }

  // -------------------------------------------------------------- polling

  static startAutoRefresh(): void {
    if (GuardianService.poller === null) {
      GuardianService.poller = new Poller(POLL_INTERVAL_MS, async (): Promise<void> => {
        await GuardianService.refreshAll();
      });
    }
    GuardianService.poller.start();
  }

  static stopAutoRefresh(): void {
    if (GuardianService.poller !== null) {
      GuardianService.poller.stop();
    }
  }

  static isPolling(): boolean {
    return GuardianService.poller !== null && GuardianService.poller.isRunning();
  }

  // ------------------------------------------------------------- evidence

  /** 私有 FALL 证据下载；不写文件、不写相册，只返回内存中的压缩 JPEG。 */
  static async loadEvidence(alarmId: string,
    cancellation: EvidenceRequestCancellation): Promise<EvidenceOutcome> {
    const outcome = new EvidenceOutcome();
    if (!validEvidenceAlarmId(alarmId)) {
      outcome.kind = ApiErrorKinds.BAD_REQUEST;
      outcome.message = '告警编号无效，无法查看证据';
      return outcome;
    }
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0 || !guard.isCurrent(ticket, startedAt)) {
      outcome.kind = ApiErrorKinds.UNAUTHORIZED;
      outcome.message = '会话已过期，请重新登录';
      return outcome;
    }
    const cached: Uint8Array | null = GuardianService.evidenceCache.get(ticket.guardianId, alarmId);
    if (cached !== null) {
      const image = new EvidenceImageBytes();
      image.alarmId = alarmId;
      image.contentType = 'image/jpeg';
      image.payload = cached;
      image.fromCache = true;
      outcome.ok = true;
      outcome.kind = 'ok';
      outcome.image = image;
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    const result: ApiResult<EvidenceImageBytes> =
      await api.evidence(ticket.token, alarmId, cancellation);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      outcome.kind = 'stale';
      outcome.message = '会话已切换，本次证据结果已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      outcome.kind = error.kind;
      outcome.message = GuardianService.evidenceMessage(error);
      if (error.kind === ApiErrorKinds.UNAUTHORIZED) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
      } else if (error.kind === ApiErrorKinds.FORBIDDEN) {
        GuardianService.setUnauthorized('当前账号无权访问该家庭，请重新登录');
      }
      return outcome;
    }
    const image: EvidenceImageBytes = result.value as EvidenceImageBytes;
    if (!guard.isCurrent(ticket, GuardianService.now()) || image.alarmId !== alarmId) {
      outcome.kind = 'stale';
      outcome.message = '告警已切换，本次证据结果已忽略';
      return outcome;
    }
    GuardianService.evidenceCache.put(ticket.guardianId, alarmId, image.payload);
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.image = image;
    return outcome;
  }

  private static evidenceMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，请重新登录';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '当前账号无权查看该家庭证据';
    if (error.kind === ApiErrorKinds.NOT_FOUND) return '证据暂不可用';
    if (error.kind === ApiErrorKinds.TIMEOUT) return '证据加载超时，请主动重试';
    if (error.kind === ApiErrorKinds.CANCELLED) return '证据加载已取消';
    if (error.kind === ApiErrorKinds.TOO_LARGE) return '证据超过 2 MiB 安全上限，已拒绝显示';
    if (error.kind === ApiErrorKinds.MALFORMED) return '证据不是有效的 JPEG，已拒绝显示';
    if (error.kind === ApiErrorKinds.SERVER || error.kind === ApiErrorKinds.SERVICE_UNAVAILABLE ||
      error.kind === ApiErrorKinds.NETWORK) {
      return '证据加载失败，请稍后主动重试';
    }
    return '证据加载失败，请稍后主动重试';
  }

  // ------------------------------------------------------------------ ack

  /**
   * 提交 ACK。202 只代表命令入队；本方法绝不修改本地告警为 ACKED。
   * 调用方需轮询 refreshAlerts() 直到服务端返回 state=ACKED。
   */
  static async ackAlert(alarmId: string, note: string): Promise<AckOutcome> {
    const outcome = new AckOutcome();
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      outcome.kind = 'stale';
      outcome.message = '会话已切换，本次操作结果已忽略';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        outcome.kind = 'unauthorized';
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.message = '会话已切换，本次操作结果已忽略';
      }
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      outcome.kind = 'unknown';
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    let cleanNote: string = note.trim();
    if (cleanNote.length > NOTE_MAX) {
      cleanNote = cleanNote.substring(0, NOTE_MAX);
    }
    const result: ApiResult<AckDto> = await api.ack(ticket.token, alarmId, cleanNote);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      // 旧会话的 ACK 结果：不写页面、不清新会话、不触发新会话刷新。
      outcome.kind = 'stale';
      outcome.message = '会话已切换，本次操作结果已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      outcome.kind = error.kind;
      outcome.message = GuardianService.ackMessage(error);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
      } else if (error.kind === ApiErrorKinds.NOT_FOUND ||
        error.kind === ApiErrorKinds.BAD_REQUEST ||
        error.kind === ApiErrorKinds.CONFLICT) {
        // 状态可能已变化：刷新真实状态，绝不在本地归档。
        void GuardianService.refreshAlerts();
      }
      return outcome;
    }
    const dto: AckDto = result.value as AckDto;
    outcome.accepted = true;
    outcome.kind = 'ok';
    outcome.serverStatus = dto.status.length > 0 ? dto.status : 'PENDING';
    outcome.message = '命令已提交，等待设备确认';
    // 立即拉一次真实状态；但仍只展示服务端返回的 ackPending/ACKED。
    void GuardianService.refreshAlerts();
    return outcome;
  }

  private static ackMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.NOT_FOUND) return '告警不存在或已失效';
    if (error.kind === ApiErrorKinds.BAD_REQUEST) {
      return '告警状态已变化，请刷新后查看真实状态';
    }
    if (error.kind === ApiErrorKinds.CONFLICT) return '设备状态冲突，请刷新后重试';
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，请重新登录';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '账号已被服务端停用';
    return GuardianService.businessMessage(error);
  }

  // -------------------------------------------------- dispositions / logs

  /** 演示模式不访问真实处置/安全日志接口（与 ACK 一致）。 */
  private static isDemoMode(): boolean {
    return AppStorage.get<string>(AppKeys.MODE) === RunMode.DEMO;
  }

  /**
   * 查询单条告警已保存的处置记录（GET /api/v1/alerts/{alarmId}/dispositions）。
   * 失败返回真实错误；绝不回退演示数据，也不伪造空列表为成功。
   */
  static async loadDispositions(alarmId: string): Promise<DispositionsOutcome> {
    const outcome = new DispositionsOutcome();
    if (!validDispositionAlarmId(alarmId)) {
      outcome.kind = ApiErrorKinds.BAD_REQUEST;
      outcome.message = '告警编号无效，无法查询处置记录';
      return outcome;
    }
    if (GuardianService.isDemoMode()) {
      outcome.kind = 'demo_mode';
      outcome.message = '演示模式不查询真实处置记录';
      return outcome;
    }
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次处置记录已忽略';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        outcome.kind = 'unauthorized';
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.stale = true;
        outcome.message = '会话已切换，本次处置记录已忽略';
      }
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    const result: ApiResult<DispositionDto[]> = await api.dispositions(ticket.token, alarmId);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次处置记录已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      outcome.kind = error.kind;
      outcome.message = GuardianService.dispositionQueryMessage(error);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
      }
      return outcome;
    }
    outcome.items = mapDispositions(result.value as DispositionDto[]);
    outcome.ok = true;
    outcome.kind = 'ok';
    return outcome;
  }

  /**
   * 登记处置结果（POST /api/v1/alerts/{alarmId}/dispositions）。
   * 独立于 ACK：不调用 ack、不生成命令、不改任何告警状态。
   * 只有服务端返回 201/200 且响应体合法才视为“已保存”；网络/超时/5xx 一律失败。
   */
  static async submitDisposition(alarmId: string, clientDispositionId: string, outcomeValue: string,
    note: string): Promise<DispositionSubmitOutcome> {
    const outcome = new DispositionSubmitOutcome();
    if (!validDispositionAlarmId(alarmId)) {
      outcome.kind = ApiErrorKinds.BAD_REQUEST;
      outcome.message = '告警编号无效，处置结果未保存';
      return outcome;
    }
    if (!validDispositionOutcome(outcomeValue)) {
      outcome.kind = ApiErrorKinds.BAD_REQUEST;
      outcome.message = '请选择有效的处置结果';
      return outcome;
    }
    if (!validClientDispositionId(clientDispositionId)) {
      outcome.kind = ApiErrorKinds.BAD_REQUEST;
      outcome.message = '提交编号无效，处置结果未保存';
      return outcome;
    }
    const cleanNote: string = normalizeDispositionNote(note);
    if (cleanNote.length > DISPOSITION_NOTE_MAX) {
      outcome.kind = ApiErrorKinds.BAD_REQUEST;
      outcome.message = `说明最多 ${DISPOSITION_NOTE_MAX} 字，处置结果未保存`;
      return outcome;
    }
    if (hasDispositionNoteControlChars(cleanNote)) {
      outcome.kind = ApiErrorKinds.BAD_REQUEST;
      outcome.message = '说明包含不支持的控制字符，处置结果未保存';
      return outcome;
    }
    if (outcomeValue === DISPOSITION_OUTCOME_OTHER && cleanNote.length === 0) {
      outcome.kind = ApiErrorKinds.BAD_REQUEST;
      outcome.message = '选择“其他说明”时必须填写说明';
      return outcome;
    }
    if (GuardianService.isDemoMode()) {
      outcome.kind = 'demo_mode';
      outcome.message = '演示模式不提交真实处置结果';
      return outcome;
    }
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次处置结果已忽略';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        outcome.kind = 'unauthorized';
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.stale = true;
        outcome.message = '会话已切换，本次处置结果已忽略';
      }
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    const result: ApiResult<DispositionResultDto> =
      await api.createDisposition(ticket.token, alarmId, clientDispositionId, outcomeValue, cleanNote);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次处置结果已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      outcome.kind = error.kind;
      outcome.message = GuardianService.dispositionSubmitMessage(error);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
      }
      return outcome;
    }
    const dto: DispositionResultDto = result.value as DispositionResultDto;
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.created = dto.created;
    outcome.duplicate = dto.duplicate;
    const record: DispositionDto | null = dto.disposition;
    if (record !== null) {
      outcome.disposition = mapDisposition(record);
    }
    outcome.message = dto.created
      ? '处置结果已保存（时间/处理人来自服务端）'
      : '该处置已保存过，服务端按幂等返回，未重复写入';
    return outcome;
  }

  /**
   * 安全日志历史（GET /api/v1/safety-logs）：来自持久化台账，不是由当前 alerts 推导。
   * 失败返回真实错误，页面不得回退演示数据。
   */
  static async loadSafetyLogs(limit: number = 50): Promise<SafetyLogsOutcome> {
    const outcome = new SafetyLogsOutcome();
    if (GuardianService.isDemoMode()) {
      outcome.kind = 'demo_mode';
      outcome.message = '演示模式不查询真实安全日志';
      return outcome;
    }
    const cleanLimit: number = normalizeSafetyLogLimit(limit);
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次安全日志已忽略';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        outcome.kind = 'unauthorized';
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.stale = true;
        outcome.message = '会话已切换，本次安全日志已忽略';
      }
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    const result: ApiResult<SafetyLogDto[]> = await api.safetyLogs(ticket.token, cleanLimit);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次安全日志已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      outcome.kind = error.kind;
      outcome.message = GuardianService.dispositionQueryMessage(error);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
      }
      return outcome;
    }
    outcome.items = mapSafetyLogs(result.value as SafetyLogDto[]);
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.loadedAt = GuardianService.now();
    return outcome;
  }

  /**
   * 门磁开关事件历史（GET /api/v1/door-events）：来自持久化台账，不是由当前 door 状态推导。
   * 按设备查询最近开关记录；失败返回真实错误，页面不得回退演示数据。
   * 时间语义：事件 occurredAt + timeSource 由后端明确标注（device=设备可信时钟 / server=服务器接收时间）。
   */
  static async loadDoorEvents(deviceId: string, limit: number = 10): Promise<DoorEventsOutcome> {
    const outcome = new DoorEventsOutcome();
    outcome.deviceId = deviceId;
    if (GuardianService.isDemoMode()) {
      outcome.kind = 'demo_mode';
      outcome.message = '演示模式不查询真实门磁事件';
      return outcome;
    }
    const cleanLimit: number = Number.isFinite(limit) && limit >= 1 && limit <= 100 ? Math.round(limit) : 10;
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次门磁事件已忽略';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        outcome.kind = 'unauthorized';
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.stale = true;
        outcome.message = '会话已切换，本次门磁事件已忽略';
      }
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    const result: ApiResult<DoorEventDto[]> = await api.doorEvents(ticket.token, deviceId, cleanLimit);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次门磁事件已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      outcome.kind = error.kind;
      outcome.message = GuardianService.doorEventsQueryMessage(error);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
      }
      return outcome;
    }
    outcome.items = mapDoorEvents(result.value as DoorEventDto[], GuardianService.now());
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.loadedAt = GuardianService.now();
    AppStorage.setOrCreate<DoorEventView[]>(AppKeys.DOOR_EVENTS, outcome.items);
    AppStorage.setOrCreate<string>(AppKeys.DOOR_EVENTS_STATUS, outcome.kind);
    AppStorage.setOrCreate<string>(AppKeys.DOOR_EVENTS_MESSAGE, outcome.message);
    return outcome;
  }

  /**
   * 设备最近定位（GET /api/v1/location）。
   * 仅作为 MANUAL_SOS 告警缺少 sosLocation 时的兜底：页面必须标注“最近定位（可能晚于求助时刻）”，
   * 不得把它冒充成求助时刻的定位，也不得在失败/空列表时伪造坐标。
   */
  static async loadLocations(): Promise<LocationsOutcome> {
    const outcome = new LocationsOutcome();
    if (GuardianService.isDemoMode()) {
      outcome.kind = 'demo_mode';
      outcome.message = '演示模式不查询真实定位';
      return outcome;
    }
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次定位查询已忽略';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        outcome.kind = 'unauthorized';
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.stale = true;
        outcome.message = '会话已切换，本次定位查询已忽略';
      }
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    const result: ApiResult<LocationPointDto[]> = await api.locations(ticket.token);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次定位查询已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      outcome.kind = error.kind;
      outcome.message = GuardianService.locationsQueryMessage(error);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
      }
      return outcome;
    }
    outcome.items = result.value as LocationPointDto[];
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.loadedAt = GuardianService.now();
    return outcome;
  }

  /** 最近定位查询失败文案：明确查询失败，不能让用户以为“设备没有位置”。 */
  private static locationsQueryMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.TIMEOUT) return '最近定位查询超时，未能获取定位';
    if (error.kind === ApiErrorKinds.NETWORK) return '网络不可用，未能获取最近定位';
    if (error.kind === ApiErrorKinds.SERVICE_UNAVAILABLE) return '服务暂不可用，未能获取最近定位';
    if (error.kind === ApiErrorKinds.SERVER) return '服务端错误，未能获取最近定位';
    if (error.kind === ApiErrorKinds.RATE_LIMITED) {
      const seconds: number = error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60;
      return `操作过于频繁，请 ${seconds} 秒后再试`;
    }
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，请重新登录';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '账号已被服务端停用';
    if (error.kind === ApiErrorKinds.MALFORMED) return '服务端响应异常，无法解析最近定位';
    return '最近定位加载失败，请稍后重试';
  }

  /** 门磁事件查询失败文案：说明未加载，绝不冒充成功。 */
  private static doorEventsQueryMessage(error: ApiError): string {    if (error.kind === ApiErrorKinds.TIMEOUT) return '查询超时，门磁事件未加载；请稍后重试';
    if (error.kind === ApiErrorKinds.NETWORK) return '网络不可用，门磁事件未加载';
    if (error.kind === ApiErrorKinds.SERVICE_UNAVAILABLE) return '服务暂不可用，门磁事件未加载，请稍后重试';
    if (error.kind === ApiErrorKinds.SERVER) return '服务端错误，门磁事件未加载，请稍后重试';
    if (error.kind === ApiErrorKinds.RATE_LIMITED) {
      const seconds: number = error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60;
      return `操作过于频繁，请 ${seconds} 秒后再试`;
    }
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，请重新登录；门磁事件未加载';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '账号已被服务端停用，门磁事件未加载';
    if (error.kind === ApiErrorKinds.MALFORMED) return '服务端响应异常，门磁事件未加载；请刷新重试';
    return '门磁事件加载失败，请稍后重试';
  }

  /** 说明：网络/超时/5xx 必须显式说明“未保存”，不能让用户误以为已保存。 */
  private static dispositionSubmitMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.NOT_FOUND) return '告警不存在或已失效，处置结果未保存';
    if (error.kind === ApiErrorKinds.CONFLICT) {
      return '同一提交编号已存在不同内容，处置结果未保存；请修改后重新提交';
    }
    if (error.kind === ApiErrorKinds.BAD_REQUEST) return '处置内容不符合服务端要求，处置结果未保存';
    if (error.kind === ApiErrorKinds.TIMEOUT) return '提交超时，处置结果未确认保存；请保持输入后重试';
    if (error.kind === ApiErrorKinds.NETWORK) return '网络不可用，处置结果未保存';
    if (error.kind === ApiErrorKinds.SERVICE_UNAVAILABLE) return '服务暂不可用，处置结果未保存，请稍后重试';
    if (error.kind === ApiErrorKinds.SERVER) return '服务端错误，处置结果未保存，请稍后重试';
    if (error.kind === ApiErrorKinds.RATE_LIMITED) {
      const seconds: number = error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60;
      return `操作过于频繁，处置结果未保存，请 ${seconds} 秒后再试`;
    }
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，请重新登录；处置结果未保存';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '账号已被服务端停用，处置结果未保存';
    if (error.kind === ApiErrorKinds.MALFORMED) {
      return '服务端响应异常，无法确认处置结果已保存；请刷新处置记录核对';
    }
    return '提交失败，处置结果未保存';
  }

  private static dispositionQueryMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.NOT_FOUND) return '告警不存在或已失效，无法查询处置记录';
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，请重新登录';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '账号已被服务端停用';
    if (error.kind === ApiErrorKinds.TIMEOUT) return '查询超时，请检查网络后重试';
    if (error.kind === ApiErrorKinds.NETWORK) return '网络不可用，无法获取处置记录';
    if (error.kind === ApiErrorKinds.MALFORMED) return '服务端响应异常，无法解析处置记录';
    return GuardianService.businessMessage(error);
  }

  // ------------------------------------------------------- activity report

  /** 写活动报告加载状态（页面读 gv.activityStatus / gv.activityMessage）。 */
  private static setActivityState(status: string, message: string): void {
    AppStorage.setOrCreate<string>(AppKeys.ACTIVITY_STATUS, status);
    AppStorage.setOrCreate<string>(AppKeys.ACTIVITY_MESSAGE, message);
  }

  /**
   * 加载活动报告（GET /api/v1/activity/report）。
   * - 复用 RequestGuard/SessionTicket/session 代际：旧会话响应直接丢弃，不写 AppStorage。
   * - 登录前/会话过期返回 unauthorized，并写 gv.activityStatus=unauthorized。
   * - 失败只更新状态/文案，不清空已成功加载的真实报告（页面保持上次数据）。
   * - 不做自动轮询：页面进入或用户点击时才调用。
   */
  static async loadActivityReport(scope: string, date: string): Promise<ActivityReportOutcome> {
    const outcome = new ActivityReportOutcome();
    if (GuardianService.isDemoMode()) {
      outcome.kind = 'demo_mode';
      outcome.message = '演示模式无活动报告数据';
      return outcome;
    }
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      GuardianService.setActivityState(ActivityLoadState.UNAUTHORIZED,
        '登录后才能查看真实活动报告');
      outcome.kind = ApiErrorKinds.UNAUTHORIZED;
      outcome.message = '登录后才能查看真实活动报告';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        GuardianService.setActivityState(ActivityLoadState.UNAUTHORIZED, '会话已过期，请重新登录');
        outcome.kind = ApiErrorKinds.UNAUTHORIZED;
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.stale = true;
        outcome.message = '会话已切换，本次活动报告已忽略';
      }
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      GuardianService.setActivityState(ActivityLoadState.ERROR, '服务未初始化，请重启 APP');
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    const cleanScope: string = isValidActivityScope(scope) ? scope : ActivityScope.DAY;
    const cleanDate: string = isValidIsoDate(date) ? date : '';
    GuardianService.setActivityState(ActivityLoadState.LOADING, '正在加载活动报告…');
    const result: ApiResult<ActivityReportDto> =
      await api.activityReport(ticket.token, cleanScope, cleanDate);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      // 旧会话/旧页面代际：不写任何 AppStorage，也不改网络状态。
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次活动报告已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      outcome.kind = error.kind;
      outcome.message = GuardianService.activityReportMessage(error);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        GuardianService.setActivityState(ActivityLoadState.UNAUTHORIZED, outcome.message);
      } else {
        // 失败不清空 gv.activityReport：页面继续显示上一次成功加载的真实报告。
        GuardianService.setActivityState(ActivityLoadState.ERROR, outcome.message);
      }
      return outcome;
    }
    const dto: ActivityReportDto = result.value as ActivityReportDto;
    const view: ActivityReportView = mapActivityReport(dto, GuardianService.now());
    AppStorage.setOrCreate<ActivityReportView>(AppKeys.ACTIVITY_REPORT, view);
    GuardianService.setActivityState(ActivityLoadState.OK, '');
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.report = view;
    return outcome;
  }

  /** 活动报告失败文案：明确是加载失败，不能显示成“没有活动”。 */
  private static activityReportMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，请重新登录';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '账号已被服务端停用';
    if (error.kind === ApiErrorKinds.TIMEOUT) return '活动报告加载超时，请检查网络后重试';
    if (error.kind === ApiErrorKinds.NETWORK) return '网络不可用，无法加载活动报告';
    if (error.kind === ApiErrorKinds.MALFORMED) return '服务端响应异常，无法解析活动报告';
    if (error.kind === ApiErrorKinds.RATE_LIMITED) {
      const seconds: number = error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60;
      return `操作过于频繁，请 ${seconds} 秒后再试`;
    }
    return GuardianService.businessMessage(error);
  }

  // ------------------------------------------------ health assessment

  /**
   * 重置健康资料/建议的全部 AppStorage 键与内存缓存。
   * 登录、登出、401/403、切换账号都必须调用：上一位老人的健康资料不得残留。
   */
  private static resetHealthState(): void {
    const profile: HealthProfileView = emptyHealthProfileView();
    const advice: HealthAdviceView = emptyHealthAdviceView();
    GuardianService.healthProfileCache = profile;
    GuardianService.healthAdviceCache = advice;
    AppStorage.setOrCreate<HealthProfileView>(AppKeys.HEALTH_PROFILE, profile);
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_STATUS, HealthProfileStatus.IDLE);
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_MESSAGE, '');
    AppStorage.setOrCreate<HealthAdviceView>(AppKeys.HEALTH_ADVICE, advice);
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_ADVICE_STATUS, HealthAdviceFlowState.IDLE);
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_ADVICE_MESSAGE, '');
  }

  /** 资料变化后旧的健康建议不再对应新资料：清空建议，绝不保留/伪造。 */
  private static clearHealthAdviceState(): void {
    const advice: HealthAdviceView = emptyHealthAdviceView();
    GuardianService.healthAdviceCache = advice;
    AppStorage.setOrCreate<HealthAdviceView>(AppKeys.HEALTH_ADVICE, advice);
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_ADVICE_STATUS, HealthAdviceFlowState.IDLE);
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_ADVICE_MESSAGE, '');
  }

  private static setHealthState(status: string, message: string): void {
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_STATUS, status);
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_MESSAGE, message);
  }

  private static setHealthAdviceState(status: string, message: string): void {
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_ADVICE_STATUS, status);
    AppStorage.setOrCreate<string>(AppKeys.HEALTH_ADVICE_MESSAGE, message);
  }

  /** 进程内缓存（AppStorage 同源）；仅用于页面阅读，不落盘。 */
  static healthProfileCached(): HealthProfileView {
    return GuardianService.healthProfileCache;
  }

  static healthAdviceCached(): HealthAdviceView {
    return GuardianService.healthAdviceCache;
  }

  /**
   * GET /api/v1/health-profile。
   * - 演示模式不调用网络（fail-closed）；
   * - 200 + {"profile": null} 是合法“还没有资料”，写 gv.healthStatus=empty；
   * - 失败只写状态/文案，绝不清空真实资料为伪造内容。
   */
  static async loadHealthProfile(): Promise<HealthProfileOutcome> {
    const outcome = new HealthProfileOutcome();
    if (GuardianService.isDemoMode()) {
      GuardianService.setHealthState(HealthProfileStatus.DEMO, HEALTH_DEMO_MESSAGE);
      outcome.kind = 'demo_mode';
      outcome.status = HealthProfileStatus.DEMO;
      outcome.message = HEALTH_DEMO_MESSAGE;
      return outcome;
    }
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      GuardianService.setHealthState(HealthProfileStatus.UNAUTHORIZED, '登录后才能加载健康资料');
      outcome.kind = ApiErrorKinds.UNAUTHORIZED;
      outcome.status = HealthProfileStatus.UNAUTHORIZED;
      outcome.message = '登录后才能加载健康资料';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        GuardianService.setHealthState(HealthProfileStatus.UNAUTHORIZED, '会话已过期，请重新登录');
        outcome.kind = ApiErrorKinds.UNAUTHORIZED;
        outcome.status = HealthProfileStatus.UNAUTHORIZED;
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.stale = true;
        outcome.message = '会话已切换，本次健康资料已忽略';
      }
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      GuardianService.setHealthState(HealthProfileStatus.ERROR, '服务未初始化，请重启 APP');
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.status = HealthProfileStatus.ERROR;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    GuardianService.setHealthState(HealthProfileStatus.LOADING, HEALTH_LOADING_MESSAGE);
    const result: ApiResult<HealthProfileEnvelopeDto> = await api.getHealthProfile(ticket.token);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次健康资料已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      const message: string = GuardianService.healthProfileMessage(error);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        GuardianService.setHealthState(HealthProfileStatus.UNAUTHORIZED, message);
      } else {
        GuardianService.setHealthState(HealthProfileStatus.ERROR, message);
      }
      outcome.kind = error.kind;
      outcome.status = GuardianService.requiresRelogin(error)
        ? HealthProfileStatus.UNAUTHORIZED : HealthProfileStatus.ERROR;
      outcome.message = message;
      return outcome;
    }
    const dto: HealthProfileEnvelopeDto = result.value as HealthProfileEnvelopeDto;
    if (!dto.present) {
      const emptyView: HealthProfileView = emptyHealthProfileView();
      GuardianService.healthProfileCache = emptyView;
      AppStorage.setOrCreate<HealthProfileView>(AppKeys.HEALTH_PROFILE, emptyView);
      GuardianService.setHealthState(HealthProfileStatus.EMPTY, HEALTH_PROFILE_EMPTY_MESSAGE);
      outcome.ok = true;
      outcome.kind = 'ok';
      outcome.status = HealthProfileStatus.EMPTY;
      outcome.present = false;
      return outcome;
    }
    const view: HealthProfileView = healthProfileViewFrom(dto.profile);
    GuardianService.healthProfileCache = view;
    AppStorage.setOrCreate<HealthProfileView>(AppKeys.HEALTH_PROFILE, view);
    GuardianService.setHealthState(HealthProfileStatus.OK, '');
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.status = HealthProfileStatus.OK;
    outcome.present = true;
    outcome.view = view;
    return outcome;
  }

  /**
   * PUT /api/v1/health-profile。
   * 页面必须先 `validateHealthForm` 做本地校验；本方法再兜底拒绝空资料/空请求体。
   * 保存成功后旧建议立即清空（建议只对应保存时的资料）。
   */
  static async saveHealthProfile(body: HealthProfileBody | null): Promise<HealthProfileOutcome> {
    const outcome = new HealthProfileOutcome();
    if (GuardianService.isDemoMode()) {
      GuardianService.setHealthState(HealthProfileStatus.DEMO, HEALTH_DEMO_MESSAGE);
      outcome.kind = 'demo_mode';
      outcome.status = HealthProfileStatus.DEMO;
      outcome.message = HEALTH_DEMO_MESSAGE;
      return outcome;
    }
    if (body === null || body === undefined || !body.hasAnyField()) {
      GuardianService.setHealthState(HealthProfileStatus.ERROR, HEALTH_FORM_EMPTY_MESSAGE);
      outcome.kind = ApiErrorKinds.BAD_REQUEST;
      outcome.status = HealthProfileStatus.ERROR;
      outcome.message = HEALTH_FORM_EMPTY_MESSAGE;
      return outcome;
    }
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      GuardianService.setHealthState(HealthProfileStatus.UNAUTHORIZED, '登录后才能保存健康资料');
      outcome.kind = ApiErrorKinds.UNAUTHORIZED;
      outcome.status = HealthProfileStatus.UNAUTHORIZED;
      outcome.message = '登录后才能保存健康资料';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        GuardianService.setHealthState(HealthProfileStatus.UNAUTHORIZED, '会话已过期，请重新登录');
        outcome.kind = ApiErrorKinds.UNAUTHORIZED;
        outcome.status = HealthProfileStatus.UNAUTHORIZED;
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.stale = true;
        outcome.message = '会话已切换，本次健康资料已忽略';
      }
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      GuardianService.setHealthState(HealthProfileStatus.ERROR, '服务未初始化，请重启 APP');
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.status = HealthProfileStatus.ERROR;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    GuardianService.setHealthState(HealthProfileStatus.LOADING, HEALTH_SAVING_MESSAGE);
    const result: ApiResult<HealthProfileEnvelopeDto> =
      await api.putHealthProfile(ticket.token, body);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次健康资料已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      const message: string = GuardianService.healthProfileMessage(error);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        GuardianService.setHealthState(HealthProfileStatus.UNAUTHORIZED, message);
      } else {
        GuardianService.setHealthState(HealthProfileStatus.ERROR, message);
      }
      outcome.kind = error.kind;
      outcome.status = GuardianService.requiresRelogin(error)
        ? HealthProfileStatus.UNAUTHORIZED : HealthProfileStatus.ERROR;
      outcome.message = message;
      return outcome;
    }
    const dto: HealthProfileEnvelopeDto = result.value as HealthProfileEnvelopeDto;
    const view: HealthProfileView = healthProfileViewFrom(dto.profile);
    GuardianService.healthProfileCache = view;
    AppStorage.setOrCreate<HealthProfileView>(AppKeys.HEALTH_PROFILE, view);
    GuardianService.setHealthState(HealthProfileStatus.OK, '');
    // 资料已变化：上一份建议不再对应当前资料，立即清空（绝不保留过期建议）。
    GuardianService.clearHealthAdviceState();
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.status = HealthProfileStatus.OK;
    outcome.present = true;
    outcome.view = view;
    return outcome;
  }

  /**
   * POST /api/v1/health-advice（使用服务端已保存资料）。
   * - 演示模式不调用网络；
   * - 没有本地已保存资料时不发无意义请求，直接提示“还没有健康资料”；
   * - 409/503/504/502/网络失败：只显示明确失败状态与重试入口，**绝不返回本地伪造建议**。
   */
  static async generateHealthAdvice(): Promise<HealthAdviceOutcome> {
    const outcome = new HealthAdviceOutcome();
    if (GuardianService.isDemoMode()) {
      GuardianService.setHealthAdviceState(HealthAdviceFlowState.DEMO, HEALTH_ADVICE_DEMO_MESSAGE);
      outcome.kind = 'demo_mode';
      outcome.status = HealthAdviceFlowState.DEMO;
      outcome.message = HEALTH_ADVICE_DEMO_MESSAGE;
      return outcome;
    }
    const guard: RequestGuard = GuardianService.requestGuard();
    const ticket: SessionTicket = guard.capture();
    const startedAt: number = GuardianService.now();
    if (ticket.token.length === 0) {
      GuardianService.setHealthAdviceState(HealthAdviceFlowState.UNAUTHORIZED,
        '登录后才能生成健康科普建议');
      outcome.kind = ApiErrorKinds.UNAUTHORIZED;
      outcome.status = HealthAdviceFlowState.UNAUTHORIZED;
      outcome.message = '登录后才能生成健康科普建议';
      return outcome;
    }
    if (!guard.isCurrent(ticket, startedAt)) {
      if (ticket.version === GuardianService.session.generationId() &&
        ticket.token === GuardianService.session.token()) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        GuardianService.setHealthAdviceState(HealthAdviceFlowState.UNAUTHORIZED,
          '会话已过期，请重新登录');
        outcome.kind = ApiErrorKinds.UNAUTHORIZED;
        outcome.status = HealthAdviceFlowState.UNAUTHORIZED;
        outcome.message = '会话已过期，请重新登录';
      } else {
        outcome.kind = 'stale';
        outcome.stale = true;
        outcome.message = '会话已切换，本次健康建议已忽略';
      }
      return outcome;
    }
    if (!GuardianService.healthProfileCache.present) {
      GuardianService.setHealthAdviceState(HealthAdviceFlowState.EMPTY,
        healthAdviceMessage(HealthAdviceFlowState.EMPTY));
      outcome.kind = 'health_profile_empty';
      outcome.status = HealthAdviceFlowState.EMPTY;
      outcome.message = healthAdviceMessage(HealthAdviceFlowState.EMPTY);
      return outcome;
    }
    const api: ApiClient | null = GuardianService.apiClient();
    if (api === null) {
      GuardianService.setHealthAdviceState(HealthAdviceFlowState.FAILED,
        '服务未初始化，请重启 APP');
      outcome.kind = ApiErrorKinds.UNKNOWN;
      outcome.status = HealthAdviceFlowState.FAILED;
      outcome.message = '服务未初始化，请重启 APP';
      return outcome;
    }
    GuardianService.setHealthAdviceState(HealthAdviceFlowState.LOADING,
      HEALTH_GENERATING_MESSAGE);
    const result: ApiResult<HealthAdviceEnvelopeDto> =
      await api.generateHealthAdvice(ticket.token, null);
    if (!guard.isCurrent(ticket, GuardianService.now())) {
      outcome.kind = 'stale';
      outcome.stale = true;
      outcome.message = '会话已切换，本次健康建议已忽略';
      return outcome;
    }
    if (!result.ok) {
      const error: ApiError = result.error as ApiError;
      const status: string = healthAdviceFlowForError(error.kind, error.status);
      const message: string = healthAdviceMessage(status);
      if (GuardianService.requiresRelogin(error)) {
        GuardianService.setUnauthorized('会话已过期，请重新登录');
        GuardianService.setHealthAdviceState(HealthAdviceFlowState.UNAUTHORIZED, message);
      } else {
        GuardianService.setHealthAdviceState(status, message);
      }
      outcome.kind = error.kind;
      outcome.status = GuardianService.requiresRelogin(error)
        ? HealthAdviceFlowState.UNAUTHORIZED : status;
      outcome.message = message;
      return outcome;
    }
    const dto: HealthAdviceEnvelopeDto = result.value as HealthAdviceEnvelopeDto;
    const advice: HealthAdviceDto = dto.advice;
    const view: HealthAdviceView =
      healthAdviceViewFromResult(advice, dto.generatedAt, dto.model);
    GuardianService.healthAdviceCache = view;
    AppStorage.setOrCreate<HealthAdviceView>(AppKeys.HEALTH_ADVICE, view);
    GuardianService.setHealthAdviceState(HealthAdviceFlowState.OK, '');
    outcome.ok = true;
    outcome.kind = 'ok';
    outcome.status = HealthAdviceFlowState.OK;
    outcome.view = view;
    return outcome;
  }

  /** 健康资料失败文案：明确是加载/保存失败，绝不冒充“还没有资料”。 */
  private static healthProfileMessage(error: ApiError): string {
    if (error.kind === ApiErrorKinds.UNAUTHORIZED) return '会话已过期，请重新登录';
    if (error.kind === ApiErrorKinds.FORBIDDEN) return '账号已被服务端停用';
    if (error.kind === ApiErrorKinds.TIMEOUT) return '健康资料请求超时，请检查网络后重试';
    if (error.kind === ApiErrorKinds.NETWORK) return '网络不可用，无法加载健康资料';
    if (error.kind === ApiErrorKinds.MALFORMED) return '服务端响应异常，无法解析健康资料';
    if (error.kind === ApiErrorKinds.BAD_REQUEST) return '资料未通过服务端校验，请检查输入';
    if (error.kind === ApiErrorKinds.TOO_LARGE) return '资料内容过长，请精简后重试';
    if (error.kind === ApiErrorKinds.SERVICE_UNAVAILABLE) return '健康资料服务暂不可用，请稍后重试';
    return GuardianService.businessMessage(error);
  }

  // ------------------------------------------------------------- helpers

  static pendingAttentionCount(): number {
    const alerts: AlertView[] = AppStorage.get<AlertView[]>(AppKeys.ALERTS) ?? [];
    return countNeedsAttention(alerts);
  }

  static netStatus(): string {
    return AppStorage.get<string>(AppKeys.NET_STATUS) ?? NetworkState.UNKNOWN;
  }

  static netMessage(): string {
    return AppStorage.get<string>(AppKeys.NET_MESSAGE) ?? '';
  }
}
