/**
 * 设备能力表（已核实 / 未核实）—— 纯逻辑，可被 Node 测试。
 *
 * 依据（2026-10-21 只读核对）：
 * - esp32-kitchen：AHT20 温湿度；MQ-2/MQ-5 原始 ADC（阈值 4096，报警禁用，未标定）；
 *   板载蜂鸣器。无 PIR、门磁、水漏、摄像头。
 * - esp32-bath：AHT20 温湿度；PIR 活动；SOS 按键；板载蜂鸣器。水漏本轮禁用；
 *   无燃气、烟雾、门磁、摄像头。
 * - dayu200-living：客厅主控 + 本地摄像头 + 跌倒检测/语音；APP 无实时视频接口。
 *   其余传感器能力未核实，不得默认拥有。
 * - 未知 deviceId：全部“待确认”，不得默认拥有任何传感器。
 *
 * 注意：云端适配器当前会剥离 sensors.*.valid（校验后不透传），因此 valid 一律视为未知，
 * 不得在 APP 内编造 valid=true。字段存在也不代表传感器已安装（禁用通道会输出占位值）。
 */

export type SensorKind =
  | 'motion'
  | 'door'
  | 'climate'
  | 'gas'
  | 'smoke'
  | 'sos'
  | 'water'
  | 'camera'
  | 'fall';

export type SensorTileState =
  | 'ok'
  | 'attention'
  | 'critical'
  | 'offline'
  | 'invalid'
  | 'waiting'
  | 'disabled'
  | 'unsupported'
  | 'unknown';

export type ValidityState = 'valid' | 'invalid' | 'unknown';

/**
 * 人体活动检测来源：PIR（人体红外）与摄像头判定是**两种不同能力**，
 * 文案与告警语义不得混用（2026-10-27 能力口径）。
 */
export class MotionSource {
  static readonly PIR: string = 'pir';
  static readonly CAMERA: string = 'camera';
  static readonly NONE: string = 'none';
}

/** 无 PIR 时设备/瓦片的固定文案（用户要求逐字）。 */
export const PIR_UNCONFIGURED_TEXT: string = '未配置 PIR，无活动监测';
/** 有 PIR 能力但本次未上报有效活动数据。 */
export const PIR_NO_DATA_TEXT: string = '暂无有效 PIR 数据';
/** 摄像头判定没有有效推理结果（无结果/监测异常/未知）。 */
export const CAMERA_NO_VALID_DATA_TEXT: string = '暂无有效检测数据';

/** 页面侧推荐使用的状态常量（避免魔法字符串拼错）。 */
export class SensorStates {
  static readonly OK: string = 'ok';
  static readonly ATTENTION: string = 'attention';
  static readonly CRITICAL: string = 'critical';
  static readonly OFFLINE: string = 'offline';
  static readonly INVALID: string = 'invalid';
  static readonly WAITING: string = 'waiting';
  static readonly DISABLED: string = 'disabled';
  static readonly UNSUPPORTED: string = 'unsupported';
  static readonly UNKNOWN: string = 'unknown';
}

export function stateTextOf(state: SensorTileState): string {
  if (state === 'ok') return '正常';
  if (state === 'attention') return '关注';
  if (state === 'critical') return '异常';
  if (state === 'offline') return '离线';
  if (state === 'invalid') return '无效';
  if (state === 'waiting') return '等待数据';
  if (state === 'disabled') return '报警未启用';
  if (state === 'unsupported') return '未安装/未启用';
  return '待确认';
}

export type SensorColorToken = 'success' | 'warning' | 'critical' | 'info' | 'neutral';

/**
 * 卡片颜色语义：只有“读取有效且状态正常”的 ok 才允许绿色。
 * unknown（有效性未知）、offline（离线/上次读数）、disabled（报警未启用）、
 * unsupported/未安装 一律中性色，避免把“有读数”误读为“环境正常”。
 */
export function colorTokenForSensorState(state: SensorTileState): SensorColorToken {
  if (state === 'ok') return 'success';
  if (state === 'attention' || state === 'invalid') return 'warning';
  if (state === 'critical') return 'critical';
  if (state === 'waiting') return 'info';
  return 'neutral';
}

export class CapabilityEntry {
  kind: SensorKind = 'motion';
  name: string = '';
  installed: boolean = false;
  enabled: boolean = false;
  /** 该能力是否具备云端告警能力（false 表示只能看数据/或未启用） */
  alarmEnabled: boolean = false;
  note: string = '';
}

