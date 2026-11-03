import { DeviceView, OverviewView, AlertView } from './Models';

export class HomeMetrics {
  static hasDeviceData(overview: OverviewView, devices: DeviceView[], netStatus: string): boolean {
    return overview.hasData || devices.length > 0 || netStatus === 'ok';
  }

  static deviceCount(overview: OverviewView, devices: DeviceView[]): number {
    if (overview.hasData) return overview.deviceCount;
    return devices.length;
  }

  static onlineCount(overview: OverviewView, devices: DeviceView[]): number {
    if (overview.hasData) return overview.onlineCount;
    let count: number = 0;
    for (let i = 0; i < devices.length; i++) {
      if (devices[i].online) count++;
    }
    return count;
  }

  static monitorOfflineCount(overview: OverviewView, devices: DeviceView[]): number {
    if (overview.hasData) return overview.monitorOfflineCount;
    let count: number = 0;
    for (let i = 0; i < devices.length; i++) {
      if (devices[i].online && devices[i].monitorOnline === 0) count++;
    }
    return count;
  }

  static offlineCount(overview: OverviewView, devices: DeviceView[]): number {
    const total: number = HomeMetrics.deviceCount(overview, devices);
    const online: number = HomeMetrics.onlineCount(overview, devices);
    const offline: number = total - online;
    return offline > 0 ? offline : 0;
  }

  static pendingAlertCount(alerts: AlertView[]): number {
    let count: number = 0;
    for (let i = 0; i < alerts.length; i++) {
      if (alerts[i].statusKey === 'pending') count++;
    }
    return count;
  }
}
