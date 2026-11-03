/**
 * 设备管理页 —— 真实设备数据（AppStorage gv.*）
 * - online 与 monitorOnline 分开表达，不用“在线”掩盖监测异常/监测状态未知
 * - 按 roomId 关联 RoomView；无匹配时退回 roomName，不假设房间名唯一
 * - 不显示虚构的网关性能/电量/信号百分比；csq 0-31 映射信号格，99/缺失显示“未知”
 * - 添加设备/一键自检/电池提醒等无后端能力入口标“未开放”
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { DemoModeBar } from '../components/DemoModeBar';
import { Medal } from '../components/Medal';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { DeviceView, RoomView, RunMode, SensorView } from '../core/view/Models';
import { GuardianService } from '../service/GuardianService';

@Entry
@Component
struct DevicePage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.devices') devices: DeviceView[] = [];
  @StorageLink('gv.rooms') rooms: RoomView[] = [];
  @StorageLink('gv.netStatus') netStatus: string = 'unknown';
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @State refreshing: boolean = false;

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

  private roomNameOf(d: DeviceView): string {
    if (d.roomId.length > 0) {
      for (let i = 0; i < this.rooms.length; i++) {
        if (this.rooms[i].id === d.roomId) {
          return this.rooms[i].name;
        }
      }
    }
    if (d.roomName.length > 0) {
      return d.roomName;
    }
    return '未分配房间';
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

  private lastSeenText(d: DeviceView): string {
    if (d.lastSeenTs > 0) {
      return `最后上报 ${DateUtil.fromNow(d.lastSeenTs)}`;
    }
    return '最后上报时间未知';
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
      const outcome = await GuardianService.refreshAll('manual');
      if (!outcome.ok) {
        const msg: string = outcome.message.length > 0 ? outcome.message : '刷新失败，请稍后重试';
        this.getUIContext().getPromptAction().showToast({ message: msg });
      } else if (outcome.partial) {
        this.getUIContext().getPromptAction().showToast({ message: '部分数据刷新失败，显示上次数据' });
      } else {
        this.getUIContext().getPromptAction().showToast({ message: '设备数据已刷新' });
      }
    } catch (err) {
      this.getUIContext().getPromptAction().showToast({ message: '刷新失败，请检查网络后重试' });
    } finally {
      this.refreshing = false;
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

  @Builder
  sensorChips(d: DeviceView) {
    Flex({ wrap: FlexWrap.Wrap }) {
      ForEach(d.sensors, (s: SensorView) => {
        Text(`${s.name} ${s.stateText}`)
          .fontSize(FontSize.mini - 1)
          .fontColor(this.sensorFg(s.state))
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor(this.sensorBg(s.state))
          .borderRadius(Radius.pill)
          .margin({ right: 5, bottom: 5 })
          .maxLines(1)
      }, (s: SensorView) => `${d.deviceId}_${s.id}`)
    }
    .width('100%')
    .margin({ top: Space.xs })
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

          Text(`${this.roomNameOf(d)} · ${d.deviceId}`)
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

      if (d.capabilitySummary.length > 0) {
        Text(`已启用能力：${d.capabilitySummary}`)
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textPrimary)
          .lineHeight(15)
          .margin({ top: Space.xs + 1 })
          .maxLines(3)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      if (d.capabilityNote.length > 0) {
        Text(d.capabilityNote)
          .fontSize(FontSize.mini)
          .fontColor(Color.textSecondary)
          .lineHeight(14)
          .margin({ top: 3 })
          .maxLines(6)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }

      if (d.sensors.length > 0) {
        this.sensorChips(d)
      }

      Row() {
        this.signalBarsView(d.csq)
        Blank()
        Text(this.lastSeenText(d))
          .fontSize(FontSize.mini - 0.5)
          .fontColor(Color.textTertiary)
          .maxLines(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Bottom)
      .margin({ top: Space.sm })

      if (!d.online) {
        Text('离线设备展示的是最后一次上报的历史数据')
          .fontSize(FontSize.mini - 1)
          .fontColor(Color.warningDark)
          .margin({ top: 3 })
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

          // 无后端能力的入口：明确未开放
          Row() {
            SymbolGlyph($r('sys.symbol.info_circle'))
              .fontSize(13)
              .fontColor([Color.textTertiary])
            Text('添加设备、一键自检、电池提醒本轮未开放（无对应后端接口）')
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .lineHeight(15)
              .margin({ left: 5 })
              .layoutWeight(1)
              .maxLines(2)
          }
          .width('100%')
          .padding(Space.md - 1)
          .backgroundColor('#F1F5F9')
          .borderRadius(Radius.button)
          .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

          // 设备列表
          Row() {
            Row() {
              Column().width(3).height(13).borderRadius(2).linearGradient(Grad.primary()).margin({ right: 7 })
              Text('全部设备').fontSize(FontSize.h3).fontWeight(FontWeight_.bold).fontColor(Color.textPrimary)
            }
            Blank()
            Text(`${this.devices.length} 台`).fontSize(FontSize.caption - 0.5).fontColor(Color.textTertiary)
          }
          .width('100%')
          .padding({ left: this.pm() + 2, right: this.pm() + 2, top: Space.lg - 2, bottom: Space.sm - 2 })

          if (this.devices.length === 0) {
            EmptyState({
              icon: $r('sys.symbol.waveform'),
              title: '暂无设备数据',
              description: this.netMessage.length > 0 ? this.netMessage : '请确认已登录并刷新'
            })
          } else {
            Column({ space: 9 }) {
              ForEach(this.devices, (d: DeviceView) => {
                this.deviceCard(d)
              }, (d: DeviceView) => d.id.length > 0 ? d.id : d.deviceId)
            }
            .padding({ left: this.pm(), right: this.pm(), bottom: Space.xxl })
          }
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
