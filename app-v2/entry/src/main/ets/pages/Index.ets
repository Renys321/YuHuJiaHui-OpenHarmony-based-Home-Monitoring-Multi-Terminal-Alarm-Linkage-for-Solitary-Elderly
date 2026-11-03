import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_ } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { HomePage } from './HomePage';
import { MonitorPage } from './MonitorPage';
import { AlertListPage } from './AlertListPage';
import { ProfilePage } from './ProfilePage';
import { GuardianService } from '../service/GuardianService';
import { DemoMode } from '../demo/DemoMode';
import { AlertView, AppKeys, RunMode } from '../core/view/Models';
import { RefreshOutcome } from '../core/service/Outcomes';
import { MockData } from '../common/MockData';
import { AlertEvent } from '../model/AlertEvent';
import { ElderProfileLocal } from '../common/ElderProfileLocal';
import { ContactsLocal } from '../common/ContactsLocal';

@Entry
@Component
struct Index {
  @StorageLink('currentTabIndex') currentIndex: number = 0;
  @StorageLink('gv.alerts') @Watch('syncAlerts') alerts: AlertView[] = [];
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @StorageLink('gv.netStatus') @Watch('onNetStatusChange') netStatus: string = 'unknown';
  private redirected: boolean = false;
  @State ready: boolean = false;

  aboutToAppear(): void {
    Responsive.init(this.getUIContext());
    AppStorage.setOrCreate('currentTabIndex', this.currentIndex);

    if (this.mode === RunMode.DEMO) {
      this.ready = true;
      return;
    }

    const ctx = this.getUIContext().getHostContext();
    if (ctx !== undefined) {
      GuardianService.init(ctx);
    }

    if (!GuardianService.isLoggedIn()) {
      this.redirectToLogin();
      return;
    }
    // 先标记真实模式，再加载本机资料：否则加载完成时 RealData 仍按 mock 返回
    AppStorage.setOrCreate<string>(AppKeys.MODE, RunMode.REAL);
    ElderProfileLocal.clearAppStorage();
    ContactsLocal.clearAppStorage();
    if (ctx !== undefined) {
      ElderProfileLocal.loadIntoAppStorage(ctx);
      ContactsLocal.loadIntoAppStorage(ctx);
    }

    GuardianService.refreshAll().then((out: RefreshOutcome) => {
      this.syncAlerts();
      this.ready = true;
      if (out.unauthorized) {
        this.redirectToLogin();
      }
    }).catch(() => {
      this.ready = true;
    });
    GuardianService.startAutoRefresh();
  }

  aboutToDisappear(): void {
    if (this.mode !== RunMode.DEMO) {
      GuardianService.stopAutoRefresh();
    }
  }

  onPageShow(): void {
    if (this.mode === RunMode.DEMO) {
      return;
    }
    if (!GuardianService.isLoggedIn()) {
      this.redirectToLogin();
      return;
    }
    if (!GuardianService.isPolling()) {
      GuardianService.startAutoRefresh();
    }
    const pending: Promise<RefreshOutcome> | null = GuardianService.refreshOnShow();
    if (pending !== null) {
      pending.then((out: RefreshOutcome) => {
        if (out.unauthorized) {
          this.redirectToLogin();
        }
      }).catch(() => { });
    }
  }

  syncAlerts(): void {
    AppStorage.setOrCreate<AlertEvent[]>('alerts', MockData.alerts());
  }

  onNetStatusChange(): void {
    if (this.mode === RunMode.DEMO) {
      return;
    }
    if (this.netStatus === 'unauthorized') {
      this.redirectToLogin();
    }
  }

  private redirectToLogin(): void {
    if (this.mode === RunMode.DEMO) {
      return;
    }
    if (this.redirected) {
      return;
    }
    this.redirected = true;
    GuardianService.stopAutoRefresh();
    this.getUIContext().getRouter().replaceUrl({ url: 'pages/LoginPage' });
  }

  private exitDemo(): void {
    DemoMode.exit();
    this.getUIContext().getRouter().replaceUrl({ url: 'pages/LoginPage' });
  }

