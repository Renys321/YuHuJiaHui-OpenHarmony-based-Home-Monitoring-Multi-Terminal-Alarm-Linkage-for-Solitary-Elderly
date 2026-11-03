// 修改密码页
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { NavBar } from '../components/NavBar';
import { AccountStore, AccountInfo } from '../common/AccountStore';
import { Session } from '../common/Session';

@Entry
@Component
struct ChangePwdPage {
  @State phone: string = '';
  @State oldPwd: string = '';
  @State pwd: string = '';
  @State pwd2: string = '';
  @State loading: boolean = false;
  @State oldErr: boolean = false;
  @State pwdErr: boolean = false;

  aboutToAppear() {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) return;
    Session.load(ctx).then((p: string) => {
      this.phone = p;
    });
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg });
    } catch (err) {
      // 忽略
    }
  }

  private submit(): void {
    if (this.loading) return;
    if (this.phone.length === 0) {
      this.toast('会话已失效，请重新登录');
      return;
    }
    if (this.oldPwd.length === 0) {
      this.oldErr = true;
      this.toast('请输入当前密码');
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
    AccountStore.findByPhone(ctx, this.phone).then((acc: AccountInfo | null) => {
      if (acc === null) {
        this.loading = false;
        this.toast('账号不存在，请重新登录');
        return;
      }
      return AccountStore.hashPassword(this.phone, this.oldPwd).then((hashed: string) => {
        if (hashed !== acc.password) {
          this.loading = false;
          this.oldErr = true;
          this.toast('当前密码不正确');
          return;
        }
        return AccountStore.updatePassword(ctx, this.phone, this.pwd).then(() => {
          this.loading = false;
          this.toast('密码修改成功');
          setTimeout(() => {
            this.getUIContext().getRouter().back();
          }, 600);
        });
      });
    });
  }

  build() {
    Column() {
      NavBar({ title: '修改密码', showBack: true })

      Scroll() {
        Column() {
          Column() {
            Text('修改登录密码')
              .fontSize(FontSize.h1)
              .fontWeight(FontWeight_.extrabold)
              .fontColor(Color.textPrimary)
            Text(`当前账号：${this.phone.length === 11
              ? `${this.phone.substring(0, 3)}****${this.phone.substring(7)}` : this.phone}`)
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
                Image($r('app.media.ic_lock'))
                  .width(15).height(15)
              }
              .width(30).height(30).borderRadius(10)
              .backgroundColor(Color.primaryLight)
              .justifyContent(FlexAlign.Center)
              .margin({ right: 10 })

              TextInput({ placeholder: '请输入当前密码', text: this.oldPwd })
                .type(InputType.Password)
                .maxLength(20)
                .fontSize(FontSize.h3 - 1)
                .fontColor(Color.textPrimary)
                .backgroundColor('rgba(0,0,0,0)')
                .padding(0)
                .layoutWeight(1)
                .onChange((v: string) => {
                  this.oldPwd = v;
                  this.oldErr = false;
                })
            }
            .width('100%')
            .height(50)
            .padding({ left: Space.md, right: Space.md })
            .backgroundColor('#F8FAFC')
            .borderRadius(Radius.button)
            .border({ width: 1.5, color: this.oldErr ? Color.critical : Color.border })
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
                Text('提交中…')
                  .fontSize(15)
                  .fontWeight(FontWeight_.bold)
                  .fontColor('#FFFFFF')
              } else {
                Text('确认修改')
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

            Text('如忘记当前密码，可退出登录后在登录页使用「忘记密码」通过绑定手机重置')
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
