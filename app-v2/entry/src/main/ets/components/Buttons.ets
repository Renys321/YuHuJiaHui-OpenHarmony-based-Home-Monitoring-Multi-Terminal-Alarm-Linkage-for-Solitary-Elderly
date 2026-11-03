import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Size, Space } from '../common/Theme';

@Component
export struct PrimaryButton {
  @Prop label: string = '';
  @Prop icon: Resource | null = null;
  @Prop loading: boolean = false;
  @Prop disabled: boolean = false;
  @Prop variant: string = 'primary';
  onClick_?: () => void;

  private grad(): LinearGradientOptions {
    if (this.variant === 'critical')
      return Grad.critical();
    if (this.variant === 'warning')
      return Grad.warning();
    if (this.variant === 'accent')
      return Grad.accent();
    if (this.variant === 'success')
      return Grad.success();
    return Grad.primary();
  }

  private shadowColor(): string {
    if (this.variant === 'critical')
      return 'rgba(220,38,38,0.35)';
    if (this.variant === 'warning')
      return 'rgba(217,119,6,0.30)';
    if (this.variant === 'accent')
      return 'rgba(234,88,12,0.30)';
    if (this.variant === 'success')
      return 'rgba(5,150,105,0.30)';
    return 'rgba(2,132,199,0.30)';
  }

  build() {
    Row() {
      if (this.loading) {
        LoadingProgress()
          .width(20)
          .height(20)
          .color('#FFFFFF')
          .margin({ right: Space.sm })
      } else if (this.icon !== null) {
        SymbolGlyph(this.icon!)
          .fontSize(18)
          .fontColor(['#FFFFFF'])
          .margin({ right: Space.sm })
      }
      Text(this.label)
        .fontSize(FontSize.h3)
        .fontWeight(FontWeight_.bold)
        .fontColor('#FFFFFF')
    }
    .width('100%')
    .height(Size.btnPrimary)
    .justifyContent(FlexAlign.Center)
    .borderRadius(Radius.button)
    .linearGradient(this.disabled
      ? { angle: 135, colors: [[Color.textTertiary, 0.0], [Color.textTertiary, 1.0]] }
      : this.grad())
    .shadow(this.disabled
      ? { radius: 0, color: 'rgba(0,0,0,0)', offsetX: 0, offsetY: 0 }
      : Shadow_.pop(this.shadowColor()))
    .opacity(this.disabled && !this.loading ? 0.6 : 1)
    .onClick(() => {
      if (!this.disabled && !this.loading && this.onClick_)
        this.onClick_();
    })
  }
}

@Component
export struct SecondaryButton {
  @Prop label: string = '';
  @Prop icon: Resource | null = null;
  @Prop color: string = Color.primary;
  @Prop disabled: boolean = false;
  onClick_?: () => void;

  build() {
    Row() {
      if (this.icon !== null)
        SymbolGlyph(this.icon!)
          .fontSize(16)
          .fontColor([this.color])
          .margin({ right: Space.xs + 2 })
      Text(this.label)
        .fontSize(FontSize.body + 1)
        .fontWeight(FontWeight_.semibold)
        .fontColor(this.disabled ? Color.textTertiary : this.color)
    }
    .width('100%')
    .height(Size.btnSecondary)
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#FFFFFF')
    .border({ width: 1.5, color: this.disabled ? Color.border : Color.border })
    .borderRadius(Radius.button)
    .shadow(Shadow_.card())
    .onClick(() => {
      if (!this.disabled && this.onClick_)
        this.onClick_();
    })
  }
}

@Component
export struct GhostButton {
  @Prop label: string = '';
  @Prop color: string = Color.textSecondary;
  onClick_?: () => void;

  build() {
    Text(this.label)
      .fontSize(FontSize.body + 1)
      .fontColor(this.color)
      .height(Size.btnGhost)
      .padding({ left: Space.lg, right: Space.lg })
      .textAlign(TextAlign.Center)
      .onClick(() => { if (this.onClick_) this.onClick_(); })
  }
}
