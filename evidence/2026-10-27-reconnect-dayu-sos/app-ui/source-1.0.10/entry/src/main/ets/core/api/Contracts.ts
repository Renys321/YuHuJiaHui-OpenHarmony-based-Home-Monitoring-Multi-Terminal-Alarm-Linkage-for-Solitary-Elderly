/**
 * APP API v1 响应 DTO 与防御式解析。
 *
 * 合同：D:\OpenHarmony\competition\docs\APP-API-v1.md（v1.0.0）
 *      + competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md（v1 增量：
 *        处置结果 dispositions / 安全日志 safety-logs，独立于 ACK）
 * 规则：忽略未来新增字段；不让缺字段/类型错误把页面打崩；不根据错误文案做业务判断。
 * 注意：旧云端适配器可能剥离 sensors.*.valid；DTO 中保留 valid 三态（可能为 null=未知）。
 * 新网关会保留该字段，旧数据/旧设备缺失时仍按未知处理。
 */
import {
  asArray, asBoolean, asFiniteNumber, asObject, asString, asTriStateBoolean,
  isRecord, parseJsonObject
} from '../util/Json';
import {
  ActivityComparisonState, ActivityScope, ActivityStatus, ActivityTrendState
} from '../activity/ActivityModels';
import { HealthProfileDto } from '../health/HealthModels';
import {
  HealthAdviceDto, HealthAdviceParseResult, HealthProfileParseResult,
  parseHealthAdviceResponse, parseHealthProfileResponse
} from '../health/HealthAdvice';

export class LoginDto {
  sessionToken: string = '';
  tokenType: string = '';
  expiresIn: number = 0;
}

export class MotionSensorDto {
  lastActiveTs: number = 0;
  countToday: number = 0;
  /** 字段是否真实出现在响应中；缺失时不得把默认 0 当作真实“0 次”。 */
  lastActiveTsPresent: boolean = false;
  countTodayPresent: boolean = false;
  /**
   * 2026-10-27 homemon 能力契约（sensors.motion.supported）：
   * true=该设备具备 PIR；false=未配置 PIR（APP 显示“未配置 PIR，无活动监测”）。
   * 缺失（supportedPresent=false）=旧数据，APP 回退到已核实能力表，保持旧行为。
   */
  supported: boolean | null = null;
  supportedPresent: boolean = false;
  /**
   * 2026-10-27 homemon 数据契约（sensors.motion.reported）：
   * false=本次未上报有效 PIR 活动数据（APP 显示“暂无有效 PIR 数据”）；缺失=旧数据（按原逻辑）。
   */
  reported: boolean | null = null;
  reportedPresent: boolean = false;
  /** 未配置/未上报原因短码（后端原样字段 reason；空=未上报）。 */
  reason: string = '';
}

export class DoorSensorDto {
  /** open 字段是否真实出现在响应中；缺失时不得把默认 false 当作真实"门已关闭"。 */
  openPresent: boolean = false;
  open: boolean = false;
  lastOpenTs: number = 0;
  lastCloseTs: number = 0;
  /** 设备端事件序号（补传缓存去重用）；0 = 无序号。 */
  seq: number = 0;
}

/**
 * 门磁开关事件（GET /api/v1/door-events 的 events 数组元素）。
 * 时间语义：occurredAt 为事件发生时间；timeSource=device 表示来自设备可信时钟，
 * timeSource=server 表示服务器接收时间（设备无可信时钟时的权威排序时间）。
 */
export class DoorEventDto {
  eventId: string = '';
  deviceId: string = '';
  roomName: string = '';
  openPresent: boolean = false;
  open: boolean = false;
  occurredAt: number = 0;
  timeSource: string = 'server';
  seq: number = 0;
  source: string = '';
}

export class ClimateSensorDto {
  tempC: number | null = null;
  rh: number | null = null;
  ok: boolean | null = null;
  valid: boolean | null = null;
}

export class RawSensorDto {
  raw: number | null = null;
  ok: boolean | null = null;
  valid: boolean | null = null;
}

export class WaterSensorDto {
  wet: boolean | null = null;
  valid: boolean | null = null;
}

/**
 * 设备电量 DTO（BATTERY-CHAIN-CONTRACT §2；固件/网关/后端 status JSON 顶层 `battery`）。
 *
 * 严格解析规则（缺数据绝不默认 0 / 100）：
 * - `battery` 整体缺失 / null / 非对象 / source 不是 battery|fixed → DeviceDto.battery = null；
 * - 已知字段类型或范围非法 → 该字段保持 null（未知），其余合法字段保留；
 * - percent 只在 calibrated=true 时由视图层展示，DTO 不做任何换算；
 * - sensors 内嵌套 battery 也接受（兼容旧网关），顶层优先。
 */
export class BatteryDto {
  /** 'battery' 电池设备 / 'fixed' 固定供电。其他值视为非法（整体按缺失处理）。 */
  source: string = '';
  /** 设备是否报告有电池；null = 未上报（未知）。 */
  present: boolean | null = null;
  /** 采样是否有效；null = 未上报（未知）。 */
  valid: boolean | null = null;
  /** 电池电压（mV，0–60000 整数）；null = 未上报。0 由视图层按无效处理。 */
  mv: number | null = null;
  /** 百分比（0–100 整数）；只有 calibrated=true 时才允许展示。 */
  percent: number | null = null;
  low: boolean | null = null;
  calibrated: boolean | null = null;
  /** 无效/不可用短码 [A-Z_]{0,16}；缺失或非法 → ''。 */
  reason: string = '';
  /** 采样时间（epoch ms，可选）；0 = 未上报。 */
  sampledAt: number = 0;
}

export class SensorsDto {
  motion: MotionSensorDto | null = null;
  door: DoorSensorDto | null = null;
  climate: ClimateSensorDto | null = null;
  gas: RawSensorDto | null = null;
  smoke: RawSensorDto | null = null;
  water: WaterSensorDto | null = null;
  /** 兼容旧网关把 battery 嵌在 sensors 内；缺失 → null。 */
  battery: BatteryDto | null = null;
  /** 服务端未来新增、APP 尚未识别的 sensors 子字段名 */
  unknownKeys: string[] = [];
}

