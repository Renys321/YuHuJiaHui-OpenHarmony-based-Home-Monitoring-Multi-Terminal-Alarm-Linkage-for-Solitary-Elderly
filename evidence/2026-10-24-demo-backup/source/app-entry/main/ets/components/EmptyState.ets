/**
 * 空态占位
 */
import { Color, FontSize, Space } from '../common/Theme';

@Component
export struct EmptyState {
  @Prop icon: Resource = $r('sys.symbol.checkmark_circle');
  @Prop title: string = '暂无数据';
  @Prop description: string = '';
  @Prop iconColor: string = Color.textTertiary;

  build() {
    Column() {
      SymbolGlyph(this.icon)
        .fontSize(56)
        .fontColor([this.iconColor])
      Text(this.title)
        .fontSize(FontSize.h3)
        .fontColor(Color.textSecondary)
        .margin({ top: Space.md })
      if (this.description.length > 0) {
        Text(this.description)
          .fontSize(FontSize.caption)
          .fontColor(Color.textTertiary)
          .margin({ top: Space.xs })
          .textAlign(TextAlign.Center)
      }
    }
    .width('100%')
    .padding({ top: Space.xxxl * 2, bottom: Space.xxxl * 2 })
    .alignItems(HorizontalAlign.Center)
  }
}
