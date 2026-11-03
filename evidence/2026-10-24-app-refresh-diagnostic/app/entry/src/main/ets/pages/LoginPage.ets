/**
 * 登录页 —— 监护人端真实 API 入口
 *  · 仅支持 guardianId + password 登录（POST /api/v1/auth/app）
 *  · 进入时 GuardianService.init + restoreSession，有效会话直接进 Index
 *  · 口令只在本次登录请求中使用：不落盘、不进日志、不进 AppStorage / Toast
 *  · 记住登录 = 系统安全存储（AssetStore）；未勾选 = 仅本次运行内存会话
 *  · “演示体验”是独立本地模式：不输入账号、不请求 API、不写正式 Token/安全存储
 *  · 旧版本地账号与当前后端不是同一认证体系；旧演示入口不恢复为默认账号登录
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { NavBar } from '../components/NavBar';
import { GuardianService } from '../service/GuardianService';
import { DemoMode } from '../demo/DemoMode';
import { LoginOutcome } from '../core/service/Outcomes';

@Entry
@Component
struct LoginPage {
  @State guardianId: string = '';
  @State pwd: string = '';
  @State showPwd: boolean = false;
  @State remember: boolean = true;
  @State agreed: boolean = false;
  @State loading: boolean = false;
  @State guardianIdErr: boolean = false;
  @State pwdErr: boolean = false;
  @State guardianIdFocus: boolean = false;
  @State pwdFocus: boolean = false;
  @State fromSwitch: boolean = false;
  @State errText: string = '';
  @State restoring: boolean = true;

  aboutToAppear(): void {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.restoring = false;
      return;
    }
    GuardianService.init(ctx);

    const params = this.getUIContext().getRouter().getParams() as Record<string, string>;
    if (params !== undefined && params !== null && params.switch === '1') {
      this.fromSwitch = true;
    }

    // 切换账号入口：原会话仍可能有效，但页面保持停留，由用户决定是否重新登录
    if (this.fromSwitch) {
      this.restoring = false;
      return;
    }

    GuardianService.restoreSession().then((ok: boolean) => {
      this.restoring = false;
      if (ok && GuardianService.isLoggedIn()) {
        this.getUIContext().getRouter().replaceUrl({ url: 'pages/Index' });
      }
    }).catch(() => {
      // 安全存储不可用或读取失败：按未登录处理，允许手动输入账号口令
      this.restoring = false;
    });
  }

  aboutToDisappear(): void {
    // 页面离开时清空内存中的口令，避免残留在页面状态里
    this.pwd = '';
  }

  private guardianIdOk(): boolean {
    const v: string = this.guardianId;
    if (v.length < 3 || v.length > 64) {
      return false;
    }
    for (let i = 0; i < v.length; i++) {
      const c: number = v.charCodeAt(i);
      const isDigit: boolean = c >= 48 && c <= 57;
      const isUpper: boolean = c >= 65 && c <= 90;
      const isLower: boolean = c >= 97 && c <= 122;
      const isDot: boolean = c === 46;
      const isUnderscore: boolean = c === 95;
      const isDash: boolean = c === 45;
      if (!(isDigit || isUpper || isLower || isDot || isUnderscore || isDash)) {
        return false;
      }
    }
    return true;
  }

  private pwdLengthOk(): boolean {
    return this.pwd.length >= 32 && this.pwd.length <= 256;
  }

  private formOk(): boolean {
    return this.agreed && this.guardianIdOk() && this.pwdLengthOk() && !this.loading;
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg });
    } catch (err) {
      // 忽略 toast 失败
    }
  }

  /** 按 outcome 给出诚实错误文案；不区分账号/口令，不暴露账号是否存在 */
  private friendlyError(out: LoginOutcome): string {
    if (out.kind === 'rate_limited') {
      return out.retryAfterSeconds > 0
        ? `尝试过多，请 ${out.retryAfterSeconds} 秒后再试`
        : '尝试过多，请稍后再试';
    }
    if (out.message.length > 0) {
      return out.message;
    }
    if (out.kind === 'unauthorized') {
      return '账号或口令错误';
    }
    if (out.kind === 'forbidden') {
      return '账号已被服务端停用';
    }
    if (out.kind === 'service_unavailable') {
      return '服务端登录未配置';
    }
    if (out.kind === 'timeout') {
      return '请求超时，请检查网络后重试';
    }
    if (out.kind === 'network') {
      return '网络不可用，请检查连接';
    }
    if (out.kind === 'server') {
      return '服务端异常，请稍后重试';
    }
    if (out.kind === 'malformed') {
      return '服务端响应异常，请稍后重试';
    }
    return '登录失败，请稍后重试';
  }

  private fieldBorder(focus: boolean, err: boolean): string {
    if (err) return Color.critical;
    if (focus) return Color.primary;
    return Color.border;
  }

  private fieldBg(focus: boolean): string {
    return focus ? '#F0F9FF' : '#F8FAFC';
  }

  private enterIndex(): void {
    // 新会话从首页 Tab 开始，避免沿用上一次会话停留在的 Tab
    AppStorage.setOrCreate('currentTabIndex', 0);
    if (this.fromSwitch) {
      this.getUIContext().getRouter().replaceUrl({ url: 'pages/Index' }).then(() => {
        this.getUIContext().getRouter().clear();
      });
    } else {
      this.getUIContext().getRouter().replaceUrl({ url: 'pages/Index' });
    }
  }

  /** 用户主动进入演示：本地示例数据，不走 GuardianService、不写真实会话。 */
  private enterDemo(): void {
    if (this.loading || this.restoring) {
      return;
    }
    this.pwd = '';
    this.showPwd = false;
    DemoMode.enter();
    this.enterIndex();
  }

  private submit(): void {
    if (this.loading || this.restoring) {
      return;
    }
    this.errText = '';
    if (!this.agreed) {
      this.errText = '请先阅读并勾选用户协议与隐私政策';
      return;
    }
    if (!this.guardianIdOk()) {
      this.guardianIdErr = true;
      this.errText = '监护人账号需为 3–64 位，仅含字母、数字、点、下划线或短横线';
      return;
    }
    if (!this.pwdLengthOk()) {
      this.pwdErr = true;
      this.errText = '登录口令需为 32–256 位（由项目负责人提供）';
      return;
    }
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.errText = '运行环境异常，请重启应用后重试';
      return;
    }
    GuardianService.init(ctx);

    const gid: string = this.guardianId;
    const secret: string = this.pwd;
    const remembered: boolean = this.remember;
    this.loading = true;

    GuardianService.login(gid, secret, remembered).then((out: LoginOutcome) => {
      this.loading = false;
      // 本次尝试结束后立即清空页面内的口令状态（成功/失败都不保留）
      this.pwd = '';
      this.showPwd = false;
      if (out.ok) {
        this.errText = '';
        this.toast('登录成功，正在进入工作台');
        this.enterIndex();
        return;
      }
      if (out.kind === 'unauthorized') {
        this.pwdErr = true;
      }
      this.errText = `${this.friendlyError(out)}（口令已清空，请重新输入）`;
    }).catch(() => {
      this.loading = false;
      this.pwd = '';
      this.showPwd = false;
      this.errText = '登录请求失败，请稍后重试（口令已清空，请重新输入）';
    });
  }

  build() {
    Column() {
      // 切换账号入口：顶部返回栏，可返回上一页
      if (this.fromSwitch) {
        NavBar({ title: '切换账号', showBack: true })
      }
      Stack() {
        // 背景光斑
        Column()
          .width(220).height(220).borderRadius(110)
          .backgroundColor(Color.primary).opacity(0.10)
          .position({ x: 240, y: -70 })
        Column()
          .width(180).height(180).borderRadius(90)
          .backgroundColor(Color.accent).opacity(0.08)
          .position({ x: -70, y: 170 })
        Column()
          .width(260).height(260).borderRadius(130)
          .backgroundColor(Color.success).opacity(0.07)
          .position({ x: 200, y: 470 })

        Scroll() {
          Column() {
            // ===== 品牌区 =====
            Column() {
              Stack() {
                Column() {
                  SymbolGlyph($r('sys.symbol.house_fill'))
                    .fontSize(36)
                    .fontColor(['#FFFFFF'])
                }
                .width(76).height(76).borderRadius(26)
                .justifyContent(FlexAlign.Center)
                .linearGradient(Grad.primary())
                .shadow(Shadow_.pop('rgba(2,132,199,0.38)'))

                Stack() {
                  Column()
                    .width(26).height(26).borderRadius(13)
                    .linearGradient(Grad.accent())
                    .shadow(Shadow_.medal('rgba(234,88,12,0.40)'))
                  Image($r('app.media.ic_heart'))
                    .width(14).height(14)
                }
                .position({ x: 62, y: 62 })
              }
              .width(90).height(90)

              Text('颐养守护')
                .fontSize(26)
                .fontWeight(FontWeight_.extrabold)
                .fontColor(Color.textPrimary)
                .letterSpacing(2)
                .margin({ top: Space.lg })
              Text('独居老人居家安全监测与应急辅助系统')
                .fontSize(FontSize.caption - 0.5)
                .fontColor(Color.textSecondary)
                .letterSpacing(1)
                .margin({ top: 6 })

              Row() {
                Image($r('app.media.ic_shield'))
                  .width(10).height(10)
                Text('真实服务端认证 · 监护人端')
                  .fontSize(FontSize.mini - 0.5)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(Color.primaryDark)
                  .margin({ left: 4 })
              }
              .padding({ left: 10, right: 10, top: 4, bottom: 4 })
              .backgroundColor('#FFFFFF')
              .borderRadius(Radius.pill)
              .shadow({ radius: 8, color: 'rgba(2,132,199,0.15)', offsetX: 0, offsetY: 2 })
              .margin({ top: 10 })
            }
            .width('100%')
            .alignItems(HorizontalAlign.Center)
            .margin({ top: Space.xxl + 2 })

            // ===== 表单卡 =====
            Column() {
              Row() {
                Row() {
                  Column()
                    .width(3).height(12).borderRadius(2)
                    .linearGradient(Grad.primary())
                    .margin({ right: 6 })
                  Text('监护人账号登录')
                    .fontSize(FontSize.h3)
                    .fontWeight(FontWeight_.bold)
                    .fontColor(Color.textPrimary)
                  Text('唯一入口')
                    .fontSize(FontSize.mini - 0.5)
                    .fontWeight(FontWeight_.bold)
                    .fontColor(Color.primaryDark)
                    .padding({ left: 6, right: 6, top: 1, bottom: 1 })
                    .backgroundColor(Color.primaryLight)
                    .borderRadius(Radius.pill)
                    .margin({ left: 6 })
                }
                .alignItems(VerticalAlign.Center)
                Blank()
                if (this.loading) {
                  LoadingProgress()
                    .width(16).height(16)
                    .color(Color.primaryDark)
                }
              }
              .width('100%')
              .margin({ bottom: Space.lg })

              // 监护人 ID
              Row() {
                Column() {
                  Image($r('app.media.ic_person_reg'))
                    .width(15).height(15)
                }
                .width(30).height(30).borderRadius(10)
                .backgroundColor(Color.primaryLight)
                .justifyContent(FlexAlign.Center)
                .margin({ right: 10 })

                TextInput({ placeholder: '请输入监护人账号', text: this.guardianId })
                  .maxLength(64)
                  .fontSize(FontSize.h3 - 1)
                  .fontColor(Color.textPrimary)
                  .backgroundColor('rgba(0,0,0,0)')
                  .padding(0)
                  .layoutWeight(1)
                  .onChange((v: string) => {
                    this.guardianId = v;
                    this.guardianIdErr = false;
                    this.errText = '';
                  })
                  .onFocus(() => { this.guardianIdFocus = true; })
                  .onBlur(() => { this.guardianIdFocus = false; })
              }
              .width('100%')
              .height(50)
              .padding({ left: Space.md, right: Space.md })
              .backgroundColor(this.fieldBg(this.guardianIdFocus))
              .borderRadius(Radius.button)
              .border({ width: 1.5, color: this.fieldBorder(this.guardianIdFocus, this.guardianIdErr) })
              .margin({ bottom: Space.md })

              // 登录口令
              Row() {
                Column() {
                  Image($r('app.media.ic_lock'))
                    .width(15).height(15)
                }
                .width(30).height(30).borderRadius(10)
                .backgroundColor(Color.primaryLight)
                .justifyContent(FlexAlign.Center)
                .margin({ right: 10 })

                TextInput({ placeholder: '请输入登录口令（32–256 位）', text: this.pwd })
                  .type(this.showPwd ? InputType.Normal : InputType.Password)
                  .maxLength(256)
                  .fontSize(FontSize.h3 - 1)
                  .fontColor(Color.textPrimary)
                  .backgroundColor('rgba(0,0,0,0)')
                  .padding(0)
                  .layoutWeight(1)
                  .onChange((v: string) => {
                    this.pwd = v;
                    this.pwdErr = false;
                    this.errText = '';
                  })
                  .onFocus(() => { this.pwdFocus = true; })
                  .onBlur(() => { this.pwdFocus = false; })

                Image(this.showPwd ? $r('app.media.ic_eye') : $r('app.media.ic_eye_off'))
                  .width(18).height(18)
                  .padding({ left: 6 })
                  .onClick(() => { this.showPwd = !this.showPwd; })
              }
              .width('100%')
              .height(50)
              .padding({ left: Space.md, right: Space.md })
              .backgroundColor(this.fieldBg(this.pwdFocus))
              .borderRadius(Radius.button)
              .border({ width: 1.5, color: this.fieldBorder(this.pwdFocus, this.pwdErr) })
              .margin({ bottom: Space.sm })

              Row() {
                Image($r('app.media.ic_shield'))
                  .width(10).height(10)
                Text('口令由项目负责人提供，APP 不保存明文口令')
                  .fontSize(FontSize.mini)
                  .fontColor(Color.textTertiary)
                  .margin({ left: 4 })
              }
              .width('100%')
              .margin({ bottom: Space.md })

              // 记住登录
              Row() {
                Row() {
                  Stack() {
                    Column()
                      .width(16).height(16).borderRadius(5)
                      .backgroundColor('#FFFFFF')
                      .border({ width: 1.5, color: this.remember ? 'rgba(0,0,0,0)' : '#CBD5E1' })
                    if (this.remember) {
                      Column()
                        .width(16).height(16).borderRadius(5)
                        .linearGradient(Grad.primary())
                      SymbolGlyph($r('sys.symbol.checkmark'))
                        .fontSize(9)
                        .fontColor(['#FFFFFF'])
                    }
                  }
                  .width(16).height(16)

                  Text('记住登录状态（系统安全存储）')
                    .fontSize(FontSize.caption - 0.5)
                    .fontColor(Color.textSecondary)
                    .margin({ left: 6 })
                }
                .onClick(() => { this.remember = !this.remember; })

                Blank()
                Text('未勾选仅保留内存会话')
                  .fontSize(FontSize.mini - 0.5)
                  .fontColor(Color.textTertiary)
              }
              .width('100%')
              .margin({ bottom: Space.md })

              // 错误提示
              if (this.errText.length > 0) {
                Row() {
                  SymbolGlyph($r('sys.symbol.exclamationmark_circle_fill'))
                    .fontSize(15)
                    .fontColor([Color.criticalDark])
                    .margin({ right: 8 })
                  Text(this.errText)
                    .fontSize(FontSize.body)
                    .fontColor(Color.criticalDark)
                    .lineHeight(17)
                    .layoutWeight(1)
                }
                .width('100%')
                .padding({ left: Space.md - 2, right: Space.md - 2, top: Space.sm, bottom: Space.sm })
                .backgroundColor(Color.criticalLight)
                .borderRadius(Radius.chip)
                .margin({ bottom: Space.md })
              }

              // 登录按钮
              Row() {
                if (this.loading || this.restoring) {
                  LoadingProgress()
                    .width(18).height(18)
                    .color('#FFFFFF')
                    .margin({ right: Space.sm })
                  Text(this.restoring ? '正在检查会话…' : '登录中…')
                    .fontSize(15)
                    .fontWeight(FontWeight_.bold)
                    .fontColor('#FFFFFF')
                    .letterSpacing(2)
                } else {
                  Text('登 录')
                    .fontSize(15)
                    .fontWeight(FontWeight_.bold)
                    .fontColor('#FFFFFF')
                    .letterSpacing(4)
                }
              }
              .width('100%')
              .height(50)
              .justifyContent(FlexAlign.Center)
              .borderRadius(Radius.button)
              .linearGradient(this.formOk()
                ? Grad.primary()
                : { angle: 135, colors: [['#D8E0EA', 0.0], ['#D8E0EA', 1.0]] })
              .shadow(this.formOk()
                ? Shadow_.pop('rgba(2,132,199,0.35)')
                : { radius: 0, color: 'rgba(0,0,0,0)', offsetX: 0, offsetY: 0 })
              .onClick(() => { this.submit(); })

              // 独立演示入口：无需账号，仅本地示例数据；不与真实登录混用
              if (!this.fromSwitch) {
                Row() {
                  Divider().layoutWeight(1).color(Color.border)
                  Text('或')
                    .fontSize(FontSize.mini)
                    .fontColor(Color.textTertiary)
                    .margin({ left: Space.md, right: Space.md })
                  Divider().layoutWeight(1).color(Color.border)
                }
                .width('100%')
                .margin({ top: Space.md, bottom: Space.sm })

                Column() {
                  Row() {
                    Column() {
                      Text('演示体验')
                        .fontSize(FontSize.body + 1)
                        .fontWeight(FontWeight_.bold)
                        .fontColor(Color.primaryDark)
                      Text('本地示例数据 · 无需账号')
                        .fontSize(FontSize.mini)
                        .fontColor(Color.textSecondary)
                        .margin({ top: 2 })
                    }
                    .alignItems(HorizontalAlign.Start)
                    .layoutWeight(1)
                    Text('进入演示')
                      .fontSize(FontSize.caption)
                      .fontWeight(FontWeight_.bold)
                      .fontColor(Color.primaryDark)
                  }
                  .width('100%')
                  .alignItems(VerticalAlign.Center)

                  Text('不连接真实设备、不调用业务 API、不发送 ACK/SOS；退出即清理示例数据')
                    .fontSize(FontSize.mini - 0.5)
                    .fontColor(Color.textTertiary)
                    .lineHeight(15)
                    .margin({ top: 5 })
                }
                .width('100%')
                .padding({ left: Space.md, right: Space.md, top: Space.sm + 2, bottom: Space.sm + 2 })
                .backgroundColor('#F0F9FF')
                .borderRadius(Radius.button)
                .border({ width: 1, color: '#BAE6FD' })
                .opacity(this.loading || this.restoring ? 0.5 : 1)
                .onClick(() => { this.enterDemo(); })
              }

              // 协议
              Row() {
                Stack() {
                  Column()
                    .width(14).height(14).borderRadius(4)
                    .backgroundColor('#FFFFFF')
                    .border({ width: 1.5, color: this.agreed ? 'rgba(0,0,0,0)' : '#CBD5E1' })
                  if (this.agreed) {
                    Column()
                      .width(14).height(14).borderRadius(4)
                      .linearGradient(Grad.primary())
                    SymbolGlyph($r('sys.symbol.checkmark'))
                      .fontSize(8)
                      .fontColor(['#FFFFFF'])
                  }
                }
                .width(14).height(14)
                .margin({ top: 2 })
                .onClick(() => { this.agreed = !this.agreed; })

                Text() {
                  Span('我已阅读并同意 ')
                    .fontSize(FontSize.mini)
                    .fontColor(Color.textTertiary)
                  Span('《用户协议》')
                    .fontSize(FontSize.mini)
                    .fontColor(Color.primaryDark)
                  Span(' 与 ')
                    .fontSize(FontSize.mini)
                    .fontColor(Color.textTertiary)
                  Span('《隐私政策》')
                    .fontSize(FontSize.mini)
                    .fontColor(Color.primaryDark)
                  Span('；账号由项目负责人分配，APP 不提供自助注册')
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
              .margin({ top: Space.lg - 2 })

              // 认证体系说明：不把 guardianId 字段名当账号，也不暗示旧账号已迁移
              Row() {
                SymbolGlyph($r('sys.symbol.info_circle'))
                  .fontSize(12)
                  .fontColor([Color.textTertiary])
                Text('真实登录仅支持项目负责人分配的公网监护人账号（口令 32–256 位）；旧版本地注册账号/演示账号未迁移，不能用于真实登录。演示体验是独立本地模式，与真实账号无关。')
                  .fontSize(FontSize.mini)
                  .fontColor(Color.textTertiary)
                  .margin({ left: 4 })
                  .layoutWeight(1)
                  .lineHeight(15)
              }
              .width('100%')
              .alignItems(VerticalAlign.Top)
              .margin({ top: Space.sm })

              // 未开放能力说明（替代注册 / 找回密码入口）
              Row() {
                SymbolGlyph($r('sys.symbol.info_circle'))
                  .fontSize(12)
                  .fontColor([Color.textTertiary])
                Text('注册、找回密码、验证码登录均无服务端接口，已标注为未开放')
                  .fontSize(FontSize.mini)
                  .fontColor(Color.textTertiary)
                  .margin({ left: 4 })
                  .layoutWeight(1)
              }
              .width('100%')
              .alignItems(VerticalAlign.Top)
              .margin({ top: Space.md })
            }
            .width('100%')
            .padding(Space.lg)
            .backgroundColor(Color.card)
            .borderRadius(22)
            .shadow({ radius: 30, color: 'rgba(15,23,42,0.08)', offsetX: 0, offsetY: 10 })
            .margin({ top: Space.xxl })

            Text('登录凭证存储方式：勾选「记住登录」写入系统安全存储，未勾选仅保留本次运行内存会话；\n实际存储模式（安全存储 / 仅内存）请在「我的」页查看。')
              .fontSize(FontSize.mini)
              .fontColor(Color.textTertiary)
              .textAlign(TextAlign.Center)
              .lineHeight(17)
              .margin({ top: Space.lg })

            Text('颐养守护 v1.0.0\n第三届河南省信息技术应用创新大赛 · 赛题四')
              .fontSize(FontSize.mini - 0.5)
              .fontColor(Color.textTertiary)
              .textAlign(TextAlign.Center)
              .lineHeight(18)
              .margin({ top: Space.md, bottom: Space.xl })
          }
          .width('100%')
          .padding({ left: Space.xxl, right: Space.xxl })
        }
        .width('100%')
        .layoutWeight(1)
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
    .linearGradient(Grad.headWash())
  }
}