export class DeviceDto {
  id: string = '';
  deviceId: string = '';
  name: string = '';
  roomId: string = '';
  roomName: string = '';
  location: string = '';
  online: boolean = false;
  /** 1 正常 / 0 监测离线 / -1 未上报 */
  monitorOnline: number = -1;
  state: string = '';
  lastSeenTs: number = 0;
  /** 视觉监测离线原因短码（后端 monitorReason，原样；空=未上报）。只做展示说明，不推断。 */
  monitorReason: string = '';
  sensors: SensorsDto = new SensorsDto();
  /** 0-31 有效；99 或缺失 = -1 未知 */
  csq: number = -1;
  /** 电量：来自后端设备对象顶层 `battery`（兼容 sensors 内嵌套）；缺失 → null。 */
  battery: BatteryDto | null = null;
}

export class RoomDto {
  id: string = '';
  name: string = '';
  location: string = '';
  state: string = '';
  onlineDeviceCount: number = 0;
  deviceCount: number = 0;
  devices: DeviceDto[] = [];
}

export class AlertEvidenceDto {
  available: boolean = false;
  evidenceId: string = '';
  bytes: number = 0;
  capturedAt: number = 0;
}

/**
 * 告警内嵌的随身求助定位（GET /api/v1/alerts 的可选字段 `sosLocation`）。
 * 只有 deviceId=esp32-sos 的 MANUAL_SOS 告警会带；可能整体缺失。
 * 字段语义由后端决定：status ∈ LOCATED/STALE/UNAVAILABLE；
 * latitude/longitude 是 **WGS84**（APP 只在 core/location/SosLocation.ts 转 GCJ-02 一次）。
 */
export class SosLocationDto {
  /** 响应里确实出现 sosLocation 字段（区别于“字段缺失”）。 */
  present: boolean = false;
  status: string = 'UNAVAILABLE';
  latitude: number | null = null;
  longitude: number | null = null;
  positionTime: number = 0;
  receivedAt: number = 0;
  ageSeconds: number | null = null;
}

export class AlertDto {
  id: string = '';
  alarmId: string = '';
  deviceId: string = '';
  roomName: string = '';
  type: string = '';
  message: string = '';
  state: string = '';
  ackPending: boolean = false;
  createdAt: number = 0;
  acknowledgedAt: number = 0;
  acknowledgedBy: string = '';
  evidence: AlertEvidenceDto = new AlertEvidenceDto();
  /** 可选：随身求助定位；缺失/结构非法一律 null（页面按“无定位”处理，不猜测）。 */
  sosLocation: SosLocationDto | null = null;
}

/**
 * GET /api/v1/location 的 locations[] 元素。
 * 来自后端设备 GPS（不是 sosLocation 的兜底专用接口，但可用于取最近定位）。
 */
export class LocationPointDto {
  deviceId: string = '';
  location: string = '';
  latitude: number | null = null;
  longitude: number | null = null;
  fixTime: number = 0;
}

export class OverviewDto {
  generatedAt: number = 0;
  deviceCount: number = 0;
  onlineCount: number = 0;
  monitorOfflineCount: number = 0;
  activeAlertCount: number = 0;
  latestAlert: AlertDto | null = null;
  locationText: string = '';
}

export class ContactDto {
  id: string = '';
  name: string = '';
  relation: string = '';
  phone: string = '';
  primary: boolean = false;
}

export class AckDto {
  accepted: boolean = false;
  status: string = '';
  commandId: string = '';
}

const KNOWN_SENSOR_KEYS: string[] = ['motion', 'door', 'climate', 'gas', 'smoke', 'water', 'battery'];

/** 整数范围（含边界）；非整数/非数字/越界 → null（未知），绝不钳位成合法值。 */
function nullableIntInRange(value: any, min: number, max: number): number | null {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  if (value < min || value > max) return null;
  if (value !== Math.floor(value)) return null;
  return value;
}

/**
 * 严格解析 battery 对象。缺失/null/非对象/未知 source → null；
 * 每个字段独立校验，非法类型或范围只让该字段为 null，不猜测、不默认 0/100。
 */
export function parseBattery(value: any): BatteryDto | null {
  if (!isRecord(value)) return null;
  const rawSource: any = value['source'];
  const source: string = typeof rawSource === 'string' ? rawSource.trim().toLowerCase() : '';
  if (source !== 'battery' && source !== 'fixed') return null;
  const dto = new BatteryDto();
  dto.source = source;
  dto.present = asTriStateBoolean(value, 'present');
  dto.valid = asTriStateBoolean(value, 'valid');
  dto.low = asTriStateBoolean(value, 'low');
  dto.calibrated = asTriStateBoolean(value, 'calibrated');
  dto.mv = nullableIntInRange(value['mv'], 0, 60000);
  dto.percent = nullableIntInRange(value['percent'], 0, 100);
  const rawReason: any = value['reason'];
  dto.reason = typeof rawReason === 'string' && /^[A-Z_]{0,16}$/.test(rawReason) ? rawReason : '';
  const rawSampledAt: any = value['sampledAt'];
  dto.sampledAt = typeof rawSampledAt === 'number' && isFinite(rawSampledAt) && rawSampledAt > 0
    ? Math.floor(rawSampledAt) : 0;
  return dto;
}

function parseMotion(value: any): MotionSensorDto | null {
  if (!isRecord(value)) return null;
  const dto = new MotionSensorDto();
  const last: any = value['lastActiveTs'];
  if (typeof last === 'number' && isFinite(last) && last >= 0) {
    dto.lastActiveTs = last;
    dto.lastActiveTsPresent = true;
  }
  const count: any = value['countToday'];
  if (typeof count === 'number' && isFinite(count) && count >= 0) {
    dto.countToday = count;
    dto.countTodayPresent = true;
  }
  // 2026-10-27 homemon 契约：supported/reported 为可选能力/数据声明。
  // 类型非法时按“字段未出现”处理（不信任非法声明），旧数据缺失时保持原行为。
  const supported: boolean | null = asTriStateBoolean(value, 'supported');
  if (supported !== null) {
    dto.supported = supported;
    dto.supportedPresent = true;
  }
  const reported: boolean | null = asTriStateBoolean(value, 'reported');
  if (reported !== null) {
    dto.reported = reported;
    dto.reportedPresent = true;
  }
  const reason: string = asString(value, 'reason', '').trim();
  dto.reason = reason.length > 64 ? reason.slice(0, 64) : reason;
  return dto;
}

