import { ElderSafeEventView } from '../core/view/Models';
import { AlertEvent } from '../model/AlertEvent';

/**
 * 老人自述安全（我没事）与原告警的闭环关系。
 * - 有 alarmId：精确匹配该告警，已 ACK/归档后不再展示；
 * - 无 alarmId：按同房间 + 时间兜底，若该房间有更晚的 ACK，则视为已闭环。
 * 注意：这里只影响“是否继续展示自述安全卡片”，绝不修改告警 ACK 状态。
 */
export class ElderSafeLogic {
  static readonly STATE_UNCONFIRMED = 'unconfirmed';
  static readonly STATE_PENDING_ACK = 'pending_ack';
  static readonly STATE_RESOLVED = 'resolved';

  private static alertResolved(a: AlertEvent): boolean {
    return a.acknowledgedAt > 0 || a.closedAt > 0
      || a.status === 'closed' || a.status === 'false_alarm';
  }

  /** 家属已点确认、等待设备回执：不是已闭环，但也不该再写“未确认”。 */
  private static alertPendingAck(a: AlertEvent): boolean {
    return !ElderSafeLogic.alertResolved(a) && a.status === 'processing';
  }

  /** 三态：unconfirmed / pending_ack / resolved。 */
  static stateOf(e: ElderSafeEventView, alerts: AlertEvent[]): string {
    if (e.alarmId.length > 0) {
      for (let i = 0; i < alerts.length; i++) {
        if (alerts[i].id === e.alarmId) {
          if (ElderSafeLogic.alertResolved(alerts[i])) return ElderSafeLogic.STATE_RESOLVED;
          if (ElderSafeLogic.alertPendingAck(alerts[i])) return ElderSafeLogic.STATE_PENDING_ACK;
          return ElderSafeLogic.STATE_UNCONFIRMED;
        }
      }
      return ElderSafeLogic.STATE_UNCONFIRMED;
    }
    // 兜底：无 alarmId 时只信“ACK 时间晚于自述事件”，不把 processing 当已闭环。
    const eAt = e.hasValidAt ? e.at : 0;
    if (eAt <= 0) return ElderSafeLogic.STATE_UNCONFIRMED;
    for (let i = 0; i < alerts.length; i++) {
      const a = alerts[i];
      const room = a.location.length > 0 ? a.location : a.sensorName;
      if (room !== e.roomName) continue;
      const ackAt = a.acknowledgedAt > 0 ? a.acknowledgedAt : a.closedAt;
      if (ackAt > 0 && ackAt >= eAt && a.createdAt <= eAt + 30 * 60 * 1000) {
        return ElderSafeLogic.STATE_RESOLVED;
      }
    }
    return ElderSafeLogic.STATE_UNCONFIRMED;
  }

  static resolved(e: ElderSafeEventView, alerts: AlertEvent[]): boolean {
    return ElderSafeLogic.stateOf(e, alerts) === ElderSafeLogic.STATE_RESOLVED;
  }

  static ackPending(e: ElderSafeEventView, alerts: AlertEvent[]): boolean {
    return ElderSafeLogic.stateOf(e, alerts) === ElderSafeLogic.STATE_PENDING_ACK;
  }

  static visible(list: ElderSafeEventView[], alerts: AlertEvent[]): ElderSafeEventView[] {
    if (list.length === 0) return [];
    // 全局只看最新一条：最新已真正 ACKED/归档则整卡隐藏；
    // “等待设备回执”仍显示这一条，避免旧事件堆叠造成“有两个”的困惑。
    if (ElderSafeLogic.resolved(list[0], alerts)) return [];
    return [list[0]];
  }
}
