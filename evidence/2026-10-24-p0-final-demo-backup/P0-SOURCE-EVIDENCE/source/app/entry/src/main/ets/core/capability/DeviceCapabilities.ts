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
  p.note = '已核实：AHT20 温湿度、MQ-2/MQ-5 原始 ADC（GAS/SMOKE 阈值 4096 永不告警，未标定）、板载蜂鸣器、CLIMATE 告警启用；无 PIR/门磁/水漏/摄像头。';
  p.entries = [
    entry('climate', '温湿度', true, true, true, 'AHT20 读数；云端未透传 valid，有效性按读数推断；CLIMATE 告警启用（5–45℃/10–90%RH）'),
    entry('gas', '燃气（MQ-5）', true, true, false, 'MQ-5 原始 ADC；GAS 报警未启用，未标定，不代表 ppm'),
    entry('smoke', '烟雾（MQ-2）', true, true, false, 'MQ-2 原始 ADC；SMOKE 报警未启用，未标定，不代表 ppm'),
    entry('motion', '人体红外', false, false, false, '未安装（CONFIG_NODE_MOTION_GPIO=-1）'),
    entry('door', '门磁', false, false, false, '未安装（CONFIG_NODE_DOOR_GPIO=-1）'),
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
  p.note = '已核实：AHT20 温湿度、PIR 活动、SOS 按键、板载蜂鸣器；1800s 无活动触发 NO_MOTION；水漏本轮禁用；无燃气/烟雾/门磁/摄像头。';
  p.entries = [
    entry('climate', '温湿度', true, true, true, 'AHT20 读数；云端未透传 valid，有效性按读数推断；CLIMATE 告警启用'),
    entry('motion', '人体活动（PIR）', true, true, true, 'PIR 上报活动时间/次数；长时间无活动会触发 NO_MOTION 告警'),
    entry('sos', '紧急求助按键', true, true, true, 'SOS 事件会形成 MANUAL_SOS 告警'),
    entry('water', '水漏', false, false, false, '本轮未启用（CONFIG_NODE_WATER_GPIO=-1）'),
    entry('gas', '燃气', false, false, false, '未安装（MQ 禁用）'),
    entry('smoke', '烟雾', false, false, false, '未安装（MQ 禁用）'),
    entry('door', '门磁', false, false, false, '未安装（门磁禁用）'),
    entry('camera', '摄像头', false, false, false, '未安装')
  ];
  return p;
}

function makeDayu(): CapabilityProfile {
  const p = new CapabilityProfile();
  p.deviceId = 'dayu200-living';
  p.displayName = '客厅主控';
  p.verified = true;
  p.note = '已核实：客厅主控/相机本地取帧/跌倒判定（PC CPU YOLO，非板端 NPU）/语音（本地）；APP 无实时视频接口，只能查看在线、监测状态与 FALL 告警证据可用性；物理传感器未接线但公网仍可能出现占位字段，APP 按“待确认”展示。';
  p.entries = [
    entry('camera', '摄像头（本地取帧）', true, true, false, '仅本地取帧/证据；APP 无实时视频接口，不显示实时画面'),
    entry('fall', '跌倒判定（PC YOLO）', true, true, true, '由 PC CPU YOLO 判定，非板端 NPU；FALL 告警与证据元数据可上报'),
    entry('climate', '温湿度', false, false, false, '待确认（本机未核实安装）'),
    entry('motion', '人体活动', false, false, false, '待确认（以 NO_MOTION 告警为准）'),
    entry('door', '门磁', false, false, false, '待确认'),
    entry('gas', '燃气', false, false, false, '待确认'),
    entry('smoke', '烟雾', false, false, false, '待确认'),
    entry('water', '水漏', false, false, false, '待确认'),
    entry('sos', '紧急求助按键', false, false, false, '待确认')
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
  const suffix: string = missing.length > 0 ? `未安装/未启用/待确认：${missing.join('、')}` : '全部已核实能力已启用';
  return `${profile.note} ${suffix}`;
}

/** 原始 ADC 值只能显示为原始值，禁止冒充 ppm。 */
export function formatRawAdc(raw: number | null): string {
  if (raw === null || !isFinite(raw)) {
    return '未收到原始值';
  }
  return `原始 ADC ${Math.round(raw)}`;
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
