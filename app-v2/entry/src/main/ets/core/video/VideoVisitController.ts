/**
 * 视频探望编排器（纯逻辑，可被 Node 测试；VIDEO-VISIT-CONTRACT §3）。
 *
 * 通过端口（Port）与真实环境解耦：
 * - VideoRelayPort：申请 ticket / POST session/end（平台层用 GuardianService + HTTP）；
 * - VideoSocketPort：WebSocket 连接/关闭（平台层用 @ohos.net.webSocket）；
 * - VideoScheduler：定时器（平台层用 setTimeout，测试用假调度器）。
 *
 * 行为：
 * - 进入 → 申请 ticket → WS 连接 → ready/首帧 → 播放（帧校验失败丢弃，不崩溃）；
 * - 断线 → 最多 3 次退避 1/2/4s 重连（ticket 一次性，每次重连重新申请）；
 * - 首帧 15s 超时 → 如实失败（不显示“正在直播”）；
 * - 主动结束/离开页面 → 立即关 WS + 通知 relay 结束会话，之后所有迟到回调一律丢弃。
 */
import { JpegFrameInfo, frameRejectText, inspectJpegFrame } from './FrameDecodeCore';
import { VideoConfig, wsUrlFor } from './VideoConfig';
import {
  VideoControlMessage, VideoEndOutcome, VideoTicketOutcome, parseControlMessage
} from './VideoRelay';
import { VideoSessionCore, VideoSessionSnapshot } from './VideoSessionCore';

export interface VideoSocketListener {
  onOpen(): void;
  onText(text: string): void;
  onBinary(data: ArrayBuffer): void;
  onClose(code: number, reason: string): void;
  onError(message: string): void;
}

export interface VideoSocketPort {
  connect(url: string, listener: VideoSocketListener): void;
  close(): void;
}

export interface VideoRelayPort {
  requestTicket(): Promise<VideoTicketOutcome>;
  endSession(): Promise<VideoEndOutcome>;
}

export interface VideoScheduler {
  after(delayMs: number, callback: () => void): number;
  cancel(handle: number): void;
}

export interface VideoVisitCallbacks {
  onState(snapshot: VideoSessionSnapshot): void;
  onFrame(data: ArrayBuffer, info: JpegFrameInfo): void;
}

/** WS 回调 → 编排器：按连接代际过滤迟到回调（离开页面后不得继续收流）。 */
class SocketListenerBridge implements VideoSocketListener {
  private controller: VideoVisitController;
  private generation: number;

  constructor(controller: VideoVisitController, generation: number) {
    this.controller = controller;
    this.generation = generation;
  }

  onOpen(): void {
    this.controller.socketOpened(this.generation);
  }

  onText(text: string): void {
    this.controller.socketText(this.generation, text);
  }

  onBinary(data: ArrayBuffer): void {
    this.controller.socketBinary(this.generation, data);
  }

  onClose(code: number, reason: string): void {
    this.controller.socketClosed(this.generation, code, reason);
  }

  onError(message: string): void {
    this.controller.socketError(this.generation, message);
  }
}

export class VideoVisitController {
  private relayBase: string;
  private relay: VideoRelayPort;
  private socketFactory: () => VideoSocketPort;
  private scheduler: VideoScheduler;
  private nowFn: () => number;
  private callbacks: VideoVisitCallbacks;
  private session: VideoSessionCore = new VideoSessionCore();
  private socket: VideoSocketPort | null = null;
  private reconnectTimer: number = -1;
  private firstFrameTimer: number = -1;
  private generation: number = 0;
  private stopped: boolean = true;
  private connecting: boolean = false;

  constructor(relayBase: string, relay: VideoRelayPort, socketFactory: () => VideoSocketPort,
    scheduler: VideoScheduler, nowFn: () => number, callbacks: VideoVisitCallbacks) {
    this.relayBase = relayBase;
    this.relay = relay;
    this.socketFactory = socketFactory;
    this.scheduler = scheduler;
    this.nowFn = nowFn;
    this.callbacks = callbacks;
  }

  snapshot(): VideoSessionSnapshot {
    return this.session.snapshot(this.nowFn());
  }

  /** 进入页面：申请会话并连接。重复调用会开启新代际（旧回调作废）。 */
  start(): void {
    this.stopped = false;
    this.generation += 1;
    this.session.reset();
    this.session.beginRequest(this.nowFn());
    this.emit();
    this.requestAndConnect(this.generation);
  }

  /** 失败后手动重试：重置重连次数，重新走完整流程。 */
  retry(): void {
    if (this.stopped && !this.session.isTerminal()) return;
    this.clearTimers();
    this.closeSocket();
    this.start();
  }

  /** 按钮“结束探望”/onPageHide/aboutToDisappear：必须关 WS 并通知 relay 结束会话。 */
  stop(): void {
    const alreadyStopped: boolean = this.stopped;
    this.stopped = true;
    this.generation += 1;
    this.clearTimers();
    this.closeSocket();
    if (alreadyStopped && !this.session.isActive()) {
      return;
    }
    this.session.end(this.nowFn());
    this.emit();
    this.endRelaySession();
  }

  // ------------------------------------------------------------- 内部实现

  private emit(): void {
    this.callbacks.onState(this.session.snapshot(this.nowFn()));
  }

