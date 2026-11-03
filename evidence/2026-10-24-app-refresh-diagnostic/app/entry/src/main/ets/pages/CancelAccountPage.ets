/**
 * 注销账号页 —— 本轮真实 API 接入阶段：服务端无注销/删除账号接口，功能未开放
 *  · APP-API-v1 无注销、身份核验或数据删除接口 → 不提供注销流程
 *  · 不调用本地账号存储、短信服务或本地会话模块，不给出任何成功提示
 *  · 只提供真实可用的“退出登录”引导（退出登录本身在「我的」页完成）
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { NavBar } from '../components/NavBar';
import { Medal } from '../components/Medal';
import { SecondaryButton } from '../components/Buttons';

@Entry
@Component
struct CancelAccountPage {

  @Builder
  consequence(text: string) {
    Row() {
      Column()
        .width(5)
        .height(5)
        .borderRadius(2.5)
        .backgroundColor(Color.critical)
        .margin({ right: 8, top: 6 })
      Text(text)
        .fontSize(FontSize.body)
        .fontColor(Color.textPrimary)
        .lineHeight(18)
        .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .margin({ bottom: Space.sm })
  }

  build() {
    Column() {
      NavBar({ title: '注销账号', showBack: true })

      Scroll() {
        Column() {
          Column() {
            Row() {
              Medal({ variant: 'crit', icon: $r('sys.symbol.exclamationmark_triangle_fill'), medalSize: 44 })
              Column() {
                Row() {
                  Text('该功能未开放')
                    .fontSize(FontSize.h1)
                    .fontWeight(FontWeight_.extrabold)
                    .fontColor(Color.textPrimary)
                  Text('未开放')
                    .fontSize(FontSize.mini)
                    .fontWeight(FontWeight_.bold)
                    .fontColor(Color.criticalDark)
                    .padding({ left: 8, right: 8, top: 2, bottom: 2 })
                    .backgroundColor(Color.criticalLight)
                    .borderRadius(Radius.pill)
                    .margin({ left: 8 })
                }
                .alignItems(VerticalAlign.Center)

                Text('服务端未提供账号注销接口')
                  .fontSize(FontSize.caption)
                  .fontColor(Color.textSecondary)
                  .margin({ top: 3 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              .margin({ left: Space.md })
            }
            .width('100%')

            Column() {
              this.consequence('账号数据由服务端与项目负责人管理，APP 无法删除账号或解绑关系。')
              this.consequence('APP 内没有身份核验与数据删除接口，因此不提供“申请注销”流程。')
              this.consequence('如果只是不想在本机继续使用，可直接退出登录清除本机凭证。')
            }
            .width('100%')
            .padding(Space.md)
            .backgroundColor('#FFFFFF')
            .borderRadius(Radius.button)
            .shadow(Shadow_.card())
            .margin({ top: Space.md })
          }
          .padding(Space.lg - 1)
          .width('100%')
          .borderRadius(22)
          .linearGradient(Grad.heroCritical())
          .shadow(Shadow_.pop('rgba(220,38,38,0.12)'))
          .alignItems(HorizontalAlign.Start)
          .margin({ left: Space.lg, right: Space.lg, top: Space.md - 2 })

          Column() {
            Text('真正需要注销时')
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.textPrimary)
            Text('请联系项目负责人核验身份后，由服务端侧删除账号与绑定关系。服务端删除后请在本机退出登录，避免残留旧凭证。')
              .fontSize(FontSize.body)
              .fontColor(Color.textSecondary)
              .lineHeight(19)
              .margin({ top: Space.sm })
            Text('本机退出登录入口：「我的」页底部 → 退出登录（会清除本机安全存储中的登录凭证并停止后台刷新）。')
              .fontSize(FontSize.caption)
              .fontColor(Color.textTertiary)
              .lineHeight(17)
              .margin({ top: Space.sm })
          }
          .padding(Space.lg - 2)
          .width('100%')
          .backgroundColor(Color.card)
          .borderRadius(Radius.card)
          .shadow(Shadow_.card())
          .alignItems(HorizontalAlign.Start)
          .margin({ left: Space.lg, right: Space.lg, top: Space.md - 2 })

          Column() {
            Row() {
              SecondaryButton({
                label: '返回上一页',
                icon: $r('sys.symbol.chevron_left'),
                color: Color.primaryDark,
                onClick_: () => {
                  this.getUIContext().getRouter().back();
                }
              })
            }
            .width('100%')
          }
          .width('100%')
          .margin({ left: Space.lg, right: Space.lg, top: Space.lg, bottom: Space.xxl })
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
