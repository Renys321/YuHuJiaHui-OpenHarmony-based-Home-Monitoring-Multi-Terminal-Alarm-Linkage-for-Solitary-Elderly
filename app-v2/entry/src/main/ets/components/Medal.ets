import { Color, Grad, Shadow_ } from '../common/Theme';

@Component
export struct Medal {
  @Prop variant: string = 'pri';
  @Prop icon: Resource = $r('sys.symbol.circle');
  @Prop medalSize: number = 42;

  private grad(): LinearGradientOptions {
    if (this.variant === 'crit')
      return Grad.critical();
    if (this.variant === 'warn')
      return Grad.warning();
    if (this.variant === 'ok')
      return Grad.success();
    if (this.variant === 'acc')
      return Grad.accent();
    if (this.variant === 'soft')
      return { angle: 135, colors: [[Color.primaryLight, 0.0], [Color.primaryLight, 1.0]] };
    if (this.variant === 'softacc')
      return { angle: 135, colors: [['#FFF1E6', 0.0], ['#FFF1E6', 1.0]] };
    if (this.variant === 'softcrit')
      return { angle: 135, colors: [[Color.criticalLight, 0.0], [Color.criticalLight, 1.0]] };
    return Grad.primary();
  }

  private fg(): string {
    if (this.variant === 'soft')
      return Color.primaryDark;
    if (this.variant === 'softacc')
      return Color.accentDark;
    if (this.variant === 'softcrit')
      return Color.criticalDark;
    return '#FFFFFF';
  }

  private medalShadow(): ShadowOptions {
    if (this.variant === 'soft' || this.variant === 'softacc' || this.variant === 'softcrit')
      return { radius: 0, color: 'rgba(0,0,0,0)', offsetX: 0, offsetY: 0 };
    if (this.variant === 'crit')
      return Shadow_.medal('rgba(220,38,38,0.35)');
    if (this.variant === 'warn')
      return Shadow_.medal('rgba(217,119,6,0.30)');
    if (this.variant === 'ok')
      return Shadow_.medal('rgba(5,150,105,0.30)');
    if (this.variant === 'acc')
      return Shadow_.medal('rgba(234,88,12,0.30)');
    return Shadow_.medal('rgba(2,132,199,0.30)');
  }

  build() {
    Column() {
      SymbolGlyph(this.icon)
        .fontSize(this.medalSize * 0.5)
        .fontColor([this.fg()])
    }
    .width(this.medalSize)
    .height(this.medalSize)
    .borderRadius(this.medalSize * 0.34)
    .justifyContent(FlexAlign.Center)
    .linearGradient(this.grad())
    .shadow(this.medalShadow())
  }
}