function parseDoor(value: any): DoorSensorDto | null {
  if (!isRecord(value)) return null;
  const dto = new DoorSensorDto();
  if (typeof value['open'] === 'boolean') {
    dto.open = value['open'];
    dto.openPresent = true;
  }
  dto.lastOpenTs = asFiniteNumber(value, 'lastOpenTs', 0);
  dto.lastCloseTs = asFiniteNumber(value, 'lastCloseTs', 0);
  dto.seq = asFiniteNumber(value, 'seq', 0);
  return dto;
}

/** 解析门磁开关事件列表响应 { events: [...] }；非对象/无 events 数组返回 null。 */
export function parseDoorEvents(bodyText: string): DoorEventDto[] | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const raw: any = root['events'];
  if (!Array.isArray(raw)) return null;
  const events: DoorEventDto[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const dto = new DoorEventDto();
    dto.eventId = asString(item, 'eventId', '');
    if (dto.eventId.length === 0) continue;
    dto.deviceId = asString(item, 'deviceId', '');
    dto.roomName = asString(item, 'room', '');
    if (typeof item['open'] === 'boolean') {
      dto.open = item['open'];
      dto.openPresent = true;
    }
    dto.occurredAt = asFiniteNumber(item, 'occurredAt', 0);
    dto.timeSource = asString(item, 'timeSource', 'server');
    dto.seq = asFiniteNumber(item, 'seq', 0);
    dto.source = asString(item, 'source', '');
    events.push(dto);
  }
  return events;
}

function parseClimate(value: any): ClimateSensorDto | null {
  if (!isRecord(value)) return null;
  const dto = new ClimateSensorDto();
  const temp: any = value['tempC'];
  const rh: any = value['rh'];
  dto.tempC = typeof temp === 'number' && isFinite(temp) ? temp : null;
  dto.rh = typeof rh === 'number' && isFinite(rh) ? rh : null;
  dto.ok = asTriStateBoolean(value, 'ok');
  dto.valid = asTriStateBoolean(value, 'valid');
  return dto;
}

function parseRaw(value: any): RawSensorDto | null {
  if (!isRecord(value)) return null;
  const dto = new RawSensorDto();
  const raw: any = value['raw'];
  dto.raw = typeof raw === 'number' && isFinite(raw) ? raw : null;
  dto.ok = asTriStateBoolean(value, 'ok');
  dto.valid = asTriStateBoolean(value, 'valid');
  return dto;
}

function parseWater(value: any): WaterSensorDto | null {
  if (!isRecord(value)) return null;
  const dto = new WaterSensorDto();
  dto.wet = asTriStateBoolean(value, 'wet');
  dto.valid = asTriStateBoolean(value, 'valid');
  return dto;
}

export function parseSensors(obj: any): SensorsDto {
  const dto = new SensorsDto();
  const source: any = asObject(obj, 'sensors');
  if (source === null) return dto;
  dto.motion = parseMotion(source['motion']);
  dto.door = parseDoor(source['door']);
  dto.climate = parseClimate(source['climate']);
  dto.gas = parseRaw(source['gas']);
  dto.smoke = parseRaw(source['smoke']);
  dto.water = parseWater(source['water']);
  dto.battery = parseBattery(source['battery']);
  const keys: string[] = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    if (KNOWN_SENSOR_KEYS.indexOf(keys[i]) < 0) {
      dto.unknownKeys.push(keys[i]);
    }
  }
  return dto;
}

export function parseDevice(obj: any): DeviceDto {
  const dto = new DeviceDto();
  dto.deviceId = asString(obj, 'deviceId', '');
  dto.id = asString(obj, 'id', dto.deviceId.length > 0 ? dto.deviceId : '');
  if (dto.id.length === 0) dto.id = dto.deviceId;
  dto.name = asString(obj, 'name', '');
  dto.roomId = asString(obj, 'roomId', '');
  dto.roomName = asString(obj, 'roomName', '');
  dto.location = asString(obj, 'location', '');
  dto.online = asBoolean(obj, 'online', false);
  dto.monitorOnline = asFiniteNumber(obj, 'monitorOnline', -1);
  if (dto.monitorOnline !== 0 && dto.monitorOnline !== 1) {
    dto.monitorOnline = -1;
  }
  dto.state = asString(obj, 'state', '');
  // lastSeenTs：只接受 >0 的 13 位毫秒；0/负数/非法一律 0（=时间未知，不显示 1970/“刚刚”）。
  const lastSeen: number = asFiniteNumber(obj, 'lastSeenTs', 0);
  dto.lastSeenTs = lastSeen > 0 ? lastSeen : 0;
  dto.monitorReason = asString(obj, 'monitorReason', '');
  dto.sensors = parseSensors(obj);
  // 电量：顶层 `battery` 优先；旧网关可能嵌在 sensors 内，仅在顶层缺失时回退。
  dto.battery = parseBattery(obj !== null && obj !== undefined ? obj['battery'] : undefined);
  if (dto.battery === null) {
    dto.battery = dto.sensors.battery;
  }
  const csq: any = obj !== null && obj !== undefined ? obj['csq'] : undefined;
  dto.csq = typeof csq === 'number' && isFinite(csq) && csq >= 0 && csq <= 31 ? Math.floor(csq) : -1;
  return dto;
}

function parseRoom(obj: any): RoomDto {
  const dto = new RoomDto();
  dto.id = asString(obj, 'id', '');
  dto.name = asString(obj, 'name', dto.id);
  dto.location = asString(obj, 'location', '');
  dto.state = asString(obj, 'state', '');
  dto.onlineDeviceCount = asFiniteNumber(obj, 'onlineDeviceCount', 0);
  dto.deviceCount = asFiniteNumber(obj, 'deviceCount', 0);
  const rawDevices: any[] = asArray(obj, 'devices');
  for (let i = 0; i < rawDevices.length; i++) {
    if (isRecord(rawDevices[i])) {
      dto.devices.push(parseDevice(rawDevices[i]));
    }
  }
  return dto;
}

/**
 * 解析告警内的可选 sosLocation。
 * - 字段缺失 / null / 非对象 → null（页面按“无定位”处理）；
 * - 字段存在但部分子字段缺失/类型错误 → 返回 present=true 的 DTO，缺字段保持 null/0；
 * - 已知枚举之外的 status 原样保留，由视图层归一为 UNAVAILABLE（不猜测）。
 */
