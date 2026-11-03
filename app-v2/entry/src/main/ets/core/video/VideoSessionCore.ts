/**
 * 视频探望会话状态机（纯逻辑，VIDEO-VISIT-CONTRACT §3）。
 *
 * 状态流转：
 *   idle → requesting（申请 ticket）→ connecting（WS 升级）→ waiting-first-frame
 *   → playing（首帧到达）→ [断线] reconnecting（最多 3 次，退避 1/2/4s）→ requesting …
 *   → failed（错误码 + 重试） / ended（主动结束/离开页面）
 *
 * 本类不依赖真实 WebSocket/HTTP/定时器：时间由调用方传入 nowMs，
 * 重连延迟只做计算（调度在 VideoVisitController），因此可被 Node 完整单测。
 * 任何状态都不得声称“正在直播”；只有真实收到并校验通过的帧才进入 playing。
 */
import { FrameRateTracker } from './FrameDecodeCore';
import { VideoConfig } from './VideoConfig';
import { VideoControlMessage, relayErrorText } from './VideoRelay';

export class VideoSessionState {
  static readonly IDLE: string = 'idle';
  static readonly REQUESTING: string = 'requesting';
  static readonly CONNECTING: string = 'connecting';
  static readonly WAITING_FIRST_FRAME: string = 'waiting-first-frame';
  static readonly PLAYING: string = 'playing';
  static readonly RECONNECTING: string = 'reconnecting';
  static readonly FAILED: string = 'failed';
  static readonly ENDED: string = 'ended';
}

/** 供页面渲染的只读快照（不含 ticket/URL/token 等敏感信息）。 */
export class VideoSessionSnapshot {
  state: string = VideoSessionState.IDLE;
  statusText: string = '未开始';
  errorKind: string = '';
  errorText: string = '';
  reconnectAttempt: number = 0;
  maxReconnectAttempts: number = VideoConfig.MAX_RECONNECT_ATTEMPTS;
  framesReceived: number = 0;
  droppedFrames: number = 0;
  fps: number = 0;
  cameraText: string = '';
  proto: number = 0;
  playing: boolean = false;
  canRetry: boolean = false;
  /** 最近一次丢帧原因文案（不覆盖主状态，仅在播放中提示）。 */
  lastDropText: string = '';
}

export class VideoSessionCore {
  state: string = VideoSessionState.IDLE;
  reconnectAttempt: number = 0;
  framesReceived: number = 0;
  droppedFrames: number = 0;
  cameraText: string = '';
  proto: number = 0;
  private rate: FrameRateTracker = new FrameRateTracker();
  private lastDropText: string = '';
  private waitingSince: number = 0;
  private waiting: boolean = false;
  private endedByUser: boolean = false;
  private errorKind: string = '';
  private errorText: string = '';

  reset(): void {
    this.state = VideoSessionState.IDLE;
    this.reconnectAttempt = 0;
    this.framesReceived = 0;
    this.droppedFrames = 0;
    this.cameraText = '';
    this.proto = 0;
    this.rate.reset();
    this.lastDropText = '';
    this.waitingSince = 0;
    this.waiting = false;
    this.endedByUser = false;
    this.errorKind = '';
    this.errorText = '';
  }

  isTerminal(): boolean {
    return this.state === VideoSessionState.FAILED || this.state === VideoSessionState.ENDED;
  }

  ended(): boolean {
    return this.endedByUser;
  }

  /** 是否处于“可能继续播放”的活动状态。 */
  isActive(): boolean {
    return !this.isTerminal() && this.state !== VideoSessionState.IDLE;
  }

  beginRequest(nowMs: number): void {
    this.state = VideoSessionState.REQUESTING;
    this.errorKind = '';
    this.errorText = '';
    this.waitingSince = 0;
    this.waiting = false;
  }

  ticketReceived(nowMs: number): void {
    this.state = VideoSessionState.CONNECTING;
    this.waitingSince = 0;
    this.waiting = false;
  }

  /** WS 已升级成功，开始等待首帧。 */
  socketOpened(nowMs: number): void {
    this.state = VideoSessionState.WAITING_FIRST_FRAME;
    this.waitingSince = nowMs;
    this.waiting = true;
  }

  controlReady(message: VideoControlMessage, nowMs: number): void {
    if (message.proto > 0) this.proto = message.proto;
    if (message.camera.length > 0) this.cameraText = message.camera;
    if (this.state === VideoSessionState.CONNECTING || this.state === VideoSessionState.WAITING_FIRST_FRAME) {
      this.state = VideoSessionState.WAITING_FIRST_FRAME;
      if (!this.waiting) {
        this.waitingSince = nowMs;
        this.waiting = true;
      }
    }
  }

  /** relay 文本错误（DAYU_DOWN / NO_AGENT / BUSY）：进入失败态，显示具体错误码。 */
  controlError(code: string, nowMs: number): void {
    this.state = VideoSessionState.FAILED;
    this.errorKind = 'relay_error';
    this.errorText = relayErrorText(code);
  }

