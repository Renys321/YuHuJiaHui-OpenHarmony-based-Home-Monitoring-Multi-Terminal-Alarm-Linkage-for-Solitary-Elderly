/**
 * 设备管理页 —— 真实设备数据（AppStorage gv.*）
 * - 只展示已核实家庭设备（厨房 / 卫生间 / 客厅 / 随身求助），按房间 / 场景分组；
 *   后端其余记录单列“未纳入监护的后端记录”，不计入在线统计、不作为告警依据、不删除记录。
 * - online 与 monitorOnline 分开表达，不用“在线”掩盖监测异常/监测状态未知
 * - 电量：全部板卡无电池电压采样电路 / 固件采样，统一显示“该设备未接入电量检测”+ 原因，不显示百分比
 * - 不显示虚构的网关性能/信号百分比；csq 0-31 映射信号格，99/缺失显示“未知”
 * - 添加设备/一键自检无对应后端接口 → 明确“未开放”，不做成可点击的成功动作
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { DemoModeBar } from '../components/DemoModeBar';
import { Medal } from '../components/Medal';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { DeviceView, DoorEventView, RoomView, RunMode, SensorView } from '../core/view/Models';
import { householdInventory, InventoryEntry, inventoryEntryFor, inventoryScopeText, unrecognizedReasonFor } from '../core/inventory/DeviceInventory';
import { GuardianService } from '../service/GuardianService';

/** 家庭设备分组：一个已核实房间 / 佩戴场景。 */
class DeviceSceneGroup {
  key: string = '';
  name: string = '';
  role: string = '';
  devices: DeviceView[] = [];
}

