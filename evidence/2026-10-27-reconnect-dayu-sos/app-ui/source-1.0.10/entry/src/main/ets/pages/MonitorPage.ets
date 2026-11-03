/**
 * 实时监测页 —— 真实设备/传感器数据（AppStorage gv.*），按房间分组
 * - 只展示 gv.devices（已核实家庭设备）的传感器，未识别后端记录不参与
 * - 不自建 30s 定时器，自动刷新由 Index/GuardianService 统一负责
 * - 手动刷新真实调用 GuardianService.refreshAll()，await + 防重复
 * - 仅展示 DeviceView.sensors 的真实字段，不编造“已刷新/正常”
 * - 筛选 chip 使用纯色/描边激活态，不使用 linearGradient（曾渲染出异常青色三角）
 */
import { Color, FontSize, FontWeight_, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { SensorCard } from '../components/SensorCard';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { AlertView, DeviceView, RoomView, RunMode, SensorView } from '../core/view/Models';
import { GuardianService } from '../service/GuardianService';

class FilterItem {
  key: string = '';
  label: string = '';
}

/** 房间分组：房间标题 + 在线数/设备数 + 该房间传感器的真实瓦片。 */
class RoomSection {
  key: string = '';
  name: string = '';
  onlineCount: number = 0;
  deviceCount: number = 0;
  sensors: SensorView[] = [];
}

@Component
export struct MonitorPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.devices') devices: DeviceView[] = [];
  @StorageLink('gv.rooms') rooms: RoomView[] = [];
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.netStatus') netStatus: string = 'unknown';
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @State activeKind: string = 'all';
  @State refreshing: boolean = false;

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private allSensors(): SensorView[] {
    const out: SensorView[] = [];
    for (let i = 0; i < this.devices.length; i++) {
      const list: SensorView[] = this.devices[i].sensors;
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
    if (kind === 'camera') return '摄像头检测';
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

  /** 某个设备集合下、通过当前类型筛选的传感器（只来自 gv.devices）。 */
  private sensorsOf(deviceList: DeviceView[]): SensorView[] {
    const out: SensorView[] = [];
    for (let i = 0; i < deviceList.length; i++) {
      const list: SensorView[] = deviceList[i].sensors;
      for (let j = 0; j < list.length; j++) {
        if (this.activeKind === 'all' || list[j].kind === this.activeKind) {
          out.push(list[j]);
        }
      }
    }
    return out;
  }

  private makeSection(key: string, name: string, deviceList: DeviceView[]): RoomSection {
    const sec = new RoomSection();
    sec.key = key;
    sec.name = name.length > 0 ? name : '未分配房间';
    sec.deviceCount = deviceList.length;
    let online: number = 0;
    for (let i = 0; i < deviceList.length; i++) {
      if (deviceList[i].online) {
        online++;
      }
    }
    sec.onlineCount = online;
    sec.sensors = this.sensorsOf(deviceList);
    return sec;
  }

  /**
   * 按房间分组：房间顺序来自 gv.rooms（只含家庭房间）；
   * rooms 请求失败时用设备自身 roomName 兜底合成分组，仍然只展示 gv.devices。
   * 当前类型筛选下没有传感器的房间不显示（避免空 section 堆叠）。
   */
  private roomSections(): RoomSection[] {
    const sections: RoomSection[] = [];
    const covered: Set<string> = new Set<string>();
    for (let i = 0; i < this.rooms.length; i++) {
      const room: RoomView = this.rooms[i];
      if (room.devices.length === 0) {
        continue;
      }
      for (let j = 0; j < room.devices.length; j++) {
        covered.add(room.devices[j].deviceId);
      }
      const sec: RoomSection = this.makeSection(
        room.id.length > 0 ? room.id : `room_${i}`, room.name, room.devices);
      if (sec.sensors.length > 0) {
        sections.push(sec);
      }
    }
    const order: string[] = [];
    const groups: Map<string, DeviceView[]> = new Map<string, DeviceView[]>();
    for (let i = 0; i < this.devices.length; i++) {
      const d: DeviceView = this.devices[i];
      if (covered.has(d.deviceId)) {
        continue;
      }
      const key: string = d.roomName.length > 0 ? d.roomName : '未分配房间';
      let list: DeviceView[] | undefined = groups.get(key);
      if (list === undefined) {
        const created: DeviceView[] = [];
        groups.set(key, created);
        order.push(key);
        list = created;
      }
      list.push(d);
    }
    for (let i = 0; i < order.length; i++) {
      const name: string = order[i];
      const list: DeviceView[] | undefined = groups.get(name);
      if (list === undefined || list.length === 0) {
        continue;
      }
      const sec: RoomSection = this.makeSection(`fallback_${i}`, name, list);
      if (sec.sensors.length > 0) {
        sections.push(sec);
      }
    }
    return sections;
  }

  /** 弹性卡片列宽：手机 2 列 / 折叠展开 3 列 / 平板 4 列（与 Responsive 断点一致）。 */
  private cardWidth(): string {
    if (this.bp === Responsive.BP_LG) {
      return '23.5%';
    }
    if (this.bp === Responsive.BP_MD) {
      return '32%';
    }
    return '48.5%';
  }

  private onlineCount(): number {
    let count: number = 0;
    for (let i = 0; i < this.devices.length; i++) {
      if (this.devices[i].online) {
        count++;
      }
    }
    return count;
  }

  private monitorIssueCount(): number {
    let count: number = 0;
    for (let i = 0; i < this.devices.length; i++) {
      const d: DeviceView = this.devices[i];
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
    return this.devices.length === 0 ? '--' : `${n}`;
  }

  private onlineRatio(): string {
    if (this.devices.length === 0) {
      return '--';
    }
    return `${this.onlineCount()}/${this.devices.length}`;
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

  @Builder
  roomSection(sec: RoomSection) {
    Column() {
      Row() {
        Column() {
          Text(sec.name)
            .fontSize(FontSize.h3)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textPrimary)
            .lineHeight(18)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(`在线 ${sec.onlineCount}/${sec.deviceCount} 台设备`)
            .fontSize(FontSize.mini)
            .fontColor(sec.onlineCount === sec.deviceCount ? Color.successDark : Color.warningDark)
            .lineHeight(13)
            .margin({ top: 2 })
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Text(sec.onlineCount === sec.deviceCount ? '全部在线' : '有设备离线')
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.semibold)
          .fontColor(sec.onlineCount === sec.deviceCount ? Color.successDark : Color.warningDark)
          .padding({ left: 8, right: 8, top: 3, bottom: 3 })
          .backgroundColor(sec.onlineCount === sec.deviceCount ? Color.successLight : Color.warningLight)
          .borderRadius(Radius.pill)
          .maxLines(1)
      }
      .width('100%')

      Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.SpaceBetween }) {
        ForEach(sec.sensors, (s: SensorView) => {
          Column() {
            SensorCard({
              sensor: s,
              onPress: (item: SensorView) => { this.showSensor(item); }
            })
          }
          .width(this.cardWidth())
          .margin({ bottom: 10 })
        }, (s: SensorView) => `${s.deviceId}_${s.kind}_${s.stateText}_${s.valueText}_${s.detailText}`)
      }
      .width('100%')
      .margin({ top: Space.sm })
    }
    .width('100%')
    .padding({ top: Space.md, bottom: Space.sm })
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
        Column() {
          Text(this.onlineRatio())
            .fontSize(20)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(Color.primaryDark)
          Text('在线设备')
            .fontSize(FontSize.caption - 0.5)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
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

      // 过滤器：只列出实际存在的 SensorKind。激活态用纯色底 + 蓝色描边，
      // 不使用 linearGradient（部分模拟器上会渲染出异常青色三角）。
      Scroll() {
        Row({ space: 7 }) {
          ForEach(this.filters(), (f: FilterItem) => {
            Text(f.label)
              .fontSize(FontSize.body - 1)
              .fontWeight(this.activeKind === f.key ? FontWeight_.bold : FontWeight_.regular)
              .fontColor(this.activeKind === f.key ? Color.primaryDark : Color.textSecondary)
              .lineHeight(14)
              .maxLines(1)
              .padding({ left: 14, right: 14, top: 15, bottom: 15 })
              .borderRadius(Radius.pill)
              .backgroundColor(this.activeKind === f.key ? Color.primaryLight : Color.card)
              .border({
                width: 1,
                color: this.activeKind === f.key ? Color.primary : Color.border
              })
              .onClick(() => { this.activeKind = f.key; })
          }, (f: FilterItem) => f.key)
        }
        .padding({ left: this.pm(), right: this.pm() })
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
      .margin({ top: Space.md - 2, bottom: Space.sm - 2 })

      if (this.roomSections().length === 0) {
        Column() {
          EmptyState({
            icon: $r('sys.symbol.waveform'),
            title: this.devices.length === 0
              ? '暂无设备数据'
              : (this.allSensors().length === 0 ? '暂无传感器数据' : '当前筛选下暂无数据'),
            description: this.devices.length === 0
              ? (this.netMessage.length > 0 ? this.netMessage : '工作台尚未获取到家庭设备，请下拉刷新或稍后再试')
              : (this.allSensors().length === 0
                ? '已核实设备暂未上报可展示的传感器读数，不显示估算值'
                : '该类型传感器当前没有可展示读数，可切回“全部”查看')
          })
        }
        .width('100%')
        .layoutWeight(1)
      } else {
        Scroll() {
          Column() {
            ForEach(this.roomSections(), (sec: RoomSection) => {
              this.roomSection(sec)
            }, (sec: RoomSection) => `${sec.key}_${sec.deviceCount}_${sec.onlineCount}_${sec.sensors.length}`)
          }
          .width('100%')
          .padding({ left: this.pm(), right: this.pm(), bottom: Space.xxl })
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
