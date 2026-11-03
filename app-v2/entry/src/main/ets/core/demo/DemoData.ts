/**
 * 独立演示数据（纯本地、可测试）。
 *
 * - 只构造示例视图，不 import API/GuardianService/Poller，不读写 Token/安全存储。
 * - 示例设备沿用已核实设备能力表的 deviceId，以便演示能力展示；名称、房间、读数、
 *   告警、联系人全部是虚构示例，界面必须显示“演示模式/示例数据”。
 * - 不使用真实账号、真实设备 ID 之外的个人信息，不构造已确认/ACKED 状态的假回执。
 */
import {
  AlertDto, ClimateSensorDto, ContactDto, DeviceDto, MotionSensorDto, OverviewDto,
  RawSensorDto, RoomDto, SensorsDto
} from '../api/Contracts';
import {
  AlertView, ContactView, DeviceView, OverviewView, RoomView, RunMode
} from '../view/Models';
import {
  mapAlerts, mapContacts, mapDevices, mapOverview, mapRooms
} from '../view/ViewMapper';

export class DemoSnapshot {
  mode: string = RunMode.DEMO;
  guardianId: string = '演示用户';
  generatedAt: number = 0;
  devices: DeviceView[] = [];
  rooms: RoomView[] = [];
  alerts: AlertView[] = [];
  overview: OverviewView = new OverviewView();
  contacts: ContactView[] = [];
}

function climate(tempC: number, rh: number): ClimateSensorDto {
  const dto = new ClimateSensorDto();
  dto.tempC = tempC;
  dto.rh = rh;
  dto.ok = true;
  dto.valid = true;
  return dto;
}

function raw(value: number): RawSensorDto {
  const dto = new RawSensorDto();
  dto.raw = value;
  dto.ok = true;
  dto.valid = true;
  return dto;
}

function motion(lastActiveTs: number, countToday: number): MotionSensorDto {
  const dto = new MotionSensorDto();
  dto.lastActiveTs = lastActiveTs;
  dto.countToday = countToday;
  return dto;
}

function makeKitchen(nowMs: number): DeviceDto {
  const dto = new DeviceDto();
  dto.id = 'esp32-kitchen';
  dto.deviceId = 'esp32-kitchen';
  dto.name = '厨房节点（演示）';
  dto.roomId = 'room-kitchen';
  dto.roomName = '厨房（演示）';
  dto.location = '示例住所 · 厨房';
  dto.online = true;
  dto.monitorOnline = 1;
  dto.state = 'NORMAL';
  dto.lastSeenTs = nowMs - 45 * 1000;
  dto.csq = 23;
  const sensors = new SensorsDto();
  sensors.climate = climate(24.6, 52);
  sensors.gas = raw(1180);
  sensors.smoke = raw(620);
  dto.sensors = sensors;
  return dto;
}

function makeBath(nowMs: number): DeviceDto {
  const dto = new DeviceDto();
  dto.id = 'esp32-bath';
  dto.deviceId = 'esp32-bath';
  dto.name = '卫生间节点（演示）';
  dto.roomId = 'room-bath';
  dto.roomName = '卫生间（演示）';
  dto.location = '示例住所 · 卫生间';
  dto.online = true;
  dto.monitorOnline = 1;
  dto.state = 'NORMAL';
  dto.lastSeenTs = nowMs - 90 * 1000;
  dto.csq = 19;
  const sensors = new SensorsDto();
  sensors.climate = climate(25.1, 58);
  sensors.motion = motion(nowMs - 120 * 1000, 6);
  dto.sensors = sensors;
  return dto;
}

function makeLiving(nowMs: number): DeviceDto {
  const dto = new DeviceDto();
  dto.id = 'dayu200-living';
  dto.deviceId = 'dayu200-living';
  dto.name = '客厅主控（演示）';
  dto.roomId = 'room-living';
  dto.roomName = '客厅（演示）';
  dto.location = '示例住所 · 客厅';
  dto.online = true;
  dto.monitorOnline = 1;
  dto.state = 'NORMAL';
  dto.lastSeenTs = nowMs - 30 * 1000;
  dto.csq = 28;
  dto.sensors = new SensorsDto();
  return dto;
}

