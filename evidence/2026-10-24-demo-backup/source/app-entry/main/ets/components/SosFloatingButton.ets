/**
 * 全局悬浮紧急按钮 —— 保留视觉风格，但本轮无远程求助接口
 * 默认 enabled=false：明确“未开放”，点击只提示不可用，绝不给出任何发送成功类提示。
 * 是否隐藏/位移由页面通过 visible 控制。
 */
import { Color, FontSize, FontWeight_, Grad } from '../common/Theme';

@Component
export struct SosFloatingButton {
  @Prop visible: boolean = true;
  /** 仅当后端真正具备远程求助能力时才置 true；本轮固定未开放 */
  @Prop enabled: boolean = false;
  onTrigger?: () => void;

  private trigger(): void {
    if (this.enabled && this.onTrigger) {
      this.onTrigger();
      return;
    }
    this.getUIContext().getPromptAction().showToast({
      message: '远程一键求助未开放，如遇紧急情况请直接拨打 120'
    });
  }

  private buttonGrad(): LinearGradientOptions {
    if (this.enabled) {
      return Grad.critical();
    }
    return { angle: 135, colors: [['#F1F5F9', 0.0], ['#E2E8F0', 1.0]] };
  }

  private buttonShadow(): ShadowOptions {
    if (this.enabled) {
      return { radius: 26, color: 'rgba(220,38,38,0.5)', offsetX: 0, offsetY: 12 };
    }
    return { radius: 10, color: 'rgba(15,23,42,0.10)', offsetX: 0, offsetY: 3 };
  }

  private ringColor(): string {
    return this.enabled ? 'rgba(239,68,68,0.35)' : 'rgba(148,163,184,0.35)';
  }

  private borderColor(): string {
    return this.enabled ? 'rgba(0,0,0,0)' : 'rgba(220,38,38,0.45)';
  }

  build() {
    if (this.visible) {
      Stack({ alignContent: Alignment.Center }) {
        // 静态光环（不播放任何触发类动效）
        Column()
          .width(70)
          .height(70)
          .borderRadius(35)
          .border({ width: 1.5, color: this.ringColor() })

        Column() {
          SymbolGlyph($r('sys.symbol.phone_fill'))
            .fontSize(19)
            .fontColor([this.enabled ? '#FFFFFF' : Color.criticalDark])
          Text('SOS')
            .fontSize(FontSize.mini)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(this.enabled ? '#FFFFFF' : Color.criticalDark)
            .margin({ top: 1 })
          if (!this.enabled) {
            Text('未开放')
              .fontSize(FontSize.mini - 1)
              .fontColor(Color.textSecondary)
              .margin({ top: 1 })
          }
        }
        .width(58)
        .height(58)
        .justifyContent(FlexAlign.Center)
        .borderRadius(29)
        .linearGradient(this.buttonGrad())
        .border({ width: 1.5, color: this.borderColor() })
        .shadow(this.buttonShadow())
      }
      .width(76)
      .height(80)
      .onClick(() => this.trigger())
    }
  }
}
