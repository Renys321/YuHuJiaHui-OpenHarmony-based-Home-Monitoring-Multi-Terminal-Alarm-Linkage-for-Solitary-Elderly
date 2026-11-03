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
 * 电量：本轮硬件核验未发现任何一块受监护板卡存在电池电压采样电路 / ADC 分压 /
 * 固件采样代码，因此全部设备电量状态为 `not-supported`（该设备未接入电量检测），
 * 严禁显示估算百分比。若后续补硬件，只需在此表登记采样来源与校准，不在 UI 里写死数字。
 */

export class DeviceClass {
  /** 已核实、纳入家庭监护的设备。 */
  static readonly HOUSEHOLD: string = 'household';
  /** 后端有记录，但不在家庭设备清单内（测试/历史/第三方），不纳入监护。 */
  static readonly UNRECOGNIZED: string = 'unrecognized';
}

export class BatteryState {
  /** 硬件没有电池电压采样电路/未接入 ADC：UI 必须显示"未接入电量检测"。 */
  static readonly NOT_SUPPORTED: string = 'not-supported';
  /** 有采样能力但当前不可用（未校准/无读数）。 */
  static readonly UNAVAILABLE: string = 'unavailable';
  /** 有真实采样且读数有效。 */
  static readonly OK: string = 'ok';
}

export class BatteryCapability {
  supported: boolean = false;
  state: string = BatteryState.NOT_SUPPORTED;
  /** 固定、可直接上屏的一句话结论。 */
  stateText: string = '该设备未接入电量检测';
  /** 为什么没有：硬件/固件事实，不含估算。 */
  detail: string = '未发现电池电压采样电路（分压/ADC）与固件采样代码，APP 不显示电量百分比。';
  /** 补齐所需硬件/固件条件（供交付报告使用，不在列表页展开）。 */
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

function batteryNotSupported(detail: string, requiredHardware: string): BatteryCapability {
  const cap = new BatteryCapability();
  cap.supported = false;
  cap.state = BatteryState.NOT_SUPPORTED;
  cap.stateText = '该设备未接入电量检测';
  cap.detail = detail;
  cap.requiredHardware = requiredHardware;
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
    batteryNotSupported('厨房节点为固定供电，板卡无电池电压采样电路与 ADC 分压接线。',
      '如需电量：增加 100k/100k 分压到空闲 ADC1 通道并避开 PIR(GPIO38)、门磁(GPIO14)、MQ-2(GPIO6)/MQ-5(GPIO7) 与音频 I2S 引脚，固件采样后经 status 上报。')),
  entry('esp32-bath', '卫生间节点', '卫生间', '房间环境节点（温湿度 / PIR / 门磁 / SOS 按键）',
    '交接文档 2026-10-26 §3 + 2026-10-27 在板固件（PIR GPIO36 / 门磁 GPIO14）',
    batteryNotSupported('卫生间节点为固定供电，板卡无电池电压采样电路与 ADC 分压接线。',
      '如需电量：增加电池分压到空闲 ADC 通道（避开 PIR GPIO36 / SOS GPIO15 / 门磁 GPIO14 / AHT20 I2C），固件采样并上报。')),
  entry('dayu200-living', '客厅主控（DAYU200）', '客厅', '边缘主控（本地相机取帧 / 跌倒判定 / 语音）',
    '交接文档 2026-10-26 §3.2 / §4 + DAYU 正式应用验收',
    batteryNotSupported('DAYU200 由适配器供电，无电池与电量采样电路。',
      '如需电量：需增加带 I2C 电量计的电池包或 ADC 采样，并核对与 MIPI-CSI 摄像头、HDC 供电的冲突；当前不适用。')),
  entry('esp32-sos', '随身求助节点', '随身求助', '随身 SOS 按键（一键求助 / 蜂鸣提示）',
    '2026-10-26 随身求助按钮联网闭环验收（COM8）+ 交接文档 §2',
    batteryNotSupported('随身求助板当前由 USB/外部供电，未核实电池与电量采样电路；固件无电池电压上报。',
      '如需电量：先确认独立电池与充电电路，再分压到空闲 ADC 通道并避开按钮 IO4 / 蜂鸣 IO5，固件增加 battery 字段并校准。'))
];

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

/** 电量能力；未登记设备的电量同样按“没有真实来源”处理，不给百分比。 */
export function batteryCapabilityFor(deviceId: string): BatteryCapability {
  const item: InventoryEntry | undefined = byId.get(deviceId);
  if (item !== undefined) {
    return item.battery;
  }
  const cap = new BatteryCapability();
  cap.supported = false;
  cap.state = BatteryState.NOT_SUPPORTED;
  cap.stateText = '该设备未接入电量检测';
  cap.detail = '未登记设备没有可核实的电量采样来源，APP 不显示电量百分比。';
  cap.requiredHardware = '';
  return cap;
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