export class CapabilityProfile {
  deviceId: string = '';
  displayName: string = '';
  /** 是否已核实（未知设备为 false） */
  verified: boolean = false;
  note: string = '';
  /**
   * 人体活动检测来源（MotionSource）：pir=真实 PIR 硬件；camera=摄像头判定（非 PIR）；
   * none=无活动检测能力。默认 none，避免把未知来源当 PIR。
   */
  motionSource: string = MotionSource.NONE;
  entries: CapabilityEntry[] = [];

  find(kind: SensorKind): CapabilityEntry {
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].kind === kind) {
        return this.entries[i];
      }
    }
    return new CapabilityEntry();
  }
}

function entry(kind: SensorKind, name: string, installed: boolean, enabled: boolean,
  alarmEnabled: boolean, note: string): CapabilityEntry {
  const item = new CapabilityEntry();
  item.kind = kind;
  item.name = name;
  item.installed = installed;
  item.enabled = enabled;
  item.alarmEnabled = alarmEnabled;
  item.note = note;
  return item;
}

function makeKitchen(): CapabilityProfile {
  const p = new CapabilityProfile();
  p.deviceId = 'esp32-kitchen';
  p.displayName = '厨房节点';
  p.verified = true;
  p.motionSource = MotionSource.PIR;
  p.note = '已核实（2026-10-27 在板固件）：AHT20 温湿度、MQ-2/MQ-5 原始 ADC（GAS/SMOKE 阈值 4096 永不告警，未标定）、SR312 PIR 活动（GPIO38，1800s 无活动触发 NO_MOTION）、门磁（GPIO14）、板载蜂鸣器、CLIMATE 告警启用；水漏、摄像头未安装。';
  p.entries = [
    entry('climate', '温湿度', true, true, true, 'AHT20 读数；云端未透传 valid，有效性按读数推断；CLIMATE 告警启用（5–45℃/10–90%RH）'),
    entry('gas', '燃气（MQ-5）', true, true, false, 'MQ-5 原始 ADC；GAS 报警未启用，未标定，不代表 ppm'),
    entry('smoke', '烟雾（MQ-2）', true, true, false, 'MQ-2 原始 ADC；SMOKE 报警未启用，未标定，不代表 ppm'),
    entry('motion', '人体活动（PIR）', true, true, true,
      'SR312 PIR（GPIO38）2026-10-27 起在板；1800s 无活动触发 NO_MOTION（需先武装）'),
    entry('door', '门磁', true, true, true,
      '干簧管门磁（GPIO14，常开 NO，OPEN_LEVEL=1）；2026-10-27 起真实开关记录，生产 v7 已入库'),
    entry('water', '水漏', false, false, false, '未安装'),
    entry('camera', '摄像头', false, false, false, '未安装'),
    entry('sos', '紧急求助按键', false, false, false, '未安装')
  ];
  return p;
}

function makeBath(): CapabilityProfile {
  const p = new CapabilityProfile();
  p.deviceId = 'esp32-bath';
  p.displayName = '卫生间节点';
  p.verified = true;
  p.motionSource = MotionSource.PIR;
  p.note = '已核实（2026-10-27 在板固件）：AHT20 温湿度、PIR 活动（GPIO36）、SOS 按键、门磁（GPIO14）、板载蜂鸣器；1800s 无活动触发 NO_MOTION；水漏本轮未启用；无燃气/烟雾/摄像头。';
  p.entries = [
    entry('climate', '温湿度', true, true, true, 'AHT20 读数；云端未透传 valid，有效性按读数推断；CLIMATE 告警启用'),
    entry('motion', '人体活动（PIR）', true, true, true, 'PIR（GPIO36）上报活动时间/次数；长时间无活动会触发 NO_MOTION 告警'),
    entry('sos', '紧急求助按键', true, true, true, 'SOS 事件会形成 MANUAL_SOS 告警'),
    entry('water', '水漏', false, false, false, '本轮未启用（CONFIG_NODE_WATER_GPIO=-1）'),
    entry('gas', '燃气', false, false, false, '未安装（MQ 禁用）'),
    entry('smoke', '烟雾', false, false, false, '未安装（MQ 禁用）'),
    entry('door', '门磁', true, true, true,
      '干簧管门磁（GPIO14，常开 NO，OPEN_LEVEL=1）；2026-10-27 起真实开关记录'),
    entry('camera', '摄像头', false, false, false, '未安装')
  ];
  return p;
}

