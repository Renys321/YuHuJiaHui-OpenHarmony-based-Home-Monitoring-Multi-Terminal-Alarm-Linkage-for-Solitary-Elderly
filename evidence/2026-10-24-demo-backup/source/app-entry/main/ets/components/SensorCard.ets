/**
 * 传感器瓦片 —— 真实 SensorView 适配
 * 状态语义严格来自 core/view/Models.SensorView（state/stateText/valueText/detailText/validity），
 * 禁止把 raw ADC 当 ppm、禁止把 unknown/disabled/unsupported/offline 显示为绿色正常。
 */
import { Color, FontSize, FontWeight_, Radius, Shadow_, Space } from '../common/Theme';
import { DateUtil } from '../common/DateUtil';
import { SensorView } from '../core/view/Models';
import { colorTokenForSensorState } from '../core/capability/DeviceCapabilities';

@Component
export struct SensorCard {
  @Prop sensor: SensorView = new SensorView();
  onPress?: (s: SensorView) => void;

  /** 唯一颜色语义来源：由 ViewMapper 写入 colorToken；缺失时用实际状态回退。 */
  private token(): string {
    if (this.sensor.colorToken.length > 0 && this.sensor.colorToken !== 'neutral') {
      return this.sensor.colorToken;
    }
    return colorTokenForSensorState(this.sensor.state);
  }

  private toneDark(): string {
    const token: string = this.token();
    if (token === 'success') return Color.successDark;
    if (token === 'warning') return Color.warningDark;
    if (token === 'critical') return Color.criticalDark;
    if (token === 'info') return Color.primaryDark;
    return Color.textSecondary;
  }

  private toneBg(): string {
    const token: string = this.token();
    if (token === 'success') return Color.successLight;
    if (token === 'warning') return Color.warningLight;
    if (token === 'critical') return Color.criticalLight;
    if (token === 'info') return Color.primaryLight;
    return '#F1F5F9';
  }

  private statusLabel(): string {
    if (this.sensor.stateText.length > 0) {
      return this.sensor.stateText;
    }
    return this.fallbackStateText(this.sensor.state);
  }

  private fallbackStateText(st: string): string {
    if (st === 'ok') return '正常';
    if (st === 'attention') return '关注';
    if (st === 'critical') return '异常';
    if (st === 'offline') return '离线';
    if (st === 'invalid') return '无效';
    if (st === 'waiting') return '等待数据';
    if (st === 'disabled') return '报警未启用';
    if (st === 'unsupported') return '未安装/未启用';
    return '待确认';
  }

  private detailText(): string {
    if (this.sensor.detailText.length > 0) {
      return this.sensor.detailText;
    }
    const st: string = this.sensor.state;
    if (st === 'disabled') return '报警未启用';
    if (st === 'unsupported') return this.sensor.installed ? '已安装 · 未启用' : '未安装';
    if (st === 'waiting') return '等待设备上报数据';
    if (st === 'offline') return '离线 · 显示上次数据';
    if (this.sensor.validity === 'invalid') return '读数无效/有效性未知';
    return '';
  }

  private icon(kind: string): Resource {
    if (kind === 'motion') return $r('sys.symbol.person_fill');
    if (kind === 'door') return $r('sys.symbol.square_grid_2x2');
    if (kind === 'climate') return $r('sys.symbol.thermometer_medium');
    if (kind === 'gas') return $r('sys.symbol.flame_fill');
    if (kind === 'smoke') return $r('sys.symbol.cloud_fill');
    if (kind === 'sos') return $r('sys.symbol.exclamationmark_circle_fill');
    if (kind === 'water') return $r('sys.symbol.drop_fill');
    if (kind === 'camera') return $r('sys.symbol.video_fill');
    if (kind === 'fall') return $r('sys.symbol.exclamationmark_triangle_fill');
    return $r('sys.symbol.circle');
  }

  private valueColor(): string {
    const token: string = this.token();
    if (token === 'critical') return Color.criticalDark;
    if (token === 'warning') return Color.warningDark;
    if (token === 'info') return Color.primaryDark;
    if (token === 'success') return Color.textPrimary;
    return Color.textTertiary;
  }

  private footerText(): string {
    const where: string = this.sensor.roomName.length > 0 ? this.sensor.roomName : this.sensor.deviceId;
    const when: string = this.sensor.lastUpdateTs > 0 ? DateUtil.fromNow(this.sensor.lastUpdateTs) : '时间未知';
    return `${where} · ${when}`;
  }

  build() {
    Column() {
      Row() {
        Column() {
          SymbolGlyph(this.icon(this.sensor.kind))
            .fontSize(14)
            .fontColor([this.toneDark()])
        }
        .width(26)
        .height(26)
        .borderRadius(9)
        .backgroundColor(this.toneBg())
        .justifyContent(FlexAlign.Center)
        .margin({ right: 6 })

        Text(this.sensor.name.length > 0 ? this.sensor.name : this.sensor.kind)
          .fontSize(FontSize.mini)
          .fontColor(Color.textSecondary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)

        Text(this.statusLabel())
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.bold)
          .fontColor(this.toneDark())
          .padding({ left: 7, right: 7, top: 3, bottom: 3 })
          .backgroundColor(this.toneBg())
          .borderRadius(Radius.pill)
          .maxLines(1)
      }
      .width('100%')

      Text(this.sensor.valueText.length > 0 ? this.sensor.valueText : '--')
        .fontSize(16)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(this.valueColor())
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: Space.md - 3 })

      if (this.detailText().length > 0) {
        Text(this.detailText())
          .fontSize(FontSize.mini)
          .fontColor(this.token() === 'success' ? Color.textSecondary : this.toneDark())
          .lineHeight(13)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 3 })
      }

      Text(this.footerText())
        .fontSize(FontSize.mini - 0.5)
        .fontColor(Color.textTertiary)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: Space.sm })
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor(Color.card)
    .borderRadius(Radius.tile)
    .shadow(Shadow_.card())
    .border({
      width: 1,
      color: this.token() === 'warning' ? 'rgba(245,158,11,0.5)'
        : this.token() === 'critical' ? 'rgba(239,68,68,0.5)' : 'rgba(0,0,0,0)'
    })
    .opacity(this.sensor.state === 'offline' || this.sensor.state === 'unsupported' ? 0.66 : 1)
    .alignItems(HorizontalAlign.Start)
    .onClick(() => { if (this.onPress) this.onPress(this.sensor); })
  }
}
