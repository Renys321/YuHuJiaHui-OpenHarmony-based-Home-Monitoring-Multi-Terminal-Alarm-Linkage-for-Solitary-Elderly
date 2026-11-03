/**
 * 活动报告页 —— 消费者真实接口 GET /api/v1/activity/report。
 *
 * 数据口径（与合同一致，禁止伪造）：
 * - 活动次数只来自服务端；count 缺失显示“无数据”，绝不显示“0 次”。
 * - 24 小时数据汇总为 6 个时段（夜间/早晨/上午/下午/晚间/深夜）。
 * - 近 7 日趋势中无数据日显示“无数据”，不按 0 画柱。
 * - 对比/趋势文案覆盖 comparable / previous_zero / previous_missing /
 *   selected_missing / insufficient 与 insufficient / stable / up / down。
 * - 不诊断疾病、不宣称人数或唯一动作次数；PIR 触发计数 ≠ 人数。
 * - 演示模式（RunMode.DEMO）不请求真实接口，明确显示“演示模式无活动报告数据”。
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { DemoModeBar } from '../components/DemoModeBar';
import { EmptyState } from '../components/EmptyState';
import { DateUtil } from '../common/DateUtil';
import { RunMode } from '../core/view/Models';
import {
  ActivityBucketView, ActivityDayView, ActivityDeviceView, ActivityLoadState, ActivityReportView,
  ActivityScope
} from '../core/activity/ActivityModels';
import { isIsoDateAfter, shiftIsoDate } from '../core/activity/ActivityReport';
import { GuardianService } from '../service/GuardianService';

class ScopeOption {
  key: string = '';
  label: string = '';
}

@Entry
@Component
struct ActivityReportPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.activityReport') report: ActivityReportView = new ActivityReportView();
  @StorageLink('gv.activityStatus') status: string = ActivityLoadState.IDLE;
  @StorageLink('gv.activityMessage') message: string = '';
  @StorageLink('gv.mode') mode: string = RunMode.NONE;
  @State scope: string = ActivityScope.DAY;
  @State selectedDate: string = '';
  @State loading: boolean = false;
  /** 加载中用户又改了范围/日期时置位，本次返回后立即按最新选择重载，避免旧响应回退用户选择。 */
  private pendingReload: boolean = false;
  private disposed: boolean = false;
  private loadSeq: number = 0;

  aboutToAppear(): void {
    this.disposed = false;
    if (this.selectedDate.length === 0) {
      const today: string = this.maxDate();
      this.selectedDate = today.length > 0 ? today : DateUtil.formatDate(Date.now());
    }
    if (this.mode === RunMode.DEMO) {
      return;
    }
    void this.load();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private maxDate(): string {
    if (this.report.today.length > 0) {
      return this.report.today;
    }
    return DateUtil.formatDate(Date.now());
  }

  private scopeOptions(): ScopeOption[] {
    const items: ScopeOption[] = [];
    const day = new ScopeOption();
    day.key = ActivityScope.DAY;
    day.label = '日';
    items.push(day);
    const week = new ScopeOption();
    week.key = ActivityScope.WEEK;
    week.label = '周';
    items.push(week);
    const month = new ScopeOption();
    month.key = ActivityScope.MONTH;
    month.label = '月';
    items.push(month);
    return items;
  }

  private canGoNext(): boolean {
    return this.selectedDate.length > 0 && isIsoDateAfter(this.maxDate(), this.selectedDate);
  }

  private toast(text: string): void {
    this.getUIContext().getPromptAction().showToast({ message: text });
  }

  private async load(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.mode === RunMode.DEMO) {
      this.toast('演示模式无活动报告数据');
      return;
    }
    if (this.selectedDate.length === 0) {
      return;
    }
    if (this.loading) {
      // 加载中改范围/日期：先记下“要重载”，等本次返回后按最新选择再取一次，
      // 不能直接丢弃用户的选择，也不能让旧响应把 chip/日期回退。
      this.pendingReload = true;
      return;
    }
    this.loading = true;
    this.loadSeq = this.loadSeq + 1;
    const seq: number = this.loadSeq;
    const requestedScope: string = this.scope;
    const requestedDate: string = this.selectedDate;
    try {
      const outcome = await GuardianService.loadActivityReport(this.scope, this.selectedDate);
      if (this.disposed || seq !== this.loadSeq) {
        return;
      }
      if (outcome.ok) {
        // 服务端回显只用于纠偏：用户本次请求之后没再改动，才同步回本地状态。
        const unchanged: boolean = this.scope === requestedScope && this.selectedDate === requestedDate;
        if (unchanged) {
          if (this.report.selectedDate.length > 0) {
            this.selectedDate = this.report.selectedDate;
          }
          if (this.report.scope === ActivityScope.DAY || this.report.scope === ActivityScope.WEEK ||
            this.report.scope === ActivityScope.MONTH) {
            this.scope = this.report.scope;
          }
        }
      } else if (!outcome.stale) {
        this.toast(outcome.message.length > 0 ? outcome.message : '活动报告加载失败');
      }
    } catch (err) {
      if (!this.disposed && seq === this.loadSeq) {
        this.toast('活动报告加载失败，请稍后重试');
      }
    } finally {
      if (seq === this.loadSeq) {
        this.loading = false;
        if (this.pendingReload && !this.disposed) {
          this.pendingReload = false;
          void this.load();
        }
      }
    }
  }

  private changeScope(next: string): void {
    if (this.scope === next) {
      return;
    }
    this.scope = next;
    void this.load();
  }

  private shiftDate(deltaDays: number): void {
    const next: string = shiftIsoDate(this.selectedDate, deltaDays);
    if (next.length === 0) {
      return;
    }
    if (isIsoDateAfter(next, this.maxDate())) {
      return;
    }
    this.selectedDate = next;
    void this.load();
  }

  private pickDate(): void {
    const parts: string[] = this.selectedDate.split('-');
    let selected: Date = new Date();
    if (parts.length === 3) {
      selected = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }
    this.getUIContext().showDatePickerDialog({
      start: new Date(2020, 0, 1),
      end: new Date(),
      selected: selected,
      onDateAccept: (value: Date) => {
        const iso: string =
          `${value.getFullYear()}-${DateUtil.pad(value.getMonth() + 1)}-${DateUtil.pad(value.getDate())}`;
        if (iso.length === 0 || isIsoDateAfter(iso, this.maxDate())) {
          return;
        }
        this.selectedDate = iso;
        void this.load();
      }
    });
  }

  private canRetry(): boolean {
    return this.status === ActivityLoadState.ERROR ||
      this.status === ActivityLoadState.UNAUTHORIZED || !this.report.hasData;
  }

  private errorBannerVisible(): boolean {
    if (this.loading || this.status === ActivityLoadState.LOADING) {
      return false;
    }
    return (this.status === ActivityLoadState.ERROR || this.status === ActivityLoadState.UNAUTHORIZED) &&
      this.message.length > 0;
  }

  private errorColor(): string {
    if (this.status === ActivityLoadState.UNAUTHORIZED) {
      return Color.criticalDark;
    }
    return Color.warningDark;
  }

  private errorBackground(): string {
    if (this.status === ActivityLoadState.UNAUTHORIZED) {
      return Color.criticalLight;
    }
    return Color.warningLight;
  }

  private scopeLabelText(): string {
    if (this.scope === ActivityScope.WEEK) {
      return '周';
    }
    if (this.scope === ActivityScope.MONTH) {
      return '月';
    }
    return '日';
  }

  @Builder
  scopeChip(item: ScopeOption) {
    Text(item.label)
      .fontSize(FontSize.body - 0.5)
      .fontWeight(this.scope === item.key ? FontWeight_.bold : FontWeight_.regular)
      .fontColor(this.scope === item.key ? '#FFFFFF' : Color.textSecondary)
      .width(46)
      .height(30)
      .textAlign(TextAlign.Center)
      .borderRadius(Radius.pill)
      .linearGradient(this.scope === item.key
        ? Grad.primary()
        : { angle: 135, colors: [[Color.card, 0.0], [Color.card, 1.0]] })
      .border({ width: 1, color: this.scope === item.key ? 'rgba(0,0,0,0)' : Color.border })
      .onClick(() => { this.changeScope(item.key); })
  }

  @Builder
  kpiCard(label: string, value: string, note: string, color: string) {
    Column() {
      Text(value)
        .fontSize(19)
        .fontWeight(FontWeight_.extrabold)
        .fontColor(color)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(label)
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textSecondary)
        .margin({ top: 2 })
      Text(note)
        .fontSize(FontSize.mini - 1)
        .fontColor(Color.textTertiary)
        .margin({ top: 3 })
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .padding(Space.md)
    .backgroundColor(Color.card)
    .borderRadius(Radius.tile)
    .shadow(Shadow_.card())
  }

  @Builder
  controlsCard() {
    Column() {
      Row() {
        ForEach(this.scopeOptions(), (item: ScopeOption) => {
          this.scopeChip(item)
        }, (item: ScopeOption) => item.key)
        Blank()
        if (this.canRetry()) {
          Row() {
            SymbolGlyph($r('sys.symbol.arrow_clockwise'))
              .fontSize(15)
              .fontColor([Color.primaryDark])
            Text('刷新')
              .fontSize(FontSize.caption)
              .fontColor(Color.primaryDark)
              .margin({ left: 3 })
          }
          .height(30)
          .padding({ left: 8, right: 8 })
          .borderRadius(Radius.pill)
          .backgroundColor(Color.primaryLight)
          .onClick(() => { void this.load(); })
        }
      }
      .width('100%')

      Row() {
        Row() {
          SymbolGlyph($r('sys.symbol.chevron_left'))
            .fontSize(18)
            .fontColor([Color.primaryDark])
        }
        .width(34)
        .height(34)
        .borderRadius(10)
        .backgroundColor('#EFF6FF')
        .justifyContent(FlexAlign.Center)
        .onClick(() => { this.shiftDate(-1); })

        Column() {
          Text(this.selectedDate.length > 0 ? this.selectedDate : '选择日期')
            .fontSize(FontSize.h2)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textPrimary)
          Text(`查询范围：${this.scopeLabelText()} · 点击选择日期`)
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ top: 1 })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Center)
        .onClick(() => { this.pickDate(); })

        Row() {
          SymbolGlyph($r('sys.symbol.chevron_right'))
            .fontSize(18)
            .fontColor([this.canGoNext() ? Color.primaryDark : Color.textTertiary])
        }
        .width(34)
        .height(34)
        .borderRadius(10)
        .backgroundColor(this.canGoNext() ? '#EFF6FF' : '#F1F5F9')
        .justifyContent(FlexAlign.Center)
        .opacity(this.canGoNext() ? 1 : 0.6)
        .onClick(() => { this.shiftDate(1); })
      }
      .width('100%')
      .margin({ top: Space.md })

      Row() {
        SymbolGlyph($r('sys.symbol.info_circle'))
          .fontSize(11)
          .fontColor([Color.textTertiary])
        Text('数据来自真实接口；未采集或不足时显示“无数据”，不会用 0 冒充。')
          .fontSize(FontSize.mini - 0.5)
          .fontColor(Color.textTertiary)
          .margin({ left: 4 })
          .layoutWeight(1)
          .maxLines(2)
      }
      .width('100%')
      .margin({ top: Space.sm })
    }
    .width('100%')
    .padding(Space.md + 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md })
  }

  @Builder
  stateBanner() {
    Row() {
      SymbolGlyph($r('sys.symbol.info_circle'))
        .fontSize(13)
        .fontColor([this.errorColor()])
      Text(this.message)
        .fontSize(FontSize.caption)
        .fontColor(this.errorColor())
        .margin({ left: 5 })
        .layoutWeight(1)
        .maxLines(3)
    }
    .width('100%')
    .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
    .backgroundColor(this.errorBackground())
    .borderRadius(Radius.chip)
    .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
  }

  @Builder
  loadingBanner() {
    Row() {
      LoadingProgress()
        .width(15)
        .height(15)
        .color(Color.primaryDark)
      Text(this.status === ActivityLoadState.LOADING && this.message.length > 0
        ? this.message : '正在加载活动报告…')
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .margin({ left: 6 })
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
    .backgroundColor('#F1F5F9')
    .borderRadius(Radius.chip)
    .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
  }

  @Builder
  sectionTitle(title: string, note: string) {
    Column() {
      Row() {
        Column()
          .width(3)
          .height(13)
          .borderRadius(2)
          .linearGradient(Grad.primary())
          .margin({ right: 7 })
        Text(title)
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
      }
      .alignItems(VerticalAlign.Center)
      if (note.length > 0) {
        Text(note)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ top: 3, left: 10 })
          .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ bottom: Space.sm })
  }

  @Builder
  kpiSection() {
    Row({ space: 9 }) {
      this.kpiCard(this.report.countKpiLabel, this.report.countKpiText, '服务端真实计数',
        this.report.selectedCount !== null || this.report.summary.total !== null
          ? Color.primaryDark : Color.textTertiary)
      this.kpiCard(this.report.avgKpiLabel, this.report.avgKpiText, '有数据日平均', Color.textSecondary)
      this.kpiCard(this.report.coverageKpiLabel, this.report.coverageKpiText,
        this.report.selectedStatusText, Color.textSecondary)
    }
    .width('100%')
    .padding({ left: this.pm(), right: this.pm() })
  }

  @Builder
  bucketRow(b: ActivityBucketView) {
    Column() {
      Row() {
        Text(b.label)
          .fontSize(FontSize.body)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textPrimary)
        Text(b.rangeText)
          .fontSize(FontSize.mini - 0.5)
          .fontColor(Color.textTertiary)
          .margin({ left: 5 })
        Blank()
        Text(b.countText)
          .fontSize(FontSize.caption)
          .fontColor(b.hasCount ? Color.textSecondary : Color.textTertiary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')

      Stack({ alignContent: Alignment.Start }) {
        Row()
          .width('100%')
          .height(9)
          .backgroundColor(Color.track)
          .borderRadius(5)
        if (b.hasCount) {
          Row()
            .width(`${Math.max(4, Math.round(b.ratio * 100))}%`)
            .height(9)
            .borderRadius(5)
            .linearGradient(Grad.barPrimary())
        }
      }
      .width('100%')
      .height(9)
      .margin({ top: 5, bottom: 9 })
    }
    .width('100%')
  }

  @Builder
  hourlyCard() {
    Column() {
      this.sectionTitle('时段分布', this.report.bucketsNote)
      if (!this.report.hourlyAvailable) {
        Text(this.report.hourlyNote)
          .fontSize(FontSize.caption)
          .fontColor(Color.warningDark)
          .width('100%')
          .margin({ bottom: Space.sm })
      }
      ForEach(this.report.buckets, (b: ActivityBucketView) => {
        this.bucketRow(b)
      }, (b: ActivityBucketView) => b.key)
    }
    .width('100%')
    .padding(Space.lg - 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  dayColumn(d: ActivityDayView) {
    Column() {
      if (d.hasCount) {
        Text(`${d.count}`)
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textSecondary)
      } else {
        Text('无数据')
          .fontSize(FontSize.mini - 1)
          .fontColor(Color.textTertiary)
      }
      Column()
        .width(20)
        .height(d.hasCount ? Math.max(6, d.ratio * 68 + 4) : 6)
        .borderRadius(6)
        .linearGradient(d.hasCount ? Grad.barPrimary() : Grad.barNight())
        .margin({ top: Space.xs, bottom: Space.xs })
      Text(d.label)
        .fontSize(FontSize.mini - 1)
        .fontColor(Color.textTertiary)
        .maxLines(1)
    }
    .layoutWeight(1)
    .height(116)
    .justifyContent(FlexAlign.End)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  daysCard() {
    Column() {
      this.sectionTitle(`近 7 日趋势（${this.report.daysNote}）`, '')
      if (this.report.recentDays.length === 0) {
        Text('服务端未返回每日趋势数据。')
          .fontSize(FontSize.caption)
          .fontColor(Color.textTertiary)
      } else {
        Row() {
          ForEach(this.report.recentDays, (d: ActivityDayView) => {
            this.dayColumn(d)
          }, (d: ActivityDayView) => d.date)
        }
        .width('100%')
        .alignItems(VerticalAlign.Bottom)
      }
    }
    .width('100%')
    .padding(Space.lg - 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  private isDayScope(): boolean {
    const scope: string = this.report.hasData ? this.report.scope : this.scope;
    return scope !== ActivityScope.WEEK && scope !== ActivityScope.MONTH;
  }

  private previousLabel(): string {
    return this.isDayScope() ? '前一日' : '上一周期';
  }

  private previousDateText(): string {
    if (this.report.previousDate.length === 0) {
      return '日期未知';
    }
    // week/month 的服务端 previous 是上一等长周期（结束日=previous.date）。
    return this.isDayScope() ? this.report.previousDate : `截至 ${this.report.previousDate}`;
  }

  private compareTitle(): string {
    return this.isDayScope() ? '与前一日对比' : '与上一周期对比';
  }

  @Builder
  compareCard() {
    Column() {
      this.sectionTitle(this.compareTitle(), '只比较活动次数，不做健康判断')
      Row() {
        Column() {
          Text(this.previousLabel())
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
          Text(this.previousDateText())
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
          Text(this.report.previousCountText)
            .fontSize(FontSize.h2)
            .fontWeight(FontWeight_.bold)
            .fontColor(this.report.previousCount !== null ? Color.textPrimary : Color.textTertiary)
            .margin({ top: 3 })
          Text(this.report.previousStatusText)
            .fontSize(FontSize.mini - 0.5)
            .fontColor(Color.textTertiary)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        Column() {
          SymbolGlyph($r('sys.symbol.chevron_right'))
            .fontSize(18)
            .fontColor([Color.textTertiary])
          Text(this.report.comparison.pctText.length > 0
            ? this.report.comparison.pctText : '—')
            .fontSize(FontSize.mini)
            .fontColor(Color.primaryDark)
            .margin({ top: 2 })
        }
        .width(52)
        .alignItems(HorizontalAlign.Center)

        Column() {
          Text(this.report.scope === ActivityScope.DAY ? '今日/选定日' : '选定范围')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
          Text(this.report.selectedDateText.length > 0 ? this.report.selectedDateText : '日期未知')
            .fontSize(FontSize.caption)
            .fontColor(Color.textSecondary)
            .margin({ top: 2 })
          Text(this.report.selectedCountText)
            .fontSize(FontSize.h2)
            .fontWeight(FontWeight_.bold)
            .fontColor(this.report.selectedCount !== null ? Color.primaryDark : Color.textTertiary)
            .margin({ top: 3 })
          Text(this.report.selectedStatusText)
            .fontSize(FontSize.mini - 0.5)
            .fontColor(Color.textTertiary)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')

      Row() {
        Text(this.report.comparison.stateText)
          .fontSize(FontSize.mini - 0.5)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.primaryDark)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor(Color.primaryLight)
          .borderRadius(Radius.pill)
        Blank()
        Text(this.report.comparison.deltaText)
          .fontSize(FontSize.caption)
          .fontColor(Color.textSecondary)
      }
      .width('100%')
      .margin({ top: Space.sm })

      Text(this.report.comparison.text)
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .lineHeight(16)
        .width('100%')
        .margin({ top: Space.xs })
    }
    .width('100%')
    .padding(Space.lg - 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  trendCard() {
    Column() {
      this.sectionTitle('变化趋势', '')
      Row() {
        Text(this.report.trend.stateText)
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.primaryDark)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor(Color.primaryLight)
          .borderRadius(Radius.pill)
        Text(this.report.trend.text)
          .fontSize(FontSize.body)
          .fontColor(Color.textPrimary)
          .margin({ left: 6 })
          .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.report.trend.note.length > 0) {
        Text(this.report.trend.note)
          .fontSize(FontSize.caption)
          .fontColor(Color.textTertiary)
          .lineHeight(16)
          .width('100%')
          .margin({ top: Space.xs })
      }
    }
    .width('100%')
    .padding(Space.lg - 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  deviceRow(d: ActivityDeviceView) {
    Row() {
      Column() {
        Text(d.roomText)
          .fontSize(FontSize.body)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textPrimary)
        Text(d.deviceId.length > 0 ? d.deviceId : '设备未知')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ top: 1 })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Column() {
        Text(d.countText)
          .fontSize(FontSize.body)
          .fontWeight(FontWeight_.bold)
          .fontColor(d.hasCount ? Color.textPrimary : Color.textTertiary)
        Text(d.statusText)
          .fontSize(FontSize.mini - 0.5)
          .fontColor(Color.textTertiary)
          .margin({ top: 1 })
      }
      .alignItems(HorizontalAlign.End)

      if (!d.hasMotionSensor) {
        // 后端 hasMotionSensor 只表示“是否观测到过 PIR 字段”，不能据此断言设备未配置传感器：
        // 新增/未接入/统计窗口内无样本的设备同样为 false，这里只表达“未观测到”。
        Text('未观测到人体传感器')
          .fontSize(FontSize.mini - 1)
          .fontColor(Color.warningDark)
          .padding({ left: 5, right: 5, top: 2, bottom: 2 })
          .backgroundColor(Color.warningLight)
          .borderRadius(Radius.pill)
          .margin({ left: 6 })
      }
    }
    .width('100%')
    .padding({ top: Space.sm, bottom: Space.sm })
  }

  @Builder
  devicesCard() {
    Column() {
      this.sectionTitle('分房间活动计数', this.report.devicesNote)
      if (this.report.devices.length === 0) {
        Text('服务端未返回设备活动数据。')
          .fontSize(FontSize.caption)
          .fontColor(Color.textTertiary)
      } else {
        ForEach(this.report.devices, (d: ActivityDeviceView, idx: number) => {
          this.deviceRow(d)
        }, (d: ActivityDeviceView, idx: number) =>
          `${d.deviceId.length > 0 ? d.deviceId : d.roomText}_${idx}`)
      }
    }
    .width('100%')
    .padding(Space.lg - 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  infoRow(label: string, value: string) {
    Row() {
      Text(label)
        .fontSize(FontSize.caption)
        .fontColor(Color.textTertiary)
        .width(88)
      Text(value.length > 0 ? value : '未提供')
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .layoutWeight(1)
        .maxLines(2)
    }
    .width('100%')
    .padding({ top: 2, bottom: 2 })
  }

  @Builder
  coverageCard() {
    Column() {
      this.sectionTitle('数据覆盖', '')
      this.infoRow('查询范围', this.report.rangeText)
      this.infoRow('数据起始', this.report.historyText)
      this.infoRow('汇总次数', this.report.summary.totalText)
      this.infoRow('有数据天数',
        `${this.report.summary.daysWithData}/${this.report.summary.days} 天`)
      this.infoRow('覆盖率', this.report.summary.coverageText)
      this.infoRow('当日覆盖', this.report.selectedCoverageText)
      if (this.report.selectedSamplesText.length > 0) {
        this.infoRow('样本', this.report.selectedSamplesText)
      }
      if (this.report.historyNote.length > 0) {
        Text(this.report.historyNote)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .lineHeight(15)
          .width('100%')
          .margin({ top: Space.xs })
      }
    }
    .width('100%')
    .padding(Space.lg - 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md - 2 })
  }

  @Builder
  emptyCard() {
    Column() {
      EmptyState({
        icon: $r('sys.symbol.waveform'),
        title: this.report.emptyTitle,
        description: this.report.emptyDescription
      })
      if (this.canRetry()) {
        Text('重新加载')
          .fontSize(FontSize.body)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.primaryDark)
          .height(40)
          .padding({ left: Space.lg, right: Space.lg })
          .backgroundColor(Color.primaryLight)
          .borderRadius(Radius.button)
          .onClick(() => { void this.load(); })
      }
    }
    .width('100%')
    .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
  }

  @Builder
  disclaimerCard() {
    Column() {
      Text(this.report.disclaimer.length > 0 ? this.report.disclaimer
        : '活动数据来自 PIR 触发计数，仅用于了解日常活动节律；不构成医疗结论，也不代表人数或唯一动作次数。')
        .fontSize(FontSize.mini)
        .fontColor(Color.textTertiary)
        .lineHeight(15)
        .width('100%')
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor('#F1F5F9')
    .borderRadius(Radius.chip)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md })
  }

  build() {
    Column() {
      NavBar({
        title: '活动报告',
        showBack: true,
        rightText: '刷新',
        onRight: () => {
          if (this.mode === RunMode.DEMO) {
            this.toast('演示模式无活动报告数据');
            return;
          }
          void this.load();
        }
      })
      DemoModeBar()

      if (this.mode === RunMode.DEMO) {
        Column() {
          Column() {
            Text('演示模式无活动报告数据')
              .fontSize(FontSize.h3)
              .fontWeight(FontWeight_.bold)
              .fontColor('#92400E')
              .width('100%')
            Text('演示数据只包含示例设备/告警，不包含真实活动报告；退出演示并登录后才能查看真实 PIR 活动计数。')
              .fontSize(FontSize.caption)
              .fontColor('#92400E')
              .lineHeight(16)
              .width('100%')
              .margin({ top: Space.xs })
          }
          .width('100%')
          .padding(Space.md)
          .backgroundColor('#FFFBEB')
          .borderRadius(Radius.card)
          .margin({ left: this.pm(), right: this.pm(), top: Space.md })

          EmptyState({
            icon: $r('sys.symbol.doc_text'),
            title: '演示模式无活动报告数据',
            description: '本页只展示真实接口数据，演示模式不伪造活动报告。'
          })
        }
        .width('100%')
        .layoutWeight(1)
      } else {
        Scroll() {
          Column() {
            this.controlsCard()
            if (this.loading || this.status === ActivityLoadState.LOADING) {
              this.loadingBanner()
            }
            if (this.errorBannerVisible()) {
              this.stateBanner()
            }

            if (this.report.hasData) {
              this.kpiSection()
              if (this.report.isEmpty) {
                this.emptyCard()
                this.coverageCard()
              } else {
                this.hourlyCard()
                this.daysCard()
                this.compareCard()
                this.trendCard()
                this.devicesCard()
                this.coverageCard()
              }
            } else {
              Column() {
                EmptyState({
                  icon: $r('sys.symbol.doc_text'),
                  title: '活动报告尚未加载',
                  description: this.message.length > 0 ? this.message
                    : '选择日期与范围后，点击刷新加载真实活动数据。'
                })
                Text('加载活动报告')
                  .fontSize(FontSize.body)
                  .fontWeight(FontWeight_.semibold)
                  .fontColor(Color.primaryDark)
                  .height(40)
                  .padding({ left: Space.lg, right: Space.lg })
                  .backgroundColor(Color.primaryLight)
                  .borderRadius(Radius.button)
                  .onClick(() => { void this.load(); })
              }
              .width('100%')
              .margin({ left: this.pm(), right: this.pm() })
            }

            this.disclaimerCard()
            Column().height(Space.xxl)
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
