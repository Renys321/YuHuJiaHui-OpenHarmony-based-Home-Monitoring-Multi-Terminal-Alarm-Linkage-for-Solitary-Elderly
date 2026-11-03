/**
 * 主框架 —— 监护人工作台
 *  · 进入时 GuardianService.init；无有效会话直接回登录页
 *  · 有会话：refreshAll + startAutoRefresh(30s)，退出页面 stopAutoRefresh
 *  · 监听 gv.netStatus：'unauthorized'（业务 401）→ 停轮询并回登录页（只触发一次）
 *  · 预警 Tab 徽标 = 真实待确认告警数（statusKey === 'pending' || 'waiting'）
 *  · SOS 浮钮：本轮无远程求助接口，仅保留视觉并明确“未开放”，不给出任何完成类提示
 *  · 演示模式（gv.mode=demo）：只读取本地示例 AppStorage，不 init/restore/refresh/startAutoRefresh，
 *    顶栏显示“演示模式/示例数据”，退出时清理演示状态回登录页。
 */
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

@Entry
@Component
struct Index {
  @StorageLink('currentTabIndex') currentIndex: number = 0;
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @StorageLink('gv.netStatus') @Watch('onNetStatusChange') netStatus: string = 'unknown';
  private redirected: boolean = false;

  aboutToAppear(): void {
    Responsive.init(this.getUIContext());
    AppStorage.setOrCreate('currentTabIndex', this.currentIndex);

    if (this.mode === RunMode.DEMO) {
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
    AppStorage.setOrCreate<string>(AppKeys.MODE, RunMode.REAL);

    GuardianService.refreshAll().then((out: RefreshOutcome) => {
      // 结果通过 gv.netStatus / gv.netMessage 呈现，这里不弹任何成功提示
      if (out.unauthorized) {
        this.redirectToLogin();
      }
    }).catch(() => { });
    GuardianService.startAutoRefresh();
  }

  aboutToDisappear(): void {
    if (this.mode !== RunMode.DEMO) {
      GuardianService.stopAutoRefresh();
    }
  }

  /** 业务 401：清会话后回登录页，只触发一次；演示模式不参与真实网络状态。 */
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
    Stack({ alignContent: Alignment.BottomEnd }) {
      Column() {
        if (this.mode === RunMode.DEMO) {
          this.demoBanner()
        }
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
      .width('100%')
      .height('100%')

      // SOS 浮钮：本轮无远程 SOS 接口 → 明确禁用/未开放，点击只提示拨打 120 或联系人
      Row() {
        Stack({ alignContent: Alignment.TopEnd }) {
          Column() {
            SymbolGlyph($r('sys.symbol.phone_fill'))
              .fontSize(18)
              .fontColor(['#FFFFFF'])
            Text('SOS')
              .fontSize(FontSize.mini)
              .fontWeight(FontWeight_.extrabold)
              .fontColor('#FFFFFF')
              .margin({ top: 1 })
          }
          .width(52)
          .height(52)
          .justifyContent(FlexAlign.Center)
          .borderRadius(26)
          .linearGradient({ angle: 135, colors: [['#CBD5E1', 0.0], ['#94A3B8', 1.0]] })
          .shadow(Shadow_.card())

          Text('未开放')
            .fontSize(7.5)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textSecondary)
            .padding({ left: 4, right: 4, top: 1, bottom: 1 })
            .backgroundColor('#FFFFFF')
            .borderRadius(Radius.pill)
            .border({ width: 1, color: Color.border })
            .margin({ top: -4, right: -9 })
        }
        .width(58)
        .height(52)
      }
      .width(58)
      .height(52)
      .margin({ right: 14, bottom: 78 })
      .onClick(() => {
        this.getUIContext().getPromptAction().showToast({
          message: this.mode === RunMode.DEMO
            ? '演示模式不发送求助；请退出演示后使用真实模式'
            : '远程求助未开放，请直接拨打 120 或联系人电话'
        });
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
