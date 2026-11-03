/**
 * 预警详情 & 真实 ACK 闭环 + 独立处置结果登记。
 *
 * 状态机（ACK）：idle → submitting → waiting(PENDING，等待设备回执) → confirmed(仅 ACKED)
 * 处置结果（独立于 ACK）：idle → submitting → saved / failed；
 *   - 只有服务端 201/200 且响应体合法才是“已保存”；网络/超时/5xx 一律失败并保留输入；
 *   - 处置登记不改变告警状态、不生成 ACK 命令、不会显示“设备已确认”。
 * 失败/超时/404 一律不本地归档；找不到告警显示“不存在或已失效”，禁止 Mock 回退。
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { LevelBadge } from '../components/LevelBadge';
import { PrimaryButton, SecondaryButton } from '../components/Buttons';
import { SosMapView } from '../view/SosMapView';
import { AlertView, ContactView, DispositionView, NetworkState, RunMode } from '../core/view/Models';
import { EmergencyContact } from '../model/Elder';
import {
  AckOutcome, DispositionSubmitOutcome, DispositionsOutcome, EvidenceOutcome, LocationsOutcome
} from '../core/service/Outcomes';
import { DispositionOption, dispositionOptions, findAlert } from '../core/view/ViewMapper';
import {
  SOS_DEVICE_ID, SosMapState, isSosAlert, pickLatestLocation,
  sosMapStateFromAlert, sosMapStateFromDeviceLocation, sosMapUnavailable
} from '../core/location/SosLocation';
import { LocationPointDto } from '../core/api/Contracts';
import { DISPOSITION_NOTE_MAX, DISPOSITION_OUTCOME_OTHER } from '../core/api/Contracts';
import { DateUtil } from '../common/DateUtil';
import { GuardianService } from '../service/GuardianService';
import { image } from '@kit.ImageKit';
import {
  EvidenceRequestCancellation, canViewFallEvidence
} from '../core/evidence/EvidenceCore';

class AckPhase {
  static readonly IDLE: string = 'idle';
  static readonly SUBMITTING: string = 'submitting';
  static readonly WAITING: string = 'waiting';
  static readonly CONFIRMED: string = 'confirmed';
  static readonly FAILED: string = 'failed';
  static readonly TIMEOUT: string = 'timeout';
}

class DispPhase {
  static readonly IDLE: string = 'idle';
  static readonly SUBMITTING: string = 'submitting';
  static readonly SAVED: string = 'saved';
  static readonly FAILED: string = 'failed';
}

class EvidencePhase {
  static readonly IDLE: string = 'idle';
  static readonly LOADING: string = 'loading';
  static readonly READY: string = 'ready';
  static readonly FAILED: string = 'failed';
}

class TimelineRow {
  time: number = 0;
  title: string = '';
  note: string = '';
}

const WAIT_POLL_MS: number = 3000;
const WAIT_TIMEOUT_MS: number = 60000;

@Entry
@Component
struct AlertDetailPage {
  @StorageLink('gv.alerts') @Watch('onAlertsChanged') alerts: AlertView[] = [];
  @StorageLink('gv.contacts') contacts: ContactView[] = [];
  @StorageLink('gv.contactsOverride') contactsOverride: EmergencyContact[] = [];
  @StorageLink('gv.netStatus') @Watch('onNetChanged') netStatus: string = NetworkState.UNKNOWN;
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @State alert: AlertView = new AlertView();
  @State found: boolean = false;
  @State phase: string = AckPhase.IDLE;
  @State note: string = '';
  @State submitting: boolean = false;
  @State ackMessage: string = '';
  @State submitAt: number = 0;
  @State elapsedSec: number = 0;
  @State timelineRows: TimelineRow[] = [];
  @State evidencePhase: string = EvidencePhase.IDLE;
  @State evidenceMessage: string = '';
  @State evidencePixelMap: image.PixelMap | null = null;
  /** MANUAL_SOS 求助地图：坐标已在 core/location 转成 GCJ-02，页面只负责展示。 */
  @State sosMap: SosMapState = new SosMapState();
  @State sosMapPayload: string = '{}';
  @State sosMapLoading: boolean = false;
  @State sosMapMessage: string = '';
  /** 处置结果面板（独立于 ACK） */
  @State dispPhase: string = DispPhase.IDLE;
  @State dispOutcome: string = '';
  @State dispNote: string = '';
  @State dispSubmitting: boolean = false;
  @State dispMessage: string = '';
  @State dispRecords: DispositionView[] = [];
  @State dispRecordsLoading: boolean = false;
  @State dispRecordsMessage: string = '';
  @State dispRecordsLoaded: boolean = false;
  @State dispSaved: DispositionView | null = null;
  private dispOptions: DispositionOption[] = dispositionOptions();
  private dispRecordsRequestId: number = 0;
  private dispSubmitRequestId: number = 0;
  /** 幂等键：失败重试沿用同一编号；用户修改结果/说明后重新生成，避免 409。 */
  private clientDispositionId: string = '';
  private alarmId: string = '';
  private waitTimerId: number = -1;
  private tickTimerId: number = -1;
  private redirecting: boolean = false;
  /** 页面已销毁：ACK/处置请求已提交给服务器，不取消；但迟到回调不得再更新页面/定时器/提示。 */
  private disposed: boolean = false;
  private evidenceCancellation: EvidenceRequestCancellation | null = null;
  private evidenceRequestId: number = 0;
  /** 主数据源 /api/v1/location 的 esp32-sos 最新点（WGS84）；同一 alarm 首次进入自动查询一次。 */
  private sosPoint: LocationPointDto | null = null;
  private sosPointAlarmId: string = '';
  private sosPointRequestId: number = 0;
  private sosQueryDone: boolean = false;
  private sosQueryLoading: boolean = false;
  /** ACKED 后重新取一次最新定位（适配器在设备回执后恢复最新 gps）。 */
  private sosPostAckFetched: boolean = false;

  aboutToAppear() {
    this.disposed = false;
    const params = this.getUIContext().getRouter().getParams() as Record<string, string>;
    const nextAlarmId: string = params !== undefined && params !== null && params['alertId'] !== undefined
      ? params['alertId'] : '';
    if (this.alarmId !== nextAlarmId) {
      this.cancelEvidenceLoad();
      this.releaseEvidencePixelMap();
      this.evidencePhase = EvidencePhase.IDLE;
      this.evidenceMessage = '';
      this.resetSosPoint();
    }
    this.alarmId = nextAlarmId;
    this.syncAlert();
    this.tickTimerId = setInterval(() => {
      this.elapsedSec = Date.now();
    }, 1000);
    if (this.alarmId.length > 0 && this.mode !== RunMode.DEMO) {
      void GuardianService.refreshAlerts();
      this.loadDispositionRecords();
    }
  }

  aboutToDisappear() {
    // 离开页面只做生命周期清理；已经提交给服务端的 ACK/处置不受影响（不会被解释为取消）。
    this.disposed = true;
    this.dispRecordsRequestId += 1;
    this.dispSubmitRequestId += 1;
    this.sosPointRequestId += 1;
    this.cancelEvidenceLoad();
    this.releaseEvidencePixelMap();
    this.evidencePhase = EvidencePhase.IDLE;
    this.evidenceMessage = '';
    this.stopWaitTimer();
    if (this.tickTimerId !== -1) {
      clearInterval(this.tickTimerId);
      this.tickTimerId = -1;
    }
  }

  private onAlertsChanged(): void {
    if (this.disposed) return;
    this.syncAlert();
  }

  private onNetChanged(): void {
    if (this.disposed || this.mode === RunMode.DEMO) return;
    if (this.netStatus === NetworkState.UNAUTHORIZED && !this.redirecting) {
      this.redirecting = true;
      this.stopWaitTimer();
      this.getUIContext().getRouter().replaceUrl({ url: 'pages/LoginPage' });
    }
  }

  private syncAlert(): void {
    if (this.disposed) return;
    if (this.alarmId.length === 0) {
      this.found = false;
      this.clearSosMap();
      this.refreshTimeline();
      return;
    }
    const current: AlertView | null = findAlert(this.alerts, this.alarmId);
    if (current === null) {
      this.found = false;
      this.clearSosMap();
      if (this.phase === AckPhase.WAITING) {
        this.phase = AckPhase.FAILED;
        this.ackMessage = '告警已不在服务端列表中（可能已失效），未本地归档';
        this.stopWaitTimer();
      }
      this.refreshTimeline();
      return;
    }
    this.found = true;
    this.alert = current;
    this.refreshSosMap();
    if (!this.canViewEvidence()) {
      this.cancelEvidenceLoad();
      this.releaseEvidencePixelMap();
      this.evidencePhase = EvidencePhase.IDLE;
      this.evidenceMessage = '';
    }
    if (current.statusKey === 'acked') {
      if (this.mode === RunMode.DEMO) {
        this.phase = AckPhase.FAILED;
        this.ackMessage = '演示示例未包含设备回执，不展示真实 ACK 成功';
        this.stopWaitTimer();
      } else if (this.phase !== AckPhase.CONFIRMED) {
        this.phase = AckPhase.CONFIRMED;
        this.ackMessage = '设备已确认（服务端 ACKED）';
      }
      this.stopWaitTimer();
    } else if (current.statusKey === 'waiting') {
      if (this.phase === AckPhase.IDLE || this.phase === AckPhase.SUBMITTING) {
        this.phase = AckPhase.WAITING;
        this.ackMessage = '服务端显示命令等待设备回执';
      }
      if (this.phase !== AckPhase.TIMEOUT) {
        this.startWaitTimer();
      }
    } else if (current.statusKey === 'pending') {
      if (this.phase === AckPhase.WAITING) {
        this.phase = AckPhase.FAILED;
        this.ackMessage = '命令已结束但设备未确认，告警仍待确认；未本地归档';
        this.stopWaitTimer();
      }
    }
    this.refreshTimeline();
  }

  private refreshTimeline(): void {
    const rows: TimelineRow[] = [];
    if (this.found && this.alert.createdAt > 0) {
      const created = new TimelineRow();
      created.time = this.alert.createdAt;
      created.title = '告警产生';
      created.note = `${this.alert.title} · 设备 ${this.alert.deviceId}`;
      rows.push(created);
    }
    if (this.submitAt > 0) {
      const submitted = new TimelineRow();
      submitted.time = this.submitAt;
      submitted.title = '本机已提交确认请求';
      submitted.note = '服务端已接受命令（PENDING），不代表设备已确认';
      rows.push(submitted);
    }
    if (this.found && this.alert.statusKey === 'acked' && this.alert.acknowledgedAt > 0) {
      const acked = new TimelineRow();
      acked.time = this.alert.acknowledgedAt;
      acked.title = '设备已确认（回执）';
      acked.note = this.alert.acknowledgedBy.length > 0
        ? `回执人：${this.alert.acknowledgedBy}` : '';
      rows.push(acked);
    }
    rows.sort((left: TimelineRow, right: TimelineRow): number => left.time - right.time);
    this.timelineRows = rows;
  }

  // -------------------------------------------------- SOS 求助地图

  /** 无告警/非 SOS：清空地图卡状态（不显示任何位置）。 */
  private clearSosMap(): void {
    this.sosMap = new SosMapState();
    this.sosMapPayload = '{}';
    this.sosMapLoading = false;
    this.sosMapMessage = '';
  }

  private resetSosPoint(): void {
    this.sosPoint = null;
    this.sosPointAlarmId = '';
    this.sosPointRequestId += 1;
    this.sosQueryDone = false;
    this.sosQueryLoading = false;
    this.sosPostAckFetched = false;
    this.clearSosMap();
  }

  /**
   * MANUAL_SOS 地图状态刷新（Lead 2026-10-27 实测更正后的唯一数据源方案）：
   * - 主数据源：`GET /api/v1/location` 的 deviceId=esp32-sos 最新点（WGS84）；
   *   已缓存则按当前时间重算年龄与 120s 有效期状态（无需重复请求）；
   * - 状态由 APP 计算：无记录→暂无定位，now-fixTime>120s→定位已过期（仍画最后位置），否则定位有效；
   * - “求助时刻位置/求助后更新”由 fixTime 与 alert.createdAt（±5s 容差）判定；
   * - 告警若带可选 sosLocation 则先展示（兼容路径，不是唯一数据源），随后仍会查询主数据源；
   * - 都没有时显示明确“暂无定位”，绝不显示推测位置。
   */
  private refreshSosMap(): void {
    if (this.disposed) return;
    if (!this.found || !isSosAlert(this.alert)) {
      this.clearSosMap();
      return;
    }
    if (this.mode === RunMode.DEMO) {
      // 演示数据不含真实坐标：明确说明，不伪造位置，也不联网。
      const demo: SosMapState = sosMapUnavailable('演示模式不加载真实定位；不会显示示例坐标');
      this.sosMap = demo;
      this.sosMapPayload = demo.payloadJson;
      this.sosMapLoading = false;
      this.sosMapMessage = '';
      return;
    }
    // 1) 主数据源已缓存：按当前时间重算（定位过期/年龄会随轮询自然更新）。
    if (this.sosPoint !== null && this.sosPointAlarmId === this.alert.alarmId) {
      const state: SosMapState = sosMapStateFromDeviceLocation(this.sosPoint,
        this.alert.createdAt, Date.now());
      this.sosMap = state;
      this.sosMapPayload = state.payloadJson;
      this.sosMapLoading = false;
      this.sosMapMessage = '';
      if (this.alert.statusKey === 'acked' && !this.sosPostAckFetched) {
        // 设备回执后适配器恢复最新 gps：再取一次，避免一直显示被冻结的求助时刻点。
        this.sosPostAckFetched = true;
        this.sosQueryDone = false;
        this.querySosLocationPoint();
      } else if (!this.sosQueryDone) {
        // 用户手动重试：即使已有缓存点，也强制重新查询最新定位。
        this.querySosLocationPoint();
      }
      return;
    }
    // 2) 主数据源尚未返回：仅当告警带可选 sosLocation 时先用它占位（兼容路径）。
    const fromAlert: SosMapState = sosMapStateFromAlert(this.alert, Date.now());
    this.sosMap = fromAlert;
    this.sosMapPayload = fromAlert.payloadJson;
    if (this.sosPointAlarmId !== this.alert.alarmId) {
      this.sosPointAlarmId = this.alert.alarmId;
      this.sosPointRequestId += 1;
      this.sosQueryDone = false;
      this.sosQueryLoading = false;
      this.sosPoint = null;
      this.sosPostAckFetched = false;
      this.sosMapMessage = '';
    }
    this.querySosLocationPoint();
  }

  /**
   * 查询 `/api/v1/location`（经 GuardianService，页面不直连 ApiClient），取 esp32-sos 最新点。
   * 同一告警自动查询一次；失败后由地图卡“重新查询定位”按钮手动重试（不做请求风暴）。
   */
  private querySosLocationPoint(): void {
    if (this.disposed || this.mode === RunMode.DEMO) return;
    if (this.sosQueryLoading || this.sosQueryDone) return;
    if (this.alert.alarmId.length === 0) return;
    const requestId: number = this.sosPointRequestId;
    const alarmId: string = this.alert.alarmId;
    const alertCreatedAt: number = this.alert.createdAt;
    this.sosQueryLoading = true;
    this.sosMapLoading = true;
    this.sosMapMessage = '';
    GuardianService.loadLocations().then((outcome: LocationsOutcome) => {
      if (this.disposed || requestId !== this.sosPointRequestId || alarmId !== this.alert.alarmId) return;
      this.sosQueryLoading = false;
      this.sosMapLoading = false;
      this.sosQueryDone = true;
      if (outcome.stale) return;
      if (!outcome.ok) {
        this.sosMapMessage = outcome.message.length > 0
          ? outcome.message : '定位查询失败，请稍后重试';
        return;
      }
      const point: LocationPointDto | null = pickLatestLocation(outcome.items, SOS_DEVICE_ID);
      if (point === null) {
        this.sosMapMessage = '未查询到该设备（esp32-sos）的定位记录';
        return;
      }
      this.sosPoint = point;
      this.sosPointAlarmId = alarmId;
      const state: SosMapState = sosMapStateFromDeviceLocation(point, alertCreatedAt, Date.now());
      this.sosMap = state;
      this.sosMapPayload = state.payloadJson;
      this.sosMapMessage = '';
    }).catch((): void => {
      this.sosQueryLoading = false;
      this.sosMapLoading = false;
      this.sosQueryDone = true;
      this.sosMapMessage = '定位查询失败，请稍后重试';
    });
  }

  /** 用户手动重试定位查询（失败后不自动重试，避免无意义请求风暴）。 */
  private retrySosLocation(): void {
    if (this.disposed || this.mode === RunMode.DEMO) return;
    this.sosPointRequestId += 1;
    this.sosQueryDone = false;
    this.sosQueryLoading = false;
    this.sosMapMessage = '';
    this.refreshSosMap();
  }

  private startWaitTimer(): void {
    if (this.disposed) return;
    if (this.mode === RunMode.DEMO) return;
    if (this.waitTimerId !== -1) return;
    this.waitTimerId = setInterval(() => {
      if (this.phase !== AckPhase.WAITING) {
        this.stopWaitTimer();
        return;
      }
      void GuardianService.refreshAlerts();
      if (this.submitAt > 0 && Date.now() - this.submitAt > WAIT_TIMEOUT_MS) {
        this.phase = AckPhase.TIMEOUT;
        this.ackMessage = '等待超时，仍未收到设备确认；服务端可能仍为 PENDING，请稍后刷新或联系现场';
        this.stopWaitTimer();
      }
    }, WAIT_POLL_MS);
  }

  private stopWaitTimer(): void {
    if (this.waitTimerId !== -1) {
      clearInterval(this.waitTimerId);
      this.waitTimerId = -1;
    }
  }

  private submit(): void {
    if (this.mode === RunMode.DEMO) {
      this.toast('演示模式不提交真实 ACK，不会产生设备回执');
      return;
    }
    if (!this.found) {
      this.toast('告警不存在或已失效');
      return;
    }
    if (this.submitting || this.phase === AckPhase.SUBMITTING ||
      this.phase === AckPhase.WAITING || this.phase === AckPhase.CONFIRMED) {
      return;
    }
    if (this.alert.statusKey === 'acked') {
      this.toast('该告警已由设备确认');
      return;
    }
    if (this.alert.statusKey !== 'pending') {
      this.toast('当前告警状态不允许提交确认');
      return;
    }
    this.submitting = true;
    this.phase = AckPhase.SUBMITTING;
    this.ackMessage = '';
    GuardianService.ackAlert(this.alarmId, this.note).then((outcome: AckOutcome) => {
      if (this.disposed) {
        // 页面已离开：服务器可能已受理；这里不回写已销毁页面、不重启定时器、不弹提示。
        return;
      }
      if (outcome.kind === 'stale') {
        // 会话已切换：旧 ACK 结果整体忽略。
        this.submitting = false;
        return;
      }
      this.submitting = false;
      if (outcome.accepted) {
        this.phase = AckPhase.WAITING;
        this.submitAt = Date.now();
        this.ackMessage = outcome.message.length > 0 ? outcome.message : '命令已提交，等待设备确认';
        this.startWaitTimer();
        this.refreshTimeline();
        this.toast('命令已提交，等待设备回执');
      } else if (outcome.kind === 'unauthorized') {
        this.phase = AckPhase.FAILED;
        this.ackMessage = outcome.message;
      } else {
        this.phase = AckPhase.FAILED;
        this.ackMessage = outcome.message.length > 0 ? outcome.message : '提交失败，未确认';
        this.toast(this.ackMessage);
      }
    });
  }

  private refreshNow(): void {
    if (this.mode === RunMode.DEMO) {
      this.toast('演示模式不刷新真实状态');
      return;
    }
    this.toast('正在刷新真实状态…');
    void GuardianService.refreshAlerts();
  }

  // -------------------------------------------------- disposition panel

  /** 查询该告警已保存的处置记录（真实接口；失败显示真实错误，不回退演示数据）。 */
  private loadDispositionRecords(): void {
    if (this.disposed || this.mode === RunMode.DEMO || this.alarmId.length === 0) return;
    this.dispRecordsRequestId += 1;
    const requestId: number = this.dispRecordsRequestId;
    const alarmId: string = this.alarmId;
    this.dispRecordsLoading = true;
    this.dispRecordsMessage = '';
    GuardianService.loadDispositions(alarmId).then((result: DispositionsOutcome) => {
      if (this.disposed || requestId !== this.dispRecordsRequestId || alarmId !== this.alarmId) return;
      this.dispRecordsLoading = false;
      if (result.stale) return;
      if (!result.ok) {
        this.dispRecordsMessage =
          result.message.length > 0 ? result.message : '处置记录加载失败，请稍后重试';
        return;
      }
      this.dispRecords = result.items;
      this.dispRecordsLoaded = true;
    });
  }

  private newClientDispositionId(): string {
    const random: string = Math.random().toString(36).substring(2, 8);
    return `disp-${Date.now().toString(36)}-${random}`;
  }

  private selectDispositionOutcome(value: string): void {
    if (this.dispSubmitting) return;
    this.dispOutcome = value;
    // 内容变化后必须换新的幂等键，否则服务端会按“同编号不同内容”返回 409。
    this.clientDispositionId = '';
    if (this.dispPhase === DispPhase.FAILED) {
      this.dispPhase = DispPhase.IDLE;
      this.dispMessage = '';
    }
  }

  private changeDispositionNote(value: string): void {
    if (this.dispSubmitting) return;
    this.dispNote = value;
    this.clientDispositionId = '';
    if (this.dispPhase === DispPhase.FAILED) {
      this.dispPhase = DispPhase.IDLE;
      this.dispMessage = '';
    }
  }

  private dispSubmitLabel(): string {
    if (this.dispSubmitting) return '提交中…';
    if (this.dispPhase === DispPhase.FAILED) return '重新提交处置结果';
    return '提交处置结果';
  }

  private dispSubmitDisabled(): boolean {
    if (this.dispSubmitting) return true;
    if (this.mode === RunMode.DEMO) return true;
    return !this.found;
  }

  private submitDisposition(): void {
    if (this.mode === RunMode.DEMO) {
      this.toast('演示模式不提交真实处置结果');
      return;
    }
    if (!this.found) {
      this.toast('告警不存在或已失效，无法登记处置结果');
      return;
    }
    if (this.dispSubmitting) return;
    if (this.dispOutcome.length === 0) {
      this.toast('请选择处置结果');
      return;
    }
    if (this.dispOutcome === DISPOSITION_OUTCOME_OTHER && this.dispNote.trim().length === 0) {
      this.toast('选择“其他说明”时必须填写说明');
      return;
    }
    if (this.dispNote.length > DISPOSITION_NOTE_MAX) {
      this.toast(`说明最多 ${DISPOSITION_NOTE_MAX} 字`);
      return;
    }
    if (this.clientDispositionId.length === 0) {
      this.clientDispositionId = this.newClientDispositionId();
    }
    this.dispSubmitRequestId += 1;
    const requestId: number = this.dispSubmitRequestId;
    const alarmId: string = this.alarmId;
    const clientDispositionId: string = this.clientDispositionId;
    const outcomeValue: string = this.dispOutcome;
    const note: string = this.dispNote;
    this.dispSubmitting = true;
    this.dispPhase = DispPhase.SUBMITTING;
    this.dispMessage = '';
    GuardianService.submitDisposition(alarmId, clientDispositionId, outcomeValue, note)
      .then((result: DispositionSubmitOutcome) => {
        if (this.disposed || requestId !== this.dispSubmitRequestId || alarmId !== this.alarmId) return;
        this.dispSubmitting = false;
        if (result.stale) return;
        if (!result.ok) {
          // 失败：保留用户输入与幂等键（同一内容重试不会产生重复记录），只显示真实失败原因。
          this.dispPhase = DispPhase.FAILED;
          this.dispMessage = result.message.length > 0 ? result.message : '提交失败，处置结果未保存';
          this.toast(this.dispMessage);
          return;
        }
        this.dispPhase = DispPhase.SAVED;
        this.dispSaved = result.disposition;
        this.dispMessage = result.message.length > 0 ? result.message : '处置结果已保存';
        this.dispOutcome = '';
        this.dispNote = '';
        this.clientDispositionId = '';
        this.toast(this.dispMessage);
        this.loadDispositionRecords();
      });
  }

  private dispTimeText(record: DispositionView): string {
    return record.hasValidServerTime
      ? DateUtil.formatDateTime(record.serverTime) : '服务端时间未知';
  }

  /** 保存成功后展示服务端返回的记录；无记录时返回空视图（不伪造字段值）。 */
  private dispSavedView(): DispositionView {
    return this.dispSaved !== null ? this.dispSaved : new DispositionView();
  }

  private canViewEvidence(): boolean {
    return this.mode !== RunMode.DEMO && canViewFallEvidence(this.alert);
  }

  private cancelEvidenceLoad(): void {
    this.evidenceRequestId += 1;
    if (this.evidenceCancellation !== null) {
      this.evidenceCancellation.cancel();
      this.evidenceCancellation = null;
    }
  }

  private releaseEvidencePixelMap(): void {
    const current: image.PixelMap | null = this.evidencePixelMap;
    this.evidencePixelMap = null;
    if (current !== null) {
      current.release().catch((): void => {
        // 页面已离开，释放失败不回写 UI，也不记录图片内容。
      });
    }
  }

  private loadEvidence(): void {
    if (!this.canViewEvidence() || this.evidencePhase === EvidencePhase.LOADING) return;
    this.cancelEvidenceLoad();
    this.releaseEvidencePixelMap();
    const requestId: number = this.evidenceRequestId;
    const alarmId: string = this.alert.alarmId;
    const cancellation = new EvidenceRequestCancellation();
    this.evidenceCancellation = cancellation;
    this.evidencePhase = EvidencePhase.LOADING;
    this.evidenceMessage = '正在加载证据…';
    GuardianService.loadEvidence(alarmId, cancellation).then(async (outcome: EvidenceOutcome) => {
      if (this.disposed || requestId !== this.evidenceRequestId || alarmId !== this.alert.alarmId) return;
      this.evidenceCancellation = null;
      if (!outcome.ok || outcome.image === null) {
        if (outcome.kind === 'cancelled' || outcome.kind === 'stale') return;
        this.evidencePhase = EvidencePhase.FAILED;
        this.evidenceMessage = outcome.message.length > 0 ? outcome.message : '证据加载失败，请主动重试';
        return;
      }
      let source: image.ImageSource | null = null;
      try {
        const payload: Uint8Array = outcome.image.payload;
        const exact: Uint8Array = new Uint8Array(payload.byteLength);
        exact.set(payload);
        source = image.createImageSource(exact.buffer as ArrayBuffer);
        const pixelMap: image.PixelMap = await source.createPixelMap({ editable: false });
        if (this.disposed || requestId !== this.evidenceRequestId || alarmId !== this.alert.alarmId) {
          await pixelMap.release();
          return;
        }
        this.evidencePixelMap = pixelMap;
        this.evidencePhase = EvidencePhase.READY;
        this.evidenceMessage = '';
      } catch (_) {
        if (!this.disposed && requestId === this.evidenceRequestId) {
          this.evidencePhase = EvidencePhase.FAILED;
          this.evidenceMessage = '证据 JPEG 解码失败，已拒绝显示';
        }
      } finally {
        if (source !== null) {
          try {
            await source.release();
          } catch (_) {
            // ImageSource 不包含业务状态；释放失败不影响告警文本和 ACK。
          }
        }
      }
    });
  }

  private toast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: message });
    } catch (error) {
      // 忽略 toast 失败
    }
  }

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private alertsLoaded(): boolean {
    return this.netStatus === NetworkState.OK || this.netStatus === NetworkState.PARTIAL ||
      this.netStatus === NetworkState.OFFLINE || this.netStatus === NetworkState.ERROR;
  }

  private statusChipBg(): string {
    if (this.alert.statusKey === 'acked') return Color.successLight;
    if (this.alert.statusKey === 'waiting') return Color.primaryLight;
    if (this.alert.statusKey === 'pending') {
      return this.alert.level === 'critical' ? Color.criticalLight : Color.warningLight;
    }
    return '#F1F5F9';
  }

  private statusChipFg(): string {
    if (this.alert.statusKey === 'acked') return Color.successDark;
    if (this.alert.statusKey === 'waiting') return Color.primaryDark;
    if (this.alert.statusKey === 'pending') {
      return this.alert.level === 'critical' ? Color.criticalDark : Color.warningDark;
    }
    return Color.textSecondary;
  }

  private elapsedText(): string {
    const anchor: number = this.phase === AckPhase.WAITING && this.submitAt > 0
      ? this.submitAt : this.alert.createdAt;
    if (anchor <= 0) return '--';
    const total: number = Math.max(0, Math.floor((Date.now() - anchor) / 1000));
    return DateUtil.duration(total * 1000);
  }

  private heroGrad(): LinearGradientOptions {
    if (this.alert.level === 'critical') return Grad.heroCritical();
    if (this.alert.level === 'high' || this.alert.level === 'medium') return Grad.heroWarning();
    return Grad.heroPrimary();
  }

  private submitLabel(): string {
    if (this.submitting) return '提交中…';
    if (this.phase === AckPhase.TIMEOUT) return '重新提交确认';
    if (this.phase === AckPhase.FAILED) return '重新提交确认';
    return '提交确认（通知设备）';
  }

  private submitDisabled(): boolean {
    if (this.submitting) return true;
    if (this.phase === AckPhase.WAITING || this.phase === AckPhase.CONFIRMED) return true;
    return this.alert.statusKey !== 'pending';
  }

  @Builder
  navBar() {
    Row() {
      Row() {
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(22)
          .fontColor([Color.textPrimary])
      }
      .width(42)
      .height(42)
      .justifyContent(FlexAlign.Center)
      .onClick(() => this.getUIContext().getRouter().back())

      Text('预警详情')
        .fontSize(15)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
        .layoutWeight(1)
        .textAlign(TextAlign.Center)

      Row().width(42).height(42)
    }
    .width('100%')
    .height(50)
    .backgroundColor('rgba(255,255,255,0.94)')
    .backdropBlur(12)
    .border({ width: { bottom: 1 }, color: Color.border })
  }

  @Builder
  notFoundCard() {
    Column() {
      SymbolGlyph($r('sys.symbol.exclamationmark_circle'))
        .fontSize(56)
        .fontColor([Color.warning])
      Text('告警不存在或已失效')
        .fontSize(FontSize.h3)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
        .margin({ top: Space.md })
      Text('该告警不在服务端当前列表中，不会用 Mock 数据代替；请返回列表刷新后重试。')
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .textAlign(TextAlign.Center)
        .margin({ top: Space.xs })
      Row() {
        SecondaryButton({
          label: '返回预警列表',
          onClick_: () => this.getUIContext().getRouter().back()
        })
      }
      .width(180)
      .margin({ top: Space.lg })
    }
    .width('100%')
    .padding({ top: 80, left: Space.xxl, right: Space.xxl })
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  heroCard() {
    Column() {
      Row() {
        LevelBadge({ level: this.alert.level })
        Text(this.alert.statusText)
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.semibold)
          .fontColor(this.statusChipFg())
          .padding({ left: 9, right: 9, top: 3, bottom: 3 })
          .backgroundColor(this.statusChipBg())
          .borderRadius(Radius.pill)
          .margin({ left: 6 })
        Blank()
        Text(this.alert.createdAt > 0 ? `发生：${DateUtil.formatDateTime(this.alert.createdAt)}` : '时间未知')
          .fontSize(FontSize.caption - 0.5)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textSecondary)
      }
      .width('100%')

      Text(this.alert.title)
        .fontSize(FontSize.h1)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(Color.textPrimary)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: 10 })

      Row() {
        Text(`${this.alert.location} · 设备 ${this.alert.deviceId}`)
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textSecondary)
          .margin({ right: Space.md })
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')
      .margin({ top: 7 })

      Text(this.alert.description)
        .fontSize(FontSize.body)
        .fontColor(Color.textPrimary)
        .lineHeight(19)
        .maxLines(4)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: 10 })

      if (this.canViewEvidence()) {
        Row() {
          SymbolGlyph($r('sys.symbol.camera_fill'))
            .fontSize(11)
            .fontColor([Color.primaryDark])
          Text(`FALL 证据可用 · ${this.alert.evidenceBytes} bytes`)
            .fontSize(FontSize.mini)
            .fontColor(Color.primaryDark)
            .layoutWeight(1)
            .maxLines(2)
            .margin({ left: Space.xs })
        }
        .width('100%')
        .padding({ left: 10, right: 10, top: 8, bottom: 8 })
        .backgroundColor('#FFFFFF')
        .borderRadius(Radius.chip)
        .margin({ top: 10 })
      }
    }
    .padding(Space.lg - 1)
    .width('100%')
    .borderRadius(22)
    .linearGradient(this.heroGrad())
    .shadow(Shadow_.pop('rgba(220,38,38,0.10)'))
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  /**
   * 能力核对提示条：告警类型与设备真实能力不符（例如厨房节点未安装 PIR）时显示。
   * 只做事实提示，不改变 ACK / 处置状态机，也不改变告警状态。
   */
  @Builder
  capabilityWarningBar() {
    Column() {
      Row() {
        SymbolGlyph($r('sys.symbol.exclamationmark_triangle_fill'))
          .fontSize(16)
          .fontColor([Color.warningDark])
        Text('告警来源需核实')
          .fontSize(FontSize.body + 1)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.warningDark)
          .margin({ left: 6 })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      .width('100%')

      Text(this.alert.capabilityWarning)
        .fontSize(FontSize.caption)
        .fontColor('#92400E')
        .lineHeight(17)
        .width('100%')
        .margin({ top: 5 })

      Text('该提示不改变告警状态，也不代表设备真实告警；提交 ACK 或处置前请先核对设备能力。')
        .fontSize(FontSize.mini)
        .fontColor('#92400E')
        .lineHeight(15)
        .width('100%')
        .margin({ top: 4 })
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor(Color.warningLight)
    .borderRadius(Radius.card)
    .border({ width: 1, color: 'rgba(245,158,11,0.55)' })
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  evidencePanel() {
    Column() {
      Row() {
        Text('告警证据')
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
        Blank()
        if (this.evidencePhase === EvidencePhase.READY) {
          Text('仅内存显示')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
        }
      }
      .width('100%')

      if (this.evidencePhase === EvidencePhase.IDLE) {
        Row() {
          PrimaryButton({
            label: '查看证据',
            onClick_: () => { this.loadEvidence(); }
          })
        }
        .width('100%')
        .margin({ top: Space.md })
      } else if (this.evidencePhase === EvidencePhase.LOADING) {
        Row() {
          LoadingProgress()
            .width(20)
            .height(20)
            .color(Color.primary)
          Text(this.evidenceMessage)
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ left: Space.sm })
        }
        .width('100%')
        .justifyContent(FlexAlign.Center)
        .padding({ top: Space.lg, bottom: Space.lg })
      } else if (this.evidencePhase === EvidencePhase.READY && this.evidencePixelMap !== null) {
        Image(this.evidencePixelMap)
          .width('100%')
          .aspectRatio(4 / 3)
          .objectFit(ImageFit.Contain)
          .backgroundColor('#111827')
          .borderRadius(Radius.button)
          .margin({ top: Space.md })
        Text(this.alert.evidenceCapturedAt > 0
          ? `拍摄时间：${DateUtil.formatDateTime(this.alert.evidenceCapturedAt)}` : '拍摄时间未知')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ top: Space.xs })
      } else {
        Column() {
          Text(this.evidenceMessage.length > 0 ? this.evidenceMessage : '证据加载失败')
            .fontSize(FontSize.caption)
            .fontColor(Color.warningDark)
            .width('100%')
          Row() {
            SecondaryButton({
              label: '重试',
              onClick_: () => { this.loadEvidence(); }
            })
          }
          .width('100%')
          .margin({ top: Space.sm })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.warningLight)
        .borderRadius(Radius.button)
        .margin({ top: Space.md })
      }
    }
    .padding(Space.lg - 2)
    .width('100%')
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  /**
   * MANUAL_SOS 求助地图卡：仅随身求助告警显示；坐标/状态来自 core/location 纯逻辑，
   * 地图本体由 SosMapView（Web + rawfile/map.html）绘制。地图失败仍保留坐标文字。
   */
  @Builder
  sosMapCard() {
    Column() {
      SosMapView({
        payloadJson: this.sosMapPayload,
        available: this.sosMap.available,
        statusText: this.sosMap.statusText,
        badgeBg: this.sosMap.badgeBg,
        badgeFg: this.sosMap.badgeFg,
        coordText: this.sosMap.coordText,
        timeText: this.sosMap.timeText,
        receivedText: this.sosMap.receivedText,
        ageText: this.sosMap.ageText,
        noteText: this.sosMap.noteText,
        sourceText: this.sosMap.sourceText,
        updatedText: this.sosMap.updateText,
        loading: this.sosMapLoading,
        retryMessage: this.sosMapMessage,
        onRetry_: () => { this.retrySosLocation(); }
      })
    }
    .width('100%')
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  demoBanner() {
    Row() {
      Text('演示模式')
        .fontSize(FontSize.mini)
        .fontWeight(FontWeight_.extrabold)
        .fontColor('#92400E')
        .padding({ left: 6, right: 6, top: 2, bottom: 2 })
        .backgroundColor('#FDE68A')
        .borderRadius(Radius.pill)
      Text('示例告警 · 不发送 ACK/不产生设备回执')
        .fontSize(FontSize.mini)
        .fontColor('#92400E')
        .margin({ left: 6 })
        .layoutWeight(1)
    }
    .width('100%')
    .height(34)
    .padding({ left: this.pm(), right: this.pm() })
    .backgroundColor('#FFFBEB')
    .border({ width: { bottom: 1 }, color: '#FDE68A' })
  }

  @Builder
  ackPanel() {
    Column() {
      Row() {
        Text('告警确认（ACK）')
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
        Text(this.mode === RunMode.DEMO ? '演示模式不可提交' : '真实状态以服务端为准')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ left: 6 })
      }
      .width('100%')

      if (this.mode === RunMode.DEMO) {
        Column() {
          Row() {
            SymbolGlyph($r('sys.symbol.info_circle'))
              .fontSize(18)
              .fontColor([Color.warningDark])
            Text('演示模式：ACK 不可用')
              .fontSize(FontSize.body + 1)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.warningDark)
              .margin({ left: 6 })
          }
          .width('100%')
          Text('示例告警不会提交真实确认命令，也不会产生设备回执或显示“设备已确认”。')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 4 })
          Text('演示数据仅保存在本次运行内存；退出演示后再使用真实模式的 ACK。')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ top: 4 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.warningLight)
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      } else if (this.phase === AckPhase.CONFIRMED || this.alert.statusKey === 'acked') {
        Column() {
          Row() {
            SymbolGlyph($r('sys.symbol.checkmark_circle_fill'))
              .fontSize(18)
              .fontColor([Color.successDark])
            Text('设备已确认')
              .fontSize(FontSize.body + 1)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.successDark)
              .margin({ left: 6 })
          }
          .width('100%')
          Text(this.alert.acknowledgedAt > 0
            ? `设备回执时间：${DateUtil.formatDateTime(this.alert.acknowledgedAt)}`
            : '服务端已返回 ACKED')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 4 })
          if (this.alert.acknowledgedBy.length > 0) {
            Text(`回执人：${this.alert.acknowledgedBy}`)
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .margin({ top: 2 })
          }
          Text('该状态来自服务端告警记录，不是本机推断。')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ top: 4 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.successLight)
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      } else if (this.phase === AckPhase.TIMEOUT) {
        Column() {
          Row() {
            SymbolGlyph($r('sys.symbol.exclamationmark_triangle_fill'))
              .fontSize(16)
              .fontColor([Color.warningDark])
            Text('等待超时，尚未收到设备确认')
              .fontSize(FontSize.body + 1)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.warningDark)
              .margin({ left: 6 })
          }
          .width('100%')
          Text(this.ackMessage.length > 0
            ? this.ackMessage
            : '等待超时，仍未收到设备确认；服务端可能仍为 PENDING，未本地归档。')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 4 })
          Text('可先刷新真实状态；若服务端已回到“待确认”，再决定是否重新提交。')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ top: 4 })
          Row({ space: 8 }) {
            Column() {
              SecondaryButton({ label: '刷新真实状态', onClick_: () => { this.refreshNow(); } })
            }
            .layoutWeight(1)
            if (this.alert.statusKey === 'pending' && !this.alert.ackPending) {
              Column() {
                PrimaryButton({
                  label: '重新提交确认',
                  loading: this.submitting,
                  disabled: this.submitting,
                  variant: this.alert.level === 'critical' ? 'critical' : 'primary',
                  onClick_: () => { this.submit(); }
                })
              }
              .layoutWeight(1)
            }
          }
          .width('100%')
          .margin({ top: 8 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.warningLight)
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      } else if ((this.phase === AckPhase.WAITING || this.alert.statusKey === 'waiting') &&
        this.phase !== AckPhase.TIMEOUT) {
        Column() {
          Row() {
            LoadingProgress()
              .width(18)
              .height(18)
              .color(Color.primaryDark)
            Text('已提交，等待设备回执')
              .fontSize(FontSize.body + 1)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.primaryDark)
              .margin({ left: 6 })
          }
          .width('100%')
          Text(this.ackMessage.length > 0 ? this.ackMessage : '服务端状态为 PENDING')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 4 })
          Text('HTTP 202 只表示命令已入队；只有服务端返回 ACKED 才是设备已确认。')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ top: 4 })
          Row() {
            SecondaryButton({ label: '刷新真实状态', onClick_: () => { this.refreshNow(); } })
          }
          .width(170)
          .margin({ top: 8 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.primaryLight)
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      } else if (this.phase === AckPhase.SUBMITTING) {
        Row() {
          LoadingProgress()
            .width(18)
            .height(18)
            .color(Color.primaryDark)
          Text('正在提交确认命令…')
            .fontSize(FontSize.body)
            .fontColor(Color.primaryDark)
            .margin({ left: 6 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.primaryLight)
        .borderRadius(Radius.button)
        .margin({ top: 10 })
      } else if (this.alert.statusKey === 'pending') {
        TextArea({
          placeholder: '确认备注（选填，最多 120 字），例如：已电话确认，老人安全',
          text: this.note
        })
          .width('100%')
          .height(88)
          .fontSize(FontSize.caption + 0.5)
          .backgroundColor('#F8FAFC')
          .borderRadius(Radius.button)
          .border({ width: 1.5, color: '#CBD5E1', style: BorderStyle.Dashed })
          .padding(Space.md)
          .maxLength(120)
          .onChange((value: string) => { this.note = value; })
          .margin({ top: 10 })

        if (this.phase === AckPhase.FAILED || this.phase === AckPhase.TIMEOUT) {
          Text(this.ackMessage)
            .fontSize(FontSize.caption)
            .fontColor(Color.criticalDark)
            .width('100%')
            .padding(Space.sm)
            .backgroundColor(Color.criticalLight)
            .borderRadius(Radius.chip)
            .margin({ top: 8 })
        }

        Text('提交后服务端返回 PENDING；需等待设备真实回执 ACKED，页面才会显示“设备已确认”。')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .lineHeight(16)
          .margin({ top: 8 })

        Row() {
          PrimaryButton({
            label: this.submitLabel(),
            loading: this.submitting,
            disabled: this.submitDisabled(),
            variant: this.alert.level === 'critical' ? 'critical' : 'primary',
            onClick_: () => { this.submit(); }
          })
        }
        .width('100%')
        .margin({ top: 10 })
      } else {
        Column() {
          Text('当前告警状态不允许提交确认')
            .fontSize(FontSize.body)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textSecondary)
          Text(`服务端状态：${this.alert.state.length > 0 ? this.alert.state : '未知'}，真实状态以刷新结果为准。`)
            .fontSize(FontSize.caption)
            .fontColor(Color.textTertiary)
            .margin({ top: 3 })
          Row() {
            SecondaryButton({ label: '刷新真实状态', onClick_: () => { this.refreshNow(); } })
          }
          .width(170)
          .margin({ top: 8 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor('#F8FAFC')
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      }

      Row() {
        SymbolGlyph($r('sys.symbol.info_circle'))
          .fontSize(11)
          .fontColor([Color.textTertiary])
        Text('ACK 与处置结果相互独立：下方处置登记不改变告警状态、不触发设备确认，也不会伪造“已归档”。')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .layoutWeight(1)
          .margin({ left: 4 })
      }
      .width('100%')
      .margin({ top: 10 })
    }
    .padding(Space.lg - 2)
    .width('100%')
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  dispOptionRow(option: DispositionOption) {
    Row() {
      Text(option.label)
        .fontSize(FontSize.body + 1)
        .fontWeight(this.dispOutcome === option.value ? FontWeight_.bold : FontWeight_.regular)
        .fontColor(this.dispOutcome === option.value ? Color.primaryDark : Color.textPrimary)
        .layoutWeight(1)
      if (this.dispOutcome === option.value) {
        SymbolGlyph($r('sys.symbol.checkmark_circle_fill'))
          .fontSize(16)
          .fontColor([Color.primaryDark])
      }
    }
    .width('100%')
    .height(42)
    .padding({ left: Space.md, right: Space.md })
    .backgroundColor(this.dispOutcome === option.value ? Color.primaryLight : '#F8FAFC')
    .borderRadius(Radius.button)
    .border({
      width: 1.5,
      color: this.dispOutcome === option.value ? Color.primary : Color.border
    })
    .margin({ bottom: 6 })
    .onClick(() => { this.selectDispositionOutcome(option.value); })
  }

  @Builder
  dispRecordRow(record: DispositionView) {
    Column() {
      Row() {
        Text(record.outcomeLabel)
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.primaryDark)
          .padding({ left: 7, right: 7, top: 2, bottom: 2 })
          .backgroundColor(Color.primaryLight)
          .borderRadius(Radius.pill)
        Blank()
        Text(this.dispTimeText(record))
          .fontSize(FontSize.caption - 0.5)
          .fontColor(record.hasValidServerTime ? Color.textSecondary : Color.warningDark)
      }
      .width('100%')

      Text(`处理人：${record.operatorText}`)
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .width('100%')
        .margin({ top: 4 })

      if (record.note.length > 0) {
        Text(`说明：${record.note}`)
          .fontSize(FontSize.caption)
          .fontColor(Color.textPrimary)
          .width('100%')
          .lineHeight(17)
          .margin({ top: 2 })
      }
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor('#F8FAFC')
    .borderRadius(Radius.button)
    .alignItems(HorizontalAlign.Start)
    .margin({ bottom: 6 })
  }

  @Builder
  dispSavedBox(record: DispositionView) {
    Column() {
      Row() {
        SymbolGlyph($r('sys.symbol.checkmark_circle_fill'))
          .fontSize(18)
          .fontColor([Color.successDark])
        Text('处置结果已保存')
          .fontSize(FontSize.body + 1)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.successDark)
          .margin({ left: 6 })
        Blank()
        Text('服务端记录')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
      }
      .width('100%')

      Text(`处置结果：${record.outcomeLabel}`)
        .fontSize(FontSize.caption)
        .fontColor(Color.textPrimary)
        .width('100%')
        .margin({ top: 5 })
      Text(`处理时间（服务端）：${this.dispTimeText(record)}`)
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .width('100%')
        .margin({ top: 2 })
      Text(`处理人：${record.operatorText}`)
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .width('100%')
        .margin({ top: 2 })
      if (record.note.length > 0) {
        Text(`说明：${record.note}`)
          .fontSize(FontSize.caption)
          .fontColor(Color.textSecondary)
          .width('100%')
          .margin({ top: 2 })
      }
      if (this.dispMessage.length > 0) {
        Text(this.dispMessage)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .width('100%')
          .margin({ top: 4 })
      }
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor(Color.successLight)
    .borderRadius(Radius.button)
    .alignItems(HorizontalAlign.Start)
    .margin({ top: 10 })
  }

  @Builder
  dispositionPanel() {
    Column() {
      Row() {
        Text('处置结果')
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
        Text('独立于 ACK · 不改告警状态')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ left: 6 })
      }
      .width('100%')

      Text('登记本次已采取的人工处置结果，保存到服务端安全日志；不会触发设备确认。')
        .fontSize(FontSize.mini)
        .fontColor(Color.textTertiary)
        .width('100%')
        .margin({ top: 4 })

      if (this.mode === RunMode.DEMO) {
        Column() {
          Row() {
            SymbolGlyph($r('sys.symbol.info_circle'))
              .fontSize(18)
              .fontColor([Color.warningDark])
            Text('演示模式：处置结果不可提交')
              .fontSize(FontSize.body + 1)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.warningDark)
              .margin({ left: 6 })
          }
          .width('100%')
          Text('示例告警不会向服务端登记真实处置结果，也不会显示“已保存”。')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 4 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.warningLight)
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      } else {
        Text('选择处置结果（必选）')
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textSecondary)
          .width('100%')
          .margin({ top: 10, bottom: 6 })

        ForEach(this.dispOptions, (option: DispositionOption) => {
          this.dispOptionRow(option)
        }, (option: DispositionOption) => option.value)

        Text('说明（选填；选择“其他说明”时必填）')
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textSecondary)
          .width('100%')
          .margin({ top: 4, bottom: 6 })
        TextArea({
          placeholder: '补充处置细节（最多 200 字）',
          text: this.dispNote
        })
          .width('100%')
          .height(88)
          .fontSize(FontSize.caption + 0.5)
          .backgroundColor('#F8FAFC')
          .borderRadius(Radius.button)
          .border({ width: 1.5, color: '#CBD5E1', style: BorderStyle.Dashed })
          .padding(Space.md)
          .maxLength(DISPOSITION_NOTE_MAX)
          .onChange((value: string) => { this.changeDispositionNote(value); })
        Row() {
          Blank()
          Text(`${this.dispNote.length}/${DISPOSITION_NOTE_MAX}`)
            .fontSize(FontSize.mini)
            .fontColor(this.dispNote.length >= DISPOSITION_NOTE_MAX
              ? Color.warningDark : Color.textTertiary)
        }
        .width('100%')
        .margin({ top: 2 })

        if (this.dispPhase === DispPhase.FAILED && this.dispMessage.length > 0) {
          Text(this.dispMessage)
            .fontSize(FontSize.caption)
            .fontColor(Color.criticalDark)
            .width('100%')
            .padding(Space.sm)
            .backgroundColor(Color.criticalLight)
            .borderRadius(Radius.chip)
            .margin({ top: 8 })
        }

        Row() {
          PrimaryButton({
            label: this.dispSubmitLabel(),
            loading: this.dispSubmitting,
            disabled: this.dispSubmitDisabled(),
            variant: 'accent',
            onClick_: () => { this.submitDisposition(); }
          })
        }
        .width('100%')
        .margin({ top: 10 })

        Text('提交只登记处置结果：不改变告警状态、不发送 ACK，也不代表设备已确认。')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .width('100%')
          .lineHeight(16)
          .margin({ top: 8 })

        if (this.dispPhase === DispPhase.SAVED && this.dispSaved !== null) {
          this.dispSavedBox(this.dispSavedView())
        } else if (this.dispPhase === DispPhase.SAVED && this.dispMessage.length > 0) {
          Text(this.dispMessage)
            .fontSize(FontSize.caption)
            .fontColor(Color.successDark)
            .width('100%')
            .padding(Space.sm)
            .backgroundColor(Color.successLight)
            .borderRadius(Radius.chip)
            .margin({ top: 8 })
        }

        Divider()
          .color('#EEF2F7')
          .margin({ top: 14, bottom: 10 })

        Row() {
          Text('已保存处置记录')
            .fontSize(FontSize.body + 0.5)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textPrimary)
          Blank()
          if (this.dispRecordsLoaded) {
            Text(`共 ${this.dispRecords.length} 条`)
              .fontSize(FontSize.mini)
              .fontColor(Color.textTertiary)
          }
        }
        .width('100%')

        if (this.dispRecordsLoading) {
          Row() {
            LoadingProgress()
              .width(18)
              .height(18)
              .color(Color.primary)
            Text('正在加载处置记录…')
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .margin({ left: 6 })
          }
          .width('100%')
          .padding({ top: Space.md, bottom: Space.sm })
        } else if (this.dispRecordsMessage.length > 0) {
          Column() {
            Text(this.dispRecordsMessage)
              .fontSize(FontSize.caption)
              .fontColor(Color.warningDark)
              .width('100%')
            Row() {
              SecondaryButton({
                label: '重试查询',
                onClick_: () => { this.loadDispositionRecords(); }
              })
            }
            .width(150)
            .margin({ top: Space.sm })
          }
          .width('100%')
          .padding(Space.md)
          .backgroundColor(Color.warningLight)
          .borderRadius(Radius.button)
          .alignItems(HorizontalAlign.Start)
          .margin({ top: 8 })
        } else if (this.dispRecords.length === 0) {
          Text('该告警暂无已保存的处置记录')
            .fontSize(FontSize.caption)
            .fontColor(Color.textTertiary)
            .width('100%')
            .margin({ top: 8 })
        } else {
          Column() {
            ForEach(this.dispRecords, (record: DispositionView) => {
              this.dispRecordRow(record)
            }, (record: DispositionView) => `${record.dispositionId}_${record.serverTime}`)
          }
          .width('100%')
          .margin({ top: 8 })
        }
      }
    }
    .padding(Space.lg - 2)
    .width('100%')
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  quickContacts() {
    Column() {
      Row() {
        SymbolGlyph($r('sys.symbol.phone_fill'))
          .fontSize(15)
          .fontColor([Color.primaryDark])
        Text('联系方式')
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
          .margin({ left: 6 })
        Blank()
        Text('点击查看号码')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
      }
      .width('100%')

      if (this.contactsOverride.length > 0) {
        ForEach(this.contactsOverride, (c: EmergencyContact) => {
          this.contactCard(c.name, c.relation, c.phone)
        }, (c: EmergencyContact) => c.id)
      } else if (this.contacts.length > 0) {
        ForEach(this.contacts, (c: ContactView) => {
          this.contactCard(c.name, c.relation, c.phone)
        }, (c: ContactView) => c.id)
      } else {
        this.contactCard('家属', '服务端未返回联系人', '')
      }
      this.contactCard('急救', '120', '120')
    }
    .width('100%')
    .padding(Space.lg - 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  contactCard(name: string, relation: string, phone: string) {
    Row() {
      Column() {
        Text(name.substring(0, 1))
          .fontSize(FontSize.body + 1)
          .fontWeight(FontWeight_.extrabold)
          .fontColor(Color.primaryDark)
      }
      .width(36).height(36).borderRadius(12)
      .backgroundColor(Color.primaryLight)
      .justifyContent(FlexAlign.Center)

      Column() {
        Text(`${name}${relation.length > 0 ? ' · ' + relation : ''}`)
          .fontSize(FontSize.body - 1)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textPrimary)
        Text(phone.length > 0 ? phone : '号码未知')
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textSecondary)
          .margin({ top: 2 })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .margin({ left: 10 })

      if (phone.length > 0) {
        Text('拨打')
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.primaryDark)
          .padding({ left: 8, right: 8, top: 4, bottom: 4 })
          .backgroundColor('#E0F2FE')
          .borderRadius(Radius.pill)
          .onClick(() => {
            this.toast(`请手动拨打 ${phone}`);
          })
      }
    }
    .width('100%')
    .padding({ top: 8, bottom: 8 })
  }

  @Builder
  timelineCard() {
    Column() {
      Text(this.mode === RunMode.DEMO ? '事件时间线（本地示例）' : '事件时间线（仅真实记录）')
        .fontSize(FontSize.h3)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
        .margin({ bottom: Space.md })

      if (this.timelineRows.length === 0) {
        Text('暂无可展示的真实时间线')
          .fontSize(FontSize.caption)
          .fontColor(Color.textTertiary)
      } else {
        ForEach(this.timelineRows, (row: TimelineRow, index: number) => {
          Row() {
            Column() {
              Column()
                .width(9)
                .height(9)
                .borderRadius(4.5)
                .linearGradient(index === this.timelineRows.length - 1
                  ? Grad.primary()
                  : { angle: 135, colors: [['#CBD5E1', 0.0], ['#CBD5E1', 1.0]] })
              if (index < this.timelineRows.length - 1) {
                Column()
                  .width(2)
                  .height(26)
                  .backgroundColor(Color.border)
                  .margin({ top: 4 })
              }
            }
            .width(16)
            .alignItems(HorizontalAlign.Center)

            Column() {
              Row() {
                Text(row.title)
                  .fontSize(FontSize.body - 0.5)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(Color.textPrimary)
                  .layoutWeight(1)
                Text(DateUtil.formatDateTime(row.time))
                  .fontSize(FontSize.caption - 0.5)
                  .fontColor(Color.textTertiary)
              }
              .width('100%')
              if (row.note.length > 0) {
                Text(row.note)
                  .fontSize(FontSize.caption - 0.5)
                  .fontColor(Color.textSecondary)
                  .width('100%')
                  .maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ top: 2 })
              }
            }
            .layoutWeight(1)
            .padding({ left: 9, bottom: Space.md })
            .alignItems(HorizontalAlign.Start)
          }
          .width('100%')
          .alignItems(VerticalAlign.Top)
        }, (row: TimelineRow, index: number) => `${index}_${row.time}_${row.title}`)
      }

      if (this.netStatus !== NetworkState.OK) {
        Text(this.netMessage.length > 0 ? this.netMessage : '网络状态异常，显示上次数据')
          .fontSize(FontSize.mini)
          .fontColor(Color.warningDark)
          .width('100%')
          .margin({ top: 6 })
      }
    }
    .padding(Space.lg - 2)
    .width('100%')
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2, bottom: Space.xxl })
  }

  build() {
    Column() {
      this.navBar()
      if (this.mode === RunMode.DEMO) {
        this.demoBanner()
      }

      if (!this.found && !this.alertsLoaded()) {
        Column() {
          LoadingProgress()
            .width(28)
            .height(28)
            .color(Color.primary)
          Text('正在加载真实告警数据…')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: Space.md })
        }
        .width('100%')
        .padding({ top: 80 })
        .alignItems(HorizontalAlign.Center)
      } else if (!this.found) {
        this.notFoundCard()
      } else {
        Scroll() {
          Column() {
            this.heroCard()
            if (this.alert.capabilityWarning.length > 0) {
              this.capabilityWarningBar()
            }
            if (isSosAlert(this.alert)) {
              this.sosMapCard()
            }
            if (this.canViewEvidence()) {
              this.evidencePanel()
            }
            this.ackPanel()
            this.quickContacts()
            this.dispositionPanel()
            this.timelineCard()
          }
          .width('100%')
        }
        .layoutWeight(1)
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
