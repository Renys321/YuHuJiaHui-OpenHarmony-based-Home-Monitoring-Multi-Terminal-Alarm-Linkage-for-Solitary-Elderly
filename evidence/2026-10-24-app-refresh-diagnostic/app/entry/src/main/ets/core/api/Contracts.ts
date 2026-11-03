/**
 * APP API v1 响应 DTO 与防御式解析。
 *
 * 合同：D:\OpenHarmony\competition\docs\APP-API-v1.md（v1.0.0）
 * 规则：忽略未来新增字段；不让缺字段/类型错误把页面打崩；不根据错误文案做业务判断。
 * 注意：旧云端适配器可能剥离 sensors.*.valid；DTO 中保留 valid 三态（可能为 null=未知）。
 * 新网关会保留该字段，旧数据/旧设备缺失时仍按未知处理。
 */
import {
  asArray, asBoolean, asFiniteNumber, asObject, asString, asTriStateBoolean,
  isRecord, parseJsonObject
} from '../util/Json';
import { IdentityTrace } from '../diag/IdentityTrace';

export class LoginDto {
  sessionToken: string = '';
  tokenType: string = '';
  expiresIn: number = 0;
}

export class MotionSensorDto {
  lastActiveTs: number = 0;
  countToday: number = 0;
}

export class DoorSensorDto {
  open: boolean = false;
  lastOpenTs: number = 0;
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

export class SensorsDto {
  motion: MotionSensorDto | null = null;
  door: DoorSensorDto | null = null;
  climate: ClimateSensorDto | null = null;
  gas: RawSensorDto | null = null;
  smoke: RawSensorDto | null = null;
  water: WaterSensorDto | null = null;
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
  sensors: SensorsDto = new SensorsDto();
  /** 0-31 有效；99 或缺失 = -1 未知 */
  csq: number = -1;
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

const KNOWN_SENSOR_KEYS: string[] = ['motion', 'door', 'climate', 'gas', 'smoke', 'water'];

function parseMotion(value: any): MotionSensorDto | null {
  if (!isRecord(value)) return null;
  const dto = new MotionSensorDto();
  dto.lastActiveTs = asFiniteNumber(value, 'lastActiveTs', 0);
  dto.countToday = asFiniteNumber(value, 'countToday', 0);
  return dto;
}

function parseDoor(value: any): DoorSensorDto | null {
  if (!isRecord(value)) return null;
  const dto = new DoorSensorDto();
  dto.open = asBoolean(value, 'open', false);
  dto.lastOpenTs = asFiniteNumber(value, 'lastOpenTs', 0);
  return dto;
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
  dto.lastSeenTs = asFiniteNumber(obj, 'lastSeenTs', 0);
  dto.sensors = parseSensors(obj);
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
      const dto: DeviceDto = parseDevice(raw[i]);
      IdentityTrace.dto(i, dto as Object);
      result.push(dto);
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
