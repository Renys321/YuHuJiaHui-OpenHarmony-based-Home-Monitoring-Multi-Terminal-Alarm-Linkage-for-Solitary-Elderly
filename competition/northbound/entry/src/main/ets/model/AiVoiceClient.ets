import socket from '@ohos.net.socket';
import buffer from '@ohos.buffer';
import { BusinessError } from '@ohos.base';
import hilog from '@ohos.hilog';

const DOMAIN = 0x0000;
const TAG = 'AiVoiceClient';

const HOST = '127.0.0.1';
const PORT = 9302;
const CONNECT_TIMEOUT_MS = 5000;

export const AI_EVENT_READY = 'ready';
export const AI_EVENT_ASR = 'asr';
export const AI_EVENT_ANSWER = 'answer';
export const AI_EVENT_TTS = 'tts';
export const AI_EVENT_ELDER_SAFE = 'elder_safe';
export const AI_EVENT_ERROR = 'error';
export const AI_EVENT_CLOSED = 'closed';
export const AI_EVENT_S3_ASR = 's3_asr';
export const AI_EVENT_S3_ANSWER = 's3_answer';
export const AI_EVENT_S3_SAFE = 's3_safe';
export const AI_EVENT_S3_ERROR = 's3_error';

export interface AiVoiceEvent {
  type: string;
  text: string;
  code: string;
  wav: Uint8Array | null;
  speakers: number;
  node: string;
  room: string;
  at: number;
}

/** 板端 → PC 的控制消息（字段按 type 选用）。 */
interface ControlMessage {
  type: string;
  protocol?: number;
  codec?: string;
  rate?: number;
  channels?: number;
  text?: string;
  target?: string;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function frame(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(4 + data.length);
  const view = new DataView(buf);
  view.setUint32(0, data.length, false);
  new Uint8Array(buf).set(data, 4);
  return buf;
}

/**
 * 板端 → PC 语音网关的 TCP 客户端。
 *
 * 控制消息是一行 JSON（\n 结尾），音频是 [u32be len][bytes]。页面用它订阅
 * S3/网关事件、发送文字或录音；断线统一通过 AI_EVENT_CLOSED 上报。
 */
export class AiVoiceClient {
  private tcp: socket.TCPSocket | null = null;
  private rx: Uint8Array = new Uint8Array(0);
  private expectWav = 0;
  private ttsSpeakers = 0;
  private sendChain: Promise<void> = Promise.resolve();
  private lastSendError: Error | null = null;
  private listener: (event: AiVoiceEvent) => void;
  private stopping = false;
  private closedEmitted = false;

  constructor(listener: (event: AiVoiceEvent) => void) {
    this.listener = listener;
  }

  private emit(type: string, text: string, code: string, wav: Uint8Array | null,
    speakers: number = 0, node: string = '', room: string = '', at: number = 0): void {
    try {
      this.listener({
        type: type, text: text, code: code, wav: wav, speakers: speakers,
        node: node, room: room, at: at
      });
    } catch (e) {
      hilog.error(DOMAIN, TAG, '%{public}s', '事件回调异常');
    }
  }

  private emitClosed(): void {
    if (this.closedEmitted) {
      return;
    }
    this.closedEmitted = true;
    this.emit(AI_EVENT_CLOSED, '语音网关未连接', 'DISCONNECTED', null);
  }

  async connect(): Promise<void> {
    const tcp = socket.constructTCPSocketInstance();
    this.tcp = tcp;
    tcp.on('message', (info: socket.SocketMessageInfo) => {
      this.onData(new Uint8Array(info.message));
    });
    tcp.on('close', () => {
      hilog.info(DOMAIN, TAG, '%{public}s', '网关连接已关闭');
      if (!this.stopping) {
        this.emitClosed();
      }
    });
    tcp.on('error', (err: BusinessError) => {
      hilog.error(DOMAIN, TAG, 'TCP 错误: %{public}s', err.message);
    });

    const addr: socket.NetAddress = { address: HOST, port: PORT };
    await tcp.connect({ address: addr, timeout: CONNECT_TIMEOUT_MS });
    hilog.info(DOMAIN, TAG, '%{public}s', '已连接语音网关 127.0.0.1:9302');
    this.sendJson({ type: 'hello', protocol: 1 });
  }

  /** 所有发送串成一条链：TCP send 不保证顺序，音频分片必须排队。 */
  private sendRaw(data: string | ArrayBuffer): void {
    this.sendChain = this.sendChain.then(() => {
      const tcp = this.tcp;
      if (tcp === null) {
        return Promise.reject(new Error('socket closed'));
      }
      return tcp.send({ data: data });
    }).catch((err: BusinessError) => {
      this.lastSendError = new Error(err.message.length > 0 ? err.message : 'send failed');
    });
  }

  private sendJson(obj: ControlMessage): void {
    this.sendRaw(JSON.stringify(obj) + '\n');
  }

  private sendBytes(data: Uint8Array): void {
    this.sendRaw(frame(data));
  }

  /** 等所有已排队的发送完成；失败会抛出。 */
  async flush(): Promise<void> {
    await this.sendChain;
    if (this.lastSendError !== null) {
      const err = this.lastSendError;
      this.lastSendError = null;
      throw err;
    }
  }

