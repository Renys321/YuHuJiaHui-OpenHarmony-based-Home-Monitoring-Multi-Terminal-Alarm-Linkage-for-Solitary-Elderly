/**
 * 预警列表项（真实 AlertView）。不显示伪造的“已推送 N 端”。
 */
import { Color, FontSize, FontWeight_, Radius, Shadow_, Space } from '../common/Theme';
import { AlertView } from '../core/view/Models';
import { DateUtil } from '../common/DateUtil';
import { LevelBadge } from './LevelBadge';

@Component
export struct AlertItem {
  @Prop alert: AlertView = new AlertView();
  onPress?: (a: AlertView) => void;

  private railColor(): string {
    if (this.alert.statusKey === 'acked') return Color.success;
    if (this.alert.statusKey === 'waiting') return Color.primary;
    if (this.alert.statusKey === 'pending') {
      return this.alert.level === 'critical' ? Color.critical : Color.warning;
    }
    return '#CBD5E1';
  }

  private statusChipBg(): string {
    if (this.alert.statusKey === 'acked') return Color.successLight;
    if (this.alert.statusKey === 'waiting') return Color.primaryLight;
    if (this.alert.statusKey === 'pending') {
      return this.alert.level === 'critical' ? Color.criticalLight : Color.warningLight;
    }
    return '#F1F5F9';
  }

  private statusChipFg(): string {
    if (this.alert.statusKey === 'acked') return Color.successDark;
    if (this.alert.statusKey === 'waiting') return Color.primaryDark;
    if (this.alert.statusKey === 'pending') {
      return this.alert.level === 'critical' ? Color.criticalDark : Color.warningDark;
    }
    return Color.textSecondary;
  }

  build() {
    Column() {
      Row() {
        LevelBadge({ level: this.alert.level })
        Text(this.alert.statusText)
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.semibold)
          .fontColor(this.statusChipFg())
          .padding({ left: 7, right: 7, top: 3, bottom: 3 })
          .backgroundColor(this.statusChipBg())
          .borderRadius(Radius.pill)
          .margin({ left: 6 })
        Blank()
        Text(this.alert.createdAt > 0 ? DateUtil.fromNow(this.alert.createdAt) : '时间未知')
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
        Text(this.alert.location)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.alert.evidenceAvailable) {
          Row() {
            SymbolGlyph($r('sys.symbol.camera_fill'))
              .fontSize(10)
              .fontColor([Color.primaryDark])
            Text('有证据元数据')
              .fontSize(FontSize.mini)
              .fontWeight(FontWeight_.semibold)
              .fontColor(Color.primaryDark)
              .margin({ left: 3 })
          }
        }
        if (this.alert.statusKey === 'acked' && this.alert.acknowledgedAt > 0) {
          Row() {
            SymbolGlyph($r('sys.symbol.checkmark'))
              .fontSize(10)
              .fontColor([Color.successDark])
            Text(DateUtil.formatTime(this.alert.acknowledgedAt))
              .fontSize(FontSize.mini)
              .fontWeight(FontWeight_.semibold)
              .fontColor(Color.successDark)
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
