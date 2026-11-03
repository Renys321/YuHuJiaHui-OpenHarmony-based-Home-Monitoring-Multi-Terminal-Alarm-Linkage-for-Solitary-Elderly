/**
 * 健康评估页 —— 两页健康资料表单 → 保存 → 生成健康科普建议 → 结果面板。
 *
 * 接口（唯一事实来源 competition/docs/AI-HEALTH-ASSESSMENT-SPEC.md §5）：
 * - GET/PUT /api/v1/health-profile、POST /api/v1/health-advice 全部经 GuardianService；
 * - 页面不直连 ApiClient / HttpTransport（静态守卫约束）。
 *
 * 硬约束：
 * - 本功能只做健康科普：不诊断、不开药、不提供医疗处置指导；结果面板固定 4 段 + 固定免责声明；
 * - 顶部固定两条提示：隐私提示 + 免责声明；
 * - 失败（超时/网络/502/503/空资料）必须显示明确状态与重试按钮，**绝不展示本地伪造建议**；
 * - 演示模式不调用网络（fail-closed），提示退出演示。
 */
import { Color, FontSize, FontWeight_, Grad, Radius, Shadow_, Space } from '../common/Theme';
import { Elder } from '../model/Elder';
import { Responsive } from '../common/Responsive';
import { NavBar } from '../components/NavBar';
import { DemoModeBar } from '../components/DemoModeBar';
import { PrimaryButton, SecondaryButton } from '../components/Buttons';
import { RunMode } from '../core/view/Models';
import { GuardianService } from '../service/GuardianService';
import { HealthAdviceOutcome, HealthProfileOutcome } from '../core/service/Outcomes';
import {
  HEALTH_ACUTE_NOTICE, HEALTH_DISCLAIMER_APP, HEALTH_GENERATING_MESSAGE,
  HEALTH_PRIVACY_NOTICE, HEALTH_SAVE_OK_MESSAGE, HEALTH_THIRD_PARTY_NOTICE,
  HealthFieldError, HealthFormState, HealthProfileView, HealthTaste,
  HealthTernary, HealthValidationResult, hasAcuteSymptomText, healthFormFreeText,
  healthFormFromView, validateHealthForm
} from '../core/health/HealthModels';
import {
  HealthAdviceFlowState, HealthAdviceSection, HealthAdviceView, HealthProfileStatus, healthAdviceMessage
} from '../core/health/HealthAdvice';

/** 页面主屏：填写 / 结果。 */
class HealthScreen {
  static readonly FORM: string = 'form';
  static readonly RESULT: string = 'result';
}

/** 表单步骤。 */
class FormStep {
  static readonly BASIC: number = 1;
  static readonly HABIT: number = 2;
}

/** 表单文本输入项配置（避免 19 个手写输入框重复代码）。 */
class FormFieldConfig {
  field: string = '';
  label: string = '';
  placeholder: string = '';
  hint: string = '';
  /** true=纯整数（使用数字键盘）；false=普通文本（小数可输入）。 */
  integer: boolean = false;
  multiline: boolean = false;
  maxLength: number = 100;
}

class TernaryOption {
  key: string = '';
  label: string = '';
}

class TasteOption {
  key: string = '';
  label: string = '';
}