  async sendPcm(pcm: Uint8Array): Promise<void> {
    this.sendJson({ type: 'audio_start', codec: 'pcm_s16le', rate: 44100, channels: 1 });
    let off = 0;
    while (off < pcm.length) {
      const end = Math.min(off + 3200, pcm.length);
      this.sendBytes(pcm.subarray(off, end));
      off = end;
    }
    this.sendJson({ type: 'audio_end' });
    await this.flush();
  }

  async sendText(text: string, target: string = ''): Promise<void> {
    this.sendJson({ type: 'text_query', text: text, target: target });
    await this.flush();
  }

  /** 长连接保活：网关 25 秒空闲会断开，页面每 10 秒调用一次。 */
  ping(): void {
    this.sendJson({ type: 'ping' });
  }

  private onData(data: Uint8Array): void {
    this.rx = this.rx.length === 0 ? data : concatBytes(this.rx, data);
    try {
      this.parse();
    } catch (e) {
      hilog.error(DOMAIN, TAG, '%{public}s', '接收解析失败');
      this.emit(AI_EVENT_ERROR, '网关返回数据无法解析', 'PROTOCOL', null);
      this.close();
    }
  }

  private parse(): void {
    for (;;) {
      if (this.expectWav > 0) {
        if (this.rx.length < 4) {
          return;
        }
        if (this.rx[0] === 0x7B) {
          // '{' 说明先来的是控制行（例如 tts_end），不是 WAV 的长度头。
          const nl = this.indexOfNewline(0);
          if (nl < 0) {
            return;
          }
          const line = buffer.from(this.rx.buffer, this.rx.byteOffset, nl).toString('utf8');
          this.rx = this.rx.subarray(nl + 1);
          this.expectWav = 0;
          this.handleJson(line);
          continue;
        }
        const view = new DataView(this.rx.buffer, this.rx.byteOffset, this.rx.byteLength);
        const len = view.getUint32(0, false);
        if (len <= 0 || len > 4 * 1024 * 1024) {
          throw new Error('invalid wav frame');
        }
        if (this.rx.length < 4 + len) {
          return;
        }
        const wav = this.rx.subarray(4, 4 + len);
        this.rx = this.rx.subarray(4 + len);
        this.expectWav = 0;
        this.emit(AI_EVENT_TTS, '', '', new Uint8Array(wav), this.ttsSpeakers);
        continue;
      }

      const nl = this.indexOfNewline(0);
      if (nl < 0) {
        if (this.rx.length > 65536) {
          throw new Error('line too long');
        }
        return;
      }
      const line = buffer.from(this.rx.buffer, this.rx.byteOffset, nl).toString('utf8');
      this.rx = this.rx.subarray(nl + 1);
      if (line.length > 0) {
        this.handleJson(line);
      }
    }
  }

  private indexOfNewline(from: number): number {
    for (let i = from; i < this.rx.length; i++) {
      if (this.rx[i] === 0x0A) {
        return i;
      }
    }
    return -1;
  }

  private handleJson(line: string): void {
    let msg: Record<string, Object>;
    try {
      msg = JSON.parse(line) as Record<string, Object>;
    } catch (e) {
      throw new Error('bad json');
    }
    const type = typeof msg.type === 'string' ? msg.type as string : '';
    const text = typeof msg.text === 'string' ? msg.text as string : '';
    const node = typeof msg.node === 'string' ? msg.node as string : '';
    const room = typeof msg.room === 'string' ? msg.room as string : '';
    const at = typeof msg.at === 'number' ? msg.at as number : 0;
    const speakers = typeof msg.speakers === 'number' ? msg.speakers as number : 0;
    switch (type) {
      case 'ready':
        this.emit(AI_EVENT_READY, '', '', null);
        break;
      case 'asr':
      case 'answer':
      case 's3_asr':
      case 's3_answer':
        this.emit(type, text, '', null, speakers, node, room, at);
        break;
      case 'elder_safe':
      case 's3_safe':
        this.emit(type, text.length > 0 ? text : '老人自述安全',
          '', null, speakers, node, room, at);
        break;
      case 's3_error': {
        const code = typeof msg.code === 'string' ? msg.code as string : 'ERROR';
        const message = typeof msg.message === 'string' ? msg.message as string : '语音服务失败';
        this.emit(AI_EVENT_S3_ERROR, message, code, null, speakers, node, room, at);
        break;
      }
      case 'tts_start':
        this.expectWav = typeof msg.bytes === 'number' ? msg.bytes as number : 0;
        this.ttsSpeakers = speakers;
        break;
      case 'error': {
        const code = typeof msg.code === 'string' ? msg.code as string : 'ERROR';
        const message = typeof msg.message === 'string' ? msg.message as string : '语音服务失败';
        this.emit(AI_EVENT_ERROR, message, code, null);
        this.close();
        break;
      }
      default:
        hilog.warn(DOMAIN, TAG, '未知消息: %{public}s', type);
    }
  }

  close(): void {
    this.stopping = true;
    const tcp = this.tcp;
    this.tcp = null;
    if (tcp !== null) {
      try {
        tcp.off('message');
        tcp.off('close');
        tcp.off('error');
      } catch (e) {
        // 忽略
      }
      try {
        tcp.close();
      } catch (e) {
        // 忽略
      }
    }
    this.rx = new Uint8Array(0);
    this.expectWav = 0;
  }
}
