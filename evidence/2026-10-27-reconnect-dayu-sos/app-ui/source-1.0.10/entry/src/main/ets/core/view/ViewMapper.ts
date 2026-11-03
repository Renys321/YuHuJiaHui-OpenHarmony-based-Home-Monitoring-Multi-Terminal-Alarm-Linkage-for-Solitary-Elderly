/**
 * DTO → 视图模型映射（纯逻辑，可测）。
 *
 * 核心约束：
 * - 设备与房间只按 roomId 关联，不靠中文房间名。
 * - 能力表决定展示哪些传感器；未知设备不默认拥有传感器。
 * - MQ 原始 ADC 不显示 ppm；报警禁用显示“报警未启用”，不用绿色“正常”冒充。
 * - valid=false/缺失/离线/监测异常不显示为正常。
 * - 告警 ACK：202/PENDING 只显示“等待设备确认”，只有 state=ACKED 才是设备已确认。
 */
import {
  AlertDto, BatteryDto, ContactDto, DeviceDto, DispositionDto, DoorEventDto, OverviewDto, RoomDto,
  SafetyLogDto, SensorsDto, SosLocationDto
} from '../api/Contracts';
import {
  CAMERA_NO_VALID_DATA_TEXT, CapabilityEntry, CapabilityProfile, MotionSource, PIR_NO_DATA_TEXT,
  PIR_UNCONFIGURED_TEXT, SensorKind, SensorTileState, ValidityState,
  capabilityNoteOf, capabilitySummaryOf, capabilityWarningFor, colorTokenForSensorState,
  formatAge, formatRawAdc, resolveCapability, stateTextOf
} from '../capability/DeviceCapabilities';
import {
  BatteryCapability, BatterySource, DeviceClass, batteryCapabilityFor, inventorySourceFor,
  isHouseholdDevice, unrecognizedReasonFor, verifiedNameFor
} from '../inventory/DeviceInventory';
import {
  AlertView, BatteryStatus, BatteryView, ContactView, DeviceView, DispositionView, DoorEventView,
  OverviewView, RoomView, SensorView, SosLocationView
} from './Models';
import {
  SosStatus, normalizeSosStatus, validAgeSeconds, validEpochMs, validLatitudeValue, validLongitudeValue
} from '../location/SosLocation';

/** 手机侧在线新鲜度合同：服务端 lastSeenTs 超过该时限即判离线。 */
export const DEVICE_OFFLINE_AFTER_MS: number = 90 * 1000;
/** 设备/服务器时钟异常超前超过该容差时，不把它当作新鲜在线。 */
const FUTURE_SKEW_TOLERANCE_MS: number = 5 * 60 * 1000;

export function isDeviceFresh(online: boolean, lastSeenTs: number, nowMs: number): boolean {
  if (!online) return false;
  if (!Number.isFinite(lastSeenTs) || lastSeenTs <= 0) return false;
  if (lastSeenTs > nowMs + FUTURE_SKEW_TOLERANCE_MS) return false;
  return nowMs - lastSeenTs <= DEVICE_OFFLINE_AFTER_MS;
}

function makeSensor(id: string, deviceId: string, roomId: string, roomName: string,
  kind: SensorKind, name: string, state: SensorTileState, nowMs: number,
  lastUpdateTs: number): SensorView {
  const view = new SensorView();
  view.id = id;
  view.deviceId = deviceId;
  view.roomId = roomId;
  view.roomName = roomName;
  view.kind = kind;
  view.name = name;
  view.state = state;
  view.stateText = stateTextOf(state);
  // 时间语义：0/负数/超前超过容差的时间都视为“时间未知”，不显示 1970，也不冒充“刚刚”。
  view.lastUpdateTs = lastUpdateTs > 0 && lastUpdateTs <= nowMs + FUTURE_SKEW_TOLERANCE_MS
    ? lastUpdateTs : 0;
  return view;
}

/**
 * 视觉监测原因短码 → 中文展示（后端 monitorReason，语义由后端/DAYU 定义）。
 * 只做保守映射：未知短码保留原样并标注“监测原因”，绝不据此推断“无人/跌倒”。
 */
export function monitorReasonTextFor(reason: string): string {
  if (reason.length === 0) return '';
  const r: string = reason.toLowerCase();
  if (r.indexOf('offline') >= 0) return '监测离线';
  if (r.indexOf('stale') >= 0) return '检测结果过期';
  if (r.indexOf('no_data') >= 0 || r.indexOf('nodata') >= 0 ||
    r.indexOf('no_result') >= 0 || r.indexOf('noresult') >= 0) {
    return '暂无检测结果';
  }
  if (r.indexOf('camera') >= 0 && (r.indexOf('down') >= 0 || r.indexOf('fail') >= 0)) {
    return '摄像头不可用';
  }
  return `监测原因 ${reason}`;
}

function climateHasReading(sensors: SensorsDto): boolean {
  if (sensors.climate === null) return false;
  return sensors.climate.tempC !== null || sensors.climate.rh !== null;
}

function climateIsPlaceholder(sensors: SensorsDto): boolean {
  if (sensors.climate === null) return false;
  // 传感器/网关明确声明本次读取有效时，0/0 也可能是真实零值，不能按占位值处理。
  if (sensors.climate.valid === true) return false;
  const temp: number | null = sensors.climate.tempC;
  const rh: number | null = sensors.climate.rh;
  return temp === 0 && rh === 0;
}

function formatClimate(sensors: SensorsDto): string {
  if (sensors.climate === null) return '--';
  const parts: string[] = [];
  if (sensors.climate.tempC !== null) {
    parts.push(`${(sensors.climate.tempC as number).toFixed(1)}°C`);
  }
  if (sensors.climate.rh !== null) {
    parts.push(`${(sensors.climate.rh as number).toFixed(0)}%RH`);
  }
  return parts.length > 0 ? parts.join(' · ') : '--';
}

function climateAlarmSuffix(cap: CapabilityEntry): string {
  return cap.alarmEnabled ? ' · 环境告警启用' : '';
}

