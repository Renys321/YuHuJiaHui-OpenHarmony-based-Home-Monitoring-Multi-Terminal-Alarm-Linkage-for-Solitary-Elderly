// 设备管理页 v2
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { Medal } from '../components/Medal';
import { MockData } from '../common/MockData';
import { DeviceView } from '../core/view/Models';
import { Sensor, SensorMeta } from '../model/Sensor';
import { DateUtil } from '../common/DateUtil';

@Entry
@Component
struct DevicePage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @State sensors: Sensor[] = MockData.sensors();
  @StorageLink('gv.devices') devices: DeviceView[] = [];
  @StorageLink('gv.lastUpdatedAt') @Watch('onDataChanged') lastUpdatedAt: number = 0;

  private pm(): number {
    return Responsive.pageMargin(this.bp);
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

  private onlineCount(): number {
    return this.sensors.filter(s => s.online).length;
  }

  private lowBattery(): Sensor[] {
    return this.sensors.filter(s => s.online && s.battery < 20);
  }

  private batteryGrad(b: number): LinearGradientOptions {
    if (b < 20)
      return Grad.critical();
    if (b < 40)
      return Grad.warning();
    return Grad.success();
  }

  private batteryFg(b: number): string {
    if (b < 20)
      return Color.criticalDark;
    if (b < 40)
      return Color.warningDark;
    return Color.successDark;
  }

  private chipVariant(s: Sensor): string {
    if (!s.online)
      return 'off';
    if (s.battery < 20)
      return 'warn';
    return 'pri';
  }

  private chipBg(s: Sensor): string {
    if (!s.online)
      return '#F1F5F9';
    if (s.battery < 20)
      return Color.warningLight;
    return Color.primaryLight;
  }

  private chipFg(s: Sensor): string {
    if (!s.online)
      return Color.textTertiary;
    if (s.battery < 20)
      return Color.warningDark;
    return Color.primaryDark;
  }

  build() {
    Column() {
      NavBar({
        title: '设备管理', showBack: true, rightText: '添加',
        onRight: () => { this.getUIContext().getPromptAction().showToast({ message: '进入设备配对流程' }); }
      })

      Scroll() {
        Column() {
          // 网关渐变卡
          Column() {
            Row() {
              Medal({ variant: 'pri', icon: $r('sys.symbol.waveform'), medalSize: 40 })
              Column() {
                Text('家庭网关 · 在线')
                  .fontSize(FontSize.h3)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(Color.textPrimary)
                Text('真实设备在线状态 · 由服务端同步')
                  .fontSize(FontSize.caption)
                  .fontColor(Color.textSecondary)
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              .margin({ left: 11 })

              Text(`${this.onlineDeviceCount()}/${this.devices.length}`)
                .fontSize(20)
                .fontWeight(FontWeight_.extrabold)
                .fontColor(Color.primaryDark)
            }
            .width('100%')

            Row() {
              Column() {
                Text('延迟（未上报）').fontSize(FontSize.mini - 0.5).fontColor(Color.textTertiary)
                Text('—').fontSize(FontSize.body + 1).fontWeight(FontWeight_.extrabold)
                  .fontColor(Color.textPrimary).margin({ top: 2 })
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)

              Column().width(1).height(30).backgroundColor('rgba(148,163,184,0.3)')

              Column() {
                Text('丢包（未上报）').fontSize(FontSize.mini - 0.5).fontColor(Color.textTertiary)
                Text('—').fontSize(FontSize.body + 1).fontWeight(FontWeight_.extrabold)
                  .fontColor(Color.textPrimary).margin({ top: 2 })
              }.layoutWeight(1).alignItems(HorizontalAlign.Center)

              Column().width(1).height(30).backgroundColor('rgba(148,163,184,0.3)')

              Column() {
                Text('运行时长（未上报）').fontSize(FontSize.mini - 0.5).fontColor(Color.textTertiary)
                Text('—').fontSize(FontSize.body + 1).fontWeight(FontWeight_.extrabold)
                  .fontColor(Color.textPrimary).margin({ top: 2 })
              }.layoutWeight(1).alignItems(HorizontalAlign.End)
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

          // 双行动按钮
          Row({ space: 9 }) {
            Row() {
              SymbolGlyph($r('sys.symbol.checkmark_circle'))
                .fontSize(15)
                .fontColor([Color.primaryDark])
              Text('一键自检')
                .fontSize(FontSize.body)
                .fontWeight(FontWeight_.bold)
                .fontColor(Color.primaryDark)
                .margin({ left: 6 })
            }
            .layoutWeight(1)
            .height(42)
            .justifyContent(FlexAlign.Center)
            .backgroundColor(Color.card)
            .borderRadius(Radius.button)
            .shadow(Shadow_.card())
            .onClick(() => { this.getUIContext().getPromptAction().showToast({ message: '正在自检 9 台设备…' }); })

            Row() {
              SymbolGlyph($r('sys.symbol.bolt_fill'))
                .fontSize(15)
                .fontColor([Color.accentDark])
              Text('电池提醒')
                .fontSize(FontSize.body)
                .fontWeight(FontWeight_.bold)
                .fontColor(Color.accentDark)
                .margin({ left: 6 })
            }
            .layoutWeight(1)
            .height(42)
            .justifyContent(FlexAlign.Center)
            .backgroundColor(Color.card)
            .borderRadius(Radius.button)
            .shadow(Shadow_.card())
            .onClick(() => {
              const list = this.lowBattery();
              this.getUIContext().getPromptAction().showToast({
                message: list.length === 0 ? '暂无低电量设备' : `${list.length} 台设备需更换电池`
              });
            })
          }
          .width('100%')
          .padding({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

          // 低电量横幅
          if (this.lowBattery().length > 0) {
            Row() {
              Medal({ variant: 'warn', icon: $r('sys.symbol.exclamationmark_triangle_fill'), medalSize: 30 })
              Column() {
                Text(`${this.lowBattery().length} 台设备电量偏低`)
                  .fontSize(FontSize.body)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(Color.textPrimary)
                Text(this.lowBattery().map(s => s.name).join('、'))
                  .fontSize(FontSize.caption)
                  .fontColor(Color.textSecondary)
                  .margin({ top: 1 })
                  .maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              .margin({ left: 9 })

              Text('详情 ›')
                .fontSize(FontSize.caption)
                .fontWeight(FontWeight_.bold)
                .fontColor(Color.warningDark)
            }
            .width('100%')
            .padding(Space.md - 1)
            .borderRadius(Radius.tile - 2)
            .linearGradient(Grad.heroWarning())
            .shadow({ radius: 12, color: 'rgba(217,119,6,0.15)', offsetX: 0, offsetY: 4 })
            .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
          }

          // 设备列表
          Row() {
            Row() {
              Column().width(3).height(13).borderRadius(2).linearGradient(Grad.primary()).margin({ right: 7 })
              Text('全部设备').fontSize(FontSize.h3).fontWeight(FontWeight_.bold).fontColor(Color.textPrimary)
            }
            Blank()
            Text(`${this.sensors.length} 台`).fontSize(FontSize.caption - 0.5).fontColor(Color.textTertiary)
          }
          .width('100%')
          .padding({ left: this.pm() + 2, right: this.pm() + 2, top: Space.lg - 2, bottom: Space.sm - 2 })

          Column({ space: 9 }) {
            ForEach(this.sensors, (s: Sensor) => {
              Row() {
                Column() {
                  SymbolGlyph(SensorMeta.icon(s.type))
                    .fontSize(19)
                    .fontColor([this.chipFg(s)])
                }
                .width(42)
                .height(42)
                .borderRadius(15)
                .backgroundColor(this.chipBg(s))
                .justifyContent(FlexAlign.Center)
                .margin({ right: 11 })

                Column() {
                  Row() {
                    Text(s.name)
                      .fontSize(FontSize.body + 0.5)
                      .fontWeight(FontWeight_.bold)
                      .fontColor(s.online ? Color.textPrimary : Color.textSecondary)
                      .layoutWeight(1)
                    if (!s.online) {
                      Text('离线')
                        .fontSize(FontSize.mini - 0.5).fontColor('#FFFFFF')
                        .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                        .borderRadius(999).backgroundColor(Color.textTertiary)
                    } else if (s.battery < 20) {
                      Text('低电量')
                        .fontSize(FontSize.mini - 0.5).fontColor('#FFFFFF').fontWeight(FontWeight_.bold)
                        .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                        .borderRadius(999).linearGradient(Grad.warning())
                    } else {
                      Text('在线')
                        .fontSize(FontSize.mini - 0.5).fontColor(Color.successDark).fontWeight(FontWeight_.semibold)
                        .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                        .borderRadius(999).backgroundColor(Color.successLight)
                    }
                  }
                  .width('100%')

                  Text(`${s.id} · ${s.location} · ${DateUtil.fromNow(s.updateTime)}`)
                    .fontSize(FontSize.caption - 0.5)
                    .fontColor(Color.textSecondary)
                    .margin({ top: 2 })

                  Row() {
                    Column() {
                      Column()
                        .width(`${s.battery}%`)
                        .height(5)
                        .borderRadius(3)
                        .linearGradient(this.batteryGrad(s.battery))
                    }
                    .width(64)
                    .height(5)
                    .backgroundColor(Color.track)
                    .borderRadius(3)
                    .alignItems(HorizontalAlign.Start)

                    Text(`${s.battery}%`)
                      .fontSize(FontSize.mini - 0.5)
                      .fontWeight(FontWeight_.semibold)
                      .fontColor(this.batteryFg(s.battery))
                      .margin({ left: 6, right: Space.sm })

                    ForEach([1, 2, 3, 4], (n: number) => {
                      Column()
                        .width(2.5)
                        .height(4 + n * 2)
                        .borderRadius(1)
                        .backgroundColor(n <= s.signalStrength ? Color.textTertiary : Color.border)
                        .margin({ right: 1.5 })
                    }, (n: number) => `${s.id}_sig_${n}`)
                  }
                  .width('100%')
                  .alignItems(VerticalAlign.Bottom)
                  .margin({ top: 7 })
                }
                .layoutWeight(1)
                .alignItems(HorizontalAlign.Start)

                SymbolGlyph($r('sys.symbol.chevron_right'))
                  .fontSize(15)
                  .fontColor(['#CBD5E1'])
              }
              .width('100%')
              .padding(Space.md)
              .backgroundColor(Color.card)
              .borderRadius(Radius.tile)
              .shadow(Shadow_.card())
              .opacity(s.online ? 1 : 0.62)
              .alignItems(VerticalAlign.Center)
              .onClick(() => { this.getUIContext().getPromptAction().showToast({ message: `${s.name} 详情` }); })
            }, (s: Sensor) => s.id)
          }
          .padding({ left: this.pm(), right: this.pm(), bottom: Space.xxl })
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
