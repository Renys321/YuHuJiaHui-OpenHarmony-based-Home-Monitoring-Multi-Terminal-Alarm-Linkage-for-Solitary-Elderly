/**
 * 命令下发通道（只负责"发"）
 *
 * 背景：实测发现 socket 的 message 回调与 UI 页面可能持有不同的模块实例，
 *       因此**接收与解析改由页面自身（Index.ets）完成**，确保数据落在 UI 所在的实例上。
 *       本文件只保留发送能力，socket 由页面通过 attach() 注入。
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

  /** 下发命令（如 `ack <告警ID> <处置结果>`），对应事件闭环 */
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
