/**
 * 预警详情 & 真实 ACK 闭环。
 *
 * 状态机：idle → submitting → waiting(PENDING，等待设备回执) → confirmed(仅 ACKED)
 * 失败/超时/404 一律不本地归档；找不到告警显示“不存在或已失效”，禁止 Mock 回退。
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { LevelBadge } from '../components/LevelBadge';
import { PrimaryButton, SecondaryButton } from '../components/Buttons';
import { AlertView, NetworkState } from '../core/view/Models';
import { AckOutcome } from '../core/service/Outcomes';
import { findAlert } from '../core/view/ViewMapper';
import { DateUtil } from '../common/DateUtil';
import { GuardianService } from '../service/GuardianService';

class AckPhase {
  static readonly IDLE: string = 'idle';
  static readonly SUBMITTING: string = 'submitting';
  static readonly WAITING: string = 'waiting';
  static readonly CONFIRMED: string = 'confirmed';
  static readonly FAILED: string = 'failed';
  static readonly TIMEOUT: string = 'timeout';
}

class TimelineRow {
  time: number = 0;
  title: string = '';
  note: string = '';
}

const WAIT_POLL_MS: number = 3000;
const WAIT_TIMEOUT_MS: number = 60000;

@Entry
@Component
struct AlertDetailPage {
  @StorageLink('gv.alerts') @Watch('onAlertsChanged') alerts: AlertView[] = [];
  @StorageLink('gv.netStatus') @Watch('onNetChanged') netStatus: string = NetworkState.UNKNOWN;
  @StorageLink('gv.netMessage') netMessage: string = '';
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @State alert: AlertView = new AlertView();
  @State found: boolean = false;
  @State phase: string = AckPhase.IDLE;
  @State note: string = '';
  @State submitting: boolean = false;
  @State ackMessage: string = '';
  @State submitAt: number = 0;
  @State elapsedSec: number = 0;
  @State timelineRows: TimelineRow[] = [];
  private alarmId: string = '';
  private waitTimerId: number = -1;
  private tickTimerId: number = -1;
  private redirecting: boolean = false;
  /** 页面已销毁：ACK 请求已提交给服务器，不取消；但迟到回调不得再更新页面/定时器/提示。 */
  private disposed: boolean = false;

  aboutToAppear() {
    const params = this.getUIContext().getRouter().getParams() as Record<string, string>;
    this.alarmId = params !== undefined && params !== null && params['alertId'] !== undefined
      ? params['alertId'] : '';
    this.syncAlert();
    this.tickTimerId = setInterval(() => {
      this.elapsedSec = Date.now();
    }, 1000);
    if (this.alarmId.length > 0) {
      void GuardianService.refreshAlerts();
    }
  }

  aboutToDisappear() {
    // 离开页面只做生命周期清理；已经提交给服务端的 ACK 不受影响（不会被解释为取消）。
    this.disposed = true;
    this.stopWaitTimer();
    if (this.tickTimerId !== -1) {
      clearInterval(this.tickTimerId);
      this.tickTimerId = -1;
    }
  }

  private onAlertsChanged(): void {
    if (this.disposed) return;
    this.syncAlert();
  }

  private onNetChanged(): void {
    if (this.disposed) return;
    if (this.netStatus === NetworkState.UNAUTHORIZED && !this.redirecting) {
      this.redirecting = true;
      this.stopWaitTimer();
      this.getUIContext().getRouter().replaceUrl({ url: 'pages/LoginPage' });
    }
  }

  private syncAlert(): void {
    if (this.disposed) return;
    if (this.alarmId.length === 0) {
      this.found = false;
      this.refreshTimeline();
      return;
    }
    const current: AlertView | null = findAlert(this.alerts, this.alarmId);
    if (current === null) {
      this.found = false;
      if (this.phase === AckPhase.WAITING) {
        this.phase = AckPhase.FAILED;
        this.ackMessage = '告警已不在服务端列表中（可能已失效），未本地归档';
        this.stopWaitTimer();
      }
      this.refreshTimeline();
      return;
    }
    this.found = true;
    this.alert = current;
    if (current.statusKey === 'acked') {
      if (this.phase !== AckPhase.CONFIRMED) {
        this.phase = AckPhase.CONFIRMED;
        this.ackMessage = '设备已确认（服务端 ACKED）';
      }
      this.stopWaitTimer();
    } else if (current.statusKey === 'waiting') {
      if (this.phase === AckPhase.IDLE || this.phase === AckPhase.SUBMITTING) {
        this.phase = AckPhase.WAITING;
        this.ackMessage = '服务端显示命令等待设备回执';
      }
      if (this.phase !== AckPhase.TIMEOUT) {
        this.startWaitTimer();
      }
    } else if (current.statusKey === 'pending') {
      if (this.phase === AckPhase.WAITING) {
        this.phase = AckPhase.FAILED;
        this.ackMessage = '命令已结束但设备未确认，告警仍待确认；未本地归档';
        this.stopWaitTimer();
      }
    }
    this.refreshTimeline();
  }

  private refreshTimeline(): void {
    const rows: TimelineRow[] = [];
    if (this.found && this.alert.createdAt > 0) {
      const created = new TimelineRow();
      created.time = this.alert.createdAt;
      created.title = '告警产生';
      created.note = `${this.alert.title} · 设备 ${this.alert.deviceId}`;
      rows.push(created);
    }
    if (this.submitAt > 0) {
      const submitted = new TimelineRow();
      submitted.time = this.submitAt;
      submitted.title = '本机已提交确认请求';
      submitted.note = '服务端已接受命令（PENDING），不代表设备已确认';
      rows.push(submitted);
    }
    if (this.found && this.alert.statusKey === 'acked' && this.alert.acknowledgedAt > 0) {
      const acked = new TimelineRow();
      acked.time = this.alert.acknowledgedAt;
      acked.title = '设备已确认（回执）';
      acked.note = this.alert.acknowledgedBy.length > 0
        ? `回执人：${this.alert.acknowledgedBy}` : '';
      rows.push(acked);
    }
    rows.sort((left: TimelineRow, right: TimelineRow): number => left.time - right.time);
    this.timelineRows = rows;
  }

  private startWaitTimer(): void {
    if (this.disposed) return;
    if (this.waitTimerId !== -1) return;
    this.waitTimerId = setInterval(() => {
      if (this.phase !== AckPhase.WAITING) {
        this.stopWaitTimer();
        return;
      }
      void GuardianService.refreshAlerts();
      if (this.submitAt > 0 && Date.now() - this.submitAt > WAIT_TIMEOUT_MS) {
        this.phase = AckPhase.TIMEOUT;
        this.ackMessage = '等待超时，仍未收到设备确认；服务端可能仍为 PENDING，请稍后刷新或联系现场';
        this.stopWaitTimer();
      }
    }, WAIT_POLL_MS);
  }

  private stopWaitTimer(): void {
    if (this.waitTimerId !== -1) {
      clearInterval(this.waitTimerId);
      this.waitTimerId = -1;
    }
  }

  private submit(): void {
    if (!this.found) {
      this.toast('告警不存在或已失效');
      return;
    }
    if (this.submitting || this.phase === AckPhase.SUBMITTING ||
      this.phase === AckPhase.WAITING || this.phase === AckPhase.CONFIRMED) {
      return;
    }
    if (this.alert.statusKey === 'acked') {
      this.toast('该告警已由设备确认');
      return;
    }
    if (this.alert.statusKey !== 'pending') {
      this.toast('当前告警状态不允许提交确认');
      return;
    }
    this.submitting = true;
    this.phase = AckPhase.SUBMITTING;
    this.ackMessage = '';
    GuardianService.ackAlert(this.alarmId, this.note).then((outcome: AckOutcome) => {
      if (this.disposed) {
        // 页面已离开：服务器可能已受理；这里不回写已销毁页面、不重启定时器、不弹提示。
        return;
      }
      if (outcome.kind === 'stale') {
        // 会话已切换：旧 ACK 结果整体忽略。
        this.submitting = false;
        return;
      }
      this.submitting = false;
      if (outcome.accepted) {
        this.phase = AckPhase.WAITING;
        this.submitAt = Date.now();
        this.ackMessage = outcome.message.length > 0 ? outcome.message : '命令已提交，等待设备确认';
        this.startWaitTimer();
        this.refreshTimeline();
        this.toast('命令已提交，等待设备回执');
      } else if (outcome.kind === 'unauthorized') {
        this.phase = AckPhase.FAILED;
        this.ackMessage = outcome.message;
      } else {
        this.phase = AckPhase.FAILED;
        this.ackMessage = outcome.message.length > 0 ? outcome.message : '提交失败，未确认';
        this.toast(this.ackMessage);
      }
    });
  }

  private refreshNow(): void {
    this.toast('正在刷新真实状态…');
    void GuardianService.refreshAlerts();
  }

  private toast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: message });
    } catch (error) {
      // 忽略 toast 失败
    }
  }

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private alertsLoaded(): boolean {
    return this.netStatus === NetworkState.OK || this.netStatus === NetworkState.PARTIAL ||
      this.netStatus === NetworkState.OFFLINE || this.netStatus === NetworkState.ERROR;
  }

  private statusChipBg(): string {
    if (this.alert.statusKey === 'acked') return Color.successLight;
    if (this.alert.statusKey === 'waiting') return Color.primaryLight;
    if (this.alert.statusKey === 'pending') {
      return this.alert.level === 'critical' ? Color.criticalLight : Color.warningLight;
    }
    return '#F1F5F9';
  }

  private statusChipFg(): string {
    if (this.alert.statusKey === 'acked') return Color.successDark;
    if (this.alert.statusKey === 'waiting') return Color.primaryDark;
    if (this.alert.statusKey === 'pending') {
      return this.alert.level === 'critical' ? Color.criticalDark : Color.warningDark;
    }
    return Color.textSecondary;
  }

  private elapsedText(): string {
    const anchor: number = this.phase === AckPhase.WAITING && this.submitAt > 0
      ? this.submitAt : this.alert.createdAt;
    if (anchor <= 0) return '--';
    const total: number = Math.max(0, Math.floor((Date.now() - anchor) / 1000));
    return DateUtil.duration(total * 1000);
  }

  private heroGrad(): LinearGradientOptions {
    if (this.alert.level === 'critical') return Grad.heroCritical();
    if (this.alert.level === 'high' || this.alert.level === 'medium') return Grad.heroWarning();
    return Grad.heroPrimary();
  }

  private submitLabel(): string {
    if (this.submitting) return '提交中…';
    if (this.phase === AckPhase.TIMEOUT) return '重新提交确认';
    if (this.phase === AckPhase.FAILED) return '重新提交确认';
    return '提交确认（通知设备）';
  }

  private submitDisabled(): boolean {
    if (this.submitting) return true;
    if (this.phase === AckPhase.WAITING || this.phase === AckPhase.CONFIRMED) return true;
    return this.alert.statusKey !== 'pending';
  }

  @Builder
  navBar() {
    Row() {
      Row() {
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(22)
          .fontColor([Color.textPrimary])
      }
      .width(42)
      .height(42)
      .justifyContent(FlexAlign.Center)
      .onClick(() => this.getUIContext().getRouter().back())

      Text('预警详情')
        .fontSize(15)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
        .layoutWeight(1)
        .textAlign(TextAlign.Center)

      Row().width(42).height(42)
    }
    .width('100%')
    .height(50)
    .backgroundColor('rgba(255,255,255,0.94)')
    .backdropBlur(12)
    .border({ width: { bottom: 1 }, color: Color.border })
  }

  @Builder
  notFoundCard() {
    Column() {
      SymbolGlyph($r('sys.symbol.exclamationmark_circle'))
        .fontSize(56)
        .fontColor([Color.warning])
      Text('告警不存在或已失效')
        .fontSize(FontSize.h3)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
        .margin({ top: Space.md })
      Text('该告警不在服务端当前列表中，不会用 Mock 数据代替；请返回列表刷新后重试。')
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .textAlign(TextAlign.Center)
        .margin({ top: Space.xs })
      Row() {
        SecondaryButton({
          label: '返回预警列表',
          onClick_: () => this.getUIContext().getRouter().back()
        })
      }
      .width(180)
      .margin({ top: Space.lg })
    }
    .width('100%')
    .padding({ top: 80, left: Space.xxl, right: Space.xxl })
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  heroCard() {
    Column() {
      Row() {
        LevelBadge({ level: this.alert.level })
        Text(this.alert.statusText)
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.semibold)
          .fontColor(this.statusChipFg())
          .padding({ left: 9, right: 9, top: 3, bottom: 3 })
          .backgroundColor(this.statusChipBg())
          .borderRadius(Radius.pill)
          .margin({ left: 6 })
        Blank()
        Text(`已过去 ${this.elapsedText()}`)
          .fontSize(FontSize.caption - 0.5)
          .fontWeight(FontWeight_.extrabold)
          .fontColor(Color.textSecondary)
      }
      .width('100%')

      Text(this.alert.title)
        .fontSize(FontSize.h1)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(Color.textPrimary)
        .margin({ top: 10 })

      Row() {
        Text(`${this.alert.location} · 设备 ${this.alert.deviceId}`)
          .fontSize(FontSize.caption - 0.5)
          .fontColor(Color.textSecondary)
          .margin({ right: Space.md })
          .layoutWeight(1)
      }
      .width('100%')
      .margin({ top: 7 })

      Text(this.alert.createdAt > 0 ? DateUtil.formatDateTime(this.alert.createdAt) : '时间未知')
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textTertiary)
        .margin({ top: 3 })

      Text(this.alert.description)
        .fontSize(FontSize.body)
        .fontColor(Color.textPrimary)
        .lineHeight(19)
        .margin({ top: 10 })

      if (this.alert.evidenceAvailable) {
        Row() {
          SymbolGlyph($r('sys.symbol.camera_fill'))
            .fontSize(11)
            .fontColor([Color.primaryDark])
          Text(`设备端已生成证据（${this.alert.evidenceBytes} bytes）；证据图下载本轮未开放`)
            .fontSize(FontSize.mini)
            .fontColor(Color.primaryDark)
            .layoutWeight(1)
            .maxLines(2)
            .margin({ left: Space.xs })
        }
        .width('100%')
        .padding({ left: 10, right: 10, top: 8, bottom: 8 })
        .backgroundColor('#FFFFFF')
        .borderRadius(Radius.chip)
        .margin({ top: 10 })
      }
    }
    .padding(Space.lg - 1)
    .width('100%')
    .borderRadius(22)
    .linearGradient(this.heroGrad())
    .shadow(Shadow_.pop('rgba(220,38,38,0.10)'))
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  ackPanel() {
    Column() {
      Row() {
        Text('告警确认（ACK）')
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
        Text('真实状态以服务端为准')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ left: 6 })
      }
      .width('100%')

      if (this.phase === AckPhase.CONFIRMED || this.alert.statusKey === 'acked') {
        Column() {
          Row() {
            SymbolGlyph($r('sys.symbol.checkmark_circle_fill'))
              .fontSize(18)
              .fontColor([Color.successDark])
            Text('设备已确认')
              .fontSize(FontSize.body + 1)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.successDark)
              .margin({ left: 6 })
          }
          .width('100%')
          Text(this.alert.acknowledgedAt > 0
            ? `设备回执时间：${DateUtil.formatDateTime(this.alert.acknowledgedAt)}`
            : '服务端已返回 ACKED')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 4 })
          if (this.alert.acknowledgedBy.length > 0) {
            Text(`回执人：${this.alert.acknowledgedBy}`)
              .fontSize(FontSize.caption)
              .fontColor(Color.textSecondary)
              .margin({ top: 2 })
          }
          Text('该状态来自服务端告警记录，不是本机推断。')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ top: 4 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.successLight)
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      } else if (this.phase === AckPhase.TIMEOUT) {
        Column() {
          Row() {
            SymbolGlyph($r('sys.symbol.exclamationmark_triangle_fill'))
              .fontSize(16)
              .fontColor([Color.warningDark])
            Text('等待超时，尚未收到设备确认')
              .fontSize(FontSize.body + 1)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.warningDark)
              .margin({ left: 6 })
          }
          .width('100%')
          Text(this.ackMessage.length > 0
            ? this.ackMessage
            : '等待超时，仍未收到设备确认；服务端可能仍为 PENDING，未本地归档。')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 4 })
          Text('可先刷新真实状态；若服务端已回到“待确认”，再决定是否重新提交。')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ top: 4 })
          Row({ space: 8 }) {
            Column() {
              SecondaryButton({ label: '刷新真实状态', onClick_: () => { this.refreshNow(); } })
            }
            .layoutWeight(1)
            if (this.alert.statusKey === 'pending' && !this.alert.ackPending) {
              Column() {
                PrimaryButton({
                  label: '重新提交确认',
                  loading: this.submitting,
                  disabled: this.submitting,
                  variant: this.alert.level === 'critical' ? 'critical' : 'primary',
                  onClick_: () => { this.submit(); }
                })
              }
              .layoutWeight(1)
            }
          }
          .width('100%')
          .margin({ top: 8 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.warningLight)
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      } else if ((this.phase === AckPhase.WAITING || this.alert.statusKey === 'waiting') &&
        this.phase !== AckPhase.TIMEOUT) {
        Column() {
          Row() {
            LoadingProgress()
              .width(18)
              .height(18)
              .color(Color.primaryDark)
            Text('已提交，等待设备回执')
              .fontSize(FontSize.body + 1)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.primaryDark)
              .margin({ left: 6 })
          }
          .width('100%')
          Text(this.ackMessage.length > 0 ? this.ackMessage : '服务端状态为 PENDING')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 4 })
          Text('HTTP 202 只表示命令已入队；只有服务端返回 ACKED 才是设备已确认。')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ top: 4 })
          Row() {
            SecondaryButton({ label: '刷新真实状态', onClick_: () => { this.refreshNow(); } })
          }
          .width(170)
          .margin({ top: 8 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.primaryLight)
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      } else if (this.phase === AckPhase.SUBMITTING) {
        Row() {
          LoadingProgress()
            .width(18)
            .height(18)
            .color(Color.primaryDark)
          Text('正在提交确认命令…')
            .fontSize(FontSize.body)
            .fontColor(Color.primaryDark)
            .margin({ left: 6 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor(Color.primaryLight)
        .borderRadius(Radius.button)
        .margin({ top: 10 })
      } else if (this.alert.statusKey === 'pending') {
        TextArea({
          placeholder: '处置说明（选填，最多 120 字），例如：已电话确认，老人安全',
          text: this.note
        })
          .width('100%')
          .height(88)
          .fontSize(FontSize.caption + 0.5)
          .backgroundColor('#F8FAFC')
          .borderRadius(Radius.button)
          .border({ width: 1.5, color: '#CBD5E1', style: BorderStyle.Dashed })
          .padding(Space.md)
          .maxLength(120)
          .onChange((value: string) => { this.note = value; })
          .margin({ top: 10 })

        if (this.phase === AckPhase.FAILED || this.phase === AckPhase.TIMEOUT) {
          Text(this.ackMessage)
            .fontSize(FontSize.caption)
            .fontColor(Color.criticalDark)
            .width('100%')
            .padding(Space.sm)
            .backgroundColor(Color.criticalLight)
            .borderRadius(Radius.chip)
            .margin({ top: 8 })
        }

        Text('提交后服务端返回 PENDING；需等待设备真实回执 ACKED，页面才会显示“设备已确认”。')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .lineHeight(16)
          .margin({ top: 8 })

        Row() {
          PrimaryButton({
            label: this.submitLabel(),
            loading: this.submitting,
            disabled: this.submitDisabled(),
            variant: this.alert.level === 'critical' ? 'critical' : 'primary',
            onClick_: () => { this.submit(); }
          })
        }
        .width('100%')
        .margin({ top: 10 })
      } else {
        Column() {
          Text('当前告警状态不允许提交确认')
            .fontSize(FontSize.body)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textSecondary)
          Text(`服务端状态：${this.alert.state.length > 0 ? this.alert.state : '未知'}，真实状态以刷新结果为准。`)
            .fontSize(FontSize.caption)
            .fontColor(Color.textTertiary)
            .margin({ top: 3 })
          Row() {
            SecondaryButton({ label: '刷新真实状态', onClick_: () => { this.refreshNow(); } })
          }
          .width(170)
          .margin({ top: 8 })
        }
        .width('100%')
        .padding(Space.md)
        .backgroundColor('#F8FAFC')
        .borderRadius(Radius.button)
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 10 })
      }

      Row() {
        SymbolGlyph($r('sys.symbol.info_circle'))
          .fontSize(11)
          .fontColor([Color.textTertiary])
        Text('电话联系 / 上门处置 / 归档：本轮无对应后端接口，未开放；不会伪造“已归档”。')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .layoutWeight(1)
          .margin({ left: 4 })
      }
      .width('100%')
      .margin({ top: 10 })
    }
    .padding(Space.lg - 2)
    .width('100%')
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  timelineCard() {
    Column() {
      Text('事件时间线（仅真实记录）')
        .fontSize(FontSize.h3)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
        .margin({ bottom: Space.md })

      if (this.timelineRows.length === 0) {
        Text('暂无可展示的真实时间线')
          .fontSize(FontSize.caption)
          .fontColor(Color.textTertiary)
      } else {
        ForEach(this.timelineRows, (row: TimelineRow, index: number) => {
          Row() {
            Column() {
              Column()
                .width(9)
                .height(9)
                .borderRadius(4.5)
                .linearGradient(index === this.timelineRows.length - 1
                  ? Grad.primary()
                  : { angle: 135, colors: [['#CBD5E1', 0.0], ['#CBD5E1', 1.0]] })
              if (index < this.timelineRows.length - 1) {
                Column()
                  .width(2)
                  .height(26)
                  .backgroundColor(Color.border)
                  .margin({ top: 4 })
              }
            }
            .width(16)
            .alignItems(HorizontalAlign.Center)

            Column() {
              Row() {
                Text(row.title)
                  .fontSize(FontSize.body - 0.5)
                  .fontWeight(FontWeight_.bold)
                  .fontColor(Color.textPrimary)
                  .layoutWeight(1)
                Text(DateUtil.formatTime(row.time))
                  .fontSize(FontSize.caption - 0.5)
                  .fontColor(Color.textTertiary)
              }
              .width('100%')
              if (row.note.length > 0) {
                Text(row.note)
                  .fontSize(FontSize.caption - 0.5)
                  .fontColor(Color.textSecondary)
                  .width('100%')
                  .maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ top: 2 })
              }
            }
            .layoutWeight(1)
            .padding({ left: 9, bottom: Space.md })
            .alignItems(HorizontalAlign.Start)
          }
          .width('100%')
          .alignItems(VerticalAlign.Top)
        }, (row: TimelineRow, index: number) => `${index}_${row.time}_${row.title}`)
      }

      if (this.netStatus !== NetworkState.OK) {
        Text(this.netMessage.length > 0 ? this.netMessage : '网络状态异常，显示上次数据')
          .fontSize(FontSize.mini)
          .fontColor(Color.warningDark)
          .width('100%')
          .margin({ top: 6 })
      }
    }
    .padding(Space.lg - 2)
    .width('100%')
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2, bottom: Space.xxl })
  }

  build() {
    Column() {
      this.navBar()

      if (!this.found && !this.alertsLoaded()) {
        Column() {
          LoadingProgress()
            .width(28)
            .height(28)
            .color(Color.primary)
          Text('正在加载真实告警数据…')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: Space.md })
        }
        .width('100%')
        .padding({ top: 80 })
        .alignItems(HorizontalAlign.Center)
      } else if (!this.found) {
        this.notFoundCard()
      } else {
        Scroll() {
          Column() {
            this.heroCard()
            this.ackPanel()
            this.timelineCard()
          }
          .width('100%')
        }
        .layoutWeight(1)
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
