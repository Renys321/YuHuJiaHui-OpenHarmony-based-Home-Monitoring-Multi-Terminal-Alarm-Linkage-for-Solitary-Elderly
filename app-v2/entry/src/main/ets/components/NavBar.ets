import { Color, FontSize, FontWeight_ } from '../common/Theme';

@Component
export struct NavBar {
  @Prop title: string = '';
  @Prop showBack: boolean = true;
  @Prop rightText: string = '';
  onRight?: () => void;

  build() {
    Row() {
      if (this.showBack)
        Row() {
          SymbolGlyph($r('sys.symbol.chevron_left'))
            .fontSize(22)
            .fontColor([Color.textPrimary])
        }
        .width(42)
        .height(42)
        .justifyContent(FlexAlign.Center)
        .onClick(() => this.getUIContext().getRouter().back())
      else
        Row().width(42).height(42)

      Text(this.title)
        .fontSize(15)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
        .layoutWeight(1)
        .textAlign(TextAlign.Center)

      if (this.rightText.length > 0)
        Text(this.rightText)
          .fontSize(FontSize.body)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.primaryDark)
          .height(42)
          .padding({ left: 14, right: 14 })
          .textAlign(TextAlign.Center)
          .onClick(() => { if (this.onRight) this.onRight(); })
      else
        Row()
          .width(42)
          .height(42)
    }
    .width('100%')
    .height(50)
    .backgroundColor('rgba(255,255,255,0.94)')
    .backdropBlur(12)
    .border({ width: { bottom: 1 }, color: Color.border })
  }
}
