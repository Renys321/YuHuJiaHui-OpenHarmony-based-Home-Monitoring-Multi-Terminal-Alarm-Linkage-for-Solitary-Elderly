/**
 * VideoStreamServer —— 手机远程视频探望的 DAYU200 板端取帧服务。
 *
 * 设计边界：
 *  - 监听 0.0.0.0:9301，但**只接受家庭局域网/回环来源**（10/8、172.16/12、192.168/16、127/8），
 *    非私有地址一律拒绝；本机没有公网 IP，也不做任何端口映射，因此不会暴露到公网。
 *  - 对外由 PC relay 通过家庭 Wi-Fi 连接（USB/HDC 不再是视频必需路径）。
 *  - 单客户端；无客户端时**不取帧、不编码、不发帧**。
 *  - 复用 APP 现有相机预览 Surface（本机监护链路），不额外开启第二个相机。
 *  - 控制消息为行分隔 JSON；视频帧为 [4 字节大端长度][JPEG]。
 *
 * 该服务失败不得影响相机预览、视觉推理、告警与 ACK 主链路。
 */
import socket from '@ohos.net.socket';
import image from '@ohos.multimedia.image';
import buffer from '@ohos.buffer';
import { BusinessError } from '@ohos.base';

export const VIDEO_STREAM_PORT: number = 9301;
/** 监听地址：家庭局域网可取帧；公网不可达（设备无公网 IP，且下面有私有地址白名单）。 */
export const VIDEO_STREAM_BIND: string = '0.0.0.0';
export const VIDEO_STREAM_PROTO: number = 1;

/* 取帧/编码配置（可被控制消息 config 覆盖；默认值会在实测后按最优配置固化）。 */
const DEFAULT_FRAME_WIDTH: number = 320;
const DEFAULT_FRAME_HEIGHT: number = 240;
const DEFAULT_JPEG_QUALITY: number = 60;
const DEFAULT_FRAME_INTERVAL_MS: number = 0;
const MIN_FRAME_WIDTH: number = 160;
const MAX_FRAME_WIDTH: number = 640;
const MIN_FRAME_HEIGHT: number = 120;
const MAX_FRAME_HEIGHT: number = 480;
const MIN_JPEG_QUALITY: number = 20;
const MAX_JPEG_QUALITY: number = 95;
const MIN_FRAME_INTERVAL_MS: number = 0;
const MAX_FRAME_INTERVAL_MS: number = 500;

/** 仅允许私有/回环来源，防止意外把 9301 暴露给非家庭网络。 */
function isAllowedClientAddress(rawAddress: string): boolean {
  let addr: string = rawAddress.trim().toLowerCase();
  if (addr.indexOf('::ffff:') === 0) {
    addr = addr.substring('::ffff:'.length);
  }
  if (addr === '::1' || addr === '127.0.0.1' || addr === 'localhost') {
    return true;
  }
  const parts: string[] = addr.split('.');
  if (parts.length !== 4) {
    return false;
  }
  const a: number = Number(parts[0]);
  const b: number = Number(parts[1]);
  if (isNaN(a) || isNaN(b)) {
    return false;
  }
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return false;
}

const MAX_RECV_CHARS: number = 4096;
const MIN_JPEG_BYTES: number = 2048;
const MAX_JPEG_BYTES: number = 1048576;
const WAITING_NOTIFY_MS: number = 1000;

export interface VideoStreamStatus {
  serverListening: boolean;
  clientConnected: boolean;
  streaming: boolean;
  framesSent: number;
  framesFailed: number;
  lastFrameBytes: number;
  lastFps: number;
  lastError: string;
}

interface StreamControl {
  type?: string;
  viewer?: string;
  width?: number;
  height?: number;
  quality?: number;
  intervalMs?: number;
  /** 1 = 直接从相机 Surface 裁剪目标区域（避免全幅读回+缩放），0/缺省 = 全幅取帧后缩放。 */
  crop?: number;
}

