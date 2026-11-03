/**
 * 设备能力集中配置（按完整 deviceId，不按房间名猜测）。
 *
 * 当前固件会为未安装的传感器输出兼容占位字段，因此**不能**只凭
 * sensors.motion / door / gas / smoke 是否存在判断能力。
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
      /* 客厅：摄像头 + PIR + 门磁 + 温湿度；无 MQ 气感/烟感 */
      c.motion = true;
      c.door = true;
      c.climate = true;
      c.camera = true;
      c.known = true;
      return c;
    }
    if (deviceId === 'esp32-kitchen') {
      /* 厨房：AHT20 + MQ2/MQ5；无 PIR/门磁/SOS/摄像头/水漏；
         MQ 阈值 4096 且报警禁用，只能显示原始 ADC 并标注未启用。 */
      c.climate = true;
      c.gas = true;
      c.smoke = true;
      c.mqAlarmEnabled = false;
      c.known = true;
      return c;
    }
    if (deviceId === 'esp32-bath') {
      /* 卫生间：AHT20 + PIR + SOS；无 MQ/门磁/摄像头，水漏禁用 */
      c.climate = true;
      c.motion = true;
      c.sos = true;
      c.water = false;
      c.known = true;
      return c;
    }
    return c;   // 未知设备：全部 false + known=false
  }

  static isKnown(deviceId: string): boolean {
    return DeviceCapabilities.forDevice(deviceId).known;
  }
}
