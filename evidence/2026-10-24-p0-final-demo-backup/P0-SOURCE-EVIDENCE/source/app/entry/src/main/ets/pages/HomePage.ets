/**
 * 首页 —— 仪表盘（真实 API 数据，AppStorage gv.*）
 * 数据全部来自 GuardianService 刷新后的视图模型：没有老人档案、活动次数、睡眠、信号百分比等虚构指标。
 * 网络失败/无数据时明确显示离线/获取失败 + 上次数据时间，不显示绿色“一切正常”。
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { StatusCard, OverallStatus } from '../components/StatusCard';
import { Medal } from '../components/Medal';
import { AlertItem } from '../components/AlertItem';
import { SectionHeader } from '../components/SectionHeader';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { AlertView, DeviceView, OverviewView, RoomView, RunMode } from '../core/view/Models';
import { HomeMetrics } from '../core/view/HomeMetrics';
import { GuardianService } from '../service/GuardianService';

@Component
export struct HomePage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.devices') devices: DeviceView[] = [];
  @StorageLink('gv.rooms') rooms: RoomView[] = [];
  @StorageLink('gv.overview') overview: OverviewView = new OverviewView();
  @StorageLink('gv.netStatus') netStatus: string = 'unknown';
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;
  @StorageLink('gv.guardianId') guardianId: string = '';
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @State refreshing: boolean = false;

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private switchTab(idx: number): void {
    AppStorage.setOrCreate('currentTabIndex', idx);
  }

  private pendingAlerts(): AlertView[] {
    const out: AlertView[] = [];
    for (let i = 0; i < this.alerts.length; i++) {
      if (this.alerts[i].statusKey === 'pending') {
        out.push(this.alerts[i]);
      }
    }
    out.sort((a: AlertView, b: AlertView) => b.createdAt - a.createdAt);
    return out;
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

  private hasCriticalPending(): boolean {
    const pending: AlertView[] = this.pendingAlerts();
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].level === 'critical') {
        return true;
      }
    }
    return false;
  }

  private todayAlertCount(): number {
    const today: string = DateUtil.formatDate(Date.now());
    let count: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (DateUtil.formatDate(this.alerts[i].createdAt) === today) {
        count++;
      }
    }
    return count;
  }

  private offlineDeviceCount(): number {
    return HomeMetrics.offlineCount(this.overview, this.devices);
  }

  private deviceCount(): number {
    return HomeMetrics.deviceCount(this.overview, this.devices);
  }

  private onlineCount(): number {
    return HomeMetrics.onlineCount(this.overview, this.devices);
  }

  private monitorOfflineCount(): number {
    return HomeMetrics.monitorOfflineCount(this.overview, this.devices);
  }

  private abnormalDevices(): DeviceView[] {
    const out: DeviceView[] = [];
    for (let i = 0; i < this.devices.length; i++) {
      const d: DeviceView = this.devices[i];
      if (!d.online || d.monitorOnline === 0 || d.monitorOnline === -1) {
        out.push(d);
      }
    }
    return out;
  }

  private hasData(): boolean {
    return HomeMetrics.hasDeviceData(this.overview, this.devices, this.netStatus);
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

  private dataStatus(): OverallStatus {
    // 网络失败/离线：即使有上次数据，也不能显示绿色正常
    if (this.netStatus === 'offline' || this.netStatus === 'error' || this.netStatus === 'unauthorized') {
      return 'offline';
    }
    if (this.netStatus === 'loading' && !this.hasData()) {
      return 'unknown';
    }
    if (!this.hasData()) {
      return 'unknown';
    }
    const pending: AlertView[] = this.pendingAlerts();
    if (this.hasCriticalPending()) {
      return 'critical';
    }
    if (pending.length > 0 || this.waitingCount() > 0) {
      return 'warning';
    }
    if (this.deviceCount() === 0) {
      return 'unknown';
    }
    if (this.onlineCount() < this.deviceCount() || this.monitorOfflineCount() > 0) {
      return 'warning';
    }
    if (this.netStatus === 'partial') {
      return 'warning';
    }
    return 'normal';
  }

  private headline(): string {
    const status: OverallStatus = this.dataStatus();
    if (status === 'critical') return '紧急告警待确认';
    if (status === 'warning') {
      if (this.pendingAlerts().length > 0) return '需要关注';
      if (this.waitingCount() > 0) return '等待设备确认';
      if (this.netStatus === 'partial') return '部分数据获取失败';
      return '设备状态异常';
    }
    if (status === 'normal') return '家中状态正常';
    if (status === 'offline') return this.hasData() ? '离线 · 显示上次数据' : '数据获取失败';
    return this.netStatus === 'loading' ? '正在获取数据' : '暂无数据';
  }

  private subline(): string {
    const status: OverallStatus = this.dataStatus();
    if (status === 'offline') {
      if (this.netMessage.length > 0) return this.netMessage;
      return this.hasData() ? '网络不可用，显示上次获取的数据' : '数据获取失败，请检查网络后重试';
    }
    if (!this.hasData()) {
      if (this.netMessage.length > 0) return this.netMessage;
      if (this.netStatus === 'loading') return '正在从服务端获取真实数据…';
      return '暂无数据，请检查网络后下拉刷新';
    }
    if (status === 'critical') {
      return `${this.pendingAlerts().length} 条紧急告警尚未确认，请尽快处理`;
    }
    if (this.pendingAlerts().length > 0) {
      return `${this.pendingAlerts().length} 条告警等待您确认`;
    }
    if (this.waitingCount() > 0) {
      return `${this.waitingCount()} 条命令已提交，等待设备回执确认`;
    }
    if (this.netStatus === 'partial') {
      return this.netMessage.length > 0 ? this.netMessage : '部分数据获取失败，显示上次数据';
    }
    if (status === 'warning') {
      return `设备在线 ${this.onlineCount()}/${this.deviceCount()} · 监测异常 ${this.monitorOfflineCount()} 台`;
    }
    return `设备全部在线 · 暂无待确认告警`;
  }

  private lastUpdateLine(): string {
    if (this.netStatus === 'loading') return '正在刷新…';
    if (this.netStatus === 'partial') {
      return this.lastUpdatedAt > 0 ? `部分失败 · 上次 ${DateUtil.formatTime(this.lastUpdatedAt)}` : '部分数据获取失败';
    }
    if (this.netStatus === 'offline') {
      return this.lastUpdatedAt > 0 ? `离线 · 上次 ${DateUtil.formatTime(this.lastUpdatedAt)}` : '离线 · 暂无数据';
    }
    if (this.netStatus === 'error') {
      return this.lastUpdatedAt > 0 ? `获取失败 · 上次 ${DateUtil.formatTime(this.lastUpdatedAt)}` : '获取失败 · 暂无数据';
    }
    if (this.netStatus === 'unauthorized') return '登录已失效';
    if (this.lastUpdatedAt > 0) return `${DateUtil.formatTime(this.lastUpdatedAt)} 更新`;
    return '尚未更新';
  }

  private eyebrow(): string {
    if (this.guardianId.length > 0) {
      return `监护人 ${this.guardianId}`;
    }
    return '我的家';
  }

  private greeting(): string {
    const hour: number = new Date().getHours();
    if (hour < 6) return '夜间好';
    if (hour < 12) return '早上好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }

  private async doRefresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    if (this.mode === RunMode.DEMO) {
      this.getUIContext().getPromptAction().showToast({ message: '演示模式不刷新真实数据' });
      return;
    }
    this.refreshing = true;
    try {
      const outcome = await GuardianService.refreshAll();
      if (!outcome.ok) {
        const msg: string = outcome.message.length > 0 ? outcome.message : '刷新失败，请稍后重试';
        this.getUIContext().getPromptAction().showToast({ message: msg });
      } else if (outcome.partial) {
        this.getUIContext().getPromptAction().showToast({ message: '部分数据刷新失败，显示上次数据' });
      } else {
        this.getUIContext().getPromptAction().showToast({ message: '数据已刷新' });
      }
    } catch (err) {
      this.getUIContext().getPromptAction().showToast({ message: '刷新失败，请检查网络后重试' });
    } finally {
      this.refreshing = false;
    }
  }

  private toast(text: string): void {
    this.getUIContext().getPromptAction().showToast({ message: text });
  }

  @Builder
  quickAction(icon: Resource, label: string, enabled: boolean, onTap: () => void) {
    Column() {
      Medal({ variant: enabled ? 'pri' : 'soft', icon: icon, medalSize: 50 })
      Text(label)
        .fontSize(FontSize.caption - 0.5)
        .fontWeight(FontWeight_.semibold)
        .fontColor(enabled ? Color.textSecondary : Color.textTertiary)
        .margin({ top: 6 })
      if (!enabled) {
        Text('未开放')
          .fontSize(FontSize.mini - 1)
          .fontColor(Color.textTertiary)
          .margin({ top: 1 })
      }
    }
    .layoutWeight(1)
    .onClick(() => {
      if (enabled) {
        onTap();
      } else {
        this.toast(`${label}未开放`);
      }
    })
  }

  @Builder
  metric(label: string, value: string, color: string) {
    Column() {
      Text(value)
        .fontSize(20)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(color)
      Text(label)
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textSecondary)
        .margin({ top: 3 })
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  deviceStateRow(d: DeviceView) {
    Row() {
      Column()
        .width(7)
        .height(7)
        .borderRadius(4)
        .backgroundColor(d.online ? (d.monitorOnline === 0 ? Color.critical : Color.warning) : Color.textTertiary)
        .margin({ right: Space.sm })
      Column() {
        Text(d.name.length > 0 ? d.name : d.deviceId)
          .fontSize(FontSize.body)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${d.roomName.length > 0 ? d.roomName : '未分配房间'} · ${d.monitorText.length > 0 ? d.monitorText : d.stateText}`)
          .fontSize(FontSize.mini)
          .fontColor(Color.textSecondary)
          .margin({ top: 1 })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(12)
        .fontColor([Color.textTertiary])
    }
    .width('100%')
    .padding({ top: Space.sm - 2, bottom: Space.sm - 2 })
    .onClick(() => {
      this.getUIContext().getRouter().pushUrl({ url: 'pages/DevicePage' });
    })
  }

  build() {
    Scroll() {
      Column() {
        // 头部：真实概览，无老人姓名/年龄/病史
        Column() {
          Row() {
            Column() {
              Text(this.greeting())
                .fontSize(FontSize.caption)
                .fontColor(Color.textSecondary)
              Text('我的家')
                .fontSize(FontSize.h2)
                .fontWeight(FontWeight_.bold)
                .fontColor(Color.textPrimary)
                .margin({ top: 2 })
              Text(`${this.rooms.length} 个房间 · ${this.devices.length} 台设备`)
                .fontSize(FontSize.caption)
                .fontColor(Color.textSecondary)
                .margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)

            Column() {
              if (this.refreshing) {
                LoadingProgress()
                  .width(18)
                  .height(18)
                  .color(Color.primaryDark)
              } else {
                SymbolGlyph($r('sys.symbol.arrow_clockwise'))
                  .fontSize(17)
                  .fontColor([Color.primaryDark])
              }
            }
            .width(36)
            .height(36)
            .borderRadius(12)
            .backgroundColor(Color.card)
            .justifyContent(FlexAlign.Center)
            .shadow(Shadow_.card())
            .margin({ right: 8 })
            .opacity(this.refreshing ? 0.7 : 1)
            .onClick(() => { void this.doRefresh(); })

            Column() {
              SymbolGlyph($r('sys.symbol.house_fill'))
                .fontSize(19)
                .fontColor(['#FFFFFF'])
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

        // 总体状态卡（由真实 overview + alerts 推导）
        Column() {
          StatusCard({
            status: this.dataStatus(),
            eyebrow: this.eyebrow(),
            headline: this.headline(),
            subline: this.subline(),
            pendingCount: this.pendingAlerts().length,
            lastUpdate: this.lastUpdateLine(),
            lastUpdateWarn: this.netWarn(),
            onPress: () => {
              if (!this.hasData()) {
                const msg: string = this.netMessage.length > 0 ? this.netMessage : '暂无数据，请先刷新';
                this.toast(msg);
              } else if (this.pendingAlerts().length > 0) {
                this.switchTab(2);
              } else {
                this.toast('当前无待确认告警');
              }
            }
          })
        }
        .padding({ left: this.pm(), right: this.pm() })
        .margin({ top: Space.md - 2 })

        // 网络失败/降级提示
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
          .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
        }

        // 快捷入口：无后端能力的一律“未开放”
        Row() {
          this.quickAction($r('sys.symbol.phone_fill'), '一键呼叫', false, () => {})
          this.quickAction($r('sys.symbol.video_fill'), '视频探望', false, () => {})
          this.quickAction($r('sys.symbol.message_fill'), '发送消息', false, () => {})
          this.quickAction($r('sys.symbol.waveform'), '实时监测', true, () => { this.switchTab(1); })
        }
        .width('100%')
        .padding({
          left: this.pm() + 4, right: this.pm() + 4,
          top: Space.md, bottom: Space.sm
        })

        // 今日概览：真实设备/告警指标
        Column() {
          Row() {
            Text('今日概览')
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.textPrimary)
            Blank()
            Text(this.hasData() ? DateUtil.formatDate(Date.now()) : '暂无数据')
              .fontSize(FontSize.caption - 0.5)
              .fontColor(Color.textTertiary)
          }
          .width('100%')

          Row() {
            Column() {
              Text(this.hasData() ? `${this.onlineCount()}/${this.deviceCount()}` : '--')
                .fontSize(20)
                .fontWeight(FontWeight_.extrabold)
                .fontColor(this.hasData() && this.onlineCount() === this.deviceCount() ? Color.successDark : Color.warningDark)
              Text('在线/设备')
                .fontSize(FontSize.caption - 0.5)
                .fontColor(Color.textSecondary)
                .margin({ top: 3 })
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Column().width(1).height(36).backgroundColor(Color.border)
            Column() {
              Text(this.hasData() ? `${this.monitorOfflineCount()}` : '--')
                .fontSize(20).fontWeight(FontWeight_.extrabold)
                .fontColor(this.monitorOfflineCount() > 0 ? Color.criticalDark : Color.textTertiary)
              Text('监测异常').fontSize(FontSize.caption - 0.5).fontColor(Color.textSecondary).margin({ top: 3 })
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Column().width(1).height(36).backgroundColor(Color.border)
            Column() {
              Text(this.hasData() ? `${this.pendingAlerts().length}` : '--')
                .fontSize(20).fontWeight(FontWeight_.extrabold)
                .fontColor(this.pendingAlerts().length > 0 ? Color.criticalDark : Color.textTertiary)
              Text('待确认').fontSize(FontSize.caption - 0.5).fontColor(Color.textSecondary).margin({ top: 3 })
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Column().width(1).height(36).backgroundColor(Color.border)
            Column() {
              Text(this.hasData() ? `${this.todayAlertCount()}` : '--')
                .fontSize(20).fontWeight(FontWeight_.extrabold)
                .fontColor(this.todayAlertCount() > 0 ? Color.warningDark : Color.textTertiary)
              Text('今日告警').fontSize(FontSize.caption - 0.5).fontColor(Color.textSecondary).margin({ top: 3 })
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
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

        // 待处置告警（真实 gv.alerts）
        SectionHeader({
          title: '待处置告警',
          subtitle: this.pendingAlerts().length > 0 ? `${this.pendingAlerts().length} 条等待确认` : '',
          moreText: '全部',
          onMore: () => { this.switchTab(2); }
        })
        if (this.pendingAlerts().length > 0) {
          Column({ space: 10 }) {
            ForEach(this.pendingAlerts().slice(0, 3), (a: AlertView) => {
              AlertItem({
                alert: a,
                onPress: (item: AlertView) => {
                  this.getUIContext().getRouter().pushUrl({
                    url: 'pages/AlertDetailPage',
                    params: { alertId: item.alarmId }
                  });
                }
              })
            }, (a: AlertView) => a.alarmId)
          }
          .padding({ left: this.pm(), right: this.pm() })
        } else {
          EmptyState({
            icon: $r('sys.symbol.checkmark_circle'),
            title: this.hasData() ? '暂无待处置告警' : '暂无法获取告警数据',
            description: this.hasData() ? '新的告警会实时同步到这里' : (this.netMessage.length > 0 ? this.netMessage : '请刷新后重试')
          })
        }

        // 设备健康（真实 devices）
        SectionHeader({
          title: '设备健康',
          moreText: '管理',
          onMore: () => {
            this.getUIContext().getRouter().pushUrl({ url: 'pages/DevicePage' });
          }
        })
        Column() {
          Row() {
            Column() {
              Text(this.hasData() ? `${this.onlineCount()}/${this.deviceCount()}` : '--')
                .fontSize(20).fontWeight(FontWeight_.extrabold)
                .fontColor(this.hasData() ? Color.primaryDark : Color.textTertiary)
              Text('在线设备').fontSize(FontSize.caption - 0.5).fontColor(Color.textSecondary).margin({ top: 2 })
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Column().width(1).height(34).backgroundColor(Color.border)
            Column() {
              Text(this.hasData() ? `${this.monitorOfflineCount()}` : '--')
                .fontSize(20).fontWeight(FontWeight_.extrabold)
                .fontColor(this.monitorOfflineCount() > 0 ? Color.criticalDark : Color.textTertiary)
              Text('监测异常').fontSize(FontSize.caption - 0.5).fontColor(Color.textSecondary).margin({ top: 2 })
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Column().width(1).height(34).backgroundColor(Color.border)
            Column() {
              Text(this.hasData() ? `${this.offlineDeviceCount()}` : '--')
                .fontSize(20).fontWeight(FontWeight_.extrabold)
                .fontColor(this.offlineDeviceCount() > 0 ? Color.warningDark : Color.textTertiary)
              Text('离线设备').fontSize(FontSize.caption - 0.5).fontColor(Color.textSecondary).margin({ top: 2 })
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          }
          .width('100%')

          if (this.abnormalDevices().length > 0) {
            Divider()
              .color(Color.border)
              .margin({ top: Space.sm, bottom: Space.xs })
            ForEach(this.abnormalDevices().slice(0, 3), (d: DeviceView) => {
              this.deviceStateRow(d)
            }, (d: DeviceView) => d.id.length > 0 ? d.id : d.deviceId)
          } else if (this.hasData() && this.devices.length > 0 && !this.netWarn()) {
            Row() {
              SymbolGlyph($r('sys.symbol.checkmark_circle'))
                .fontSize(12)
                .fontColor([Color.textTertiary])
              Text('设备均在线且监测状态正常')
                .fontSize(FontSize.caption)
                .fontColor(Color.textSecondary)
                .margin({ left: 5 })
            }
            .width('100%')
            .margin({ top: Space.sm })
          }
        }
        .padding(Space.lg - 2)
        .backgroundColor(Color.card)
        .borderRadius(Radius.card)
        .shadow(Shadow_.card())
        .alignItems(HorizontalAlign.Start)
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