/**
 * 远程探望取帧服务。相机 Surface 与预览状态由页面通过回调提供，
 * 保证“取的是正在显示的那一路相机画面”。
 */
export class VideoStreamServer {
  private server: socket.TCPSocketServer | null = null;
  private connection: socket.TCPSocketConnection | null = null;
  private surfaceProvider: (() => string) | null = null;
  private previewActiveProvider: (() => boolean) | null = null;
  private listening: boolean = false;
  private clientConnected: boolean = false;
  private streaming: boolean = false;
  private generation: number = 0;
  private timerId: number = -1;
  private recvText: string = '';
  private framesSent: number = 0;
  private framesFailed: number = 0;
  private lastFrameBytes: number = 0;
  private lastFps: number = 0;
  private fpsWindowStart: number = 0;
  private fpsWindowFrames: number = 0;
  private lastWaitingNotice: number = 0;
  private lastError: string = '';
  private statusListener: ((status: VideoStreamStatus) => void) | null = null;
  private starting: boolean = false;
  /* 帧参数（config 控制消息可覆盖）；只在取帧循环里读取，避免积压。 */
  private frameWidth: number = DEFAULT_FRAME_WIDTH;
  private frameHeight: number = DEFAULT_FRAME_HEIGHT;
  private jpegQuality: number = DEFAULT_JPEG_QUALITY;
  private frameIntervalMs: number = DEFAULT_FRAME_INTERVAL_MS;
  private cropMode: boolean = false;
  private sourceWidth: number = 0;
  private sourceHeight: number = 0;
  /* 复用编码器，避免每帧 create/release ImagePacker 的开销。 */
  private sharedPacker: image.ImagePacker | null = null;
  /* 单帧在途：上一次 captureAndSend 未完成前不再启动新的一帧。 */
  private captureInFlight: boolean = false;

  setStatusListener(listener: (status: VideoStreamStatus) => void): void {
    this.statusListener = listener;
  }

  /**
   * 启动监听。surfaceProvider/previewActiveProvider 用于按需取帧；
   * 监听本身不触发任何取帧。
   */
  async start(surfaceProvider: () => string, previewActiveProvider: () => boolean): Promise<void> {
    this.surfaceProvider = surfaceProvider;
    this.previewActiveProvider = previewActiveProvider;
    if (this.listening || this.starting) {
      return;
    }
    this.starting = true;
    try {
      const tcpServer: socket.TCPSocketServer = socket.constructTCPSocketServerInstance();
      tcpServer.on('connect', (connection: socket.TCPSocketConnection): void => {
        this.onClientConnected(connection);
      });
      await tcpServer.listen({ address: VIDEO_STREAM_BIND, port: VIDEO_STREAM_PORT });
      this.server = tcpServer;
      this.listening = true;
      this.lastError = '';
      console.info(`[VideoStreamServer] 已监听 ${VIDEO_STREAM_BIND}:${VIDEO_STREAM_PORT}（仅私网/回环来源）`);
    } catch (err) {
      const error = err as BusinessError;
      this.lastError = `listen failed: ${error.code}`;
      console.error(`[VideoStreamServer] 监听失败: ${error.code} - ${error.message}`);
    } finally {
      this.starting = false;
    }
    this.notify();
  }

  /** 停止监听与当前流；不触碰相机预览本身（预览由 Index 监护链路持有）。 */
  stop(): void {
    this.generation = this.generation + 1;
    this.streaming = false;
    this.captureInFlight = false;
    this.clearFrameTimer();
    this.closeConnection();
    this.releaseSharedPacker();
    const tcpServer: socket.TCPSocketServer | null = this.server;
    this.server = null;
    this.listening = false;
    this.clientConnected = false;
    this.surfaceProvider = null;
    this.previewActiveProvider = null;
    if (tcpServer !== null) {
      tcpServer.off('connect');
      tcpServer.close().then((): void => {
        console.info('[VideoStreamServer] 监听已关闭');
      }).catch((err: BusinessError): void => {
        console.warn(`[VideoStreamServer] 关闭监听失败: ${err.code}`);
      });
    }
    this.notify();
  }

