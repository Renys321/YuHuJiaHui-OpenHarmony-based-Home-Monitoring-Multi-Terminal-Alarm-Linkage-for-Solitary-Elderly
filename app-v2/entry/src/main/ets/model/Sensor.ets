/**
 * 传感器 / 设备模型
 */
export type SensorType =
  | 'motion'
  | 'door'
  | 'temperature'
  | 'humidity'
  | 'sos'
  | 'smoke'
  | 'gas';

export type SensorStatus = 'normal' | 'warning' | 'critical' | 'offline';

@Observed
export class Sensor {
  id: string = '';
  type: SensorType = 'motion';
  name: string = '';
  location: string = '';
  status: SensorStatus = 'normal';
  online: boolean = true;
  battery: number = 100;
  signalStrength: number = 4;
  lastTriggeredAt: number = 0;
  lastValue: string = '';
  updateTime: number = 0;
}

export class SensorMeta {
  static label(type: SensorType): string {
    if (type === 'motion')
      return '人体红外';
    if (type === 'door')
      return '门窗磁';
    if (type === 'temperature')
      return '温度';
    if (type === 'humidity')
      return '湿度';
    if (type === 'sos')
      return '紧急求助';
    if (type === 'smoke')
      return '烟雾';
    if (type === 'gas')
      return '燃气';
    return type;
  }

  static icon(type: SensorType): Resource {
    if (type === 'motion')
      return $r('sys.symbol.person_fill');
    if (type === 'door')
      return $r('sys.symbol.square_grid_2x2');
    if (type === 'temperature')
      return $r('sys.symbol.thermometer_medium');
    if (type === 'humidity')
      return $r('sys.symbol.drop_fill');
    if (type === 'sos')
      return $r('sys.symbol.exclamationmark_circle_fill');
    if (type === 'smoke')
      return $r('sys.symbol.cloud_fill');
    if (type === 'gas')
      return $r('sys.symbol.flame_fill');
    return $r('sys.symbol.circle');
  }
}