export function parseSosLocation(value: any): SosLocationDto | null {
  if (!isRecord(value)) return null;
  const dto = new SosLocationDto();
  dto.present = true;
  dto.status = asString(value, 'status', '');
  const latitude: any = value['latitude'];
  dto.latitude = typeof latitude === 'number' && isFinite(latitude) ? latitude : null;
  const longitude: any = value['longitude'];
  dto.longitude = typeof longitude === 'number' && isFinite(longitude) ? longitude : null;
  const positionTime: number = asFiniteNumber(value, 'positionTime', 0);
  dto.positionTime = positionTime > 0 ? positionTime : 0;
  const receivedAt: number = asFiniteNumber(value, 'receivedAt', 0);
  dto.receivedAt = receivedAt > 0 ? receivedAt : 0;
  const ageSeconds: any = value['ageSeconds'];
  dto.ageSeconds = typeof ageSeconds === 'number' && isFinite(ageSeconds) && ageSeconds >= 0
    ? Math.floor(ageSeconds) : null;
  return dto;
}

export function parseAlert(obj: any): AlertDto {
  const dto = new AlertDto();
  dto.alarmId = asString(obj, 'alarmId', '');
  dto.id = asString(obj, 'id', dto.alarmId.length > 0 ? dto.alarmId : '');
  if (dto.id.length === 0) dto.id = dto.alarmId;
  if (dto.alarmId.length === 0) dto.alarmId = dto.id;
  dto.deviceId = asString(obj, 'deviceId', '');
  dto.roomName = asString(obj, 'roomName', '');
  dto.type = asString(obj, 'type', '');
  dto.message = asString(obj, 'message', '');
  dto.state = asString(obj, 'state', '');
  dto.ackPending = asBoolean(obj, 'ackPending', false);
  dto.createdAt = asFiniteNumber(obj, 'createdAt', 0);
  dto.acknowledgedAt = asFiniteNumber(obj, 'acknowledgedAt', 0);
  dto.acknowledgedBy = asString(obj, 'acknowledgedBy', '');
  const evidence: any = asObject(obj, 'evidence');
  if (evidence !== null) {
    dto.evidence.available = asBoolean(evidence, 'available', false);
    dto.evidence.evidenceId = asString(evidence, 'evidenceId', '');
    dto.evidence.bytes = asFiniteNumber(evidence, 'bytes', 0);
    dto.evidence.capturedAt = asFiniteNumber(evidence, 'capturedAt', 0);
  }
  dto.sosLocation = parseSosLocation(obj['sosLocation']);
  return dto;
}

export function parseLogin(bodyText: string): LoginDto | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const token: string = asString(root, 'sessionToken', '');
  if (token.length === 0) return null;
  const dto = new LoginDto();
  dto.sessionToken = token;
  dto.tokenType = asString(root, 'tokenType', 'Bearer');
  dto.expiresIn = asFiniteNumber(root, 'expiresIn', 7200);
  return dto;
}

export function parseOverview(bodyText: string): OverviewDto | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const dto = new OverviewDto();
  dto.generatedAt = asFiniteNumber(root, 'generatedAt', 0);
  dto.deviceCount = asFiniteNumber(root, 'deviceCount', 0);
  dto.onlineCount = asFiniteNumber(root, 'onlineCount', 0);
  dto.monitorOfflineCount = asFiniteNumber(root, 'monitorOfflineCount', 0);
  dto.activeAlertCount = asFiniteNumber(root, 'activeAlertCount', 0);
  const latest: any = asObject(root, 'latestAlert');
  if (latest !== null) {
    dto.latestAlert = parseAlert(latest);
  }
  const location: any = asObject(root, 'location');
  if (location !== null) {
    dto.locationText = asString(location, 'location', '');
  }
  return dto;
}

export function parseRooms(bodyText: string): RoomDto[] | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const raw: any = root['rooms'];
  if (!Array.isArray(raw)) return null;
  const result: RoomDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (isRecord(raw[i])) {
      result.push(parseRoom(raw[i]));
    }
  }
  return result;
}

export function parseDevices(bodyText: string): DeviceDto[] | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const raw: any = root['devices'];
  if (!Array.isArray(raw)) return null;
  const result: DeviceDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (isRecord(raw[i])) {
      result.push(parseDevice(raw[i]));
    }
  }
  return result;
}

export function parseAlerts(bodyText: string): AlertDto[] | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const raw: any = root['alerts'];
  if (!Array.isArray(raw)) return null;
  const result: AlertDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (isRecord(raw[i])) {
      result.push(parseAlert(raw[i]));
    }
  }
  return result;
}

/**
 * GET /api/v1/location 响应解析：{ locations: [{deviceId, location, latitude, longitude, fixTime}] }。
 * 结构非法（非对象 / 缺 locations 数组）返回 null；数组元素非法时跳过该条（不伪造坐标）。
 * 空数组是合法的“当前没有任何设备定位”。
 */
export function parseLocations(bodyText: string): LocationPointDto[] | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const raw: any = root['locations'];
  if (!Array.isArray(raw)) return null;
  const result: LocationPointDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!isRecord(raw[i])) continue;
    const dto = new LocationPointDto();
    dto.deviceId = asString(raw[i], 'deviceId', '');
    if (dto.deviceId.length === 0) continue;
    dto.location = asString(raw[i], 'location', '');
    const latitude: any = raw[i]['latitude'];
    dto.latitude = typeof latitude === 'number' && isFinite(latitude) ? latitude : null;
    const longitude: any = raw[i]['longitude'];
    dto.longitude = typeof longitude === 'number' && isFinite(longitude) ? longitude : null;
    const fixTime: number = asFiniteNumber(raw[i], 'fixTime', 0);
    dto.fixTime = fixTime > 0 ? fixTime : 0;
    result.push(dto);
  }
  return result;
}

export function parseContacts(bodyText: string): ContactDto[] | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const raw: any = root['contacts'];
  if (!Array.isArray(raw)) return null;
  const result: ContactDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!isRecord(raw[i])) continue;
    const dto = new ContactDto();
    dto.id = asString(raw[i], 'id', `${i}`);
    dto.name = asString(raw[i], 'name', '');
    dto.relation = asString(raw[i], 'relation', '');
    dto.phone = asString(raw[i], 'phone', '');
    dto.primary = asBoolean(raw[i], 'primary', false);
    result.push(dto);
  }
  return result;
}