  /** 断线后 relay 恢复推流（resumed）：继续等待真实帧，不直接宣称正在播放。 */
  controlResumed(nowMs: number): void {
    if (this.state === VideoSessionState.RECONNECTING) {
      this.state = VideoSessionState.WAITING_FIRST_FRAME;
      this.waitingSince = nowMs;
      this.waiting = true;
    }
  }

  /** 收到一帧通过校验的 JPEG：首帧后进入 playing。 */
  frameReceived(nowMs: number): void {
    this.framesReceived += 1;
    this.rate.addFrame(nowMs);
    this.waiting = false;
    this.waitingSince = 0;
    this.lastDropText = '';
    this.state = VideoSessionState.PLAYING;
  }

  /** 非法帧丢弃：保持当前状态，不影响已有画面（不崩溃、不冒充成功）。 */
  frameDropped(reason: string, dropText: string): void {
    this.droppedFrames += 1;
    this.lastDropText = dropText;
  }

  /** WS error 事件：先记录文案；真正状态迁移由随后的 close 事件决定（避免双重重连）。 */
  socketError(message: string): void {
    if (this.isTerminal()) return;
    this.lastDropText = message.length > 0 ? `视频连接异常：${message}` : '视频连接异常';
  }

  /**
   * WS 关闭（非主动结束）：
   * - 还有重连次数 → reconnecting，返回本次退避延迟（1000/2000/4000ms）；
   * - 次数耗尽 → failed（返回 -1）。
   */
  socketClosed(nowMs: number): number {
    if (this.endedByUser) {
      this.state = VideoSessionState.ENDED;
      return -1;
    }
    if (this.isTerminal()) {
      return -1;
    }
    if (this.reconnectAttempt >= VideoConfig.MAX_RECONNECT_ATTEMPTS) {
      this.state = VideoSessionState.FAILED;
      this.errorKind = 'disconnected';
      this.errorText = `视频连接已中断，重连 ${VideoConfig.MAX_RECONNECT_ATTEMPTS} 次仍失败，请重试`;
      return -1;
    }
    this.reconnectAttempt += 1;
    this.state = VideoSessionState.RECONNECTING;
    const exponent: number = this.reconnectAttempt - 1;
    return VideoConfig.RECONNECT_BASE_DELAY_MS * Math.pow(2, exponent);
  }

  /** 重连定时器到点：重新申请 ticket（ticket 一次性）。 */
  reconnectDue(nowMs: number): void {
    this.state = VideoSessionState.REQUESTING;
  }

  /** 申请 ticket / 配置等直接失败。 */
  requestFailed(kind: string, message: string): void {
    this.state = VideoSessionState.FAILED;
    this.errorKind = kind;
    this.errorText = message;
  }

  /** 主动结束（按钮/离开页面）。 */
  end(nowMs: number): void {
    this.endedByUser = true;
    this.state = VideoSessionState.ENDED;
    this.waiting = false;
    this.waitingSince = 0;
  }

  /** 等待首帧超时（WS 通了但没有任何画面：如实失败，不显示“正在直播”）。 */
  firstFrameTimedOut(nowMs: number): boolean {
    if (this.state !== VideoSessionState.WAITING_FIRST_FRAME) return false;
    if (!this.waiting) return false;
    return nowMs - this.waitingSince >= VideoConfig.FIRST_FRAME_TIMEOUT_MS;
  }

  fps(): number {
    return this.rate.fps();
  }

  snapshot(nowMs: number): VideoSessionSnapshot {
    const view = new VideoSessionSnapshot();
    view.state = this.state;
    view.errorKind = this.errorKind;
    view.errorText = this.errorText;
    view.reconnectAttempt = this.reconnectAttempt;
    view.framesReceived = this.framesReceived;
    view.droppedFrames = this.droppedFrames;
    view.fps = this.rate.fps();
    view.cameraText = this.cameraText;
    view.proto = this.proto;
    view.playing = this.state === VideoSessionState.PLAYING;
    view.canRetry = this.state === VideoSessionState.FAILED;
    view.lastDropText = this.lastDropText;
    if (this.state === VideoSessionState.IDLE) {
      view.statusText = '未开始';
    } else if (this.state === VideoSessionState.REQUESTING) {
      view.statusText = '正在申请视频会话…';
    } else if (this.state === VideoSessionState.CONNECTING) {
      view.statusText = '正在连接视频中继…';
    } else if (this.state === VideoSessionState.WAITING_FIRST_FRAME) {
      view.statusText = '已连接，等待第一帧画面…';
    } else if (this.state === VideoSessionState.PLAYING) {
      view.statusText = `实时画面 · 已接收 ${this.framesReceived} 帧 · ${view.fps} fps`;
    } else if (this.state === VideoSessionState.RECONNECTING) {
      view.statusText =
        `连接中断，正在重连…（第 ${this.reconnectAttempt}/${VideoConfig.MAX_RECONNECT_ATTEMPTS} 次）`;
    } else if (this.state === VideoSessionState.FAILED) {
      view.statusText = this.errorText.length > 0 ? this.errorText : '视频连接失败';
    } else if (this.state === VideoSessionState.ENDED) {
      view.statusText = '已结束探望';
    }
    return view;
  }
}
