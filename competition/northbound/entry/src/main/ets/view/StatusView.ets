import { DeviceStore } from '../model/DeviceModel';

/**
 * 实时状态页：人体活动 / 门窗 / 温湿度 / 设备信息
 *
 * 数据走 AppStorage：普通静态字段不可观测，跨组件还可能拿到不同模块实例，直接读不会刷新。
 */
@Component
export struct StatusView {
  /* @StorageProp 可观测，能可靠驱动刷新；实测 @Prop 从页面传进 TabContent 子组件在此环境不生效 */
  @StorageProp('liveCount') count: number = 0;
  @StorageProp('liveLastActiveTs') lastActiveTs: number = 0;
  @StorageProp('liveDoorOpen') doorOpen: boolean = false;
  @StorageProp('liveDoorLastOpenTs') doorLastOpenTs: number = 0;
  @StorageProp('liveTempC') tempC: number = 0;
  @StorageProp('liveRh') rh: number = 0;
  @StorageProp('liveClimateOk') climateOk: boolean = true;
  @StorageProp('liveDeviceId') deviceId: string = '-';
  @StorageProp('liveOnline') online: boolean = false;
  @StorageProp('liveStateText') stateText: string = '一切正常';

  build() {
    Scroll() {
      Column({ space: 12 }) {
        Row({ space: 12 }) {
          this.metricCard('最后活动', DeviceStore.agoText(this.lastActiveTs), '人体传感器')
          this.metricCard('今日活动', `${this.count} 次`, '累计触发')
        }.width('100%')

        Column() {
          this.cardTitle('门窗状态')
          Row() {
            Text(this.doorOpen ? '当前：开启' : '当前：关闭')
              .fontSize(16)
              .fontColor(this.doorOpen ? '#E6A23C' : '#333333')
            Blank()
            Text(`最近开启 ${DeviceStore.agoText(this.doorLastOpenTs)}`)
              .fontSize(13).fontColor('#888888')
          }.width('100%').margin({ top: 8 })
        }.cardStyle()

        Column() {
          this.cardTitle('室内环境')
          Row() {
            this.envItem('温度', `${this.tempC.toFixed(1)} ℃`)
            this.envItem('湿度', `${this.rh.toFixed(1)} %`)
          }.width('100%').margin({ top: 8 })
          Text(this.climateOk ? '环境舒适度正常' : '温湿度超出阈值，已触发预警')
            .fontSize(13)
            .fontColor(this.climateOk ? '#37B24D' : '#E6453C')
            .margin({ top: 8 })
        }.cardStyle()

        Column() {
          this.cardTitle('设备信息')
          this.kv('设备编号', this.deviceId)
          this.kv('在线状态', this.online ? '在线（本地 TCP 已连接）' : '离线')
          this.kv('供电', '市电供电（12V/2A）')
          this.kv('运行状态', this.stateText)
        }.cardStyle()

        Text('提示：数据来自本机南向守护进程 homemon 的实时上报')
          .fontSize(12).fontColor('#999999').margin({ top: 4, bottom: 8 })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 16, bottom: 88 })
    }
    .width('100%').height('100%').align(Alignment.Top)
  }

  @Builder
  metricCard(label: string, value: string, sub: string) {
    Column() {
      Text(label).fontSize(13).fontColor('#888888')
      Text(value).fontSize(22).fontWeight(FontWeight.Bold).margin({ top: 6 })
      Text(sub).fontSize(12).fontColor('#AAAAAA').margin({ top: 4 })
    }
    .cardStyle()
    .layoutWeight(1)
  }

  @Builder
  envItem(label: string, value: string) {
    Column() {
      Text(label).fontSize(13).fontColor('#888888')
      Text(value).fontSize(20).fontWeight(FontWeight.Bold).margin({ top: 4 })
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  cardTitle(t: string) {
    Text(t).fontSize(15).fontWeight(FontWeight.Bold).width('100%')
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

@Extend(Column)
function cardStyle() {
  .width('100%')
  .padding(16)
  .backgroundColor(Color.White)
  .borderRadius(12)
  .alignItems(HorizontalAlign.Start)
}