export function parseAck(bodyText: string): AckDto | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const dto = new AckDto();
  dto.accepted = asBoolean(root, 'accepted', false);
  dto.status = asString(root, 'status', '');
  dto.commandId = asString(root, 'commandId', '');
  if (!dto.accepted) return null;
  return dto;
}

/** 仅用于日志/调试的安全短错误码；不返回服务端文案给业务逻辑。 */
export function parseErrorCode(bodyText: string): string {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return '';
  return asString(root, 'error', '');
}

// ============================================================================
// 告警处置结果 / 安全日志（CONTRACT v1 增量，独立于既有 ACK 语义）
//
// 合同：competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md
// 规则：缺字段不崩溃；未知/未来字段忽略；serverTime 缺失或 0 一律视为“无有效时间”。
// 解析函数返回 null 表示整体结构非法（不是空列表）；空列表是合法的“无记录”。
// ============================================================================

/** 处置结果枚举（与合同第 1 节完全一致，顺序即 UI 展示顺序）。 */
export const DISPOSITION_OUTCOMES: string[] = [
  'CONTACTED_FAMILY',
  'CONTACTED_COMMUNITY',
  'ON_SITE_CONFIRMED_NORMAL',
  'FALSE_ALARM',
  'OTHER'
];

export const DISPOSITION_OUTCOME_OTHER: string = 'OTHER';
/** 说明最大长度（字符；客户端按 UTF-16 长度从严限制，不会比后端更宽）。 */
export const DISPOSITION_NOTE_MAX: number = 200;
/** 安全日志默认/最大条数（合同 2.3：1–200，非法值回退默认 50）。 */
export const SAFETY_LOG_DEFAULT_LIMIT: number = 50;
export const SAFETY_LOG_MAX_LIMIT: number = 200;

const DISPOSITION_ALARM_ID_RE: RegExp = /^[A-Za-z0-9._:-]{1,80}$/;
const CLIENT_DISPOSITION_ID_RE: RegExp = /^[A-Za-z0-9._-]{8,64}$/;
const DISPOSITION_CONTROL_CHARS_RE: RegExp = /[\u0000-\u001F\u007F-\u009F]/;

export class DispositionDto {
  dispositionId: string = '';
  alarmId: string = '';
  deviceId: string = '';
  roomName: string = '';
  alarmType: string = '';
  alarmCreatedAt: number = 0;
  /** 仅当字段存在且为 >0 的有限数时为 true；缺失/0 不得当作有效时间。 */
  alarmCreatedAtPresent: boolean = false;
  outcome: string = '';
  outcomeLabel: string = '';
  note: string = '';
  operator: string = '';
  operatorRole: string = '';
  serverTime: number = 0;
  /** 仅当字段存在且为 >0 的有限数时为 true；缺失/0 不得当作有效时间。 */
  serverTimePresent: boolean = false;
}

/**
 * 安全日志条目。字段与 PublicDisposition 相同（后端同一台账），
 * 单独成类只是为了让调用方语义清楚；不复用授权/身份字段。
 */
export class SafetyLogDto extends DispositionDto {
}

/** POST /alerts/{alarmId}/dispositions 的响应体：201 首次 / 200 幂等重放。 */
export class DispositionResultDto {
  created: boolean = false;
  duplicate: boolean = false;
  disposition: DispositionDto | null = null;
  /** HTTP 状态码（由 ApiClient 填写；解析器默认 0）。 */
  httpStatus: number = 0;
}

export function validDispositionAlarmId(alarmId: string): boolean {
  if (typeof alarmId !== 'string') return false;
  return DISPOSITION_ALARM_ID_RE.test(alarmId);
}

/** clientDispositionId：8–64 位 [A-Za-z0-9._-]，且不含 ".."（与留言客户端 ID 同规则）。 */
export function validClientDispositionId(id: string): boolean {
  if (typeof id !== 'string') return false;
  if (!CLIENT_DISPOSITION_ID_RE.test(id)) return false;
  return id.indexOf('..') < 0;
}

export function validDispositionOutcome(outcome: string): boolean {
  return DISPOSITION_OUTCOMES.indexOf(outcome) >= 0;
}

/** 把 \r\n 归一为单个空格并去掉首尾空白（与后端校验规则一致）。 */
export function normalizeDispositionNote(note: string): string {
  if (typeof note !== 'string') return '';
  // CRLF 是一处换行，只归一为一个空格；单独的 \r 或 \n 同样归一为一个空格。
  return note.replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ').trim();
}

/** 归一化后仍含 C0/DEL/C1 控制字符则视为非法（后端会 400）。 */
export function hasDispositionNoteControlChars(note: string): boolean {
  return DISPOSITION_CONTROL_CHARS_RE.test(note);
}

export function normalizeSafetyLogLimit(limit: number): number {
  if (typeof limit !== 'number' || !isFinite(limit)) return SAFETY_LOG_DEFAULT_LIMIT;
  const value: number = Math.floor(limit);
  if (value < 1 || value > SAFETY_LOG_MAX_LIMIT) return SAFETY_LOG_DEFAULT_LIMIT;
  return value;
}

function fillDisposition(value: any, dto: DispositionDto): DispositionDto {
  dto.dispositionId = asString(value, 'dispositionId', '');
  dto.alarmId = asString(value, 'alarmId', '');
  dto.deviceId = asString(value, 'deviceId', '');
  dto.roomName = asString(value, 'roomName', '');
  dto.alarmType = asString(value, 'alarmType', '');
  const alarmCreatedAt: number = asFiniteNumber(value, 'alarmCreatedAt', 0);
  dto.alarmCreatedAt = alarmCreatedAt > 0 ? alarmCreatedAt : 0;
  dto.alarmCreatedAtPresent = dto.alarmCreatedAt > 0;
  dto.outcome = asString(value, 'outcome', '');
  dto.outcomeLabel = asString(value, 'outcomeLabel', '');
  dto.note = asString(value, 'note', '');
  dto.operator = asString(value, 'operator', '');
  dto.operatorRole = asString(value, 'operatorRole', '');
  const serverTime: number = asFiniteNumber(value, 'serverTime', 0);
  dto.serverTime = serverTime > 0 ? serverTime : 0;
  dto.serverTimePresent = dto.serverTime > 0;
  return dto;
}

