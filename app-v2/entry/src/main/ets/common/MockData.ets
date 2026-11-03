// Mock 数据
import { Elder, EmergencyContact } from '../model/Elder';
import { Sensor, SensorType, SensorStatus } from '../model/Sensor';
import { AlertEvent, TimelineItem } from '../model/AlertEvent';
import { RealData } from './RealData';

const now = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function makeSensor(
  id: string, type: SensorType, name: string, location: string,
  status: SensorStatus, online: boolean, battery: number, signal: number,
  lastTriggeredAt: number, lastValue: string, updateTime: number
): Sensor {
  const s = new Sensor();
  s.id = id; s.type = type; s.name = name; s.location = location;
  s.status = status; s.online = online; s.battery = battery;
  s.signalStrength = signal; s.lastTriggeredAt = lastTriggeredAt;
  s.lastValue = lastValue; s.updateTime = updateTime;
  return s;
}

function makeTimeline(time: number, actor: string, action: string, note: string): TimelineItem {
  const t = new TimelineItem();
  t.time = time; t.actor = actor; t.action = action; t.note = note;
  return t;
}

export class MockData {
  static elder(): Elder {
    const realElder: Elder | null = RealData.elder();
    if (realElder !== null) return realElder;
    const e = new Elder();
    e.id = 'E001';
    e.name = '张桂芳';
    e.age = 78;
    e.gender = 'female';
    e.address = '郑州市金水区文化路 68 号院 3 号楼 502';
    e.phone = '138****6621';
    e.medicalHistory = '高血压（10 年）· 糖尿病（5 年）';
    e.communityGrid = '文化路社区 · 第三网格';
    e.communityPhone = '0371-6388****';

    const c1 = new EmergencyContact();
    c1.id = 'C1';
    c1.name = '李强';
    c1.relation = '儿子';
    c1.phone = '139****8823';
    c1.priority = 1;
    c1.notifyEnabled = true;

    const c2 = new EmergencyContact();
    c2.id = 'C2';
    c2.name = '李红';
    c2.relation = '女儿';
    c2.phone = '137****2210';
    c2.priority = 2;
    c2.notifyEnabled = true;

    const c3 = new EmergencyContact();
    c3.id = 'C3';
    c3.name = '王邻居';
    c3.relation = '邻居';
    c3.phone = '135****6672';
    c3.priority = 3;
    c3.notifyEnabled = false;

    e.emergencyContacts = [c1, c2, c3];
    return e;
  }

  static sensors(): Sensor[] {
    const realSensors: Sensor[] | null = RealData.sensors();
    if (realSensors !== null) return realSensors;
    return [
      makeSensor('S01', 'motion', '客厅人体红外', '客厅',
        'normal', true, 82, 4, now - 6 * MIN, '有人活动', now - 6 * MIN),
      makeSensor('S02', 'motion', '卧室人体红外', '主卧',
        'normal', true, 64, 3, now - 42 * MIN, '无活动', now - 42 * MIN),
      makeSensor('S03', 'door', '入户门磁', '玄关',
        'normal', true, 91, 4, now - 2 * HOUR, '关闭', now - 2 * HOUR),
      makeSensor('S04', 'door', '阳台门磁', '阳台',
        'warning', true, 18, 2, now - 15 * MIN, '开启 15 分钟', now - 15 * MIN),
      makeSensor('S05', 'temperature', '客厅温湿度', '客厅',
        'normal', true, 76, 4, now - 1 * MIN, '24.6°C', now - 1 * MIN),
      makeSensor('S06', 'humidity', '卧室湿度', '主卧',
        'normal', true, 76, 4, now - 1 * MIN, '52 %', now - 1 * MIN),
      makeSensor('S07', 'sos', '随身求助按钮', '随身',
        'normal', true, 55, 4, 0, '待命', now - 30 * 1000),
      makeSensor('S08', 'smoke', '厨房烟雾', '厨房',
        'offline', false, 0, 0, now - 26 * HOUR, '离线', now - 26 * HOUR),
      makeSensor('S09', 'gas', '厨房燃气', '厨房',
        'normal', true, 88, 3, 0, '0 ppm', now - 3 * MIN)
    ];
  }

