/**
 * 安全日志页 —— 真实 gv.alerts 按本地日期分组，正式模式不引入任何演示数据
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { DemoModeBar } from '../components/DemoModeBar';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { AlertView, RunMode } from '../core/view/Models';

class DayGroup {
  date: string = '';
  items: AlertView[] = [];
}

@Entry
@Component
struct LogPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.netStatus') netStatus: string = 'unknown';
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @State filterKeyword: string = '';

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private match(a: AlertView, keyword: string): boolean {
    const key: string = keyword.toLowerCase();
    if (a.title.toLowerCase().includes(key)) return true;
    if (a.description.toLowerCase().includes(key)) return true;
    if (a.roomName.toLowerCase().includes(key)) return true;
    if (a.type.toLowerCase().includes(key)) return true;
    if (a.statusText.toLowerCase().includes(key)) return true;
    if (a.location.toLowerCase().includes(key)) return true;
    if (a.alarmId.toLowerCase().includes(key)) return true;
    return false;
  }

  private groups(): DayGroup[] {
    const keyword: string = this.filterKeyword.trim();
    const filtered: AlertView[] = [];
    for (let i = 0; i < this.alerts.length; i++) {
      if (keyword.length === 0 || this.match(this.alerts[i], keyword)) {
        filtered.push(this.alerts[i]);
      }
    }
    filtered.sort((a: AlertView, b: AlertView) => b.createdAt - a.createdAt);

    const out: DayGroup[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const alert: AlertView = filtered[i];
      const key: string = DateUtil.formatDate(alert.createdAt);
      let group: DayGroup | null = null;
      for (let j = 0; j < out.length; j++) {
        if (out[j].date === key) {
          group = out[j];
          break;
        }
      }
      if (group === null) {
        const created = new DayGroup();
        created.date = key;
        out.push(created);
        group = created;
      }
      group.items.push(alert);
    }
    return out;
  }

  private levelLabel(level: string): string {
    if (level === 'critical') return '紧急';
    if (level === 'high') return '高危';
    if (level === 'medium') return '中等';
    return '提示';
  }

  private levelColor(level: string): string {
    if (level === 'critical') return Color.criticalDark;
    if (level === 'high') return Color.warningDark;
    if (level === 'medium') return Color.primaryDark;
    return Color.textSecondary;
  }

  private levelBg(level: string): string {
    if (level === 'critical') return Color.criticalLight;
    if (level === 'high') return Color.warningLight;
    if (level === 'medium') return Color.primaryLight;
    return '#F1F5F9';
  }

  private statusColor(statusKey: string): string {
    if (statusKey === 'pending') return Color.criticalDark;
    if (statusKey === 'waiting') return Color.warningDark;
    if (statusKey === 'acked') return Color.successDark;
    return Color.textSecondary;
  }

  private statusBg(statusKey: string): string {
    if (statusKey === 'pending') return Color.criticalLight;
    if (statusKey === 'waiting') return Color.warningLight;
    if (statusKey === 'acked') return Color.successLight;
    return '#F1F5F9';
  }

  private netWarn(): boolean {
    return this.netStatus !== 'ok' && this.netStatus !== 'loading';
  }

  @Builder
  alertRow(a: AlertView, isLast: boolean) {
    Row() {
      Column() {
        Column()
          .width(9)
          .height(9)
          .borderRadius(4.5)
          .linearGradient(Grad.level(a.level))
        if (!isLast) {
          Column()
            .width(2)
            .height(20)
            .backgroundColor(Color.border)
            .margin({ top: 4 })
        }
      }
      .width(16)
      .alignItems(HorizontalAlign.Center)

      Column() {
        Row() {
          Text(a.title.length > 0 ? a.title : '告警事件')
            .fontSize(FontSize.body)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textPrimary)
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(DateUtil.formatTime(a.createdAt))
            .fontSize(FontSize.caption - 0.5)
            .fontColor(Color.textTertiary)
        }
        .width('100%')

        Row() {
          Text(this.levelLabel(a.level))
            .fontSize(FontSize.mini - 0.5)
            .fontWeight(FontWeight_.semibold)
            .fontColor(this.levelColor(a.level))
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
            .backgroundColor(this.levelBg(a.level))
            .borderRadius(Radius.pill)
          Text(a.statusText)
            .fontSize(FontSize.mini - 0.5)
            .fontWeight(FontWeight_.semibold)
            .fontColor(this.statusColor(a.statusKey))
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
            .backgroundColor(this.statusBg(a.statusKey))
            .borderRadius(Radius.pill)
            .margin({ left: 5 })
          Blank()
          if (a.statusKey === 'acked' && a.acknowledgedText.length > 0) {
            Text(a.acknowledgedText)
              .fontSize(FontSize.mini - 0.5)
              .fontColor(Color.successDark)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
        }
        .width('100%')
        .margin({ top: 5 })

        Text(`${a.roomName.length > 0 ? a.roomName : '房间未知'} · ${a.type.length > 0 ? a.type : '类型未知'}`)
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textSecondary)
          .margin({ top: Space.xs })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .padding({ left: 9, bottom: Space.md })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .onClick(() => {
      this.getUIContext().getRouter().pushUrl({
        url: 'pages/AlertDetailPage',
        params: { alertId: a.alarmId }
      });
    })
  }

  build() {
    Column() {
      NavBar({ title: '安全日志', showBack: true })
      DemoModeBar()

      Row() {
        SymbolGlyph($r('sys.symbol.magnifyingglass'))
          .fontSize(14)
          .fontColor([Color.textTertiary])
          .margin({ right: Space.sm })
        TextInput({ placeholder: '搜索告警标题 / 房间 / 类型', text: this.filterKeyword })
          .fontSize(FontSize.body - 0.5)
          .backgroundColor('rgba(0,0,0,0)')
          .layoutWeight(1)
          .onChange((v: string) => { this.filterKeyword = v; })
      }
      .width('100%')
      .height(40)
      .padding({ left: Space.md, right: Space.md })
      .backgroundColor(Color.card)
      .borderRadius(Radius.button)
      .border({ width: 1.5, color: Color.border })
      .margin({ left: this.pm(), right: this.pm(), top: 10, bottom: 6 })

      Row() {
        Text(this.mode === RunMode.DEMO ? `共 ${this.alerts.length} 条示例告警` : `共 ${this.alerts.length} 条真实告警`)
          .fontSize(FontSize.caption)
          .fontColor(Color.textSecondary)
        Blank()
        Text(this.lastUpdatedAt > 0 ? `更新 ${DateUtil.formatTime(this.lastUpdatedAt)}` : '尚未更新')
          .fontSize(FontSize.caption)
          .fontColor(Color.textTertiary)
      }
      .width('100%')
      .padding({ left: this.pm() + 2, right: this.pm() + 2, top: 2, bottom: 6 })

      if (this.netWarn() && this.netMessage.length > 0) {
        Row() {
          SymbolGlyph($r('sys.symbol.info_circle'))
            .fontSize(12)
            .fontColor([Color.warningDark])
          Text(this.netMessage)
            .fontSize(FontSize.caption)
            .fontColor(Color.warningDark)
            .margin({ left: 5 })
            .layoutWeight(1)
            .maxLines(2)
        }
        .width('100%')
        .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
        .backgroundColor(Color.warningLight)
        .borderRadius(Radius.chip)
        .margin({ left: this.pm(), right: this.pm(), bottom: Space.sm })
      }

      if (this.alerts.length === 0) {
        EmptyState({
          icon: $r('sys.symbol.doc_text'),
          title: this.netWarn() ? '暂无告警记录' : '正在获取告警记录',
          description: this.netMessage.length > 0 ? this.netMessage : '登录并刷新后展示真实告警日志'
        })
      } else if (this.groups().length === 0) {
        EmptyState({
          icon: $r('sys.symbol.magnifyingglass'),
          title: '无匹配记录',
          description: '换个关键词试试'
        })
      } else {
        List({ space: Space.md - 2 }) {
          ForEach(this.groups(), (g: DayGroup) => {
            ListItem() {
              Column() {
                Row() {
                  Text(g.date)
                    .fontSize(FontSize.body + 0.5)
                    .fontWeight(FontWeight_.extrabold)
                    .fontColor(Color.textPrimary)
                  Blank()
                  Text(`${g.items.length} 条`)
                    .fontSize(FontSize.caption - 0.5)
                    .fontColor(Color.textTertiary)
                }
                .width('100%')
                .padding({ left: this.pm() + 2, right: this.pm() + 2, bottom: 7 })

                Column() {
                  ForEach(g.items, (a: AlertView, idx: number) => {
                    this.alertRow(a, idx === g.items.length - 1)
                  }, (a: AlertView) => a.alarmId)
                }
                .padding(Space.md + 1)
                .backgroundColor(Color.card)
                .borderRadius(Radius.tile)
                .shadow(Shadow_.card())
                .margin({ left: this.pm(), right: this.pm() })
              }
              .width('100%')
            }
          }, (g: DayGroup) => g.date)
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ top: 2, bottom: Space.xxl })
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