/** 单条 PublicDisposition 解析（缺字段只回退默认值，绝不抛异常）。 */
export function parseDisposition(value: any): DispositionDto {
  return fillDisposition(isRecord(value) ? value : {}, new DispositionDto());
}

/** GET /alerts/{alarmId}/dispositions：结构非法返回 null，无记录返回 []。 */
export function parseDispositions(bodyText: string): DispositionDto[] | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const raw: any = root['dispositions'];
  if (!Array.isArray(raw)) return null;
  const result: DispositionDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (isRecord(raw[i])) {
      result.push(fillDisposition(raw[i], new DispositionDto()));
    }
  }
  return result;
}

/** GET /safety-logs：结构非法返回 null，无记录返回 []。 */
export function parseSafetyLogs(bodyText: string): SafetyLogDto[] | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const raw: any = root['logs'];
  if (!Array.isArray(raw)) return null;
  const result: SafetyLogDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (isRecord(raw[i])) {
      result.push(fillDisposition(raw[i], new SafetyLogDto()));
    }
  }
  return result;
}

/** POST 响应解析：201 {"created":true,...} / 200 {"created":false,"duplicate":true,...}。 */
export function parseDispositionResult(bodyText: string): DispositionResultDto | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const record: any = asObject(root, 'disposition');
  if (record === null) return null;
  const dto = new DispositionResultDto();
  dto.created = asBoolean(root, 'created', false);
  dto.duplicate = asBoolean(root, 'duplicate', false);
  dto.disposition = fillDisposition(record, new DispositionDto());
  return dto;
}

// ============================================================================
// 活动报告（CONTRACT v1 增量：GET /api/v1/activity/report）
//
// 合同（冻结）：scope=day|week|month&date=YYYY-MM-DD。
// 解析规则：
// - count 缺失/类型错误/负数一律为 null（绝不默认成 0，0 是真实“没有触发”）。
// - status 未知值一律按 insufficient；未知字段忽略。
// - hourly 长度归一为 24：缺失的高位小时补 null，多出的部分忽略。
// - 只有 body 不是 JSON 对象（非法 JSON / 数组 / 标量）才返回 null；
//   合法对象里所有字段都缺失时返回全默认 DTO，由页面显示“无数据/数据不足”。
// ============================================================================

export const ACTIVITY_SCOPES: string[] = [
  ActivityScope.DAY, ActivityScope.WEEK, ActivityScope.MONTH
];

const ACTIVITY_STATUS_VALUES: string[] = [
  ActivityStatus.OK, ActivityStatus.PARTIAL, ActivityStatus.INSUFFICIENT, ActivityStatus.NO_DATA
];

const ACTIVITY_COMPARISON_STATE_VALUES: string[] = [
  ActivityComparisonState.COMPARABLE, ActivityComparisonState.PREVIOUS_ZERO,
  ActivityComparisonState.PREVIOUS_MISSING, ActivityComparisonState.SELECTED_MISSING,
  ActivityComparisonState.INSUFFICIENT
];

const ACTIVITY_TREND_STATE_VALUES: string[] = [
  ActivityTrendState.INSUFFICIENT, ActivityTrendState.STABLE,
  ActivityTrendState.UP, ActivityTrendState.DOWN
];

function includesString(list: string[], value: string): boolean {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === value) return true;
  }
  return false;
}

/** scope 校验：只接受 day|week|month；非法值归一为 day（请求前由 ApiClient 直接拒绝）。 */
export function isValidActivityScopeValue(value: any): boolean {
  return typeof value === 'string' && includesString(ACTIVITY_SCOPES, value);
}

export function normalizeActivityScope(value: any): string {
  return isValidActivityScopeValue(value) ? (value as string) : ActivityScope.DAY;
}

/** status 校验：未知/缺失一律 insufficient，不猜测“正常”。 */
export function normalizeActivityStatus(value: any): string {
  if (typeof value === 'string' && includesString(ACTIVITY_STATUS_VALUES, value)) {
    return value;
  }
  return ActivityStatus.INSUFFICIENT;
}

/** 对比状态：未知/缺失一律 insufficient。 */
export function normalizeActivityComparisonState(value: any): string {
  if (typeof value === 'string' && includesString(ACTIVITY_COMPARISON_STATE_VALUES, value)) {
    return value;
  }
  return ActivityComparisonState.INSUFFICIENT;
}

/** 趋势状态：未知/缺失一律 insufficient。 */
export function normalizeActivityTrendState(value: any): string {
  if (typeof value === 'string' && includesString(ACTIVITY_TREND_STATE_VALUES, value)) {
    return value;
  }
  return ActivityTrendState.INSUFFICIENT;
}