function makeDayu(): CapabilityProfile {
  const p = new CapabilityProfile();
  p.deviceId = 'dayu200-living';
  p.displayName = '客厅主控';
  p.verified = true;
  // 客厅**没有 PIR**；人员检测来自摄像头 + 本机 YOLO 推理，是另一种能力（不得按 PIR 活动语义展示）。
  p.motionSource = MotionSource.CAMERA;
  p.note = '已核实：客厅主控/相机本地取帧/摄像头人体活动判定/跌倒判定（PC CPU YOLO，非板端 NPU）/语音（本地）；'
    + 'APP 无实时视频接口，只能查看在线、监测状态、摄像头检测结果与 FALL 告警证据可用性；'
    + '未配置 PIR（人员检测来自摄像头判定，与 PIR 活动是两种能力）；物理环境传感器未接线，固件兼容占位字段不展示，不当作已安装。';
  p.entries = [
    entry('camera', '摄像头人体检测', true, true, false,
      '由客厅摄像头 + 本机 YOLO 判定；仅检测结果，非 PIR；APP 无实时视频接口，不显示实时画面'),
    entry('fall', '跌倒判定（PC YOLO）', true, true, true, '由 PC CPU YOLO 判定，非板端 NPU；FALL 告警与证据元数据可上报'),
    entry('motion', 'PIR 活动监测（未配置）', false, false, false,
      '未配置 PIR，无活动监测；客厅人员检测来自摄像头判定，不得按 PIR 活动/NO_MOTION 语义展示'),
    entry('climate', '温湿度', false, false, false, '未安装（本机未接线；固件兼容占位字段不展示）'),
    entry('door', '门磁', false, false, false, '未安装（本机未接线；固件兼容占位字段不展示）'),
    entry('gas', '燃气', false, false, false, '未安装（本机未接线；MQ 占位字段不展示）'),
    entry('smoke', '烟雾', false, false, false, '未安装（本机未接线；MQ 占位字段不展示）'),
    entry('water', '水漏', false, false, false, '未安装'),
    entry('sos', '紧急求助按键', false, false, false, '未安装（随身求助是独立 esp32-sos 设备）')
  ];
  return p;
}

/**
 * 随身求助节点（esp32-sos，COM8）：独立 ESP32-S3 板，按钮 IO4、蜂鸣器 IO5、GPIO6 禁用；
 * 通过 Wi-Fi / 网关上报 MANUAL_SOS。当前没有摄像头、也没有电量遥测。
 * 来源：competition/evidence/2026-10-26-wireless-sos-button-final/REPORT.md。
 */
function makeSos(): CapabilityProfile {
  const p = new CapabilityProfile();
  p.deviceId = 'esp32-sos';
  p.displayName = '随身求助节点';
  p.verified = true;
  p.motionSource = MotionSource.NONE;
  p.note = '已核实：随身 SOS 按键（IO4 输入上拉）、蜂鸣提示（IO5）、Wi-Fi 上报 MANUAL SOS 与定位记录；无摄像头/温湿度/燃气/烟雾/门磁/水漏；当前无电量遥测。';
  p.entries = [
    entry('sos', '紧急求助按键', true, true, true, '按下按钮形成 MANUAL_SOS 告警；可配套 /api/v1/location 查看随身定位'),
    entry('camera', '摄像头', false, false, false, '未安装'),
    entry('climate', '温湿度', false, false, false, '未安装'),
    entry('motion', '人体活动', false, false, false, '未安装'),
    entry('door', '门磁', false, false, false, '未安装'),
    entry('gas', '燃气', false, false, false, '未安装'),
    entry('smoke', '烟雾', false, false, false, '未安装'),
    entry('water', '水漏', false, false, false, '未安装'),
    entry('fall', '跌倒检测', false, false, false, '未安装（跌倒判定在客厅 DAYU200）')
  ];
  return p;
}

function makeUnknown(deviceId: string): CapabilityProfile {
  const p = new CapabilityProfile();
  p.deviceId = deviceId;
  p.displayName = deviceId.length > 0 ? deviceId : '未知设备';
  p.verified = false;
  p.note = '未核实该设备能力；不默认拥有任何传感器，字段存在也不代表已安装。';
  p.entries = [
    entry('climate', '温湿度', false, false, false, '待确认'),
    entry('motion', '人体活动', false, false, false, '待确认'),
    entry('door', '门磁', false, false, false, '待确认'),
    entry('gas', '燃气', false, false, false, '待确认'),
    entry('smoke', '烟雾', false, false, false, '待确认'),
    entry('water', '水漏', false, false, false, '待确认'),
    entry('sos', '紧急求助按键', false, false, false, '待确认'),
    entry('camera', '摄像头', false, false, false, '待确认'),
    entry('fall', '跌倒检测', false, false, false, '待确认')
  ];
  return p;
}