  static alerts(): AlertEvent[] {
    const realAlerts: AlertEvent[] | null = RealData.alerts();
    if (realAlerts !== null) return realAlerts;
    // A1 紧急求助
    const a1 = new AlertEvent();
    a1.id = 'A20261012001';
    a1.level = 'critical';
    a1.status = 'pending';
    a1.sensorType = 'sos';
    a1.sensorName = '随身求助按钮';
    a1.location = '主卧';
    a1.title = '老人触发紧急求助';
    a1.description = '求助按钮被长按 3 秒，触发一级响应。当前定位主卧。请立即联系老人或就近亲属。';
    a1.createdAt = now - 4 * MIN;
    a1.pushedTo = ['本人手机', '儿子（李强）', '社区网格员'];
    a1.timeline = [
      makeTimeline(now - 4 * MIN, '系统', '触发紧急求助', '随身按钮长按 3s'),
      makeTimeline(now - 4 * MIN + 2000, '系统', '推送至 3 个终端', '本人 · 儿子 · 社区'),
      makeTimeline(now - 3 * MIN, '本地声光报警器', '已启动', '持续 60 秒'),
      makeTimeline(now - 30 * 1000, '系统', '等待处置', '')
    ];

    // A2 长时间无活动
    const a2 = new AlertEvent();
    a2.id = 'A20261012002';
    a2.level = 'high';
    a2.status = 'pending';
    a2.sensorType = 'motion';
    a2.sensorName = '客厅人体红外';
    a2.location = '客厅';
    a2.title = '长时间无活动（> 4 小时）';
    a2.description = '客厅与卧室人体红外均未检测到活动，超过预设阈值 4 小时。';
    a2.createdAt = now - 25 * MIN;
    a2.pushedTo = ['本人手机'];
    a2.timeline = [
      makeTimeline(now - 4 * HOUR, '系统', '开始计时', '最后一次活动 06:12'),
      makeTimeline(now - 25 * MIN, '系统', '触发无活动预警', '超过 4h 阈值')
    ];

    // A3 阳台门开启超时
    const a3 = new AlertEvent();
    a3.id = 'A20261012003';
    a3.level = 'medium';
    a3.status = 'pending';
    a3.sensorType = 'door';
    a3.sensorName = '阳台门磁';
    a3.location = '阳台';
    a3.title = '阳台门开启超时';
    a3.description = '阳台门已开启超过 15 分钟且无人体活动信号，请关注。';
    a3.createdAt = now - 8 * MIN;
    a3.pushedTo = ['本人手机'];
    a3.timeline = [
      makeTimeline(now - 15 * MIN, '阳台门磁', '开启', ''),
      makeTimeline(now - 8 * MIN, '系统', '触发超时预警', '开启 > 15min')
    ];

    // A4 已归档 · 温度异常
    const a4 = new AlertEvent();
    a4.id = 'A20261011012';
    a4.level = 'high';
    a4.status = 'closed';
    a4.sensorType = 'temperature';
    a4.sensorName = '客厅温湿度';
    a4.location = '客厅';
    a4.title = '室内温度异常偏低';
    a4.description = '客厅温度降至 12.4°C，低于安全阈值 16°C。';
    a4.createdAt = now - 20 * HOUR;
    a4.acknowledgedAt = now - 19.5 * HOUR;
    a4.closedAt = now - 19 * HOUR;
    a4.handlerName = '李强';
    a4.disposition = 'called_elder';
    a4.dispositionNote = '电话联系老人，反馈暖气故障，已联系物业维修。';
    a4.pushedTo = ['本人手机', '儿子（李强）'];
    a4.timeline = [
      makeTimeline(now - 20 * HOUR, '系统', '触发低温预警', '12.4°C'),
      makeTimeline(now - 19.5 * HOUR, '李强', '确认预警', ''),
      makeTimeline(now - 19 * HOUR, '李强', '归档', '已联系物业')
    ];

    // A5 误报 · 烟雾
    const a5 = new AlertEvent();
    a5.id = 'A20261010007';
    a5.level = 'medium';
    a5.status = 'false_alarm';
    a5.sensorType = 'smoke';
    a5.sensorName = '厨房烟雾';
    a5.location = '厨房';
    a5.title = '厨房烟雾浓度上升';
    a5.description = '烟雾传感器读数瞬时上升。';
    a5.createdAt = now - 2 * DAY;
    a5.acknowledgedAt = now - 2 * DAY + 5 * MIN;
    a5.closedAt = now - 2 * DAY + 8 * MIN;
    a5.handlerName = '李红';
    a5.disposition = 'false_alarm';
    a5.dispositionNote = '老人炒菜油烟所致，已开窗通风。建议加装抽油烟机联动。';
    a5.pushedTo = ['本人手机', '女儿（李红）'];
    a5.timeline = [
      makeTimeline(now - 2 * DAY, '系统', '触发烟雾预警', ''),
      makeTimeline(now - 2 * DAY + 8 * MIN, '李红', '标记误报', '')
    ];

    return [a1, a2, a3, a4, a5];
  }

  static hourlyActivity(): number[] {
    if (RealData.realMode()) {
      const bins: number[] = [];
      for (let i = 0; i < 24; i++) bins.push(0);
      const list = MockData.alerts();
      for (let i = 0; i < list.length; i++) {
        const d = new Date(list[i].createdAt);
        const h = d.getHours();
        bins[h] = bins[h] + 1;
      }
      return bins;
    }
    return [
      0, 0, 0, 0, 0, 2, 8, 15, 22, 18, 12, 10,
      14, 8, 6, 10, 16, 20, 18, 12, 8, 4, 2, 0
    ];
  }

  static weeklyAlerts(): WeekBarItem[] {
    if (RealData.realMode()) {
      const out: WeekBarItem[] = [];
      const base = Date.now();
      for (let i = 6; i >= 0; i--) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        const label = `${d.getMonth() + 1}/${d.getDate()}`;
        let count = 0;
        const list = MockData.alerts();
        for (let j = 0; j < list.length; j++) {
          const ad = new Date(list[j].createdAt);
          if (`${ad.getMonth() + 1}/${ad.getDate()}` === label) count++;
        }
        out.push({ day: label, count: count });
      }
      return out;
    }
    return [
      { day: '周一', count: 1 },
      { day: '周二', count: 0 },
      { day: '周三', count: 2 },
      { day: '周四', count: 1 },
      { day: '周五', count: 0 },
      { day: '周六', count: 3 },
      { day: '周日', count: 1 }
    ];
  }
}

export interface WeekBarItem {
  day: string;
  count: number;
}