function buildClimateView(dto: DeviceDto, nowMs: number, profile: CapabilityProfile): SensorView | null {
  const cap: CapabilityEntry = profile.find('climate');
  if (!cap.installed || !cap.enabled) return null;
  const view = makeSensor(`${dto.deviceId}:climate`, dto.deviceId, dto.roomId, dto.roomName,
    'climate', '温湿度', 'waiting', nowMs, dto.lastSeenTs);
  view.installed = true;
  view.enabled = true;
  view.alarmEnabled = cap.alarmEnabled;
  const sensors: SensorsDto = dto.sensors;
  if (!climateHasReading(sensors)) {
    view.state = 'waiting';
    view.stateText = stateTextOf('waiting');
    view.valueText = '--';
    view.detailText = '等待温湿度数据';
    view.validity = 'unknown';
    return view;
  }
  const rawText: string = formatClimate(sensors);
  const climate = sensors.climate;
  if (climate === null) {
    view.state = 'waiting';
    view.stateText = stateTextOf('waiting');
    view.valueText = '--';
    view.detailText = '等待温湿度数据';
    return view;
  }
  if (climate.valid === false || climate.ok === false) {
    // 明确读取失败/无效：保留旧值但必须说明是上次读数，不能显示正常。
    view.state = 'invalid';
    view.stateText = '读数无效';
    view.valueText = `上次读数 ${rawText}`;
    view.detailText = `读取失败/读数无效；展示上次读数，不能视为正常${climateAlarmSuffix(cap)}`;
    view.validity = 'invalid';
    return view;
  }
  if (climateIsPlaceholder(sensors)) {
    view.state = 'invalid';
    view.stateText = '无效';
    view.valueText = rawText;
    view.detailText = '温湿度均为 0，可能为占位或读取失败，不能视为正常';
    view.validity = 'unknown';
    return view;
  }
  if (climate.valid === true) {
    view.state = 'ok';
    view.stateText = '读数有效';
    view.valueText = rawText;
    view.detailText = `AHT20 读数有效（读取有效，不等于环境告警判定）${climateAlarmSuffix(cap)}`;
    view.validity = 'valid';
    return view;
  }
  // valid 缺失（旧网关/旧设备）：保留读数，但有效性未知、中性色、不显示“正常”。
  view.state = 'unknown';
  view.stateText = '有效性未知';
  view.valueText = rawText;
  view.detailText = `未收到 valid；已显示读数，但本次读取有效性未知，不代表环境正常${climateAlarmSuffix(cap)}`;
  view.validity = 'unknown';
  return view;
}

/**
 * 活动检测语义（2026-10-27 homemon 契约 sensors.motion.supported/reported）：
 * - 状态显式声明 supported=false → 'unsupported'（显示“未配置 PIR，无活动监测”），优先于能力表；
 * - 否则用已核实能力表：kitchen/bath=PIR、dayu200=camera（非 PIR）、其余=none；
 * - 旧数据没有 supported 字段（supportedPresent=false）→ 保持上述回退行为，不改变旧数据解析。
 */
export function motionSemanticsFor(dto: DeviceDto, profile: CapabilityProfile): string {
  const motion = dto.sensors.motion;
  if (motion !== null && motion.supportedPresent && motion.supported === false) {
    return 'unsupported';
  }
  return profile.motionSource;
}

/** 无 PIR（未配置/显式不支持）时的独立瓦片：明确“未配置 PIR，无活动监测”，不伪装成 PIR 数据。 */
function buildPirUnconfiguredView(dto: DeviceDto, nowMs: number, profile: CapabilityProfile,
  cameraCompanion: boolean): SensorView {
  const reason: string = dto.sensors.motion !== null ? dto.sensors.motion.reason : '';
  const view = makeSensor(`${dto.deviceId}:pir`, dto.deviceId, dto.roomId, dto.roomName,
    'motion', 'PIR 活动监测', 'unsupported', nowMs, dto.lastSeenTs);
  view.installed = false;
  view.enabled = false;
  view.alarmEnabled = false;
  view.stateText = '未配置';
  view.valueText = PIR_UNCONFIGURED_TEXT;
  view.detailText = cameraCompanion
    ? '客厅人员检测来自摄像头判定（独立展示，非 PIR）；不显示活动次数，也不产生 PIR 无活动判读'
    : '该设备状态声明未配置/未启用 PIR 活动监测，不展示活动次数，也不产生 PIR 无活动判读';
  if (reason.length > 0) {
    view.detailText = `${view.detailText}（原因 ${reason}）`;
  }
  return view;
}

/**
 * 摄像头人体判定独立瓦片（客厅等无 PIR 场景）。
 * 诚实性：
 * - 只有“设备在线新鲜 + monitorOnline=1（视觉监测正常）”且收到检测字段时，才描述“检测到/今日未检测到人体”；
 * - monitorOnline=0/-1、无检测结果、字段缺失 → 明确“暂无有效检测数据”并给出真实原因；
 * - 离线由 applyOfflinePresentation 统一改写为“离线·上次读数/暂无数据”；
 * - 绝不把摄像头判定当 PIR，也不据此提示“长时间无活动”。
 */
function buildCameraMotionView(dto: DeviceDto, nowMs: number, profile: CapabilityProfile): SensorView | null {
  const cap: CapabilityEntry = profile.find('camera');
  if (!cap.installed || !cap.enabled) return null;
  const view = makeSensor(`${dto.deviceId}:camera`, dto.deviceId, dto.roomId, dto.roomName,
    'camera', '摄像头人体检测（非 PIR）', 'waiting', nowMs, dto.lastSeenTs);
  view.installed = true;
  view.enabled = true;
  view.alarmEnabled = false;
  view.validity = 'unknown';
  const reasonText: string = monitorReasonTextFor(dto.monitorReason);
  const reasonSuffix: string = reasonText.length > 0 ? `（${reasonText}）` : '';
  const motion = dto.sensors.motion;
  if (dto.monitorOnline !== 1) {
    view.state = 'unknown';
    view.stateText = CAMERA_NO_VALID_DATA_TEXT;
    view.valueText = CAMERA_NO_VALID_DATA_TEXT;
    view.detailText = dto.monitorOnline === 0
      ? `视觉监测异常${reasonSuffix}，摄像头判定无有效推理；仅检测结果，无实时画面`
      : `监测状态未知${reasonSuffix}，不能把历史检测当当前结果；仅检测结果，无实时画面`;
    return view;
  }
  if (motion === null) {
    view.state = 'waiting';
    view.stateText = '等待检测数据';
    view.valueText = '--';
    view.detailText = '视觉监测正常，但未收到摄像头检测结果（摄像头判定，非 PIR）；不推断有人/无人活动';
    return view;
  }
  const hasLast: boolean = motion.lastActiveTsPresent;
  const hasCount: boolean = motion.countTodayPresent;
  if (!hasLast && !hasCount) {
    view.state = 'unknown';
    view.stateText = CAMERA_NO_VALID_DATA_TEXT;
    view.valueText = CAMERA_NO_VALID_DATA_TEXT;
    view.detailText = '未收到摄像头检测字段；不推断有人/无人活动';
    return view;
  }
  view.stateText = '检测有效';
  if (hasLast && motion.lastActiveTs > 0) {
    const countText: string = hasCount ? ` · 今日检测 ${Math.round(motion.countToday)} 次` : '';
    view.state = 'ok';
    view.valueText = `最近检测到人体 · ${formatAge(nowMs, motion.lastActiveTs)}`;
    view.detailText = `摄像头判定（非 PIR）${countText}；仅检测结果，无实时画面`;
    return view;
  }
  if (hasCount && motion.countToday > 0) {
    view.state = 'ok';
    view.valueText = `今日检测 ${Math.round(motion.countToday)} 次`;
    view.detailText = '未收到最近检测时间；摄像头判定（非 PIR），仅检测结果';
    return view;
  }
  // 视觉监测正常 + 今日检测 0 次：这是有效推理下的“未检测到人体”，不是 PIR 无活动告警依据。
  view.state = 'ok';
  view.valueText = '今日未检测到人体';
  view.detailText = '视觉监测正常，今日暂未检测到人体（摄像头判定，非 PIR）；仅检测结果，无实时画面';
  return view;
}

