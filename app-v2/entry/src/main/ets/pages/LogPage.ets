/**
 * 记录页 —— 两个真实数据来源，互不冒充：
 * 1) 告警记录：真实 gv.alerts 按本地日期分组（沿用原有行为，正式模式不引入演示数据）；
 * 2) 安全日志：GET /api/v1/safety-logs 持久化台账（处置结果历史），不是由当前 alerts 推导；
 *    加载失败显示真实错误并保留空态，绝不回退演示数据。演示模式下不查询真实接口。
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { DemoModeBar } from '../components/DemoModeBar';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { AlertView, DispositionView, RunMode } from '../core/view/Models';
import { alertTypeLabel } from '../core/view/ViewMapper';
import { SafetyLogsOutcome } from '../core/service/Outcomes';
import { GuardianService } from '../service/GuardianService';

class DayGroup {
  date: string = '';
  items: AlertView[] = [];
}

class SafetyDayGroup {
  date: string = '';
  items: DispositionView[] = [];
}

class LogTab {
  static readonly ALERTS: string = 'alerts';
  static readonly SAFETY: string = 'safety';
}

@Entry
@Component
struct LogPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.netStatus') netStatus: string = 'unknown';
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;
  @StorageLink('gv.mode') @Watch('onModeChanged') mode: string = RunMode.NONE;
  @State filterKeyword: string = '';
  @State tab: string = LogTab.ALERTS;
  @State safetyItems: DispositionView[] = [];
  @State safetyLoading: boolean = false;
  @State safetyMessage: string = '';
  @State safetyLoaded: boolean = false;
  @State safetyLoadedAt: number = 0;
  private safetyRequestId: number = 0;

  aboutToDisappear() {
    // 页面销毁：丢弃迟到的安全日志响应，不写已销毁页面。
    this.safetyRequestId += 1;
  }

  private onModeChanged(): void {
    if (this.tab === LogTab.SAFETY && this.mode !== RunMode.DEMO &&
      !this.safetyLoaded && !this.safetyLoading) {
      this.loadSafetyLogs();
    }
  }

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

  private safetyGroups(): SafetyDayGroup[] {
    const out: SafetyDayGroup[] = [];
    for (let i = 0; i < this.safetyItems.length; i++) {
      const item: DispositionView = this.safetyItems[i];
      // serverTime 无效（缺失/0）的条目绝不按 1970 分组，单独归入“时间未知”。
      const key: string = item.hasValidServerTime
        ? DateUtil.formatDate(item.serverTime) : '时间未知';
      let group: SafetyDayGroup | null = null;
      for (let j = 0; j < out.length; j++) {
        if (out[j].date === key) {
          group = out[j];
          break;
        }
      }
      if (group === null) {
        const created = new SafetyDayGroup();
        created.date = key;
        out.push(created);
        group = created;
      }
      group.items.push(item);
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

  private selectTab(next: string): void {
    this.tab = next;
    if (next !== LogTab.SAFETY) return;
    if (this.mode === RunMode.DEMO) return;
    if (!this.safetyLoaded && !this.safetyLoading) {
      this.loadSafetyLogs();
    }
  }

  /** 安全日志（真实接口）。失败显示真实错误；不回退演示数据，不伪造成功。 */
  private loadSafetyLogs(): void {
    if (this.mode === RunMode.DEMO) return;
    this.safetyRequestId += 1;
    const requestId: number = this.safetyRequestId;
    this.safetyLoading = true;
    this.safetyMessage = '';
    GuardianService.loadSafetyLogs(50).then((result: SafetyLogsOutcome) => {
      if (requestId !== this.safetyRequestId) return;
      this.safetyLoading = false;
      if (result.stale) return;
      if (!result.ok) {
        this.safetyMessage = result.message.length > 0
          ? result.message : '安全日志加载失败，请稍后重试';
        return;
      }
      this.safetyItems = result.items;
      this.safetyLoaded = true;
      this.safetyLoadedAt = result.loadedAt;
    });
  }

  private safetyTimeText(item: DispositionView): string {
    return item.hasValidServerTime
      ? DateUtil.formatDateTime(item.serverTime) : '服务端时间未知';
  }

  @Builder
  tabBar() {
    Row() {
      Text('告警记录')
        .fontSize(FontSize.body + 0.5)
        .fontWeight(this.tab === LogTab.ALERTS ? FontWeight_.bold : FontWeight_.regular)
        .fontColor(this.tab === LogTab.ALERTS ? '#FFFFFF' : Color.textSecondary)
        .textAlign(TextAlign.Center)
        .height(34)
        .layoutWeight(1)
        .borderRadius(Radius.button)
        .backgroundColor(this.tab === LogTab.ALERTS ? Color.primaryDark : 'rgba(0,0,0,0)')
        .onClick(() => { this.selectTab(LogTab.ALERTS); })
      Text('安全日志')
        .fontSize(FontSize.body + 0.5)
        .fontWeight(this.tab === LogTab.SAFETY ? FontWeight_.bold : FontWeight_.regular)
        .fontColor(this.tab === LogTab.SAFETY ? '#FFFFFF' : Color.textSecondary)
        .textAlign(TextAlign.Center)
        .height(34)
        .layoutWeight(1)
        .borderRadius(Radius.button)
        .backgroundColor(this.tab === LogTab.SAFETY ? Color.primaryDark : 'rgba(0,0,0,0)')
        .onClick(() => { this.selectTab(LogTab.SAFETY); })
    }
    .width('100%')
    .padding(4)
    .backgroundColor(Color.card)
    .borderRadius(Radius.button)
    .border({ width: 1, color: Color.border })
    .margin({ left: this.pm(), right: this.pm(), top: 10 })
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
          Text(DateUtil.formatDateTime(a.createdAt))
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

  /** 安全日志行：告警 / 房间 / 处理时间 / 处理人 / 结果 / 说明，点击回对应告警详情。 */
  @Builder
  safetyRow(item: DispositionView, isLast: boolean) {
    Row() {
      Column() {
        Column()
          .width(9)
          .height(9)
          .borderRadius(4.5)
          .linearGradient(Grad.accent())
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
          Text(item.alarmTypeLabel)
            .fontSize(FontSize.body)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textPrimary)
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.safetyTimeText(item))
            .fontSize(FontSize.caption - 0.5)
            .fontColor(item.hasValidServerTime ? Color.textTertiary : Color.warningDark)
        }
        .width('100%')

        Row() {
          Text(item.outcomeLabel)
            .fontSize(FontSize.mini - 0.5)
            .fontWeight(FontWeight_.semibold)
            .fontColor(Color.primaryDark)
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
            .backgroundColor(Color.primaryLight)
            .borderRadius(Radius.pill)
          Text(`处理人：${item.operatorText}`)
            .fontSize(FontSize.mini - 0.5)
            .fontColor(Color.textSecondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
            .margin({ left: 6 })
        }
        .width('100%')
        .margin({ top: 5 })

        Text(`${item.roomText} · 设备 ${item.deviceId.length > 0 ? item.deviceId : '未知'}`)
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textSecondary)
          .margin({ top: Space.xs })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })

        if (item.note.length > 0) {
          Text(`说明：${item.note}`)
            .fontSize(FontSize.caption - 0.5)
            .fontColor(Color.textTertiary)
            .margin({ top: 2 })
            .maxLines(3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .layoutWeight(1)
      .padding({ left: 9, bottom: Space.md })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .onClick(() => {
      if (item.alarmId.length === 0) return;
      this.getUIContext().getRouter().pushUrl({
        url: 'pages/AlertDetailPage',
        params: { alertId: item.alarmId }
      });
    })
  }

  @Builder
  alertsView() {
    Column() {
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
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  safetyView() {
    Column() {
      Row() {
      Text(this.mode === RunMode.DEMO
        ? '演示模式'
        : `共 ${this.safetyItems.length} 条真实安全日志`)
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
      Blank()
      if (this.mode !== RunMode.DEMO) {
        Text(this.safetyLoading ? '加载中…'
          : (this.safetyLoadedAt > 0 ? `更新 ${DateUtil.formatTime(this.safetyLoadedAt)}` : '尚未加载'))
          .fontSize(FontSize.caption)
          .fontColor(Color.textTertiary)
        Text('刷新')
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.primaryDark)
          .padding({ left: 10, right: 2, top: 2, bottom: 2 })
          .onClick(() => { this.loadSafetyLogs(); })
      }
    }
    .width('100%')
    .padding({ left: this.pm() + 2, right: this.pm() + 2, top: 10, bottom: 6 })

    if (this.safetyMessage.length > 0) {
      Row() {
        SymbolGlyph($r('sys.symbol.exclamationmark_circle'))
          .fontSize(12)
          .fontColor([Color.warningDark])
        Text(this.safetyMessage)
          .fontSize(FontSize.caption)
          .fontColor(Color.warningDark)
          .margin({ left: 5 })
          .layoutWeight(1)
          .maxLines(2)
        Text('重试')
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.warningDark)
          .padding({ left: 8 })
          .onClick(() => { this.loadSafetyLogs(); })
      }
      .width('100%')
      .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
      .backgroundColor(Color.warningLight)
      .borderRadius(Radius.chip)
      .margin({ left: this.pm(), right: this.pm(), bottom: Space.sm })
    }

    if (this.mode === RunMode.DEMO) {
      EmptyState({
        icon: $r('sys.symbol.doc_text'),
        title: '演示模式不查询真实安全日志',
        description: '安全日志来自服务端持久化台账；退出演示并使用真实账号后查看'
      })
    } else if (this.safetyLoading && this.safetyItems.length === 0) {
      Column() {
        LoadingProgress()
          .width(28)
          .height(28)
          .color(Color.primary)
        Text('正在加载安全日志…')
          .fontSize(FontSize.caption)
          .fontColor(Color.textSecondary)
          .margin({ top: Space.md })
      }
      .width('100%')
      .padding({ top: 80 })
      .alignItems(HorizontalAlign.Center)
    } else if (this.safetyItems.length === 0) {
      EmptyState({
        icon: $r('sys.symbol.doc_text'),
        title: this.safetyMessage.length > 0 ? '安全日志加载失败' : '暂无安全日志',
        description: this.safetyMessage.length > 0
          ? this.safetyMessage
          : '处置结果保存后会出现在这里（来自服务端持久化台账）'
      })
    } else {
      List({ space: Space.md - 2 }) {
        ForEach(this.safetyGroups(), (g: SafetyDayGroup) => {
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
                ForEach(g.items, (item: DispositionView, idx: number) => {
                  this.safetyRow(item, idx === g.items.length - 1)
                }, (item: DispositionView) => `${item.dispositionId}_${item.serverTime}`)
              }
              .padding(Space.md + 1)
              .backgroundColor(Color.card)
              .borderRadius(Radius.tile)
              .shadow(Shadow_.card())
              .margin({ left: this.pm(), right: this.pm() })
            }
            .width('100%')
          }
        }, (g: SafetyDayGroup) => g.date)
      }
      .width('100%')
      .layoutWeight(1)
      .padding({ top: 2, bottom: Space.xxl })
      .scrollBar(BarState.Off)
    }
    }
    .width('100%')
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Column() {
      NavBar({ title: '记录与日志', showBack: true })
      DemoModeBar()
      this.tabBar()

      if (this.tab === LogTab.ALERTS) {
        this.alertsView()
      } else {
        this.safetyView()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
