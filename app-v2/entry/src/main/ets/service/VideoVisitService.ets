/**
 * 视频探望服务（平台层装配）：把 core/video 的纯逻辑状态机接到真实环境。
 *
 * - relay 地址：VideoConfig 默认值 + AppStorage `video.relayBase` 覆盖（不写死到页面）；
 * - ticket/session end：全部走 GuardianService（页面拿不到、也不打印 token）；
 * - WS：net/HarmonyVideoSocket（@ohos.net.webSocket）；
 * - 定时器：setTimeout；JPEG 解码在页面用 @ohos.multimedia.image 完成。
 */
import { JpegFrameInfo } from '../core/video/FrameDecodeCore';
import { VideoConfig, relayBaseOrDefault } from '../core/video/VideoConfig';
import {
  VideoEndOutcome, VideoTicketOutcome
} from '../core/video/VideoRelay';
import { VideoSessionSnapshot } from '../core/video/VideoSessionCore';
import {
  VideoRelayPort, VideoScheduler, VideoVisitCallbacks, VideoVisitController
} from '../core/video/VideoVisitController';
import { HarmonyVideoSocket } from '../net/HarmonyVideoSocket';
import { GuardianService } from './GuardianService';

/** setTimeout 调度器（服务/页面层真实定时器）。 */
class TimeoutScheduler implements VideoScheduler {
  after(delayMs: number, callback: () => void): number {
    return setTimeout(callback, delayMs) as number;
  }

  cancel(handle: number): void {
    clearTimeout(handle);
  }
}

/** relay 端口：token 只存在于 GuardianService 内部，不经过页面。 */
class GuardianVideoRelayPort implements VideoRelayPort {
  private relayBase: string;

  constructor(relayBase: string) {
    this.relayBase = relayBase;
  }

  requestTicket(): Promise<VideoTicketOutcome> {
    return GuardianService.requestVideoTicket(this.relayBase);
  }

  endSession(): Promise<VideoEndOutcome> {
    return GuardianService.endVideoSession(this.relayBase);
  }
}

export class VideoVisitService {
  private controller: VideoVisitController | null = null;
  /** 当前会话 relay 基址（已归一化），用于页面显示与日志（不含凭据）。 */
  private relayBase: string = '';

  /**
   * relay 基址解析：AppStorage `video.relayBase` 优先，空/非法回退 VideoConfig 默认值。
   * 生产环境可注入 `https://api.luxunacc.xyz`（自动转 wss）。
   */
  static resolvedRelayBase(): string {
    const override: string = AppStorage.get<string>(VideoConfig.RELAY_BASE_STORAGE_KEY) ?? '';
    return relayBaseOrDefault(override);
  }

  relayBaseUsed(): string {
    return this.relayBase;
  }

  /** 开始探望（重复调用会先停止上一轮，避免并发收流）。 */
  start(onState: (snapshot: VideoSessionSnapshot) => void,
    onFrame: (data: ArrayBuffer, info: JpegFrameInfo) => void): void {
    this.stop();
    this.relayBase = VideoVisitService.resolvedRelayBase();
    const callbacks: VideoVisitCallbacks = {
      onState: onState,
      onFrame: onFrame
    };
    const controller = new VideoVisitController(
      this.relayBase,
      new GuardianVideoRelayPort(this.relayBase),
      () => new HarmonyVideoSocket(),
      new TimeoutScheduler(),
      () => Date.now(),
      callbacks
    );
    this.controller = controller;
    controller.start();
  }

  /** 失败后手动重试（重置重连次数）。 */
  retry(): void {
    if (this.controller !== null) {
      this.controller.retry();
    }
  }

  /** 结束探望/离开页面：关 WS 并 POST /video/session/end；之后迟到回调全部丢弃。 */
  stop(): void {
    const controller: VideoVisitController | null = this.controller;
    this.controller = null;
    if (controller !== null) {
      controller.stop();
    }
  }

  snapshot(): VideoSessionSnapshot | null {
    if (this.controller === null) return null;
    return this.controller.snapshot();
  }
}