  isListening(): boolean {
    return this.listening;
  }

  private onClientConnected(connection: socket.TCPSocketConnection): void {
    if (this.connection !== null) {
      // 单客户端：已有观看者时明确拒绝，避免多人并发采集。
      connection.send({ data: '{"type":"busy"}\n' }).then((): void => {
        connection.close();
      }).catch((): void => {
        connection.close();
      });
      console.warn('[VideoStreamServer] 已存在观看者，拒绝新连接');
      return;
    }
    // 局域网白名单：只接受私有/回环来源（设备没有公网 IP，也没有端口映射）。
    connection.getRemoteAddress().then((peer: socket.NetAddress): void => {
      const peerAddress: string = peer.address;
      if (!isAllowedClientAddress(peerAddress)) {
        console.warn(`[VideoStreamServer] 拒绝非私网来源: ${peerAddress}`);
        connection.send({ data: '{"type":"error","code":"LAN_ONLY"}\n' }).then((): void => {
          connection.close();
        }).catch((): void => {
          connection.close();
        });
        return;
      }
      if (this.connection !== null) {
        connection.close();
        return;
      }
      console.info(`[VideoStreamServer] 观看者已连接 peer=${peerAddress}`);
      this.acceptClient(connection);
    }).catch((err: BusinessError): void => {
      console.warn(`[VideoStreamServer] 获取对端地址失败: ${err.code}`);
      connection.close();
    });
  }

  /** 通过私网来源校验后正式接纳该观看者（单客户端）。 */
  private acceptClient(connection: socket.TCPSocketConnection): void {
    this.connection = connection;
    this.clientConnected = true;
    this.recvText = '';
    this.stopping = false;
    this.generation = this.generation + 1;
    connection.on('message', (info: socket.SocketMessageInfo): void => {
      this.onClientMessage(info);
    });
    connection.on('close', (): void => {
      this.onClientClosed(connection, 'peer closed');
    });
    connection.on('error', (err: BusinessError): void => {
      this.onClientClosed(connection, `socket error ${err.code}`);
    });
    const cameraActive: boolean = this.isPreviewActive();
    const hello: string = `{"type":"hello","proto":${VIDEO_STREAM_PROTO},` +
      `"device":"dayu200-living","camera":"${this.frameWidth}x${this.frameHeight}",` +
      `"quality":${this.jpegQuality},"intervalMs":${this.frameIntervalMs},"cameraActive":${cameraActive}}\n`;
    connection.send({ data: hello }).catch((err: BusinessError): void => {
      this.onClientClosed(connection, `hello send failed ${err.code}`);
    });
    this.notify();
  }

  private stopping: boolean = false;

  private onClientClosed(connection: socket.TCPSocketConnection, reason: string): void {
    if (this.connection !== connection || this.stopping) {
      return;
    }
    this.stopping = true;
    this.streaming = false;
    this.clearFrameTimer();
    this.clientConnected = false;
    this.connection = null;
    this.recvText = '';
    console.info(`[VideoStreamServer] 观看者断开：${reason}（已发送 ${this.framesSent} 帧）`);
    try {
      connection.off('message');
      connection.off('close');
      connection.off('error');
    } catch (err) {
      console.warn('[VideoStreamServer] 解绑连接事件失败');
    }
    connection.close().catch((): void => { });
    this.notify();
  }

  private closeConnection(): void {
    const connection: socket.TCPSocketConnection | null = this.connection;
    this.connection = null;
    this.clientConnected = false;
    this.stopping = true;
    if (connection === null) {
      return;
    }
    try {
      connection.off('message');
      connection.off('close');
      connection.off('error');
    } catch (err) {
      console.warn('[VideoStreamServer] 解绑连接事件失败');
    }
    connection.send({ data: '{"type":"stopped"}\n' }).then((): void => {
      connection.close().catch((): void => { });
    }).catch((): void => {
      connection.close().catch((): void => { });
    });
  }

