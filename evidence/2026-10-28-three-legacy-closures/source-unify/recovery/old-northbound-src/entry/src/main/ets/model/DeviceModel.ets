/**
 * 北向数据层：与南向 homemon / 云端协议对齐
 * 协议定义见 competition/README.md §3.1 / §3.2
 *
 * 数据来源（P4 已完成）：
 *   优先 **真实设备** —— APP 与 homemon 同板运行，经 DeviceLink 连 127.0.0.1:9000
 *   读取真实状态；连不上时回退到 seed() 的演示数据，保证界面始终可用。
 *
 * 注意：ArkTS 规定静态方法内不能使用 `this`（arkts-no-standalone-this），
 *       因此本文件统一以类名 DeviceStore 引用静态成员。
 */
import { DeviceLink } from './DeviceLink';

export interface MotionStatus {
  lastActiveTs: number;
  countToday: number;
}

export interface DoorStatus {
  open: boolean;
  lastOpenTs: number;
}

export interface ClimateStatus {
  tempC: number;
  rh: number;
  ok: boolean;
}

export interface AlarmItem {
  id: string;
  type: string;
  level: string;      // WARN | ALARM
  startTs: number;
  detail: string;
  acked: boolean;
  action: string;     // 处置结果（事件闭环）
  ackTs: number;
}

/* ---- homemon 上报报文（competition/README.md §3.1）的结构定义 ---- */
interface RawOk {
  raw: number;
  ok: boolean;
}

interface RawSensors {
  motion: MotionStatus;
  door: DoorStatus;
  climate: ClimateStatus;
  gas: RawOk;
  smoke: RawOk;
}

interface RawAlarm {
  id: string;
  type: string;
  countToday: number;
}

interface StatusMsg {
  deviceId: string;
  ts: number;
  state: string;
  sensors: RawSensors;
  history: number[];
  slots: number[];
  alarm: RawAlarm;
}

export class DeviceStore {
  static deviceId: string = 'dayu200-01';
  static online: boolean = true;
  static state: string = 'NORMAL';            // NORMAL | WARN | ALARM | ACKED
  static motion: MotionStatus = { lastActiveTs: 0, countToday: 0 };
  static door: DoorStatus = { open: false, lastOpenTs: 0 };
  static climate: ClimateStatus = { tempC: 24.6, rh: 41.2, ok: true };
  static alarms: AlarmItem[] = [];
  static weekly: number[] = [142, 156, 131, 160, 148, 155, 168];   // 近 7 日活动频次
  static yesterdayCount: number = 160;
  static alarmTotal: number = 0;
  static dataSource: string = '演示数据';      // '真实设备' | '演示数据'
  static lastTs: number = 0;                   // 设备最近一次上报时间
  static gasOk: boolean = true;
  static smokeOk: boolean = true;
  static history: number[] = [0, 0, 0, 0, 0, 0, 0];   // 近 7 日每日活动次数（末位=今天）
  static slots: number[] = [0, 0, 0, 0];               // 今日四个时段的活动次数

  /**
   * 解析 homemon 上报的一行 JSON 并刷新界面数据（真实数据入口）
   * 报文示例：
   * {"deviceId":"dayu200-01","ts":...,"state":"NORMAL",
   *  "sensors":{"motion":{...},"door":{...},"climate":{...},"gas":{...},"smoke":{...}},
   *  "alarm":{"id":"","type":"","countToday":0}}
   */
  static applyStatus(line: string): void {
    let o: StatusMsg;
    try {
      o = JSON.parse(line) as StatusMsg;
    } catch (e) {
      console.error('[DeviceStore] 状态报文解析失败');
      return;
    }
    DeviceStore.deviceId = o.deviceId;
    DeviceStore.state = o.state;
    DeviceStore.lastTs = o.ts;
    DeviceStore.motion = {
      lastActiveTs: o.sensors.motion.lastActiveTs,
      countToday: o.sensors.motion.countToday
    };
    DeviceStore.door = {
      open: o.sensors.door.open,
      lastOpenTs: o.sensors.door.lastOpenTs
    };
    DeviceStore.climate = {
      tempC: o.sensors.climate.tempC,
      rh: o.sensors.climate.rh,
      ok: o.sensors.climate.ok
    };
    DeviceStore.gasOk = o.sensors.gas.ok;
    DeviceStore.smokeOk = o.sensors.smoke.ok;
    DeviceStore.alarmTotal = o.alarm.countToday;
    if (o.history !== undefined) {
      DeviceStore.history = o.history;
    }
    if (o.slots !== undefined) {
      DeviceStore.slots = o.slots;
    }
    if (o.alarm.id.length > 0) {
      DeviceStore.upsertAlarm(o.alarm.id, o.alarm.type);
    }
    DeviceStore.online = true;
    DeviceStore.dataSource = '真实设备';
  }

  /** 把设备来的告警并入列表（同 id 只记一次） */
  static upsertAlarm(id: string, type: string): void {
    for (let i = 0; i < DeviceStore.alarms.length; i++) {
      if (DeviceStore.alarms[i].id === id) {
        return;
      }
    }
    const detail: string = DeviceStore.alarmDetailText(type);
    const item: AlarmItem = {
      id: id, type: type, level: 'ALARM', startTs: Date.now(),
      detail: detail, acked: false, action: '', ackTs: 0
    };
    const next: AlarmItem[] = [item];
    for (let i = 0; i < DeviceStore.alarms.length; i++) {
      next.push(DeviceStore.alarms[i]);
    }
    DeviceStore.alarms = next;
  }

