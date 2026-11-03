import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { AlertEvent, AlertMeta } from '../model/AlertEvent';
import { SensorMeta } from '../model/Sensor';
import { DateUtil } from '../common/DateUtil';
import { LevelBadge } from './LevelBadge';

@Component
export struct AlertItem {
  @Prop alert: AlertEvent = new AlertEvent();
  onPress?: (a: AlertEvent) => void;

  private railColor(): string {
    if (this.alert.status === 'closed' || this.alert.status === 'false_alarm')
      return '#CBD5E1';
    if (this.alert.status === 'pending' && this.alert.level === 'critical')
      return Color.critical;
    if (this.alert.status === 'pending')
      return Color.warning;
    return Color.primary;
  }

  private statusChipText(): string {
    return AlertMeta.statusLabel(this.alert.status);
  }

  private statusChipBg(): string {
    if (this.alert.status === 'pending')
      return Color.criticalLight;
    if (this.alert.status === 'processing')
      return Color.warningLight;
    if (this.alert.status === 'closed')
      return Color.successLight;
    return '#F1F5F9';
  }

  private statusChipFg(): string {
    if (this.alert.status === 'pending')
      return Color.criticalDark;
    if (this.alert.status === 'processing')
      return Color.warningDark;
    if (this.alert.status === 'closed')
      return Color.successDark;
    return Color.textSecondary;
  }

  build() {
    Column() {
      Row() {
        LevelBadge({ level: this.alert.level })
        Text(this.statusChipText())
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.semibold)
          .fontColor(this.statusChipFg())
          .padding({ left: 7, right: 7, top: 3, bottom: 3 })
          .backgroundColor(this.statusChipBg())
          .borderRadius(Radius.pill)
          .margin({ left: 6 })
        Blank()
        Text(DateUtil.formatDateTime(this.alert.createdAt))
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
      }
      .width('100%')

      Text(this.alert.title)
        .fontSize(FontSize.h3 - 1)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
        .margin({ top: Space.sm - 1 })
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      Text(this.alert.description)
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .lineHeight(16)
        .margin({ top: Space.xs })
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      Row() {
        SymbolGlyph(SensorMeta.icon(this.alert.sensorType))
          .fontSize(11)
          .fontColor([Color.textTertiary])
        Text(`${this.alert.sensorName} · ${this.alert.location}`)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ left: Space.xs })
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.alert.disposition !== null && this.alert.disposition !== undefined) {
          Row() {
            SymbolGlyph($r('sys.symbol.checkmark'))
              .fontSize(10)
              .fontColor([Color.successDark])
            Text(AlertMeta.dispositionLabel(this.alert.disposition))
              .fontSize(FontSize.mini)
              .fontWeight(FontWeight_.semibold)
              .fontColor(Color.successDark)
              .margin({ left: 3 })
          }
        } else if (this.alert.pushedTo.length > 0 && this.alert.status === 'pending') {
          Row() {
            SymbolGlyph($r('sys.symbol.paperplane_fill'))
              .fontSize(10)
              .fontColor([Color.criticalDark])
            Text(`已推送 ${this.alert.pushedTo.length} 端`)
              .fontSize(FontSize.mini)
              .fontWeight(FontWeight_.semibold)
              .fontColor(Color.criticalDark)
              .margin({ left: 3 })
          }
        }
      }
      .width('100%')
      .margin({ top: Space.sm - 1 })
    }
    .width('100%')
    .padding(Space.md + 1)
    .alignItems(HorizontalAlign.Start)
    .backgroundColor(Color.card)
    .borderRadius(Radius.tile)
    .clip(true)
    .border({ width: { left: 4 }, color: this.railColor() })
    .shadow(Shadow_.card())
    .onClick(() => { if (this.onPress) this.onPress(this.alert); })
  }
}
