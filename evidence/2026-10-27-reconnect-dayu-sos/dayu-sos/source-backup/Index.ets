import socket from '@ohos.net.socket';
import buffer from '@ohos.buffer';
import { BusinessError } from '@ohos.base';
import common from '@ohos.app.ability.common';
import window from '@ohos.window';
import { DeviceStore, AlarmItem } from '../model/DeviceModel';
import { DeviceCapability, DeviceCapabilities } from '../model/DeviceCapabilities';
import { CameraModel, CameraPhotoResult, CameraPreviewSummary } from '../model/CameraModel';
import { VisionFrameStreamer, VisionStreamStatus } from '../model/VisionFrameStreamer';
import { VideoStreamServer, VideoStreamStatus } from '../model/VideoStreamServer';
import { PreviewTuningStore, PreviewTuningSettings } from '../model/PreviewTuning';

/** 候选端口：多节点时每个房间节点监听一个端口（配合 hdc fport 映射到 PC） */
const PORTS: number[] = [9000, 9001, 9002];

/** 设备超时判定常量：超过此时间未收到状态即判定离线（毫秒） */
const DEVICE_STALE_MS: number = 12000;
/** 定时器检查间隔（毫秒） */
const TIMER_INTERVAL_MS: number = 3000;
/** 相机暂时不可用时做有限重试；避免无人值守时一次瞬态失败永久停监。 */
const CAMERA_GUARD_RETRY_MS: number = 2000;
const CAMERA_GUARD_MAX_RETRIES: number = 3;
const CAMERA_GUARD_RECOVERY_MS: number = 60000;
const GUARD_FOREGROUND_EVENT: string = 'eldercare.guard.foreground';
/** 正式客厅视觉节点身份（homemon 正式配置值） */
const CANONICAL_LIVING_DEVICE_ID: string = 'dayu200-living';
/** 历史别名：旧 homemon 默认 deviceId 与正式身份是同一台设备，收到正式身份后必须迁移掉 */
const LEGACY_DEVICE_IDS: string[] = ['dayu200-01'];
/** 摄像头物理归属固定：只有该设备显示与控制客厅摄像头 */
const CAMERA_OWNER_DEVICE_ID: string = 'dayu200-living';

/** 单个节点的最新快照 */
interface DevSnap {
  id: string;
  room: string;
  state: string;
  count: number;
  lastActiveTs: number;
  doorOpen: boolean;
  doorLastOpenTs: number;
  tempC: number;
  rh: number;
  climateOk: boolean;
  climateValid: boolean;
  climateValidKnown: boolean;
  gasOk: boolean;
  smokeOk: boolean;
  gasRaw: number;
  smokeRaw: number;
  gasValid: boolean;
  gasValidKnown: boolean;
  smokeValid: boolean;
  smokeValidKnown: boolean;
  history: number[];
  slots: number[];
  alarmCount: number;
  alarms: AlarmItem[];
  online: boolean;
  lastSeenMs: number;  // 本地接收时间（Date.now()），用于超时判定
  /** PC 侧监护链路：1=在线，0=失联，-1=从未上报（不显示失联告警） */
  monitorOnline: number;
}

/** 到某个节点的 TCP 连接 */
interface Link {
  sock: socket.TCPSocket | null;
  buf: string;
  port: number;               // ⚠ 一条连接会复用承载多个设备（relay），设备归属见 routes
  connected: boolean;
  retrying: boolean;          // 已有重连任务在排队 → 不再重复排
  deviceIds: string[];        // 该连接上见过的全部 deviceId（断线时一并标离线）
}

/** deviceId 白名单：会被拼进 `route <deviceId> ...` 命令行，必须防协议注入 */
const DEVICE_ID_RE: RegExp = /^[A-Za-z0-9._-]{1,64}$/;

/* ---- 节点上报报文（competition/README.md §3.1）的显式类型 ---- */
interface RawOk {
  raw: number;
  ok: boolean;
  /** 新固件显式有效性；旧报文没有该字段时为未知，不能按 0 猜测 */
  valid?: boolean;
}

interface RawMotion {
  lastActiveTs: number;
  countToday: number;
}

interface RawDoor {
  open: boolean;
  lastOpenTs: number;
}

interface RawClimate {
  tempC: number;
  rh: number;
  ok: boolean;
  /** 新固件显式有效性；旧报文没有该字段时为未知 */
  valid?: boolean;
}

interface RawSensors {
  motion: RawMotion;
  door: RawDoor;
  climate: RawClimate;
  gas: RawOk;
  smoke: RawOk;
}

interface RawAlarmMsg {
  id: string;
  type: string;
  countToday: number;
}

interface NodeMsg {
  deviceId: string;
  room: string;
  ts: number;
  state: string;
  sensors: RawSensors;
  history: number[];
  slots: number[];
  alarm: RawAlarmMsg;
  /** PC watchdog 上报的监护链路状态；旧版 homemon 不带该字段 */
  monitorOnline?: number;
}

/**
 * 监护人端主页：三个页签（实时状态 / 预警处置 / 统计报告）
 * 对应赛题四北向要求：实时查看状态、历史预警与详情、事件闭环、数据统计分析。
 *
 * 多节点（2026-10-09 新增）：
 *   页面自动发现 9000–9002 上的节点（每个房间一个），按报文里的 deviceId/room 归类，
 *   顶部提供**设备切换**；每个房间的数据与告警互相独立。
 *
 * ⚠ 界面刷新约束（真机实测结论）：
 *   只有「build() 里**内联直接引用 @State**」的控件会刷新 ——
 *   @Prop 传子组件 / @StorageProp / @Builder 传参 在本环境下均不可靠，故页面全部内联渲染。
 */
@Entry
@Component
struct Index {
  @State current: number = 0;
  @State diag: string = '初始化';

  /* 设备列表与选中项 */
  @State deviceIds: string[] = [];
  @State deviceLabels: string[] = [];
  @State selectedId: string = '';

  /* 选中设备的实时快照（内联渲染用） */
  @State liveRoom: string = '-';
  @State liveState: string = 'NORMAL';
  @State liveOnline: boolean = false;
  @State liveCount: number = 0;
  @State liveLastActiveTs: number = 0;
  @State liveDoorOpen: boolean = false;
  @State liveDoorLastOpenTs: number = 0;
  @State liveTempC: number = 0;
  @State liveRh: number = 0;
  @State liveClimateOk: boolean = true;
  @State liveClimateValid: boolean = false;
  @State liveClimateValidKnown: boolean = false;
  @State liveGasOk: boolean = true;
  @State liveSmokeOk: boolean = true;
  @State liveGasRaw: number = 0;
  @State liveSmokeRaw: number = 0;
  @State liveGasValid: boolean = false;
  @State liveGasValidKnown: boolean = false;
  @State liveSmokeValid: boolean = false;
  @State liveSmokeValidKnown: boolean = false;
  @State liveHistory: number[] = [0, 0, 0, 0, 0, 0, 0];
  @State liveSlots: number[] = [0, 0, 0, 0];
  @State liveAlarmCount: number = 0;
  @State liveAlarms: AlarmItem[] = [];
  @State ackText: string = '';
  @State ackHint: string = '';                 // 闭环状态提示（下发中/超时）
  @State cameraStatusText: string = '监护准备中';
  @State cameraPhotoText: string = '';
  @State cameraBusy: boolean = false;
  @State cameraPreviewActive: boolean = false;
  @State cameraPhotoAvailable: boolean = false;
  @State cameraGuardEnabled: boolean = true;
  @State cameraVisionText: string = '自动监护待启动';
  @State cameraVisionConnected: boolean = false;
  @State cameraVisionFall: boolean = false;
  /** Display-only camera preview tuning; persisted in the formal app's local preferences. */
  @State cameraPreviewWidthPct: number = 60;
  @State cameraPreviewScalePct: number = 130;
  @State liveMonitorOnline: number = -1;       // PC 侧监护链路：1=在线 0=失联 -1=未上报
  @State pendingAckId: string = '';            // 已下发但尚未被设备确认的告警（@State：告警行"确认中"需随之刷新）
  @State pendingDeviceId: string = '';         // ⚠ 必须记下"发给哪个设备"，否则切房间会错结算
  private sending: boolean = false;            // send Promise 未落定前禁止重复下发（防覆盖 pending）
  private pendingAction: string = '';
  private pendingSince: number = 0;

