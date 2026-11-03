import { Color, FontSize, FontWeight_, Radius, Space } from '../common/Theme';
import { AlertLevel, AlertMeta } from '../model/AlertEvent';

@Component
export struct LevelBadge {
  @Prop level: string = 'low';
  @Prop small: boolean = false;

  build() {
    Row() {
      Column()
        .width(this.small ? 6 : 8)
        .height(this.small ? 6 : 8)
        .borderRadius(this.small ? 3 : 4)
        .backgroundColor(AlertMeta.levelColor(this.level as AlertLevel))
        .margin({ right: Space.xs + 2 })
      Text(AlertMeta.levelLabel(this.level as AlertLevel))
        .fontSize(this.small ? FontSize.mini : FontSize.caption)
        .fontWeight(FontWeight_.semibold)
        .fontColor(AlertMeta.levelColor(this.level as AlertLevel))
    }
    .padding({
      left: this.small ? Space.sm : Space.md,
      right: this.small ? Space.sm : Space.md,
      top: this.small ? 2 : Space.xs,
      bottom: this.small ? 2 : Space.xs
    })
    .backgroundColor(AlertMeta.levelBg(this.level as AlertLevel))
    .borderRadius(Radius.pill)
  }
}

@Component
export struct TagChip {
  @Prop text: string = '';
  @Prop color: string = Color.textSecondary;
  @Prop bg: string = '#F1F5F9';

  build() {
    Text(this.text)
      .fontSize(FontSize.caption)
      .fontColor(this.color)
      .padding({ left: Space.sm, right: Space.sm, top: 3, bottom: 3 })
      .backgroundColor(this.bg)
      .borderRadius(Radius.pill)
  }
}