  private onClientMessage(info: socket.SocketMessageInfo): void {
    try {
      const chunk: string = buffer.from(info.message).toString('utf-8');
      this.recvText = this.recvText + chunk;
      if (this.recvText.length > MAX_RECV_CHARS) {
        this.recvText = this.recvText.substring(this.recvText.length - MAX_RECV_CHARS);
      }
      let newlineIndex: number = this.recvText.indexOf('\n');
      while (newlineIndex >= 0) {
        const line: string = this.recvText.substring(0, newlineIndex).trim();
        this.recvText = this.recvText.substring(newlineIndex + 1);
        if (line.length > 0) {
          this.handleControlLine(line);
        }
        newlineIndex = this.recvText.indexOf('\n');
      }
    } catch (err) {
      const error = err as BusinessError;
      console.warn(`[VideoStreamServer] 控制消息解析失败: ${error.message}`);
    }
  }

  private handleControlLine(line: string): void {
    let control: StreamControl | null = null;
    try {
      control = JSON.parse(line) as StreamControl;
    } catch (err) {
      this.sendJson('{"type":"error","code":"BAD_CONTROL"}');
      return;
    }
    if (control === null || control.type === undefined) {
      this.sendJson('{"type":"error","code":"BAD_CONTROL"}');
      return;
    }
    if (control.type === 'start') {
      this.startStreaming(control.viewer === undefined ? '' : control.viewer);
      return;
    }
    if (control.type === 'config') {
      this.applyConfig(control);
      return;
    }
    if (control.type === 'stop') {
      this.stopStreamingAndReply();
      return;
    }
    if (control.type === 'ping') {
      this.sendJson('{"type":"pong"}');
      return;
    }
    this.sendJson('{"type":"error","code":"UNKNOWN_CONTROL"}');
  }

  private startStreaming(viewer: string): void {
    if (this.connection === null) {
      return;
    }
    if (this.streaming) {
      this.sendJson('{"type":"started","proto":1}');
      return;
    }
    this.generation = this.generation + 1;
    this.streaming = true;
    this.framesSent = 0;
    this.framesFailed = 0;
    this.lastFps = 0;
    this.fpsWindowStart = Date.now();
    this.fpsWindowFrames = 0;
    this.lastWaitingNotice = 0;
    console.info(`[VideoStreamServer] 开始取帧 viewer=${viewer.length > 0 ? viewer : 'anonymous'} ` +
      `size=${this.frameWidth}x${this.frameHeight} q=${this.jpegQuality} interval=${this.frameIntervalMs}`);
    this.sendJson(`{"type":"started","proto":${VIDEO_STREAM_PROTO}}`);
    this.scheduleFrame(this.generation, 0);
  }

  private stopStreamingAndReply(): void {
    this.streaming = false;
    this.clearFrameTimer();
    this.sendJson('{"type":"stopped"}');
    console.info(`[VideoStreamServer] 停止取帧（已发送 ${this.framesSent} 帧）`);
    this.notify();
  }

  private scheduleFrame(generation: number, delayMs: number): void {
    if (!this.streaming || generation !== this.generation) {
      return;
    }
    this.timerId = setTimeout((): void => {
      this.timerId = -1;
      this.captureAndSend(generation);
    }, delayMs);
  }

