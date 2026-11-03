/**
 * 家庭设备清单（真实硬件台账）—— 纯逻辑，可被 Node 测试。
 *
 * 目的：APP 只把"已核实的家庭监护设备"当作受监护设备展示与统计；
 * 后端仍可能长期保留测试/历史/第三方上报记录（例如 "隔离测试节点"），
 * 这些记录不得冒充家庭房间、不得计入在线数、不得参与告警判读，只能在
 * 设备管理页的"未纳入监护的后端记录"里如实列出，并明确说明原因。
 *
 * 事实来源（不是 APP 猜测）：
 * - `competition/docs/evidence/2026-10-26-new-chat-handoff.md` §3：厨房/卫生间/DAYU 身份、端口、引脚；
 * - `competition/evidence/2026-10-26-wireless-sos-button-final/REPORT.md`：esp32-sos 随身求助板（COM8）；
 * - `competition/esp32-node` 固件配置与 `competition/evidence/2026-10-27-real-capability-app/hardware/` 本轮硬件核验。
 *
 * 电量（BATTERY-CHAIN-CONTRACT §6）：台账只声明每台设备的电量来源能力，不存放任何数值。
 * - 厨房 / 卫生间 / DAYU200：固定供电，无电池采样 → fixed；
 * - esp32-sos（及第二优先 esp32-node-wearable）：电池化候选，但当前无采样硬件/未上报 → battery-capable，
 *   未上报时 UI 显示“电量未知”，严禁写死百分比。
 */

export class DeviceClass {
  /** 已核实、纳入家庭监护的设备。 */
  static readonly HOUSEHOLD: string = 'household';
  /** 后端有记录，但不在家庭设备清单内（测试/历史/第三方），不纳入监护。 */
  static readonly UNRECOGNIZED: string = 'unrecognized';
}

/**
 * 电量来源能力（BATTERY-CHAIN-CONTRACT §6）。
 *
 * 台账只声明“硬件有没有电池采样能力”，不存放任何电量数值：
 * - fixed：固定供电（USB/适配器），硬件无电池电压采样，UI 显示“固定供电，无电池电量数据”；
 * - battery-capable：可电池化/电池供电的板卡，但当前未接入采样或未上报，UI 必须显示“电量未知”；
 * - unknown：未登记设备，没有可核实来源，UI 同样显示“电量未知”。
 */
export class BatterySource {
  static readonly FIXED: string = 'fixed';
  static readonly BATTERY_CAPABLE: string = 'battery-capable';
  static readonly UNKNOWN: string = 'unknown';
}

export class BatteryCapability {
  /** BatterySource 之一。 */
  source: string = BatterySource.UNKNOWN;
  /** 硬件事实说明（为什么固定供电 / 为什么未接入电量检测），不含估算。 */
  note: string = '';
  /** 补齐电量检测所需的硬件/校准条件；固定供电设备为空。 */
  requiredHardware: string = '';
}

export class InventoryEntry {
  deviceId: string = '';
  /** 已核实显示名（不依赖后端 room 猜测）。 */
  displayName: string = '';
  /** 已核实所属房间/佩戴场景。 */
  roomLabel: string = '';
  /** 设备角色，例如 "房间环境节点" / "随身求助设备"。 */
  role: string = '';
  /** 真实来源（交接/验收证据），用于"有明确来源"的展示。 */
  source: string = '';
  battery: BatteryCapability = new BatteryCapability();
}

function batteryFixed(note: string): BatteryCapability {
  const cap = new BatteryCapability();
  cap.source = BatterySource.FIXED;
  cap.note = note;
  return cap;
}

function batteryCapable(note: string, requiredHardware: string): BatteryCapability {
  const cap = new BatteryCapability();
  cap.source = BatterySource.BATTERY_CAPABLE;
  cap.note = note;
  cap.requiredHardware = requiredHardware;
  return cap;
}

function batteryUnknown(note: string): BatteryCapability {
  const cap = new BatteryCapability();
  cap.source = BatterySource.UNKNOWN;
  cap.note = note;
  return cap;
}

function entry(deviceId: string, displayName: string, roomLabel: string, role: string,
  source: string, battery: BatteryCapability): InventoryEntry {
  const item = new InventoryEntry();
  item.deviceId = deviceId;
  item.displayName = displayName;
  item.roomLabel = roomLabel;
  item.role = role;
  item.source = source;
  item.battery = battery;
  return item;
}