function makeRooms(): RoomDto[] {
  const kitchen = new RoomDto();
  kitchen.id = 'room-kitchen';
  kitchen.name = '厨房（演示）';
  kitchen.location = '示例住所';
  const bath = new RoomDto();
  bath.id = 'room-bath';
  bath.name = '卫生间（演示）';
  bath.location = '示例住所';
  const living = new RoomDto();
  living.id = 'room-living';
  living.name = '客厅（演示）';
  living.location = '示例住所';
  return [living, kitchen, bath];
}

function makeAlerts(nowMs: number): AlertDto[] {
  const sos = new AlertDto();
  sos.id = 'demo-alarm-sos-1';
  sos.alarmId = 'demo-alarm-sos-1';
  sos.deviceId = 'esp32-bath';
  sos.roomName = '卫生间（演示）';
  sos.type = 'MANUAL_SOS';
  sos.message = '示例：紧急求助按键触发（本地演示数据）';
  sos.state = 'ALARM';
  sos.ackPending = false;
  sos.createdAt = nowMs - 3 * 60 * 1000;

  const noMotion = new AlertDto();
  noMotion.id = 'demo-alarm-nomotion-1';
  noMotion.alarmId = 'demo-alarm-nomotion-1';
  noMotion.deviceId = 'esp32-bath';
  noMotion.roomName = '卫生间（演示）';
  noMotion.type = 'NO_MOTION';
  noMotion.message = '示例：长时间无活动（本地演示数据）';
  noMotion.state = 'ALARM';
  noMotion.ackPending = false;
  noMotion.createdAt = nowMs - 10 * 60 * 1000;

  return [sos, noMotion];
}

function makeOverview(nowMs: number, deviceCount: number, onlineCount: number,
  latest: AlertDto | null): OverviewDto {
  const dto = new OverviewDto();
  dto.generatedAt = nowMs;
  dto.deviceCount = deviceCount;
  dto.onlineCount = onlineCount;
  dto.monitorOfflineCount = 0;
  dto.activeAlertCount = 2;
  dto.latestAlert = latest;
  dto.locationText = '示例住所 · 本地演示数据';
  return dto;
}

function makeContacts(): ContactDto[] {
  const first = new ContactDto();
  first.id = 'demo-contact-1';
  first.name = '示例家属甲';
  first.relation = '家属';
  first.phone = '00000000000';
  first.primary = true;
  const second = new ContactDto();
  second.id = 'demo-contact-2';
  second.name = '示例家属乙';
  second.relation = '家属';
  second.phone = '00000000001';
  second.primary = false;
  return [first, second];
}

/** 构造一份只驻留调用方内存的演示快照；不写 AppStorage，不触网。 */
export function buildDemoSnapshot(nowMs: number = Date.now()): DemoSnapshot {
  const snapshot = new DemoSnapshot();
  snapshot.generatedAt = nowMs;
  snapshot.guardianId = '演示用户';

  const dtos: DeviceDto[] = [makeKitchen(nowMs), makeBath(nowMs), makeLiving(nowMs)];
  snapshot.devices = mapDevices(dtos, nowMs, true);
  snapshot.rooms = mapRooms(makeRooms(), snapshot.devices);

  const alertDtos: AlertDto[] = makeAlerts(nowMs);
  snapshot.alerts = mapAlerts(alertDtos);
  snapshot.overview = mapOverview(makeOverview(nowMs, snapshot.devices.length,
    snapshot.devices.filter((d: DeviceView): boolean => d.online).length,
    alertDtos.length > 0 ? alertDtos[0] : null));
  snapshot.contacts = mapContacts(makeContacts());
  return snapshot;
}