const capabilityCache: Map<string, CapabilityProfile> = new Map<string, CapabilityProfile>();

export function resolveCapability(deviceId: string): CapabilityProfile {
  const key: string = deviceId.length > 0 ? deviceId : '__unknown__';
  const cached: CapabilityProfile | undefined = capabilityCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let profile: CapabilityProfile;
  if (deviceId === 'esp32-kitchen') {
    profile = makeKitchen();
  } else if (deviceId === 'esp32-bath') {
    profile = makeBath();
  } else if (deviceId === 'dayu200-living') {
    profile = makeDayu();
  } else if (deviceId === 'esp32-sos') {
    profile = makeSos();
  } else {
    profile = makeUnknown(deviceId);
  }
  capabilityCache.set(key, profile);
  return profile;
}

/** 已核实且已启用的能力，例如“温湿度、燃气（MQ-5）”。 */
export function capabilitySummaryOf(deviceId: string): string {
  const profile: CapabilityProfile = resolveCapability(deviceId);
  if (!profile.verified) {
    return '能力待确认';
  }
  const installed: string[] = [];
  for (let i = 0; i < profile.entries.length; i++) {
    const item: CapabilityEntry = profile.entries[i];
    if (item.installed && item.enabled) {
      installed.push(item.name);
    }
  }
  return installed.length > 0 ? installed.join('、') : '暂无已核实能力';
}

/** 未安装/未启用/待确认的能力清单，供设备页明确展示。 */
export function capabilityNoteOf(deviceId: string): string {
  const profile: CapabilityProfile = resolveCapability(deviceId);
  if (!profile.verified) {
    return profile.note;
  }
  const missing: string[] = [];
  for (let i = 0; i < profile.entries.length; i++) {
    const item: CapabilityEntry = profile.entries[i];
    if (!item.installed || !item.enabled) {
      missing.push(item.name);
    }
  }
  const suffix: string = missing.length > 0 ? `未安装/未启用：${missing.join('、')}` : '全部已核实能力已启用';
  return `${profile.note} ${suffix}`;
}

/** 原始 ADC 值只能显示为原始值，禁止冒充 ppm。 */
export function formatRawAdc(raw: number | null): string {
  if (raw === null || !isFinite(raw)) {
    return '未收到原始值';
  }
  return `原始 ADC ${Math.round(raw)}`;
}

/**
 * 告警类型与设备真实能力的核对提示。
 * 已核实设备上出现"未安装能力"的告警，说明该告警来自历史/测试/错配数据，
 * 页面必须如实提示核实，不能默认当成真实硬件事件处置。
 */
export function capabilityWarningFor(deviceId: string, kind: SensorKind, kindLabel: string): string {
  const profile: CapabilityProfile = resolveCapability(deviceId);
  if (!profile.verified) {
    return `未核实设备 ${deviceId} 的能力；该${kindLabel}告警来源待确认，请先核对设备。`;
  }
  // “长时间无活动（NO_MOTION）”只属于 PIR 能力；客厅是摄像头判定，必须提示不得按 PIR 判读。
  if (kind === 'motion' && profile.motionSource === MotionSource.CAMERA) {
    return `能力核对：${profile.displayName}未配置 PIR；“长时间无活动”不能按 PIR 活动判读，` +
      '客厅人员检测来自摄像头判定，请核实告警来源后再处置。';
  }
  const cap: CapabilityEntry = profile.find(kind);
  if (!cap.installed) {
    return `能力核对：${profile.displayName} 未安装/未核实${cap.name.length > 0 ? cap.name : kindLabel}能力，` +
      '此告警可能来自测试/历史或错配数据，请核实后再处置。';
  }
  if (!cap.enabled) {
    return `能力核对：${profile.displayName} 的${cap.name}当前未启用，此告警需核实。`;
  }
  return '';
}

/** 相对时间文本（纯函数，避免依赖 UI DateUtil）。 */
export function formatAge(nowMs: number, tsMs: number): string {
  if (!isFinite(tsMs) || tsMs <= 0) {
    return '时间未知';
  }
  const diffSec: number = Math.max(0, Math.floor((nowMs - tsMs) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}
