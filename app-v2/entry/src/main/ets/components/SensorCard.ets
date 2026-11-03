import { Color, FontSize, FontWeight_, Radius, Shadow_, Space } from '../common/Theme';
import { Sensor, SensorMeta } from '../model/Sensor';
import { DateUtil } from '../common/DateUtil';

@Component
export struct SensorCard {
  @Prop sensor: Sensor = new Sensor();
  onPress?: (s: Sensor) => void;

  private statusColor(): string {
    switch (this.sensor.status) {
      case 'critical': return Color.critical;
      case 'warning': return Color.warning;
      case 'offline': return Color.textTertiary;
      default: return Color.success;
    }
  }

  private statusDark(): string {
    switch (this.sensor.status) {
      case 'critical': return Color.criticalDark;
      case 'warning': return Color.warningDark;
      case 'offline': return Color.textSecondary;
      default: return Color.successDark;
    }
  }

  private statusBg(): string {
    switch (this.sensor.status) {
      case 'critical': return Color.criticalLight;
      case 'warning': return Color.warningLight;
      case 'offline': return '#F1F5F9';
      default: return Color.successLight;
    }
  }

  private statusText(): string {
    switch (this.sensor.status) {
      case 'critical': return '异常';
      case 'warning': return '关注';
      case 'offline': return '离线';
      default: return '正常';
    }
  }

  private batteryColor(): string {
    if (this.sensor.battery < 20)
      return Color.warningDark;
    return Color.textTertiary;
  }

  build() {
    Column() {
      Row() {
        Column() {
          SymbolGlyph(SensorMeta.icon(this.sensor.type))
            .fontSize(14)
            .fontColor([this.statusDark()])
        }
        .width(26)
        .height(26)
        .borderRadius(9)
        .backgroundColor(this.statusBg())
        .justifyContent(FlexAlign.Center)
        .margin({ right: 6 })

        Text(this.sensor.location)
          .fontSize(FontSize.mini)
          .fontColor(Color.textSecondary)
          .layoutWeight(1)

        Text(this.statusText())
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.bold)
          .fontColor(this.statusDark())
          .padding({ left: 7, right: 7, top: 3, bottom: 3 })
          .backgroundColor(this.statusBg())
          .borderRadius(Radius.pill)
      }
      .width('100%')

      Text(this.sensor.lastValue.length > 0 ? this.sensor.lastValue : '--')
        .fontSize(17)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(this.sensor.status === 'offline' ? Color.textTertiary : Color.textPrimary)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: Space.md - 2 })

      Text(this.sensor.name)
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textSecondary)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: 2 })

      Row() {
        // 手绘迷你电池
        Stack({ alignContent: Alignment.TopStart }) {
          Row()
            .width(16)
            .height(8)
            .border({ width: 1, color: this.batteryColor() })
            .borderRadius(2.5)
            .opacity(0.85)
          Row()
            .width(Math.max(1, 12 * this.sensor.battery / 100))
            .height(4)
            .backgroundColor(this.batteryColor())
            .borderRadius(1)
            .margin({ left: 2, top: 2 })
        }
        .width(16)
        .height(8)

        Text(`${this.sensor.battery}%`)
          .fontSize(FontSize.mini - 0.5)
          .fontColor(this.batteryColor())
          .margin({ left: Space.xs, right: Space.sm })

        ForEach([1, 2, 3, 4], (n: number) => {
          Column()
            .width(2.5)
            .height(4 + n * 2)
            .borderRadius(1)
            .backgroundColor(n <= this.sensor.signalStrength ? Color.textTertiary : Color.border)
            .opacity(n <= this.sensor.signalStrength ? 0.8 : 1)
            .margin({ right: 1.5 })
        }, (n: number) => n.toString())

        Blank()
        Text(DateUtil.fromNow(this.sensor.updateTime))
          .fontSize(FontSize.mini - 0.5)
          .fontColor(Color.textTertiary)
      }
      .width('100%')
      .alignItems(VerticalAlign.Bottom)
      .margin({ top: Space.md - 2 })
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor(Color.card)
    .borderRadius(Radius.tile)
    .shadow(Shadow_.card())
    .border({
      width: 1,
      color: this.sensor.status === 'warning' ? 'rgba(245,158,11,0.5)'
        : this.sensor.status === 'critical' ? 'rgba(239,68,68,0.5)'
        : 'rgba(0,0,0,0)'
    })
    .opacity(this.sensor.status === 'offline' ? 0.62 : 1)
    .alignItems(HorizontalAlign.Start)
    .onClick(() => { if (this.onPress) this.onPress(this.sensor); })
  }
}
