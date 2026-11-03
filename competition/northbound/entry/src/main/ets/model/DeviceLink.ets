/**
 * 命令下发通道，只管发。
 * 收包和解析放在 Index.ets：socket 的 message 回调与页面可能不是同一个模块实例。
 * socket 由页面通过 attach() 注入。
 */
import socket from '@ohos.net.socket';
import { BusinessError } from '@ohos.base';

export class DeviceLink {
  private static tcp: socket.TCPSocket | null = null;

  /** 由页面把已连接的 socket 注入进来 */
  static attach(tcp: socket.TCPSocket): void {
    DeviceLink.tcp = tcp;
  }

  static detach(): void {
    DeviceLink.tcp = null;
  }

  /** 下发命令，如 `ack <告警ID> <处置结果>`，事件闭环走这条 */
  static send(text: string): void {
    const tcp = DeviceLink.tcp;
    if (tcp === null) {
      console.warn('[DeviceLink] socket 未注入，命令未下发: ' + text);
      return;
    }
    tcp.send({ data: text })
      .then(() => {
        console.info('[DeviceLink] 已下发: ' + text.trim());
      })
      .catch((err: BusinessError) => {
        console.error('[DeviceLink] 下发失败: ' + err.message);
      });
  }
}
