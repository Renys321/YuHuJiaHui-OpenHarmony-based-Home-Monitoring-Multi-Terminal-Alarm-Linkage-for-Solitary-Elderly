/**
 * 平台层：@ohos.net.webSocket 适配器（唯一直接使用 WebSocket 网络栈的源码）。
 *
 * 只负责连接/收发/关闭，不做任何业务判断；业务状态机在 core/video/VideoVisitController.ts。
 * 安全：URL 中只有一次性 ticket（60s TTL、一次性），不打印 URL/ticket/token。
 */
import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { VideoSocketListener, VideoSocketPort } from '../core/video/VideoVisitController';

export class HarmonyVideoSocket implements VideoSocketPort {
  private ws: webSocket.WebSocket | null = null;
  private listener: VideoSocketListener | null = null;

  connect(url: string, listener: VideoSocketListener): void {
    this.listener = listener;
    const ws: webSocket.WebSocket = webSocket.createWebSocket();
    this.ws = ws;
    ws.on('open', (err: BusinessError, value: Object): void => {
      if (this.listener !== null) {
        this.listener.onOpen();
      }
    });
    ws.on('message', (err: BusinessError, value: string | ArrayBuffer): void => {
      const target: VideoSocketListener | null = this.listener;
      if (target === null) return;
      if (typeof value === 'string') {
        target.onText(value);
        return;
      }
      target.onBinary(value as ArrayBuffer);
    });
    ws.on('close', (err: BusinessError, value: webSocket.CloseResult): void => {
      const target: VideoSocketListener | null = this.listener;
      if (target === null) return;
      const code: number = value !== null && value !== undefined && typeof value.code === 'number'
        ? value.code : 0;
      const reason: string = value !== null && value !== undefined && typeof value.reason === 'string'
        ? value.reason : '';
      target.onClose(code, reason);
    });
    ws.on('error', (err: BusinessError): void => {
      const target: VideoSocketListener | null = this.listener;
      if (target === null) return;
      const message: string = err !== null && err !== undefined && typeof err.message === 'string' &&
        err.message.length > 0 ? err.message : 'websocket error';
      target.onError(message);
    });
    ws.connect(url, (err: BusinessError, ok: boolean): void => {
      if (err !== null && err !== undefined && typeof err.code === 'number' && err.code !== 0) {
        const target: VideoSocketListener | null = this.listener;
        if (target !== null) {
          const message: string = typeof err.message === 'string' && err.message.length > 0
            ? err.message : 'websocket connect failed';
          target.onError(message);
        }
      }
    });
  }

  /** 关闭连接并解除回调绑定（stop 之后所有迟到事件都被丢弃）。 */
  close(): void {
    const ws: webSocket.WebSocket | null = this.ws;
    this.ws = null;
    this.listener = null;
    if (ws === null) return;
    ws.close().then((closed: boolean): void => {
    }).catch((err: BusinessError): void => {
    });
  }
}