function buildMotionView(dto: DeviceDto, nowMs: number, profile: CapabilityProfile): SensorView | null {
  const cap: CapabilityEntry = profile.find('motion');
  if (!cap.installed || !cap.enabled) return null;
  const view = makeSensor(`${dto.deviceId}:motion`, dto.deviceId, dto.roomId, dto.roomName,
    'motion', cap.name.length > 0 ? cap.name : '人体活动', 'waiting', nowMs, dto.lastSeenTs);
  view.installed = true;
  view.enabled = true;
  view.alarmEnabled = cap.alarmEnabled;
  const motion = dto.sensors.motion;
  if (motion === null) {
    view.state = 'waiting';
    view.stateText = stateTextOf('waiting');
    view.valueText = '--';
    view.detailText = '等待活动数据';
    return view;
  }
  // 2026-10-27 homemon 契约：reported=false 表示本次没有有效 PIR 数据，不得按“0 次活动”展示。
  if (motion.reportedPresent && motion.reported === false) {
    view.state = 'unknown';
    view.stateText = '暂无数据';
    view.valueText = PIR_NO_DATA_TEXT;
    view.detailText = motion.reason.length > 0
      ? `本次未上报有效 PIR 活动数据（原因 ${motion.reason}）；不视为无活动，也不触发“长时间无活动”判读`
      : '本次未上报有效 PIR 活动数据；不视为无活动，也不触发“长时间无活动”判读';
    return view;
  }
  view.state = 'ok';
  view.stateText = stateTextOf('ok');
  view.validity = 'unknown';
  const hasLast: boolean = motion.lastActiveTsPresent;
  const hasCount: boolean = motion.countTodayPresent;
  if (!hasLast && !hasCount) {
    // 字段完全缺失：不能把 DTO 默认 0 当作真实“0 次/暂无活动”。
    view.state = 'unknown';
    view.stateText = stateTextOf('unknown');
    view.valueText = '--';
    view.detailText = '未收到活动字段，最近活动和今日次数未知';
    return view;
  }
  if (hasLast && motion.lastActiveTs > 0) {
    view.valueText = `最近活动 ${formatAge(nowMs, motion.lastActiveTs)}`;
  } else if (hasLast) {
    // 2026-10-27 契约：lastActiveTs=0 表示从未检测到活动；
    // 但若同一报文今日计数>0（数据自相矛盾），不得显示“从未检测到活动”，按时间未知处理。
    if (hasCount && motion.countToday > 0) {
      view.state = 'unknown';
      view.stateText = stateTextOf('unknown');
      view.valueText = `今日 ${Math.round(motion.countToday)} 次（最近活动时间未知）`;
      view.detailText = '未收到最近活动时间；今日计数来自设备上报，时间语义待确认，不视为实时活动';
      return view;
    }
    view.valueText = '从未检测到活动';
  } else {
    view.valueText = '最近活动时间未知';
  }
  const countText: string = hasCount ? `今日 ${Math.round(motion.countToday)} 次` : '今日次数未知';
  view.detailText = `${countText} · 长时间无活动会触发 NO_MOTION 告警`;
  return view;
}

function buildRawSensorView(dto: DeviceDto, nowMs: number, profile: CapabilityProfile,
  kind: SensorKind, displayName: string): SensorView | null {
  const cap: CapabilityEntry = profile.find(kind);
  if (!cap.installed || !cap.enabled) return null;
  const view = makeSensor(`${dto.deviceId}:${kind}`, dto.deviceId, dto.roomId, dto.roomName,
    kind, displayName, 'waiting', nowMs, dto.lastSeenTs);
  view.installed = true;
  view.enabled = true;
  view.alarmEnabled = cap.alarmEnabled;
  const raw = kind === 'gas' ? dto.sensors.gas : dto.sensors.smoke;
  if (raw === null) {
    view.state = 'waiting';
    view.stateText = stateTextOf('waiting');
    view.valueText = '--';
    view.detailText = '等待原始 ADC 数据';
    return view;
  }
  if (raw.ok === false || raw.valid === false) {
    view.state = 'invalid';
    view.stateText = '读数无效';
    view.valueText = raw.raw !== null ? `上次读数 ${formatRawAdc(raw.raw)}` : '--';
    view.detailText = '读取失败/读数无效；报警未启用、未标定；展示上次读数，不能视为正常';
    view.validity = 'invalid';
    return view;
  }
  if (raw.raw === null) {
    view.state = 'waiting';
    view.stateText = stateTextOf('waiting');
    view.valueText = '--';
    view.detailText = '未收到原始 ADC 值';
    return view;
  }
  view.valueText = formatRawAdc(raw.raw);
  if (!cap.alarmEnabled) {
    view.state = 'disabled';
    view.stateText = stateTextOf('disabled');
    view.detailText = '报警未启用 · 未标定，原始 ADC 不代表 ppm，也不代表安全';
  } else {
    view.state = 'ok';
    view.stateText = stateTextOf('ok');
    view.detailText = '原始 ADC；有效性未知';
  }
  view.validity = raw.valid === true ? 'valid' : (raw.valid === false ? 'invalid' : 'unknown');
  return view;
}

function buildDoorView(dto: DeviceDto, nowMs: number, profile: CapabilityProfile): SensorView | null {
  const cap: CapabilityEntry = profile.find('door');
  if (!cap.installed || !cap.enabled) return null;
  const view = makeSensor(`${dto.deviceId}:door`, dto.deviceId, dto.roomId, dto.roomName,
    'door', '门磁', 'waiting', nowMs, dto.lastSeenTs);
  view.installed = true;
  view.enabled = true;
  const door = dto.sensors.door;
  if (door === null) {
    view.state = 'waiting';
    view.stateText = stateTextOf('waiting');
    view.valueText = '--';
    view.detailText = '等待门磁数据';
    return view;
  }
  if (!door.openPresent) {
    // open 字段缺失/非法：状态未知，绝不默认显示"门已关闭"。
    view.state = 'unknown';
    view.stateText = stateTextOf('unknown');
    view.valueText = '未知';
    view.detailText = '未收到门磁开关状态';
    return view;
  }
  view.valueText = door.open ? '开启' : '关闭';
  view.state = door.open ? 'attention' : 'ok';
  view.stateText = stateTextOf(door.open ? 'attention' : 'ok');
  const openText: string = door.lastOpenTs > 0 ? `最近开启 ${formatAge(nowMs, door.lastOpenTs)}` : '暂无开启记录';
  const closeText: string = door.lastCloseTs > 0 ? `最近关闭 ${formatAge(nowMs, door.lastCloseTs)}` : '';
  view.detailText = closeText.length > 0 ? `${openText} · ${closeText}` : openText;
  return view;
}

/**
 * 门磁开关事件 → 事件视图（设备详情"最近开关记录"区块）。
 * 时间语义严格区分来源：timeSource=device 表示设备可信时钟，server 表示服务器接收时间；
 * occurredAt<=0 时显示"时间未知"，绝不把 0 当成有效时间。
 */