/** 已核实家庭设备清单：3 个固定房间节点 + 1 个随身求助设备。 */
const HOUSEHOLD: InventoryEntry[] = [
  entry('esp32-kitchen', '厨房节点', '厨房', '房间环境节点（温湿度 / PIR / 门磁 / MQ-2 / MQ-5）',
    '交接文档 2026-10-26 §3 + 2026-10-27 在板固件（PIR GPIO38 / 门磁 GPIO14 / MQ GPIO6-7）',
    batteryFixed('厨房节点为 USB 固定供电，板卡无电池电压采样电路与 ADC 分压接线。')),
  entry('esp32-bath', '卫生间节点', '卫生间', '房间环境节点（温湿度 / PIR / 门磁 / SOS 按键）',
    '交接文档 2026-10-26 §3 + 2026-10-27 在板固件（PIR GPIO36 / 门磁 GPIO14）',
    batteryFixed('卫生间节点为 USB 固定供电，板卡无电池电压采样电路与 ADC 分压接线。')),
  entry('dayu200-living', '客厅主控（DAYU200）', '客厅', '边缘主控（本地相机取帧 / 跌倒判定 / 语音）',
    '交接文档 2026-10-26 §3.2 / §4 + DAYU 正式应用验收',
    batteryFixed('DAYU200 由电源适配器固定供电，系统无 power_supply 设备；系统 BatteryService 的容量是模拟值，不是真实电量，APP 不使用。')),
  entry('esp32-sos', '随身求助节点', '随身求助', '随身 SOS 按键（一键求助 / 蜂鸣提示）',
    '2026-10-26 随身求助按钮联网闭环验收（COM8）+ 交接文档 §2 + 2026-10-27 电量硬件核验',
    batteryCapable('未接入电量检测（无采样模块）：随身求助板当前由 USB 供电，板卡无电池座/充电/ADC 分压，固件未上报 battery。',
      '补齐条件：1S 锂电 + TP4056 充电保护 + 100k/100k 分压到 ADC1（避开按钮 GPIO4 / 蜂鸣 GPIO5），固件每 30s 采样并至少 2 点校准后上报 battery。'))
];

/**
 * 非家庭清单、但契约要求登记电量能力的板卡（不参与房间/在线统计）。
 * esp32-node-wearable 是电池化第二优先板，当前同样未接入采样。
 */
const DECLARED_BATTERY: Map<string, BatteryCapability> = new Map<string, BatteryCapability>();
DECLARED_BATTERY.set('esp32-node-wearable',
  batteryCapable('未接入电量检测（无采样模块）：ESP32-S3 由 USB/充电宝供电，M100 独立供电，固件无 ADC 采样，未上报 battery。',
    '补齐条件：1S 锂电 + 充电保护 + 分压到空闲 ADC1 并至少 2 点校准；上报前 APP 不显示百分比。'));

const byId: Map<string, InventoryEntry> = new Map<string, InventoryEntry>();
for (let i = 0; i < HOUSEHOLD.length; i++) {
  byId.set(HOUSEHOLD[i].deviceId, HOUSEHOLD[i]);
}

/** 家庭设备清单（只读副本，页面不要原地修改）。 */
export function householdInventory(): InventoryEntry[] {
  return HOUSEHOLD.slice();
}

/** 设备是否已核实并纳入家庭监护。 */
export function isHouseholdDevice(deviceId: string): boolean {
  return byId.has(deviceId);
}

/** 查已核实台账；未登记返回 null。 */
export function inventoryEntryFor(deviceId: string): InventoryEntry | null {
  const item: InventoryEntry | undefined = byId.get(deviceId);
  return item !== undefined ? item : null;
}

/** 已核实显示名；未登记设备只能用后端给的名字（页面需标“未识别”）。 */
export function verifiedNameFor(deviceId: string): string {
  const item: InventoryEntry | undefined = byId.get(deviceId);
  return item !== undefined ? item.displayName : '';
}

/** 设备来源说明；未登记设备返回空串。 */
export function inventorySourceFor(deviceId: string): string {
  const item: InventoryEntry | undefined = byId.get(deviceId);
  return item !== undefined ? item.source : '';
}

/** 电量能力；未登记设备没有可核实来源，按 unknown（UI 显示电量未知，不给百分比）。 */
export function batteryCapabilityFor(deviceId: string): BatteryCapability {
  const item: InventoryEntry | undefined = byId.get(deviceId);
  if (item !== undefined) {
    return item.battery;
  }
  const declared: BatteryCapability | undefined = DECLARED_BATTERY.get(deviceId);
  if (declared !== undefined) {
    return declared;
  }
  return batteryUnknown('未登记设备没有可核实的电量采样来源，APP 不显示电量数值。');
}

/** 未纳入监护的原因（用于设备管理页如实说明，不删除后端记录）。 */
export function unrecognizedReasonFor(deviceId: string, roomName: string): string {
  const room: string = roomName.length > 0 ? roomName : '未分配房间';
  return `后端仍有该设备（${deviceId}，${room}）的上报记录，但它不在家庭设备清单（厨房 / 卫生间 / 客厅 / 随身求助）中，` +
    '可能是隔离测试、历史遗留、重复登记或非房间设备；未计入在线统计，也不作为告警判读依据，记录不删除。';
}

/** 家庭设备清单口径说明（设备管理页/交付报告共用）。 */
export function inventoryScopeText(): string {
  const names: string[] = [];
  for (let i = 0; i < HOUSEHOLD.length; i++) {
    names.push(HOUSEHOLD[i].displayName);
  }
  return `家庭设备清单（已核实来源）：${names.join('、')}。列表以外的后端记录单独列出、不计入监护统计。`;
}
