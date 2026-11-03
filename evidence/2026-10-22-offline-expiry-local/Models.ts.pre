/**
 * APP 内部视图模型（纯数据，不含 UI 装饰器）—— 可被 Node 测试。
 * 页面通过 @StorageLink('gv.*') 读取这些类的实例/数组。
 */
import { SensorKind, SensorTileState, ValidityState } from '../capability/DeviceCapabilities';

/** AppStorage 键（页面/服务统一使用，避免字符串拼写漂移）。 */
export class AppKeys {
  static readonly DEVICES: string = 'gv.devices';
  static readonly ROOMS: string = 'gv.rooms';
  static readonly ALERTS: string = 'gv.alerts';
  static readonly OVERVIEW: string = 'gv.overview';
  static readonly CONTACTS: string = 'gv.contacts';
  static readonly NET_STATUS: string = 'gv.netStatus';
  static readonly NET_MESSAGE: string = 'gv.netMessage';
  static readonly LAST_UPDATED_AT: string = 'gv.lastUpdatedAt';
  static readonly DATA_SOURCE: string = 'gv.dataSource';
  static readonly GUARDIAN_ID: string = 'gv.guardianId';
  static readonly TOKEN_STORAGE: string = 'gv.tokenStorage';
  static readonly MODE: string = 'gv.mode';
}

/** 运行模式：真实后端会话 / 独立本地演示 / 未选择。演示状态只驻留内存。 */
export class RunMode {
  static readonly REAL: string = 'real';
  static readonly DEMO: string = 'demo';
  static readonly NONE: string = '';
}

export class NetworkState {
  static readonly UNKNOWN: string = 'unknown';
  static readonly LOADING: string = 'loading';
  static readonly OK: string = 'ok';
  static readonly PARTIAL: string = 'partial';
  static readonly OFFLINE: string = 'offline';
  static readonly ERROR: string = 'error';
  static readonly UNAUTHORIZED: string = 'unauthorized';
}

export class DataSource {
  static readonly API: string = 'api';
  static readonly NONE: string = 'none';
  /** 本地示例数据：仅演示模式使用，不来自 API。 */
  static readonly DEMO: string = 'demo';
}

export class SensorView {
  id: string = '';
  deviceId: string = '';
  roomId: string = '';
  roomName: string = '';
  kind: SensorKind = 'motion';
  name: string = '';
  valueText: string = '--';
  detailText: string = '';
  state: SensorTileState = 'unknown';
  stateText: string = '待确认';
  /** 颜色语义 token：success/warning/critical/info/neutral；只有 ok 才允许 success。 */
  colorToken: string = 'neutral';
  lastUpdateTs: number = 0;
  installed: boolean = false;
  enabled: boolean = false;
  alarmEnabled: boolean = false;
  validity: ValidityState = 'unknown';
}

export class DeviceView {
  id: string = '';
  deviceId: string = '';
  name: string = '';
  roomId: string = '';
  roomName: string = '';
  location: string = '';
  online: boolean = false;
  /** 1 正常 / 0 监测离线 / -1 未上报（未知） */
  monitorOnline: number = -1;
  state: string = '';
  stateText: string = '未知';
  monitorText: string = '监测状态未知';
  lastSeenTs: number = 0;
  /** 0-31 有效；99/-1 未知 */
  csq: number = -1;
  sensors: SensorView[] = [];
  capabilitySummary: string = '';
  capabilityNote: string = '';
  capabilityVerified: boolean = false;
}

export class RoomView {
  id: string = '';
  name: string = '';
  location: string = '';
  state: string = '';
  onlineDeviceCount: number = 0;
  deviceCount: number = 0;
  devices: DeviceView[] = [];
  /** 服务端 rooms 未覆盖、由 devices.roomId 合成的未分配分组 */
  isSynthetic: boolean = false;
}

export class AlertView {
  id: string = '';
  alarmId: string = '';
  deviceId: string = '';
  roomName: string = '';
  type: string = '';
  message: string = '';
  state: string = '';
  ackPending: boolean = false;
  /** 'pending' 待确认 / 'waiting' 等待设备确认 / 'acked' 设备已确认 / 'unknown' 状态未知 */
  statusKey: string = 'unknown';
  statusText: string = '状态未知';
  level: string = 'medium';
  sensorType: SensorKind = 'motion';
  title: string = '';
  description: string = '';
  location: string = '';
  createdAt: number = 0;
  acknowledgedAt: number = 0;
  acknowledgedBy: string = '';
  acknowledgedText: string = '';
  evidenceAvailable: boolean = false;
  evidenceId: string = '';
  evidenceBytes: number = 0;
  evidenceCapturedAt: number = 0;
}

export class LocationView {
  deviceId: string = '';
  location: string = '';
  latitude: number = 0;
  longitude: number = 0;
  fixTime: number = 0;
  text: string = '';
}

export class OverviewView {
  hasData: boolean = false;
  generatedAt: number = 0;
  deviceCount: number = 0;
  onlineCount: number = 0;
  monitorOfflineCount: number = 0;
  activeAlertCount: number = 0;
  latestAlert: AlertView | null = null;
  locationText: string = '';
}

export class ContactView {
  id: string = '';
  name: string = '';
  relation: string = '';
  phone: string = '';
  primary: boolean = false;
}

/** 全局网络快照（页面直接显示 message）。 */
export class NetSnapshot {
  status: string = NetworkState.UNKNOWN;
  message: string = '';
  lastUpdatedAt: number = 0;
  dataSource: string = DataSource.NONE;
}
