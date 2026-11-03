/**
 * 找回密码页 —— 本轮真实 API 接入阶段：服务端无找回/重置口令接口，功能未开放
 *  · 不调用本地账号存储、短信服务或本地会话模块，不出现短信验证或任何成功流程
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { NavBar } from '../components/NavBar';
import { Medal } from '../components/Medal';
import { SecondaryButton } from '../components/Buttons';

@Entry
@Component
struct ForgotPage {

  @Builder
  reason(text: string) {
    Row() {
      Column()
        .width(5)
        .height(5)
        .borderRadius(2.5)
        .backgroundColor(Color.warning)
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
      NavBar({ title: '找回密码', showBack: true })

      Scroll() {
        Column() {
          Column() {
            Row() {
              Medal({ variant: 'warn', icon: $r('sys.symbol.exclamationmark_triangle_fill'), medalSize: 44 })
              Column() {
                Row() {
                  Text('该功能未开放')
                    .fontSize(FontSize.h1)
                    .fontWeight(FontWeight_.extrabold)
                    .fontColor(Color.textPrimary)
                  Text('未开放')
                    .fontSize(FontSize.mini)
                    .fontWeight(FontWeight_.bold)
                    .fontColor(Color.warningDark)
                    .padding({ left: 8, right: 8, top: 2, bottom: 2 })
                    .backgroundColor(Color.warningLight)
                    .borderRadius(Radius.pill)
                    .margin({ left: 8 })
                }
                .alignItems(VerticalAlign.Center)

                Text('服务端未提供找回或重置口令接口')
                  .fontSize(FontSize.caption)
                  .fontColor(Color.textSecondary)
                  .margin({ top: 3 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              .margin({ left: Space.md })
            }
            .width('100%')

            Text('APP-API-v1 没有短信验证、口令重置或找回接口。为避免伪造任何成功结果，本页仅作说明。')
              .fontSize(FontSize.body)
              .fontColor(Color.textSecondary)
              .lineHeight(19)
              .margin({ top: Space.md })
          }
          .padding(Space.lg - 1)
          .width('100%')
          .borderRadius(22)
          .linearGradient(Grad.heroWarning())
          .shadow(Shadow_.card())
          .alignItems(HorizontalAlign.Start)
          .margin({ left: Space.lg, right: Space.lg, top: Space.md - 2 })

          Column() {
            Text('口令无法找回时')
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.textPrimary)

            Column() {
              this.reason('请联系项目负责人核验身份后线下重置口令；APP 内不提供重置入口。')
              this.reason('不要在备注、聊天记录或本机便签中明文保存登录口令。')
              this.reason('登录失败提示“账号或口令错误”时，APP 不会透露账号是否存在。')
            }
            .width('100%')
            .margin({ top: Space.md })
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
                label: '返回登录页',
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
