/**
 * 顶部总体状态卡片 —— 数据状态必须由页面从真实数据推导
 *  - normal：绿 · 仅当设备全部在线且无待确认告警
 *  - warning：橙 · 待确认/等待设备确认/设备异常
 *  - critical：红 · 紧急未确认告警
 *  - unknown：灰蓝 · 数据缺失/获取中（不得显示绿色正常）
 *  - offline：灰 · 网络失败/离线，显示上次数据
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Medal } from './Medal';

export type OverallStatus = 'normal' | 'warning' | 'critical' | 'unknown' | 'offline';

@Component
export struct StatusCard {
  @Prop status: OverallStatus = 'unknown';
  @Prop eyebrow: string = '';
  @Prop headline: string = '';
  @Prop subline: string = '';
  @Prop pendingCount: number = 0;
  @Prop lastUpdate: string = '';
  @Prop lastUpdateWarn: boolean = false;
  onPress?: () => void;

  private hero(): LinearGradientOptions {
    if (this.status === 'critical') return Grad.heroCritical();
    if (this.status === 'warning') return Grad.heroWarning();
    if (this.status === 'normal') return Grad.heroSuccess();
    if (this.status === 'offline') {
      return { angle: 140, colors: [['#EEF1F5', 0.0], ['#F7F9FB', 0.55], ['#FFFFFF', 1.0]] };
    }
    return { angle: 140, colors: [['#E8EEF6', 0.0], ['#F5F8FC', 0.55], ['#FFFFFF', 1.0]] };
  }

  private medalVariant(): string {
    if (this.status === 'critical') return 'crit';
    if (this.status === 'warning') return 'warn';
    if (this.status === 'normal') return 'ok';
    return 'soft';
  }

  private icon(): Resource {
    if (this.status === 'critical') return $r('sys.symbol.exclamationmark_circle_fill');
    if (this.status === 'warning') return $r('sys.symbol.exclamationmark_triangle_fill');
    if (this.status === 'normal') return $r('sys.symbol.checkmark_circle_fill');
    return $r('sys.symbol.info_circle');
  }

  private railColor(): string {
    if (this.status === 'critical') return Color.criticalDark;
    if (this.status === 'warning') return Color.warningDark;
    if (this.status === 'normal') return Color.successDark;
    if (this.status === 'offline') return Color.textTertiary;
    return Color.primaryDark;
  }

  private shadowColor(): string {
    if (this.status === 'critical') return 'rgba(220,38,38,0.14)';
    if (this.status === 'warning') return 'rgba(217,119,6,0.14)';
    if (this.status === 'normal') return 'rgba(5,150,105,0.14)';
    return 'rgba(100,116,139,0.12)';
  }

  private updateColor(): string {
    return this.lastUpdateWarn ? Color.warningDark : Color.textTertiary;
  }

  build() {
    Column() {
      Row() {
        Text(this.eyebrow)
          .fontSize(FontSize.caption)
          .fontColor(Color.textSecondary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(this.lastUpdate)
          .fontSize(FontSize.mini)
          .fontColor(this.updateColor())
          .maxLines(1)
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
            .maxLines(2)
          Text(this.subline)
            .fontSize(FontSize.body)
            .fontColor(Color.textSecondary)
            .lineHeight(17)
            .margin({ top: 3 })
            .maxLines(3)
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
          Text(' 条待确认告警')
            .fontSize(FontSize.body)
            .fontColor(Color.textPrimary)
          Blank()
          Row() {
            Text('查看详情')
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
