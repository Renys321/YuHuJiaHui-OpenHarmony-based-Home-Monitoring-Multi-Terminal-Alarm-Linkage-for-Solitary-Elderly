// 首页
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { StatusCard, OverallStatus } from '../components/StatusCard';
import { Medal } from '../components/Medal';
import { AlertItem } from '../components/AlertItem';
import { ElderSafeNotice } from '../components/ElderSafeNotice';
import { SectionHeader } from '../components/SectionHeader';
import { MockData } from '../common/MockData';
import { Elder } from '../model/Elder';
import { Sensor } from '../model/Sensor';
import { AlertEvent } from '../model/AlertEvent';
import { DeviceView, ElderSafeEventView, ElderSafeLoadState } from '../core/view/Models';
import { DateUtil } from '../common/DateUtil';
import { ElderSafeLogic } from '../common/ElderSafeLogic';

@Component
export struct HomePage {
  @StorageLink('alerts') alerts: AlertEvent[] = [];
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.elderRevision') @Watch('onElderChanged') elderRevision: number = 0;
  @StorageLink('gv.devices') devices: DeviceView[] = [];
  @StorageLink('gv.elderSafeEvents') elderSafeEvents: ElderSafeEventView[] = [];
  @StorageLink('gv.elderSafeStatus') elderSafeStatus: string = ElderSafeLoadState.IDLE;
  @StorageLink('gv.elderSafeMessage') elderSafeMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') @Watch('onDataChanged') lastUpdatedAt: number = 0;
  @State elder: Elder = MockData.elder();
  @State sensors: Sensor[] = MockData.sensors();
  @State now: number = Date.now();

  aboutToAppear() {
    if (this.alerts.length === 0) {
      AppStorage.setOrCreate<AlertEvent[]>('alerts', MockData.alerts());
    }
    setInterval(() => { this.now = Date.now(); }, 30 * 1000);
  }

  onElderChanged(): void {
    this.elder = MockData.elder();
  }

  onDataChanged(): void {
    this.sensors = MockData.sensors();
  }

  private onlineDeviceCount(): number {
    let n = 0;
    for (let i = 0; i < this.devices.length; i++) {
      if (this.devices[i].online) n++;
    }
    return n;
  }

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private overallStatus(): OverallStatus {
    const pending = this.alerts.filter(a => a.status === 'pending');
    if (pending.some(a => a.level === 'critical')) return 'critical';
    if (pending.length > 0) return 'warning';
    return 'normal';
  }

  private latestPending(): AlertEvent | null {
    const list = this.alerts.filter(a => a.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt);
    return list.length > 0 ? list[0] : null;
  }

  private headline(): string {
    const a = this.latestPending();
    if (a !== null) return a.title;
    return '一切正常';
  }

  private subline(): string {
    const a = this.latestPending();
    if (a !== null) return a.description;
    return `${this.elder.name} · 最近活动 ${DateUtil.fromNow(this.latestMotion())}`;
  }

  private elderLine(): string {
    if (this.elder.age > 0) return `${this.elder.name} · ${this.elder.age} 岁`;
    return this.elder.name;
  }

  private latestMotion(): number {
    const motions = this.sensors.filter(s => s.type === 'motion' && s.lastTriggeredAt > 0);
    if (motions.length === 0) return Date.now();
    return Math.max(...motions.map(m => m.lastTriggeredAt));
  }

  private pendingAlerts(): AlertEvent[] {
    return this.alerts.filter(a => a.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 3);
  }

  private onlineCount(): number {
    return this.sensors.filter(s => s.online).length;
  }

  private lowBatteryCount(): number {
    return this.sensors.filter(s => s.online && s.battery < 20).length;
  }

  private switchTab(idx: number): void {
    AppStorage.setOrCreate('currentTabIndex', idx);
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

  private todayAlertCount(): number {
    const day = DateUtil.formatDate(Date.now());
    let n = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (DateUtil.formatDate(this.alerts[i].createdAt) === day) n++;
    }
    return n;
  }

