/**
 * APP 内部视图模型（纯数据，不含 UI 装饰器）—— 可被 Node 测试。
 * 页面通过 @StorageLink('gv.*') 读取这些类的实例/数组。
 */
import { SensorKind, SensorTileState, ValidityState } from '../capability/DeviceCapabilities';

/** AppStorage 键（页面/服务统一使用，避免字符串拼写漂移）。 */
export class AppKeys {
  static readonly DEVICES: string = 'gv.devices';
  /** 后端有记录但不在家庭设备清单内的设备（不参与监护统计，只如实列出）。 */
  static readonly UNRECOGNIZED_DEVICES: string = 'gv.unrecognizedDevices';
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
  /** 活动报告（GET /api/v1/activity/report）：报告视图 + 加载状态 + 错误文案。 */
  static readonly ACTIVITY_REPORT: string = 'gv.activityReport';
  static readonly ACTIVITY_STATUS: string = 'gv.activityStatus';
  static readonly ACTIVITY_MESSAGE: string = 'gv.activityMessage';
  /** 门磁开关事件（GET /api/v1/door-events）：按设备缓存最近记录 + 加载状态 + 错误文案。 */
  static readonly DOOR_EVENTS: string = 'gv.doorEvents';
  static readonly DOOR_EVENTS_STATUS: string = 'gv.doorEventsStatus';
  static readonly DOOR_EVENTS_MESSAGE: string = 'gv.doorEventsMessage';
  /** 健康科普评估（GET/PUT /api/v1/health-profile + POST /api/v1/health-advice）。 */
  static readonly HEALTH_PROFILE: string = 'gv.healthProfile';
  static readonly HEALTH_STATUS: string = 'gv.healthStatus';
  static readonly HEALTH_MESSAGE: string = 'gv.healthMessage';
  static readonly HEALTH_ADVICE: string = 'gv.healthAdvice';
  static readonly HEALTH_ADVICE_STATUS: string = 'gv.healthAdviceStatus';
  static readonly HEALTH_ADVICE_MESSAGE: string = 'gv.healthAdviceMessage';
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
  /** 'household' 已核实家庭设备 / 'unrecognized' 后端记录但未纳入监护 */
  deviceClass: string = 'unrecognized';
  /** 已核实设备台账来源；未识别设备为空。 */
  inventorySource: string = '';
  /** 设备角色（例如“房间环境节点”），来自已核实台账。 */
  inventoryRole: string = '';
  /** 是否已分配到已知房间；false = 未分配房间（不伪造默认房间）。 */
  roomAssigned: boolean = false;
  online: boolean = false;
  /** 1 正常 / 0 监测离线 / -1 未上报（未知） */
  monitorOnline: number = -1;
  state: string = '';
  stateText: string = '未知';
  monitorText: string = '监测状态未知';
  lastSeenTs: number = 0;
  /** 最近上报相对时间（真实时间；0 显示“时间未知”）。 */
  lastSeenText: string = '时间未知';
  /** 0-31 有效；99/-1 未知 */
  csq: number = -1;
  sensors: SensorView[] = [];
  /** 是否存在可展示的历史读数（用于区分“无历史读数”和“离线”）。 */
  hasReading: boolean = false;
  capabilitySummary: string = '';
  capabilityNote: string = '';
  capabilityVerified: boolean = false;
  /** 电量能力：本轮无任何板卡接入真实电量采样，supported=false 时绝不显示百分比。 */
  batterySupported: boolean = false;
  /** 'not-supported' | 'unavailable' | 'ok' */
  batteryState: string = 'not-supported';
  batteryStateText: string = '该设备未接入电量检测';
  batteryDetail: string = '';
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

/**
 * 告警内嵌随身求助定位（MANUAL_SOS + esp32-sos 才有）。
 * latitude/longitude 保留后端原始 WGS84；GCJ-02 转换只在 core/location/SosLocation.ts 做一次。
 */
export class SosLocationView {
  /** 服务端响应里是否真的出现 sosLocation 字段（false = 字段缺失）。 */
  present: boolean = false;
  /** 'LOCATED' | 'STALE' | 'UNAVAILABLE'（未知值已归一为 UNAVAILABLE）。 */
  status: string = 'UNAVAILABLE';
  latitude: number | null = null;
  longitude: number | null = null;
  positionTime: number = 0;
  receivedAt: number = 0;
  ageSeconds: number | null = null;
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
  /**
   * 告警类型与该设备真实能力的核对提示（例如“厨房节点未安装 PIR”）。
   * 非空时页面必须如实提示“请核实”，不能把历史/测试告警当真实硬件事件处置。
   */
  capabilityWarning: string = '';
  /** 可选：随身求助定位；null = 服务端未返回（页面走 /api/v1/location 兜底）。 */
  sosLocation: SosLocationView | null = null;
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

/**
 * 处置结果 / 安全日志视图（告警详情处置面板与安全日志页共用）。
 * 时间语义：hasValidServerTime=false / hasValidAlarmCreatedAt=false 时 UI 必须显示“时间未知”，
 * 绝不把缺失或 0 的 serverTime 当成 1970-01-01 这样的有效时间。
 */
export class DispositionView {
  dispositionId: string = '';
  alarmId: string = '';
  deviceId: string = '';
  roomName: string = '';
  roomText: string = '房间未知';
  alarmType: string = '';
  alarmTypeLabel: string = '告警';
  alarmCreatedAt: number = 0;
  hasValidAlarmCreatedAt: boolean = false;
  outcome: string = '';
  outcomeLabel: string = '未知结果';
  note: string = '';
  operator: string = '';
  operatorText: string = '处理人未知';
  operatorRole: string = '';
  serverTime: number = 0;
  /** 服务端处理时间是否有效；false 时页面只显示“服务端时间未知”。 */
  hasValidServerTime: boolean = false;
}

/** 全局网络快照（页面直接显示 message）。 */
export class NetSnapshot {
  status: string = NetworkState.UNKNOWN;
  message: string = '';
  lastUpdatedAt: number = 0;
  dataSource: string = DataSource.NONE;
}

/**
 * 门磁开关事件视图（设备详情"最近开关记录"区块使用）。
 * 时间语义：occurredAt 为事件发生时间（timeSource=device 时来自设备可信时钟，
 * timeSource=server 时为服务器接收时间）；hasValidOccurredAt=false 时 UI 显示"时间未知"，
 * 绝不把 0 当成有效时间。open 缺失（openPresent=false）按"未知"处理。
 */
export class DoorEventView {
  eventId: string = '';
  deviceId: string = '';
  roomName: string = '';
  openPresent: boolean = false;
  open: boolean = false;
  occurredAt: number = 0;
  hasValidOccurredAt: boolean = false;
  timeSource: string = 'server';
  timeSourceText: string = '服务器时间';
  seq: number = 0;
  source: string = '';
  actionText: string = '状态未知';
  timeText: string = '时间未知';
}
