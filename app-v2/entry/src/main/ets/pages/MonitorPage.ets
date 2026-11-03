// 实时监测页 v2
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { SensorCard } from '../components/SensorCard';
import { MockData } from '../common/MockData';
import { Sensor, SensorType } from '../model/Sensor';
import { DateUtil } from '../common/DateUtil';

type FilterKey = 'all' | 'activity' | 'door' | 'env' | 'safety';

interface FilterItem {
  key: FilterKey;
  label: string;
  types: SensorType[];
}

@Component
export struct MonitorPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @State sensors: Sensor[] = MockData.sensors();
  @State activeFilter: FilterKey = 'all';
  @State now: number = Date.now();

  private filters: FilterItem[] = [
    { key: 'all', label: '全部', types: [] },
    { key: 'activity', label: '活动', types: ['motion', 'sos'] },
    { key: 'door', label: '门窗', types: ['door'] },
    { key: 'env', label: '环境', types: ['temperature', 'humidity', 'smoke', 'gas'] },
    { key: 'safety', label: '安全', types: ['sos', 'smoke', 'gas'] }
  ];

  aboutToAppear() {
    setInterval(() => { this.now = Date.now(); }, 30 * 1000);
  }

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private filtered(): Sensor[] {
    if (this.activeFilter === 'all') return this.sensors;
    const types = this.filters.find(f => f.key === this.activeFilter)?.types ?? [];
    return this.sensors.filter(s => types.includes(s.type));
  }

  private onlineRate(): string {
    const on = this.sensors.filter(s => s.online).length;
    return `${Math.round(on / this.sensors.length * 100)}%`;
  }

  private latestActivity(): number {
    const motions = this.sensors.filter(s => s.type === 'motion' && s.lastTriggeredAt > 0);
    if (motions.length === 0) return Date.now();
    return Math.max(...motions.map(m => m.lastTriggeredAt));
  }

  build() {
    Column() {
      Row() {
        Column() {
          Text('实时监测')
            .fontSize(FontSize.h1)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(Color.textPrimary)
          Text(`${DateUtil.formatTime(this.now)} 更新 · 每 30s 自动刷新`)
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Column() {
          SymbolGlyph($r('sys.symbol.arrow_clockwise'))
            .fontSize(19)
            .fontColor([Color.primaryDark])
        }
        .width(36)
        .height(36)
        .borderRadius(12)
        .backgroundColor(Color.card)
        .justifyContent(FlexAlign.Center)
        .shadow(Shadow_.card())
        .onClick(() => {
          this.now = Date.now();
          this.getUIContext().getPromptAction().showToast({ message: '已刷新' });
        })
      }
      .width('100%')
      .padding({
        left: this.pm() + 2, right: this.pm() + 2,
        top: Space.md, bottom: Space.md - 2
      })

      // 摘要三宫格
      Row() {
        Column() {
          Text(this.onlineRate())
            .fontSize(20)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(Color.primaryDark)
          Text('设备在线')
            .fontSize(FontSize.caption - 0.5)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Column().width(1).height(34).backgroundColor(Color.border)

        Column() {
          Text(DateUtil.fromNow(this.latestActivity()))
            .fontSize(FontSize.h3)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(Color.successDark)
          Text('最后活动')
            .fontSize(FontSize.caption - 0.5)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Center)

        Column().width(1).height(34).backgroundColor(Color.border)

        Column() {
          Text('12')
            .fontSize(20)
            .fontWeight(FontWeight_.extrabold)
            .fontColor(Color.accentDark)
          Text('今日触发')
            .fontSize(FontSize.caption - 0.5)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.End)
      }
      .width('100%')
      .padding(Space.lg - 2)
      .backgroundColor(Color.card)
      .borderRadius(Radius.card)
      .shadow(Shadow_.card())
      .margin({ left: this.pm(), right: this.pm() })

      // 过滤器
      Scroll() {
        Row({ space: 7 }) {
          ForEach(this.filters, (f: FilterItem) => {
            Text(f.label)
              .fontSize(FontSize.body - 1)
              .fontWeight(this.activeFilter === f.key ? FontWeight_.bold : FontWeight_.regular)
              .fontColor(this.activeFilter === f.key ? '#FFFFFF' : Color.textSecondary)
              .padding({ left: 13, right: 13, top: 6, bottom: 6 })
              .borderRadius(Radius.pill)
              .linearGradient(this.activeFilter === f.key
                ? Grad.primary()
                : { angle: 135, colors: [[Color.card, 0.0], [Color.card, 1.0]] })
              .border({
                width: 1,
                color: this.activeFilter === f.key ? 'rgba(0,0,0,0)' : Color.border
              })
              .shadow(this.activeFilter === f.key
                ? { radius: 12, color: 'rgba(2,132,199,0.35)', offsetX: 0, offsetY: 4 }
                : { radius: 0, color: 'rgba(0,0,0,0)', offsetX: 0, offsetY: 0 })
              .onClick(() => { this.activeFilter = f.key; })
          }, (f: FilterItem) => f.key)
        }
        .padding({ left: this.pm(), right: this.pm() })
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Off)
      .width('100%')
      .margin({ top: Space.md - 2, bottom: Space.sm - 2 })

      // 传感器栅格（断点自适应列数）
      Grid() {
        ForEach(this.filtered(), (s: Sensor) => {
          GridItem() {
            SensorCard({
              sensor: s,
              onPress: (item: Sensor) => {
                this.getUIContext().getPromptAction().showToast({ message: `${item.name} · ${item.lastValue}` });
              }
            })
          }
        }, (s: Sensor) => s.id)
      }
      .columnsTemplate(Responsive.sensorColumns(this.bp))
      .columnsGap(10)
      .rowsGap(10)
      .padding({ left: this.pm(), right: this.pm(), top: 2, bottom: Space.xxl })
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