export function mapDoorEvents(events: DoorEventDto[], nowMs: number): DoorEventView[] {
  return events.map((event) => {
    const view = new DoorEventView();
    view.eventId = event.eventId;
    view.deviceId = event.deviceId;
    view.roomName = event.roomName;
    view.openPresent = event.openPresent;
    view.open = event.open;
    view.seq = event.seq;
    view.source = event.source;
    view.occurredAt = event.occurredAt;
    view.hasValidOccurredAt = Number.isFinite(event.occurredAt) && event.occurredAt > 0;
    view.timeSource = event.timeSource === 'device' ? 'device' : 'server';
    view.timeSourceText = view.timeSource === 'device' ? '设备时间' : '服务器时间';
    view.actionText = !event.openPresent ? '状态未知' : (event.open ? '打开' : '关闭');
    if (view.hasValidOccurredAt) {
      view.timeText = `${formatAge(nowMs, view.occurredAt)}（${view.timeSourceText}）`;
    } else {
      view.timeText = '时间未知';
    }
    return view;
  });
}

function buildWaterView(dto: DeviceDto, nowMs: number, profile: CapabilityProfile): SensorView | null {
  const cap: CapabilityEntry = profile.find('water');
  if (!cap.installed || !cap.enabled) return null;
  const view = makeSensor(`${dto.deviceId}:water`, dto.deviceId, dto.roomId, dto.roomName,
    'water', '水漏', 'waiting', nowMs, dto.lastSeenTs);
  view.installed = true;
  view.enabled = true;
  const water = dto.sensors.water;
  if (water === null || water.wet === null) {
    view.state = 'waiting';
    view.stateText = stateTextOf('waiting');
    view.valueText = '--';
    view.detailText = '等待水漏数据';
    return view;
  }
  view.valueText = water.wet ? '检测到水' : '干燥';
  view.state = water.wet ? 'critical' : 'ok';
  view.stateText = stateTextOf(water.wet ? 'critical' : 'ok');
  view.detailText = water.valid === false ? '本次读数无效' : '';
  view.validity = water.valid === true ? 'valid' : (water.valid === false ? 'invalid' : 'unknown');
  return view;
}

/** 已核实设备上的“待确认”能力：例如 DAYU200 未接线但仍会上报的占位传感器字段。 */
function buildPendingSensors(dto: DeviceDto, nowMs: number, profile: CapabilityProfile): SensorView[] {
  const views: SensorView[] = [];
  const sensors: SensorsDto = dto.sensors;
  const present: Map<SensorKind, boolean> = new Map<SensorKind, boolean>();
  present.set('climate', climateHasReading(sensors));
  present.set('motion', sensors.motion !== null);
  present.set('door', sensors.door !== null);
  present.set('gas', sensors.gas !== null);
  present.set('smoke', sensors.smoke !== null);
  present.set('water', sensors.water !== null);
  const kinds: SensorKind[] = ['climate', 'motion', 'door', 'gas', 'smoke', 'water'];
  for (let i = 0; i < kinds.length; i++) {
    const kind: SensorKind = kinds[i];
    const cap: CapabilityEntry = profile.find(kind);
    if (cap.installed) continue;
    if (cap.note.indexOf('待确认') < 0) continue;
    const hasData: boolean = present.get(kind) === true;
    if (!hasData) continue;
    const view = makeSensor(`${dto.deviceId}:${kind}:pending`, dto.deviceId, dto.roomId,
      dto.roomName, kind, `${cap.name}（待确认）`, 'unknown', nowMs, dto.lastSeenTs);
    view.valueText = '待确认';
    view.detailText = '设备能力未核实，字段存在不代表已安装/有效；不显示为正常';
    views.push(view);
  }
  return views;
}

/** 未知设备：只提示“检测到字段但能力待确认”，不默认展示为正常。 */
function buildUnknownSensors(dto: DeviceDto, nowMs: number): SensorView[] {
  const views: SensorView[] = [];
  const sensors: SensorsDto = dto.sensors;
  if (sensors.climate !== null) {
    const v = makeSensor(`${dto.deviceId}:climate`, dto.deviceId, dto.roomId, dto.roomName,
      'climate', '温湿度（待确认）', 'unknown', nowMs, dto.lastSeenTs);
    v.valueText = '待确认';
    v.detailText = '设备能力未核实，字段存在不代表已安装/有效';
    views.push(v);
  }
  if (sensors.motion !== null) {
    const v = makeSensor(`${dto.deviceId}:motion`, dto.deviceId, dto.roomId, dto.roomName,
      'motion', '人体活动（待确认）', 'unknown', nowMs, dto.lastSeenTs);
    v.valueText = '待确认';
    v.detailText = '设备能力未核实，字段存在不代表已安装';
    views.push(v);
  }
  if (sensors.door !== null) {
    const v = makeSensor(`${dto.deviceId}:door`, dto.deviceId, dto.roomId, dto.roomName,
      'door', '门磁（待确认）', 'unknown', nowMs, dto.lastSeenTs);
    v.valueText = '待确认';
    v.detailText = '设备能力未核实，字段存在不代表已安装';
    views.push(v);
  }
  if (sensors.gas !== null) {
    const v = makeSensor(`${dto.deviceId}:gas`, dto.deviceId, dto.roomId, dto.roomName,
      'gas', '燃气（待确认）', 'unknown', nowMs, dto.lastSeenTs);
    v.valueText = '待确认';
    v.detailText = '设备能力未核实；不把原始值当 ppm';
    views.push(v);
  }
  if (sensors.smoke !== null) {
    const v = makeSensor(`${dto.deviceId}:smoke`, dto.deviceId, dto.roomId, dto.roomName,
      'smoke', '烟雾（待确认）', 'unknown', nowMs, dto.lastSeenTs);
    v.valueText = '待确认';
    v.detailText = '设备能力未核实；不把原始值当浓度';
    views.push(v);
  }
  if (sensors.water !== null) {
    const v = makeSensor(`${dto.deviceId}:water`, dto.deviceId, dto.roomId, dto.roomName,
      'water', '水漏（待确认）', 'unknown', nowMs, dto.lastSeenTs);
    v.valueText = '待确认';
    v.detailText = '设备能力未核实';
    views.push(v);
  }
  return views;
}

function stateTextForDevice(online: boolean, state: string): string {
  if (!online) return '离线';
  if (state === 'NORMAL') return '正常';
  if (state === 'WARN') return '关注';
  if (state === 'ALARM') return '告警';
  if (state === 'ACKED') return '已确认';
  if (state === 'OFFLINE') return '离线';
  if (state.length === 0) return '状态未知';
  return `状态 ${state}`;
}

function monitorTextFor(monitorOnline: number): string {
  if (monitorOnline === 1) return '视觉监测正常';
  if (monitorOnline === 0) return '在线·监测异常';
  return '监测状态未知';
}

