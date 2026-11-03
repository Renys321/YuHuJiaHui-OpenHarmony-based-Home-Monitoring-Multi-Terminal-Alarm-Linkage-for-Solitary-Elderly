// 注册页
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { NavBar } from '../components/NavBar';
import { AccountStore } from '../common/AccountStore';
import { SmsService } from '../common/SmsService';
import { Session } from '../common/Session';

@Entry
@Component
struct RegisterPage {
  @State phone: string = '';
  @State code: string = '';
  @State pwd: string = '';
  @State pwd2: string = '';
  @State nickname: string = '';
  @State relation: string = '儿子';
  @State sec: number = 0;
  @State loading: boolean = false;
  @State phoneErr: boolean = false;
  @State codeErr: boolean = false;
  @State pwdErr: boolean = false;
  private relations: string[] = ['儿子', '女儿', '配偶', '社区网格员', '其他'];
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

  private startCountdown(): void {
    this.sec = 60;
    this.timerId = setInterval(() => {
      this.sec -= 1;
      if (this.sec <= 0) {
        clearInterval(this.timerId);
        this.timerId = -1;
        this.sec = 0;
      }
    }, 1000);
  }

  private sendCode(): void {
    if (this.sec > 0 || this.loading)
      return;
    if (!this.phoneOk()) {
      this.phoneErr = true;
      this.toast('请输入正确的 11 位手机号');
      return;
    }
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined)
      return;
    AccountStore.findByPhone(ctx, this.phonePlain()).then((acc) => {
      if (acc !== null) {
        this.phoneErr = true;
        this.toast('该手机号已注册，请直接登录或找回密码');
        return;
      }
      const code = SmsService.send(this.phonePlain(), 'register');
      this.startCountdown();
      this.toast(`【演示短信】注册验证码：${code}（5 分钟内有效）`);
    });
  }

  private submit(): void {
    if (this.loading) return;
    if (!this.phoneOk()) {
      this.phoneErr = true;
      this.toast('请输入正确的 11 位手机号');
      return;
    }
    if (!SmsService.verify(this.phonePlain(), 'register', this.code)) {
      this.codeErr = true;
      this.toast('验证码错误或已过期');
      return;
    }
    if (this.pwd.length < 6) {
      this.pwdErr = true;
      this.toast('密码至少 6 位');
      return;
    }
    if (this.pwd !== this.pwd2) {
      this.pwdErr = true;
      this.toast('两次输入的密码不一致');
      return;
    }
    const nick = this.nickname.length > 0 ? this.nickname : '监护人';
    this.loading = true;
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.loading = false;
      return;
    }
    AccountStore.register(ctx, this.phonePlain(), this.pwd, nick, this.relation).then(() => {
      return Session.addHistory(ctx, this.phonePlain(), nick);
    }).then(() => {
      return Session.save(ctx, this.phonePlain(), true);
    }).then(() => {
      this.loading = false;
      this.toast('注册成功，手机号已绑定为安全手机');
      setTimeout(() => {
        this.getUIContext().getRouter().replaceUrl({ url: 'pages/Index' });
      }, 600);
    });
  }

  build() {
    Column() {
      NavBar({ title: '注册新账号', showBack: true })

      Scroll() {
        Column() {
          Column() {
            Text('创建监护人账号')
              .fontSize(FontSize.h1)
              .fontWeight(FontWeight_.extrabold)
              .fontColor(Color.textPrimary)
            Text('注册后自动绑定手机号，用于验证码登录与找回密码')
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .margin({ top: 4 })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ left: 4, right: 4, top: Space.lg, bottom: Space.lg })

          Column() {
            // 手机号
            Row() {
              Column() {
                Image($r('app.media.ic_phone_reg'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.primaryLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              Text('+86')
                .fontSize(FontSize.h3 - 1)
                .fontWeight(FontWeight_.bold)
                .fontColor(Color.textPrimary)
                .padding({ right: 10 })
                .border({ width: { right: 1 }, color: Color.border })
                .margin({ right: 10 })

              TextInput({ placeholder: '请输入手机号（将自动绑定）', text: this.phone })
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

            // 验证码
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

            // 密码
            Row() {
              Column() {
                Image($r('app.media.ic_lock'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.primaryLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              TextInput({ placeholder: '设置密码（至少 6 位）', text: this.pwd })
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

            // 确认密码
            Row() {
              Column() {
                Image($r('app.media.ic_lock'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.primaryLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              TextInput({ placeholder: '再次输入密码', text: this.pwd2 })
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
            .margin({ bottom: Space.md })

            // 昵称
            Row() {
              Column() {
                Image($r('app.media.ic_person_reg'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.primaryLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              TextInput({ placeholder: '昵称（选填，默认"监护人"）', text: this.nickname })
                .maxLength(12)
                .fontSize(FontSize.h3 - 1)
                .fontColor(Color.textPrimary)
                .backgroundColor('rgba(0,0,0,0)')
                .padding(0)
                .layoutWeight(1)
                .onChange((v: string) => { this.nickname = v; })
            }
            .width('100%')
            .height(50)
            .padding({ left: Space.md, right: Space.md })
            .backgroundColor('#F8FAFC')
            .borderRadius(Radius.button)
            .border({ width: 1.5, color: Color.border })
            .margin({ bottom: Space.md })

            // 与老人关系
            Column() {
              Text('与老人关系')
                .fontSize(FontSize.caption)
                .fontColor(Color.textSecondary)
              Row({ space: 8 }) {
                ForEach(this.relations, (r: string) => {
                  Text(r)
                    .fontSize(FontSize.body - 1)
                    .fontWeight(this.relation === r ? FontWeight_.bold : FontWeight_.regular)
                    .fontColor(this.relation === r ? '#FFFFFF' : Color.textSecondary)
                    .padding({ left: 12, right: 12, top: 6, bottom: 6 })
                    .borderRadius(Radius.pill)
                    .linearGradient(this.relation === r
                      ? Grad.primary()
                      : { angle: 135, colors: [[Color.card, 0.0], [Color.card, 1.0]] })
                    .border({ width: 1, color: this.relation === r ? 'rgba(0,0,0,0)' : Color.border })
                    .onClick(() => { this.relation = r; })
                }, (r: string) => r)
              }
              .width('100%')
              .margin({ top: Space.sm })
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .margin({ bottom: Space.lg })

            // 注册按钮
            Row() {
              if (this.loading) {
                LoadingProgress()
                  .width(18).height(18)
                  .color('#FFFFFF')
                  .margin({ right: Space.sm })
                Text('注册中…')
                  .fontSize(15)
                  .fontWeight(FontWeight_.bold)
                  .fontColor('#FFFFFF')
              } else {
                Text('注册并绑定手机号')
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

            Text('注册即代表同意《用户协议》与《隐私政策》；密码以 SHA-256 加盐哈希存储')
              .fontSize(FontSize.mini)
              .fontColor(Color.textTertiary)
              .textAlign(TextAlign.Center)
              .margin({ top: Space.md })
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
