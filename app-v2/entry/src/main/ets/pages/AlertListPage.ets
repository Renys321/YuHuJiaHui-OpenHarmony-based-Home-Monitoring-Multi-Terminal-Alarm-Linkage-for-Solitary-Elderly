/**
 * 预警中心
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { AlertItem } from '../components/AlertItem';
import { ElderSafeNotice } from '../components/ElderSafeNotice';
import { EmptyState } from '../components/EmptyState';
import { AlertEvent, AlertStatus } from '../model/AlertEvent';
import { ElderSafeEventView, ElderSafeLoadState } from '../core/view/Models';
import { ElderSafeLogic } from '../common/ElderSafeLogic';

type TabKey = 'pending' | 'processing' | 'closed' | 'false_alarm' | 'all';

interface TabItem {
  key: TabKey;
  label: string;
}

@Component
export struct AlertListPage {
  @StorageLink('alerts') alerts: AlertEvent[] = [];
  @StorageLink('gv.elderSafeEvents') elderSafeEvents: ElderSafeEventView[] = [];
  @StorageLink('gv.elderSafeStatus') elderSafeStatus: string = ElderSafeLoadState.IDLE;
  @StorageLink('gv.elderSafeMessage') elderSafeMessage: string = '';
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @State activeTab: TabKey = 'pending';

  private tabs: TabItem[] = [
    { key: 'pending', label: '待处置' },
    { key: 'processing', label: '处置中' },
    { key: 'closed', label: '已归档' },
    { key: 'false_alarm', label: '误报' },
    { key: 'all', label: '全部' }
  ];

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private filtered(): AlertEvent[] {
    const list = this.activeTab === 'all'
      ? this.alerts
      : this.alerts.filter(a => a.status === (this.activeTab as AlertStatus));
    return list.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  private countOf(k: TabKey): number {
    if (k === 'all') return this.alerts.length;
    return this.alerts.filter(a => a.status === (k as AlertStatus)).length;
  }

  /** 自述安全只做展示与跳转，绝不在这里 ACK 原告警。 */
  private openElderSafe(event: ElderSafeEventView): void {
    if (event.alarmId.length === 0) {
      this.getUIContext().getPromptAction().showToast({ message: '该记录无关联预警，原告警仍需您确认' });
      return;
    }
    this.getUIContext().getRouter().pushUrl({
      url: 'pages/AlertDetailPage',
      params: { alertId: event.alarmId }
    });
  }

  build() {
    Column() {
      Row() {
        Column() {
          Text('预警中心')
            .fontSize(FontSize.h1)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(Color.textPrimary)
          Text('确认预警 · 填写处置结果 · 形成安全日志')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Column() {
          SymbolGlyph($r('sys.symbol.magnifyingglass'))
            .fontSize(19)
            .fontColor([Color.textSecondary])
        }
        .width(36)
        .height(36)
        .borderRadius(12)
        .backgroundColor(Color.card)
        .justifyContent(FlexAlign.Center)
        .shadow({ radius: 12, color: 'rgba(15,23,42,0.06)', offsetX: 0, offsetY: 2 })
      }
      .width('100%')
      .padding({
        left: this.pm() + 2, right: this.pm() + 2,
        top: Space.md, bottom: Space.md - 2
      })

      // 老人自述安全（只记录、不 ACK；与原告警并列展示）
      if (ElderSafeLogic.visible(this.elderSafeEvents, this.alerts).length > 0) {
        Column({ space: 8 }) {
          ForEach(ElderSafeLogic.visible(this.elderSafeEvents, this.alerts).slice(0, 3), (e: ElderSafeEventView) => {
            ElderSafeNotice({
              event: e,
              ackPending: ElderSafeLogic.ackPending(e, this.alerts),
              onPress: () => { this.openElderSafe(e); }
            })
          }, (e: ElderSafeEventView) => e.eventId)
          if (this.elderSafeStatus === ElderSafeLoadState.ERROR && this.elderSafeMessage.length > 0) {
            Text(`${this.elderSafeMessage}（显示上次记录）`)
              .fontSize(FontSize.mini)
              .fontColor(Color.warningDark)
              .width('100%')
          }
        }
        .padding({ left: this.pm(), right: this.pm() })
        .margin({ bottom: Space.sm })
      } else if (this.elderSafeStatus === ElderSafeLoadState.ERROR) {
        Column() {
          Text('老人自述安全加载失败')
            .fontSize(FontSize.caption)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.criticalDark)
          Text(this.elderSafeMessage)
            .fontSize(FontSize.mini)
            .fontColor(Color.textSecondary)
            .margin({ top: 4 })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding(Space.md)
        .backgroundColor('#FFF4F4')
        .borderRadius(Radius.card)
        .margin({ left: this.pm(), right: this.pm(), bottom: Space.sm })
      }

      Scroll() {
        Row({ space: 7 }) {
          ForEach(this.tabs, (t: TabItem) => {
            Row() {
              Text(t.label)
                .fontSize(FontSize.body - 1)
                .fontWeight(this.activeTab === t.key ? FontWeight_.bold : FontWeight_.regular)
                .fontColor(this.activeTab === t.key ? '#FFFFFF' : Color.textSecondary)
              Text(`${this.countOf(t.key)}`)
                .fontSize(8.5)
                .fontWeight(FontWeight_.extrabold)
                .fontColor(this.activeTab === t.key ? '#FFFFFF' : Color.textTertiary)
                .padding({ left: 5, right: 5, top: 1, bottom: 1 })
                .borderRadius(Radius.pill)
                .backgroundColor(this.activeTab === t.key ? 'rgba(255,255,255,0.25)' : '#F1F5F9')
                .margin({ left: 5 })
            }
            .padding({ left: 12, right: 12, top: 6, bottom: 6 })
            .borderRadius(Radius.pill)
            .linearGradient(this.activeTab === t.key
              ? Grad.primary()
              : { angle: 135, colors: [[Color.card, 0.0], [Color.card, 1.0]] })
            .border({
              width: 1,
              color: this.activeTab === t.key ? 'rgba(0,0,0,0)' : Color.border
            })
            .shadow(this.activeTab === t.key
              ? { radius: 12, color: 'rgba(2,132,199,0.35)', offsetX: 0, offsetY: 4 }
              : { radius: 0, color: 'rgba(0,0,0,0)', offsetX: 0, offsetY: 0 })
            .onClick(() => { this.activeTab = t.key; })
          }, (t: TabItem) => t.key)
        }
        .padding({ left: this.pm(), right: this.pm() })
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')

      if (this.filtered().length === 0) {
        EmptyState({
          icon: $r('sys.symbol.checkmark_circle'),
          title: '暂无相关预警',
          description: this.activeTab === 'pending'
            ? '当前无待处置预警，老人一切安好'
            : '暂无记录',
          iconColor: Color.success
        })
      } else {
        List({ space: 10 }) {
          ForEach(this.filtered(), (a: AlertEvent) => {
            ListItem() {
              AlertItem({
                alert: a,
                onPress: (item: AlertEvent) => {
                  this.getUIContext().getRouter().pushUrl({
                    url: 'pages/AlertDetailPage',
                    params: { alertId: item.id }
                  });
                }
              })
            }
          }, (a: AlertEvent) => a.id)
        }
        .width('100%')
        .layoutWeight(1)
        .padding({
          left: this.pm(), right: this.pm(),
          top: Space.md - 2, bottom: Space.xxl
        })
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
