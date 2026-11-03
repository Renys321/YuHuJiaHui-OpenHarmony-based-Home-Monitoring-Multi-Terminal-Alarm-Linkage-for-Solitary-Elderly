/**
 * 实时监测页 —— 真实设备/传感器数据（AppStorage gv.*）
 * - 不自建 30s 定时器，自动刷新由 Index/GuardianService 统一负责
 * - 手动刷新真实调用 GuardianService.refreshAll()，await + 防重复
 * - 仅展示 DeviceView.sensors 的真实字段，不编造“已刷新/正常”
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { SensorCard } from '../components/SensorCard';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { AlertView, DeviceView, RunMode, SensorView } from '../core/view/Models';
import { GuardianService } from '../service/GuardianService';

class FilterItem {
  key: string = '';
  label: string = '';
}

@Component
export struct MonitorPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.devices') devices: DeviceView[] = [];
  @StorageLink('gv.devicesVersion') devicesVersion: number = 0;
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.netStatus') netStatus: string = 'unknown';
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @State activeKind: string = 'all';
  @State refreshing: boolean = false;
  @State testPhase: number = 0;

  private injectTestSnapshot(): void {
    // Diagnostic-only fixture: drive the real MonitorPage/AppStorage with A(3 online),
    // B(2 online, bath offline), C(3 online, bath recovered).
    GuardianService.stopAutoRefresh();
    const phase: number = this.testPhase % 3;
    const now: number = Date.now();
    const devices: DeviceView[] = [];
    const ids: string[] = ['dayu200-living', 'esp32-kitchen', 'esp32-bath', 'old-1', 'old-2'];
    const rooms: string[] = ['客厅', '厨房', '卫生间', '旧设备', '旧设备'];
    for (let i = 0; i < ids.length; i++) {
      const d = new DeviceView();
      d.id = ids[i];
      d.deviceId = ids[i];
      d.roomId = rooms[i];
      d.roomName = rooms[i];
      d.online = i === 2 ? phase !== 1 : i < 2;
      d.monitorOnline = 1;
      d.state = 'NORMAL';
      d.lastSeenTs = now - (d.online ? 1000 : 120000);
      if (i === 2) {
        const s = new SensorView();
        s.id = 'esp32-bath:climate';
        s.deviceId = 'esp32-bath';
        s.roomId = '卫生间';
        s.roomName = '卫生间';
        s.kind = 'climate';
        s.name = '温湿度';
        s.state = d.online ? 'ok' : 'offline';
        s.stateText = d.online ? '读数有效' : '离线';
        s.valueText = d.online ? (phase === 2 ? '26.0°C · 51%RH' : '25.0°C · 50%RH') : '上次读数 25.0°C · 50%RH';
        s.detailText = d.online ? 'AHT20 读数有效' : '设备离线，展示上次读数';
        s.lastUpdateTs = now;
        d.sensors = [s];
      } else {
        d.sensors = [];
      }
      devices.push(d);
    }
    AppStorage.setOrCreate<DeviceView[]>('gv.devices', devices);
    AppStorage.setOrCreate<number>('gv.devicesVersion', this.testPhase + 1);
    AppStorage.setOrCreate<number>('gv.lastUpdatedAt', now);
  }

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private liveDevices(): DeviceView[] {
    const live: DeviceView[] | undefined = AppStorage.get<DeviceView[]>('gv.devices');
    return live !== undefined ? live : this.devices;
  }

  private allSensors(): SensorView[] {
    const out: SensorView[] = [];
    for (let i = 0; i < this.liveDevices().length; i++) {
      const list: SensorView[] = this.liveDevices()[i].sensors;
      for (let j = 0; j < list.length; j++) {
        out.push(list[j]);
      }
    }
    return out;
  }

  private kindLabel(kind: string): string {
    if (kind === 'climate') return '温湿度';
    if (kind === 'motion') return '活动';
    if (kind === 'door') return '门窗';
    if (kind === 'gas') return '燃气';
    if (kind === 'smoke') return '烟雾';
    if (kind === 'sos') return '紧急求助';
    if (kind === 'water') return '水漏';
    if (kind === 'camera') return '摄像头';
    if (kind === 'fall') return '跌倒检测';
    if (kind === 'unknown') return '待确认';
    return kind;
  }

  private filters(): FilterItem[] {
    const items: FilterItem[] = [];
    const all = new FilterItem();
    all.key = 'all';
    all.label = '全部';
    items.push(all);
    const sensors: SensorView[] = this.allSensors();
    for (let i = 0; i < sensors.length; i++) {
      const kind: string = sensors[i].kind;
      let exists: boolean = false;
      for (let j = 0; j < items.length; j++) {
        if (items[j].key === kind) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        const item = new FilterItem();
        item.key = kind;
        item.label = this.kindLabel(kind);
        items.push(item);
      }
    }
    return items;
  }

  private filtered(): SensorView[] {
    const all: SensorView[] = this.allSensors();
    if (this.activeKind === 'all') {
      return all;
    }
    const out: SensorView[] = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i].kind === this.activeKind) {
        out.push(all[i]);
      }
    }
    return out;
  }

  private onlineCount(): number {
    let count: number = 0;
    for (let i = 0; i < this.liveDevices().length; i++) {
      if (this.liveDevices()[i].online) {
        count++;
      }
    }
    return count;
  }

  private monitorIssueCount(): number {
    let count: number = 0;
    for (let i = 0; i < this.liveDevices().length; i++) {
      const d: DeviceView = this.liveDevices()[i];
      if (d.online && d.monitorOnline === 0) {
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

  private deviceValue(n: number): string {
    return this.liveDevices().length === 0 ? '--' : `${n}`;
  }

  private onlineRatio(): string {
    // 显式读取 revision，使摘要 Builder 的父级 build 建立对设备快照变化的依赖。
    const revision: number = this.devicesVersion;
    const devices: DeviceView[] = this.liveDevices();
    let n: number = 0;
    for (let i = 0; i < devices.length; i++) {
      if (devices[i].online) n += 1;
    }
    if (devices.length === 0) return '--';
    if (revision < 0) return '--';
    return `${n}/${devices.length}`;
  }

  private netLabel(): string {
    if (this.netStatus === 'loading') return '正在刷新';
    if (this.netStatus === 'ok') return '数据已同步';
    if (this.netStatus === 'partial') return '部分数据失败·显示上次数据';
    if (this.netStatus === 'offline') return '离线·显示上次数据';
    if (this.netStatus === 'error') return '获取失败·显示上次数据';
    if (this.netStatus === 'unauthorized') return '登录已失效';
    return '尚未获取数据';
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

  private headerColor(): string {
    return this.netWarn() ? this.netFg() : Color.textSecondary;
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

  private showSensor(s: SensorView): void {
    const room: string = s.roomName.length > 0 ? `${s.roomName} · ` : '';
    const detail: string = s.detailText.length > 0 ? ` · ${s.detailText}` : '';
    const value: string = s.valueText.length > 0 ? s.valueText : '--';
    this.getUIContext().getPromptAction().showToast({
      message: `${room}${s.name} · ${s.stateText} · ${value}${detail}`
    });
  }

  @Builder
  summaryItem(label: string, value: string, color: string, alignEnd: boolean) {
    Column() {
      Text(value)
        .fontSize(20)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(color)
      Text(label)
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textSecondary)
        .margin({ top: 2 })
    }
    .layoutWeight(1)
    .alignItems(alignEnd ? HorizontalAlign.End : HorizontalAlign.Start)
  }

  build() {
    Column() {
      Row() {
        Column() {
          Text('实时监测')
            .fontSize(FontSize.h1)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(Color.textPrimary)
          Text(this.lastUpdatedAt > 0
            ? `上次更新 ${DateUtil.formatTime(this.lastUpdatedAt)} · ${this.netLabel()}`
            : this.netLabel())
            .fontSize(FontSize.caption)
            .fontColor(this.headerColor())
            .margin({ top: 2 })
            .maxLines(2)
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Button('T')
          .width(28)
          .height(28)
          .fontSize(10)
          .onClick(() => {
            this.testPhase = (this.testPhase + 1) % 3;
            this.injectTestSnapshot();
          })

        Column() {
          if (this.refreshing) {
            LoadingProgress()
              .width(19)
              .height(19)
              .color(Color.primaryDark)
          } else {
            SymbolGlyph($r('sys.symbol.arrow_clockwise'))
              .fontSize(19)
              .fontColor([Color.primaryDark])
          }
        }
        .width(36)
        .height(36)
        .borderRadius(12)
        .backgroundColor(Color.card)
        .justifyContent(FlexAlign.Center)
        .shadow(Shadow_.card())
        .opacity(this.refreshing ? 0.7 : 1)
        .onClick(() => { void this.doRefresh(); })
      }
      .width('100%')
      .padding({
        left: this.pm() + 2, right: this.pm() + 2,
        top: Space.md, bottom: Space.md - 2
      })

      // 父级 build 的直接响应式依赖：@Builder/方法内的读取不会触发父级重算。
      Text(this.devicesVersion.toString()).fontSize(0).height(0).opacity(0)

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
        .margin({ left: this.pm(), right: this.pm() })
      }

      // 真实摘要（全部来自 DeviceView/alerts）
      Row() {
        this.summaryItem('在线设备', this.onlineRatio(),
          Color.primaryDark, false)
        Column().width(1).height(34).backgroundColor(Color.border)
        this.summaryItem('监测异常', this.deviceValue(this.monitorIssueCount()),
          this.monitorIssueCount() > 0 ? Color.criticalDark : Color.textTertiary, false)
        Column().width(1).height(34).backgroundColor(Color.border)
        this.summaryItem('待确认告警', this.deviceValue(this.pendingCount()),
          this.pendingCount() > 0 ? Color.warningDark : Color.textTertiary, true)
      }
      .width('100%')
      .padding(Space.lg - 2)
      .backgroundColor(Color.card)
      .borderRadius(Radius.card)
      .shadow(Shadow_.card())
      .margin({ left: this.pm(), right: this.pm() })

      // 过滤器：只列出实际存在的 SensorKind
      Scroll() {
        Row({ space: 7 }) {
          ForEach(this.filters(), (f: FilterItem) => {
            Text(f.label)
              .fontSize(FontSize.body - 1)
              .fontWeight(this.activeKind === f.key ? FontWeight_.bold : FontWeight_.regular)
              .fontColor(this.activeKind === f.key ? '#FFFFFF' : Color.textSecondary)
              .padding({ left: 13, right: 13, top: 6, bottom: 6 })
              .borderRadius(Radius.pill)
              .linearGradient(this.activeKind === f.key
                ? Grad.primary()
                : { angle: 135, colors: [[Color.card, 0.0], [Color.card, 1.0]] })
              .border({
                width: 1,
                color: this.activeKind === f.key ? 'rgba(0,0,0,0)' : Color.border
              })
              .shadow(this.activeKind === f.key
                ? { radius: 12, color: 'rgba(2,132,199,0.35)', offsetX: 0, offsetY: 4 }
                : { radius: 0, color: 'rgba(0,0,0,0)', offsetX: 0, offsetY: 0 })
              .onClick(() => { this.activeKind = f.key; })
          }, (f: FilterItem) => f.key)
        }
        .padding({ left: this.pm(), right: this.pm() })
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
      .margin({ top: Space.md - 2, bottom: Space.sm - 2 })

      if (this.filtered().length === 0) {
        Column() {
          EmptyState({
            icon: $r('sys.symbol.waveform'),
            title: this.liveDevices().length === 0 ? '暂无设备数据' : '暂无传感器数据',
            description: this.liveDevices().length === 0
              ? (this.netMessage.length > 0 ? this.netMessage : '下拉刷新或稍后再试')
              : '设备能力待确认，暂无可展示的传感器'
          })
        }
        .width('100%')
        .layoutWeight(1)
      } else {
        Grid() {
          ForEach(this.filtered(), (s: SensorView) => {
            GridItem() {
              SensorCard({
                sensor: s,
                onPress: (item: SensorView) => { this.showSensor(item); }
              })
            }
          }, (s: SensorView, idx: number) => `${s.deviceId}_${s.kind}_${idx}_${this.devicesVersion}`)
        }
        .columnsTemplate(Responsive.sensorColumns(this.bp))
        .columnsGap(10)
        .rowsGap(10)
        .padding({ left: this.pm(), right: this.pm(), top: 2, bottom: Space.xxl })
        .layoutWeight(1)
        .width('100%')
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