/** count 解析：缺失/类型错误/负数/Infinity → null；否则向下取整（计数无小数）。 */
export function nullableActivityCount(value: any): number | null {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/** 覆盖比例解析：缺失/非法 → null；保留原始数值，由展示层统一换算百分比。 */
export function nullableActivityRatio(value: any): number | null {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return null;
  return value;
}

/**
 * epoch 毫秒（例如 dataSince）：只接受 >0 的有限整数；其余一律 0（=无数据）。
 * 不把 0/负数/小数/NaN 当成有效时间，避免页面显示 1970 或错误时间。
 */
export function safeActivityEpochMs(value: any): number {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return 0;
  if (Math.floor(value) !== value) return 0;
  return value;
}

/** 单个小时：hour 序号 + count（null=无数据）。 */
export class ActivityHourDto {
  hour: number = 0;
  count: number | null = null;
}

/** 归一化小时数组：固定输出 expected 项，缺失补 null，多余忽略。 */
export function parseActivityHourList(value: any, expected: number): ActivityHourDto[] {
  const raw: any[] = Array.isArray(value) ? value : [];
  const size: number = expected > 0 ? expected : 24;
  const result: ActivityHourDto[] = [];
  for (let i = 0; i < size; i++) {
    const item = new ActivityHourDto();
    item.hour = i;
    item.count = i < raw.length ? nullableActivityCount(raw[i]) : null;
    result.push(item);
  }
  return result;
}

export class ActivityRangeDto {
  from: string = '';
  to: string = '';
  days: number = 0;
}

export class ActivitySelectedDto {
  date: string = '';
  count: number | null = null;
  status: string = ActivityStatus.INSUFFICIENT;
  samples: number = 0;
  samplesPresent: boolean = false;
  invalidSamples: number = 0;
  invalidSamplesPresent: boolean = false;
  firstTs: number = 0;
  firstTsPresent: boolean = false;
  lastTs: number = 0;
  lastTsPresent: boolean = false;
  maxGapMs: number | null = null;
  coverageRatio: number | null = null;
  hourly: ActivityHourDto[] = parseActivityHourList(null, 24);
}

export class ActivityPreviousDto {
  date: string = '';
  count: number | null = null;
  status: string = ActivityStatus.INSUFFICIENT;
}

export class ActivityComparisonDto {
  state: string = ActivityComparisonState.INSUFFICIENT;
  delta: number | null = null;
  pct: number | null = null;
  text: string = '';
}

export class ActivityDayDto {
  date: string = '';
  count: number | null = null;
  status: string = ActivityStatus.INSUFFICIENT;
  coverageRatio: number | null = null;
}

export class ActivitySummaryDto {
  total: number | null = null;
  days: number = 0;
  daysWithData: number = 0;
  coverageRatio: number | null = null;
  coverageText: string = '';
}

export class ActivityDeviceDto {
  deviceId: string = '';
  room: string = '';
  hasMotionSensor: boolean = false;
  count: number | null = null;
  status: string = ActivityStatus.INSUFFICIENT;
}

export class ActivityTrendDto {
  state: string = ActivityTrendState.INSUFFICIENT;
  text: string = '';
  note: string = '';
}

export class ActivityReportDto {
  generatedAt: number = 0;
  timezone: string = '';
  scope: string = ActivityScope.DAY;
  today: string = '';
  selectedDate: string = '';
  range: ActivityRangeDto = new ActivityRangeDto();
  /** 旧格式：dataSince 为字符串时保留原文（兼容旧网关/旧 fixture）。 */
  dataSince: string = '';
  /** 新格式：服务端 dataSince 为 epoch 毫秒；0 = 没有任何活动数据。 */
  dataSinceMs: number = 0;
  /** 新格式：家庭时区展示文本 `YYYY-MM-DD HH:mm`（服务端新增，优先用于展示）。 */
  dataSinceText: string = '';
  /** string / dataSinceMs / dataSinceText 任一有效即为 true。 */
  dataSincePresent: boolean = false;
  historyNote: string = '';
  selected: ActivitySelectedDto = new ActivitySelectedDto();
  previous: ActivityPreviousDto = new ActivityPreviousDto();
  comparison: ActivityComparisonDto = new ActivityComparisonDto();
  days: ActivityDayDto[] = [];
  summary: ActivitySummaryDto = new ActivitySummaryDto();
  hourly: ActivityHourDto[] = parseActivityHourList(null, 24);
  devices: ActivityDeviceDto[] = [];
  trend: ActivityTrendDto = new ActivityTrendDto();
  disclaimer: string = '';
}

function parseActivityRange(value: any): ActivityRangeDto {
  const dto = new ActivityRangeDto();
  if (!isRecord(value)) return dto;
  dto.from = asString(value, 'from', '');
  dto.to = asString(value, 'to', '');
  dto.days = Math.max(0, Math.floor(asFiniteNumber(value, 'days', 0)));
  return dto;
}

export function parseActivitySelected(value: any): ActivitySelectedDto {
  const dto = new ActivitySelectedDto();
  if (!isRecord(value)) return dto;
  dto.date = asString(value, 'date', '');
  dto.count = nullableActivityCount(value['count']);
  dto.status = normalizeActivityStatus(value['status']);
  if (typeof value['samples'] === 'number' && isFinite(value['samples']) && value['samples'] >= 0) {
    dto.samples = Math.floor(value['samples']);
    dto.samplesPresent = true;
  }
  if (typeof value['invalidSamples'] === 'number' && isFinite(value['invalidSamples']) &&
    value['invalidSamples'] >= 0) {
    dto.invalidSamples = Math.floor(value['invalidSamples']);
    dto.invalidSamplesPresent = true;
  }
  if (typeof value['firstTs'] === 'number' && isFinite(value['firstTs']) && value['firstTs'] > 0) {
    dto.firstTs = value['firstTs'];
    dto.firstTsPresent = true;
  }
  if (typeof value['lastTs'] === 'number' && isFinite(value['lastTs']) && value['lastTs'] > 0) {
    dto.lastTs = value['lastTs'];
    dto.lastTsPresent = true;
  }
  dto.maxGapMs = nullableActivityCount(value['maxGapMs']);
  dto.coverageRatio = nullableActivityRatio(value['coverageRatio']);
  dto.hourly = parseActivityHourList(value['hourly'], 24);
  // 诚实性：status=ok 却没有 count 时降级为 insufficient；no_data 一律不带 count。
  if (dto.status === ActivityStatus.NO_DATA) {
    dto.count = null;
  } else if (dto.status === ActivityStatus.OK && dto.count === null) {
    dto.status = ActivityStatus.INSUFFICIENT;
  }
  return dto;
}

export function parseActivityPrevious(value: any): ActivityPreviousDto {
  const dto = new ActivityPreviousDto();
  if (!isRecord(value)) return dto;
  dto.date = asString(value, 'date', '');
  dto.count = nullableActivityCount(value['count']);
  dto.status = normalizeActivityStatus(value['status']);
  if (dto.status === ActivityStatus.NO_DATA) dto.count = null;
  return dto;
}

function parseActivityComparison(value: any): ActivityComparisonDto {
  const dto = new ActivityComparisonDto();
  if (!isRecord(value)) return dto;
  dto.state = normalizeActivityComparisonState(value['state']);
  const delta: any = value['delta'];
  dto.delta = typeof delta === 'number' && isFinite(delta) ? delta : null;
  const pct: any = value['pct'];
  dto.pct = typeof pct === 'number' && isFinite(pct) ? pct : null;
  dto.text = asString(value, 'text', '');
  return dto;
}

function parseActivitySummary(value: any): ActivitySummaryDto {
  const dto = new ActivitySummaryDto();
  if (!isRecord(value)) return dto;
  dto.total = nullableActivityCount(value['total']);
  dto.days = Math.max(0, Math.floor(asFiniteNumber(value, 'days', 0)));
  dto.daysWithData = Math.max(0, Math.floor(asFiniteNumber(value, 'daysWithData', 0)));
  dto.coverageRatio = nullableActivityRatio(value['coverageRatio']);
  dto.coverageText = asString(value, 'coverageText', '');
  return dto;
}

function parseActivityTrend(value: any): ActivityTrendDto {
  const dto = new ActivityTrendDto();
  if (!isRecord(value)) return dto;
  dto.state = normalizeActivityTrendState(value['state']);
  dto.text = asString(value, 'text', '');
  dto.note = asString(value, 'note', '');
  return dto;
}

function parseActivityDays(value: any): ActivityDayDto[] {
  const raw: any[] = Array.isArray(value) ? value : [];
  const result: ActivityDayDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!isRecord(raw[i])) continue;
    const dto = new ActivityDayDto();
    dto.date = asString(raw[i], 'date', '');
    dto.count = nullableActivityCount(raw[i]['count']);
    dto.status = normalizeActivityStatus(raw[i]['status']);
    if (dto.status === ActivityStatus.NO_DATA) dto.count = null;
    if (dto.status === ActivityStatus.OK && dto.count === null) {
      dto.status = ActivityStatus.INSUFFICIENT;
    }
    dto.coverageRatio = nullableActivityRatio(raw[i]['coverageRatio']);
    result.push(dto);
  }
  return result;
}

