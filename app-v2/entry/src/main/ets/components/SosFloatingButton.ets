 // 全局悬浮紧急按钮 —— v2 渐变 + 脉冲扩散环
 //  长按 1.5s 触发一键呼救，防误触

import { Color, FontSize, FontWeight_, Grad } from '../common/Theme';

@Component
export struct SosFloatingButton {
  @Prop visible: boolean = true;
  onTrigger?: () => void;
  @State pressing: boolean = false;
  @State progress: number = 0;
  @State pulseScale: number = 0.85;
  @State pulseOpacity: number = 0.9;
  private timerId: number = -1;

  aboutToAppear() {
    // 脉冲扩散环：0.85→1.3 循环
    this.getUIContext().animateTo({
      duration: 1800,
      iterations: -1,
      curve: Curve.EaseOut
    }, () => {
      this.pulseScale = 1.3;
      this.pulseOpacity = 0;
    });
  }

  aboutToDisappear() {
    if (this.timerId !== -1) {
      clearInterval(this.timerId);
    }
  }

  private startPress() {
    this.pressing = true;
    this.progress = 0;
    const step = 50;            // 每 50ms
    const total = 1500;         // 1.5s
    const inc = step / total * 100;
    this.timerId = setInterval(() => {
      this.progress += inc;
      if (this.progress >= 100) {
        clearInterval(this.timerId);
        this.timerId = -1;
        this.pressing = false;
        this.progress = 0;
        this.getUIContext().getPromptAction().showToast({ message: '已触发一键呼救，正在推送至全部联系人' });
        if (this.onTrigger)
          this.onTrigger();
      }
    }, step);
  }

  private cancelPress() {
    if (this.timerId !== -1) {
      clearInterval(this.timerId);
      this.timerId = -1;
    }
    this.pressing = false;
    this.progress = 0;
  }

  build() {
    if (this.visible) {
      Stack() {
        // 脉冲扩散环
        Column()
          .width(58)
          .height(58)
          .borderRadius(29)
          .border({ width: 2, color: 'rgba(239,68,68,0.45)' })
          .scale({ x: this.pulseScale, y: this.pulseScale })
          .opacity(this.pulseOpacity)

        // 长按进度环
        if (this.pressing)
          Progress({ value: this.progress, total: 100, type: ProgressType.Ring })
            .width(72)
            .height(72)
            .color('#FFFFFF')
            .backgroundColor('#7F1D1D')
            .style({ strokeWidth: 4 })

        Column() {
          SymbolGlyph($r('sys.symbol.phone_fill'))
            .fontSize(20)
            .fontColor(['#FFFFFF'])
          Text('SOS')
            .fontSize(FontSize.mini)
            .fontWeight(FontWeight_.extrabold)
            .fontColor('#FFFFFF')
            .margin({ top: 1 })
        }
        .width(58)
        .height(58)
        .justifyContent(FlexAlign.Center)
        .borderRadius(29)
        .linearGradient(Grad.critical())
        .shadow({ radius: 26, color: 'rgba(220,38,38,0.5)', offsetX: 0, offsetY: 12 })
      }
      .width(76)
      .height(76)
      .onTouch((e: TouchEvent) => {
        if (e.type === TouchType.Down)
          this.startPress();
        else if (e.type === TouchType.Up || e.type === TouchType.Cancel)
          this.cancelPress();
      })
    }
  }
}
