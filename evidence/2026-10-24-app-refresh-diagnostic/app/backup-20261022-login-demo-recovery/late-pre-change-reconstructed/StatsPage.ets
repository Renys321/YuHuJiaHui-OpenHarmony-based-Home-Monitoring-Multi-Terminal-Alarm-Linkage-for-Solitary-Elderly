/**
 * 数据统计页 —— 只展示能从真实 gv.alerts 推导的统计
 * 无数据源的模块（活动曲线/睡眠/AI 洞察/报告导出）明确“暂无数据/未开放”，不编造指标。
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { AlertView } from '../core/view/Models';

class DayStat {
  key: string = '';
  label: string = '';
  count: number = 0;
}

@Entry
@Component
struct StatsPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.netStatus') netStatus: string = 'unknown';
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private days(): DayStat[] {
    const out: DayStat[] = [];
    const base: number = Date.now();
    for (let i = 6; i >= 0; i--) {
      const d: Date = new Date(base);
      d.setDate(d.getDate() - i);
      const item = new DayStat();
      item.key = DateUtil.formatDate(d.getTime());
      item.label = `${d.getMonth() + 1}/${d.getDate()}`;
      item.count = 0;
      out.push(item);
    }
    for (let i = 0; i < this.alerts.length; i++) {
      const key: string = DateUtil.formatDate(this.alerts[i].createdAt);
      for (let j = 0; j < out.length; j++) {
        if (out[j].key === key) {
          out[j].count = out[j].count + 1;
          break;
        }
      }
    }
    return out;
  }

  private total7(): number {
    const list: DayStat[] = this.days();
    let sum: number = 0;
    for (let i = 0; i < list.length; i++) {
      sum = sum + list[i].count;
    }
    return sum;
  }

  private todayCount(): number {
    const today: string = DateUtil.formatDate(Date.now());
    let count: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (DateUtil.formatDate(this.alerts[i].createdAt) === today) {
        count++;
      }
    }
    return count;
  }

  private pendingCount(): number {
    let count: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (this.alerts[i].statusKey === 'pending') {
        count++;
      }
    }
    return count;
  }

  private waitingCount(): number {
    let count: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (this.alerts[i].statusKey === 'waiting') {
        count++;
      }
    }
    return count;
  }

  private maxCount(): number {
    const list: DayStat[] = this.days();
    let max: number = 1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].count > max) {
        max = list[i].count;
      }
    }
    return max;
  }

  private netWarn(): boolean {
    return this.netStatus !== 'ok' && this.netStatus !== 'loading';
  }

  private netFatal(): boolean {
    return this.netStatus === 'error' || this.netStatus === 'unauthorized';
  }

  private netFg(): string {
    if (this.netFatal()) return Color.criticalDark;
    return Color.warningDark;
  }

  private netBg(): string {
    if (this.netFatal()) return Color.criticalLight;
    return Color.warningLight;
  }

  private hasData(): boolean {
    return this.lastUpdatedAt > 0;
  }

  private valueOrDash(value: number): string {
    return this.hasData() ? `${value}` : '--';
  }

  private toast(text: string): void {
    this.getUIContext().getPromptAction().showToast({ message: text });
  }

  @Builder
  kpiCard(value: string, label: string, note: string, color: string) {
    Column() {
      Text(value)
        .fontSize(20)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(color)
      Text(label)
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textSecondary)
        .margin({ top: 2 })
      Text(note)
        .fontSize(FontSize.mini - 0.5)
        .fontColor(Color.textTertiary)
        .margin({ top: 4 })
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .padding(Space.md)
    .backgroundColor(Color.card)
    .borderRadius(Radius.tile)
    .shadow(Shadow_.card())
  }

  build() {
    Column() {
      NavBar({
        title: '数据统计', showBack: true, rightText: '导出',
        onRight: () => { this.toast('报告导出未开放（本轮无导出接口）'); }
      })

      Scroll() {
        Column() {
          if (this.netWarn() && this.netMessage.length > 0) {
            Row() {
              SymbolGlyph($r('sys.symbol.info_circle'))
                .fontSize(13)
                .fontColor([this.netFg()])
              Text(this.netMessage)
                .fontSize(FontSize.caption)
                .fontColor(this.netFg())
                .lineHeight(15)
                .margin({ left: 5 })
                .layoutWeight(1)
                .maxLines(2)
            }
            .width('100%')
            .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
            .backgroundColor(this.netBg())
            .borderRadius(Radius.chip)
            .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
          }

          Row() {
            Text('近 7 天真实告警统计（按本地日期聚合）')
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
            Blank()
            Text(this.lastUpdatedAt > 0 ? `更新 ${DateUtil.formatTime(this.lastUpdatedAt)}` : '尚未更新')
              .fontSize(FontSize.caption - 0.5)
              .fontColor(Color.textTertiary)
          }
          .width('100%')
          .padding({ left: this.pm() + 2, right: this.pm() + 2, top: Space.md - 2, bottom: Space.sm })

          // KPI：仅真实告警口径
          Row({ space: 9 }) {
            this.kpiCard(this.valueOrDash(this.alerts.length), '总告警数', '全部真实告警', Color.primaryDark)
            this.kpiCard(this.valueOrDash(this.pendingCount()), '待确认', '等待监护人确认',
              this.pendingCount() > 0 ? Color.criticalDark : Color.textTertiary)
            this.kpiCard(this.valueOrDash(this.total7()), '近 7 天告警', '按本地日期聚合',
              this.total7() > 0 ? Color.warningDark : Color.textTertiary)
          }
          .width('100%')
          .padding({ left: this.pm(), right: this.pm() })

          if (this.waitingCount() > 0) {
            Row() {
              SymbolGlyph($r('sys.symbol.info_circle'))
                .fontSize(12)
                .fontColor([Color.warningDark])
              Text(`${this.waitingCount()} 条命令已提交，尚未收到设备回执`)
                .fontSize(FontSize.caption)
                .fontColor(Color.warningDark)
                .margin({ left: 5 })
                .layoutWeight(1)
                .maxLines(2)
            }
            .width('100%')
            .padding(Space.md - 1)
            .backgroundColor(Color.warningLight)
            .borderRadius(Radius.chip)
            .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
          }

          // 近 7 天告警柱状图
          Column() {
            Row() {
              Text('近 7 天告警趋势')
                .fontSize(FontSize.h3)
                .fontWeight(FontWeight_.bold)
                .fontColor(Color.textPrimary)
              Blank()
              Text(`近7天 ${this.total7()} 次 · 今日 ${this.todayCount()} 次`)
                .fontSize(FontSize.caption - 0.5)
                .fontColor(Color.textTertiary)
            }
            .width('100%')

            Row() {
              ForEach(this.days(), (w: DayStat) => {
                Column() {
                  Text(`${w.count}`)
                    .fontSize(FontSize.mini)
                    .fontWeight(FontWeight_.bold)
                    .fontColor(Color.textSecondary)
                    .margin({ bottom: Space.xs })
                  Column()
                    .width(22)
                    .height(Math.max(4, (w.count / this.maxCount()) * 78))
                    .borderRadius(7)
                    .linearGradient(w.count === 0
                      ? { angle: 180, colors: [['#E6EDF5', 0.0], ['#E6EDF5', 1.0]] }
                      : Grad.barWarning())
                  Text(w.label)
                    .fontSize(FontSize.mini)
                    .fontColor(Color.textTertiary)
                    .margin({ top: Space.xs + 1 })
                }
                .layoutWeight(1)
                .height(118)
                .justifyContent(FlexAlign.End)
              }, (w: DayStat) => w.key)
            }
            .width('100%')
            .margin({ top: 10 })

            if (this.alerts.length === 0) {
              Text(this.hasData() ? '近 7 天暂无告警记录' : '暂无告警数据，请先刷新')
                .fontSize(FontSize.caption)
                .fontColor(Color.textTertiary)
                .margin({ top: Space.sm })
            }
          }
          .padding(Space.lg - 2)
          .backgroundColor(Color.card)
          .borderRadius(Radius.card)
          .shadow(Shadow_.card())
          .alignItems(HorizontalAlign.Start)
          .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

          // 无数据源模块：明确暂无数据 / 未开放
          Column() {
            Row() {
              SymbolGlyph($r('sys.symbol.info_circle'))
                .fontSize(15)
                .fontColor([Color.textTertiary])
              Text('暂无数据源的功能')
                .fontSize(FontSize.h3)
                .fontWeight(FontWeight_.bold)
                .fontColor(Color.textPrimary)
                .margin({ left: 6 })
            }
            .width('100%')

            Text('活动分布、睡眠时长、AI 洞察：后端未提供对应接口，暂无数据。')
              .fontSize(FontSize.body - 1)
              .fontColor(Color.textSecondary)
              .lineHeight(17)
              .margin({ top: Space.sm })
              .width('100%')
            Text('报告导出：本轮未开放。')
              .fontSize(FontSize.body - 1)
              .fontColor(Color.textSecondary)
              .lineHeight(17)
              .margin({ top: 3 })
              .width('100%')
          }
          .padding(Space.lg - 2)
          .backgroundColor('#F1F5F9')
          .borderRadius(Radius.card)
          .alignItems(HorizontalAlign.Start)
          .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

          if (!this.hasData() && this.alerts.length === 0) {
            EmptyState({
              icon: $r('sys.symbol.doc_text'),
              title: this.netWarn() ? '暂无统计数据' : '正在获取统计数据',
              description: this.netMessage.length > 0 ? this.netMessage : '登录并刷新后展示真实告警统计'
            })
          }

          Column().height(Space.xxl)
        }
        .width('100%')
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
