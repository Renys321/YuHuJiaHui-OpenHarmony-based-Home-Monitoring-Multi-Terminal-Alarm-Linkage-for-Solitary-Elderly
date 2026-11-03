/**
 * 设备能力集中配置（按完整 deviceId，不按房间名猜测）。
 *
 * 2026-10-27 更新（在板固件核验）：
 * - 厨房 PIR（SR312/GPIO38）与厨房/卫生间门磁（GPIO14）已装并真实上报；
 * - 客厅 DAYU200 只有摄像头（本地取帧）+ 跌倒判定，PIR/温湿度/门磁物理未接线，
 *   固件兼容占位字段不得当成已安装；
 * - MQ-2/MQ-5 仍未标定、报警阈值未启用，只能显示原始 ADC。
 * 未知设备一律保守：不显示传感器卡片，页面显示“能力待确认”。
 */
export class DeviceCapability {
  motion: boolean = false;
  door: boolean = false;
  climate: boolean = false;
  gas: boolean = false;
  smoke: boolean = false;
  sos: boolean = false;
  water: boolean = false;
  camera: boolean = false;
  /** 仅表示有 MQ 通道；阈值/报警是否启用单独判断 */
  mqAlarmEnabled: boolean = false;
  known: boolean = false;
}

export class DeviceCapabilities {
  static forDevice(deviceId: string): DeviceCapability {
    const c: DeviceCapability = new DeviceCapability();
    if (deviceId === 'dayu200-living' || deviceId === 'dayu200-01') {
      /* 客厅：摄像头（本机取帧）+ 跌倒判定；PIR/温湿度/门磁物理未接线（2026-10-27 核验），
         固件占位字段不得显示为已安装。 */
      c.camera = true;
      c.known = true;
      return c;
    }
    if (deviceId === 'esp32-kitchen') {
      /* 厨房：AHT20 + MQ2/MQ5 + PIR（GPIO38，2026-10-27 起）+ 门磁（GPIO14）；
         2026-10-28 起气体阈值启用：GAS=900 / SMOKE=700（连续 3 帧、回差 20），未标定。 */
      c.climate = true;
      c.gas = true;
      c.smoke = true;
      c.motion = true;
      c.door = true;
      c.mqAlarmEnabled = true;
      c.known = true;
      return c;
    }
    if (deviceId === 'esp32-bath') {
      /* 卫生间：AHT20 + PIR（GPIO36）+ SOS + 门磁（GPIO14，2026-10-27 起）；
         无 MQ/摄像头，水漏禁用。 */
      c.climate = true;
      c.motion = true;
      c.sos = true;
      c.door = true;
      c.water = false;
      c.known = true;
      return c;
    }
    if (deviceId === 'esp32-sos') {
      /* 随身求助：只有 SOS 按键与蜂鸣提示；无环境传感器/摄像头/电量遥测。 */
      c.sos = true;
      c.known = true;
      return c;
    }
    return c;   // 未知设备：全部 false + known=false
  }

  static isKnown(deviceId: string): boolean {
    return DeviceCapabilities.forDevice(deviceId).known;
  }
}
