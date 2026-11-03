/**
 * 真实数据适配器：把旧版核心写入 AppStorage 的 gv.* 视图转换为新版页面的 model。
 * - 只在 gv.mode === 'real' 时返回数据；演示模式继续用 MockData 的本地样例
 * - 没有对应真实字段的（活动次数/睡眠/电量等）不做编造：返回 0 / 空 / -1，由页面如实展示
 */
import { AlertView, ContactView, DeviceView } from '../core/view/Models';
import { HealthProfileView } from '../core/health/HealthModels';
import { SensorKind } from '../core/capability/DeviceCapabilities';
import { Elder, EmergencyContact } from '../model/Elder';
import { Sensor, SensorStatus, SensorType } from '../model/Sensor';
import { AlertEvent, AlertLevel, AlertStatus } from '../model/AlertEvent';

export class RealData {
  static realMode(): boolean {
    return AppStorage.get<string>('gv.mode') === 'real';
  }

  private static kindToType(kind: SensorKind): SensorType {
    if (kind === 'door') return 'door';
    if (kind === 'climate') return 'temperature';
    if (kind === 'gas') return 'gas';
    if (kind === 'smoke') return 'smoke';
    if (kind === 'sos') return 'sos';
    return 'motion';
  }

  static elder(): Elder | null {
    const hasLocal = AppStorage.get<Elder>('gv.elderOverride') !== undefined &&
      AppStorage.get<Elder>('gv.elderOverride') !== null;
    if (!RealData.realMode() && !hasLocal) return null;
    const e = new Elder();
    e.id = 'REAL';
    e.name = '我的家';
    const profile = AppStorage.get<HealthProfileView>('gv.healthProfile');
    if (profile !== undefined && profile !== null) {
      e.age = Number.parseInt(profile.ageText.length > 0 ? profile.ageText : '0', 10) || 0;
      e.medicalHistory = profile.medicalHistory;
    }
    const gid = AppStorage.get<string>('gv.guardianId');
    if (gid !== undefined && gid.length > 0) {
      e.phone = gid.length > 7 ? `${gid.substring(0, 3)}****${gid.substring(gid.length - 4)}` : gid;
    }
    const localContacts = AppStorage.get<EmergencyContact[]>('gv.contactsOverride');
    if (localContacts !== undefined && localContacts !== null) {
      e.emergencyContacts = localContacts;
      return e;
    }
    const contacts = AppStorage.get<ContactView[]>('gv.contacts');
    if (contacts !== undefined && contacts !== null) {
      const list: EmergencyContact[] = [];
      for (let i = 0; i < contacts.length; i++) {
        const c = new EmergencyContact();
        c.id = contacts[i].id;
        c.name = contacts[i].name;
        c.relation = contacts[i].relation;
        c.phone = contacts[i].phone;
        c.priority = contacts[i].primary ? 1 : i + 1;
        c.notifyEnabled = true;
        list.push(c);
      }
      e.emergencyContacts = list;
    }
    const local = AppStorage.get<Elder>('gv.elderOverride');
    if (local !== undefined && local !== null) {
      e.name = local.name;
      e.age = local.age;
      e.gender = local.gender;
      e.address = local.address;
      e.medicalHistory = local.medicalHistory;
    }
    return e;
  }

  static sensors(): Sensor[] | null {
    if (!RealData.realMode()) return null;
    const devices = AppStorage.get<DeviceView[]>('gv.devices');
    if (devices === undefined || devices === null || devices.length === 0) return null;
    const out: Sensor[] = [];
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i];
      if (d.sensors.length > 0) {
        for (let j = 0; j < d.sensors.length; j++) {
          const s = new Sensor();
          const sv = d.sensors[j];
          s.id = sv.id;
          s.type = RealData.kindToType(sv.kind);
          s.name = sv.name.length > 0 ? sv.name : d.name;
          s.location = sv.roomName.length > 0 ? sv.roomName : d.roomName;
          s.online = d.online && sv.state !== 'offline';
          s.status = !d.online ? 'offline' : (sv.state === 'critical' ? 'critical'
            : (sv.state === 'attention' ? 'warning' : (sv.state === 'offline' ? 'offline' : 'normal')));
          s.lastValue = sv.valueText;
          s.updateTime = sv.lastUpdateTs;
          s.lastTriggeredAt = sv.lastUpdateTs;
          s.battery = 100;
          s.signalStrength = d.csq >= 0 ? Math.min(4, Math.round((d.csq / 31) * 4)) : 0;
          out.push(s);
        }
      } else {
        const s = new Sensor();
        s.id = d.deviceId.length > 0 ? d.deviceId : d.id;
        s.type = 'motion';
        s.name = d.name;
        s.location = d.roomName;
        s.online = d.online;
        s.status = d.online ? 'normal' : 'offline';
        s.lastValue = d.stateText;
        s.updateTime = d.lastSeenTs;
        s.lastTriggeredAt = d.lastSeenTs;
        s.battery = 100;
        s.signalStrength = d.csq >= 0 ? Math.min(4, Math.round((d.csq / 31) * 4)) : 0;
        out.push(s);
      }
    }
    return out.length > 0 ? out : null;
  }

  static alerts(): AlertEvent[] | null {
    if (!RealData.realMode()) return null;
    const alerts = AppStorage.get<AlertView[]>('gv.alerts');
    if (alerts === undefined || alerts === null) return null;
    const out: AlertEvent[] = [];
    for (let i = 0; i < alerts.length; i++) {
      const a = alerts[i];
      const e = new AlertEvent();
      e.id = a.alarmId.length > 0 ? a.alarmId : a.id;
      e.title = a.title;
      e.description = a.description;
      e.location = a.location.length > 0 ? a.location : a.roomName;
      e.sensorName = a.roomName;
      e.createdAt = a.createdAt;
      e.acknowledgedAt = a.acknowledgedAt;
      e.handlerName = a.acknowledgedBy;
      e.sensorType = RealData.kindToType(a.sensorType);
      let lvl: AlertLevel = 'medium';
      if (a.level === 'critical') lvl = 'critical';
      else if (a.level === 'high') lvl = 'high';
      else if (a.level === 'low') lvl = 'low';
      e.level = lvl;
      if (a.statusKey === 'acked') {
        e.status = 'closed' as AlertStatus;
        e.closedAt = a.acknowledgedAt;
      } else if (a.statusKey === 'waiting') {
        e.status = 'processing' as AlertStatus;
      } else {
        e.status = 'pending' as AlertStatus;
      }
      out.push(e);
    }
    return out;
  }
}
