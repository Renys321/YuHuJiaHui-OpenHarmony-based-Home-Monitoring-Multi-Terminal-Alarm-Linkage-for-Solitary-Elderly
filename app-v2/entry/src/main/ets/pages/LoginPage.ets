/**
 * 登录页（v2 新版视觉 + 真实后端认证）
 *  · 版式对齐新版：品牌头图 + 卡片内「验证码登录 / 密码登录」tabs + 一键演示
 *  · 实际可用：密码登录（guardianId + password → POST /api/v1/auth/app）
 *  · 验证码登录/注册：后端无接口，明确标注“未开放”，不伪造发送
 *  · 记住登录 = 系统安全存储；未勾选 = 仅本次运行内存会话
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { GuardianService } from '../service/GuardianService';
import { DemoMode } from '../demo/DemoMode';
import { LoginOutcome } from '../core/service/Outcomes';

@Entry
@Component
struct LoginPage {
  @State pwd: string = '';
  @State showPwd: boolean = false;
  @State remember: boolean = true;
  @State agreed: boolean = false;
  @State loading: boolean = false;
  @State phoneErr: boolean = false;
  @State pwdErr: boolean = false;
  @State errText: string = '';
  @State restoring: boolean = true;
  @State mode: string = 'pwd';
  @State phone: string = '';
  @State code: string = '';

  aboutToAppear(): void {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.restoring = false;
      return;
    }
    GuardianService.init(ctx);
    GuardianService.restoreSession().then((ok: boolean) => {
      this.restoring = false;
      if (ok && GuardianService.isLoggedIn()) {
        this.getUIContext().getRouter().replaceUrl({ url: 'pages/Index' });
      }
    }).catch(() => {
      this.restoring = false;
    });
  }

  aboutToDisappear(): void {
    this.pwd = '';
  }

  private phoneOk(): boolean {
    if (this.phone.length !== 11 || this.phone.charAt(0) !== '1') return false;
    for (let i = 0; i < this.phone.length; i++) {
      const c: number = this.phone.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    return true;
  }

  private pwdOk(): boolean {
    return this.pwd.length >= 8 && this.pwd.length <= 256;
  }

  private formOk(): boolean {
    return this.agreed && this.phoneOk() && this.pwdOk() && !this.loading && !this.restoring;
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg });
    } catch (err) {}
  }

  private friendlyError(out: LoginOutcome): string {
    if (out.kind === 'rate_limited') {
      return out.retryAfterSeconds > 0 ? `尝试过多，请 ${out.retryAfterSeconds} 秒后再试` : '尝试过多，请稍后再试';
    }
    if (out.message.length > 0) return out.message;
    if (out.kind === 'unauthorized') return '账号或口令错误';
    if (out.kind === 'forbidden') return '账号已被服务端停用';
    if (out.kind === 'service_unavailable') return '服务端登录未配置';
    if (out.kind === 'timeout') return '请求超时，请检查网络后重试';
    if (out.kind === 'network') return '网络不可用，请检查连接';
    if (out.kind === 'server') return '服务端异常，请稍后重试';
    if (out.kind === 'malformed') return '服务端响应异常，请稍后重试';
    return '登录失败，请稍后重试';
  }

  private enterIndex(): void {
    AppStorage.setOrCreate('currentTabIndex', 0);
    this.getUIContext().getRouter().replaceUrl({ url: 'pages/Index' });
  }

  private enterDemo(): void {
    if (this.loading || this.restoring) return;
    this.pwd = '';
    DemoMode.enter();
    this.enterIndex();
  }

  private submit(): void {
    if (this.loading || this.restoring) return;
    this.errText = '';
    if (this.mode === 'code') {
      this.errText = '验证码登录未开放：后端未提供短信发送/校验接口，请使用密码登录';
      return;
    }
    if (!this.agreed) {
      this.errText = '请先阅读并勾选用户协议与隐私政策';
      return;
    }
    if (!this.phoneOk()) {
      this.phoneErr = true;
      this.errText = '请输入 11 位手机号';
      return;
    }
    if (!this.pwdOk()) {
      this.pwdErr = true;
      this.errText = '登录口令需为 8–256 位';
      return;
    }
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.errText = '运行环境异常，请重启应用后重试';
      return;
    }
    GuardianService.init(ctx);
    this.loading = true;
    const gid: string = this.phone;
    const secret: string = this.pwd;
    GuardianService.login(gid, secret, this.remember).then((out: LoginOutcome) => {
      this.loading = false;
      this.pwd = '';
      this.showPwd = false;
      if (out.ok) {
        this.errText = '';
        AppStorage.delete('gv.elderOverride');
        AppStorage.delete('gv.contactsOverride');
        this.toast('登录成功，正在进入工作台');
        this.enterIndex();
        return;
      }
      if (out.kind === 'unauthorized') this.pwdErr = true;
      this.errText = this.friendlyError(out);
    }).catch(() => {
      this.loading = false;
      this.pwd = '';
      this.showPwd = false;
      this.errText = '登录请求失败，请稍后重试';
    });
  }

  private fieldBorder(err: boolean): string {
    if (err) return Color.critical;
    return Color.border;
  }

  private fieldBg(): string {
    return '#F8FAFC';
  }

  @Builder
  tabItem(label: string, active: boolean, onTap: () => void) {
    Text(label)
      .fontSize(FontSize.body - 1)
      .fontWeight(active ? FontWeight_.bold : FontWeight_.semibold)
      .fontColor(active ? Color.primaryDark : Color.textSecondary)
      .padding({ top: 9, bottom: 9 })
      .layoutWeight(1)
      .textAlign(TextAlign.Center)
      .borderRadius(10)
      .backgroundColor(active ? '#FFFFFF' : 'rgba(0,0,0,0)')
      .shadow(active ? { radius: 6, color: 'rgba(15,23,42,0.10)', offsetX: 0, offsetY: 2 }
        : { radius: 0, color: 'rgba(0,0,0,0)', offsetX: 0, offsetY: 0 })
      .onClick(onTap)
  }

  build() {
    Stack() {
      Column().width(260).height(260).borderRadius(130)
        .backgroundColor(Color.primary).opacity(0.10).position({ x: 220, y: -90 })
      Column().width(200).height(200).borderRadius(100)
        .backgroundColor(Color.accent).opacity(0.08).position({ x: -80, y: 180 })
      Column().width(280).height(280).borderRadius(140)
        .backgroundColor(Color.success).opacity(0.07).position({ x: 180, y: 520 })

      Scroll() {
        Column() {
          Column() {
            Stack() {
              Column() {
                SymbolGlyph($r('sys.symbol.house_fill'))
                  .fontSize(34).fontColor(['#FFFFFF'])
              }
              .width(74).height(74).borderRadius(24)
              .justifyContent(FlexAlign.Center)
              .linearGradient(Grad.primary())
              .shadow(Shadow_.pop('rgba(2,132,199,0.38)'))

              Stack() {
                Column().width(24).height(24).borderRadius(12)
                  .linearGradient(Grad.accent())
                  .shadow(Shadow_.medal('rgba(234,88,12,0.40)'))
                Image($r('app.media.ic_heart')).width(13).height(13)
              }
              .position({ x: 58, y: 58 })
            }
            .width(86).height(86)

            Text('颐养守护')
              .fontSize(26).fontWeight(FontWeight_.extrabold)
              .fontColor(Color.textPrimary).letterSpacing(2)
              .margin({ top: Space.lg })
            Text('独居老人居家安全监测与应急辅助系统')
              .fontSize(FontSize.caption - 0.5)
              .fontColor(Color.textSecondary).letterSpacing(0.5)
              .margin({ top: 6 })
            Row() {
              Image($r('app.media.ic_shield')).width(10).height(10)
              Text('鸿蒙分布式安全认证 · 监护人端')
                .fontSize(FontSize.mini - 0.5).fontWeight(FontWeight_.bold)
                .fontColor(Color.primaryDark).margin({ left: 4 })
            }
            .padding({ left: 10, right: 10, top: 4, bottom: 4 })
            .backgroundColor('#FFFFFF').borderRadius(Radius.pill)
            .shadow({ radius: 8, color: 'rgba(2,132,199,0.15)', offsetX: 0, offsetY: 2 })
            .margin({ top: 10 })
          }
          .width('100%').alignItems(HorizontalAlign.Center)
          .margin({ top: Space.xxl })

          Column() {
            Row() {
              Text('验证码登录')
                .fontSize(FontSize.body - 1)
                .fontWeight(this.mode === 'code' ? FontWeight_.bold : FontWeight_.semibold)
                .fontColor(this.mode === 'code' ? Color.primaryDark : Color.textSecondary)
                .padding({ top: 9, bottom: 9 })
                .layoutWeight(1)
                .textAlign(TextAlign.Center)
                .borderRadius(10)
                .backgroundColor(this.mode === 'code' ? '#FFFFFF' : 'rgba(0,0,0,0)')
                .shadow(this.mode === 'code'
                  ? { radius: 6, color: 'rgba(15,23,42,0.10)', offsetX: 0, offsetY: 2 }
                  : { radius: 0, color: 'rgba(0,0,0,0)', offsetX: 0, offsetY: 0 })
                .onClick(() => {
                  this.mode = 'code';
                  this.errText = '';
                })
              Text('密码登录')
                .fontSize(FontSize.body - 1)
                .fontWeight(this.mode === 'pwd' ? FontWeight_.bold : FontWeight_.semibold)
                .fontColor(this.mode === 'pwd' ? Color.primaryDark : Color.textSecondary)
                .padding({ top: 9, bottom: 9 })
                .layoutWeight(1)
                .textAlign(TextAlign.Center)
                .borderRadius(10)
                .backgroundColor(this.mode === 'pwd' ? '#FFFFFF' : 'rgba(0,0,0,0)')
                .shadow(this.mode === 'pwd'
                  ? { radius: 6, color: 'rgba(15,23,42,0.10)', offsetX: 0, offsetY: 2 }
                  : { radius: 0, color: 'rgba(0,0,0,0)', offsetX: 0, offsetY: 0 })
                .onClick(() => {
                  this.mode = 'pwd';
                  this.errText = '';
                })
            }
            .width('100%').backgroundColor(Color.track)
            .borderRadius(Radius.chip).padding(3)
            .margin({ bottom: Space.md })

            if (this.mode === 'pwd') {
              Row() {
                Column() {
                  Image($r('app.media.ic_person_reg')).width(15).height(15)
                }
                .width(30).height(30).borderRadius(10)
                .backgroundColor(Color.primaryLight)
                .justifyContent(FlexAlign.Center).margin({ right: 10 })
                TextInput({ placeholder: '请输入手机号', text: this.phone })
                  .type(InputType.PhoneNumber)
                  .maxLength(11).fontSize(FontSize.h3 - 1).fontColor(Color.textPrimary)
                  .backgroundColor('rgba(0,0,0,0)').padding(0).layoutWeight(1)
                  .onChange((v: string) => { this.phone = v; this.phoneErr = false; this.errText = ''; })
              }
              .width('100%').height(52)
              .padding({ left: Space.md, right: Space.md })
              .backgroundColor(this.fieldBg())
              .borderRadius(Radius.button)
              .border({ width: 1.5, color: this.fieldBorder(this.phoneErr) })
              .margin({ bottom: Space.md })

              Row() {
                Column() {
                  Image($r('app.media.ic_lock')).width(15).height(15)
                }
                .width(30).height(30).borderRadius(10)
                .backgroundColor(Color.primaryLight)
                .justifyContent(FlexAlign.Center).margin({ right: 10 })
                TextInput({ placeholder: '请输入登录口令', text: this.pwd })
                  .type(this.showPwd ? InputType.Normal : InputType.Password)
                  .maxLength(256).fontSize(FontSize.h3 - 1).fontColor(Color.textPrimary)
                  .backgroundColor('rgba(0,0,0,0)').padding(0).layoutWeight(1)
                  .onChange((v: string) => { this.pwd = v; this.pwdErr = false; this.errText = ''; })
                Image(this.showPwd ? $r('app.media.ic_eye') : $r('app.media.ic_eye_off'))
                  .width(18).height(18).padding({ left: 6 })
                  .onClick(() => { this.showPwd = !this.showPwd; })
              }
              .width('100%').height(52)
              .padding({ left: Space.md, right: Space.md })
              .backgroundColor(this.fieldBg())
              .borderRadius(Radius.button)
              .border({ width: 1.5, color: this.fieldBorder(this.pwdErr) })
              .margin({ bottom: Space.sm })
            } else {
              // 验证码登录：版式按新版展示，后端接口未开放
              Row() {
                Text('+86')
                  .fontSize(FontSize.body).fontWeight(FontWeight_.bold)
                  .fontColor(Color.textPrimary)
                  .margin({ right: 8 })
                Divider().vertical(true).height(20).color(Color.border).margin({ right: 8 })
                TextInput({ placeholder: '请输入手机号', text: this.phone })
                  .type(InputType.PhoneNumber)
                  .maxLength(11).fontSize(FontSize.h3 - 1).fontColor(Color.textPrimary)
                  .backgroundColor('rgba(0,0,0,0)').padding(0).layoutWeight(1)
                  .onChange((v: string) => { this.phone = v; })
              }
              .width('100%').height(52)
              .padding({ left: Space.md, right: Space.md })
              .backgroundColor('#F8FAFC')
              .borderRadius(Radius.button)
              .border({ width: 1.5, color: Color.border })
              .margin({ bottom: Space.md })

              Row() {
                Column() {
                  Image($r('app.media.ic_shield')).width(15).height(15)
                }
                .width(30).height(30).borderRadius(10)
                .backgroundColor(Color.primaryLight)
                .justifyContent(FlexAlign.Center).margin({ right: 10 })
                TextInput({ placeholder: '请输入 6 位验证码', text: this.code })
                  .type(InputType.Number)
                  .maxLength(6).fontSize(FontSize.h3 - 1).fontColor(Color.textPrimary)
                  .backgroundColor('rgba(0,0,0,0)').padding(0).layoutWeight(1)
                  .onChange((v: string) => { this.code = v; })
                Text('获取验证码')
                  .fontSize(FontSize.caption).fontWeight(FontWeight_.bold)
                  .fontColor(Color.primaryDark)
                  .padding({ left: 8 })
                  .onClick(() => { this.toast('验证码登录暂未开放：后端无短信发送接口'); })
              }
              .width('100%').height(52)
              .padding({ left: Space.md, right: Space.md })
              .backgroundColor('#F8FAFC')
              .borderRadius(Radius.button)
              .border({ width: 1.5, color: Color.border })
              .margin({ bottom: Space.sm })

              Text('验证码登录暂未开放（后端无短信发送/校验接口），请使用「密码登录」')
                .fontSize(FontSize.mini).fontColor(Color.textTertiary)
                .lineHeight(15).width('100%')
                .padding({ left: 4, top: 2, bottom: Space.md })
            }

            if (this.errText.length > 0) {
              Text(this.errText)
                .fontSize(FontSize.caption).fontColor(Color.criticalDark)
                .width('100%').padding({ left: 4, bottom: 6 })
            }

            Button(this.loading ? '登录中…' : '登 录')
              .width('100%').height(48)
              .fontSize(FontSize.h3).fontWeight(FontWeight_.bold)
              .fontColor('#FFFFFF')
              .backgroundColor(this.formOk() ? Color.primary : '#D7E2EC')
              .borderRadius(Radius.button)
              .enabled(!this.loading)
              .onClick(() => { this.submit(); })

            Row() {
              Checkbox({ name: 'agree', group: 'login' })
                .select(this.agreed)
                .selectedColor(Color.primary)
                .width(18).height(18)
                .onChange((v: boolean) => { this.agreed = v; this.errText = ''; })
              Text('我已阅读并同意《用户协议》与《隐私政策》，手机号由项目负责人分配')
                .fontSize(FontSize.mini).fontColor(Color.textSecondary)
                .lineHeight(15).margin({ left: 4 }).layoutWeight(1)
            }
            .width('100%').padding({ top: Space.sm, bottom: 2 })
            .alignItems(VerticalAlign.Top)

            Row() {
              Text('新用户？').fontSize(FontSize.caption).fontColor(Color.textSecondary)
              Text('立即注册并绑定手机号').fontSize(FontSize.caption)
                .fontWeight(FontWeight_.bold).fontColor(Color.primaryDark)
                .onClick(() => { this.toast('注册未开放：后端暂无注册接口'); })
            }
            .width('100%').justifyContent(FlexAlign.Center).margin({ top: Space.sm })
          }
          .width('100%').padding(Space.lg - 2)
          .backgroundColor('#FFFFFF')
          .borderRadius(Radius.card)
          .shadow(Shadow_.card())
          .margin({ left: 24, right: 24, top: Space.xxl - 4 })

          Row() {
            SymbolGlyph($r('sys.symbol.star_fill')).fontSize(16).fontColor([Color.accentDark])
            Text('评审演示：一键体验监护人演示账号')
              .fontSize(FontSize.body - 1).fontWeight(FontWeight_.bold)
              .fontColor(Color.accentDark).margin({ left: 6 })
          }
          .width('100%').justifyContent(FlexAlign.Center)
          .padding({ top: 11, bottom: 11 })
          .backgroundColor('#FFFFFF')
          .borderRadius(Radius.card)
          .border({ width: 1.5, color: '#F1D5C4', style: BorderStyle.Dashed })
          .margin({ left: 24, right: 24, top: Space.lg })
          .onClick(() => { this.enterDemo(); })

          Text('颐养守护 v1.0.11')
            .fontSize(FontSize.mini).fontColor(Color.textTertiary)
            .margin({ top: Space.xl })
          Text('独居老人居家安全监测与应急辅助系统 · 赛题四')
            .fontSize(FontSize.mini).fontColor(Color.textTertiary)
            .margin({ top: 2, bottom: 28 })
        }
        .width('100%')
      }
      .width('100%').height('100%')
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%').height('100%').backgroundColor(Color.bg)
  }
}