function parseActivityDevices(value: any): ActivityDeviceDto[] {
  const raw: any[] = Array.isArray(value) ? value : [];
  const result: ActivityDeviceDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!isRecord(raw[i])) continue;
    const dto = new ActivityDeviceDto();
    dto.deviceId = asString(raw[i], 'deviceId', '');
    dto.room = asString(raw[i], 'room', '');
    dto.hasMotionSensor = asBoolean(raw[i], 'hasMotionSensor', false);
    dto.count = nullableActivityCount(raw[i]['count']);
    dto.status = normalizeActivityStatus(raw[i]['status']);
    if (dto.status === ActivityStatus.NO_DATA) dto.count = null;
    result.push(dto);
  }
  return result;
}

/**
 * GET /api/v1/activity/report 响应解析。
 * 返回 null 仅当 body 不是 JSON 对象（非法 JSON/数组/标量），由 ApiClient 映射为 malformed。
 */
export function parseActivityReport(bodyText: string): ActivityReportDto | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const dto = new ActivityReportDto();
  dto.generatedAt = Math.max(0, Math.floor(asFiniteNumber(root, 'generatedAt', 0)));
  dto.timezone = asString(root, 'timezone', '');
  dto.scope = normalizeActivityScope(root['scope']);
  dto.today = asString(root, 'today', '');
  dto.selectedDate = asString(root, 'selectedDate', '');
  dto.range = parseActivityRange(asObject(root, 'range'));
  // dataSince 真实后端是 epoch 毫秒 number；旧 fixture/旧网关可能是字符串；两者都兼容。
  const dataSinceRaw: any = root['dataSince'];
  const dataSinceMs: number = safeActivityEpochMs(dataSinceRaw);
  if (dataSinceMs > 0) {
    dto.dataSinceMs = dataSinceMs;
    dto.dataSincePresent = true;
  } else if (typeof dataSinceRaw === 'string' && dataSinceRaw.length > 0) {
    dto.dataSince = dataSinceRaw;
    dto.dataSincePresent = true;
  }
  dto.dataSinceText = asString(root, 'dataSinceText', '');
  if (dto.dataSinceText.length > 0) {
    dto.dataSincePresent = true;
  }
  dto.historyNote = asString(root, 'historyNote', '');
  dto.selected = parseActivitySelected(asObject(root, 'selected'));
  dto.previous = parseActivityPrevious(asObject(root, 'previous'));
  dto.comparison = parseActivityComparison(asObject(root, 'comparison'));
  dto.days = parseActivityDays(root['days']);
  dto.summary = parseActivitySummary(asObject(root, 'summary'));
  dto.hourly = parseActivityHourList(root['hourly'], 24);
  dto.devices = parseActivityDevices(root['devices']);
  dto.trend = parseActivityTrend(asObject(root, 'trend'));
  dto.disclaimer = asString(root, 'disclaimer', '');
  return dto;
}

// ============================================================================
// 健康科普评估（AI-HEALTH-ASSESSMENT-SPEC §1 / §2.3）
//
// 合同：competition/docs/AI-HEALTH-ASSESSMENT-SPEC.md（冻结）
// 规则：
// - GET /health-profile：{"profile": HealthProfile | null}；null = 还没有资料；
// - PUT /health-profile：{"profile": HealthProfile}（落盘后的规范化结果，含 updatedAt）；
// - POST /health-advice：{"advice":{summary,diet,exerciseAndSleep,warningSigns,disclaimer},
//   generatedAt, model}；任何失败都绝不返回建议。
// 解析一律“忽略未知字段、缺字段/类型错误不崩”，整体结构非法返回 null。
// ============================================================================

/** GET/PUT /api/v1/health-profile 响应信封。 */
export class HealthProfileEnvelopeDto {
  /** false = 服务端明确返回 {"profile": null}（还没有资料）。 */
  present: boolean = false;
  profile: HealthProfileDto = new HealthProfileDto();
}

/** POST /api/v1/health-advice 响应信封。 */
export class HealthAdviceEnvelopeDto {
  advice: HealthAdviceDto = new HealthAdviceDto();
  generatedAt: number = 0;
  model: string = '';
}

/** 解析 GET/PUT health-profile；结构非法返回 null（空资料返回 present=false）。 */
export function parseHealthProfileEnvelope(bodyText: string): HealthProfileEnvelopeDto | null {
  const parsed: HealthProfileParseResult | null = parseHealthProfileResponse(bodyText);
  if (parsed === null) {
    return null;
  }
  const dto = new HealthProfileEnvelopeDto();
  dto.present = parsed.present;
  dto.profile = parsed.profile;
  return dto;
}

/** 解析 POST health-advice；缺字段/类型错误/缺免责声明/红线词一律返回 null。 */
export function parseHealthAdviceEnvelope(bodyText: string): HealthAdviceEnvelopeDto | null {
  const parsed: HealthAdviceParseResult | null = parseHealthAdviceResponse(bodyText);
  if (parsed === null) {
    return null;
  }
  const dto = new HealthAdviceEnvelopeDto();
  dto.advice = parsed.advice;
  dto.generatedAt = parsed.generatedAt;
  dto.model = parsed.model;
  return dto;
}