/**
 * 预警中心 —— 真实 API 告警（gv.alerts），无 Mock 回退。
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { AlertItem } from '../components/AlertItem';
import { EmptyState } from '../components/EmptyState';
import { AlertView, NetworkState, AppKeys } from '../core/view/Models';

type TabKey = 'all' | 'pending' | 'waiting' | 'acked';

interface TabItem {
  key: TabKey;
  label: string;
}

@Component
export struct AlertListPage {
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.netStatus') netStatus: string = NetworkState.UNKNOWN;
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @State activeTab: TabKey = 'pending';

  private tabs: TabItem[] = [
    { key: 'pending', label: '待确认' },
    { key: 'waiting', label: '等待设备确认' },
    { key: 'acked', label: '设备已确认' },
    { key: 'all', label: '全部' }
  ];

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private filtered(): AlertView[] {
    if (this.activeTab === 'all') return this.alerts;
    if (this.activeTab === 'pending') return this.alerts.filter(a => a.statusKey === 'pending');
    if (this.activeTab === 'waiting') return this.alerts.filter(a => a.statusKey === 'waiting');
    return this.alerts.filter(a => a.statusKey === 'acked');
  }

  private countOf(k: TabKey): number {
    if (k === 'all') return this.alerts.length;
    if (k === 'pending') return this.alerts.filter(a => a.statusKey === 'pending').length;
    if (k === 'waiting') return this.alerts.filter(a => a.statusKey === 'waiting').length;
    return this.alerts.filter(a => a.statusKey === 'acked').length;
  }

  private showNetworkBanner(): boolean {
    return this.netStatus !== NetworkState.OK && this.netStatus !== NetworkState.UNKNOWN;
  }

  build() {
    Column() {
      Row() {
        Column() {
          Text('预警中心')
            .fontSize(FontSize.h1)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(Color.textPrimary)
          Text('确认真实告警 · 等待设备回执 · 不伪造归档')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .padding({
        left: this.pm() + 2, right: this.pm() + 2,
        top: Space.md, bottom: Space.md - 2
      })

      if (this.showNetworkBanner()) {
        Row() {
          SymbolGlyph($r('sys.symbol.exclamationmark_triangle_fill'))
            .fontSize(13)
            .fontColor([Color.warningDark])
          Text(this.netMessage.length > 0 ? this.netMessage : '网络状态异常，显示上次数据')
            .fontSize(FontSize.caption)
            .fontColor(Color.warningDark)
            .margin({ left: 5 })
            .layoutWeight(1)
            .maxLines(2)
        }
        .width('100%')
        .padding(Space.sm + 1)
        .backgroundColor(Color.warningLight)
        .borderRadius(Radius.chip)
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
          title: this.alerts.length === 0 ? '暂无告警数据' : '该分类下暂无告警',
          description: this.alerts.length === 0
            ? (this.netStatus === NetworkState.OK
              ? '服务端当前未返回告警；出现新告警后会显示在这里'
              : '尚未获取到告警数据，请检查网络后刷新')
            : '切换分类查看其他真实告警',
          iconColor: this.alerts.length === 0 ? Color.textTertiary : Color.success
        })
      } else {
        List({ space: 10 }) {
          ForEach(this.filtered(), (a: AlertView) => {
            ListItem() {
              AlertItem({
                alert: a,
                onPress: (item: AlertView) => {
                  this.getUIContext().getRouter().pushUrl({
                    url: 'pages/AlertDetailPage',
                    params: { alertId: item.alarmId }
                  });
                }
              })
            }
          }, (a: AlertView) => a.alarmId)
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
