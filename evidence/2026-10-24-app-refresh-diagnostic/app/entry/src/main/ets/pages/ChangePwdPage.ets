/**
 * 修改密码页 —— 本轮真实 API 接入阶段：服务端无修改口令接口，功能未开放
 *  · APP-API-v1 无修改口令 / 校验旧口令接口，不提供任何“已修改”流程
 *  · 不调用本地账号存储、短信服务或本地会话模块
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { NavBar } from '../components/NavBar';
import { Medal } from '../components/Medal';
import { SecondaryButton } from '../components/Buttons';

@Entry
@Component
struct ChangePwdPage {

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
      NavBar({ title: '修改密码', showBack: true })

      Scroll() {
        Column() {
          Column() {
            Row() {
              Medal({ variant: 'warn', icon: $r('sys.symbol.gearshape'), medalSize: 44 })
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

                Text('服务端未提供修改登录口令接口')
                  .fontSize(FontSize.caption)
                  .fontColor(Color.textSecondary)
                  .margin({ top: 3 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              .margin({ left: Space.md })
            }
            .width('100%')

            Text('当前登录口令由服务端统一管理。APP 没有校验旧口令、提交新口令或刷新凭证的接口，因此不提供修改入口，也不会给出任何成功提示。')
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
            Text('需要更换口令时')
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.textPrimary)

            Column() {
              this.reason('请联系项目负责人，由其线下为你重置登录口令并重新分发。')
              this.reason('重置后请在本机登录页重新登录；旧的登录凭证由服务端判定失效。')
              this.reason('请勿将口令写入备忘录、聊天记录或公开投屏内容。')
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