  private requestAndConnect(generation: number): void {
    this.connecting = true;
    this.relay.requestTicket().then((outcome: VideoTicketOutcome): void => {
      this.connecting = false;
      if (generation !== this.generation || this.stopped) return;
      if (!outcome.ok) {
        this.handleRequestFailure(outcome.kind, outcome.message);
        return;
      }
      this.session.ticketReceived(this.nowFn());
      this.emit();
      const url: string = wsUrlFor(this.relayBase, outcome.wsPath);
      if (url.length === 0) {
        this.session.requestFailed('config', '视频中继地址配置无效，请检查 video.relayBase 配置');
        this.emit();
        return;
      }
      this.openSocket(url, generation);
    }).catch((): void => {
      this.connecting = false;
      if (generation !== this.generation || this.stopped) return;
      this.handleRequestFailure('network', '无法连接视频服务，请检查网络后重试');
    });
  }

  private handleRequestFailure(kind: string, message: string): void {
    if (this.session.reconnectAttempt > 0) {
      // 重连阶段的申请失败也算一次重连失败，继续按 1/2/4s 退避直到 3 次上限。
      const delay: number = this.session.socketClosed(this.nowFn());
      this.emit();
      if (delay >= 0) {
        this.scheduleReconnect(delay);
        return;
      }
    }
    this.session.requestFailed(kind, message);
    this.emit();
  }

  private openSocket(url: string, generation: number): void {
    this.closeSocket();
    const socket: VideoSocketPort = this.socketFactory();
    this.socket = socket;
    socket.connect(url, new SocketListenerBridge(this, generation));
  }

  private closeSocket(): void {
    const socket: VideoSocketPort | null = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.close();
    }
  }

  /** WS 已连接（generation 校验通过）。 */
  socketOpened(generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    this.session.socketOpened(this.nowFn());
    this.scheduleFirstFrameTimeout();
    this.emit();
  }

  /** WS 文本控制消息：ready/error/resumed/heartbeat。 */
  socketText(generation: number, text: string): void {
    if (generation !== this.generation || this.stopped) return;
    const message: VideoControlMessage | null = parseControlMessage(text);
    if (message === null) return;
    if (message.type === 'ready') {
      this.session.controlReady(message, this.nowFn());
      this.emit();
      return;
    }
    if (message.type === 'resumed') {
      this.session.controlResumed(this.nowFn());
      this.emit();
      return;
    }
    if (message.type === 'error') {
      this.session.controlError(message.code, this.nowFn());
      this.clearFirstFrameTimer();
      this.closeSocket();
      this.emit();
      return;
    }
    // heartbeat 等未知控制消息：不改变画面状态（不冒充播放）。
  }

  /** WS 二进制消息：一帧 JPEG；非法帧丢弃并计数，不影响已有画面。 */
  socketBinary(generation: number, data: ArrayBuffer): void {
    if (generation !== this.generation || this.stopped) return;
    const bytes: Uint8Array = new Uint8Array(data);
    const info: JpegFrameInfo = inspectJpegFrame(bytes, VideoConfig.FRAME_MIN_BYTES,
      VideoConfig.FRAME_MAX_BYTES);
    if (!info.valid) {
      this.session.frameDropped(info.reason, frameRejectText(info.reason));
      this.emit();
      return;
    }
    this.clearFirstFrameTimer();
    this.session.frameReceived(this.nowFn());
    this.emit();
    this.callbacks.onFrame(data, info);
  }

  socketError(generation: number, message: string): void {
    if (generation !== this.generation || this.stopped) return;
    this.session.socketError(message);
    this.emit();
  }

  /** WS 关闭：按重连策略排队；次数耗尽进入 failed（显示错误 + 重试按钮）。 */
  socketClosed(generation: number, code: number, reason: string): void {
    if (generation !== this.generation || this.stopped) return;
    this.socket = null;
    this.clearFirstFrameTimer();
    const delay: number = this.session.socketClosed(this.nowFn());
    this.emit();
    if (delay >= 0) {
      this.scheduleReconnect(delay);
    }
  }

  private scheduleReconnect(delayMs: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = this.scheduler.after(delayMs, (): void => {
      this.reconnectTimer = -1;
      if (this.stopped) return;
      this.session.reconnectDue(this.nowFn());
      this.emit();
      this.requestAndConnect(this.generation);
    });
  }

  private scheduleFirstFrameTimeout(): void {
    this.clearFirstFrameTimer();
    this.firstFrameTimer = this.scheduler.after(VideoConfig.FIRST_FRAME_TIMEOUT_MS, (): void => {
      this.firstFrameTimer = -1;
      if (this.stopped) return;
      if (!this.session.firstFrameTimedOut(this.nowFn())) return;
      this.session.requestFailed('first_frame_timeout',
        '已连接视频中继，但 15 秒内没有收到任何画面，请重试');
      this.closeSocket();
      this.emit();
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer >= 0) {
      this.scheduler.cancel(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
  }

  private clearFirstFrameTimer(): void {
    if (this.firstFrameTimer >= 0) {
      this.scheduler.cancel(this.firstFrameTimer);
      this.firstFrameTimer = -1;
    }
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.clearFirstFrameTimer();
  }

  /** 主动结束时通知 relay 关停推流；失败只记录在返回值，不阻塞页面退出。 */
  private endRelaySession(): void {
    this.relay.endSession().then((outcome: VideoEndOutcome): void => {
      // 结束失败不影响本地已退出：relay 侧空闲会自动停止 DAYU 推流。
    }).catch((): void => {
    });
  }

  /** 是否还有在途的 ticket 请求（测试/调试使用）。 */
  isConnecting(): boolean {
    return this.connecting;
  }
}
