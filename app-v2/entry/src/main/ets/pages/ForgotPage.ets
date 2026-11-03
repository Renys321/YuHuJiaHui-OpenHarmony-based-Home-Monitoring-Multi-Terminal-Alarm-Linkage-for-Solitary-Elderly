/**
 * 忘记密码页 —— 通过绑定手机号短信验证码重置密码
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { NavBar } from '../components/NavBar';
import { AccountStore } from '../common/AccountStore';
import { SmsService } from '../common/SmsService';

@Entry
@Component
struct ForgotPage {
  @State phone: string = '';
  @State code: string = '';
  @State pwd: string = '';
  @State pwd2: string = '';
  @State sec: number = 0;
  @State loading: boolean = false;
  @State phoneErr: boolean = false;
  @State codeErr: boolean = false;
  @State pwdErr: boolean = false;
  private timerId: number = -1;

  aboutToDisappear() {
    if (this.timerId !== -1) {
      clearInterval(this.timerId);
    }
  }

  private phonePlain(): string {
    return this.phone.split(' ').join('');
  }

  private phoneOk(): boolean {
    return this.phonePlain().length === 11 && this.phonePlain().charAt(0) === '1';
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
    if (!this.phoneOk()) {
      this.phoneErr = true;
      this.toast('请输入正确的 11 位手机号');
      return;
    }
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) return;
    AccountStore.findByPhone(ctx, this.phonePlain()).then((acc) => {
      if (acc === null) {
        this.phoneErr = true;
        this.toast('该手机号未注册，无法找回');
        return;
      }
      const code = SmsService.send(this.phonePlain(), 'reset');
      this.sec = 60;
      this.timerId = setInterval(() => {
        this.sec -= 1;
        if (this.sec <= 0) {
          clearInterval(this.timerId);
          this.timerId = -1;
          this.sec = 0;
        }
      }, 1000);
      this.toast(`【演示短信】重置验证码：${code}（发送至绑定手机）`);
    });
  }

  private submit(): void {
    if (this.loading) return;
    if (!this.phoneOk()) {
      this.phoneErr = true;
      this.toast('请输入正确的 11 位手机号');
      return;
    }
    if (!SmsService.verify(this.phonePlain(), 'reset', this.code)) {
      this.codeErr = true;
      this.toast('验证码错误或已过期');
      return;
    }
    if (this.pwd.length < 6) {
      this.pwdErr = true;
      this.toast('新密码至少 6 位');
      return;
    }
    if (this.pwd !== this.pwd2) {
      this.pwdErr = true;
      this.toast('两次输入的密码不一致');
      return;
    }
    this.loading = true;
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.loading = false;
      return;
    }
    AccountStore.updatePassword(ctx, this.phonePlain(), this.pwd).then(() => {
      this.loading = false;
      this.toast('密码重置成功，请用新密码登录');
      setTimeout(() => {
        this.getUIContext().getRouter().back();
      }, 600);
    });
  }

  build() {
    Column() {
      NavBar({ title: '找回密码', showBack: true })

      Scroll() {
        Column() {
          Column() {
            Text('重置登录密码')
              .fontSize(FontSize.h1)
              .fontWeight(FontWeight_.extrabold)
              .fontColor(Color.textPrimary)
            Text('验证码将发送至账号绑定的手机号')
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .margin({ top: 4 })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ left: 4, right: 4, top: Space.lg, bottom: Space.lg })

          Column() {
            Row() {
              Column() {
                Image($r('app.media.ic_phone_reg'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.primaryLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              TextInput({ placeholder: '请输入注册时绑定的手机号', text: this.phone })
                .type(InputType.Number)
                .maxLength(13)
                .fontSize(FontSize.h3 - 1)
                .fontColor(Color.textPrimary)
                .backgroundColor('rgba(0,0,0,0)')
                .padding(0)
                .layoutWeight(1)
                .onChange((v: string) => {
                  this.phone = v;
                  this.phoneErr = false;
                })
            }
            .width('100%')
            .height(50)
            .padding({ left: Space.md, right: Space.md })
            .backgroundColor('#F8FAFC')
            .borderRadius(Radius.button)
            .border({ width: 1.5, color: this.phoneErr ? Color.critical : Color.border })
            .margin({ bottom: Space.md })

            Row() {
              Column() {
                Image($r('app.media.ic_shield'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.primaryLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              TextInput({ placeholder: '请输入 6 位验证码', text: this.code })
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
                .fontColor(this.sec > 0 ? Color.textTertiary : Color.primaryDark)
                .padding({ left: 6 })
                .onClick(() => { this.sendCode(); })
            }
            .width('100%')
            .height(50)
            .padding({ left: Space.md, right: Space.md })
            .backgroundColor('#F8FAFC')
            .borderRadius(Radius.button)
            .border({ width: 1.5, color: this.codeErr ? Color.critical : Color.border })
            .margin({ bottom: Space.md })

            Row() {
              Column() {
                Image($r('app.media.ic_lock'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.primaryLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              TextInput({ placeholder: '设置新密码（至少 6 位）', text: this.pwd })
                .type(InputType.Password)
                .maxLength(20)
                .fontSize(FontSize.h3 - 1)
                .fontColor(Color.textPrimary)
                .backgroundColor('rgba(0,0,0,0)')
                .padding(0)
                .layoutWeight(1)
                .onChange((v: string) => {
                  this.pwd = v;
                  this.pwdErr = false;
                })
            }
            .width('100%')
            .height(50)
            .padding({ left: Space.md, right: Space.md })
            .backgroundColor('#F8FAFC')
            .borderRadius(Radius.button)
            .border({ width: 1.5, color: this.pwdErr ? Color.critical : Color.border })
            .margin({ bottom: Space.md })

            Row() {
              Column() {
                Image($r('app.media.ic_lock'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.primaryLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              TextInput({ placeholder: '再次输入新密码', text: this.pwd2 })
                .type(InputType.Password)
                .maxLength(20)
                .fontSize(FontSize.h3 - 1)
                .fontColor(Color.textPrimary)
                .backgroundColor('rgba(0,0,0,0)')
                .padding(0)
                .layoutWeight(1)
                .onChange((v: string) => {
                  this.pwd2 = v;
                  this.pwdErr = false;
                })
            }
            .width('100%')
            .height(50)
            .padding({ left: Space.md, right: Space.md })
            .backgroundColor('#F8FAFC')
            .borderRadius(Radius.button)
            .border({ width: 1.5, color: this.pwdErr ? Color.critical : Color.border })
            .margin({ bottom: Space.lg })

            Row() {
              if (this.loading) {
                LoadingProgress()
                  .width(18).height(18)
                  .color('#FFFFFF')
                  .margin({ right: Space.sm })
                Text('重置中…')
                  .fontSize(15)
                  .fontWeight(FontWeight_.bold)
                  .fontColor('#FFFFFF')
              } else {
                Text('重置密码')
                  .fontSize(15)
                  .fontWeight(FontWeight_.bold)
                  .fontColor('#FFFFFF')
                  .letterSpacing(2)
              }
            }
            .width('100%')
            .height(50)
            .justifyContent(FlexAlign.Center)
            .borderRadius(Radius.button)
            .linearGradient(Grad.primary())
            .shadow(Shadow_.pop('rgba(2,132,199,0.35)'))
            .onClick(() => { this.submit(); })
          }
          .width('100%')
          .padding(Space.lg)
          .backgroundColor(Color.card)
          .borderRadius(22)
          .shadow({ radius: 30, color: 'rgba(15,23,42,0.08)', offsetX: 0, offsetY: 10 })
          .margin({ left: Space.lg, right: Space.lg, bottom: Space.xxl })
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
