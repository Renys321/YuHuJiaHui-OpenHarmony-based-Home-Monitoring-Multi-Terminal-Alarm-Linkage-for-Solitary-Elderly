/**
 * 顶部总体状态卡片 —— v2 渐变晕染 + 渐变徽章 + 内嵌 CTA
 *  - 正常：绿 · "一切正常"
 *  - 预警：橙 · "N 条待处置"
 *  - 危急：红 · "紧急求助"
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Medal } from './Medal';

export type OverallStatus = 'normal' | 'warning' | 'critical';

@Component
export struct StatusCard {
  @Prop status: OverallStatus = 'normal';
  @Prop elderName: string = '';
  @Prop headline: string = '';
  @Prop subline: string = '';
  @Prop pendingCount: number = 0;
  @Prop lastUpdate: string = '';
  onPress?: () => void;

  private hero(): LinearGradientOptions {
    if (this.status === 'critical')
      return Grad.heroCritical();
    if (this.status === 'warning')
      return Grad.heroWarning();
    return Grad.heroSuccess();
  }

  private medalVariant(): string {
    if (this.status === 'critical')
      return 'crit';
    if (this.status === 'warning')
      return 'warn';
    return 'ok';
  }

  private icon(): Resource {
    if (this.status === 'critical')
      return $r('sys.symbol.exclamationmark_circle_fill');
    if (this.status === 'warning')
      return $r('sys.symbol.exclamationmark_triangle_fill');
    return $r('sys.symbol.checkmark_circle_fill');
  }

  private railColor(): string {
    if (this.status === 'critical')
      return Color.criticalDark;
    if (this.status === 'warning')
      return Color.warningDark;
    return Color.successDark;
  }

  private shadowColor(): string {
    if (this.status === 'critical')
      return 'rgba(220,38,38,0.14)';
    if (this.status === 'warning')
      return 'rgba(217,119,6,0.14)';
    return 'rgba(5,150,105,0.14)';
  }

  build() {
    Column() {
      Row() {
        Text(this.elderName)
          .fontSize(FontSize.caption)
          .fontColor(Color.textSecondary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(this.lastUpdate)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
      }
      .width('100%')

      Row() {
        Medal({ variant: this.medalVariant(), icon: this.icon(), medalSize: 44 })
          .margin({ right: Space.md })
        Column() {
          Text(this.headline)
            .fontSize(FontSize.h1)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(Color.textPrimary)
          Text(this.subline)
            .fontSize(FontSize.body)
            .fontColor(Color.textSecondary)
            .margin({ top: 3 })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .margin({ top: Space.md })

      if (this.pendingCount > 0) {
        Row() {
          Text(`${this.pendingCount}`)
            .fontSize(19)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(this.railColor())
          Text(' 条待处置预警')
            .fontSize(FontSize.body)
            .fontColor(Color.textPrimary)
          Blank()
          Row() {
            Text('立即处理')
              .fontSize(FontSize.body - 1)
              .fontWeight(FontWeight_.bold)
              .fontColor(this.railColor())
            SymbolGlyph($r('sys.symbol.chevron_right'))
              .fontSize(11)
              .fontColor([this.railColor()])
              .margin({ left: 2 })
          }
        }
        .width('100%')
        .padding({ left: Space.md, right: Space.md, top: 10, bottom: 10 })
        .backgroundColor('#FFFFFF')
        .borderRadius(Radius.button)
        .shadow(Shadow_.card())
        .margin({ top: Space.md })
      }
    }
    .width('100%')
    .padding({ left: Space.lg, right: Space.lg, top: Space.lg - 2, bottom: Space.lg - 2 })
    .alignItems(HorizontalAlign.Start)
    .borderRadius(22)
    .clip(true)
    .linearGradient(this.hero())
    .border({ width: { left: 5 }, color: this.railColor() })
    .shadow(Shadow_.pop(this.shadowColor()))
    .onClick(() => { if (this.onPress) this.onPress(); })
  }
}
