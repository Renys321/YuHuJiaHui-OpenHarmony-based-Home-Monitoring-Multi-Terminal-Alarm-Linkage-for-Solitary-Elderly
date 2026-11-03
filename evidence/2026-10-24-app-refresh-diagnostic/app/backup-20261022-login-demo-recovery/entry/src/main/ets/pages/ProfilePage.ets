/**
 * 我的 —— 监护人账号与真实会话状态
 *  · 身份卡：真实 guardianId、Token 存储模式（安全存储 / 仅内存）、真实设备数 / 在线数 / 待确认告警数
 *  · 守护对象档案、病史、社区、紧急联系人：服务端 APP-API-v1 未提供对应接口 → 显示“未接入 / 暂无数据”
 *  · 修改密码 / 注销账号 / 切换账号 / 推送 / 声音 / 分布式协同等无后端能力入口 → 明确标注“未开放”，不提示成功
 *  · 退出登录：二次确认 → GuardianService.logout() → 回登录页
 *  · 不调用本地模拟数据、本地账号存储、短信服务或本地会话模块
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { SectionHeader } from '../components/SectionHeader';
import { Medal } from '../components/Medal';
import { GuardianService } from '../service/GuardianService';
import { AlertView, ContactView, DeviceView } from '../core/view/Models';

@Component
export struct ProfilePage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.guardianId') guardianId: string = '';
  @StorageLink('gv.tokenStorage') tokenStorage: string = 'memory';
  @StorageLink('gv.dataSource') dataSource: string = 'none';
  @StorageLink('gv.lastUpdatedAt') lastUpdatedAt: number = 0;
  @StorageLink('gv.devices') devices: DeviceView[] = [];
  @StorageLink('gv.alerts') alerts: AlertView[] = [];
  @StorageLink('gv.contacts') contacts: ContactView[] = [];
  @State contactsLoading: boolean = false;

  aboutToAppear(): void {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    GuardianService.init(ctx);
    if (!GuardianService.isLoggedIn()) {
      // 会话失效的跳转由 Index 依据 gv.netStatus 统一处理，这里不重复跳
      return;
    }
    // 联系人接口可选：失败不阻塞页面，保持“暂无数据”
    this.contactsLoading = true;
    GuardianService.loadContacts().then((ok: boolean) => {
      this.contactsLoading = false;
      if (!ok) {
        return;
      }
    }).catch(() => {
      this.contactsLoading = false;
    });
  }

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private realGuardianId(): string {
    if (this.guardianId.length > 0) {
      return this.guardianId;
    }
    const fromService: string = GuardianService.guardianId();
    return fromService.length > 0 ? fromService : '未登录';
  }

  private avatarChar(): string {
    const gid: string = this.realGuardianId();
    if (gid.length === 0 || gid === '未登录') {
      return '监';
    }
    return gid.substring(0, 1).toUpperCase();
  }

  private tokenModeText(): string {
    return this.tokenStorage === 'secure' ? '安全存储' : '仅内存';
  }

  private tokenModeDetail(): string {
    if (this.tokenStorage === 'secure') {
      return '登录凭证已写入系统安全存储（AssetStore），重启 APP 后可自动恢复会话';
    }
    return '安全存储不可用，登录凭证仅保留在本次运行内存中，退出 APP 后需重新登录';
  }

  private isPending(a: AlertView): boolean {
    return a.statusKey === 'pending' || a.statusKey === 'waiting';
  }

  private pendingCount(): number {
    let n: number = 0;
    for (let i = 0; i < this.alerts.length; i++) {
      if (this.isPending(this.alerts[i])) {
        n += 1;
      }
    }
    return n;
  }

  private onlineCount(): number {
    let n: number = 0;
    for (let i = 0; i < this.devices.length; i++) {
      if (this.devices[i].online) {
        n += 1;
      }
    }
    return n;
  }

  private lastUpdatedText(): string {
    if (this.lastUpdatedAt <= 0) {
      return '暂无成功刷新';
    }
    const d: Date = new Date(this.lastUpdatedAt);
    const hh: string = d.getHours() < 10 ? `0${d.getHours()}` : `${d.getHours()}`;
    const mm: string = d.getMinutes() < 10 ? `0${d.getMinutes()}` : `${d.getMinutes()}`;
    const ss: string = d.getSeconds() < 10 ? `0${d.getSeconds()}` : `${d.getSeconds()}`;
    return `${hh}:${mm}:${ss}`;
  }

  private dataSourceText(): string {
    return this.dataSource === 'api' ? '真实服务端 API' : '暂无数据';
  }

  private maskPhone(p: string): string {
    if (p.length < 7) {
      return p;
    }
    return `${p.substring(0, 3)}****${p.substring(p.length - 4)}`;
  }

  private toast(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg });
    } catch (err) {
      // 忽略 toast 失败
    }
  }

  private confirmLogout(): void {
    this.getUIContext().getPromptAction().showDialog({
      title: '退出登录',
      message: '退出后将清除本机安全存储中的登录凭证，并停止后台数据刷新。确认退出当前监护人账号？',
      buttons: [
        { text: '取消', color: Color.textSecondary },
        { text: '确认退出', color: Color.critical }
      ]
    }).then((result) => {
      if (result.index === 1) {
        this.doLogout();
      }
    }).catch(() => { });
  }

  private doLogout(): void {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    GuardianService.init(ctx);
    GuardianService.logout().then(() => {
      this.getUIContext().getRouter().replaceUrl({ url: 'pages/LoginPage' });
    }).catch(() => {
      this.getUIContext().getRouter().replaceUrl({ url: 'pages/LoginPage' });
    });
  }

  @Builder
  statTile(value: string, label: string, color: string) {
    Column() {
      Text(value)
        .fontSize(FontSize.h1)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(color)
      Text(label)
        .fontSize(FontSize.mini)
        .fontColor(Color.textSecondary)
        .margin({ top: 2 })
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  settingRow(icon: Resource, title: string, sub: string, valueText: string, note: string,
             danger: boolean = false, onTap?: () => void) {
    Row() {
      Medal({ variant: danger ? 'softcrit' : 'soft', icon: icon, medalSize: 32 })
        .margin({ right: 11 })
      Column() {
        Text(title)
          .fontSize(FontSize.body + 0.5)
          .fontWeight(FontWeight_.semibold)
          .fontColor(danger ? Color.criticalDark : Color.textPrimary)
        if (sub.length > 0) {
          Text(sub)
            .fontSize(FontSize.caption - 0.5)
            .fontColor(Color.textTertiary)
            .margin({ top: 2 })
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .margin({ right: Space.sm })

      if (valueText.length > 0) {
        Text(valueText)
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textSecondary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      } else if (note.length > 0) {
        Text(note)
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.semibold)
          .fontColor(note === '未开放' ? Color.warningDark : Color.textTertiary)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor(note === '未开放' ? Color.warningLight : '#F1F5F9')
          .borderRadius(Radius.pill)
      } else {
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(15)
          .fontColor(['#CBD5E1'])
      }
    }
    .width('100%')
    .height(56)
    .padding({ left: Space.lg - 2, right: Space.lg - 2 })
    .backgroundColor(Color.card)
    .onClick(() => {
      if (onTap) {
        onTap();
      } else {
        this.toast('该功能未开放');
      }
    })
  }

  build() {
    Scroll() {
      Column() {
        // ===== 身份卡（真实 guardianId + 存储模式 + 真实统计） =====
        Column() {
          Row() {
            Column() {
              Text(this.avatarChar())
                .fontSize(20)
                .fontWeight(FontWeight_.extrabold)
                .fontColor('#FFFFFF')
            }
            .width(52)
            .height(52)
            .borderRadius(18)
            .justifyContent(FlexAlign.Center)
            .linearGradient(Grad.primary())
            .shadow(Shadow_.medal('rgba(2,132,199,0.35)'))

            Column() {
              Row() {
                Text(this.realGuardianId())
                  .fontSize(FontSize.h2)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(Color.textPrimary)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
                Text(this.tokenModeText())
                  .fontSize(FontSize.mini - 0.5)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(this.tokenStorage === 'secure' ? Color.successDark : Color.warningDark)
                  .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                  .backgroundColor(this.tokenStorage === 'secure' ? Color.successLight : Color.warningLight)
                  .borderRadius(Radius.pill)
                  .margin({ left: Space.xs })
              }
              .width('100%')
              .alignItems(VerticalAlign.Center)

              Text('监护人账号 · 真实服务端会话')
                .fontSize(FontSize.caption)
                .fontColor(Color.textSecondary)
                .margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
            .margin({ left: Space.md })
          }
          .width('100%')

          Row() {
            this.statTile(`${this.devices.length}`, '设备', Color.primaryDark)
            Column()
              .width(1)
              .height(26)
              .backgroundColor(Color.border)
            this.statTile(`${this.onlineCount()}`, '在线', Color.successDark)
            Column()
              .width(1)
              .height(26)
              .backgroundColor(Color.border)
            this.statTile(`${this.pendingCount()}`, '待确认告警', Color.criticalDark)
          }
          .width('100%')
          .padding({ top: Space.md, bottom: Space.xs })
          .margin({ top: Space.md })
          .backgroundColor('#FFFFFF')
          .borderRadius(Radius.button)
          .shadow(Shadow_.card())
        }
        .width('100%')
        .padding(Space.lg - 1)
        .borderRadius(22)
        .linearGradient(Grad.heroPrimary())
        .shadow(Shadow_.card())
        .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })

        // ===== 账号与会话（真实状态） =====
        SectionHeader({ title: '账号与会话' })
        Column() {
          this.settingRow($r('sys.symbol.person_fill'), '监护人 ID', '登录账号（非敏感）',
            this.realGuardianId(), '')
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('app.media.ic_shield'), 'Token 存储模式', this.tokenModeDetail(),
            this.tokenModeText(), '')
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.cloud_fill'), '数据来源', '正式数据源，无本地模拟回落',
            this.dataSourceText(), '')
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.clock_fill'), '最近刷新时间', '成功获取服务端数据的本机时间',
            this.lastUpdatedText(), '')
        }
        .backgroundColor(Color.card)
        .borderRadius(Radius.card)
        .shadow(Shadow_.card())
        .clip(true)
        .margin({ left: this.pm(), right: this.pm() })

        // ===== 守护对象与联系人 =====
        SectionHeader({ title: '守护对象与联系人', subtitle: '服务端未提供该部分数据接口' })
        Column() {
          this.settingRow($r('sys.symbol.person_2_fill'), '守护对象档案',
            '老人姓名 / 年龄 / 病史 / 社区等无对应接口', '', '未接入')
          Divider().color('#F1F5F9').margin({ left: 45 })

          if (this.contacts.length > 0) {
            ForEach(this.contacts, (c: ContactView) => {
              Column() {
                this.settingRow($r('sys.symbol.phone_fill'), c.name,
                  `${c.relation} · 服务端联系人`, this.maskPhone(c.phone), '',
                  false, () => { this.toast('APP 内暂未接入拨号能力，请手动拨打'); })
                Divider().color('#F1F5F9').margin({ left: 45 })
              }
              .width('100%')
            }, (c: ContactView) => c.id)
          } else {
            this.settingRow($r('sys.symbol.person_2_fill'), '紧急联系人',
              this.contactsLoading ? '正在尝试加载联系人…' : '服务端联系人接口暂未返回数据',
              '', '暂无数据')
          }
        }
        .backgroundColor(Color.card)
        .borderRadius(Radius.card)
        .shadow(Shadow_.card())
        .clip(true)
        .margin({ left: this.pm(), right: this.pm() })

        // ===== 功能（真实跳转） =====
        SectionHeader({ title: '功能' })
        Column() {
          this.settingRow($r('sys.symbol.clock_fill'), '安全日志', '真实告警与处置记录', '', '',
            false, () => { this.getUIContext().getRouter().pushUrl({ url: 'pages/LogPage' }); })
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.gearshape'), '设备管理', '真实设备与传感器能力',
            `${this.devices.length} 台`, '',
            false, () => { this.getUIContext().getRouter().pushUrl({ url: 'pages/DevicePage' }); })
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.waveform'), '数据统计', '仅展示可由真实告警推导的统计', '', '',
            false, () => { this.getUIContext().getRouter().pushUrl({ url: 'pages/StatsPage' }); })
        }
        .backgroundColor(Color.card)
        .borderRadius(Radius.card)
        .shadow(Shadow_.card())
        .clip(true)
        .margin({ left: this.pm(), right: this.pm() })

        // ===== 账号安全（无后端能力，明确未开放） =====
        SectionHeader({ title: '账号安全', subtitle: '以下操作服务端暂无接口' })
        Column() {
          this.settingRow($r('sys.symbol.phone_fill'), '绑定手机号', '账号绑定关系由服务端管理',
            '', '未开放')
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.gearshape'), '修改密码', '无校验旧口令 / 提交新口令接口',
            '', '未开放', false, () => { this.toast('修改密码未开放，请联系项目负责人重置口令'); })
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.person_2_fill'), '切换账号', '需退出登录后重新登录',
            '', '未开放', false, () => { this.toast('切换账号未开放，请先退出登录再使用其他账号登录'); })
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.xmark_circle'), '注销账号', '无账号注销 / 数据删除接口',
            '', '未开放', true, () => { this.toast('注销账号未开放，请联系项目负责人处理'); })
        }
        .backgroundColor(Color.card)
        .borderRadius(Radius.card)
        .shadow(Shadow_.card())
        .clip(true)
        .margin({ left: this.pm(), right: this.pm() })

        // ===== 通知与协同（无后端能力） =====
        SectionHeader({ title: '通知与协同', subtitle: '推送 / 分布式能力暂未接入服务端' })
        Column() {
          this.settingRow($r('sys.symbol.bell_fill'), '紧急预警通知', '服务端无推送订阅接口', '', '未开放')
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.paperplane_fill'), '推送至其他终端', '服务端无多端推送接口', '',
            '未开放')
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.message_fill'), '声音与振动', '本机提醒策略暂无后端配置',
            '', '未开放')
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.square_grid_2x2'), '跨设备预警同步',
            '未接入分布式流转服务', '', '未开放')
        }
        .backgroundColor(Color.card)
        .borderRadius(Radius.card)
        .shadow(Shadow_.card())
        .clip(true)
        .margin({ left: this.pm(), right: this.pm() })

        // ===== 关于 =====
        SectionHeader({ title: '关于' })
        Column() {
          this.settingRow($r('sys.symbol.info_circle'), '版本信息', '颐养守护 v1.0.0（真实 API 接入版）',
            '', '', false, () => { this.toast('颐养守护 v1.0.0（真实 API 接入版）'); })
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.doc_text'), '用户协议与隐私政策', 'APP 内暂未提供协议页面',
            '', '未开放')
          Divider().color('#F1F5F9').margin({ left: 45 })
          this.settingRow($r('sys.symbol.questionmark_circle'), '帮助与反馈', 'APP 内暂未提供反馈通道',
            '', '未开放')
        }
        .backgroundColor(Color.card)
        .borderRadius(Radius.card)
        .shadow(Shadow_.card())
        .clip(true)
        .margin({ left: this.pm(), right: this.pm() })

        // ===== 退出登录（真实清会话） =====
        Row() {
          Image($r('app.media.ic_logout'))
            .width(15)
            .height(15)
          Text('退出登录')
            .fontSize(FontSize.body + 1)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.criticalDark)
            .margin({ left: 6 })
        }
        .width('100%')
        .height(50)
        .justifyContent(FlexAlign.Center)
        .backgroundColor(Color.card)
        .borderRadius(Radius.button)
        .border({ width: 1.5, color: Color.criticalLight })
        .shadow(Shadow_.card())
        .margin({ left: this.pm(), right: this.pm() })
        .onClick(() => { this.confirmLogout(); })

        Column().height(56)
      }
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
    .scrollBar(BarState.Off)
  }
}