@Entry
@Component
struct HealthAssessmentPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @StorageLink('gv.healthProfile') profile: HealthProfileView = new HealthProfileView();
  @StorageLink('gv.healthStatus') healthStatus: string = HealthProfileStatus.IDLE;
  @StorageLink('gv.healthMessage') healthMessage: string = '';
  @StorageLink('gv.healthAdvice') advice: HealthAdviceView = new HealthAdviceView();
  @StorageLink('gv.healthAdviceStatus') adviceStatus: string = HealthAdviceFlowState.IDLE;
  @StorageLink('gv.healthAdviceMessage') adviceMessage: string = '';
  @StorageLink('gv.mode') mode: string = RunMode.NONE;

  @State step: number = FormStep.BASIC;
  @State screen: string = HealthScreen.FORM;
  @State loadingProfile: boolean = true;
  @State saving: boolean = false;
  @State generating: boolean = false;
  @State fieldErrors: HealthFieldError[] = [];
  @State formMessage: string = '';
  /** 是否已就“健康资料将发送给第三方 AI”取得用户明确同意（仅本页生命周期内有效）。 */
  @State aiConsentGiven: boolean = false;

  // ---- 第 1 页：基础健康信息
  @State ageText: string = '';
  @State medicalHistory: string = '';
  @State medications: string = '';
  @State heightText: string = '';
  @State weightText: string = '';
  @State systolicText: string = '';
  @State diastolicText: string = '';
  @State glucoseText: string = '';
  // ---- 第 2 页：生活习惯
  @State sleepHoursText: string = '';
  @State sleepDifficulty: string = HealthTernary.UNSET;
  @State nightAwakeningsText: string = '';
  @State dietRegular: string = HealthTernary.UNSET;
  @State dietTaste: string = '';
  @State dietRestrictions: string = '';
  @State exerciseTimesText: string = '';
  @State exerciseTypes: string = '';
  @State smoking: string = '';
  @State alcohol: string = '';
  @State bowel: string = '';
  @State mood: string = '';
  @State vision: string = '';
  @State hearing: string = '';

  private disposed: boolean = false;

  aboutToAppear(): void {
    this.disposed = false;
    if (this.mode === RunMode.DEMO) {
      this.loadingProfile = false;
      return;
    }
    const ctx = this.getUIContext().getHostContext();
    if (ctx !== undefined) {
      GuardianService.init(ctx);
    }
    // 同一会话内重新进入页面时，已有真实建议则直接展示结果面板。
    if (this.advice.hasAdvice && this.adviceStatus === HealthAdviceFlowState.OK) {
      this.screen = HealthScreen.RESULT;
    }
    void this.loadProfile();
  }

  aboutToDisappear(): void {
    this.disposed = true;
  }

  // ------------------------------------------------------------- helpers

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  private isDemo(): boolean {
    return this.mode === RunMode.DEMO;
  }

  private toast(text: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: text });
    } catch (err) {
      // 忽略 toast 失败
    }
  }

  private isBasicField(field: string): boolean {
    return field === 'age' || field === 'medicalHistory' || field === 'medications' ||
      field === 'heightText' || field === 'weightText' || field === 'restingBloodPressure' ||
      field === 'glucoseText';
  }

  private fieldValue(field: string): string {
    if (field === 'ageText') return this.ageText;
    if (field === 'medicalHistory') return this.medicalHistory;
    if (field === 'medications') return this.medications;
    if (field === 'heightText') return this.heightText;
    if (field === 'weightText') return this.weightText;
    if (field === 'systolicText') return this.systolicText;
    if (field === 'diastolicText') return this.diastolicText;
    if (field === 'glucoseText') return this.glucoseText;
    if (field === 'sleepHoursText') return this.sleepHoursText;
    if (field === 'nightAwakeningsText') return this.nightAwakeningsText;
    if (field === 'dietRestrictions') return this.dietRestrictions;
    if (field === 'exerciseTimesText') return this.exerciseTimesText;
    if (field === 'exerciseTypes') return this.exerciseTypes;
    if (field === 'smoking') return this.smoking;
    if (field === 'alcohol') return this.alcohol;
    if (field === 'bowel') return this.bowel;
    if (field === 'mood') return this.mood;
    if (field === 'vision') return this.vision;
    if (field === 'hearing') return this.hearing;
    return '';
  }

  private applyField(field: string, value: string): void {
    if (field === 'ageText') this.ageText = value;
    else if (field === 'medicalHistory') this.medicalHistory = value;
    else if (field === 'medications') this.medications = value;
    else if (field === 'heightText') this.heightText = value;
    else if (field === 'weightText') this.weightText = value;
    else if (field === 'systolicText') this.systolicText = value;
    else if (field === 'diastolicText') this.diastolicText = value;
    else if (field === 'glucoseText') this.glucoseText = value;
    else if (field === 'sleepHoursText') this.sleepHoursText = value;
    else if (field === 'nightAwakeningsText') this.nightAwakeningsText = value;
    else if (field === 'dietRestrictions') this.dietRestrictions = value;
    else if (field === 'exerciseTimesText') this.exerciseTimesText = value;
    else if (field === 'exerciseTypes') this.exerciseTypes = value;
    else if (field === 'smoking') this.smoking = value;
    else if (field === 'alcohol') this.alcohol = value;
    else if (field === 'bowel') this.bowel = value;
    else if (field === 'mood') this.mood = value;
    else if (field === 'vision') this.vision = value;
    else if (field === 'hearing') this.hearing = value;
    this.clearFieldError(field);
    this.formMessage = '';
  }

  private errorFor(field: string): string {
    for (let i = 0; i < this.fieldErrors.length; i++) {
      if (this.fieldErrors[i].field === field ||
        (field === 'systolicText' && this.fieldErrors[i].field === 'restingBloodPressure') ||
        (field === 'diastolicText' && this.fieldErrors[i].field === 'restingBloodPressure')) {
        return this.fieldErrors[i].message;
      }
    }
    return '';
  }

  private clearFieldError(field: string): void {
    if (this.fieldErrors.length === 0) {
      return;
    }
    const kept: HealthFieldError[] = [];
    for (let i = 0; i < this.fieldErrors.length; i++) {
      const item: HealthFieldError = this.fieldErrors[i];
      if (item.field !== field) {
        kept.push(item);
      }
    }
    this.fieldErrors = kept;
  }

  // --------------------------------------------------------- 表单 ↔ 状态

  private buildForm(): HealthFormState {
    const state = new HealthFormState();
    state.ageText = this.ageText;
    state.medicalHistory = this.medicalHistory;
    state.medications = this.medications;
    state.heightText = this.heightText;
    state.weightText = this.weightText;
    state.systolicText = this.systolicText;
    state.diastolicText = this.diastolicText;
    state.glucoseText = this.glucoseText;
    state.sleepHoursText = this.sleepHoursText;
    state.sleepDifficulty = this.sleepDifficulty;
    state.nightAwakeningsText = this.nightAwakeningsText;
    state.dietRegular = this.dietRegular;
    state.dietTaste = this.dietTaste;
    state.dietRestrictions = this.dietRestrictions;
    state.exerciseTimesText = this.exerciseTimesText;
    state.exerciseTypes = this.exerciseTypes;
    state.smoking = this.smoking;
    state.alcohol = this.alcohol;
    state.bowel = this.bowel;
    state.mood = this.mood;
    state.vision = this.vision;
    state.hearing = this.hearing;
    return state;
  }

  private applyProfileToForm(view: HealthProfileView): void {
    const form: HealthFormState = healthFormFromView(view);
    this.ageText = form.ageText;
    this.medicalHistory = form.medicalHistory;
    this.medications = form.medications;
    this.heightText = form.heightText;
    this.weightText = form.weightText;
    this.systolicText = form.systolicText;
    this.diastolicText = form.diastolicText;
    this.glucoseText = form.glucoseText;
    this.sleepHoursText = form.sleepHoursText;
    this.sleepDifficulty = form.sleepDifficulty;
    this.nightAwakeningsText = form.nightAwakeningsText;
    this.dietRegular = form.dietRegular;
    this.dietTaste = form.dietTaste;
    this.dietRestrictions = form.dietRestrictions;
    this.exerciseTimesText = form.exerciseTimesText;
    this.exerciseTypes = form.exerciseTypes;
    this.smoking = form.smoking;
    this.alcohol = form.alcohol;
    this.bowel = form.bowel;
    this.mood = form.mood;
    this.vision = form.vision;
    this.hearing = form.hearing;
  }

  private clearForm(): void {
    this.applyProfileToForm(new HealthProfileView());
  }

  private ternaryOptions(): TernaryOption[] {
    const items: TernaryOption[] = [];
    const unset = new TernaryOption();
    unset.key = HealthTernary.UNSET;
    unset.label = '未填写';
    items.push(unset);
    const yes = new TernaryOption();
    yes.key = HealthTernary.YES;
    yes.label = '是';
    items.push(yes);
    const no = new TernaryOption();
    no.key = HealthTernary.NO;
    no.label = '否';
    items.push(no);
    return items;
  }

  private tasteOptions(): TasteOption[] {
    const items: TasteOption[] = [];
    const unset = new TasteOption();
    unset.key = '';
    unset.label = '未填写';
    items.push(unset);
    const light = new TasteOption();
    light.key = HealthTaste.LIGHT;
    light.label = '清淡';
    items.push(light);
    const normal = new TasteOption();
    normal.key = HealthTaste.NORMAL;
    normal.label = '一般';
    items.push(normal);
    const salty = new TasteOption();
    salty.key = HealthTaste.SALTY;
    salty.label = '偏咸';
    items.push(salty);
    return items;
  }

  private ternaryValue(field: string): string {
    if (field === 'sleepDifficulty') return this.sleepDifficulty;
    if (field === 'dietRegular') return this.dietRegular;
    return HealthTernary.UNSET;
  }

  private setTernary(field: string, key: string): void {
    if (field === 'sleepDifficulty') this.sleepDifficulty = key;
    else if (field === 'dietRegular') this.dietRegular = key;
    this.clearFieldError(field);
    this.formMessage = '';
  }

  private setTaste(key: string): void {
    this.dietTaste = key;
    this.clearFieldError('dietTaste');
    this.formMessage = '';
  }

  // --------------------------------------------------------------- 状态

  /** 急症词命中：仅提示立即就医，不改变保存/生成行为。 */
  private acuteVisible(): boolean {
    const form: HealthFormState = this.buildForm();
    return hasAcuteSymptomText(healthFormFreeText(form));
  }

  private profileErrorVisible(): boolean {
    if (this.loadingProfile) return false;
    return (this.healthStatus === HealthProfileStatus.ERROR ||
      this.healthStatus === HealthProfileStatus.UNAUTHORIZED) && this.healthMessage.length > 0;
  }

  private adviceFailedVisible(): boolean {
    if (this.generating) return false;
    return this.adviceStatus === HealthAdviceFlowState.TIMEOUT ||
      this.adviceStatus === HealthAdviceFlowState.FAILED ||
      this.adviceStatus === HealthAdviceFlowState.NOT_CONFIGURED ||
      this.adviceStatus === HealthAdviceFlowState.EMPTY ||
      this.adviceStatus === HealthAdviceFlowState.UNAUTHORIZED ||
      this.adviceStatus === HealthAdviceFlowState.DEMO;
  }

  private adviceFailedText(): string {
    if (this.adviceMessage.length > 0) {
      return this.adviceMessage;
    }
    return healthAdviceMessage(this.adviceStatus);
  }

  private generatingVisible(): boolean {
    return this.generating || this.adviceStatus === HealthAdviceFlowState.LOADING;
  }

  private canRetryAdvice(): boolean {
    const s: string = this.adviceStatus;
    return s === HealthAdviceFlowState.TIMEOUT || s === HealthAdviceFlowState.FAILED ||
      s === HealthAdviceFlowState.NOT_CONFIGURED;
  }

  // --------------------------------------------------------------- 动作

  /** 没有云端健康档案时，从本机“守护对象资料”带入已知健康字段。 */
  private applyLocalElderFallback(): void {
    const e = AppStorage.get<Elder>('gv.elderOverride');
    if (e === undefined) return;
    if (this.ageText.length === 0 && e.age > 0) this.ageText = `${e.age}`;
    if (this.medicalHistory.length === 0) this.medicalHistory = e.medicalHistory;
    if (this.medications.length === 0) this.medications = e.medications;
    if (this.heightText.length === 0 && e.heightCm > 0) this.heightText = `${e.heightCm}`;
    if (this.weightText.length === 0 && e.weightKg > 0) this.weightText = `${e.weightKg}`;
    if (this.systolicText.length === 0 && e.systolic > 0) this.systolicText = `${e.systolic}`;
    if (this.diastolicText.length === 0 && e.diastolic > 0) this.diastolicText = `${e.diastolic}`;
    if (this.glucoseText.length === 0 && e.fastingGlucose > 0) this.glucoseText = `${e.fastingGlucose}`;
  }

  private async loadProfile(): Promise<void> {
    if (this.disposed || this.isDemo()) {
      this.loadingProfile = false;
      return;
    }
    this.loadingProfile = true;
    try {
      const outcome: HealthProfileOutcome = await GuardianService.loadHealthProfile();
      if (this.disposed) return;
      if (outcome.stale) return;
      if (outcome.ok && outcome.present && outcome.view !== null) {
        this.applyProfileToForm(outcome.view);
        this.fieldErrors = [];
        this.formMessage = '';
      } else if (outcome.ok && !outcome.present) {
        this.clearForm();
        this.applyLocalElderFallback();
      }
    } catch (err) {
      if (!this.disposed) {
        this.applyLocalElderFallback();
        this.formMessage = '健康资料加载失败，请稍后重试';
      }
    } finally {
      if (!this.disposed) {
        this.loadingProfile = false;
      }
    }
  }

  private onNext(): void {
    const result: HealthValidationResult = validateHealthForm(this.buildForm());
    const basicErrors: HealthFieldError[] = [];
    for (let i = 0; i < result.fields.length; i++) {
      const item: HealthFieldError = result.fields[i];
      if (item.field === 'form' || this.isBasicField(item.field)) {
        basicErrors.push(item);
      }
    }
    // 空表单允许先进入第 2 页填写（保存时统一拦截“至少填写一项”）。
    if (basicErrors.length > 0 && basicErrors.length !== result.fields.length) {
      // 有基础字段错误：留在第 1 页并高亮。
      this.fieldErrors = basicErrors;
      this.formMessage = basicErrors[0].message;
      this.step = FormStep.BASIC;
      return;
    }
    if (basicErrors.length > 0 && this.anyBasicFieldFilled()) {
      this.fieldErrors = basicErrors;
      this.formMessage = basicErrors[0].message;
      this.step = FormStep.BASIC;
      return;
    }
    this.fieldErrors = [];
    this.formMessage = '';
    this.step = FormStep.HABIT;
  }

  private anyBasicFieldFilled(): boolean {
    return this.ageText.trim().length > 0 || this.medicalHistory.trim().length > 0 ||
      this.medications.trim().length > 0 || this.heightText.trim().length > 0 ||
      this.weightText.trim().length > 0 || this.systolicText.trim().length > 0 ||
      this.diastolicText.trim().length > 0 || this.glucoseText.trim().length > 0;
  }

  private onPrev(): void {
    this.step = FormStep.BASIC;
  }

  private async onSave(): Promise<void> {
    if (this.saving || this.generating || this.isDemo()) {
      return;
    }
    const form: HealthFormState = this.buildForm();
    const result: HealthValidationResult = validateHealthForm(form);
    if (!result.ok) {
      this.fieldErrors = result.fields;
      this.formMessage = result.messageText();
      const basicFirst: boolean = this.isBasicField(result.firstFocus) || result.firstFocus === 'form';
      this.step = basicFirst ? FormStep.BASIC : FormStep.HABIT;
      this.toast(this.formMessage);
      return;
    }
    this.saving = true;
    this.formMessage = '';
    try {
      const outcome: HealthProfileOutcome = await GuardianService.saveHealthProfile(form.toProfileBody());
      if (this.disposed || outcome.stale) return;
      if (!outcome.ok) {
        this.formMessage = outcome.message;
        this.toast(outcome.message);
        return;
      }
      if (outcome.view !== null) {
        this.applyProfileToForm(outcome.view);
      }
      this.fieldErrors = [];
      this.formMessage = '';
      this.toast(HEALTH_SAVE_OK_MESSAGE);
    } catch (err) {
      if (!this.disposed) {
        this.formMessage = '健康资料保存失败，请稍后重试';
        this.toast(this.formMessage);
      }
    } finally {
      if (!this.disposed) {
        this.saving = false;
      }
    }
  }

  /** 首次生成前明确告知“健康资料会发送给第三方 AI”，取得同意后才发起请求。 */
  private requestAiConsent(): void {
    this.getUIContext().getPromptAction().showDialog({
      title: '健康资料将发送给第三方 AI',
      message: HEALTH_THIRD_PARTY_NOTICE,
      buttons: [
        { text: '取消', color: Color.textSecondary },
        { text: '同意并生成', color: Color.primaryDark }
      ]
    }).then((result) => {
      if (result.index === 1 && !this.disposed) {
        this.aiConsentGiven = true;
        void this.onGenerate();
      }
    }).catch(() => { });
  }

  private async onGenerate(): Promise<void> {
    if (this.saving || this.generating || this.isDemo()) {
      return;
    }
    if (!this.aiConsentGiven) {
      // 未同意前不发送任何健康资料。
      this.requestAiConsent();
      return;
    }
    this.generating = true;
    try {
      const outcome: HealthAdviceOutcome = await GuardianService.generateHealthAdvice();
      if (this.disposed || outcome.stale) return;
      if (outcome.ok && outcome.view !== null) {
        this.screen = HealthScreen.RESULT;
      } else {
        // 失败：保留表单，显示明确失败状态与重试按钮，绝不展示伪造建议。
        this.screen = HealthScreen.FORM;
        const message: string = outcome.message.length > 0
          ? outcome.message : healthAdviceMessage(outcome.status);
        if (message.length > 0) {
          this.toast(message);
        }
      }
    } catch (err) {
      if (!this.disposed) {
        this.toast('暂时无法生成建议，请稍后重试');
      }
    } finally {
      if (!this.disposed) {
        this.generating = false;
      }
    }
  }

  private onEditProfile(): void {
    this.screen = HealthScreen.FORM;
    this.step = FormStep.BASIC;
    this.applyProfileToForm(this.profile);
    this.fieldErrors = [];
    this.formMessage = '';
  }

  // ------------------------------------------------------------- fields

  private page1Fields(): FormFieldConfig[] {
    const items: FormFieldConfig[] = [];
    const age = new FormFieldConfig();
    age.field = 'ageText';
    age.label = '年龄';
    age.placeholder = '例如 72';
    age.hint = '1–130 的整数';
    age.integer = true;
    age.maxLength = 3;
    items.push(age);
    const history = new FormFieldConfig();
    history.field = 'medicalHistory';
    history.label = '既往病史';
    history.placeholder = '例如 高血压（可不填）';
    history.hint = '最多 500 字';
    history.multiline = true;
    history.maxLength = 500;
    items.push(history);
    const medications = new FormFieldConfig();
    medications.field = 'medications';
    medications.label = '长期用药';
    medications.placeholder = '例如 氨氯地平（可不填）';
    medications.hint = '只记录药名，不写剂量调整';
    medications.multiline = true;
    medications.maxLength = 500;
    items.push(medications);
    const height = new FormFieldConfig();
    height.field = 'heightText';
    height.label = '身高';
    height.placeholder = '例如 165';
    height.hint = '50–250 cm，最多 1 位小数';
    height.maxLength = 6;
    items.push(height);
    const weight = new FormFieldConfig();
    weight.field = 'weightText';
    weight.label = '体重';
    weight.placeholder = '例如 62';
    weight.hint = '20–300 kg，最多 1 位小数';
    weight.maxLength = 6;
    items.push(weight);
    const systolic = new FormFieldConfig();
    systolic.field = 'systolicText';
    systolic.label = '静息血压（收缩压）';
    systolic.placeholder = '例如 135';
    systolic.hint = '60–260 的整数';
    systolic.integer = true;
    systolic.maxLength = 3;
    items.push(systolic);
    const diastolic = new FormFieldConfig();
    diastolic.field = 'diastolicText';
    diastolic.label = '静息血压（舒张压）';
    diastolic.placeholder = '例如 82';
    diastolic.hint = '40–160 且需小于收缩压';
    diastolic.integer = true;
    diastolic.maxLength = 3;
    items.push(diastolic);
    const glucose = new FormFieldConfig();
    glucose.field = 'glucoseText';
    glucose.label = '空腹血糖';
    glucose.placeholder = '例如 6.1';
    glucose.hint = '1.0–40.0，最多 1 位小数';
    glucose.maxLength = 5;
    items.push(glucose);
    return items;
  }

  private page2Fields(): FormFieldConfig[] {
    const items: FormFieldConfig[] = [];
    const sleepHours = new FormFieldConfig();
    sleepHours.field = 'sleepHoursText';
    sleepHours.label = '睡眠时长';
    sleepHours.placeholder = '例如 7';
    sleepHours.hint = '0–24 小时，最多 1 位小数';
    sleepHours.maxLength = 4;
    items.push(sleepHours);
    const awakenings = new FormFieldConfig();
    awakenings.field = 'nightAwakeningsText';
    awakenings.label = '夜间醒来次数';
    awakenings.placeholder = '例如 1';
    awakenings.hint = '0–20 的整数';
    awakenings.integer = true;
    awakenings.maxLength = 2;
    items.push(awakenings);
    const restrictions = new FormFieldConfig();
    restrictions.field = 'dietRestrictions';
    restrictions.label = '饮食忌口';
    restrictions.placeholder = '例如 少油（可不填）';
    restrictions.hint = '最多 200 字';
    restrictions.maxLength = 200;
    items.push(restrictions);
    const times = new FormFieldConfig();
    times.field = 'exerciseTimesText';
    times.label = '每周运动次数';
    times.placeholder = '例如 4';
    times.hint = '0–21 的整数';
    times.integer = true;
    times.maxLength = 2;
    items.push(times);
    const types = new FormFieldConfig();
    types.field = 'exerciseTypes';
    types.label = '运动类型';
    types.placeholder = '例如 散步、太极（可不填）';
    types.hint = '最多 100 字';
    types.maxLength = 100;
    items.push(types);
    return items;
  }

  private otherFields(): FormFieldConfig[] {
    const items: FormFieldConfig[] = [];
    const smoking = new FormFieldConfig();
    smoking.field = 'smoking';
    smoking.label = '吸烟情况';
    smoking.placeholder = '例如 不吸烟';
    smoking.hint = '最多 100 字';
    smoking.maxLength = 100;
    items.push(smoking);
    const alcohol = new FormFieldConfig();
    alcohol.field = 'alcohol';
    alcohol.label = '饮酒情况';
    alcohol.placeholder = '例如 偶尔';
    alcohol.hint = '最多 100 字';
    alcohol.maxLength = 100;
    items.push(alcohol);
    const bowel = new FormFieldConfig();
    bowel.field = 'bowel';
    bowel.label = '排便情况';
    bowel.placeholder = '例如 正常';
    bowel.hint = '最多 100 字';
    bowel.maxLength = 100;
    items.push(bowel);
    const mood = new FormFieldConfig();
    mood.field = 'mood';
    mood.label = '情绪状态';
    mood.placeholder = '例如 平稳';
    mood.hint = '最多 200 字';
    mood.maxLength = 200;
    items.push(mood);
    const vision = new FormFieldConfig();
    vision.field = 'vision';
    vision.label = '视力情况';
    vision.placeholder = '例如 尚可';
    vision.hint = '最多 100 字';
    vision.maxLength = 100;
    items.push(vision);
    const hearing = new FormFieldConfig();
    hearing.field = 'hearing';
    hearing.label = '听力情况';
    hearing.placeholder = '例如 需大声';
    hearing.hint = '最多 100 字';
    hearing.maxLength = 100;
    items.push(hearing);
    return items;
  }

  // ------------------------------------------------------------ builders

  @Builder
  noticeCard(icon: Resource, text: string, color: string, background: string) {
    Row() {
      SymbolGlyph(icon)
        .fontSize(14)
        .fontColor([color])
      Text(text)
        .fontSize(FontSize.caption)
        .fontColor(color)
        .margin({ left: 6 })
        .layoutWeight(1)
        .maxLines(4)
    }
    .width('100%')
    .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
    .backgroundColor(background)
    .borderRadius(Radius.chip)
    .alignItems(VerticalAlign.Top)
  }

  /** 顶部固定两条提示：隐私提示 + 免责声明（始终展示）。 */
  @Builder
  topNotices() {
    Column() {
      this.noticeCard($r('sys.symbol.info_circle'), HEALTH_PRIVACY_NOTICE, Color.primaryDark,
        Color.primaryLight)
      Column().height(Space.sm)
      this.noticeCard($r('sys.symbol.doc_text'), HEALTH_DISCLAIMER_APP, '#92400E', '#FFFBEB')
      Column().height(Space.sm)
      // 第三方 AI 告知：生成前还会再弹窗取得一次明确同意。
      this.noticeCard($r('sys.symbol.info_circle'), HEALTH_THIRD_PARTY_NOTICE, '#1D4ED8', '#EFF6FF')
    }
    .width('100%')
    .margin({ left: this.pm(), right: this.pm(), top: Space.md })
  }

  @Builder
  demoNotice() {
    Column() {
      Row() {
        SymbolGlyph($r('sys.symbol.exclamationmark_triangle_fill'))
          .fontSize(16)
          .fontColor([Color.warningDark])
        Text('演示模式')
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.warningDark)
          .margin({ left: 6 })
      }
      .width('100%')
      Text('演示模式不调用网络，健康评估不可用。请退出演示后使用真实账号登录。')
        .fontSize(FontSize.caption)
        .fontColor(Color.textSecondary)
        .margin({ top: Space.xs })
        .width('100%')
    }
    .width('100%')
    .padding(Space.md + 2)
    .backgroundColor(Color.warningLight)
    .borderRadius(Radius.card)
    .margin({ left: this.pm(), right: this.pm(), top: Space.md })
  }

  @Builder
  stateBanner(icon: Resource, text: string, color: string, background: string, showRetry: boolean) {
    Row() {
      SymbolGlyph(icon)
        .fontSize(14)
        .fontColor([color])
      Text(text)
        .fontSize(FontSize.caption)
        .fontColor(color)
        .margin({ left: 6 })
        .layoutWeight(1)
        .maxLines(4)
      if (showRetry) {
        Text('重试')
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.primaryDark)
          .padding({ left: 10, right: 10, top: 4, bottom: 4 })
          .backgroundColor('#FFFFFF')
          .borderRadius(Radius.pill)
          .onClick(() => { void this.loadProfile(); })
      }
    }
    .width('100%')
    .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
    .backgroundColor(background)
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
      Text('正在加载健康资料…')
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
  acuteBanner() {
    Row() {
      SymbolGlyph($r('sys.symbol.exclamationmark_triangle_fill'))
        .fontSize(15)
        .fontColor([Color.warningDark])
      Text(HEALTH_ACUTE_NOTICE)
        .fontSize(FontSize.caption)
        .fontWeight(FontWeight_.semibold)
        .fontColor(Color.warningDark)
        .margin({ left: 6 })
        .layoutWeight(1)
        .maxLines(3)
    }
    .width('100%')
    .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
    .backgroundColor(Color.warningLight)
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
  savedProfileCard() {
    Column() {
      Row() {
        SymbolGlyph($r('sys.symbol.checkmark_circle'))
          .fontSize(15)
          .fontColor([Color.successDark])
        Text('已保存的健康资料')
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
          .margin({ left: 6 })
        Blank()
        if (this.profile.updatedAtText.length > 0) {
          Text(this.profile.updatedAtText)
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
        }
      }
      .width('100%')

      if (this.profile.basicLines.length > 0) {
        Column() {
          ForEach(this.profile.basicLines, (line: string) => {
            Text(line)
              .fontSize(FontSize.body)
              .fontColor(Color.textSecondary)
              .margin({ top: 3 })
              .width('100%')
          }, (line: string, index: number) => `basic-${index}`)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .margin({ top: Space.sm })
      }
      if (this.profile.habitLines.length > 0) {
        Column() {
          ForEach(this.profile.habitLines, (line: string) => {
            Text(line)
              .fontSize(FontSize.body)
              .fontColor(Color.textSecondary)
              .margin({ top: 3 })
              .width('100%')
          }, (line: string, index: number) => `habit-${index}`)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .margin({ top: Space.xs })
      }

      Row() {
        SecondaryButton({
          label: '修改资料',
          icon: $r('sys.symbol.doc_text'),
          color: Color.primaryDark,
          onClick_: () => { this.onEditProfile(); }
        })
      }
      .width('100%')
      .margin({ top: Space.md })
    }
    .width('100%')
    .padding(Space.md + 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
  }

  /** 按 field 键取字段配置（供两页表单复用同一套输入样式）。 */
  private fieldByKey(key: string): FormFieldConfig {
    const all: FormFieldConfig[] = [];
    const basic: FormFieldConfig[] = this.page1Fields();
    for (let i = 0; i < basic.length; i++) all.push(basic[i]);
    const habit: FormFieldConfig[] = this.page2Fields();
    for (let i = 0; i < habit.length; i++) all.push(habit[i]);
    const other: FormFieldConfig[] = this.otherFields();
    for (let i = 0; i < other.length; i++) all.push(other[i]);
    for (let i = 0; i < all.length; i++) {
      if (all[i].field === key) {
        return all[i];
      }
    }
    return new FormFieldConfig();
  }

  @Builder
  textFieldBlock(item: FormFieldConfig) {
    Column() {
      Row() {
        Text(item.label)
          .fontSize(FontSize.body + 0.5)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textPrimary)
        if (item.hint.length > 0) {
          Text(item.hint)
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ left: 5 })
        }
      }
      .width('100%')
      .margin({ bottom: 5 })

      if (item.multiline) {
        TextArea({ placeholder: item.placeholder, text: this.fieldValue(item.field) })
          .maxLength(item.maxLength)
          .fontSize(FontSize.body + 1)
          .fontColor(Color.textPrimary)
          .height(72)
          .width('100%')
          .backgroundColor('#FFFFFF')
          .borderRadius(Radius.chip)
          .border({ width: 1.5, color: this.errorFor(item.field).length > 0 ? Color.critical : Color.border })
          .onChange((v: string) => { this.applyField(item.field, v); })
      } else {
        TextInput({ placeholder: item.placeholder, text: this.fieldValue(item.field) })
          .type(item.integer ? InputType.Number : InputType.Normal)
          .maxLength(item.maxLength)
          .fontSize(FontSize.body + 1)
          .fontColor(Color.textPrimary)
          .height(44)
          .width('100%')
          .backgroundColor('#FFFFFF')
          .borderRadius(Radius.chip)
          .border({ width: 1.5, color: this.errorFor(item.field).length > 0 ? Color.critical : Color.border })
          .onChange((v: string) => { this.applyField(item.field, v); })
      }

      if (this.errorFor(item.field).length > 0) {
        Text(this.errorFor(item.field))
          .fontSize(FontSize.mini)
          .fontColor(Color.criticalDark)
          .margin({ top: 3 })
          .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ bottom: Space.md })
  }

  @Builder
  ternaryChip(label: string, selected: boolean, field: string, key: string) {
    Text(label)
      .fontSize(FontSize.body)
      .fontWeight(selected ? FontWeight_.bold : FontWeight_.regular)
      .fontColor(selected ? '#FFFFFF' : Color.textSecondary)
      .height(34)
      .padding({ left: 14, right: 14 })
      .textAlign(TextAlign.Center)
      .borderRadius(Radius.pill)
      .linearGradient(selected
        ? Grad.primary()
        : { angle: 135, colors: [[Color.card, 0.0], [Color.card, 1.0]] })
      .border({ width: 1, color: selected ? 'rgba(0,0,0,0)' : Color.border })
      .onClick(() => { this.setTernary(field, key); })
  }

  @Builder
  tasteChip(label: string, selected: boolean, key: string) {
    Text(label)
      .fontSize(FontSize.body)
      .fontWeight(selected ? FontWeight_.bold : FontWeight_.regular)
      .fontColor(selected ? '#FFFFFF' : Color.textSecondary)
      .height(34)
      .padding({ left: 14, right: 14 })
      .textAlign(TextAlign.Center)
      .borderRadius(Radius.pill)
      .linearGradient(selected
        ? Grad.primary()
        : { angle: 135, colors: [[Color.card, 0.0], [Color.card, 1.0]] })
      .border({ width: 1, color: selected ? 'rgba(0,0,0,0)' : Color.border })
      .onClick(() => { this.setTaste(key); })
  }

  @Builder
  ternaryBlock(field: string, label: string) {
    Column() {
      Text(label)
        .fontSize(FontSize.body + 0.5)
        .fontWeight(FontWeight_.semibold)
        .fontColor(Color.textPrimary)
        .width('100%')
        .margin({ bottom: 5 })
      Row() {
        ForEach(this.ternaryOptions(), (item: TernaryOption) => {
          this.ternaryChip(item.label, this.ternaryValue(field) === item.key, field, item.key)
        }, (item: TernaryOption) => `${field}-${item.key}`)
      }
      .width('100%')
      if (this.errorFor(field).length > 0) {
        Text(this.errorFor(field))
          .fontSize(FontSize.mini)
          .fontColor(Color.criticalDark)
          .margin({ top: 3 })
          .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ bottom: Space.md })
  }

  @Builder
  tasteBlock() {
    Column() {
      Row() {
        Text('饮食口味')
          .fontSize(FontSize.body + 0.5)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textPrimary)
        Text('清淡 / 一般 / 偏咸')
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ left: 5 })
      }
      .width('100%')
      .margin({ bottom: 5 })
      Row() {
        ForEach(this.tasteOptions(), (item: TasteOption) => {
          this.tasteChip(item.label, this.dietTaste === item.key, item.key)
        }, (item: TasteOption) => `taste-${item.key}`)
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ bottom: Space.md })
  }

  @Builder
  stepHeader() {
    Row() {
      Text(this.step === FormStep.BASIC ? '第 1 步 / 共 2 步 · 基础健康信息'
        : '第 2 步 / 共 2 步 · 生活习惯')
        .fontSize(FontSize.h3)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
        .layoutWeight(1)
      Text(this.step === FormStep.BASIC ? '1 / 2' : '2 / 2')
        .fontSize(FontSize.caption)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.primaryDark)
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .backgroundColor(Color.primaryLight)
        .borderRadius(Radius.pill)
    }
    .width('100%')
    .margin({ bottom: Space.md })
  }

  @Builder
  basicStep() {
    Column() {
      this.sectionTitle('基础健康信息', '年龄 / 病史 / 用药 / 身高体重 / 血压 / 血糖')
      ForEach(this.page1Fields(), (item: FormFieldConfig) => {
        this.textFieldBlock(item)
      }, (item: FormFieldConfig) => item.field)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  habitStep() {
    Column() {
      this.sectionTitle('睡眠', '资料不足时建议里会写“信息不足”，不会猜测')
      this.textFieldBlock(this.fieldByKey('sleepHoursText'))
      this.ternaryBlock('sleepDifficulty', '入睡困难')
      this.textFieldBlock(this.fieldByKey('nightAwakeningsText'))

      this.sectionTitle('饮食', '')
      this.ternaryBlock('dietRegular', '饮食是否规律')
      this.tasteBlock()
      this.textFieldBlock(this.fieldByKey('dietRestrictions'))

      this.sectionTitle('运动', '')
      this.textFieldBlock(this.fieldByKey('exerciseTimesText'))
      this.textFieldBlock(this.fieldByKey('exerciseTypes'))

      this.sectionTitle('其他生活习惯', '')
      this.textFieldBlock(this.fieldByKey('smoking'))
      this.textFieldBlock(this.fieldByKey('alcohol'))
      this.textFieldBlock(this.fieldByKey('bowel'))
      this.textFieldBlock(this.fieldByKey('mood'))
      this.textFieldBlock(this.fieldByKey('vision'))
      this.textFieldBlock(this.fieldByKey('hearing'))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  formPanel() {
    Column() {
      if (this.profile.present) {
        this.savedProfileCard()
      }
      if (this.acuteVisible()) {
        this.acuteBanner()
      }
      Column() {
        this.stepHeader()
        if (this.step === FormStep.BASIC) {
          this.basicStep()
        } else {
          this.habitStep()
        }

        if (this.formMessage.length > 0) {
          Row() {
            SymbolGlyph($r('sys.symbol.exclamationmark_circle'))
              .fontSize(13)
              .fontColor([Color.criticalDark])
            Text(this.formMessage)
              .fontSize(FontSize.caption)
              .fontColor(Color.criticalDark)
              .margin({ left: 5 })
              .layoutWeight(1)
              .maxLines(3)
          }
          .width('100%')
          .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
          .backgroundColor(Color.criticalLight)
          .borderRadius(Radius.chip)
          .margin({ bottom: Space.md })
        }

        if (this.step === FormStep.BASIC) {
          Row() {
            PrimaryButton({
              label: '下一步',
              icon: $r('sys.symbol.chevron_right'),
              onClick_: () => { this.onNext(); }
            })
          }
          .width('100%')
        } else {
          Row() {
            SecondaryButton({
              label: '上一步',
              icon: $r('sys.symbol.chevron_left'),
              color: Color.textSecondary,
              onClick_: () => { this.onPrev(); }
            })
          }
          .width('100%')
          .margin({ bottom: Space.md })

          Row() {
            PrimaryButton({
              label: this.saving ? '正在保存健康资料…' : '保存资料',
              icon: $r('sys.symbol.checkmark_circle'),
              loading: this.saving,
              disabled: this.saving || this.generating,
              onClick_: () => { void this.onSave(); }
            })
          }
          .width('100%')

          if (this.profile.present || this.healthStatus === HealthProfileStatus.OK) {
            Row() {
              PrimaryButton({
                label: this.generating ? HEALTH_GENERATING_MESSAGE : '生成健康建议',
                icon: $r('sys.symbol.doc_text'),
                loading: this.generating,
                disabled: this.saving || this.generating,
                variant: 'success',
                onClick_: () => { void this.onGenerate(); }
              })
            }
            .width('100%')
            .margin({ top: Space.md })
          }
        }
      }
      .width('100%')
      .padding(Space.md + 2)
      .backgroundColor(Color.card)
      .borderRadius(Radius.card)
      .shadow(Shadow_.card())
      .alignItems(HorizontalAlign.Start)
      .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  adviceSectionCard(section: HealthAdviceSection) {
    Column() {
      Row() {
        Column()
          .width(3)
          .height(13)
          .borderRadius(2)
          .linearGradient(section.key === 'warningSigns' ? Grad.warning() : Grad.primary())
          .margin({ right: 7 })
        Text(section.title)
          .fontSize(FontSize.h3)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
      }
      .alignItems(VerticalAlign.Center)
      if (section.note.length > 0) {
        Text(section.note)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ top: 2, left: 10 })
          .width('100%')
      }
      ForEach(section.items, (line: string, index: number) => {
        Row() {
          Column()
            .width(5)
            .height(5)
            .borderRadius(3)
            .backgroundColor(section.key === 'warningSigns' ? Color.warningDark : Color.primaryDark)
            .margin({ top: 7, right: 7 })
          Text(line)
            .fontSize(FontSize.body + 0.5)
            .fontColor(Color.textSecondary)
            .layoutWeight(1)
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)
        .margin({ top: 6 })
      }, (line: string, index: number) => `${section.key}-${index}`)
    }
    .width('100%')
    .padding(Space.md + 2)
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow(Shadow_.card())
    .alignItems(HorizontalAlign.Start)
    .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
  }

  @Builder
  resultPanel() {
    Column() {
      Column() {
        Row() {
          SymbolGlyph($r('sys.symbol.doc_text'))
            .fontSize(18)
            .fontColor([Color.successDark])
          Column() {
            Text('健康科普建议')
              .fontSize(FontSize.h2)
              .fontWeight(FontWeight_.bold)
              .fontColor(Color.textPrimary)
            Text(this.advice.generatedAtText.length > 0
              ? `生成时间：${this.advice.generatedAtText}`
              : '生成时间：未知')
              .fontSize(FontSize.mini)
              .fontColor(Color.textTertiary)
              .margin({ top: 2 })
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
          .margin({ left: Space.sm })
        }
        .width('100%')
      }
      .width('100%')
      .padding(Space.md + 2)
      .backgroundColor(Color.card)
      .borderRadius(Radius.card)
      .shadow(Shadow_.card())
      .alignItems(HorizontalAlign.Start)
      .margin({ left: this.pm(), right: this.pm(), top: Space.sm })

      ForEach(this.advice.sections(), (section: HealthAdviceSection) => {
        this.adviceSectionCard(section)
      }, (section: HealthAdviceSection) => section.key)

      Row() {
        SymbolGlyph($r('sys.symbol.info_circle'))
          .fontSize(13)
          .fontColor([Color.textSecondary])
        Text(this.advice.disclaimer)
          .fontSize(FontSize.caption)
          .fontColor(Color.textSecondary)
          .margin({ left: 6 })
          .layoutWeight(1)
          .maxLines(4)
      }
      .width('100%')
      .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
      .backgroundColor('#F1F5F9')
      .borderRadius(Radius.chip)
      .margin({ left: this.pm(), right: this.pm(), top: Space.md })
      .alignItems(VerticalAlign.Top)

      if (this.generatingVisible()) {
        Row() {
          LoadingProgress()
            .width(15)
            .height(15)
            .color(Color.primaryDark)
          Text(this.adviceMessage.length > 0 ? this.adviceMessage : HEALTH_GENERATING_MESSAGE)
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

      if (this.adviceFailedVisible()) {
        Row() {
          SymbolGlyph($r('sys.symbol.exclamationmark_circle'))
            .fontSize(14)
            .fontColor([Color.criticalDark])
          Text(this.adviceFailedText())
            .fontSize(FontSize.caption)
            .fontWeight(FontWeight_.semibold)
            .fontColor(Color.criticalDark)
            .margin({ left: 6 })
            .layoutWeight(1)
            .maxLines(4)
        }
        .width('100%')
        .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
        .backgroundColor(Color.criticalLight)
        .borderRadius(Radius.chip)
        .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
      }

      Column() {
        PrimaryButton({
          label: this.generating ? HEALTH_GENERATING_MESSAGE : '重新生成',
          icon: $r('sys.symbol.arrow_clockwise'),
          loading: this.generating,
          disabled: this.generating,
          onClick_: () => { void this.onGenerate(); }
        })
        Row().height(Space.md)
        SecondaryButton({
          label: '修改资料',
          icon: $r('sys.symbol.doc_text'),
          color: Color.primaryDark,
          onClick_: () => { this.onEditProfile(); }
        })
      }
      .width('100%')
      .padding({ left: this.pm(), right: this.pm(), top: Space.md })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  formIntro() {
    Column() {
      if (!this.profile.present) {
        Row() {
          SymbolGlyph($r('sys.symbol.info_circle'))
            .fontSize(14)
            .fontColor([Color.primaryDark])
          Text('还没有健康资料，请填写两步表单后点击“保存资料”。')
            .fontSize(FontSize.caption)
            .fontColor(Color.primaryDark)
            .margin({ left: 6 })
            .layoutWeight(1)
        }
        .width('100%')
        .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
        .backgroundColor(Color.primaryLight)
        .borderRadius(Radius.chip)
        .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
      }
    }
    .width('100%')
  }

  build() {
    Column() {
      NavBar({ title: '健康评估' })
      DemoModeBar()
      Scroll() {
        Column() {
          this.topNotices()
          if (this.isDemo()) {
            this.demoNotice()
          } else if (this.loadingProfile) {
            this.loadingBanner()
          } else {
            if (this.profileErrorVisible()) {
              this.stateBanner($r('sys.symbol.exclamationmark_circle'), this.healthMessage,
                this.healthStatus === HealthProfileStatus.UNAUTHORIZED ? Color.criticalDark
                  : Color.warningDark,
                this.healthStatus === HealthProfileStatus.UNAUTHORIZED ? Color.criticalLight
                  : Color.warningLight,
                true)
            }
            if (this.screen === HealthScreen.RESULT && this.advice.hasAdvice) {
              this.resultPanel()
            } else {
              this.formIntro()
              this.formPanel()
              if (this.adviceFailedVisible() && this.screen === HealthScreen.FORM) {
                Row() {
                  SymbolGlyph($r('sys.symbol.exclamationmark_circle'))
                    .fontSize(14)
                    .fontColor([Color.criticalDark])
                  Text(this.adviceFailedText())
                    .fontSize(FontSize.caption)
                    .fontWeight(FontWeight_.semibold)
                    .fontColor(Color.criticalDark)
                    .margin({ left: 6 })
                    .layoutWeight(1)
                    .maxLines(4)
                  if (this.canRetryAdvice()) {
                    Text('重新生成')
                      .fontSize(FontSize.caption)
                      .fontWeight(FontWeight_.bold)
                      .fontColor(Color.primaryDark)
                      .padding({ left: 10, right: 10, top: 4, bottom: 4 })
                      .backgroundColor('#FFFFFF')
                      .borderRadius(Radius.pill)
                      .onClick(() => { void this.onGenerate(); })
                  }
                }
                .width('100%')
                .padding({ left: Space.md, right: Space.md, top: Space.sm, bottom: Space.sm })
                .backgroundColor(Color.criticalLight)
                .borderRadius(Radius.chip)
                .margin({ left: this.pm(), right: this.pm(), top: Space.sm })
                .alignItems(VerticalAlign.Top)
              }
            }
          }
          Column().height(56)
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