  @Builder
  demoBanner() {
    Row() {
      Text('演示模式')
        .fontSize(FontSize.mini)
        .fontWeight(FontWeight_.extrabold)
        .fontColor('#92400E')
        .padding({ left: 6, right: 6, top: 2, bottom: 2 })
        .backgroundColor('#FDE68A')
        .borderRadius(Radius.pill)
      Text('示例数据 · 不连接真实设备/不发送命令')
        .fontSize(FontSize.mini)
        .fontColor('#92400E')
        .margin({ left: 6 })
        .layoutWeight(1)
        .maxLines(1)
      Text('退出演示')
        .fontSize(FontSize.mini)
        .fontWeight(FontWeight_.bold)
        .fontColor('#92400E')
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .border({ width: 1, color: '#F59E0B' })
        .borderRadius(Radius.pill)
        .onClick(() => { this.exitDemo(); })
    }
    .width('100%')
    .height(36)
    .padding({ left: 10, right: 10 })
    .backgroundColor('#FFFBEB')
    .border({ width: { bottom: 1 }, color: '#FDE68A' })
  }

  private isPending(a: AlertView): boolean {
    return a.statusKey === 'pending' || a.statusKey === 'waiting';
  }

  private pendingCount(): number {
    let n: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (this.isPending(this.alerts[i])) {
        n += 1;
      }
    }
    return n;
  }

  @Builder
  tabBarBuilder(index: number, label: string, icon: Resource, iconActive: Resource,
                badge: number = 0) {
    Column() {
      Stack({ alignContent: Alignment.TopEnd }) {
        SymbolGlyph(this.currentIndex === index ? iconActive : icon)
          .fontSize(21)
          .fontColor([this.currentIndex === index ? Color.primaryDark : Color.textTertiary])
        if (badge > 0) {
          Text(badge > 99 ? '99+' : badge.toString())
            .fontSize(8.5)
            .fontWeight(FontWeight_.extrabold)
            .fontColor('#FFFFFF')
            .padding({ left: 5, right: 5, top: 1, bottom: 1 })
            .borderRadius(999)
            .linearGradient(Grad.critical())
            .shadow({ radius: 6, color: 'rgba(220,38,38,0.4)', offsetX: 0, offsetY: 2 })
            .margin({ top: -4, right: -9 })
        }
      }
      Text(label)
        .fontSize(FontSize.mini)
        .fontColor(this.currentIndex === index ? Color.primaryDark : Color.textTertiary)
        .fontWeight(this.currentIndex === index ? FontWeight_.bold : FontWeight_.regular)
        .margin({ top: 3 })
      Column()
        .width(this.currentIndex === index ? 14 : 0)
        .height(3)
        .borderRadius(2)
        .linearGradient(Grad.primary())
        .margin({ top: 3 })
    }
    .width('100%')
    .height(56)
    .justifyContent(FlexAlign.Center)
    .onClick(() => {
      this.currentIndex = index;
      AppStorage.setOrCreate('currentTabIndex', index);
    })
  }

  build() {
    Stack() {
      Column() {
        if (this.mode === RunMode.DEMO) {
          this.demoBanner()
        }
        if (!this.ready) {
          Column() {
            LoadingProgress().width(40).height(40).color(Color.primary)
            Text('正在同步真实数据…')
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .margin({ top: 10 })
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
        Tabs({ barPosition: BarPosition.End, index: this.currentIndex }) {
          TabContent() { HomePage() }
            .tabBar(this.tabBarBuilder(0, '首页',
              $r('sys.symbol.house'), $r('sys.symbol.house_fill')))

          TabContent() { MonitorPage() }
            .tabBar(this.tabBarBuilder(1, '监测',
              $r('sys.symbol.waveform'), $r('sys.symbol.waveform')))

          TabContent() { AlertListPage() }
            .tabBar(this.tabBarBuilder(2, '预警',
              $r('sys.symbol.bell'), $r('sys.symbol.bell_fill'), this.pendingCount()))

          TabContent() { ProfilePage() }
            .tabBar(this.tabBarBuilder(3, '我的',
              $r('sys.symbol.person'), $r('sys.symbol.person_fill')))
        }
        .barHeight(62)
        .barBackgroundColor('rgba(255,255,255,0.96)')
        .scrollable(false)
        .animationDuration(220)
        .onChange((idx: number) => {
          this.currentIndex = idx;
          AppStorage.setOrCreate('currentTabIndex', idx);
        })
        .width('100%')
        .layoutWeight(1)
        .backgroundColor(Color.bg)
        }
      }
      .width('100%')
      .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
