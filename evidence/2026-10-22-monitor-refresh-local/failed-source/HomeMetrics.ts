/**
 * 首页统计的纯展示派生逻辑。
 *
 * overview 是服务端聚合接口；当该接口不可用但 devices/alerts 已经拿到真实
 * 数据时，首页仍应使用同一批真实设备数据展示，而不是显示 `--`。
 * 这里只做“已有真实数据的选择与计数”，不编造未知指标。
 */
import { DeviceView, OverviewView, AlertView } from './Models';

export class HomeMetrics {
  /**
   * 设备维度是否有真实数据：overview 成功，或 devices 已成功返回非空列表。
   * 空设备列表 + overview 失败 => 不能把失败/空当成 0 展示。
   */
  static hasDeviceData(overview: OverviewView, devices: DeviceView[], netStatus: string): boolean {
    return overview.hasData || devices.length > 0 || netStatus === 'ok';
  }

  static deviceCount(overview: OverviewView, devices: DeviceView[]): number {
    // devices 快照存在时，以同一批设备为准，避免 overview 与监测页版本不一致。
    if (devices.length > 0) return devices.length;
    if (overview.hasData) return overview.deviceCount;
    return devices.length;
  }

  static onlineCount(overview: OverviewView, devices: DeviceView[]): number {
    if (devices.length > 0) {
      let count: number = 0;
      for (let i = 0; i < devices.length; i++) {
        if (devices[i].online) count++;
      }
      return count;
    }
    if (overview.hasData) return overview.onlineCount;
    return 0;
  }

  static monitorOfflineCount(overview: OverviewView, devices: DeviceView[]): number {
    if (devices.length > 0) {
      let count: number = 0;
      for (let i = 0; i < devices.length; i++) {
        if (devices[i].online && devices[i].monitorOnline === 0) count++;
      }
      return count;
    }
    if (overview.hasData) return overview.monitorOfflineCount;
    return 0;
  }

  static offlineCount(overview: OverviewView, devices: DeviceView[]): number {
    const total: number = HomeMetrics.deviceCount(overview, devices);
    const online: number = HomeMetrics.onlineCount(overview, devices);
    const offline: number = total - online;
    return offline > 0 ? offline : 0;
  }

  /** 待确认告警只按 alert.statusKey 计算，不把设备当前 ALARM 数量当告警总数。 */
  static pendingAlertCount(alerts: AlertView[]): number {
    let count: number = 0;
    for (let i = 0; i < alerts.length; i++) {
      if (alerts[i].statusKey === 'pending') count++;
    }
    return count;
  }
}