  private timerId: number = -1;
  private tick: number = 0;
  private order: string[] = [];
  private snaps: Map<string, DevSnap> = new Map();
  private links: Link[] = [];
  /** deviceId → 该设备状态到达的连接端口（命令必须沿原路返回） */
  private routes: Map<string, number> = new Map();
  private cameraModel: CameraModel = new CameraModel();
  private visionStreamer: VisionFrameStreamer = new VisionFrameStreamer();
  /** 手机远程视频探望的板端取帧服务（只监听本机回环，按需取帧）。 */
  private videoStreamServer: VideoStreamServer = new VideoStreamServer();
  /** 远程探望状态文案：只在真实推流时显示帧数/帧率。 */
  @State videoVisitText: string = '远程探望：服务启动中';
  private cameraController: XComponentController = new XComponentController();
  private cameraSurfaceId: string = '';
  private cameraPageActive: boolean = false;
  private cameraAbilityForeground: boolean = true;
  private cameraRetryTimerId: number = -1;
  private cameraRetryCount: number = 0;
  /** 同一 evidenceId 只触发一次全分辨率拍照；pending 用于标记当前/正在完成的证据照片。 */
  private lastAutoEvidenceId: string = '';
  private pendingFallEvidenceId: string = '';
  private pendingPcEvidenceFile: string = '';
  /** 每次暂停/Surface 销毁都会递增，令仍在 await 的旧启动结果失效。 */
  private cameraStartGeneration: number = 0;
  private abilityForegroundListener = (foreground: boolean): void => {
    console.info(`[Index] guard foreground event=${foreground}`);
    this.cameraAbilityForeground = foreground;
    if (!foreground) {
      this.stopCameraGuardRuntime('应用已进入后台，监护已暂停');
      return;
    }
    if (this.cameraGuardEnabled && this.cameraPageActive) {
      this.cameraRetryCount = 0;
      this.cameraStatusText = '自动监护准备中';
      this.scheduleCameraGuardStart(0);
    }
  };

  aboutToAppear(): void {
    this.cameraPageActive = true;
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    context.eventHub.on(GUARD_FOREGROUND_EVENT, this.abilityForegroundListener);
    void this.loadPreviewTuning(context);
    DeviceStore.seed();
    this.cameraModel.setPhotoResultListener((result: CameraPhotoResult): void => {
      this.cameraBusy = false;
      const evidenceId: string = this.pendingFallEvidenceId;
      const pcFile: string = this.pendingPcEvidenceFile;
      this.pendingFallEvidenceId = '';
      this.pendingPcEvidenceFile = '';
      if (result.success) {
        if (evidenceId.length > 0) {
          const pcHint: string = pcFile.length > 0 ? ` · PC触发帧 ${pcFile}` : '';
          this.cameraPhotoText = `跌倒证据已保存 ${result.fileName} · ${Math.round(result.bytes / 1024)} KB${pcHint}`;
        } else {
          this.cameraPhotoText = `已保存 ${result.fileName} · ${Math.round(result.bytes / 1024)} KB`;
        }
      } else {
        this.cameraPhotoText = evidenceId.length > 0 ?
          (pcFile.length > 0 ? `跌倒事件 ${evidenceId}：本机照片保存失败，PC触发帧仍保留` :
            `跌倒事件 ${evidenceId}：本机照片保存失败，未确认PC取证成功`) : '拍照保存失败';
      }
    });
    this.visionStreamer.setStatusListener((status: VisionStreamStatus): void => {
      this.cameraVisionConnected = status.connected;
      this.cameraVisionFall = status.fallDetected;
      if (status.fallEventId !== undefined && status.fallEventId.length > 0 &&
        status.fallEventId !== this.lastAutoEvidenceId) {
        this.lastAutoEvidenceId = status.fallEventId;
        this.captureFallEvidence(
          status.fallEventId,
          status.evidenceSaved === true,
          status.evidenceFile === undefined ? '' : status.evidenceFile
        );
      }
      if (!status.running) {
        this.cameraVisionText = '人体检测已停止';
      } else if (status.connected) {
        let resultText: string = '';
        if (status.orientationState === 'refused') {
          resultText = '方向校准失败，跌倒检测已停用';
        } else if (status.orientationState === 'suspended') {
          resultText = '画面方向异常，跌倒检测已暂停';
        } else if (status.orientationState === 'calibrating') {
          resultText = '正在校准画面方向，跌倒检测暂未启用';
        } else {
          resultText = status.fallDetected ? '疑似跌倒' :
            (status.personDetected ? '检测到人体' : '未检测到人体');
        }
        this.cameraVisionText = `${resultText} · ${status.framesSent} 帧 · ${status.lastLatencyMs} ms`;
      } else if (status.framesFailed > 0) {
        this.cameraVisionText = `人体检测未连接 · 重试 ${status.framesFailed}`;
      } else {
        this.cameraVisionText = '正在连接人体检测…';
      }
    });
    this.diag = '发现节点中…';
    for (let i = 0; i < PORTS.length; i++) {
      this.openLink(PORTS[i]);
    }
    this.startVideoStreamServer();
    this.timerId = setInterval(() => {
      this.tick = this.tick + 1;
      /* 闭环超时保护：8 秒未收到设备确认 → 保留"待处理"并提示，绝不假装已闭环 */
      if (this.pendingAckId.length > 0 && Date.now() - this.pendingSince > 8000) {
        this.pendingAckId = '';
        this.pendingDeviceId = '';
        this.pendingAction = '';
        this.ackHint = '✗ 8 秒内未收到设备确认，请检查节点后重试';
      }
      /* 超时离线判定：检查所有设备快照的 lastSeenMs，超过 DEVICE_STALE_MS 则标记离线 */
      this.checkDeviceStale();
    }, TIMER_INTERVAL_MS);
    this.scheduleCameraGuardStart(0);
  }

  aboutToDisappear(): void {
    this.cameraPageActive = false;
    this.videoStreamServer.stop();
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    context.eventHub.off(GUARD_FOREGROUND_EVENT, this.abilityForegroundListener);
    if (this.timerId !== -1) {
      clearInterval(this.timerId);
      this.timerId = -1;
    }
    this.stopCameraGuardRuntime('监护随页面退出暂停');
  }

  private onCameraSurfaceReady(): void {
    this.cameraSurfaceId = this.cameraController.getXComponentSurfaceId();
    console.info(`[Index] camera surface ready idLength=${this.cameraSurfaceId.length}`);
    this.cameraStatusText = this.cameraGuardEnabled ? '自动监护准备中' : '监护已暂停';
    this.scheduleCameraGuardStart(0);
  }

  /**
   * 启动手机远程视频探望的板端取帧服务。
   * 服务只监听本机回环；没有观看者时不取帧、不编码、不发帧。
   * 启动失败不影响相机预览与监护主链路。
   */
  private startVideoStreamServer(): void {
    this.videoStreamServer.setStatusListener((status: VideoStreamStatus): void => {
      if (status.streaming) {
        this.videoVisitText = `远程探望：推流中 · ${status.framesSent} 帧 · ${status.lastFps} fps`;
      } else if (status.clientConnected) {
        this.videoVisitText = '远程探望：观看者已连接，等待开始';
      } else if (status.serverListening) {
        this.videoVisitText = '远程探望：就绪（无观看者）';
      } else {
        this.videoVisitText = status.lastError.length > 0 ?
          `远程探望：未就绪（${status.lastError}）` : '远程探望：未就绪';
      }
    });
    this.videoStreamServer.start(() => this.cameraSurfaceId, () => this.cameraPreviewActive)
      .then((): void => {
        console.info('[Index] video stream server start attempted');
      })
      .catch((err: BusinessError): void => {
        console.warn(`[Index] video stream server start failed: ${err.code}`);
      });
  }

  private async loadPreviewTuning(context: common.UIAbilityContext): Promise<void> {
    const settings: PreviewTuningSettings = await PreviewTuningStore.load(context);
    this.cameraPreviewWidthPct = settings.widthPct;
    this.cameraPreviewScalePct = settings.scalePct;
  }