  static alarmDetailText(type: string): string {
    if (type === 'NO_MOTION') return '长时间未检测到人体活动，疑似跌倒或昏迷';
    if (type === 'MANUAL_SOS') return '老人按下随身求助按钮，主动求助';
    if (type === 'CLIMATE') return '室内温湿度超出舒适区间';
    if (type === 'GAS') return '检测到燃气泄漏，请立即开窗通风并撤离';
    if (type === 'SMOKE') return '检测到烟雾，疑似火情';
    if (type === 'FALL') return '视觉检测到疑似跌倒，请尽快查看现场';
    return '设备上报异常';
  }

  /** 离线兜底数据：仅在连不上设备时用于让界面可用（不注入任何"假告警"） */
  static seed(): void {
    const now: number = Date.now();
    DeviceStore.motion = { lastActiveTs: now - 3 * 60 * 1000, countToday: 0 };
    DeviceStore.door = { open: false, lastOpenTs: 0 };
    DeviceStore.climate = { tempC: 0, rh: 0, ok: true };
    DeviceStore.state = 'NORMAL';
    DeviceStore.alarms = [];
    DeviceStore.alarmTotal = 0;
  }

  /**
   * P4 替换点：从云端/本地桥接拉取最新状态。
   *   方案 A：HTTP GET /status（解析 §3.1 JSON）
   *   方案 B：MQTT 订阅 home/{deviceId}/status
   */
  static refresh(): boolean {
    if (DeviceStore.dataSource === '真实设备') {
      // 真实数据由页面内的 socket 推送并在 applyStatus() 中更新在线标志，这里无需额外处理
      return true;
    }
    const now: number = Date.now();
    const next: MotionStatus = {
      lastActiveTs: now - (DeviceStore.motion.countToday % 20) * 60 * 1000,
      countToday: DeviceStore.motion.countToday + 1
    };
    DeviceStore.motion = next;
    return true;
  }

  /** 事件闭环：确认预警 + 填写处置结果（对应赛题"居家安全日志"） */
  static ack(id: string, action: string): void {
    const kept: AlarmItem[] = [];
    for (let i = 0; i < DeviceStore.alarms.length; i++) {
      const a: AlarmItem = DeviceStore.alarms[i];
      if (a.id === id) {
        const done: AlarmItem = {
          id: a.id, type: a.type, level: a.level, startTs: a.startTs,
          detail: a.detail, acked: true, action: action, ackTs: Date.now()
        };
        kept.push(done);
      } else {
        kept.push(a);
      }
    }
    DeviceStore.alarms = kept;
    DeviceStore.state = 'ACKED';
    // 下发到设备：写进开发板的居家安全日志（事件闭环）
    DeviceLink.send(`ack ${id} ${action}\n`);
  }

  static stateText(): string {
    if (DeviceStore.state === 'ALARM') return '异常告警';
    if (DeviceStore.state === 'WARN') return '需要关注';
    if (DeviceStore.state === 'ACKED') return '已确认处理';
    return '一切正常';
  }

  static stateColor(): string {
    if (DeviceStore.state === 'ALARM') return '#E64545';
    if (DeviceStore.state === 'WARN') return '#E6A23C';
    if (DeviceStore.state === 'ACKED') return '#3F7DE6';
    return '#37B24D';
  }

  /** 赛题要求的"活动规律报告"文案：今日 vs 昨日 */
  static trendText(): string {
    const today: number = DeviceStore.motion.countToday;
    const base: number = DeviceStore.yesterdayCount;
    if (base <= 0) return '暂无昨日数据';
    const diff: number = base - today;
    const pct: number = Math.round(Math.abs(diff) * 100 / base);
    if (pct < 5) return `今日活动频次 ${today} 次，与昨日基本持平`;
    if (diff > 0) return `今日活动频次较昨日下降 ${pct}%（${today} 次 / 昨日 ${base} 次）`;
    return `今日活动频次较昨日上升 ${pct}%（${today} 次 / 昨日 ${base} 次）`;
  }

  static alarmTypeText(type: string): string {
    if (type === 'NO_MOTION') return '长时间无活动';
    if (type === 'MANUAL_SOS') return '主动求助';
    if (type === 'CLIMATE') return '温湿度异常';
    if (type === 'GAS') return '燃气泄漏';
    if (type === 'SMOKE') return '烟雾告警';
    if (type === 'FALL') return '疑似跌倒';
    return type;
  }

  static hhmm(ts: number): string {
    if (ts <= 0) return '--:--';
    const d: Date = new Date(ts);
    const h: number = d.getHours();
    const m: number = d.getMinutes();
    const hs: string = h < 10 ? `0${h}` : `${h}`;
    const ms: string = m < 10 ? `0${m}` : `${m}`;
    return `${hs}:${ms}`;
  }

  static agoText(ts: number): string {
    if (ts <= 0) return '暂无';
    const min: number = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h: number = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.floor(h / 24)} 天前`;
  }
}
