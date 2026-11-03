import { DeviceStore, AlarmItem } from '../model/DeviceModel';

/**
 * 预警处置页：历史预警列表 + 详情 + 事件闭环（确认并填写处置结果 → 居家安全日志）
 */
@Component
export struct AlarmView {
  @Prop rev: number = 0;        // 数据版本号：变化即触发重绘
  @State pendingId: string = '';
  @State actionText: string = '';
  @State refreshFlag: number = 0;

  @Builder
  content() {
    Column() {
      if (DeviceStore.alarms.length === 0) {
        Column() {
          Text('暂无预警记录').fontSize(16).fontColor('#888888')
          Text('系统持续监测中').fontSize(13).fontColor('#AAAAAA').margin({ top: 8 })
        }.width('100%').layoutWeight(1).justifyContent(FlexAlign.Center)
      } else {
        List({ space: 12 }) {
          ForEach(DeviceStore.alarms, (item: AlarmItem) => {
            ListItem() {
              this.alarmCard(item)
            }
          }, (item: AlarmItem) => item.id)
        }
        .width('100%')
        .layoutWeight(1)
        .padding(16)
      }
    }
    .width('100%').height('100%')
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
  alarmCard(item: AlarmItem) {
    Column() {
      Row() {
        Text(DeviceStore.alarmTypeText(item.type))
          .fontSize(15).fontWeight(FontWeight.Bold).fontColor(Color.White)
          .backgroundColor(item.level === 'ALARM' ? '#E64545' : '#E6A23C')
          .borderRadius(10).padding({ left: 10, right: 10, top: 3, bottom: 3 })

        Text(DeviceStore.hhmm(item.startTs))
          .fontSize(13).fontColor('#888888').margin({ left: 10 })

        Blank()

        Text(item.acked ? '已闭环' : '待处理')
          .fontSize(13)
          .fontColor(item.acked ? '#37B24D' : '#E64545')
      }.width('100%')

      Text(item.detail).fontSize(14).margin({ top: 10 }).width('100%')

      if (item.acked) {
        Column() {
          Text(`处置结果：${item.action}`).fontSize(13).fontColor('#444444')
          Text(`确认时间：${DeviceStore.hhmm(item.ackTs)}`)
            .fontSize(12).fontColor('#999999').margin({ top: 4 })
        }
        .width('100%')
        .padding(10)
        .backgroundColor('#F2F7F2')
        .borderRadius(8)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      } else {
        if (this.pendingId === item.id) {
          Column() {
            TextInput({ placeholder: '填写现场排查结果与处置措施', text: this.actionText })
              .onChange((v: string) => { this.actionText = v; })
              .fontSize(14)
            Row({ space: 10 }) {
              Button('确认闭环')
                .fontSize(14)
                .backgroundColor('#3F7DE6')
                .onClick(() => {
                  DeviceStore.ack(item.id, this.actionText.length > 0 ? this.actionText : '已确认，老人一切正常');
                  this.pendingId = '';
                  this.actionText = '';
                  this.refreshFlag++;
                })
              Button('取消')
                .fontSize(14)
                .backgroundColor('#CCCCCC')
                .onClick(() => { this.pendingId = ''; })
            }.width('100%').margin({ top: 10 }).justifyContent(FlexAlign.End)
          }.width('100%').margin({ top: 10 })
        } else {
          Button('处理并填写处置结果')
            .fontSize(14)
            .backgroundColor('#3F7DE6')
            .width('100%')
            .margin({ top: 10 })
            .onClick(() => { this.pendingId = item.id; this.actionText = ''; })
        }
      }

      Text('快捷处置：已联系社区网格员上门查看 / 老人一切正常，误报')
        .fontSize(11).fontColor('#AAAAAA').margin({ top: 8 })
    }
    .width('100%')
    .padding(16)
    .backgroundColor(Color.White)
    .borderRadius(12)
    .alignItems(HorizontalAlign.Start)
  }
}