@Entry
@Component
struct DevicePage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.devices') devices: DeviceView[] = [];
  @StorageLink('gv.unrecognizedDevices') unrecognizedDevices: DeviceView[] = [];
  @StorageLink('gv.rooms') rooms: RoomView[] = [];
  @StorageLink('gv.netStatus') netStatus: string = 'unknown';
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @StorageLink('gv.doorEvents') doorEvents: DoorEventView[] = [];
  @StorageLink('gv.doorEventsStatus') doorEventsStatus: string = '';
  @StorageLink('gv.doorEventsMessage') doorEventsMessage: string = '';
  @State refreshing: boolean = false;
  /** “未纳入监护的后端记录”默认折叠，避免与家庭设备混淆。 */
  @State unrecognizedExpanded: boolean = false;

  private pm(): number {
    return Responsive.pageMargin(this.bp);
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

  private offlineCount(): number {
    return this.devices.length - this.onlineCount();
  }

  private statusText(d: DeviceView): string {
    if (!d.online) return '离线';
    if (d.monitorOnline === 0) return '在线 · 监测异常';
    if (d.monitorOnline === -1) return '在线 · 监测状态未知';
    return '在线 · 监测正常';
  }

  private statusFg(d: DeviceView): string {
    if (!d.online) return Color.textTertiary;
    if (d.monitorOnline === 0) return Color.criticalDark;
    if (d.monitorOnline === -1) return Color.warningDark;
    return Color.successDark;
  }

  private statusBg(d: DeviceView): string {
    if (!d.online) return '#F1F5F9';
    if (d.monitorOnline === 0) return Color.criticalLight;
    if (d.monitorOnline === -1) return Color.warningLight;
    return Color.successLight;
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

  private csqKnown(csq: number): boolean {
    return csq >= 0 && csq !== 99;
  }

  private signalBars(csq: number): number {
    if (!this.csqKnown(csq)) return -1;
    if (csq === 0) return 0;
    const bars: number = Math.ceil(csq / 31 * 4);
    return bars < 1 ? 1 : (bars > 4 ? 4 : bars);
  }

  private sensorFg(state: string): string {
    if (state === 'critical') return Color.criticalDark;
    if (state === 'attention' || state === 'invalid') return Color.warningDark;
    if (state === 'ok') return Color.successDark;
    if (state === 'waiting') return Color.primaryDark;
    return Color.textSecondary;
  }

  private sensorBg(state: string): string {
    if (state === 'critical') return Color.criticalLight;
    if (state === 'attention' || state === 'invalid') return Color.warningLight;
    if (state === 'ok') return Color.successLight;
    if (state === 'waiting') return Color.primaryLight;
    return '#F1F5F9';
  }

  /** 设备所属房间/场景：优先已核实台账，其次后端房间；都没有则如实写“未分配房间”。 */
  private sceneLabelOf(d: DeviceView): string {
    const entry: InventoryEntry | null = inventoryEntryFor(d.deviceId);
    if (entry !== null && entry.roomLabel.length > 0) {
      return entry.roomLabel;
    }
    if (d.roomName.length > 0) {
      return d.roomName;
    }
    if (d.roomId.length > 0) {
      for (let i = 0; i < this.rooms.length; i++) {
        if (this.rooms[i].id === d.roomId && this.rooms[i].name.length > 0) {
          return this.rooms[i].name;
        }
      }
    }
    return '未分配房间';
  }

  /** 家庭设备按已核实房间/场景分组（清单顺序：厨房 → 卫生间 → 客厅 → 随身求助）。 */
  private sceneGroups(): DeviceSceneGroup[] {
    const groups: DeviceSceneGroup[] = [];
    const inventory: InventoryEntry[] = householdInventory();
    for (let i = 0; i < inventory.length; i++) {
      const entry: InventoryEntry = inventory[i];
      const matched: DeviceView[] = [];
      for (let j = 0; j < this.devices.length; j++) {
        if (this.devices[j].deviceId === entry.deviceId) {
          matched.push(this.devices[j]);
        }
      }
      if (matched.length === 0) {
        continue;
      }
      const group = new DeviceSceneGroup();
      group.key = `scene_${entry.deviceId}`;
      group.name = entry.roomLabel.length > 0 ? entry.roomLabel : entry.displayName;
      group.role = entry.role;
      group.devices = matched;
      groups.push(group);
    }
    // 兜底：家庭设备里若出现未登记 ID，单独分组，不伪造房间。
    const leftovers: DeviceView[] = [];
    for (let i = 0; i < this.devices.length; i++) {
      let known: boolean = false;
      for (let j = 0; j < inventory.length; j++) {
        if (inventory[j].deviceId === this.devices[i].deviceId) {
          known = true;
          break;
        }
      }
      if (!known) {
        leftovers.push(this.devices[i]);
      }
    }
    for (let i = 0; i < leftovers.length; i++) {
      const item: DeviceView = leftovers[i];
      const group = new DeviceSceneGroup();
      group.key = `scene_unknown_${item.deviceId}`;
      group.name = this.sceneLabelOf(item);
      group.role = item.inventoryRole.length > 0 ? item.inventoryRole : '未登记设备';
      group.devices = [item];
      groups.push(group);
    }
    return groups;
  }

  /** 设备清单口径：真实模式用已核实台账，演示模式明确标注示例数据。 */
  private scopeText(): string {
    if (this.mode === RunMode.DEMO) {
      return '演示模式：本页设备为本地示例数据，不对应真实家庭设备，不连接真实设备、不发送命令。';
    }
    return inventoryScopeText();
  }

  /** 设备状态补充说明：区分“离线”“无历史读数”，不把离线设备的旧读数当成当前状态。 */
  private stateNote(d: DeviceView): string {
    if (!d.online) {
      return d.hasReading
        ? '设备离线，展示的是最后一次上报的历史读数，不代表当前状态。'
        : '设备离线，且没有可展示的历史读数。';
    }
    if (!d.hasReading) {
      return '设备在线，但最近上报中没有可展示的读数。';
    }
    return '';
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
        this.getUIContext().getPromptAction().showToast({ message: '设备数据已刷新' });
      }
      // 刷新成功后同步加载门磁开关记录（找到首个装门磁的设备；失败保留上次记录与提示）。
      await this.loadDoorEventsForDevices();
    } catch (err) {
      this.getUIContext().getPromptAction().showToast({ message: '刷新失败，请检查网络后重试' });
    } finally {
      this.refreshing = false;
    }
  }

  /** 首个装有门磁的设备 ID（用于加载"最近开关记录"）；无则返回空串。 */
  private firstDoorDeviceId(): string {
    for (let i = 0; i < this.devices.length; i++) {
      const sensors: SensorView[] = this.devices[i].sensors;
      for (let j = 0; j < sensors.length; j++) {
        if (sensors[j].kind === 'door') {
          return this.devices[i].deviceId;
        }
      }
    }
    return '';
  }

  /** 该设备是否装有门磁传感器。 */
  private hasDoorSensor(d: DeviceView): boolean {
    const sensors: SensorView[] = d.sensors;
    for (let i = 0; i < sensors.length; i++) {
      if (sensors[i].kind === 'door') {
        return true;
      }
    }
    return false;
  }

  /** 当前设备的门磁事件（按后端顺序最新在前，最多 5 条）。 */
  private doorEventsOf(d: DeviceView): DoorEventView[] {
    const result: DoorEventView[] = [];
    for (let i = 0; i < this.doorEvents.length; i++) {
      if (this.doorEvents[i].deviceId === d.deviceId) {
        result.push(this.doorEvents[i]);
        if (result.length >= 5) {
          break;
        }
      }
    }
    return result;
  }

  private async loadDoorEventsForDevices(): Promise<void> {
    const deviceId: string = this.firstDoorDeviceId();
    if (deviceId.length === 0) {
      return;
    }
    const outcome = await GuardianService.loadDoorEvents(deviceId, 10);
    if (!outcome.ok && outcome.kind !== 'stale' && outcome.message.length > 0) {
      // 失败时保留上一次成功加载的记录，仅更新提示文案（不冒充成功）。
      this.getUIContext().getPromptAction().showToast({ message: outcome.message });
    }
  }

  @Builder
  summaryCell(label: string, value: string, color: string, alignEnd: boolean) {
    Column() {
      Text(value)
        .fontSize(18)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(color)
      Text(label)
        .fontSize(FontSize.mini)
        .fontColor(Color.textSecondary)
        .margin({ top: 2 })
    }
    .layoutWeight(1)
    .alignItems(alignEnd ? HorizontalAlign.End : HorizontalAlign.Start)
  }

  @Builder
  signalBarsView(csq: number) {
    Row() {
      if (this.csqKnown(csq)) {
        ForEach([1, 2, 3, 4], (n: number) => {
          Column()
            .width(2.5)
            .height(4 + n * 2)
            .borderRadius(1)
            .backgroundColor(n <= this.signalBars(csq) ? Color.textSecondary : Color.border)
            .margin({ right: 1.5 })
        }, (n: number) => `sig_${n}`)
        Text(`${csq}`)
          .fontSize(FontSize.mini - 0.5)
          .fontColor(Color.textTertiary)
          .margin({ left: 3 })
      } else {
        Text('信号未知')
          .fontSize(FontSize.mini - 0.5)
          .fontColor(Color.textTertiary)
      }
    }
    .alignItems(VerticalAlign.Bottom)
  }

  private sensorValueColor(state: string): string {
    if (state === 'critical') return Color.criticalDark;
    if (state === 'attention' || state === 'invalid') return Color.warningDark;
    if (state === 'waiting') return Color.primaryDark;
    return Color.textPrimary;
  }

  @Builder
  sensorRow(s: SensorView, index: number, total: number) {
    Column() {
      Row() {
        Text(s.name.length > 0 ? s.name : s.kind)
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(s.stateText.length > 0 ? s.stateText : '待确认')
          .fontSize(FontSize.mini - 1)
          .fontWeight(FontWeight_.bold)
          .fontColor(this.sensorFg(s.state))
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor(this.sensorBg(s.state))
          .borderRadius(Radius.pill)
          .maxLines(1)
          .margin({ left: 6 })
      }
      .width('100%')

      Text(s.valueText.length > 0 ? s.valueText : '--')
        .fontSize(FontSize.body)
        .fontWeight(FontWeight_.bold)
        .fontColor(this.sensorValueColor(s.state))
        .lineHeight(19)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: 3 })

      if (s.detailText.length > 0) {
        Text(s.detailText)
          .fontSize(FontSize.mini)
          .fontColor(Color.textSecondary)
          .lineHeight(14)
          .maxLines(3)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 2 })
      }
    }
    .width('100%')
    .padding({ top: Space.sm, bottom: Space.sm })
    .border({
      width: { bottom: index < total - 1 ? 1 : 0 },
      color: Color.border
    })
  }

  @Builder
  sensorChips(d: DeviceView) {
    Column() {
      ForEach(d.sensors, (s: SensorView, index: number) => {
        this.sensorRow(s, index, d.sensors.length)
      }, (s: SensorView) => `${d.deviceId}_${s.id}_${s.stateText}_${s.valueText}_${s.detailText}`)
    }
    .width('100%')
    .margin({ top: Space.xs })
  }

  /** 设备卡片内的"最近开关记录"区块（仅门磁设备显示）。 */
  @Builder
  doorEventSection(d: DeviceView) {
    Column() {
      Row() {
        Column().width(3).height(11).borderRadius(2).linearGradient(Grad.primary()).margin({ right: 6 })
        Text('最近开关记录')
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
      }
      .width('100%')
      .margin({ top: Space.md - 1, bottom: 3 })

      if (this.doorEventsStatus === 'ok' && this.doorEventsOf(d).length === 0) {
        Text('暂无开关记录')
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textTertiary)
          .lineHeight(15)
      } else if (this.doorEventsStatus === 'ok') {
        ForEach(this.doorEventsOf(d), (ev: DoorEventView) => {
          Row() {
            Text(ev.actionText)
              .fontSize(FontSize.caption - 0.5)
              .fontWeight(FontWeight_.bold)
              .fontColor(ev.openPresent && ev.open ? Color.warningDark : Color.textSecondary)
            Blank()
            Text(ev.timeText)
              .fontSize(FontSize.caption - 1)
              .fontColor(Color.textTertiary)
              .maxLines(1)
          }
          .width('100%')
          .padding({ top: 2, bottom: 2 })
        }, (ev: DoorEventView) => `${ev.deviceId}_${ev.eventId}`)
      } else if (this.doorEventsStatus.length > 0 && this.doorEventsStatus !== 'demo_mode') {
        Text(this.doorEventsMessage.length > 0 ? this.doorEventsMessage : '开关记录未加载')
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.warningDark)
          .lineHeight(15)
          .maxLines(2)
      } else {
        Text('暂无开关记录')
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textTertiary)
          .lineHeight(15)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  deviceCard(d: DeviceView) {
    Column() {
      Row() {
        Column() {
          SymbolGlyph($r('sys.symbol.waveform'))
            .fontSize(19)
            .fontColor([d.online ? Color.primaryDark : Color.textTertiary])
        }
        .width(42)
        .height(42)
        .borderRadius(15)
        .backgroundColor(d.online ? Color.primaryLight : '#F1F5F9')
        .justifyContent(FlexAlign.Center)
        .margin({ right: 11 })

        Column() {
          Row() {
            Text(d.name.length > 0 ? d.name : d.deviceId)
              .fontSize(FontSize.body + 0.5)
              .fontWeight(FontWeight_.bold)
              .fontColor(d.online ? Color.textPrimary : Color.textSecondary)
              .layoutWeight(1)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.statusText(d))
              .fontSize(FontSize.mini - 0.5)
              .fontWeight(FontWeight_.bold)
              .fontColor(this.statusFg(d))
              .padding({ left: 6, right: 6, top: 2, bottom: 2 })
              .borderRadius(Radius.pill)
              .backgroundColor(this.statusBg(d))
              .maxLines(1)
          }
          .width('100%')

          Text(`已核实位置：${this.sceneLabelOf(d)} · 设备ID ${d.deviceId}`)
            .fontSize(FontSize.caption - 0.5)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')

      // 状态补充：未分配房间 / 离线 / 无历史读数 / 未配置传感器分别如实标注。
      this.deviceStatusChips(d)

      // 已核实能力摘要（来自 DeviceView.capabilitySummary/capabilityNote）
      Row() {
        Text(d.capabilityVerified ? '能力已核实' : '能力待确认')
          .fontSize(FontSize.mini - 1)
          .fontColor(d.capabilityVerified ? Color.primaryDark : Color.warningDark)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor(d.capabilityVerified ? Color.primaryLight : Color.warningLight)
          .borderRadius(Radius.pill)
        Text(d.stateText.length > 0 ? `设备状态 ${d.stateText}` : '设备状态未知')
          .fontSize(FontSize.mini - 1)
          .fontColor(Color.textSecondary)
          .margin({ left: 6 })
          .maxLines(1)
      }
      .width('100%')
      .margin({ top: Space.sm })

      Text(`已启用能力：${d.capabilitySummary.length > 0 ? d.capabilitySummary : '暂无已核实能力'}`)
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textPrimary)
        .lineHeight(15)
        .margin({ top: Space.xs + 1 })
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (d.capabilityNote.length > 0) {
        Text(`能力核对：${d.capabilityNote}`)
          .fontSize(FontSize.mini)
          .fontColor(Color.textSecondary)
          .lineHeight(14)
          .margin({ top: 3 })
          .maxLines(8)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      if (d.inventorySource.length > 0) {
        Text(`台账来源：${d.inventorySource}`)
          .fontSize(FontSize.mini - 1)
          .fontColor(Color.textTertiary)
          .lineHeight(13)
          .margin({ top: 3 })
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }

      if (d.sensors.length > 0) {
        this.sensorChips(d)
      }

      // 门磁设备：最近开关记录（真实台账；无记录显示"暂无开关记录"，不伪造）。
      if (this.hasDoorSensor(d)) {
        this.doorEventSection(d)
      }

      // 电量：无真实采样，只显示“该设备未接入电量检测”+原因，不显示任何百分比。
      this.batteryBlock(d)

      Row() {
        this.signalBarsView(d.csq)
        Blank()
        Text(`最近上报：${d.lastSeenText.length > 0 ? d.lastSeenText : '时间未知'}`)
          .fontSize(FontSize.mini - 0.5)
          .fontColor(Color.textTertiary)
          .maxLines(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Bottom)
      .margin({ top: Space.sm })

      if (this.stateNote(d).length > 0) {
        Text(this.stateNote(d))
          .fontSize(FontSize.mini - 1)
          .fontColor(Color.warningDark)
          .lineHeight(13)
          .margin({ top: 3 })
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor(Color.card)
    .borderRadius(Radius.tile)
    .shadow(Shadow_.card())
    .opacity(d.online ? 1 : 0.78)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  statusChip(label: string, fg: string, bg: string) {
    Text(label)
      .fontSize(FontSize.mini - 1)
      .fontColor(fg)
      .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      .backgroundColor(bg)
      .borderRadius(Radius.pill)
      .maxLines(1)
      .margin({ right: 5, top: 3 })
  }

  /** 未分配房间 / 离线 / 无历史读数 / 未配置传感器：分别如实标注，不互相替代。 */
  @Builder
  deviceStatusChips(d: DeviceView) {
    Row() {
      if (!d.roomAssigned) {
        this.statusChip('后端未分配房间', Color.warningDark, Color.warningLight)
      }
      if (!d.online) {
        this.statusChip('离线', Color.textSecondary, '#F1F5F9')
      }
      if (!d.hasReading) {
        this.statusChip('无历史读数', '#92400E', Color.warningLight)
      }
      if (d.sensors.length === 0) {
        this.statusChip('未配置传感器', Color.textSecondary, '#F1F5F9')
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
  }

  /** 电量真实能力：本轮无任何板卡接入电压采样，只显示固定结论与硬件原因。 */
  @Builder
  batteryBlock(d: DeviceView) {
    Row() {
      SymbolGlyph($r('sys.symbol.info_circle'))
        .fontSize(12)
        .fontColor([Color.textSecondary])
        .margin({ top: 1 })
      Column() {
        Text(d.batteryStateText.length > 0 ? d.batteryStateText : '该设备未接入电量检测')
          .fontSize(FontSize.caption - 0.5)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (d.batteryDetail.length > 0) {
          Text(d.batteryDetail)
            .fontSize(FontSize.mini - 0.5)
            .fontColor(Color.textSecondary)
            .lineHeight(13)
            .margin({ top: 1 })
            .maxLines(3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 5 })
    }
    .width('100%')
    .padding({ left: 8, right: 8, top: 6, bottom: 6 })
    .backgroundColor('#F1F5F9')
    .borderRadius(Radius.chip)
    .alignItems(VerticalAlign.Top)
    .margin({ top: Space.sm })
  }

  /** 一个房间/场景分组：分组标题 + 该场景下的家庭设备卡片。 */
  @Builder
  sceneSection(group: DeviceSceneGroup) {
    Column() {
      Row() {
        Column().width(3).height(13).borderRadius(2).linearGradient(Grad.primary()).margin({ right: 7 })
        Column() {
          Text(group.name)
            .fontSize(FontSize.h3)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textPrimary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (group.role.length > 0) {
            Text(group.role)
              .fontSize(FontSize.mini)
              .fontColor(Color.textSecondary)
              .margin({ top: 1 })
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        .margin({ right: Space.sm })

        Text(`${group.devices.length} 台`)
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textTertiary)
          .maxLines(1)
      }
      .width('100%')
      .padding({ left: this.pm() + 2, right: this.pm() + 2, top: Space.lg - 4, bottom: Space.xs + 2 })

      Column({ space: 9 }) {
        ForEach(group.devices, (d: DeviceView) => {
          this.deviceCard(d)
        }, (d: DeviceView) => `${group.key}_${d.deviceId}_${d.lastSeenTs}_${d.online}`)
      }
      .padding({ left: this.pm(), right: this.pm() })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  /** 未纳入监护的后端记录逐条展示（只如实列出，不删除、不计入统计）。 */
  @Builder
  unrecognizedCard(d: DeviceView) {
    Column() {
      Row() {
        Text(d.name.length > 0 ? d.name : d.deviceId)
          .fontSize(FontSize.body)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text('未纳入监护')
          .fontSize(FontSize.mini - 1)
          .fontColor(Color.textSecondary)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor('#F1F5F9')
          .borderRadius(Radius.pill)
          .maxLines(1)
      }
      .width('100%')

      Text(`设备ID：${d.deviceId} · 后端房间：${d.roomName.length > 0 ? d.roomName : '未分配房间'}`)
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textSecondary)
        .lineHeight(14)
        .margin({ top: 3 })
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      if (d.lastSeenTs > 0) {
        Text(`后端最近上报：${d.lastSeenText.length > 0 ? d.lastSeenText : '时间未知'}`)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ top: 2 })
          .maxLines(1)
      }

      Text(`未纳入原因：${unrecognizedReasonFor(d.deviceId, d.roomName)}`)
        .fontSize(FontSize.mini)
        .fontColor(Color.textSecondary)
        .lineHeight(14)
        .margin({ top: 4 })
        .maxLines(5)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor(Color.card)
    .borderRadius(Radius.tile)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  unrecognizedSection() {
    Column() {
      Row() {
        Column().width(3).height(13).borderRadius(2).backgroundColor(Color.textTertiary).margin({ right: 7 })
        Text('未纳入监护的后端记录')
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${this.unrecognizedDevices.length} 条`)
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textTertiary)
          .maxLines(1)
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(13)
          .fontColor([Color.textTertiary])
          .margin({ left: 5 })
          .rotate({ angle: this.unrecognizedExpanded ? 90 : 0 })
      }
      .width('100%')
      .height(44)
      .padding({ left: this.pm() + 2, right: this.pm() + 2 })
      .onClick(() => {
        this.unrecognizedExpanded = !this.unrecognizedExpanded;
      })

      if (this.unrecognizedExpanded) {
        Column() {
          Text('这些设备在后端仍有上报记录，但不在已核实家庭设备清单（厨房 / 卫生间 / 客厅 / 随身求助）中，可能是测试、历史或第三方设备；不计入在线统计，也不作为告警判读依据。记录仅在此如实展示，不做删除。')
            .fontSize(FontSize.caption - 0.5)
            .fontColor(Color.textSecondary)
            .lineHeight(15)
            .maxLines(4)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ left: 12, right: 12, top: 4, bottom: 8 })

          if (this.unrecognizedDevices.length === 0) {
            Text('当前没有未纳入监护的后端记录。')
              .fontSize(FontSize.caption)
              .fontColor(Color.textTertiary)
              .margin({ left: 12, right: 12, top: 2, bottom: Space.md })
              .maxLines(2)
          } else {
            Column({ space: 9 }) {
              ForEach(this.unrecognizedDevices, (d: DeviceView) => {
                this.unrecognizedCard(d)
              }, (d: DeviceView) => `unrec_${d.deviceId}_${d.lastSeenTs}`)
            }
            .padding({ left: this.pm(), right: this.pm(), bottom: Space.md })
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .margin({ top: Space.sm })
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Column() {
      NavBar({
        title: '设备管理',
        showBack: true,
        rightText: this.refreshing ? '刷新中' : '刷新',
        onRight: () => { void this.doRefresh(); }
      })
      DemoModeBar()

      Scroll() {
        Column() {
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
            .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
          }

          // 真实摘要卡（仅在线/监测异常/离线）
          Column() {
            Row() {
              Medal({ variant: 'pri', icon: $r('sys.symbol.waveform'), medalSize: 40 })
              Column() {
                Text('家庭设备')
                  .fontSize(FontSize.h3)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(Color.textPrimary)
                Text(this.lastUpdatedAt > 0
                  ? (this.mode === RunMode.DEMO
                    ? `本地示例数据 · 生成于 ${DateUtil.formatTime(this.lastUpdatedAt)}`
                    : `真实数据 · 更新于 ${DateUtil.formatTime(this.lastUpdatedAt)}`)
                  : '尚未获取设备数据')
                  .fontSize(FontSize.caption)
                  .fontColor(Color.textSecondary)
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              .margin({ left: 11 })

              Text(`${this.devices.length}`)
                .fontSize(20)
                .fontWeight(FontWeight_.extrabold)
                .fontColor(Color.primaryDark)
            }
            .width('100%')

            Row() {
              this.summaryCell('在线', `${this.onlineCount()}`, Color.primaryDark, false)
              Column().width(1).height(30).backgroundColor('rgba(148,163,184,0.3)')
              this.summaryCell('监测异常', `${this.monitorIssueCount()}`,
                this.monitorIssueCount() > 0 ? Color.criticalDark : Color.textTertiary, false)
              Column().width(1).height(30).backgroundColor('rgba(148,163,184,0.3)')
              this.summaryCell('离线', `${this.offlineCount()}`,
                this.offlineCount() > 0 ? Color.warningDark : Color.textTertiary, true)
            }
            .width('100%')
            .margin({ top: Space.md })
          }
          .padding(Space.lg - 1)
          .backgroundColor(Color.card)
          .borderRadius(22)
          .linearGradient(Grad.heroPrimary())
          .shadow(Shadow_.card())
          .alignItems(HorizontalAlign.Start)
          .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

          // 家庭设备清单口径（已核实来源；列表外记录单独列出）
          Row() {
            SymbolGlyph($r('sys.symbol.info_circle'))
              .fontSize(13)
              .fontColor([Color.textTertiary])
            Text(this.scopeText())
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .lineHeight(15)
              .margin({ left: 5 })
              .layoutWeight(1)
              .maxLines(3)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .width('100%')
          .padding(Space.md - 1)
          .backgroundColor('#F1F5F9')
          .borderRadius(Radius.button)
          .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

          // 无后端能力的入口：明确未开放，不做成可点击的成功动作
          Row() {
            SymbolGlyph($r('sys.symbol.info_circle'))
              .fontSize(13)
              .fontColor([Color.textTertiary])
            Text('添加设备、一键自检未开放（无对应后端接口），APP 不提供可点击的成功操作。')
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .lineHeight(15)
              .margin({ left: 5 })
              .layoutWeight(1)
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .width('100%')
          .padding(Space.md - 1)
          .backgroundColor('#F1F5F9')
          .borderRadius(Radius.button)
          .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

          // 家庭设备：按房间/场景分组（不是平铺后端全部记录）
          Row() {
            Row() {
              Column().width(3).height(13).borderRadius(2).linearGradient(Grad.primary()).margin({ right: 7 })
              Text('家庭设备（按房间 / 场景）')
                .fontSize(FontSize.h3)
                .fontWeight(FontWeight_.bold)
                .fontColor(Color.textPrimary)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
            }
            Blank()
            Text(`${this.devices.length} 台`).fontSize(FontSize.caption - 0.5).fontColor(Color.textTertiary)
          }
          .width('100%')
          .padding({ left: this.pm() + 2, right: this.pm() + 2, top: Space.lg - 2, bottom: Space.xs })

          if (this.devices.length === 0) {
            EmptyState({
              icon: $r('sys.symbol.waveform'),
              title: '暂无家庭设备数据',
              description: this.netMessage.length > 0 ? this.netMessage : '请确认已登录并刷新'
            })
          } else {
            ForEach(this.sceneGroups(), (group: DeviceSceneGroup) => {
              this.sceneSection(group)
            }, (group: DeviceSceneGroup) => group.key)
          }

          // 未纳入监护的后端记录（折叠；不计入在线统计、不作为告警依据、不删除）
          this.unrecognizedSection()

          Column().height(Space.xxl)
        }
        .width('100%')
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