/** 是否包含可展示的“读数”（用于离线时区分上次读数/暂无数据）。 */
function hasDisplayReading(valueText: string): boolean {
  if (valueText.length === 0) return false;
  if (valueText === '--') return false;
  if (valueText === '待确认') return false;
  return true;
}

/** 设备离线：所有传感器瓦片不得继续显示实时正常，只表达“离线 + 上次读数/暂无数据”。 */
function applyOfflinePresentation(sensor: SensorView): void {
  const hadReading: boolean = hasDisplayReading(sensor.valueText);
  sensor.state = 'offline';
  sensor.colorToken = 'neutral';
  if (hadReading) {
    if (sensor.valueText.indexOf('上次读数') !== 0) {
      sensor.valueText = `上次读数 ${sensor.valueText}`;
    }
    sensor.stateText = '离线·上次读数';
    const suffix: string = sensor.detailText.length > 0 ? `；${sensor.detailText}` : '';
    sensor.detailText = `设备离线，展示上次读数，不代表当前状态${suffix}`;
  } else {
    sensor.valueText = '--';
    sensor.stateText = '离线·暂无数据';
    sensor.detailText = '设备离线，且暂无历史读数';
  }
}

/** 电量数据新鲜期：lastSeenTs 距今超过 120s 视为过期（BATTERY-CHAIN-CONTRACT §6）。 */
export const BATTERY_STALE_AFTER_MS: number = 120 * 1000;
/** 未来时钟容差：超过该容差视为异常数据，不当作“刚刚更新”。 */
const BATTERY_FUTURE_TOLERANCE_MS: number = 5 * 60 * 1000;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 本地 HH:mm；0/非法时间返回空串（显示“时间未知”，不显示 1970）。 */
export function formatClockHm(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const date: Date = new Date(Math.floor(ts));
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function batteryMvText(mv: number | null): string {
  if (mv === null || mv <= 0) return '';
  return `${(mv / 1000).toFixed(2)} V`;
}

function batteryMissingDetail(capability: BatteryCapability, battery: BatteryDto | null): string {
  const parts: string[] = [];
  if (capability.note.length > 0) parts.push(capability.note);
  if (battery !== null && battery.reason.length > 0) parts.push(`上报原因：${battery.reason}`);
  if (battery !== null && battery.present === false) parts.push('设备报告未接电池（可能由外部供电）。');
  if (capability.requiredHardware.length > 0) parts.push(capability.requiredHardware);
  return parts.join(' ');
}

/**
 * 把设备电量 DTO + 台账电量能力映射为逐台 BatteryView。
 *
 * 规则（契约 §6，顺序即优先级）：
 * 1) fixed（台账判定固定供电）→“固定供电，无电池电量数据”；
 * 2) 设备离线（后端 online=false）→“设备离线，电量未知”；
 * 3) battery 缺失/无效/未接电池/mv=0→“电量未知（设备未上报电量）”；
 * 4) lastSeenTs 距今 >120s →“电量数据过期（最后更新 HH:mm）”；
 * 5) 真实新鲜数据→“3.85 V · 约 42% · 更新于 HH:mm”（未校准→“未标定”，low=true 加“电量偏低”）。
 * 任何分支都不补 0/100，不把电压当百分比。
 */
export function mapBattery(dto: DeviceDto, capability: BatteryCapability, nowMs: number): BatteryView {
  const view = new BatteryView();
  view.sourceText = capability.source;
  if (capability.source === BatterySource.FIXED) {
    view.status = BatteryStatus.FIXED;
    view.text = '固定供电，无电池电量数据';
    view.detail = capability.note;
    return view;
  }
  if (!dto.online) {
    view.status = BatteryStatus.OFFLINE;
    view.text = '设备离线，电量未知';
    view.detail = capability.note;
    return view;
  }
  const battery: BatteryDto | null = dto.battery;
  if (battery === null || battery.source === 'fixed') {
    view.status = BatteryStatus.MISSING;
    view.text = '电量未知（设备未上报电量）';
    view.detail = batteryMissingDetail(capability, battery);
    return view;
  }
  if (battery.present === false || battery.valid === false ||
    (battery.mv === null && battery.percent === null) || battery.mv === 0) {
    view.status = BatteryStatus.MISSING;
    view.text = '电量未知（设备未上报电量）';
    view.detail = batteryMissingDetail(capability, battery);
    return view;
  }
  const lastSeenAgeMs: number = nowMs - dto.lastSeenTs;
  if (dto.lastSeenTs <= 0 || lastSeenAgeMs > BATTERY_STALE_AFTER_MS ||
    lastSeenAgeMs < -BATTERY_FUTURE_TOLERANCE_MS) {
    const staleClock: string = formatClockHm(dto.lastSeenTs);
    view.status = BatteryStatus.STALE;
    view.text = staleClock.length > 0
      ? `电量数据过期（最后更新 ${staleClock}）`
      : '电量数据过期（最后更新时间未知）';
    view.detail = '设备在线，但电量数据超过 120 秒未更新，显示值不代表当前电量。';
    return view;
  }
  const sampledAt: number = battery.sampledAt > 0 ? battery.sampledAt : dto.lastSeenTs;
  const mvText: string = batteryMvText(battery.mv);
  const hasPercent: boolean = battery.percent !== null && battery.calibrated === true;
  const percentText: string = hasPercent ? `约 ${battery.percent}%` : '未标定';
  const clock: string = formatClockHm(sampledAt);
  let text: string = mvText.length > 0 ? `${mvText} · ${percentText}` : percentText;
  text += clock.length > 0 ? ` · 更新于 ${clock}` : ' · 更新于 时间未知';
  if (battery.low === true) {
    view.alert = true;
    text += ' · 电量偏低';
  }
  view.status = BatteryStatus.REAL;
  view.text = text;
  view.detail = hasPercent
    ? '来源：设备上报电量（已完成多点校准）。'
    : '来源：设备上报电压；未完成多点校准，只显示电压、不换算百分比。';
  view.hasPercent = hasPercent;
  view.mv = battery.mv;
  view.percent = hasPercent ? battery.percent : null;
  view.sampledAt = sampledAt;
  return view;
}

export function mapDevice(dto: DeviceDto, nowMs: number, demo: boolean = false): DeviceView {
  const view = new DeviceView();
  view.deviceId = dto.deviceId.length > 0 ? dto.deviceId : dto.id;
  view.id = dto.id.length > 0 ? dto.id : view.deviceId;
  // 家庭设备清单是"真实来源"：已核实设备用台账显示名/房间，未登记设备保留后端名字并单独隔离。
  // 演示模式保留显式的“（演示）”名称/房间，界面另有演示标识，不与真实账户数据混淆。
  const household: boolean = isHouseholdDevice(view.deviceId);
  view.deviceClass = household ? DeviceClass.HOUSEHOLD : DeviceClass.UNRECOGNIZED;
  const verifiedName: string = demo ? '' : verifiedNameFor(view.deviceId);
  view.name = verifiedName.length > 0
    ? verifiedName
    : (dto.name.length > 0 ? dto.name : (dto.roomName.length > 0 ? `${dto.roomName}节点` : view.deviceId));
  view.inventorySource = demo ? '演示数据（非真实设备）' : inventorySourceFor(view.deviceId);
  view.roomId = dto.roomId;
  view.roomName = dto.roomName.length > 0 ? dto.roomName : (household ? '' : '未分配房间');
  view.location = dto.location;
  view.roomAssigned = view.roomId.length > 0 || dto.roomName.length > 0;
  const freshOnline: boolean = isDeviceFresh(dto.online, dto.lastSeenTs, nowMs);
  view.online = freshOnline;
  view.monitorOnline = dto.monitorOnline;
  view.state = dto.state;
  view.stateText = stateTextForDevice(freshOnline, dto.state);
  view.monitorText = monitorTextFor(dto.monitorOnline);
  view.lastSeenTs = dto.lastSeenTs;
  // lastSeen 超前超过容差（设备/服务器时钟异常）= 时间未知；绝不显示“刚刚”冒充实时。
  const lastSeenUsable: boolean = dto.lastSeenTs > 0 &&
    dto.lastSeenTs <= nowMs + FUTURE_SKEW_TOLERANCE_MS;
  view.lastSeenText = lastSeenUsable ? formatAge(nowMs, dto.lastSeenTs) : '时间未知';
  view.monitorReason = dto.monitorReason;
  view.monitorReasonText = monitorReasonTextFor(dto.monitorReason);
  view.csq = dto.csq;
  const profile: CapabilityProfile = resolveCapability(view.deviceId);
  view.capabilityVerified = profile.verified;
  view.capabilitySummary = household ? capabilitySummaryOf(view.deviceId) : '未纳入监护';
  let note: string = household ? capabilityNoteOf(view.deviceId) : unrecognizedReasonFor(view.deviceId, view.roomName);
  if (dto.sensors.unknownKeys.length > 0) {
    note = `${note} 未识别 sensors 字段：${dto.sensors.unknownKeys.join('、')}`;
  }
  view.capabilityNote = note;
  // 逐台电量：台账能力（fixed/battery-capable）+ 设备真实上报 → 状态文案；不写死数值。
  const batteryCapability: BatteryCapability = batteryCapabilityFor(view.deviceId);
  view.battery = mapBattery(dto, batteryCapability, nowMs);
  const sensors: SensorView[] = [];
  // 未纳入监护的后端记录不生成传感器瓦片：它们不参与监护统计与告警判读，
  // 只在设备管理页如实说明来源，避免把测试/历史数据伪装成家庭传感器。
  if (household) {
    if (profile.verified) {
      const climate = buildClimateView(dto, nowMs, profile);
      if (climate !== null) sensors.push(climate);
      // 活动检测语义按来源分流：PIR 与摄像头判定是两种能力，绝不混用文案。
      const motionSemantics: string = motionSemanticsFor(dto, profile);
      if (motionSemantics === 'pir') {
        const motion = buildMotionView(dto, nowMs, profile);
        if (motion !== null) sensors.push(motion);
      } else if (motionSemantics === 'camera') {
        sensors.push(buildPirUnconfiguredView(dto, nowMs, profile, true));
        const cameraMotion = buildCameraMotionView(dto, nowMs, profile);
        if (cameraMotion !== null) sensors.push(cameraMotion);
      } else if (motionSemantics === 'unsupported') {
        // 状态显式声明未配置 PIR：如果是摄像头设备，同时保留独立的摄像头判定瓦片。
        sensors.push(buildPirUnconfiguredView(dto, nowMs, profile,
          profile.motionSource === MotionSource.CAMERA));
        if (profile.motionSource === MotionSource.CAMERA) {
          const cameraMotion = buildCameraMotionView(dto, nowMs, profile);
          if (cameraMotion !== null) sensors.push(cameraMotion);
        }
      }
      const gas = buildRawSensorView(dto, nowMs, profile, 'gas', '燃气（MQ-5）');
      if (gas !== null) sensors.push(gas);
      const smoke = buildRawSensorView(dto, nowMs, profile, 'smoke', '烟雾（MQ-2）');
      if (smoke !== null) sensors.push(smoke);
      const door = buildDoorView(dto, nowMs, profile);
      if (door !== null) sensors.push(door);
      const water = buildWaterView(dto, nowMs, profile);
      if (water !== null) sensors.push(water);
      const pendingViews: SensorView[] = buildPendingSensors(dto, nowMs, profile);
      for (let i = 0; i < pendingViews.length; i++) {
        sensors.push(pendingViews[i]);
      }
    } else {
      const unknownViews = buildUnknownSensors(dto, nowMs);
      for (let i = 0; i < unknownViews.length; i++) {
        sensors.push(unknownViews[i]);
      }
    }
  }
  // 离线状态优先于单个传感器的读数语义；随后统一写入颜色 token（仅 ok 才 success）。
  // “未配置 PIR”等 unsupported 能力不属于数据陈旧，离线时也保持其明确文案。
  if (!view.online) {
    for (let i = 0; i < sensors.length; i++) {
      if (sensors[i].state === 'unsupported') continue;
      applyOfflinePresentation(sensors[i]);
    }
  }
  let hasReading: boolean = false;
  for (let i = 0; i < sensors.length; i++) {
    sensors[i].colorToken = colorTokenForSensorState(sensors[i].state);
    // 未配置/未安装能力不是“历史读数”，不计入 hasReading（避免首页误报“有历史读数”）。
    if (sensors[i].state === 'unsupported') continue;
    if (sensors[i].valueText !== '--' && sensors[i].valueText !== '待确认' &&
      sensors[i].valueText.indexOf('暂无') < 0 && sensors[i].valueText.indexOf('未配置') < 0) {
      hasReading = true;
    }
  }
  view.hasReading = hasReading;
  view.sensors = sensors;
  return view;
}

/** 按“是否纳入家庭监护”拆分设备；未识别设备只如实列出，不参与统计。 */
export class DeviceSplit {
  household: DeviceView[] = [];
  unrecognized: DeviceView[] = [];
}

export function splitDevices(devices: DeviceView[]): DeviceSplit {
  const split = new DeviceSplit();
  for (let i = 0; i < devices.length; i++) {
    if (devices[i].deviceClass === DeviceClass.HOUSEHOLD) {
      split.household.push(devices[i]);
    } else {
      split.unrecognized.push(devices[i]);
    }
  }
  return split;
}

/**
 * 只保留“确实包含已核实家庭设备”的房间。
 * 后端可能保留测试/历史房间（例如“隔离测试”），不得把它们显示成家庭房间或计入统计。
 */
export function householdRooms(rooms: RoomDto[], householdDevices: DeviceView[]): RoomDto[] {
  const roomIds: Set<string> = new Set<string>();
  const roomNames: Set<string> = new Set<string>();
  for (let i = 0; i < householdDevices.length; i++) {
    const d: DeviceView = householdDevices[i];
    if (d.roomId.length > 0) roomIds.add(d.roomId);
    if (d.roomName.length > 0) roomNames.add(d.roomName);
  }
  const result: RoomDto[] = [];
  for (let i = 0; i < rooms.length; i++) {
    const room: RoomDto = rooms[i];
    if (roomIds.has(room.id) || roomNames.has(room.name)) {
      result.push(room);
    }
  }
  return result;
}

export function mapDevices(devices: DeviceDto[], nowMs: number, demo: boolean = false): DeviceView[] {
  const result: DeviceView[] = [];
  for (let i = 0; i < devices.length; i++) {
    const dto: DeviceDto = devices[i];
    if (dto.deviceId.length === 0 && dto.id.length === 0) continue;
    result.push(mapDevice(dto, nowMs, demo));
  }
  return result;
}

function deriveRoomState(devices: DeviceView[]): string {
  let hasAlarm: boolean = false;
  let hasWarn: boolean = false;
  let allOffline: boolean = devices.length > 0;
  for (let i = 0; i < devices.length; i++) {
    const d: DeviceView = devices[i];
    if (d.state === 'ALARM') hasAlarm = true;
    if (d.state === 'WARN') hasWarn = true;
    if (d.online) allOffline = false;
  }
  if (hasAlarm) return 'ALARM';
  if (hasWarn) return 'WARN';
  if (allOffline) return 'OFFLINE';
  return 'NORMAL';
}

export function mapRooms(rooms: RoomDto[], devices: DeviceView[]): RoomView[] {
  const deviceById: Map<string, DeviceView> = new Map<string, DeviceView>();
  for (let i = 0; i < devices.length; i++) {
    deviceById.set(devices[i].deviceId, devices[i]);
  }
  const used: Set<string> = new Set<string>();
  const result: RoomView[] = [];
  for (let i = 0; i < rooms.length; i++) {
    const dto: RoomDto = rooms[i];
    const view = new RoomView();
    view.id = dto.id;
    view.name = dto.name.length > 0 ? dto.name : dto.id;
    view.location = dto.location;
    const roomDevices: DeviceView[] = [];
    for (let j = 0; j < devices.length; j++) {
      const device: DeviceView = devices[j];
      if (dto.id.length > 0 && device.roomId === dto.id) {
        roomDevices.push(device);
        used.add(device.deviceId);
      }
    }
    view.devices = roomDevices;
    view.deviceCount = roomDevices.length > 0 ? roomDevices.length : dto.deviceCount;
    view.onlineDeviceCount = roomDevices.length > 0
      ? roomDevices.filter((item: DeviceView): boolean => item.online).length
      : dto.onlineDeviceCount;
    view.state = dto.state.length > 0 ? dto.state : deriveRoomState(roomDevices);
    view.isSynthetic = false;
    result.push(view);
  }
  const unassigned: DeviceView[] = [];
  for (let i = 0; i < devices.length; i++) {
    if (!used.has(devices[i].deviceId)) {
      unassigned.push(devices[i]);
    }
  }
  if (unassigned.length > 0) {
    const view = new RoomView();
    view.id = '__unassigned__';
    view.name = '未分配房间';
    view.devices = unassigned;
    view.deviceCount = unassigned.length;
    view.onlineDeviceCount = unassigned.filter((item: DeviceView): boolean => item.online).length;
    view.state = deriveRoomState(unassigned);
    view.isSynthetic = true;
    result.push(view);
  }
  return result;
}

export function alertTypeLabel(type: string): string {
  if (type === 'FALL') return '检测到跌倒';
  if (type === 'MANUAL_SOS') return '紧急求助按键';
  if (type === 'GAS') return '燃气异常';
  if (type === 'SMOKE') return '烟雾异常';
  if (type === 'NO_MOTION') return '长时间无活动';
  if (type === 'WATER_LEAK') return '水漏异常';
  if (type === 'CLIMATE') return '环境异常';
  if (type.length === 0) return '告警';
  return `告警（${type}）`;
}

/**
 * 告警标题（按设备真实能力校正）：
 * NO_MOTION 只属于 PIR 能力；客厅 dayu200-living 没有 PIR（人员检测来自摄像头判定），
 * 历史/错误来源的 NO_MOTION 不得直接展示成“长时间无活动”，必须标注需核实。
 */
export function alertTitleFor(type: string, deviceId: string): string {
  if (type === 'NO_MOTION') {
    const profile: CapabilityProfile = resolveCapability(deviceId);
    if (profile.motionSource === MotionSource.CAMERA) {
      return '无活动告警（未配置 PIR，来源需核实）';
    }
  }
  return alertTypeLabel(type);
}

export function alertLevelFor(type: string): string {
  if (type === 'FALL' || type === 'MANUAL_SOS') return 'critical';
  if (type === 'GAS' || type === 'SMOKE' || type === 'WATER_LEAK' || type === 'CLIMATE') return 'high';
  if (type === 'NO_MOTION') return 'medium';
  return 'low';
}

export function alertSensorKindFor(type: string): SensorKind {
  if (type === 'MANUAL_SOS') return 'sos';
  if (type === 'GAS') return 'gas';
  if (type === 'SMOKE') return 'smoke';
  if (type === 'WATER_LEAK') return 'water';
  // FALL 是摄像头/PC YOLO 能力，与 PIR 的 NO_MOTION 分开核对，避免互相误判能力不符。
  if (type === 'FALL') return 'fall';
  if (type === 'NO_MOTION') return 'motion';
  if (type === 'CLIMATE') return 'climate';
  return 'motion';
}

/**
 * sosLocation DTO → 视图（可选字段，缺失不崩）。
 * 诚实性：LOCATED/STALE 但缺经纬度时降级 UNAVAILABLE（不能“定位有效”却没有坐标）；
 * 未知 status 一律 UNAVAILABLE；时间缺失/0 保持 0（页面显示“时间未知”，不显示 1970）。
 */
export function mapSosLocation(dto: SosLocationDto | null): SosLocationView | null {
  if (dto === null) return null;
  const view = new SosLocationView();
  view.present = dto.present;
  view.status = normalizeSosStatus(dto.status);
  view.latitude = validLatitudeValue(dto.latitude);
  view.longitude = validLongitudeValue(dto.longitude);
  view.positionTime = validEpochMs(dto.positionTime);
  view.receivedAt = validEpochMs(dto.receivedAt);
  view.ageSeconds = dto.ageSeconds !== null ? validAgeSeconds(dto.ageSeconds) : null;
  if ((view.status === SosStatus.LOCATED || view.status === SosStatus.STALE) &&
    (view.latitude === null || view.longitude === null)) {
    view.status = SosStatus.UNAVAILABLE;
  }
  return view;
}

export function mapAlert(dto: AlertDto): AlertView {
  const view = new AlertView();
  view.alarmId = dto.alarmId.length > 0 ? dto.alarmId : dto.id;
  view.id = dto.id.length > 0 ? dto.id : view.alarmId;
  view.deviceId = dto.deviceId;
  view.roomName = dto.roomName;
  view.type = dto.type;
  view.message = dto.message;
  view.state = dto.state;
  view.ackPending = dto.ackPending;
  view.createdAt = dto.createdAt;
  view.acknowledgedAt = dto.acknowledgedAt;
  view.acknowledgedBy = dto.acknowledgedBy;
  view.location = dto.roomName.length > 0 ? dto.roomName : '未分配';
  view.level = alertLevelFor(dto.type);
  view.sensorType = alertSensorKindFor(dto.type);
  view.title = alertTitleFor(dto.type, dto.deviceId);
  // 告警类型与设备真实能力不符合时（例如厨房节点并无 PIR），页面必须提示核实。
  view.capabilityWarning = capabilityWarningFor(dto.deviceId, view.sensorType, view.title);
  view.sosLocation = mapSosLocation(dto.sosLocation);
  const message: string = dto.message.length > 0 ? dto.message : '服务端未提供告警详情';
  view.description = `${message} · 设备 ${dto.deviceId}`;
  view.evidenceAvailable = dto.evidence.available;
  view.evidenceId = dto.evidence.evidenceId;
  view.evidenceBytes = dto.evidence.bytes;
  view.evidenceCapturedAt = dto.evidence.capturedAt;
  if (dto.state === 'ACKED') {
    view.statusKey = 'acked';
    view.statusText = '设备已确认';
    view.acknowledgedText = '设备已确认';
  } else if (dto.state === 'ALARM' && dto.ackPending) {
    view.statusKey = 'waiting';
    view.statusText = '等待设备确认';
  } else if (dto.state === 'ALARM') {
    view.statusKey = 'pending';
    view.statusText = '待确认';
  } else {
    view.statusKey = 'unknown';
    view.statusText = dto.state.length > 0 ? `状态 ${dto.state}` : '状态未知';
  }
  return view;
}

export function mapAlerts(alerts: AlertDto[]): AlertView[] {
  const result: AlertView[] = [];
  for (let i = 0; i < alerts.length; i++) {
    result.push(mapAlert(alerts[i]));
  }
  result.sort((left: AlertView, right: AlertView): number => right.createdAt - left.createdAt);
  return result;
}

export function mapOverview(dto: OverviewDto): OverviewView {
  const view = new OverviewView();
  view.hasData = true;
  view.generatedAt = dto.generatedAt;
  view.deviceCount = dto.deviceCount;
  view.onlineCount = dto.onlineCount;
  view.monitorOfflineCount = dto.monitorOfflineCount;
  view.activeAlertCount = dto.activeAlertCount;
  view.locationText = dto.locationText;
  view.latestAlert = dto.latestAlert !== null ? mapAlert(dto.latestAlert) : null;
  return view;
}

export function mapContacts(contacts: ContactDto[]): ContactView[] {
  const result: ContactView[] = [];
  for (let i = 0; i < contacts.length; i++) {
    const dto: ContactDto = contacts[i];
    const view = new ContactView();
    view.id = dto.id;
    view.name = dto.name;
    view.relation = dto.relation;
    view.phone = dto.phone;
    view.primary = dto.primary;
    result.push(view);
  }
  return result;
}

/** 待关注告警数（待确认 + 等待设备确认），供 Tab 徽标。 */
export function countNeedsAttention(alerts: AlertView[]): number {
  let count: number = 0;
  for (let i = 0; i < alerts.length; i++) {
    if (alerts[i].statusKey === 'pending' || alerts[i].statusKey === 'waiting') {
      count += 1;
    }
  }
  return count;
}

/** ACK 后从最新 alerts 查找指定告警；找不到返回 null（页面显示不存在/已失效，禁止 Mock 回退）。 */
export function findAlert(alerts: AlertView[], alarmId: string): AlertView | null {
  for (let i = 0; i < alerts.length; i++) {
    if (alerts[i].alarmId === alarmId) {
      return alerts[i];
    }
  }
  return null;
}

// ============================================================================
// 处置结果 / 安全日志视图映射（CONTRACT v1 增量）
// ============================================================================

/** 处置结果选项（顺序与合同第 1 节一致）。 */
export class DispositionOption {
  value: string = '';
  label: string = '';
}

/** 5 个可选处置结果；页面只允许提交这些值（OTHER 时说明必填由页面/服务校验）。 */
export function dispositionOptions(): DispositionOption[] {
  const out: DispositionOption[] = [];
  const values: string[] = [
    'CONTACTED_FAMILY', 'CONTACTED_COMMUNITY', 'ON_SITE_CONFIRMED_NORMAL', 'FALSE_ALARM', 'OTHER'
  ];
  for (let i = 0; i < values.length; i++) {
    const option = new DispositionOption();
    option.value = values[i];
    option.label = dispositionOutcomeLabel(values[i]);
    out.push(option);
  }
  return out;
}

/** outcome → 中文文案；未知枚举返回空串（调用方显示“未知结果”，不猜测语义）。 */
export function dispositionOutcomeLabel(outcome: string): string {
  if (outcome === 'CONTACTED_FAMILY') return '已联系家属';
  if (outcome === 'CONTACTED_COMMUNITY') return '已联系社区';
  if (outcome === 'ON_SITE_CONFIRMED_NORMAL') return '现场确认正常';
  if (outcome === 'FALSE_ALARM') return '误报';
  if (outcome === 'OTHER') return '其他说明';
  return '';
}

function dispositionTimeValid(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 单条处置记录 → 视图（时间无效态、处理人/房间缺省文案统一在这里处理）。 */
export function mapDisposition(dto: DispositionDto): DispositionView {
  const view = new DispositionView();
  view.dispositionId = dto.dispositionId;
  view.alarmId = dto.alarmId;
  view.deviceId = dto.deviceId;
  view.roomName = dto.roomName;
  view.roomText = dto.roomName.length > 0 ? dto.roomName : '房间未知';
  view.alarmType = dto.alarmType;
  view.alarmTypeLabel = alertTypeLabel(dto.alarmType);
  view.alarmCreatedAt = dto.alarmCreatedAt;
  view.hasValidAlarmCreatedAt = dispositionTimeValid(dto.alarmCreatedAt);
  view.outcome = dto.outcome;
  const mapped: string = dispositionOutcomeLabel(dto.outcome);
  view.outcomeLabel = dto.outcomeLabel.length > 0
    ? dto.outcomeLabel
    : (mapped.length > 0 ? mapped : '未知结果');
  view.note = dto.note;
  view.operator = dto.operator;
  view.operatorText = dto.operator.length > 0 ? dto.operator : '处理人未知';
  view.operatorRole = dto.operatorRole;
  view.serverTime = dto.serverTime;
  view.hasValidServerTime = dispositionTimeValid(dto.serverTime);
  return view;
}

/** 列表映射：保持服务端顺序（合同 2.2/2.3 已按 serverTime 降序返回），不本地重排。 */
export function mapDispositions(dtos: DispositionDto[]): DispositionView[] {
  const out: DispositionView[] = [];
  for (let i = 0; i < dtos.length; i++) {
    out.push(mapDisposition(dtos[i]));
  }
  return out;
}

export function mapSafetyLogs(dtos: SafetyLogDto[]): DispositionView[] {
  const out: DispositionView[] = [];
  for (let i = 0; i < dtos.length; i++) {
    out.push(mapDisposition(dtos[i]));
  }
  return out;
}
