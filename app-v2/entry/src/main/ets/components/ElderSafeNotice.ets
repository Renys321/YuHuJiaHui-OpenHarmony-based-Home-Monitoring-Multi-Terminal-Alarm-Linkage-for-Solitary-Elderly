import { FontSize, FontWeight_, Radius, Space } from '../common/Theme';
import { ElderSafeEventView } from '../core/view/Models';

/**
 * “老人自述安全”记录卡片。
 * 语义固定：这类记录永远是“未确认”，且不改变原告警的 ACK；
 * alarmId 只用于跳转原预警详情，绝不在这里触发任何 ACK。
 */
@Component
export struct ElderSafeNotice {
  @Prop event: ElderSafeEventView = new ElderSafeEventView();
  @Prop ackPending: boolean = false;
  onPress?: () => void;

  build() {
    Column() {
      Row() {
        Text('老人自述安全')
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.bold)
          .fontColor('#166534')
        Blank()
        Text(this.event.timeText)
          .fontSize(FontSize.mini)
          .fontColor(this.ackPending ? '#B45309' : '#4D7C5F')
      }
      .width('100%')

      Text(`“${this.event.text}”`)
        .fontSize(FontSize.h3)
        .fontWeight(FontWeight_.bold)
        .fontColor('#14532D')
        .margin({ top: Space.sm - 2 })
        .width('100%')

      Row() {
        Text(this.ackPending
          ? `${this.event.roomName} · 家属已确认，等待设备回执`
          : `${this.event.roomName} · 状态：未确认（不影响原告警 ACK）`)
          .fontSize(FontSize.mini)
          .fontColor(this.ackPending ? '#B45309' : '#4D7C5F')
          .layoutWeight(1)
        if (this.event.alarmId.length > 0) {
          Text('查看原预警')
            .fontSize(FontSize.mini)
            .fontWeight(FontWeight_.semibold)
            .fontColor('#15803D')
        }
      }
      .width('100%')
      .margin({ top: Space.sm - 2 })
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor('#F0FDF4')
    .borderRadius(Radius.card)
    .border({ width: 1, color: '#BBF7D0' })
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      if (this.onPress !== undefined) {
        this.onPress();
      }
    })
  }
}