  private async captureAndSend(generation: number): Promise<void> {
    if (!this.streaming || generation !== this.generation || this.captureInFlight) {
      return;
    }
    const connection: socket.TCPSocketConnection | null = this.connection;
    if (connection === null) {
      return;
    }
    const surfaceId: string = this.surfaceProvider === null ? '' : this.surfaceProvider();
    if (surfaceId.length === 0 || !this.isPreviewActive()) {
      const now: number = Date.now();
      if (now - this.lastWaitingNotice >= WAITING_NOTIFY_MS) {
        this.lastWaitingNotice = now;
        this.sendJson('{"type":"waiting","reason":"camera_inactive"}');
        this.notify();
      }
      this.scheduleFrame(generation, 500);
      return;
    }

    this.captureInFlight = true;
    let pixelMap: image.PixelMap | null = null;
    const startedAt: number = Date.now();
    let captureMs: number = 0;
    let scaleMs: number = 0;
    let packMs: number = 0;
    let sendMs: number = 0;
    try {
      const useCrop: boolean = this.cropMode && this.sourceWidth > 0 && this.sourceHeight > 0 &&
        this.frameWidth <= this.sourceWidth && this.frameHeight <= this.sourceHeight;
      if (useCrop) {
        const region: image.Region = {
          size: { width: this.frameWidth, height: this.frameHeight },
          x: Math.floor((this.sourceWidth - this.frameWidth) / 2),
          y: Math.floor((this.sourceHeight - this.frameHeight) / 2)
        };
        pixelMap = await image.createPixelMapFromSurface(surfaceId, region);
      } else {
        pixelMap = await image.createPixelMapFromSurface(surfaceId);
      }
      captureMs = Date.now() - startedAt;
      if (!this.streaming || generation !== this.generation) {
        return;
      }
      if (this.sourceWidth === 0 || this.sourceHeight === 0) {
        const info: image.ImageInfo = await pixelMap.getImageInfo();
        this.sourceWidth = info.size.width;
        this.sourceHeight = info.size.height;
        console.info(`[VideoStreamServer] 相机源画面 ${this.sourceWidth}x${this.sourceHeight}`);
      }
      if (!useCrop && (this.frameWidth !== this.sourceWidth || this.frameHeight !== this.sourceHeight)) {
        const scaleStart: number = Date.now();
        await pixelMap.scale(this.frameWidth / this.sourceWidth, this.frameHeight / this.sourceHeight);
        scaleMs = Date.now() - scaleStart;
        if (!this.streaming || generation !== this.generation) {
          return;
        }
      }
      if (this.sharedPacker === null) {
        this.sharedPacker = image.createImagePacker();
      }
      const packStart: number = Date.now();
      const jpeg: ArrayBuffer = await this.sharedPacker.packToData(pixelMap, {
        format: 'image/jpeg',
        quality: this.jpegQuality
      });
      packMs = Date.now() - packStart;
      if (!this.streaming || generation !== this.generation) {
        return;
      }
      const bytes: number = jpeg.byteLength;
      if (bytes < MIN_JPEG_BYTES || bytes > MAX_JPEG_BYTES) {
        this.framesFailed = this.framesFailed + 1;
        this.lastError = `jpeg size out of range: ${bytes}`;
        return;
      }
      const sendStart: number = Date.now();
      await this.sendFrame(connection, jpeg);
      sendMs = Date.now() - sendStart;
      this.framesSent = this.framesSent + 1;
      this.lastFrameBytes = bytes;
      this.fpsWindowFrames = this.fpsWindowFrames + 1;
      const now: number = Date.now();
      const windowMs: number = now - this.fpsWindowStart;
      if (windowMs >= 1000) {
        this.lastFps = Math.round((this.fpsWindowFrames * 1000) / windowMs);
        this.fpsWindowStart = now;
        this.fpsWindowFrames = 0;
      }
      /* 每 20 帧打印一次真实分段耗时（APP 实际帧率以 APP 自己收到的帧计数为准）。 */
      if (this.framesSent % 20 === 1) {
        console.info(`[VideoStreamServer] frame#${this.framesSent} cap=${captureMs}ms ` +
          `scale=${scaleMs}ms pack=${packMs}ms send=${sendMs}ms size=${this.frameWidth}x${this.frameHeight} ` +
          `q=${this.jpegQuality} bytes=${bytes} fps=${this.lastFps} interval=${this.frameIntervalMs}`);
      }
      this.notify();
    } catch (err) {
      if (this.streaming && generation === this.generation) {
        const error = err as BusinessError;
        this.framesFailed = this.framesFailed + 1;
        this.lastError = `frame failed: ${error.code}`;
        console.warn(`[VideoStreamServer] 取帧/编码失败: ${error.code} - ${error.message}`);
        this.notify();
      }
    } finally {
      if (pixelMap !== null) {
        try {
          await pixelMap.release();
        } catch (err) {
          console.warn('[VideoStreamServer] PixelMap release failed');
        }
      }
      this.captureInFlight = false;
      const elapsed: number = Date.now() - startedAt;
      const delay: number = elapsed >= this.frameIntervalMs ? 0 : this.frameIntervalMs - elapsed;
      this.scheduleFrame(generation, delay);
    }
  }

