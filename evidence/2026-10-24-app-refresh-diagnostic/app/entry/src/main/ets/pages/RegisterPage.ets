/**
 * 注册页 —— 本轮真实 API 接入阶段：服务端无自助注册接口，功能未开放
 *  · 账号由项目负责人统一分配（guardianId），APP 不提供自助注册/短信验证
 *  · 不调用本地账号存储、短信服务或本地会话模块
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { NavBar } from '../components/NavBar';
import { Medal } from '../components/Medal';
import { SecondaryButton } from '../components/Buttons';

@Entry
@Component
struct RegisterPage {

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
      NavBar({ title: '注册新账号', showBack: true })

      Scroll() {
        Column() {
          // 状态英雄卡
          Column() {
            Row() {
              Medal({ variant: 'warn', icon: $r('sys.symbol.person_fill'), medalSize: 44 })
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

                Text('服务端未提供监护人账号注册接口')
                  .fontSize(FontSize.caption)
                  .fontColor(Color.textSecondary)
                  .margin({ top: 3 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              .margin({ left: Space.md })
            }
            .width('100%')

            Text('当前 APP-API-v1 只有登录接口（POST /api/v1/auth/app），没有注册、短信验证或账号绑定接口。为避免伪造任何成功结果，本页仅作说明。')
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

          // 说明卡
          Column() {
            Text('账号如何获取')
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.textPrimary)

            Column() {
              this.reason('监护人账号（guardianId）与登录口令由项目负责人统一分配，APP 不提供自助注册。')
              this.reason('口令为 32–256 位字符串，请向项目负责人索取，且不要在本机明文记录。')
              this.reason('如需新增监护人账号或调整绑定关系，请联系项目负责人线下处理。')
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

          // 替代操作
          Column() {
            Text('你可以做什么')
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.textPrimary)
            Text('返回登录页，使用项目负责人提供的 guardianId 与口令登录。登录后的数据全部来自真实服务端。')
              .fontSize(FontSize.body)
              .fontColor(Color.textSecondary)
              .lineHeight(19)
              .margin({ top: Space.sm })
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
            .margin({ top: Space.md })
          }
          .padding(Space.lg - 2)
          .width('100%')
          .backgroundColor(Color.card)
          .borderRadius(Radius.card)
          .shadow(Shadow_.card())
          .alignItems(HorizontalAlign.Start)
          .margin({ left: Space.lg, right: Space.lg, top: Space.md - 2, bottom: Space.xxl })
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