  private pendingAlertCount(): number {
    let n = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (this.alerts[i].status === 'pending' || this.alerts[i].status === 'processing') n++;
    }
    return n;
  }

  private onlineSensorCount(): number {
    let n = 0;
    for (let i = 0; i < this.sensors.length; i++) {
      if (this.sensors[i].online) n++;
    }
    return n;
  }

  @Builder
  quickAction(variant: string, icon: Resource, label: string, onTap: () => void) {
    Column() {
      Medal({ variant: variant, icon: icon, medalSize: 50 })
      Text(label)
        .fontSize(FontSize.caption - 0.5)
        .fontWeight(FontWeight_.semibold)
        .fontColor(Color.textSecondary)
        .margin({ top: 6 })
    }
    .layoutWeight(1)
    .onClick(onTap)
  }

  @Builder
  todayMetric(label: string, value: string, unit: string, color: string, delta: string, deltaColor: string) {
    Column() {
      Row() {
        Text(value)
          .fontSize(20)
          .fontWeight(FontWeight_.extrabold)
          .fontColor(color)
        Text(unit)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ left: 2, bottom: 3 })
      }
      .alignItems(VerticalAlign.Bottom)
      Text(label)
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textSecondary)
        .margin({ top: 3 })
      Text(delta)
        .fontSize(FontSize.mini - 0.5)
        .fontWeight(FontWeight_.semibold)
        .fontColor(deltaColor)
        .margin({ top: 3 })
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .padding({ left: Space.md, right: Space.md })
  }

  build() {
    Scroll() {
      Column() {
        // 头部水洗渐变
        Column() {
          Row() {
            Column() {
              Text(`${new Date(this.now).getHours() < 12 ? '早上好' :
                new Date(this.now).getHours() < 18 ? '下午好' : '晚上好'}`)
                .fontSize(FontSize.caption)
                .fontColor(Color.textSecondary)
              Text(this.elderLine())
                .fontSize(FontSize.h2)
                .fontWeight(FontWeight_.bold)
                .fontColor(Color.textPrimary)
                .margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)

            Column() {
              Text(this.elder.name.substring(0, 1))
                .fontSize(FontSize.h3)
                .fontWeight(FontWeight_.extrabold)
                .fontColor('#FFFFFF')
            }
            .width(42)
            .height(42)
            .borderRadius(16)
            .justifyContent(FlexAlign.Center)
            .linearGradient(Grad.accent())
            .shadow(Shadow_.medal('rgba(234,88,12,0.30)'))
          }
          .width('100%')
          .padding({
            left: this.pm(), right: this.pm(),
            top: Space.md, bottom: Space.md
          })
        }
        .width('100%')
        .linearGradient(Grad.headWash())

        // 总体状态卡
        Column() {
          StatusCard({
            status: this.overallStatus(),
            elderName: `${this.elder.address}`,
            headline: this.headline(),
            subline: this.subline(),
            pendingCount: this.alerts.filter(a => a.status === 'pending').length,
            lastUpdate: `${DateUtil.formatTime(this.now)} 更新`,
            onPress: () => {
              if (this.alerts.some(a => a.status === 'pending')) {
                this.switchTab(2);
              } else {
                this.getUIContext().getPromptAction().showToast({ message: '当前无待处置预警' });
              }
            }
          })
        }
        .padding({ left: this.pm(), right: this.pm() })
        .margin({ top: Space.md - 2 })

        // 老人自述安全（只记录、不 ACK；手机可见）
        if (ElderSafeLogic.visible(this.elderSafeEvents, this.alerts).length > 0) {
          Column() {
            ElderSafeNotice({
              event: ElderSafeLogic.visible(this.elderSafeEvents, this.alerts)[0],
              ackPending: ElderSafeLogic.ackPending(ElderSafeLogic.visible(this.elderSafeEvents, this.alerts)[0], this.alerts),
              onPress: () => { this.openElderSafe(ElderSafeLogic.visible(this.elderSafeEvents, this.alerts)[0]); }
            })
            if (this.elderSafeStatus === ElderSafeLoadState.ERROR && this.elderSafeMessage.length > 0) {
              Text(`${this.elderSafeMessage}（显示上次记录）`)
                .fontSize(FontSize.mini)
                .fontColor(Color.warningDark)
                .margin({ top: 6 })
            }
          }
          .padding({ left: this.pm(), right: this.pm() })
          .margin({ top: Space.sm })
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
          .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
        }

        // 快捷操作
        Row() {
          this.quickAction('pri', $r('sys.symbol.phone_fill'), '一键呼叫',
            () => { this.getUIContext().getPromptAction().showToast({ message: '一键呼叫未开放：无后端语音链路' }); })
          this.quickAction('acc', $r('sys.symbol.video_fill'), '视频探望',
            () => { this.getUIContext().getRouter().pushUrl({ url: 'pages/VideoVisitPage' }); })
          this.quickAction('ok', $r('sys.symbol.message_fill'), '发送消息',
            () => { this.getUIContext().getPromptAction().showToast({ message: '发送消息未开放：无后端接口' }); })
          this.quickAction('pri', $r('sys.symbol.waveform'), '实时监测',
            () => { this.switchTab(1); })
        }
        .width('100%')
        .padding({
          left: this.pm() + 4, right: this.pm() + 4,
          top: Space.md, bottom: Space.sm
        })

        // 今日概览
        Column() {
          Row() {
            Text('今日概览')
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.textPrimary)
            Blank()
            Text(DateUtil.formatDate(this.now))
              .fontSize(FontSize.caption - 0.5)
              .fontColor(Color.textTertiary)
          }
          .width('100%')

          Row() {
            this.todayMetric('今日告警', `${this.todayAlertCount()}`, '条', Color.primaryDark, '真实同步', Color.textTertiary)
            Column().width(1).height(36).backgroundColor(Color.border)
            this.todayMetric('待确认', `${this.pendingAlertCount()}`, '条', Color.accentDark, '需处置', Color.criticalDark)
            Column().width(1).height(36).backgroundColor(Color.border)
            this.todayMetric('设备在线', `${this.onlineDeviceCount()}/${this.devices.length}`, '', Color.successDark, '实时', Color.successDark)
          }
          .width('100%')
          .margin({ top: Space.md - 2 })
        }
        .padding(Space.lg - 2)
        .backgroundColor(Color.card)
        .borderRadius(Radius.card)
        .shadow(Shadow_.card())
        .alignItems(HorizontalAlign.Start)
        .margin({ left: this.pm(), right: this.pm(), top: Space.sm })

        // 待处置预警
        if (this.pendingAlerts().length > 0) {
          SectionHeader({
            title: '待处置预警',
            subtitle: `${this.pendingAlertCount()} 条等待您的确认`,
            moreText: '全部',
            onMore: () => { this.switchTab(2); }
          })
          Column({ space: 10 }) {
            ForEach(this.pendingAlerts(), (a: AlertEvent) => {
              AlertItem({
                alert: a,
                onPress: (item: AlertEvent) => {
                  this.getUIContext().getRouter().pushUrl({
                    url: 'pages/AlertDetailPage',
                    params: { alertId: item.id }
                  });
                }
              })
            }, (a: AlertEvent) => a.id)
          }
          .padding({ left: this.pm(), right: this.pm() })
        }

        // 设备健康
        SectionHeader({
          title: '设备健康',
          moreText: '管理',
          onMore: () => {
            this.getUIContext().getRouter().pushUrl({ url: 'pages/DevicePage' });
          }
        })
        Row() {
          Column() {
            Text(`${this.onlineCount()}/${this.sensors.length}`)
              .fontSize(20).fontWeight(FontWeight_.extrabold).fontColor(Color.successDark)
            Text('设备在线')
              .fontSize(FontSize.caption - 0.5).fontColor(Color.textSecondary)
              .margin({ top: 3 })
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)

          Column().width(1).height(34).backgroundColor(Color.border)

          Column() {
            Text(`${this.lowBatteryCount()}`)
              .fontSize(20).fontWeight(FontWeight_.extrabold)
              .fontColor(this.lowBatteryCount() > 0 ? Color.warningDark : Color.textTertiary)
            Text('低电量')
              .fontSize(FontSize.caption - 0.5).fontColor(Color.textSecondary)
              .margin({ top: 3 })
          }.layoutWeight(1).alignItems(HorizontalAlign.Center)

          Column().width(1).height(34).backgroundColor(Color.border)

          Column() {
            Text('98%')
              .fontSize(20).fontWeight(FontWeight_.extrabold).fontColor(Color.primaryDark)
            Text('信号强度')
              .fontSize(FontSize.caption - 0.5).fontColor(Color.textSecondary)
              .margin({ top: 3 })
          }.layoutWeight(1).alignItems(HorizontalAlign.End)
        }
        .width('100%')
        .padding(Space.lg - 2)
        .backgroundColor(Color.card)
        .borderRadius(Radius.card)
        .shadow(Shadow_.card())
        .margin({ left: this.pm(), right: this.pm(), bottom: Space.xxl })

        Column().height(56)
      }
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
  }
}