  /** 控制消息 config：切换分辨率/质量/最小帧间隔（用于实测比较；默认值固化后仍保留以便诊断）。 */
  private applyConfig(control: StreamControl): void {
    this.frameWidth = this.clampInt(control.width, MIN_FRAME_WIDTH, MAX_FRAME_WIDTH, this.frameWidth);
    this.frameHeight = this.clampInt(control.height, MIN_FRAME_HEIGHT, MAX_FRAME_HEIGHT, this.frameHeight);
    this.jpegQuality = this.clampInt(control.quality, MIN_JPEG_QUALITY, MAX_JPEG_QUALITY, this.jpegQuality);
    this.frameIntervalMs = this.clampInt(control.intervalMs, MIN_FRAME_INTERVAL_MS,
      MAX_FRAME_INTERVAL_MS, this.frameIntervalMs);
    if (control.crop !== undefined) {
      this.cropMode = control.crop === 1;
    }
    console.info(`[VideoStreamServer] 配置更新 size=${this.frameWidth}x${this.frameHeight} ` +
      `q=${this.jpegQuality} interval=${this.frameIntervalMs} crop=${this.cropMode ? 1 : 0}`);
    this.sendJson(`{"type":"config","width":${this.frameWidth},"height":${this.frameHeight},` +
      `"quality":${this.jpegQuality},"intervalMs":${this.frameIntervalMs},` +
      `"crop":${this.cropMode ? 1 : 0}}`);
  }

  private clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (value === undefined || typeof value !== 'number' || isNaN(value)) {
      return fallback;
    }
    const v: number = Math.round(value);
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }

  private releaseSharedPacker(): void {
    const packer: image.ImagePacker | null = this.sharedPacker;
    this.sharedPacker = null;
    if (packer !== null) {
      packer.release().catch((err: BusinessError): void => {
        console.warn(`[VideoStreamServer] packer release failed: ${err.code}`);
      });
    }
  }

  private async sendFrame(connection: socket.TCPSocketConnection, jpeg: ArrayBuffer): Promise<void> {
    const length: number = jpeg.byteLength;
    const payload: Uint8Array = new Uint8Array(4 + length);
    payload[0] = (length >>> 24) & 0xFF;
    payload[1] = (length >>> 16) & 0xFF;
    payload[2] = (length >>> 8) & 0xFF;
    payload[3] = length & 0xFF;
    payload.set(new Uint8Array(jpeg), 4);
    await connection.send({ data: payload.buffer });
  }

  private sendJson(text: string): void {
    const connection: socket.TCPSocketConnection | null = this.connection;
    if (connection === null) {
      return;
    }
    connection.send({ data: text + '\n' }).catch((err: BusinessError): void => {
      console.warn(`[VideoStreamServer] 控制消息发送失败: ${err.code}`);
    });
  }

  private isPreviewActive(): boolean {
    return this.previewActiveProvider !== null && this.previewActiveProvider();
  }

  private clearFrameTimer(): void {
    if (this.timerId !== -1) {
      clearTimeout(this.timerId);
      this.timerId = -1;
    }
  }

  private notify(): void {
    if (this.statusListener === null) {
      return;
    }
    const status: VideoStreamStatus = {
      serverListening: this.listening,
      clientConnected: this.clientConnected,
      streaming: this.streaming,
      framesSent: this.framesSent,
      framesFailed: this.framesFailed,
      lastFrameBytes: this.lastFrameBytes,
      lastFps: this.lastFps,
      lastError: this.lastError
    };
    this.statusListener(status);
  }
}
