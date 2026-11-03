/**
 * 数据统计页（v2 视觉，接真实数据）
 * - 数据来源：gv.alerts（真实告警）、gv.devices（在线数）
 * - 不引入 MockData；无活动/睡眠/报告导出等无数据源指标
 * - 24 小时分布、近 7 天趋势、摘要文本均由真实告警推导
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { AlertView, DeviceView, RunMode } from '../core/view/Models';

type RangeKey = 'day' | 'week' | 'month';

interface RangeItem {
  k: RangeKey;
  label: string;
}

class DayStat {
  label: string = '';
  count: number = 0;
}

@Entry
@Component
struct StatsPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.devices') devices: DeviceView[] = [];
  @StorageLink('gv.netStatus') netStatus: string = 'unknown';
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @State range: RangeKey = 'week';

  private ranges: RangeItem[] = [
    { k: 'day', label: '今日' },
    { k: 'week', label: '本周' },
    { k: 'month', label: '本月' }
  ];

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private rangeLabel(): string {
    if (this.range === 'day') return '今日';
    if (this.range === 'week') return '近 7 天';
    return '近 30 天';
  }

  private rangeStart(): number {
    const now: number = Date.now();
    if (this.range === 'day') {
      const d: Date = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    const days: number = this.range === 'week' ? 7 : 30;
    return now - days * 24 * 3600 * 1000;
  }

  private hourly(): number[] {
    const out: number[] = [];
    for (let i = 0; i < 24; i++) {
      out.push(0);
    }
    const start: number = this.rangeStart();
    for (let i = 0; i < this.alerts.length; i++) {
      const ts: number = this.alerts[i].createdAt;
      if (ts >= start) {
        const h: number = new Date(ts).getHours();
        out[h] = out[h] + 1;
      }
    }
    return out;
  }

  private maxHourly(): number {
    const list: number[] = this.hourly();
    let max: number = 1;
    for (let i = 0; i < list.length; i++) {
      if (list[i] > max) max = list[i];
    }
    return max;
  }

  private days(): DayStat[] {
    const out: DayStat[] = [];
    const base: number = Date.now();
    for (let i = 6; i >= 0; i--) {
      const d: Date = new Date(base);
      d.setDate(d.getDate() - i);
      const item = new DayStat();
      item.label = `${d.getMonth() + 1}/${d.getDate()}`;
      item.count = 0;
      out.push(item);
    }
    for (let i = 0; i < this.alerts.length; i++) {
      const created: Date = new Date(this.alerts[i].createdAt);
      const label: string = `${created.getMonth() + 1}/${created.getDate()}`;
      for (let j = 0; j < out.length; j++) {
        if (out[j].label === label) {
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
    for (let i = 0; i < list.length; i++) sum = sum + list[i].count;
    return sum;
  }

  private maxWeekly(): number {
    const list: DayStat[] = this.days();
    let max: number = 1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].count > max) max = list[i].count;
    }
    return max;
  }

  private todayCount(): number {
    const today: string = DateUtil.formatDate(Date.now());
    let count: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (DateUtil.formatDate(this.alerts[i].createdAt) === today) count++;
    }
    return count;
  }

  private yesterdayCount(): number {
    const y: string = DateUtil.formatDate(Date.now() - 24 * 3600 * 1000);
    let count: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (DateUtil.formatDate(this.alerts[i].createdAt) === y) count++;
    }
    return count;
  }

  private pendingCount(): number {
    let count: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (this.alerts[i].statusKey === 'pending') count++;
    }
    return count;
  }

  private waitingCount(): number {
    let count: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (this.alerts[i].statusKey === 'waiting') count++;
    }
    return count;
  }

  private onlineCount(): number {
    let count: number = 0;
    for (let i = 0; i < this.devices.length; i++) {
      if (this.devices[i].online) count++;
    }
    return count;
  }

  private topType(): string {
    const types: string[] = [];
    const counts: number[] = [];
    for (let i = 0; i < this.alerts.length; i++) {
      const t: string = this.alerts[i].title.length > 0 ? this.alerts[i].title : this.alerts[i].type;
      let found: number = -1;
      for (let j = 0; j < types.length; j++) {
        if (types[j] === t) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        counts[found] = counts[found] + 1;
      } else {
        types.push(t);
        counts.push(1);
      }
    }
    let best: number = -1;
    let bestCount: number = 0;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > bestCount) {
        bestCount = counts[i];
        best = i;
      }
    }
    if (best < 0) return '暂无';
    return `${types[best]}（${bestCount} 条）`;
  }

  private hasData(): boolean {
    return this.lastUpdatedAt > 0;
  }

  private netWarn(): boolean {
    return this.netStatus !== 'ok' && this.netStatus !== 'loading';
  }

  private netFatal(): boolean {
    return this.netStatus === 'error' || this.netStatus === 'unauthorized';
  }

  private pad(n: number): string {
    return n < 10 ? '0' + n : '' + n;
  }

  private hourGrad(hour: number, v: number): LinearGradientOptions {
    if (v === 0) {
      return { angle: 180, colors: [['#E6EDF5', 0.0], ['#E6EDF5', 1.0]] };
    }
    if (hour < 6) return Grad.barNight();
    if (hour < 20) return Grad.barPrimary();
    return Grad.barEvening();
  }

  private dayDeltaText(): string {
    const diff: number = this.todayCount() - this.yesterdayCount();
    if (diff > 0) return `较昨日 +${diff}`;
    if (diff < 0) return `较昨日 ${diff}`;
    return '与昨日持平';
  }

  @Builder
  kpiCard(value: string, label: string, note: string, valueColor: string) {
    Stack({ alignContent: Alignment.TopEnd }) {
      Column()
        .width(52)
        .height(52)
        .borderRadius(26)
        .backgroundColor(valueColor)
        .opacity(0.10)
        .margin({ top: -14, right: -14 })
      Column() {
        Text(value)
          .fontSize(20)
          .fontWeight(FontWeight_.extrabold)
          .fontColor(valueColor)
        Text(label)
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textSecondary)
          .margin({ top: 2 })
        Text(note)
          .fontSize(FontSize.mini - 0.5)
          .fontColor(Color.textTertiary)
          .margin({ top: 5 })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .layoutWeight(1)
    .padding(Space.md)
    .backgroundColor(Color.card)
    .borderRadius(Radius.tile)
    .shadow(Shadow_.card())
    .clip(true)
  }

  build() {
    Column() {
      NavBar({
        title: '数据统计', showBack: true, rightText: '报告',
        onRight: () => {
          this.getUIContext().getRouter().pushUrl({ url: 'pages/ActivityReportPage' });
        }
      })

      Scroll() {
        Column() {
          if (this.netWarn() && this.netMessage.length > 0) {
            Row() {
              SymbolGlyph($r('sys.symbol.info_circle'))
                .fontSize(13)
                .fontColor([this.netFatal() ? Color.criticalDark : Color.warningDark])
              Text(this.netMessage)
                .fontSize(FontSize.caption)
                .fontColor(this.netFatal() ? Color.criticalDark : Color.warningDark)
                .lineHeight(15)
                .margin({ left: 5 })
                .layoutWeight(1)
                .maxLines(2)
            }
            .width('100%')
            .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
            .backgroundColor(this.netFatal() ? Color.criticalLight : Color.warningLight)
            .borderRadius(Radius.chip)
            .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
          }

          // 分段控件
          Row() {
            ForEach(this.ranges, (item: RangeItem) => {
              Text(item.label)
                .fontSize(FontSize.body - 1)
                .fontWeight(this.range === item.k ? FontWeight_.bold : FontWeight_.semibold)
                .fontColor(this.range === item.k ? Color.primaryDark : Color.textSecondary)
                .padding({ top: 7, bottom: 7 })
                .layoutWeight(1)
                .textAlign(TextAlign.Center)
                .borderRadius(9)
                .backgroundColor(this.range === item.k ? '#FFFFFF' : 'rgba(0,0,0,0)')
                .onClick(() => { this.range = item.k; })
            }, (item: RangeItem) => item.k)
          }
          .width('100%')
          .backgroundColor(Color.track)
          .borderRadius(Radius.chip)
          .padding(3)
          .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2, bottom: Space.md - 2 })

          if (!this.hasData()) {
            Column() {
              EmptyState({
                icon: $r('sys.symbol.waveform'),
                title: '暂无统计数据',
                description: '尚未获取到告警/设备数据，请回首页下拉刷新或稍后再试'
              })
            }
            .width('100%')
            .layoutWeight(1)
            .justifyContent(FlexAlign.Center)
            .padding({ top: Space.xl })
          } else {
            // KPI
            Row({ space: 9 }) {
              this.kpiCard(`${this.todayCount()}`, '今日预警', this.dayDeltaText(), Color.primaryDark)
              this.kpiCard(`${this.total7()}`, '近 7 天预警', `待确认 ${this.pendingCount()} 条`, Color.warningDark)
              this.kpiCard(`${this.onlineCount()}/${this.devices.length}`, '设备在线', `等待确认 ${this.waitingCount()} 条`, Color.successDark)
            }
            .width('100%')
            .padding({ left: this.pm(), right: this.pm() })

            // 24 小时分布
            Column() {
              Row() {
                Text(`${this.rangeLabel()} 24 小时预警分布`)
                  .fontSize(FontSize.h3)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(Color.textPrimary)
                Blank()
                Text('按小时聚合')
                  .fontSize(FontSize.caption - 0.5)
                  .fontColor(Color.textTertiary)
              }
              .width('100%')

              Stack({ alignContent: Alignment.Bottom }) {
                Row() {
                  ForEach(this.hourly(), (v: number, i: number) => {
                    Column() {
                      Column()
                        .width('100%')
                        .height(Math.max(2, (v / this.maxHourly()) * 108))
                        .borderRadius({ topLeft: 4, topRight: 4, bottomLeft: 2, bottomRight: 2 })
                        .linearGradient(this.hourGrad(i, v))
                    }
                    .layoutWeight(1)
                    .height(112)
                    .justifyContent(FlexAlign.End)
                    .padding({ left: 1.5, right: 1.5 })
                  }, (v: number, i: number) => `h_${i}_${v}`)
                }
                .width('100%')
                .height(112)
                .alignItems(VerticalAlign.Bottom)
              }
              .width('100%')
              .height(112)
              .margin({ top: Space.md - 2 })

              Row() {
                ForEach([0, 4, 8, 12, 16, 20, 23], (h: number) => {
                  Text(`${this.pad(h)}:00`)
                    .fontSize(FontSize.mini - 1)
                    .fontColor(Color.textTertiary)
                    .layoutWeight(1)
                    .textAlign(h === 23 ? TextAlign.End : TextAlign.Start)
                }, (h: number) => `x_${h}`)
              }
              .width('100%')
              .margin({ top: 5 })
            }
            .padding(Space.lg - 2)
            .backgroundColor(Color.card)
            .borderRadius(Radius.card)
            .shadow(Shadow_.card())
            .alignItems(HorizontalAlign.Start)
            .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

            // 近 7 天趋势
            Column() {
              Row() {
                Text('近 7 天预警趋势')
                  .fontSize(FontSize.h3)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(Color.textPrimary)
                Blank()
                Text(`共 ${this.total7()} 次`)
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
                      .height(Math.max(4, (w.count / this.maxWeekly()) * 78))
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
                }, (w: DayStat) => `d_${w.label}`)
              }
              .width('100%')
              .margin({ top: 10 })
            }
            .padding(Space.lg - 2)
            .backgroundColor(Color.card)
            .borderRadius(Radius.card)
            .shadow(Shadow_.card())
            .alignItems(HorizontalAlign.Start)
            .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

            // 数据摘要（真实推导，不做 AI 编造）
            Column() {
              Row() {
                SymbolGlyph($r('sys.symbol.waveform'))
                  .fontSize(15)
                  .fontColor([Color.accentDark])
                Text('数据摘要')
                  .fontSize(FontSize.h3)
                  .fontWeight(FontWeight_.extrabold)
                  .fontColor(Color.textPrimary)
                  .margin({ left: 6 })
              }
              .width('100%')

              Column({ space: 4 }) {
                Text(`近 7 天共 ${this.total7()} 条预警，其中待确认 ${this.pendingCount()} 条、等待设备确认 ${this.waitingCount()} 条。`)
                  .fontSize(FontSize.body - 1)
                  .fontColor(Color.textPrimary)
                  .lineHeight(18)
                  .width('100%')
                  .padding({ left: 14 })
                Text(`预警最多的类型：${this.topType()}。`)
                  .fontSize(FontSize.body - 1)
                  .fontColor(Color.textPrimary)
                  .lineHeight(18)
                  .width('100%')
                  .padding({ left: 14 })
                Text(`数据来源：${this.mode === RunMode.DEMO ? '本地演示数据' : 'gv.alerts 实时同步'}；无活动/睡眠数据时不做展示。`)
                  .fontSize(FontSize.caption)
                  .fontColor(Color.textSecondary)
                  .lineHeight(16)
                  .width('100%')
                  .padding({ left: 14 })
              }
              .width('100%')
              .margin({ top: 9 })
            }
            .padding(Space.lg - 2)
            .borderRadius(Radius.card)
            .linearGradient(Grad.heroAccent())
            .shadow({ radius: 14, color: 'rgba(234,88,12,0.12)', offsetX: 0, offsetY: 4 })
            .alignItems(HorizontalAlign.Start)
            .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2, bottom: Space.xxl })
          }
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
