import { Color, FontSize, FontWeight_, Grad, Space } from '../common/Theme';

@Component
export struct SectionHeader {
  @Prop title: string = '';
  @Prop subtitle: string = '';
  @Prop moreText: string = '';
  onMore?: () => void;

  build() {
    Row() {
      Column() {
        Row() {
          Column()
            .width(3)
            .height(13)
            .borderRadius(2)
            .linearGradient(Grad.primary())
            .margin({ right: 7 })
          Text(this.title)
            .fontSize(FontSize.h3)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textPrimary)
        }
        .alignItems(VerticalAlign.Center)

        if (this.subtitle.length > 0)
          Text(this.subtitle)
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: Space.xs, left: 10 })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      if (this.moreText.length > 0)
        Row() {
          Text(this.moreText)
            .fontSize(FontSize.caption + 0.5)
            .fontWeight(FontWeight_.semibold)
            .fontColor(Color.primaryDark)
          SymbolGlyph($r('sys.symbol.chevron_right'))
            .fontSize(12)
            .fontColor([Color.primaryDark])
            .margin({ left: 2 })
        }
        .height(44)
        .padding({ left: Space.sm, right: Space.sm })
        .onClick(() => { if (this.onMore) this.onMore(); })
    }
    .width('100%')
    .padding({ left: Space.lg, right: Space.lg, top: Space.md, bottom: Space.sm })
  }
}
