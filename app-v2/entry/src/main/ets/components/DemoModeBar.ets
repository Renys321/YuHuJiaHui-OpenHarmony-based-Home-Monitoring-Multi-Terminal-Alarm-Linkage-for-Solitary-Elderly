/**
 * 独立演示模式的页面级标识条。
 * 只读取 gv.mode；demo 下在子页面持续显示“示例数据”，真实模式不占空间。
 */
import { Color, FontSize, FontWeight_ } from '../common/Theme';
import { AppKeys, RunMode } from '../core/view/Models';

@Component
export struct DemoModeBar {
  @StorageLink('gv.mode') mode: string = RunMode.NONE;

  build() {
    if (this.mode === RunMode.DEMO) {
      Row() {
        Text('演示模式')
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.extrabold)
          .fontColor('#92400E')
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor('#FDE68A')
          .borderRadius(999)
        Text('示例数据 · 不连接真实设备/不发送命令')
          .fontSize(FontSize.mini)
          .fontColor('#92400E')
          .margin({ left: 6 })
          .layoutWeight(1)
          .maxLines(1)
      }
      .width('100%')
      .height(34)
      .padding({ left: 10, right: 10 })
      .backgroundColor('#FFFBEB')
      .border({ width: { bottom: 1 }, color: '#FDE68A' })
    }
  }
}