  private async savePreviewTuning(): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    await PreviewTuningStore.save(context, {
      widthPct: this.cameraPreviewWidthPct,
      scalePct: this.cameraPreviewScalePct
    });
  }

  private changePreviewWidth(delta: number): void {
    const next: number = Math.max(30, Math.min(90, this.cameraPreviewWidthPct + delta));
    if (next === this.cameraPreviewWidthPct) {
      return;
    }
    this.cameraPreviewWidthPct = next;
    void this.savePreviewTuning();
  }

  private changePreviewScale(delta: number): void {
    const next: number = Math.max(70, Math.min(160, this.cameraPreviewScalePct + delta));
    if (next === this.cameraPreviewScalePct) {
      return;
    }
    this.cameraPreviewScalePct = next;
    void this.savePreviewTuning();
  }

  private resetPreviewTuning(): void {
    this.cameraPreviewWidthPct = 60;
    this.cameraPreviewScalePct = 130;
    void this.savePreviewTuning();
  }

  /**
   * 无人查看时的持续监护：监护运行期间保持屏幕常亮。
   *
   * 背景（本轮真机实测）：DAYU200 / API 26 没有相机后台模式；息屏或切到后台会让系统把
   * Ability 置为 BACKGROUND，Camera 被释放、送帧停止（PC 侧 watchdog 随即报 monitor offline）。
   * 监护人不需要看预览画面，但设备不能自动熄屏 —— 否则"无人查看的持续监护"会在一次息屏后失效。
   * 该调用失败不影响监护主链路（仅告警），也不改变任何告警/证据语义。
   */
  private async applyGuardScreenLock(on: boolean): Promise<void> {
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const win: window.Window = await window.getLastWindow(context);
      await win.setWindowKeepScreenOn(on);
    } catch (error) {
      console.warn('[Index] setWindowKeepScreenOn failed');
    }
  }

  private scheduleCameraGuardStart(delayMs: number): void {
    if (!this.cameraGuardEnabled || !this.cameraPageActive || !this.cameraAbilityForeground ||
      this.cameraPreviewActive ||
      this.cameraBusy || this.cameraSurfaceId.length === 0 || this.cameraRetryTimerId !== -1) {
      return;
    }
    this.cameraRetryTimerId = setTimeout(() => {
      this.cameraRetryTimerId = -1;
      this.startCameraGuard();
    }, delayMs);
  }

  private clearCameraRetry(): void {
    if (this.cameraRetryTimerId !== -1) {
      clearTimeout(this.cameraRetryTimerId);
      this.cameraRetryTimerId = -1;
    }
  }

  private async startCameraGuard(): Promise<void> {
    if (!this.cameraGuardEnabled || !this.cameraPageActive || !this.cameraAbilityForeground ||
      this.cameraBusy || this.cameraPreviewActive) {
      return;
    }
    if (this.cameraSurfaceId.length === 0) {
      this.cameraStatusText = '监护画布未就绪';
      return;
    }

    const generation: number = this.cameraStartGeneration;
    this.cameraBusy = true;
    this.cameraStatusText = '正在启动自动监护…';
    this.cameraPhotoText = '';
    let retryNeeded: boolean = false;
    let slowRecoveryNeeded: boolean = false;
    let cancelledStart: boolean = false;
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const summary: CameraPreviewSummary = await this.cameraModel.startPreview(context, this.cameraSurfaceId);
      if (generation !== this.cameraStartGeneration || !this.cameraGuardEnabled || !this.cameraPageActive ||
        !this.cameraAbilityForeground ||
        this.cameraSurfaceId.length === 0) {
        cancelledStart = true;
        await this.cameraModel.release();
        return;
      }
      if (!summary.available) {
        if (summary.error === 'Permission denied') {
          this.cameraStatusText = '相机未授权，自动监护未运行';
        } else {
          retryNeeded = this.cameraRetryCount < CAMERA_GUARD_MAX_RETRIES;
          slowRecoveryNeeded = !retryNeeded;
          this.cameraStatusText = retryNeeded ? '自动监护启动失败，准备重试' :
            '自动监护暂时不可用，稍后重试';
        }
        return;
      }
      this.cameraPreviewActive = true;
      this.cameraPhotoAvailable = summary.photoAvailable;
      this.cameraRetryCount = 0;
      this.cameraStatusText = `监护运行中 · ${summary.position} · ${summary.width}×${summary.height}`;
      this.visionStreamer.start(this.cameraSurfaceId);
      void this.applyGuardScreenLock(true);      // 监护运行期间禁止自动熄屏
      if (!summary.photoAvailable) {
        this.cameraPhotoText = '当前相机不支持拍照输出';
      }
    } catch (error) {
      retryNeeded = this.cameraRetryCount < CAMERA_GUARD_MAX_RETRIES;
      slowRecoveryNeeded = !retryNeeded;
      this.cameraStatusText = retryNeeded ? '自动监护启动异常，准备重试' :
        '自动监护暂时不可用，稍后重试';
    } finally {
      this.cameraBusy = false;
      if (retryNeeded && this.cameraGuardEnabled && this.cameraPageActive && this.cameraAbilityForeground) {
        this.cameraRetryCount = this.cameraRetryCount + 1;
        this.scheduleCameraGuardStart(CAMERA_GUARD_RETRY_MS);
      } else if (slowRecoveryNeeded && this.cameraGuardEnabled && this.cameraPageActive &&
        this.cameraAbilityForeground) {
        this.cameraRetryCount = 0;
        this.scheduleCameraGuardStart(CAMERA_GUARD_RECOVERY_MS);
      } else if (cancelledStart && this.cameraGuardEnabled && this.cameraPageActive &&
        this.cameraAbilityForeground && !this.cameraPreviewActive) {
        this.scheduleCameraGuardStart(0);
      }
    }
  }

  private stopCameraGuardRuntime(statusText: string): void {
    this.cameraStartGeneration = this.cameraStartGeneration + 1;
    this.clearCameraRetry();
    this.visionStreamer.stop();
    this.cameraModel.release();
    void this.applyGuardScreenLock(false);     // 监护停止后立即恢复系统息屏策略
    this.cameraPreviewActive = false;
    this.cameraPhotoAvailable = false;
    this.cameraStatusText = statusText;
    this.cameraVisionText = '自动监护已停止';
    this.cameraVisionConnected = false;
    this.cameraVisionFall = false;
  }

  private pauseCameraGuard(): void {
    if (!this.cameraGuardEnabled) {
      return;
    }
    this.cameraGuardEnabled = false;
    this.cameraRetryCount = 0;
    this.stopCameraGuardRuntime('监护已暂停');
  }

  private resumeCameraGuard(): void {
    if (this.cameraBusy || this.cameraGuardEnabled) {
      return;
    }
    this.cameraGuardEnabled = true;
    this.cameraRetryCount = 0;
    this.cameraStatusText = '自动监护准备中';
    this.cameraVisionText = '正在启动人体检测…';
    this.scheduleCameraGuardStart(0);
  }

  private onCameraSurfaceDestroyed(): void {
    console.info('[Index] camera surface destroyed');
    this.cameraSurfaceId = '';
    this.cameraRetryCount = 0;
    this.stopCameraGuardRuntime(this.cameraGuardEnabled ? '监护画布已销毁' : '监护已暂停');
  }

  private async takeCameraPhoto(): Promise<void> {
    if (this.cameraBusy || !this.cameraPreviewActive || !this.cameraPhotoAvailable) {
      return;
    }
    this.cameraBusy = true;
    this.cameraPhotoText = '正在拍照…';
    const accepted: boolean = await this.cameraModel.takePhoto();
    if (!accepted) {
      this.cameraBusy = false;
      this.cameraPhotoText = '拍照请求失败';
    }
  }

  private async captureFallEvidence(evidenceId: string, pcSaved: boolean, pcFile: string): Promise<void> {
    this.pendingFallEvidenceId = evidenceId;
    this.pendingPcEvidenceFile = pcSaved ? pcFile : '';
    if (!this.cameraPreviewActive || !this.cameraPhotoAvailable) {
      this.pendingFallEvidenceId = '';
      this.pendingPcEvidenceFile = '';
      this.cameraPhotoText = pcSaved ? `跌倒触发帧已保存到PC · ${pcFile}` :
        `跌倒事件 ${evidenceId}：当前相机不支持自动拍照`;
      return;
    }
    if (this.cameraBusy) {
      this.cameraPhotoText = '检测到疑似跌倒，当前拍照完成后自动归入证据';
      return;
    }
    this.cameraBusy = true;
    this.cameraPhotoText = '检测到疑似跌倒，正在自动保存证据…';
    const accepted: boolean = await this.cameraModel.takePhoto();
    if (!accepted) {
      this.cameraBusy = false;
      this.pendingFallEvidenceId = '';
      this.pendingPcEvidenceFile = '';
      this.cameraPhotoText = pcSaved ? `自动拍照请求失败，PC触发帧已保存 · ${pcFile}` :
        `跌倒事件 ${evidenceId}：证据保存失败`;
    }
  }

  /** 连接一个候选端口（连不上就重试；连上后由报文告知自己是哪个设备） */
  private openLink(port: number): void {
    const link: Link = {
      sock: null,
      buf: '',
      port: port,
      connected: false,
      retrying: false,
      deviceIds: []
    };
    try {
      const tcp: socket.TCPSocket = socket.constructTCPSocketInstance();
      link.sock = tcp;
      this.links.push(link);

      tcp.on('message', (info: socket.SocketMessageInfo) => {
        try {
          const text: string = buffer.from(info.message).toString('utf8');
          this.consume(link, text);
        } catch (e) {
          console.error('[UI-Link] 报文解码失败');
        }
      });
      tcp.on('close', () => {
        link.connected = false;
        this.markOffline(link);
        this.retryOpen(link);
      });
      tcp.on('error', () => {
        link.connected = false;
        this.markOffline(link);
        this.retryOpen(link);
      });

      const addr: socket.NetAddress = { address: '127.0.0.1', port: port };
      tcp.connect({ address: addr, timeout: 3000 })
        .then(() => {
          link.connected = true;
          console.info('[UI-Link] 已连接端口 ' + port);
          this.refreshDiag();
        })
        .catch((err: BusinessError) => {
          this.retryOpen(link);
        });
    } catch (e) {
      this.retryOpen(link);
    }
  }

  private retryOpen(link: Link): void {
    /* ⚠ 防连接风暴：error / close / connect.catch 三处都会调到这里，
       若不设闸就会同时排多个重连任务，把主线程占满
       （OH 7.0 实测会拖垮同进程的语音 Ability → LIFECYCLE_TIMEOUT）。 */
    if (link.retrying) return;
    link.retrying = true;
    setTimeout(() => {
      const sk = link.sock;
      if (sk !== null) {
        try {
          sk.off('message');
          sk.off('close');
          sk.off('error');
        } catch (e) {
          // 忽略
        }
        try {
          sk.close();
        } catch (e) {
          // 忽略
        }
      }
      const idx: number = this.links.indexOf(link);
      if (idx >= 0) {
        this.links.splice(idx, 1);
      }
      this.openLink(link.port);
    }, 15000);                            // 15 秒一次：够用且不挤占主线程
  }

  private markOffline(link: Link): void {
    /* 该连接上见过的所有设备（含 relay 注入的无线节点）一并离线 */
    for (let i = 0; i < link.deviceIds.length; i++) {
      const dev: string = link.deviceIds[i];
      const s = this.snaps.get(dev);
      if (s !== undefined) {
        s.online = false;
        if (dev === this.selectedId) {
          this.applySnap(s);                // 刷新当前选中设备（含 liveOnline）
        }
      }
    }
    this.refreshDiag();
  }

  /** 超时离线检查：遍历所有快照，超过 DEVICE_STALE_MS 未收到状态则标记离线 */
  private checkDeviceStale(): void {
    const now: number = Date.now();
    this.snaps.forEach((snap: DevSnap, devId: string) => {
      if (snap.online && now - snap.lastSeenMs > DEVICE_STALE_MS) {
        snap.online = false;
        if (devId === this.selectedId) {
          this.liveOnline = false;          // 当前选中设备离线 → 立即刷新界面
        }
      }
    });
    this.refreshDiag();
  }

  private countOnline(): number {
    /* 按“设备快照”统计，而不是按 TCP 连接数：一个连接可承载多个 relay 节点 */
    let n: number = 0;
    this.snaps.forEach((s: DevSnap) => {
      if (s.online) {
        n = n + 1;
      }
    });
    return n;
  }

  private refreshDiag(): void {
    this.diag = `${this.selectedLabel()} · 全屋在线 ${this.countOnline()}/${this.deviceIds.length} 台设备`;
  }

  private selectedCapability(): DeviceCapability {
    return DeviceCapabilities.forDevice(this.selectedId);
  }

  private hasMotionCapability(): boolean {
    return this.selectedCapability().motion;
  }

  private hasDoorCapability(): boolean {
    return this.selectedCapability().door;
  }

  private hasClimateCapability(): boolean {
    return this.selectedCapability().climate;
  }

  private hasGasCapability(): boolean {
    return this.selectedCapability().gas;
  }

  private hasSmokeCapability(): boolean {
    return this.selectedCapability().smoke;
  }

  private capabilityKnown(): boolean {
    return this.selectedCapability().known;
  }

  private climateValueText(isTemp: boolean): string {
    if (!this.hasClimateCapability()) return '未配置';
    if (!this.liveClimateValidKnown) return '待确认';
    if (!this.liveClimateValid) return '读取无效';
    return isTemp ? `${this.liveTempC.toFixed(1)} ℃` : `${this.liveRh.toFixed(1)} %`;
  }

  private climateHintText(): string {
    if (!this.hasClimateCapability()) return '该设备未配置温湿度接口';
    if (!this.liveClimateValidKnown) return '温湿度有效性未知，不显示为正常';
    if (!this.liveClimateValid) return '本次温湿度读取无效，暂不可用';
    return this.liveClimateOk ? '环境舒适度正常' : '温湿度超出阈值，已触发预警';
  }

  private gasStatusText(): string {
    const cap: DeviceCapability = this.selectedCapability();
    if (!cap.gas) return '未配置';
    if (!cap.mqAlarmEnabled) return `原始 ADC ${this.liveGasRaw} · 报警未启用`;
    if (this.liveGasValidKnown && !this.liveGasValid) return `读取无效 · ADC ${this.liveGasRaw}`;
    return this.liveGasOk ? '正常' : '超限';
  }

  private smokeStatusText(): string {
    const cap: DeviceCapability = this.selectedCapability();
    if (!cap.smoke) return '未配置';
    if (!cap.mqAlarmEnabled) return `原始 ADC ${this.liveSmokeRaw} · 报警未启用`;
    if (this.liveSmokeValidKnown && !this.liveSmokeValid) return `读取无效 · ADC ${this.liveSmokeRaw}`;
    return this.liveSmokeOk ? '正常' : '超限';
  }

  private climateValueColor(): string {
    if (!this.hasClimateCapability() || !this.liveClimateValidKnown || !this.liveClimateValid) {
      return '#888888';
    }
    return this.liveClimateOk ? '#333333' : '#E6453C';
  }

  /** 按行解析节点推送的 JSON */
  private consume(link: Link, text: string): void {
    link.buf += text;
    let idx: number = link.buf.indexOf('\n');
    while (idx >= 0) {
      const line: string = link.buf.substring(0, idx).trim();
      link.buf = link.buf.substring(idx + 1);
      if (line.length > 0) {
        this.applyLine(link, line);
      }
      idx = link.buf.indexOf('\n');
    }
  }

  private applyLine(link: Link, line: string): void {
    let o: NodeMsg;
    try {
      o = JSON.parse(line) as NodeMsg;
    } catch (e) {
      return;
    }
    const dev: string = o.deviceId;
    if (typeof dev !== 'string' || !DEVICE_ID_RE.test(dev)) {
      return;                               // 非法 deviceId 直接丢弃，不污染 routes/order
    }
    // 正式身份已经出现后，忽略迟到或残留进程发来的旧别名状态，
    // 否则旧节点会在下一条报文中重新进入 order，双客厅随即复发。
    if (LEGACY_DEVICE_IDS.indexOf(dev) >= 0 &&
      (this.order.indexOf(CANONICAL_LIVING_DEVICE_ID) >= 0 || this.snaps.has(CANONICAL_LIVING_DEVICE_ID))) {
      console.info('[Index] ignored stale legacy device id: ' + dev);
      return;
    }
    this.routes.set(dev, link.port);        // 记下该设备的回程连接
    if (link.deviceIds.indexOf(dev) < 0) {
      link.deviceIds.push(dev);             // 登记该连接承载的设备（去重）
    }
    if (this.order.indexOf(dev) < 0) {
      this.order.push(dev);                 // 新发现一个节点
    }
    // 旧身份迁移：收到正式客厅身份后，移除本地历史别名，避免出现两个"客厅"节点
    if (dev === CANONICAL_LIVING_DEVICE_ID) {
      for (let i = 0; i < LEGACY_DEVICE_IDS.length; i++) {
        this.dropLegacyDevice(LEGACY_DEVICE_IDS[i]);
      }
    }
    const snap: DevSnap = this.toSnap(dev, o);
    // 注意：toSnap 内部已把上一份告警并入（保留本地闭环状态），此处不要再覆盖
    this.snaps.set(dev, snap);
    this.refreshDeviceList();

    // 每份设备快照都先尝试结算（内部按 pendingDeviceId + pendingAckId 双重匹配），
    // 否则下发后切换房间，原设备的 ACKED 回传将永远无法结算
    this.settlePending(snap);
    if (this.selectedId.length === 0) {
      this.selectedId = dev;                // 默认选中第一个发现的节点
      this.applySnap(snap);
    } else if (this.selectedId === dev) {
      this.applySnap(snap);                 // 当前选中节点 → 刷新界面
    }
    this.refreshDiag();
  }

  private toSnap(dev: string, o: NodeMsg): DevSnap {
    const hist: number[] = o.history;
    const slots: number[] = o.slots;
    const monRaw: number | undefined = o.monitorOnline;
    const snap: DevSnap = {
      id: dev,
      room: o.room !== undefined && o.room.length > 0 ? o.room : dev,
      state: o.state,
      count: o.sensors.motion.countToday,
      lastActiveTs: o.sensors.motion.lastActiveTs,
      doorOpen: o.sensors.door.open,
      doorLastOpenTs: o.sensors.door.lastOpenTs,
      tempC: o.sensors.climate.tempC,
      rh: o.sensors.climate.rh,
      climateOk: o.sensors.climate.ok,
      climateValid: o.sensors.climate.valid === true,
      climateValidKnown: o.sensors.climate.valid !== undefined,
      gasOk: o.sensors.gas.ok,
      smokeOk: o.sensors.smoke.ok,
      gasRaw: o.sensors.gas.raw,
      smokeRaw: o.sensors.smoke.raw,
      gasValid: o.sensors.gas.valid === true,
      gasValidKnown: o.sensors.gas.valid !== undefined,
      smokeValid: o.sensors.smoke.valid === true,
      smokeValidKnown: o.sensors.smoke.valid !== undefined,
      history: hist !== undefined ? hist : [0, 0, 0, 0, 0, 0, 0],
      slots: slots !== undefined ? slots : [0, 0, 0, 0],
      alarmCount: o.alarm.countToday,
      alarms: [],
      online: true,
      lastSeenMs: Date.now(),  // 记录本地接收时间，用于超时判定
      monitorOnline: monRaw === undefined ? -1 : monRaw
    };
    const aid: string = o.alarm.id;
    if (aid !== undefined && aid.length > 0) {
      const type: string = o.alarm.type;
      const list: AlarmItem[] = [];
      let exists: boolean = false;
      const prev = this.snaps.get(dev);
      if (prev !== undefined) {
        for (let i = 0; i < prev.alarms.length; i++) {
          list.push(prev.alarms[i]);
          if (prev.alarms[i].id === aid) {
            exists = true;
          }
        }
      }
      if (!exists) {
        list.unshift({
          id: aid, type: type, level: 'ALARM', startTs: Date.now(),
          detail: DeviceStore.alarmDetailText(type), acked: false, action: '', ackTs: 0
        });
      }
      snap.alarms = list;
    }
    return snap;
  }

  private refreshDeviceList(): void {
    const ids: string[] = [];
    const labels: string[] = [];
    for (let i = 0; i < this.order.length; i++) {
      ids.push(this.order[i]);
      const s = this.snaps.get(this.order[i]);
      labels.push(s !== undefined ? s.room : this.order[i]);
    }
    /* 同名房间去重：多个节点房间名完全相同时追加设备后缀，避免出现两个无法区分的标签 */
    const counts: Map<string, number> = new Map<string, number>();
    for (let i = 0; i < labels.length; i++) {
      const key: string = labels[i];
      const prev: number | undefined = counts.get(key);
      counts.set(key, prev === undefined ? 1 : prev + 1);
    }
    const finalLabels: string[] = [];
    for (let i = 0; i < labels.length; i++) {
      const key: string = labels[i];
      const total: number | undefined = counts.get(key);
      finalLabels.push(total !== undefined && total > 1 ? key + '·' + ids[i] : key);
    }
    this.deviceIds = ids;
    this.deviceLabels = finalLabels;
  }

  /** 摄像头物理归属固定为客厅节点：只有选中它时才显示画面与操作 */
  private hasCameraSelected(): boolean {
    return this.selectedId === CAMERA_OWNER_DEVICE_ID;
  }

  /** 移除历史别名设备的本地痕迹（快照/顺序/路由/连接登记），必要时迁移选中项 */
  private dropLegacyDevice(alias: string): void {
    if (alias.length === 0 || alias === CANONICAL_LIVING_DEVICE_ID) {
      return;
    }
    const known: boolean = this.order.indexOf(alias) >= 0 || this.snaps.has(alias) ||
      this.routes.has(alias) || this.selectedId === alias;
    this.order = this.order.filter((id: string): boolean => id !== alias);
    this.snaps.delete(alias);
    this.routes.delete(alias);
    for (let i = 0; i < this.links.length; i++) {
      const ids: string[] = this.links[i].deviceIds;
      const pos: number = ids.indexOf(alias);
      if (pos >= 0) {
        ids.splice(pos, 1);
      }
    }
    if (this.selectedId === alias) {
      this.selectedId = CANONICAL_LIVING_DEVICE_ID;   // 当前选中旧别名 -> 自动切到正式身份
    }
    if (known) {
      console.info('[Index] legacy device id migrated: ' + alias + ' -> ' + CANONICAL_LIVING_DEVICE_ID);
    }
  }

  private selectedLabel(): string {
    const s = this.snaps.get(this.selectedId);
    return s !== undefined ? s.room : '-';
  }

  private selectDevice(id: string): void {
    this.selectedId = id;
    this.ackHint = '';   // 切换设备后不保留上一台设备的闭环提示，避免误读
    const s = this.snaps.get(id);
    if (s !== undefined) {
      this.applySnap(s);
    }
    this.refreshDiag();
  }

  /** 把某个节点的快照写入页面 @State（唯一的数据出口） */
  private applySnap(s: DevSnap): void {
    this.liveRoom = s.room;
    this.liveState = s.state;
    this.liveOnline = s.online;
    this.liveMonitorOnline = s.monitorOnline;
    this.liveCount = s.count;
    this.liveLastActiveTs = s.lastActiveTs;
    this.liveDoorOpen = s.doorOpen;
    this.liveDoorLastOpenTs = s.doorLastOpenTs;
    this.liveTempC = s.tempC;
    this.liveRh = s.rh;
    this.liveClimateOk = s.climateOk;
    this.liveClimateValid = s.climateValid;
    this.liveClimateValidKnown = s.climateValidKnown;
    this.liveGasOk = s.gasOk;
    this.liveSmokeOk = s.smokeOk;
    this.liveGasRaw = s.gasRaw;
    this.liveSmokeRaw = s.smokeRaw;
    this.liveGasValid = s.gasValid;
    this.liveGasValidKnown = s.gasValidKnown;
    this.liveSmokeValid = s.smokeValid;
    this.liveSmokeValidKnown = s.smokeValidKnown;
    this.liveHistory = s.history.slice();
    this.liveSlots = s.slots.slice();
    this.liveAlarmCount = s.alarmCount;
    this.liveAlarms = s.alarms.slice();
  }

  /** 事件闭环：**先下发、等设备确认后才置为已闭环**（避免界面假闭环）
   *  设备侧会核对告警 ID 并回状态 ACKED；超时则保留"待处理"并提示。 */
  private doAck(id: string): void {
    if (this.sending) {
      this.ackHint = '正在下发，请稍候…';
      return;
    }
    if (this.pendingAckId.length > 0) {
      this.ackHint = '上一条告警正在等待设备确认，请等待确认或超时后再下发';
      return;
    }
    /* ⚠ CR/LF 压成空格：防止文本框输入拼出第二条命令（命令按行解析） */
    const rawAction: string = this.ackText.length > 0 ? this.ackText : '已确认，老人一切正常';
    const action: string = rawAction.replace(/[\r\n]+/g, ' ').trim() || '已确认，老人一切正常';
    const target: string = this.selectedId;      // 锁定本次下发目标设备
    if (!DEVICE_ID_RE.test(target)) {
      this.ackHint = '✗ 设备 ID 非法，确认未下发';
      return;                                    // 防止 deviceId 拼出额外命令/字段
    }
    /* 按"该设备状态从哪条连接到达"选路：relay 注入的无线节点与网关共用连接，
       不能用连接上最后一条报文的 deviceId 判断（会被复用状态覆盖） */
    const port: number | undefined = this.routes.get(target);
    const snap: DevSnap | undefined = this.snaps.get(target);
    let lk: Link | null = null;
    if (port !== undefined) {
      for (let i = 0; i < this.links.length; i++) {
        if (this.links[i].port === port) {
          lk = this.links[i];
          break;
        }
      }
    }
    if (target.length === 0 || port === undefined || lk === null) {
      this.ackHint = '✗ 该节点没有可用路由，确认未下发（请等待节点上报后重试）';
      return;
    }
    const sk: socket.TCPSocket | null = lk.sock;
    if (!lk.connected || sk === null || (snap !== undefined && !snap.online)) {
      this.ackHint = '✗ 该节点不在线，确认未下发（请检查连接后重试）';
      return;
    }
    this.sending = true;
    sk.send({ data: `route ${target} ack ${id} ${action}\n` })
      .then(() => {
        /* ⚠ 只有发送真正成功才进入等待态（否则要白等 8 秒超时） */
        this.sending = false;
        this.pendingAckId = id;
        this.pendingDeviceId = target;
        this.pendingAction = action;
        this.pendingSince = Date.now();
        this.ackHint = '已下发，等待设备确认…';
        console.info('[UI] 已下发闭环到 ' + target);
      })
      .catch((err: BusinessError) => {
        /* 立即反馈失败，不进入等待态 */
        this.sending = false;
        if (this.pendingAckId === id && this.pendingDeviceId === target) {
          this.pendingAckId = '';                // 仅清理本次目标的等待态，不误清其他设备的 pending
          this.pendingDeviceId = '';
          this.pendingAction = '';
        }
        this.ackHint = '✗ 下发失败：' + err.message + '（未闭环，请重试）';
        console.error('[UI] 下发失败: ' + err.message);
      });
    this.ackText = '';
  }

  /** 告警行"确认中"：告警 ID 与下发目标设备都须匹配当前设备（不同设备可能出现同名告警 ID） */
  private isConfirming(alarmId: string): boolean {
    return this.pendingAckId.length > 0 && this.pendingAckId === alarmId &&
      this.pendingDeviceId === this.selectedId;
  }

  /** 设备回传的状态里若为 ACKED，且**设备与告警都匹配**，才真正置为已闭环 */
  private settlePending(s: DevSnap): void {
    if (this.pendingAckId.length === 0) return;
    if (s.id !== this.pendingDeviceId) return;   // 不是当初下发的那台设备 → 不结算
    if (s.state !== 'ACKED') return;

    let hit: boolean = false;
    const kept: AlarmItem[] = [];
    for (let i = 0; i < s.alarms.length; i++) {
      const a: AlarmItem = s.alarms[i];
      if (a.id === this.pendingAckId) {
        hit = true;
        kept.push({
          id: a.id, type: a.type, level: a.level, startTs: a.startTs, detail: a.detail,
          acked: true, action: this.pendingAction, ackTs: Date.now()
        });
      } else {
        kept.push(a);
      }
    }
    if (!hit) return;                                  // 没找到对应告警 → 保持等待（等超时提示）
    s.alarms = kept;
    console.info('[UI] 设备 ' + s.id + ' 已确认闭环：' + this.pendingAckId);
    this.pendingAckId = '';
    this.pendingDeviceId = '';
    this.pendingAction = '';
    this.ackHint = '✓ 设备已确认，闭环完成';
  }

  private stateLabel(): string {
    if (this.liveState === 'ALARM') return '异常告警';
    if (this.liveState === 'WARN') return '需要关注';
    if (this.liveState === 'ACKED') return '已确认处理';
    return '一切正常';
  }

  /** PC 侧监护链路（watchdog）状态文案：失联时才提示，未上报不误报 */
  private monitorLabel(): string {
    if (this.liveMonitorOnline === 0) return 'PC 监护失联：未持续收到摄像头帧';
    if (this.liveMonitorOnline === 1) return 'PC 监护在线';
    return 'PC 监护状态未上报';
  }

  private stateBg(): string {
    if (this.liveState === 'ALARM') return '#E64545';
    if (this.liveState === 'WARN') return '#E6A23C';
    if (this.liveState === 'ACKED') return '#3F7DE6';
    return '#37B24D';
  }

  private trendText(): string {
    const today: number = this.liveHistory.length > 6 ? this.liveHistory[6] : 0;
    const yest: number = this.liveHistory.length > 5 ? this.liveHistory[5] : 0;
    if (yest <= 0) {
      return `今日活动 ${today} 次（昨日数据积累中）`;
    }
    const diff: number = yest - today;
    const pct: number = Math.round(Math.abs(diff) * 100 / yest);
    if (pct < 5) {
      return `今日活动频次 ${today} 次，与昨日基本持平`;
    }
    if (diff > 0) {
      return `今日活动频次较昨日下降 ${pct}%（${today} 次 / 昨日 ${yest} 次）`;
    }
    return `今日活动频次较昨日上升 ${pct}%（${today} 次 / 昨日 ${yest} 次）`;
  }

  private maxHist(): number {
    let m: number = 1;
    for (let i = 0; i < this.liveHistory.length; i++) {
      if (this.liveHistory[i] > m) {
        m = this.liveHistory[i];
      }
    }
    return m;
  }

  private dayLabel(i: number): string {
    if (i === 6) return '今天';
    if (i === 5) return '昨天';
    return `前${6 - i}天`;
  }

  private slotMax(): number {
    let m: number = 1;
    for (let i = 0; i < this.liveSlots.length; i++) {
      if (this.liveSlots[i] > m) {
        m = this.liveSlots[i];
      }
    }
    return m;
  }

  private slotWidth(idx: number): string {
    const v: number = this.liveSlots.length > idx ? this.liveSlots[idx] : 0;
    const w: number = Math.round(v * 100 / this.slotMax());
    return `${w < 4 ? 4 : w}%`;
  }

  private ackedCount(): number {
    let n: number = 0;
    for (let i = 0; i < this.liveAlarms.length; i++) {
      if (this.liveAlarms[i].acked) {
        n = n + 1;
      }
    }
    return n;
  }

  @Builder
  tabBuilder(title: string, index: number) {
    Column() {
      Text(title)
        .fontSize(16)
        .fontWeight(this.current === index ? FontWeight.Bold : FontWeight.Normal)
        .fontColor(this.current === index ? '#3F7DE6' : '#666666')
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  build() {
    Column() {
      Row() {
        Column() {
          Text('居家安全监护').fontSize(20).fontWeight(FontWeight.Bold)
          Text(`${this.liveRoom} · 已选设备${this.liveOnline ? '在线' : '离线'} · ${this.selectedId}`)
            .fontSize(12).fontColor('#888888').margin({ top: 4 })
          Text(this.diag).fontSize(11).fontColor('#AAAAAA').margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Text(this.stateLabel())
          .fontSize(14).fontColor(Color.White)
          .backgroundColor(this.stateBg())
          .borderRadius(12).padding({ left: 12, right: 12, top: 4, bottom: 4 })
      }
      .width('100%').padding({ left: 16, right: 16, top: 16, bottom: 8 })

      /* 设备切换（多房间）：每个节点一个标签 */
      Row({ space: 8 }) {
        ForEach(this.deviceIds, (id: string, idx: number) => {
          Text(this.deviceLabels[idx])
            .fontSize(13)
            .fontColor(this.selectedId === id ? Color.White : '#555555')
            .backgroundColor(this.selectedId === id ? '#3F7DE6' : '#FFFFFF')
            .borderRadius(14)
            .padding({ left: 14, right: 14, top: 6, bottom: 6 })
            .onClick(() => { this.selectDevice(id); })
        }, (id: string, idx: number) => `${id}-${this.selectedId === id}`)
        if (this.deviceIds.length === 0) {
          Text('未发现节点').fontSize(13).fontColor('#999999')
        }
      }
      .width('100%').padding({ left: 16, right: 16, bottom: 4 })

      /* 离线时必须明确“以下为上一次上报的历史读数”，不把旧值当当前状态 */
      if (this.selectedId.length > 0 && !this.liveOnline) {
        Row() {
          Text('已选设备离线：以下为最后一次上报的历史读数，不代表当前状态')
            .fontSize(12).fontColor('#B26A00').width('100%')
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 6, bottom: 6 })
        .backgroundColor('#FFF4E5')
        .borderRadius(8)
        .margin({ left: 16, right: 16, bottom: 4 })
      }

      /* 实时数据条：必须内联直接引用 @State；能力按 deviceId 过滤 */
      Row({ space: 8 }) {
        if (this.hasMotionCapability()) {
          Column() {
            Text('今日活动').fontSize(12).fontColor('#888888')
            Text(`${this.liveCount} 次`).fontSize(18).fontWeight(FontWeight.Bold).margin({ top: 4 })
          }.liveCardStyle()
        }
        if (this.hasClimateCapability()) {
          Column() {
            Text('温度').fontSize(12).fontColor('#888888')
            Text(this.climateValueText(true)).fontSize(18).fontWeight(FontWeight.Bold)
              .fontColor(this.climateValueColor()).margin({ top: 4 })
          }.liveCardStyle()
          Column() {
            Text('湿度').fontSize(12).fontColor('#888888')
            Text(this.climateValueText(false)).fontSize(18).fontWeight(FontWeight.Bold)
              .fontColor(this.climateValueColor()).margin({ top: 4 })
          }.liveCardStyle()
        }
      }.width('100%').padding({ left: 16, right: 16 })

      if (this.hasDoorCapability() || this.hasGasCapability() || this.hasSmokeCapability()) {
        Row({ space: 8 }) {
          if (this.hasDoorCapability()) {
            Column() {
              Text('门窗').fontSize(12).fontColor('#888888')
              Text(this.liveDoorOpen ? '开启' : '关闭').fontSize(18).fontWeight(FontWeight.Bold).margin({ top: 4 })
            }.liveCardStyle()
          }
          if (this.hasGasCapability()) {
            Column() {
              Text('燃气').fontSize(12).fontColor('#888888')
              Text(this.gasStatusText()).fontSize(14).fontWeight(FontWeight.Bold).margin({ top: 4 })
                .fontColor('#666666')
            }.liveCardStyle()
          }
          if (this.hasSmokeCapability()) {
            Column() {
              Text('烟雾').fontSize(12).fontColor('#888888')
              Text(this.smokeStatusText()).fontSize(14).fontWeight(FontWeight.Bold).margin({ top: 4 })
                .fontColor('#666666')
            }.liveCardStyle()
          }
        }.width('100%').padding({ left: 16, right: 16, top: 8 })
      }

      Tabs({ barPosition: BarPosition.End, index: this.current }) {
        TabContent() {
          Scroll() {
            Column({ space: 12 }) {
              if (this.hasMotionCapability()) {
                Row({ space: 12 }) {
                  Column() {
                    Text('最后活动').fontSize(13).fontColor('#888888')
                    Text(DeviceStore.agoText(this.liveLastActiveTs)).fontSize(22)
                      .fontWeight(FontWeight.Bold).margin({ top: 6 })
                    Text('人体传感器').fontSize(12).fontColor('#AAAAAA').margin({ top: 4 })
                  }.cardStyle().layoutWeight(1)
                  Column() {
                    Text('今日活动').fontSize(13).fontColor('#888888')
                    Text(`${this.liveCount} 次`).fontSize(22)
                      .fontWeight(FontWeight.Bold).margin({ top: 6 })
                    Text('累计触发').fontSize(12).fontColor('#AAAAAA').margin({ top: 4 })
                  }.cardStyle().layoutWeight(1)
                }.width('100%')
              }

              if (this.hasDoorCapability()) {
                Column() {
                  Text(`${this.liveRoom} · 门窗状态`).fontSize(15).fontWeight(FontWeight.Bold).width('100%')
                  Row() {
                    Text(this.liveDoorOpen ? '当前：开启' : '当前：关闭').fontSize(16)
                      .fontColor(this.liveDoorOpen ? '#E6A23C' : '#333333')
                    Blank()
                    Text(`最近开启 ${DeviceStore.agoText(this.liveDoorLastOpenTs)}`)
                      .fontSize(13).fontColor('#888888')
                  }.width('100%').margin({ top: 8 })
                }.cardStyle()
              }

              if (this.hasClimateCapability()) {
                Column() {
                  Text('室内环境').fontSize(15).fontWeight(FontWeight.Bold).width('100%')
                  Row() {
                    Column() {
                      Text('温度').fontSize(13).fontColor('#888888')
                      Text(this.climateValueText(true)).fontSize(20)
                        .fontWeight(FontWeight.Bold).fontColor(this.climateValueColor()).margin({ top: 4 })
                    }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                    Column() {
                      Text('湿度').fontSize(13).fontColor('#888888')
                      Text(this.climateValueText(false)).fontSize(20)
                        .fontWeight(FontWeight.Bold).fontColor(this.climateValueColor()).margin({ top: 4 })
                    }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                  }.width('100%').margin({ top: 8 })
                  Text(this.climateHintText()).fontSize(13)
                    .fontColor(this.liveClimateValidKnown && this.liveClimateValid && this.liveClimateOk ? '#37B24D' : '#888888')
                    .margin({ top: 8 })
                }.cardStyle()
              }

              Column() {
                Text('设备信息').fontSize(15).fontWeight(FontWeight.Bold).width('100%')
                if (!this.capabilityKnown()) {
                  Text('能力待确认：未识别的设备编号，暂不显示传感器状态，避免把兼容占位字段当成已安装')
                    .fontSize(13).fontColor('#E6A23C').width('100%').margin({ top: 8 })
                }
                Row() {
                  Text('房间 / 编号').fontSize(14).fontColor('#888888')
                  Blank()
                  Text(`${this.liveRoom} / ${this.selectedId}`).fontSize(14)
                }.width('100%').margin({ top: 8 })
                Row() {
                  Text('在线状态').fontSize(14).fontColor('#888888')
                  Blank()
                  Text(this.liveOnline ? '在线（本地 TCP 已连接）' : '离线').fontSize(14)
                }.width('100%').margin({ top: 8 })
                if (this.hasGasCapability()) {
                  Row() {
                    Text('燃气').fontSize(14).fontColor('#888888')
                    Blank()
                    Text(this.gasStatusText()).fontSize(14)
                  }.width('100%').margin({ top: 8 })
                }
                if (this.hasSmokeCapability()) {
                  Row() {
                    Text('烟雾').fontSize(14).fontColor('#888888')
                    Blank()
                    Text(this.smokeStatusText()).fontSize(14)
                  }.width('100%').margin({ top: 8 })
                }
                Row() {
                  Text('运行状态').fontSize(14).fontColor('#888888')
                  Blank()
                  Text(this.stateLabel()).fontSize(14)
                }.width('100%').margin({ top: 8 })
                Row() {
                  Text('APP 版本').fontSize(14).fontColor('#888888')
                  Blank()
                  Text('1.0.4 · 2026-10-27 视频探望推流').fontSize(12).fontColor('#666666')
                }.width('100%').margin({ top: 8 })
              }.cardStyle()

              Column() {
                Row() {
                  Text('客厅摄像头').fontSize(15).fontWeight(FontWeight.Bold)
                  Text('（固定归属 ' + CAMERA_OWNER_DEVICE_ID + ' / 客厅）').fontSize(11).fontColor('#999999')
                  Blank()
                  if (this.hasCameraSelected()) {
                    Text(this.cameraStatusText).fontSize(12)
                      .fontColor(this.cameraPreviewActive ? '#37B24D' : '#777777')
                  }
                }.width('100%')

                if (this.hasCameraSelected()) {
                  Row() {
                    Text(`画面宽度 ${this.cameraPreviewWidthPct}% · 高度缩放 ${this.cameraPreviewScalePct}%`)
                      .fontSize(12).fontColor('#666666')
                    Blank()
                    Text('仅影响显示').fontSize(10).fontColor('#999999')
                  }.width('100%').margin({ top: 8 })
                  Row({ space: 6 }) {
                    Button('画面-10%').fontSize(11)
                      .onClick(() => { this.changePreviewWidth(-10); })
                    Button('画面+10%').fontSize(11)
                      .onClick(() => { this.changePreviewWidth(10); })
                    Button('比例-5%').fontSize(11)
                      .onClick(() => { this.changePreviewScale(-5); })
                    Button('比例+5%').fontSize(11)
                      .onClick(() => { this.changePreviewScale(5); })
                    Button('重置').fontSize(11)
                      .onClick(() => { this.resetPreviewTuning(); })
                  }.width('100%').margin({ top: 4 })
                }

                Stack({ alignContent: Alignment.Center }) {
                  Column() {
                    XComponent({
                      id: 'eldercareCameraPreview',
                      type: XComponentType.SURFACE,
                      controller: this.cameraController
                    })
                      .width('100%').height('100%')
                      .onLoad(() => { this.onCameraSurfaceReady(); })
                      .onDestroy(() => { this.onCameraSurfaceDestroyed(); })
                  }
                  // Display-only rotation: keep the 4:3 Surface wrapper native, rotate the
                  // wrapper into a 3:4 portrait area. XComponent and camera session are never
                  // recreated when these display values change.
                  .width('133.33%').height('75%')
                  .rotate({ angle: -90 })
                  .scale({ x: 1, y: this.cameraPreviewScalePct / 100 })
                  /*
                   * Keep this node stable instead of conditionally inserting/removing it.
                   * On this DAYU200 build, rebuilding the Stack around a SURFACE XComponent
                   * can destroy its native Surface after preview state changes.
                   */
                  Text(this.cameraGuardEnabled ? '自动监护正在启动' : '自动监护已暂停')
                    .fontSize(13).fontColor('#AAAAAA')
                    .visibility(this.cameraPreviewActive ? Visibility.Hidden : Visibility.Visible)
                  /*
                   * 非客厅房间：用**稳定遮罩**隐藏画面并禁止操作。
                   * 不删除 XComponent，避免原生 Surface 被重建；返回客厅立刻可见。
                   * 后台 Camera + VisionFrameStreamer 不因选中项变化而停止。
                   */
                  Column() {
                    Text('该房间未配置摄像头').fontSize(13).fontColor('#DDDDDD')
                    Text('客厅摄像头仅在选中「客厅」时显示与控制').fontSize(11).fontColor('#999999').margin({ top: 6 })
                  }
                  .width('100%').height('100%')
                  .justifyContent(FlexAlign.Center)
                  .backgroundColor('#1E2329')
                  .visibility(this.hasCameraSelected() ? Visibility.None : Visibility.Visible)
                }
                .width(`${this.cameraPreviewWidthPct}%`).aspectRatio(3 / 4).margin({ top: 10 })
                .alignSelf(ItemAlign.Center)
                .backgroundColor('#1E2329').borderRadius(6).clip(true)

                Row({ space: 8 }) {
                  Button(this.cameraPreviewActive ? '监护运行中' :
                    (this.cameraGuardEnabled ? '监护启动中' : '恢复监护'))
                    .fontSize(13)
                    .enabled(!this.cameraBusy && !this.cameraGuardEnabled && this.hasCameraSelected())
                    .onClick(() => { this.resumeCameraGuard(); })
                  Button('拍照')
                    .fontSize(13)
                    .enabled(!this.cameraBusy && this.cameraPreviewActive && this.cameraPhotoAvailable
                      && this.hasCameraSelected())
                    .onClick(() => { this.takeCameraPhoto(); })
                  Button('暂停监护')
                    .fontSize(13)
                    .enabled(this.cameraGuardEnabled && this.hasCameraSelected())
                    .onClick(() => { this.pauseCameraGuard(); })
                }.width('100%').margin({ top: 10 })

                if (this.cameraPhotoText.length > 0 && this.hasCameraSelected()) {
                  Text(this.cameraPhotoText).fontSize(12).fontColor('#666666')
                    .width('100%').margin({ top: 8 })
                }
                if (this.hasCameraSelected()) {
                  Text(this.cameraVisionText).fontSize(12)
                    .fontColor(this.cameraVisionFall ? '#C92A2A' :
                      (this.cameraVisionConnected ? '#2F9E44' : '#777777'))
                    .width('100%').margin({ top: 8 })
                  Text(this.videoVisitText).fontSize(12).fontColor('#666666')
                    .width('100%').margin({ top: 4 })
                  Text(this.monitorLabel()).fontSize(12)
                    .fontColor(this.liveMonitorOnline === 0 ? '#C92A2A' : '#666666')
                    .width('100%').margin({ top: 4 })
                }
              }.cardStyle()

              Text('提示：多房间节点经物联网云平台汇聚，本页数据来自本地直连的实时上报')
                .fontSize(12).fontColor('#999999').margin({ top: 4, bottom: 8 })
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 16, bottom: 88 })
          }
          .width('100%').height('100%').align(Alignment.Top)
        }.tabBar(this.tabBuilder('实时状态', 0))

        TabContent() {
          Column() {
            if (this.liveAlarms.length === 0) {
              Column() {
                Text('暂无预警记录').fontSize(16).fontColor('#888888')
                Text(`${this.liveRoom} 系统持续监测中`).fontSize(13).fontColor('#AAAAAA').margin({ top: 8 })
              }.width('100%').layoutWeight(1).justifyContent(FlexAlign.Center)
            } else {
              List({ space: 12 }) {
                ForEach(this.liveAlarms, (item: AlarmItem) => {
                  ListItem() {
                    Column() {
                      Row() {
                        Text(DeviceStore.alarmTypeText(item.type))
                          .fontSize(15).fontWeight(FontWeight.Bold).fontColor(Color.White)
                          .backgroundColor(item.level === 'ALARM' ? '#E64545' : '#E6A23C')
                          .borderRadius(10).padding({ left: 10, right: 10, top: 3, bottom: 3 })
                        Text(`${this.liveRoom} · ${DeviceStore.hhmm(item.startTs)}`)
                          .fontSize(13).fontColor('#888888').margin({ left: 10 })
                        Blank()
                        Text(item.acked ? '已闭环' : (this.isConfirming(item.id) ? '确认中…' : '待处理'))
                          .fontSize(13)
                          .fontColor(item.acked ? '#37B24D' : (this.isConfirming(item.id) ? '#E6A23C' : '#E64545'))
                      }.width('100%')

                      Text(item.detail).fontSize(14).margin({ top: 10 }).width('100%')

                      if (item.acked) {
                        Column() {
                          Text(`处置结果：${item.action}`).fontSize(13).fontColor('#444444')
                          Text(`确认时间：${DeviceStore.hhmm(item.ackTs)}`)
                            .fontSize(12).fontColor('#999999').margin({ top: 4 })
                        }
                        .width('100%').margin({ top: 10 }).padding(10)
                        .backgroundColor('#F4F7FB').borderRadius(8)
                        .alignItems(HorizontalAlign.Start)
                      } else {
                        Column() {
                          TextInput({ placeholder: '填写处置结果，例如：已电话确认，老人一切正常' })
                            .fontSize(13)
                            .onChange((v: string) => { this.ackText = v; })
                          Row() {
                            Button('确认闭环')
                              .fontSize(14).backgroundColor('#3F7DE6')
                              .onClick(() => { this.doAck(item.id); })
                            Text('下发后需收到设备确认才算闭环')
                              .fontSize(11).fontColor('#999999').margin({ left: 10 }).layoutWeight(1)
                          }.width('100%').margin({ top: 8 })
                          if (this.ackHint.length > 0) {
                            Text(this.ackHint).fontSize(11)
                              .fontColor(this.ackHint.startsWith('✓') ? '#37B24D' : '#E6A23C')
                              .margin({ top: 6 }).width('100%')
                          }
                        }.width('100%').margin({ top: 10 })
                      }
                    }
                    .width('100%').padding(16).backgroundColor(Color.White)
                    .borderRadius(12).alignItems(HorizontalAlign.Start)
                  }
                }, (item: AlarmItem) => `${item.id}-${item.acked ? 'a' : 'p'}`)
              }
              .width('100%').layoutWeight(1).padding(16)
            }
          }.width('100%').height('100%')
        }.tabBar(this.tabBuilder('预警处置', 1))

        TabContent() {
          Scroll() {
            Column({ space: 12 }) {
              if (this.hasMotionCapability()) {
                Column() {
                  Text(`${this.liveRoom} · 活动规律报告`).fontSize(15).fontWeight(FontWeight.Bold).width('100%')
                  Text(this.trendText()).fontSize(14).fontColor('#E6A23C')
                    .margin({ top: 10 }).width('100%')
                  Text(`最近活动：${DeviceStore.agoText(this.liveLastActiveTs)}`)
                    .fontSize(12).fontColor('#888888').margin({ top: 6 })
                }.cardStyle()

                Column() {
                  Text('近 7 日每日活动频次').fontSize(15).fontWeight(FontWeight.Bold).width('100%')
                  Row() {
                    ForEach(this.liveHistory, (v: number, i: number) => {
                      Column() {
                        Text(`${v}`).fontSize(10).fontColor('#666666')
                        Column()
                          .width('62%')
                          .height(Math.max(4, Math.round(v * 100 / this.maxHist())))
                          .backgroundColor('#3F7DE6').borderRadius(4).margin({ top: 4 })
                        Text(this.dayLabel(i)).fontSize(10).fontColor('#999999').margin({ top: 4 })
                      }
                      .layoutWeight(1)
                      .height(140)
                      .justifyContent(FlexAlign.End)
                    }, (v: number, i: number) => `${i}-${v}`)
                  }.width('100%').height(140).margin({ top: 8 })
                }.cardStyle()

                Column() {
                  Text('今日活动时段分布').fontSize(15).fontWeight(FontWeight.Bold).width('100%')
                  Row() {
                    Text('早晨 06-09').fontSize(13).fontColor('#666666').width(92)
                    Stack({ alignContent: Alignment.Start }) {
                      Column().width('100%').height(10).backgroundColor('#E8EDF5').borderRadius(5)
                      Column().width(this.slotWidth(0)).height(10).backgroundColor('#3F7DE6').borderRadius(5)
                    }.layoutWeight(1).height(10)
                    Text(`${this.liveSlots[0]}`).fontSize(13).width(34).textAlign(TextAlign.End)
                  }.width('100%').margin({ top: 10 })
                  Row() {
                    Text('上午 09-12').fontSize(13).fontColor('#666666').width(92)
                    Stack({ alignContent: Alignment.Start }) {
                      Column().width('100%').height(10).backgroundColor('#E8EDF5').borderRadius(5)
                      Column().width(this.slotWidth(1)).height(10).backgroundColor('#3F7DE6').borderRadius(5)
                    }.layoutWeight(1).height(10)
                    Text(`${this.liveSlots[1]}`).fontSize(13).width(34).textAlign(TextAlign.End)
                  }.width('100%').margin({ top: 12 })
                  Row() {
                    Text('下午 12-18').fontSize(13).fontColor('#666666').width(92)
                    Stack({ alignContent: Alignment.Start }) {
                      Column().width('100%').height(10).backgroundColor('#E8EDF5').borderRadius(5)
                      Column().width(this.slotWidth(2)).height(10).backgroundColor('#3F7DE6').borderRadius(5)
                    }.layoutWeight(1).height(10)
                    Text(`${this.liveSlots[2]}`).fontSize(13).width(34).textAlign(TextAlign.End)
                  }.width('100%').margin({ top: 12 })
                  Row() {
                    Text('晚间 18-22').fontSize(13).fontColor('#666666').width(92)
                    Stack({ alignContent: Alignment.Start }) {
                      Column().width('100%').height(10).backgroundColor('#E8EDF5').borderRadius(5)
                      Column().width(this.slotWidth(3)).height(10).backgroundColor('#3F7DE6').borderRadius(5)
                    }.layoutWeight(1).height(10)
                    Text(`${this.liveSlots[3]}`).fontSize(13).width(34).textAlign(TextAlign.End)
                  }.width('100%').margin({ top: 12 })
                }.cardStyle()
              } else {
                Column() {
                  Text(this.capabilityKnown() ? '该房间未配置 PIR 人体活动传感器' : '设备能力待确认')
                    .fontSize(15).fontWeight(FontWeight.Bold).width('100%')
                  Text(this.capabilityKnown()
                    ? '不展示今日活动/活动规律/时段统计；客厅人员检测来自摄像头（见实时状态），兼容占位字段不作为已安装依据。'
                    : '未识别该设备编号，暂不展示活动统计，避免把兼容占位字段当成已安装。')
                    .fontSize(13).fontColor('#888888').margin({ top: 8 }).width('100%')
                }.cardStyle()
              }

              Column() {
                Text('预警统计').fontSize(15).fontWeight(FontWeight.Bold).width('100%')
                Row() {
                  Text('今日预警').fontSize(14).fontColor('#888888')
                  Blank()
                  Text(`${this.liveAlarmCount} 次`).fontSize(14)
                }.width('100%').margin({ top: 8 })
                Row() {
                  Text('待处理').fontSize(14).fontColor('#888888')
                  Blank()
                  Text(`${this.liveAlarms.length - this.ackedCount()} 次`).fontSize(14)
                }.width('100%').margin({ top: 8 })
                Row() {
                  Text('已闭环').fontSize(14).fontColor('#888888')
                  Blank()
                  Text(`${this.ackedCount()} 次`).fontSize(14)
                }.width('100%').margin({ top: 8 })
              }.cardStyle()

              Text('说明：日统计由各房间节点累计并持久化，本页展示所选房间的真实数据')
                .fontSize(12).fontColor('#999999').margin({ top: 4, bottom: 8 })
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 16, bottom: 88 })
          }
          .width('100%').height('100%').align(Alignment.Top)
        }.tabBar(this.tabBuilder('统计报告', 2))
      }
      .onChange((index: number) => { this.current = index; })
      .barHeight(56)
      .layoutWeight(1)
    }
    .width('100%').height('100%').backgroundColor('#F4F6F9')
  }
}

@Extend(Column)
function liveCardStyle() {
  .layoutWeight(1)
  .padding(12)
  .backgroundColor(Color.White)
  .borderRadius(10)
  .alignItems(HorizontalAlign.Start)
}

@Extend(Column)
function cardStyle() {
  .width('100%')
  .padding(16)
  .backgroundColor(Color.White)
  .borderRadius(12)
  .alignItems(HorizontalAlign.Start)
}
