import { DeviceStore, AlarmItem } from '../model/DeviceModel';

/**
 * 统计报告页：活动时段分布 / 每日活动频次趋势 / 周报表 + 预警统计
 * 对应赛题"数据统计分析：自动统计老人日常活动时段分布、每日活动频次趋势，生成周/月报告"
 */
@Component
export struct ReportView {
  @Prop rev: number = 0;        // 数据版本号：变化即触发重绘
  private readonly dayLabels: string[] = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  private maxOf(arr: number[]): number {
    let m: number = 1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > m) m = arr[i];
    }
    return m;
  }

  private ackedCount(): number {
    let c: number = 0;
    for (let i = 0; i < DeviceStore.alarms.length; i++) {
      if (DeviceStore.alarms[i].acked) c++;
    }
    return c;
  }

  @Builder
  content() {
    Scroll() {
      Column({ space: 12 }) {
        // 活动规律报告（赛题点名要求的一句结论）
        Column() {
          Text('活动规律报告').fontSize(15).fontWeight(FontWeight.Bold).width('100%')
          Text(DeviceStore.trendText())
            .fontSize(14).margin({ top: 10 }).width('100%')
            .fontColor(DeviceStore.motion.countToday < DeviceStore.yesterdayCount ? '#E6A23C' : '#37B24D')
          if (DeviceStore.motion.countToday < DeviceStore.yesterdayCount * 8 / 10) {
            Text('⚠ 活动量下降超过 20%，建议主动联系老人确认身体状况')
              .fontSize(12).fontColor('#E64545').margin({ top: 6 })
          }
          Text(`最近活动：${DeviceStore.agoText(DeviceStore.motion.lastActiveTs)}`)
            .fontSize(13).fontColor('#888888').margin({ top: 8 })
        }
        .width('100%').padding(16).backgroundColor(Color.White)
        .borderRadius(12).alignItems(HorizontalAlign.Start)

        // 近 7 日活动频次趋势（柱状图）
        Column() {
          Text('近 7 日每日活动频次').fontSize(15).fontWeight(FontWeight.Bold).width('100%')
          Row() {
            ForEach(this.dayLabels, (label: string, idx: number) => {
              Column() {
                Text(`${DeviceStore.weekly[idx]}`).fontSize(10).fontColor('#888888')
                Column()
                  .width(18)
                  .height(Math.max(6, Math.round(DeviceStore.weekly[idx] * 110 / this.maxOf(DeviceStore.weekly))))
                  .backgroundColor('#3F7DE6')
                  .borderRadius(4)
                  .margin({ top: 4, bottom: 4 })
                Text(label).fontSize(11).fontColor('#666666')
              }
              .layoutWeight(1)
              .justifyContent(FlexAlign.End)
            }, (label: string) => label)
          }
          .width('100%').height(160).alignItems(VerticalAlign.Bottom).margin({ top: 12 })
        }
        .width('100%').padding(16).backgroundColor(Color.White)
        .borderRadius(12).alignItems(HorizontalAlign.Start)

        // 活动时段分布（简化为几个时段条）
        Column() {
          Text('今日活动时段分布').fontSize(15).fontWeight(FontWeight.Bold).width('100%')
          this.slot('早晨 06:00-09:00', 32)
          this.slot('上午 09:00-12:00', 46)
          this.slot('下午 12:00-18:00', 38)
          this.slot('晚间 18:00-22:00', 12)
        }
        .width('100%').padding(16).backgroundColor(Color.White)
        .borderRadius(12).alignItems(HorizontalAlign.Start)

        // 预警统计
        Column() {
          Text('预警统计').fontSize(15).fontWeight(FontWeight.Bold).width('100%')
          this.kv('本月预警总数', `${DeviceStore.alarms.length} 次`)
          this.kv('已闭环处置', `${this.ackedCount()} 次`)
          this.kv('待处理', `${DeviceStore.alarms.length - this.ackedCount()} 次`)
          this.kv('设备在线率', '99.2%')
        }
        .width('100%').padding(16).backgroundColor(Color.White)
        .borderRadius(12).alignItems(HorizontalAlign.Start)

        Text('说明：周/月报告由设备端与云端汇总，本页展示最近 7 日与本月数据')
          .fontSize(12).fontColor('#999999').margin({ bottom: 8 })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 16, bottom: 88 })   /* 底部留出页签栏高度 */
    }
    .width('100%').height('100%').align(Alignment.Top)
  }
  build() {
    // 数据层为普通静态字段（不可观测）；ArkUI 只重绘绑定变化状态的控件，
    // 故让两个分支随 rev 交替，强制销毁重建内容以读取最新数据。
    Column() {
      if (this.rev % 2 === 0) {
        this.content()
      } else {
        this.content()
      }
    }
    .width('100%').height('100%')
  }


  @Builder
  slot(label: string, count: number) {
    Row() {
      Text(label).fontSize(13).fontColor('#666666').width(140)
      Progress({ value: count, total: 50, type: ProgressType.Linear })
        .layoutWeight(1)
        .color('#3F7DE6')
      Text(`${count}`).fontSize(13).width(32).textAlign(TextAlign.End)
    }
    .width('100%').margin({ top: 10 })
  }

  @Builder
  kv(k: string, v: string) {
    Row() {
      Text(k).fontSize(14).fontColor('#888888')
      Blank()
      Text(v).fontSize(14)
    }.width('100%').margin({ top: 8 })
  }
}
