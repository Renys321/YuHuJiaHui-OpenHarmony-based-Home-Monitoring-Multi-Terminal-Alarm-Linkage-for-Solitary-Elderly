import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { NavBar } from '../components/NavBar';
import { Medal } from '../components/Medal';
import { PrimaryButton } from '../components/Buttons';
import { AccountStore } from '../common/AccountStore';
import { SmsService } from '../common/SmsService';
import { Session } from '../common/Session';

@Entry
@Component
struct CancelAccountPage {
  @State phone: string = '';
  @State code: string = '';
  @State sec: number = 0;
  @State agreed: boolean = false;
  @State loading: boolean = false;
  @State codeErr: boolean = false;
  private timerId: number = -1;

  aboutToAppear() {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) return;
    Session.load(ctx).then((p: string) => {
      this.phone = p;
    });
  }

  aboutToDisappear() {
    if (this.timerId !== -1) {
      clearInterval(this.timerId);
    }
  }

  private maskedPhone(): string {
    if (this.phone.length !== 11) {
      return this.phone.length > 0 ? this.phone : '未绑定';
    }
    return `${this.phone.substring(0, 3)}****${this.phone.substring(7)}`;
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg });
    } catch (err) {
      // 忽略
    }
  }

  private sendCode(): void {
    if (this.sec > 0 || this.loading) return;
    if (this.phone.length === 0) {
      this.toast('会话已失效，请重新登录');
      return;
    }
    const code = SmsService.send(this.phone, 'cancel');
    this.sec = 60;
    this.timerId = setInterval(() => {
      this.sec -= 1;
      if (this.sec <= 0) {
        clearInterval(this.timerId);
        this.timerId = -1;
        this.sec = 0;
      }
    }, 1000);
    this.toast(`【演示短信】注销验证码：${code}（发送至绑定手机）`);
  }

  private canSubmit(): boolean {
    return this.code.length === 6 && this.agreed && !this.loading;
  }

  private submit(): void {
    if (this.loading) return;
    if (this.code.length !== 6) {
      this.codeErr = true;
      this.toast('请输入 6 位验证码');
      return;
    }
    if (!SmsService.verify(this.phone, 'cancel', this.code)) {
      this.codeErr = true;
      this.toast('验证码错误或已过期');
      return;
    }
    if (!this.agreed) {
      this.toast('请先勾选注销协议');
      return;
    }
    this.getUIContext().getPromptAction().showDialog({
      title: '确认注销账号',
      message: `账号 ${this.maskedPhone()} 将被永久删除，全部数据无法恢复。确认继续？`,
      buttons: [
        { text: '再想想', color: Color.textSecondary },
        { text: '确认注销', color: Color.critical }
      ]
    }).then((result) => {
      if (result.index !== 1) {
        return;
      }
      this.loading = true;
      const ctx = this.getUIContext().getHostContext();
      if (ctx === undefined) {
        this.loading = false;
        return;
      }
      AccountStore.deleteAccount(ctx, this.phone).then(() => {
        return Session.removeHistory(ctx, this.phone);
      }).then(() => {
        return Session.clear(ctx);
      }).then(() => {
        this.loading = false;
        this.toast('账号已注销，期待再次相遇');
        setTimeout(() => {
          this.getUIContext().getRouter().replaceUrl({ url: 'pages/LoginPage' });
        }, 600);
      });
    });
  }

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
        .fontSize(FontSize.body - 0.5)
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
          // 警示英雄卡
          Column() {
            Row() {
              Medal({ variant: 'crit', icon: $r('sys.symbol.exclamationmark_triangle_fill'), medalSize: 44 })
              Column() {
                Text('申请注销账号')
                  .fontSize(FontSize.h1)
                  .fontWeight(FontWeight_.extrabold)
                  .fontColor(Color.textPrimary)
                Text(`当前账号：${this.maskedPhone()}`)
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
              this.consequence('账号信息与登录凭证将被永久删除，无法恢复')
              this.consequence('绑定手机号立即解绑，之后注册视为全新账号')
              this.consequence('该账号下的安全日志、处置记录将随账号一并清除')
              this.consequence('若老人仍需监护，请先转移至其他监护人账号')
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

          // 身份核验卡
          Column() {
            Text('身份核验')
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.textPrimary)
            Text('验证码将发送至绑定手机，用于确认本人操作')
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .margin({ top: 3 })

            Row() {
              Column() {
                Image($r('app.media.ic_shield'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.criticalLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              TextInput({ placeholder: '请输入 6 位注销验证码', text: this.code })
                .type(InputType.Number)
                .maxLength(6)
                .fontSize(FontSize.h3 - 1)
                .fontColor(Color.textPrimary)
                .backgroundColor('rgba(0,0,0,0)')
                .padding(0)
                .layoutWeight(1)
                .onChange((v: string) => {
                  this.code = v;
                  this.codeErr = false;
                })

              Text(this.sec > 0 ? `${this.sec}s 后重发` : '获取验证码')
                .fontSize(FontSize.body)
                .fontWeight(this.sec > 0 ? FontWeight_.semibold : FontWeight_.bold)
                .fontColor(this.sec > 0 ? Color.textTertiary : Color.criticalDark)
                .padding({ left: 6 })
                .onClick(() => { this.sendCode(); })
            }
            .width('100%')
            .height(50)
            .padding({ left: Space.md, right: Space.md })
            .backgroundColor('#F8FAFC')
            .borderRadius(Radius.button)
            .border({ width: 1.5, color: this.codeErr ? Color.critical : Color.border })
            .margin({ top: Space.md })

            Row() {
              Stack() {
                Column()
                  .width(14).height(14).borderRadius(4)
                  .backgroundColor('#FFFFFF')
                  .border({ width: 1.5, color: this.agreed ? 'rgba(0,0,0,0)' : '#CBD5E1' })
                if (this.agreed) {
                  Column()
                    .width(14).height(14).borderRadius(4)
                    .linearGradient(Grad.critical())
                  SymbolGlyph($r('sys.symbol.checkmark'))
                    .fontSize(8)
                    .fontColor(['#FFFFFF'])
                }
              }
              .width(14).height(14)
              .margin({ top: 2 })
              .onClick(() => { this.agreed = !this.agreed; })

              Text() {
                Span('我已阅读 ')
                  .fontSize(FontSize.mini)
                  .fontColor(Color.textTertiary)
                Span('《账号注销协议》')
                  .fontSize(FontSize.mini)
                  .fontColor(Color.criticalDark)
                Span('，知悉注销后全部数据不可恢复')
                  .fontSize(FontSize.mini)
                  .fontColor(Color.textTertiary)
              }
              .layoutWeight(1)
              .margin({ left: 7 })
              .lineHeight(16)
              .onClick(() => { this.agreed = !this.agreed; })
            }
            .width('100%')
            .alignItems(VerticalAlign.Top)
            .margin({ top: Space.md })
          }
          .padding(Space.lg - 2)
          .width('100%')
          .backgroundColor(Color.card)
          .borderRadius(Radius.card)
          .shadow(Shadow_.card())
          .alignItems(HorizontalAlign.Start)
          .margin({ left: Space.lg, right: Space.lg, top: Space.md - 2 })

          // 注销按钮
          Column() {
            PrimaryButton({
              label: this.loading ? '注销中…' : '确认注销账号',
              loading: this.loading,
              disabled: !(this.code.length === 6 && this.agreed),
              variant: 'critical',
              onClick_: () => { this.submit(); }
            })
          }
          .margin({ left: Space.lg, right: Space.lg, top: Space.lg })

          Text('注销后如需继续使用，可用同一手机号重新注册')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .textAlign(TextAlign.Center)
            .margin({ top: Space.md, bottom: Space.xxl })
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
