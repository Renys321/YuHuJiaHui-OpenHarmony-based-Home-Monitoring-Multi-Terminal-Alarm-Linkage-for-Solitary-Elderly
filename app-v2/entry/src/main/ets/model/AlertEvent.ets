/**
 * 预警事件模型
 */
import { SensorType } from './Sensor';

export type AlertLevel = 'critical' | 'high' | 'medium' | 'low';
export type AlertStatus = 'pending' | 'processing' | 'closed' | 'false_alarm';
export type DispositionType =
  | 'called_elder'
  | 'contacted_family'
  | 'contacted_community'
  | 'called_120'
  | 'called_119'
  | 'on_site'
  | 'false_alarm';

@Observed
export class AlertEvent {
  id: string = '';
  level: AlertLevel = 'medium';
  status: AlertStatus = 'pending';
  sensorType: SensorType = 'motion';
  sensorName: string = '';
  location: string = '';
  title: string = '';
  description: string = '';
  createdAt: number = 0;
  acknowledgedAt: number = 0;
  closedAt: number = 0;
  handlerName: string = '';
  disposition: DispositionType | null = null;
  dispositionNote: string = '';
  timeline: TimelineItem[] = [];
  pushedTo: string[] = [];
}

@Observed
export class TimelineItem {
  time: number = 0;
  actor: string = '';
  action: string = '';
  note: string = '';
}

export class AlertMeta {
  static levelLabel(l: AlertLevel): string {
    if (l === 'critical')
      return '紧急';
    if (l === 'high')
      return '高危';
    if (l === 'medium')
      return '中等';
    return '提示';
  }

  static levelColor(l: AlertLevel): string {
    if (l === 'critical')
      return '#EF4444';
    if (l === 'high')
      return '#F59E0B';
    if (l === 'medium')
      return '#0EA5E9';
    return '#64748B';
  }

  static levelBg(l: AlertLevel): string {
    if (l === 'critical')
      return '#FEE2E2';
    if (l === 'high')
      return '#FEF3C7';
    if (l === 'medium')
      return '#E0F2FE';
    return '#F1F5F9';
  }

  static statusLabel(s: AlertStatus): string {
    if (s === 'pending')
      return '待处置';
    if (s === 'processing')
      return '处置中';
    if (s === 'closed')
      return '已归档';
    return '误报';
  }

  static dispositionLabel(d: DispositionType): string {
    if (d === 'called_elder')
      return '已电话联系老人';
    if (d === 'contacted_family')
      return '已联系家属';
    if (d === 'contacted_community')
      return '已联系社区网格员';
    if (d === 'called_120')
      return '已呼叫 120';
    if (d === 'called_119')
      return '已呼叫 119';
    if (d === 'on_site')
      return '已上门查看';
    return '标记为误报';
  }
}
