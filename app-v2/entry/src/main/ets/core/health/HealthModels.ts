/**
 * 健康科普评估：表单状态 / DTO / 校验 / 固定文案（纯逻辑，Node 测试直接执行）。
 *
 * 唯一事实来源：`competition/docs/AI-HEALTH-ASSESSMENT-SPEC.md` §1 / §5.1。
 *
 * 定性（必须始终遵守）：
 * - 本功能只提供健康科普与生活方式参考，**不诊断疾病、不开药、不提供医疗处置指导**；
 * - 校验规则与后端 §1 完全一致（年龄/身高/体重/血压/血糖/文本长度），APP 侧只做前置提示，
 *   服务端仍是唯一权威；
 * - `updatedAt` 只能由服务端写入，本模块产出的请求体绝不包含它；
 * - 字符串先 trim；trim 后为空 = 未填写，不写入请求体（绝不发 `""`）；
 * - 数值 0 是合法值，未填写用 null 表示，二者严格区分。
 */
import { asBoolean, asFiniteNumber, asObject, asString, hasOwn, isRecord } from '../util/Json';

// ------------------------------------------------------------- 固定文案

/** APP 页脚固定免责声明（§5.1 常量）。 */
export const HEALTH_DISCLAIMER_APP: string =
  '本功能仅提供健康科普参考，不构成医疗诊断或治疗建议。';

/** 页面顶部固定隐私提示（§5.1 常量）。 */
export const HEALTH_PRIVACY_NOTICE: string =
  '请勿填写身份证号、手机号、详细住址或其他不必要的身份信息。';

/** 建议结果固定免责声明（与后端 §2.3 完全一致）。 */
export const HEALTH_ADVICE_DISCLAIMER: string =
  '本内容仅健康科普参考，不构成医疗诊断、治疗或用药建议；如有不适请及时就医。';

/** 命中急症词时的黄条提示（只提示就医，不做任何处置指导）。 */
export const HEALTH_ACUTE_NOTICE: string =
  '如为正在发生的急性症状，请立即就医或拨打急救电话。';

/**
 * 第三方 AI 告知与同意文案（页面常驻 + 首次生成前弹窗确认）。
 * 明确说明会通过 HTTPS 把健康资料发送给第三方 AI（DeepSeek），且不含身份信息。
 */
export const HEALTH_THIRD_PARTY_NOTICE: string =
  '生成建议时，你填写的健康资料会通过 HTTPS 发送给第三方 AI 服务（DeepSeek），仅用于生成健康科普建议；不会发送身份证号、手机号或详细住址。';

export const HEALTH_FORM_EMPTY_MESSAGE: string = '请至少填写一项健康资料';
export const HEALTH_PROFILE_EMPTY_MESSAGE: string = '还没有健康资料，请先填写并保存';
export const HEALTH_LOADING_MESSAGE: string = '正在加载健康资料…';
export const HEALTH_SAVING_MESSAGE: string = '正在保存健康资料…';
export const HEALTH_SAVE_OK_MESSAGE: string = '健康资料已保存';
export const HEALTH_GENERATING_MESSAGE: string = '正在生成健康科普建议…';
export const HEALTH_DEMO_MESSAGE: string = '演示模式不调用网络，请退出演示后使用健康评估';
export const HEALTH_TEXT_TOTAL_LIMIT_BYTES: number = 4096;

// ------------------------------------------------------------- 急症词

/**
 * 正在发生的急性症状关键词（§1.7，与后端同一集合）。
 * 只用于页面黄条提示与“提交行为不变”，不新增任何存储字段。
 */
export const ACUTE_SYMPTOM_PATTERN: RegExp =
  /胸痛|呼吸困难|昏迷|大出血|剧烈头痛|意识不清|抽搐|偏瘫|口角歪斜/;

export function hasAcuteSymptomText(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) {
    return false;
  }
  return ACUTE_SYMPTOM_PATTERN.test(text);
}

/** 汇总表单所有自由文本，供急症词检测（只读，不改变提交内容）。 */
export function healthFormFreeText(state: HealthFormState): string {
  return [
    state.medicalHistory,
    state.medications,
    state.dietRestrictions,
    state.exerciseTypes,
    state.smoking,
    state.alcohol,
    state.bowel,
    state.mood,
    state.vision,
    state.hearing
  ].join(' ');
}

// ------------------------------------------------------------- 枚举/常量

/** 饮食口味（§1：light | normal | salty）。 */
export class HealthTaste {
  static readonly LIGHT: string = 'light';
  static readonly NORMAL: string = 'normal';
  static readonly SALTY: string = 'salty';
}

export const HEALTH_TASTES: string[] = [
  HealthTaste.LIGHT, HealthTaste.NORMAL, HealthTaste.SALTY
];

export function isValidHealthTaste(value: string): boolean {
  return HEALTH_TASTES.indexOf(value) >= 0;
}

export function healthTasteLabel(value: string): string {
  if (value === HealthTaste.LIGHT) return '清淡';
  if (value === HealthTaste.NORMAL) return '一般';
  if (value === HealthTaste.SALTY) return '偏咸';
  return '未填写';
}

/** 三态枚举：'' = 未填写（不提交），'yes'/'no' = 明确填写。 */
export class HealthTernary {
  static readonly UNSET: string = '';
  static readonly YES: string = 'yes';
  static readonly NO: string = 'no';
}

export function healthTernaryToBoolean(value: string): boolean | null {
  if (value === HealthTernary.YES) return true;
  if (value === HealthTernary.NO) return false;
  return null;
}

export function healthBooleanToTernary(value: boolean | null): string {
  if (value === true) return HealthTernary.YES;
  if (value === false) return HealthTernary.NO;
  return HealthTernary.UNSET;
}

/** §1 的数值/长度上限（与后端 validateHealthProfile 完全一致）。 */
export class HealthLimits {
  static readonly AGE_MIN: number = 1;
  static readonly AGE_MAX: number = 130;
  static readonly HEIGHT_MIN: number = 50;
  static readonly HEIGHT_MAX: number = 250;
  static readonly WEIGHT_MIN: number = 20;
  static readonly WEIGHT_MAX: number = 300;
  static readonly SYSTOLIC_MIN: number = 60;
  static readonly SYSTOLIC_MAX: number = 260;
  static readonly DIASTOLIC_MIN: number = 40;
  static readonly DIASTOLIC_MAX: number = 160;
  static readonly GLUCOSE_MIN: number = 1;
  static readonly GLUCOSE_MAX: number = 40;
  static readonly SLEEP_HOURS_MIN: number = 0;
  static readonly SLEEP_HOURS_MAX: number = 24;
  static readonly NIGHT_AWAKENINGS_MAX: number = 20;
  static readonly EXERCISE_TIMES_MAX: number = 21;
  static readonly HISTORY_MAX: number = 500;
  static readonly MEDICATIONS_MAX: number = 500;
  static readonly RESTRICTIONS_MAX: number = 200;
  static readonly EXERCISE_TYPES_MAX: number = 100;
  static readonly SHORT_TEXT_MAX: number = 100;
  static readonly MOOD_MAX: number = 200;
}

/** UTF-8 字节数（§1.5 文本总字节 ≤ 4 KiB；与后端 Buffer.byteLength 等价）。 */
export function utf8ByteLength(text: string): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }
  let bytes: number = 0;
  for (let i = 0; i < text.length; i++) {
    const code: number = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xD800 && code <= 0xDBFF) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** 字符数（按 Unicode code point，与后端 Array.from().length 一致）。 */
export function codePointLength(text: string): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }
  let count: number = 0;
  for (let i = 0; i < text.length; i++) {
    const code: number = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      i += 1;
    }
    count += 1;
  }
  return count;
}

// ------------------------------------------------------------- 校验结果

export class HealthFieldError {
  field: string = '';
  message: string = '';

  constructor(field: string = '', message: string = '') {
    this.field = field;
    this.message = message;
  }
}

export class HealthValidationResult {
  ok: boolean = true;
  fields: HealthFieldError[] = [];
  /** 第一条错误对应的字段路径，页面据此滚动/高亮。 */
  firstFocus: string = '';

  add(field: string, message: string): void {
    this.ok = false;
    this.fields.push(new HealthFieldError(field, message));
    if (this.firstFocus.length === 0) {
      this.firstFocus = field;
    }
  }

  errorFor(field: string): string {
    for (let i = 0; i < this.fields.length; i++) {
      if (this.fields[i].field === field) {
        return this.fields[i].message;
      }
    }
    return '';
  }

  messageText(): string {
    if (this.fields.length === 0) {
      return '';
    }
    return this.fields[0].message;
  }
}

class TextNumberParse {
  empty: boolean = false;
  invalid: boolean = false;
  /** 小数位超过 1 位（与“不是数字”区分，便于给出准确文案）。 */
  tooManyDecimals: boolean = false;
  value: number = 0;
}

/** 解析输入文本为数字：空 = 未填写；整数模式拒绝小数；小数模式最多 1 位。 */
function parseTextNumber(text: string, integerOnly: boolean): TextNumberParse {
  const result = new TextNumberParse();
  const trimmed: string = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length === 0) {
    result.empty = true;
    return result;
  }
  if (integerOnly) {
    if (!/^\d{1,3}$/.test(trimmed)) {
      result.invalid = true;
      return result;
    }
    result.value = Number(trimmed);
    return result;
  }
  if (/^\d{1,3}$/.test(trimmed)) {
    result.value = Number(trimmed);
    return result;
  }
  if (/^\d{1,3}\.\d$/.test(trimmed)) {
    result.value = Number(trimmed);
    return result;
  }
  if (/^\d{1,3}\.\d{2,}$/.test(trimmed)) {
    result.tooManyDecimals = true;
    result.invalid = true;
    return result;
  }
  result.invalid = true;
  return result;
}

function trimmedOrEmpty(text: string): string {
  return typeof text === 'string' ? text.trim() : '';
}

/** 数字展示：整数不带小数点，其余保留至多 1 位小数。 */
export function formatHealthNumber(value: number): string {
  if (typeof value !== 'number' || !isFinite(value)) {
    return '';
  }
  if (Math.floor(value) === value) {
    return `${value}`;
  }
  return `${Math.round(value * 10) / 10}`;
}

/** 数值文本归一（'165.0' → '165'；'6.10' 非法由校验报错）。 */
export function normalizeNumberText(text: string): string {
  const parsed: TextNumberParse = parseTextNumber(text, false);
  if (parsed.empty || parsed.invalid) {
    return '';
  }
  return formatHealthNumber(parsed.value);
}

// ------------------------------------------------------------- 表单状态

/**
 * 两页表单的完整状态（全部字符串输入 + 三态/枚举）。
 * 第 1 页：年龄/既往病史/长期用药/身高/体重/静息血压/空腹血糖。
 * 第 2 页：睡眠/饮食/运动/吸烟/饮酒/排便/情绪/视力/听力。
 */
export class HealthFormState {
  // ---- 第 1 页：基础健康信息
  ageText: string = '';
  medicalHistory: string = '';
  medications: string = '';
  heightText: string = '';
  weightText: string = '';
  systolicText: string = '';
  diastolicText: string = '';
  glucoseText: string = '';
  // ---- 第 2 页：生活习惯
  sleepHoursText: string = '';
  /** '' | 'yes' | 'no'（入睡困难） */
  sleepDifficulty: string = HealthTernary.UNSET;
  nightAwakeningsText: string = '';
  /** '' | 'yes' | 'no'（饮食是否规律） */
  dietRegular: string = HealthTernary.UNSET;
  /** '' | light | normal | salty */
  dietTaste: string = '';
  dietRestrictions: string = '';
  exerciseTimesText: string = '';
  exerciseTypes: string = '';
  smoking: string = '';
  alcohol: string = '';
  bowel: string = '';
  mood: string = '';
  vision: string = '';
  hearing: string = '';

  /** 稳定血压文本：'135/82'；两侧都未填写时返回 ''。 */
  bloodPressureText(): string {
    const systolic: string = this.systolicText.trim();
    const diastolic: string = this.diastolicText.trim();
    if (systolic.length === 0 && diastolic.length === 0) {
      return '';
    }
    return `${systolic}/${diastolic}`;
  }

  /** 是否完全没有填写任何字段（空表单不能提交，与后端 {} → 400 对齐）。 */
  isEmpty(): boolean {
    if (this.bloodPressureText().length > 0) return false;
    const texts: string[] = [
      this.ageText, this.medicalHistory, this.medications, this.heightText, this.weightText,
      this.glucoseText, this.sleepHoursText, this.nightAwakeningsText, this.dietRestrictions,
      this.exerciseTimesText, this.exerciseTypes, this.smoking, this.alcohol, this.bowel,
      this.mood, this.vision, this.hearing
    ];
    for (let i = 0; i < texts.length; i++) {
      if (trimmedOrEmpty(texts[i]).length > 0) return false;
    }
    if (healthTernaryToBoolean(this.sleepDifficulty) !== null) return false;
    if (healthTernaryToBoolean(this.dietRegular) !== null) return false;
    if (isValidHealthTaste(this.dietTaste)) return false;
    return true;
  }

  /** 仅输出已填写字段（服务端白名单；绝不包含 updatedAt）。 */
  toProfileBody(): HealthProfileBody {
    const body = new HealthProfileBody();
    const age: TextNumberParse = parseTextNumber(this.ageText, true);
    if (!age.invalid && !age.empty) body.age = age.value;
    body.medicalHistory = staticOrNull(trimmedOrEmpty(this.medicalHistory));
    body.medications = staticOrNull(trimmedOrEmpty(this.medications));
    const height: TextNumberParse = parseTextNumber(this.heightText, false);
    if (!height.invalid && !height.empty) body.heightCm = height.value;
    const weight: TextNumberParse = parseTextNumber(this.weightText, false);
    if (!weight.invalid && !weight.empty) body.weightKg = weight.value;
    const bloodPressure: string = this.bloodPressureText();
    if (bloodPressure.length > 0) body.restingBloodPressure = bloodPressure;
    const glucose: TextNumberParse = parseTextNumber(this.glucoseText, false);
    if (!glucose.invalid && !glucose.empty) {
      body.fastingGlucose = normalizeNumberText(this.glucoseText);
      if (body.fastingGlucose.length === 0) body.fastingGlucose = null;
    }
    const sleep = new HealthSleepBody();
    const sleepHours: TextNumberParse = parseTextNumber(this.sleepHoursText, false);
    if (!sleepHours.invalid && !sleepHours.empty) sleep.hours = sleepHours.value;
    const difficulty: boolean | null = healthTernaryToBoolean(this.sleepDifficulty);
    if (difficulty !== null) sleep.difficulty = difficulty;
    const awakenings: TextNumberParse = parseTextNumber(this.nightAwakeningsText, true);
    if (!awakenings.invalid && !awakenings.empty) sleep.nightAwakenings = awakenings.value;
    if (sleep.hasAny()) body.sleep = sleep;
    const diet = new HealthDietBody();
    const regular: boolean | null = healthTernaryToBoolean(this.dietRegular);
    if (regular !== null) diet.regular = regular;
    if (isValidHealthTaste(this.dietTaste)) diet.taste = this.dietTaste;
    diet.restrictions = staticOrNull(trimmedOrEmpty(this.dietRestrictions));
    if (diet.hasAny()) body.diet = diet;
    const exercise = new HealthExerciseBody();
    const times: TextNumberParse = parseTextNumber(this.exerciseTimesText, true);
    if (!times.invalid && !times.empty) exercise.timesPerWeek = times.value;
    exercise.types = staticOrNull(trimmedOrEmpty(this.exerciseTypes));
    if (exercise.hasAny()) body.exercise = exercise;
    body.smoking = staticOrNull(trimmedOrEmpty(this.smoking));
    body.alcohol = staticOrNull(trimmedOrEmpty(this.alcohol));
    body.bowel = staticOrNull(trimmedOrEmpty(this.bowel));
    body.mood = staticOrNull(trimmedOrEmpty(this.mood));
    body.vision = staticOrNull(trimmedOrEmpty(this.vision));
    body.hearing = staticOrNull(trimmedOrEmpty(this.hearing));
    return body;
  }

  toProfileJson(): string {
    return healthProfileBodyJson(this.toProfileBody());
  }
}

function staticOrNull(text: string): string | null {
  return text.length > 0 ? text : null;
}

/**
 * 与后端 §1 完全一致的本地校验。
 * 返回 `{ok, fields:[{field,message}], firstFocus}`；错误文案中文且不含任何诊断措辞。
 */
export function validateHealthForm(state: HealthFormState): HealthValidationResult {
  const result = new HealthValidationResult();
  if (state === null || state === undefined) {
    result.add('form', HEALTH_FORM_EMPTY_MESSAGE);
    return result;
  }
  if (state.isEmpty()) {
    result.add('form', HEALTH_FORM_EMPTY_MESSAGE);
    return result;
  }

  // 年龄：integer 1..130
  const age: TextNumberParse = parseTextNumber(state.ageText, true);
  if (!age.empty) {
    if (age.invalid || age.value < HealthLimits.AGE_MIN || age.value > HealthLimits.AGE_MAX) {
      result.add('age', `年龄需为 ${HealthLimits.AGE_MIN}–${HealthLimits.AGE_MAX} 的整数`);
    }
  }
  checkTextLength(result, 'medicalHistory', state.medicalHistory, HealthLimits.HISTORY_MAX,
    `既往病史最多 ${HealthLimits.HISTORY_MAX} 字`);
  checkTextLength(result, 'medications', state.medications, HealthLimits.MEDICATIONS_MAX,
    `长期用药最多 ${HealthLimits.MEDICATIONS_MAX} 字`);

  // 身高 / 体重：number，最多 1 位小数
  const height: TextNumberParse = parseTextNumber(state.heightText, false);
  if (!height.empty) {
    if (height.invalid || height.value < HealthLimits.HEIGHT_MIN ||
      height.value > HealthLimits.HEIGHT_MAX) {
      result.add('heightText',
        `身高需为 ${HealthLimits.HEIGHT_MIN}–${HealthLimits.HEIGHT_MAX} cm 的数字，最多 1 位小数`);
    }
  }
  const weight: TextNumberParse = parseTextNumber(state.weightText, false);
  if (!weight.empty) {
    if (weight.invalid || weight.value < HealthLimits.WEIGHT_MIN ||
      weight.value > HealthLimits.WEIGHT_MAX) {
      result.add('weightText',
        `体重需为 ${HealthLimits.WEIGHT_MIN}–${HealthLimits.WEIGHT_MAX} kg 的数字，最多 1 位小数`);
    }
  }

  // 静息血压：两侧要么都不填，要么都合法且收缩压 > 舒张压
  const systolic: TextNumberParse = parseTextNumber(state.systolicText, true);
  const diastolic: TextNumberParse = parseTextNumber(state.diastolicText, true);
  if (!systolic.empty || !diastolic.empty) {
    if (systolic.empty || diastolic.empty) {
      result.add('restingBloodPressure', '请同时填写收缩压和舒张压');
    } else if (systolic.invalid || systolic.value < HealthLimits.SYSTOLIC_MIN ||
      systolic.value > HealthLimits.SYSTOLIC_MAX) {
      result.add('restingBloodPressure',
        `收缩压需为 ${HealthLimits.SYSTOLIC_MIN}–${HealthLimits.SYSTOLIC_MAX} 的整数`);
    } else if (diastolic.invalid || diastolic.value < HealthLimits.DIASTOLIC_MIN ||
      diastolic.value > HealthLimits.DIASTOLIC_MAX) {
      result.add('restingBloodPressure',
        `舒张压需为 ${HealthLimits.DIASTOLIC_MIN}–${HealthLimits.DIASTOLIC_MAX} 的整数`);
    } else if (systolic.value <= diastolic.value) {
      result.add('restingBloodPressure', '收缩压需大于舒张压');
    }
  }

  // 空腹血糖：十进制字符串 1.0..40.0，最多 1 位小数
  const glucose: TextNumberParse = parseTextNumber(state.glucoseText, false);
  if (!glucose.empty) {
    if (glucose.invalid || glucose.value < HealthLimits.GLUCOSE_MIN ||
      glucose.value > HealthLimits.GLUCOSE_MAX) {
      result.add('glucoseText',
        `空腹血糖需为 ${HealthLimits.GLUCOSE_MIN}.0–${HealthLimits.GLUCOSE_MAX}.0 的数字，最多 1 位小数`);
    }
  }

  // 睡眠：hours 0..24（1 位小数）、nightAwakenings 0..20（整数）、difficulty boolean
  const sleepHours: TextNumberParse = parseTextNumber(state.sleepHoursText, false);
  if (!sleepHours.empty) {
    if (sleepHours.invalid || sleepHours.value < HealthLimits.SLEEP_HOURS_MIN ||
      sleepHours.value > HealthLimits.SLEEP_HOURS_MAX) {
      result.add('sleepHoursText',
        `睡眠时长需为 ${HealthLimits.SLEEP_HOURS_MIN}–${HealthLimits.SLEEP_HOURS_MAX} 的数字，最多 1 位小数`);
    }
  }
  if (state.sleepDifficulty !== HealthTernary.UNSET &&
    healthTernaryToBoolean(state.sleepDifficulty) === null) {
    result.add('sleepDifficulty', '入睡困难请选择“是”或“否”');
  }
  const awakenings: TextNumberParse = parseTextNumber(state.nightAwakeningsText, true);
  if (!awakenings.empty) {
    if (awakenings.invalid || awakenings.value < 0 ||
      awakenings.value > HealthLimits.NIGHT_AWAKENINGS_MAX) {
      result.add('nightAwakeningsText',
        `夜间醒来次数需为 0–${HealthLimits.NIGHT_AWAKENINGS_MAX} 的整数`);
    }
  }

  // 饮食
  if (state.dietRegular !== HealthTernary.UNSET &&
    healthTernaryToBoolean(state.dietRegular) === null) {
    result.add('dietRegular', '饮食是否规律请选择“是”或“否”');
  }
  if (state.dietTaste.length > 0 && !isValidHealthTaste(state.dietTaste)) {
    result.add('dietTaste', '饮食口味请选择清淡 / 一般 / 偏咸');
  }
  checkTextLength(result, 'dietRestrictions', state.dietRestrictions,
    HealthLimits.RESTRICTIONS_MAX, `饮食忌口最多 ${HealthLimits.RESTRICTIONS_MAX} 字`);

  // 运动
  const times: TextNumberParse = parseTextNumber(state.exerciseTimesText, true);
  if (!times.empty) {
    if (times.invalid || times.value < 0 || times.value > HealthLimits.EXERCISE_TIMES_MAX) {
      result.add('exerciseTimesText',
        `每周运动次数需为 0–${HealthLimits.EXERCISE_TIMES_MAX} 的整数`);
    }
  }
  checkTextLength(result, 'exerciseTypes', state.exerciseTypes,
    HealthLimits.EXERCISE_TYPES_MAX, `运动类型最多 ${HealthLimits.EXERCISE_TYPES_MAX} 字`);

  // 其余短文本
  checkTextLength(result, 'smoking', state.smoking, HealthLimits.SHORT_TEXT_MAX,
    `吸烟情况最多 ${HealthLimits.SHORT_TEXT_MAX} 字`);
  checkTextLength(result, 'alcohol', state.alcohol, HealthLimits.SHORT_TEXT_MAX,
    `饮酒情况最多 ${HealthLimits.SHORT_TEXT_MAX} 字`);
  checkTextLength(result, 'bowel', state.bowel, HealthLimits.SHORT_TEXT_MAX,
    `排便情况最多 ${HealthLimits.SHORT_TEXT_MAX} 字`);
  checkTextLength(result, 'mood', state.mood, HealthLimits.MOOD_MAX,
    `情绪状态最多 ${HealthLimits.MOOD_MAX} 字`);
  checkTextLength(result, 'vision', state.vision, HealthLimits.SHORT_TEXT_MAX,
    `视力情况最多 ${HealthLimits.SHORT_TEXT_MAX} 字`);
  checkTextLength(result, 'hearing', state.hearing, HealthLimits.SHORT_TEXT_MAX,
    `听力情况最多 ${HealthLimits.SHORT_TEXT_MAX} 字`);

  // 文本总字节 ≤ 4 KiB（§1.5）
  let textBytes: number = 0;
  const allTexts: string[] = [
    state.medicalHistory, state.medications, state.dietRestrictions, state.exerciseTypes,
    state.smoking, state.alcohol, state.bowel, state.mood, state.vision, state.hearing
  ];
  for (let i = 0; i < allTexts.length; i++) {
    textBytes += utf8ByteLength(trimmedOrEmpty(allTexts[i]));
  }
  if (textBytes > HEALTH_TEXT_TOTAL_LIMIT_BYTES) {
    result.add('form', `所有文本总长度超出上限（${HEALTH_TEXT_TOTAL_LIMIT_BYTES} 字节）`);
  }

  return result;
}

function checkTextLength(result: HealthValidationResult, field: string, text: string,
  maxLength: number, message: string): void {
  const trimmed: string = trimmedOrEmpty(text);
  if (trimmed.length === 0) {
    return;
  }
  if (codePointLength(trimmed) > maxLength) {
    result.add(field, message);
  }
}

// ------------------------------------------------------------- 请求体

export class HealthSleepBody {
  hours: number | null = null;
  difficulty: boolean | null = null;
  nightAwakenings: number | null = null;

  hasAny(): boolean {
    return this.hours !== null || this.difficulty !== null || this.nightAwakenings !== null;
  }
}

export class HealthDietBody {
  regular: boolean | null = null;
  taste: string | null = null;
  restrictions: string | null = null;

  hasAny(): boolean {
    return this.regular !== null || this.taste !== null || this.restrictions !== null;
  }
}

export class HealthExerciseBody {
  timesPerWeek: number | null = null;
  types: string | null = null;

  hasAny(): boolean {
    return this.timesPerWeek !== null || this.types !== null;
  }
}

/** PUT/POST 请求体（只含服务端白名单字段；updatedAt 永不由客户端提供）。 */
export class HealthProfileBody {
  age: number | null = null;
  medicalHistory: string | null = null;
  medications: string | null = null;
  heightCm: number | null = null;
  weightKg: number | null = null;
  restingBloodPressure: string | null = null;
  fastingGlucose: string | null = null;
  sleep: HealthSleepBody | null = null;
  diet: HealthDietBody | null = null;
  exercise: HealthExerciseBody | null = null;
  smoking: string | null = null;
  alcohol: string | null = null;
  bowel: string | null = null;
  mood: string | null = null;
  vision: string | null = null;
  hearing: string | null = null;

  hasAnyField(): boolean {
    if (this.age !== null || this.medicalHistory !== null || this.medications !== null) return true;
    if (this.heightCm !== null || this.weightKg !== null) return true;
    if (this.restingBloodPressure !== null || this.fastingGlucose !== null) return true;
    if (this.sleep !== null || this.diet !== null || this.exercise !== null) return true;
    if (this.smoking !== null || this.alcohol !== null || this.bowel !== null) return true;
    if (this.mood !== null || this.vision !== null || this.hearing !== null) return true;
    return false;
  }
}

/** 序列化请求体：只输出非 null 字段（等价于后端“未填写 = 不写快照”）。 */
export function healthProfileBodyJson(body: HealthProfileBody): string {
  const out: any = {};
  if (body === null || body === undefined) {
    return '{}';
  }
  if (body.age !== null) out['age'] = body.age;
  if (body.medicalHistory !== null) out['medicalHistory'] = body.medicalHistory;
  if (body.medications !== null) out['medications'] = body.medications;
  if (body.heightCm !== null) out['heightCm'] = body.heightCm;
  if (body.weightKg !== null) out['weightKg'] = body.weightKg;
  if (body.restingBloodPressure !== null) out['restingBloodPressure'] = body.restingBloodPressure;
  if (body.fastingGlucose !== null) out['fastingGlucose'] = body.fastingGlucose;
  if (body.sleep !== null) {
    const sleep: any = {};
    if (body.sleep.hours !== null) sleep['hours'] = body.sleep.hours;
    if (body.sleep.difficulty !== null) sleep['difficulty'] = body.sleep.difficulty;
    if (body.sleep.nightAwakenings !== null) sleep['nightAwakenings'] = body.sleep.nightAwakenings;
    if (Object.keys(sleep).length > 0) out['sleep'] = sleep;
  }
  if (body.diet !== null) {
    const diet: any = {};
    if (body.diet.regular !== null) diet['regular'] = body.diet.regular;
    if (body.diet.taste !== null) diet['taste'] = body.diet.taste;
    if (body.diet.restrictions !== null) diet['restrictions'] = body.diet.restrictions;
    if (Object.keys(diet).length > 0) out['diet'] = diet;
  }
  if (body.exercise !== null) {
    const exercise: any = {};
    if (body.exercise.timesPerWeek !== null) exercise['timesPerWeek'] = body.exercise.timesPerWeek;
    if (body.exercise.types !== null) exercise['types'] = body.exercise.types;
    if (Object.keys(exercise).length > 0) out['exercise'] = exercise;
  }
  if (body.smoking !== null) out['smoking'] = body.smoking;
  if (body.alcohol !== null) out['alcohol'] = body.alcohol;
  if (body.bowel !== null) out['bowel'] = body.bowel;
  if (body.mood !== null) out['mood'] = body.mood;
  if (body.vision !== null) out['vision'] = body.vision;
  if (body.hearing !== null) out['hearing'] = body.hearing;
  return JSON.stringify(out);
}

// ------------------------------------------------------------- 响应 DTO

/** HealthProfile（§1 白名单字段 + 服务端 updatedAt）。数值/布尔用 hasXxx 区分“0/false”与“未填写”。 */
export class HealthProfileDto {
  age: number = 0;
  hasAge: boolean = false;
  medicalHistory: string = '';
  medications: string = '';
  heightCm: number = 0;
  hasHeightCm: boolean = false;
  weightKg: number = 0;
  hasWeightKg: boolean = false;
  restingBloodPressure: string = '';
  fastingGlucose: string = '';
  sleepHours: number = 0;
  hasSleepHours: boolean = false;
  sleepDifficulty: boolean = false;
  hasSleepDifficulty: boolean = false;
  nightAwakenings: number = 0;
  hasNightAwakenings: boolean = false;
  dietRegular: boolean = false;
  hasDietRegular: boolean = false;
  dietTaste: string = '';
  dietRestrictions: string = '';
  exerciseTimesPerWeek: number = 0;
  hasExerciseTimesPerWeek: boolean = false;
  exerciseTypes: string = '';
  smoking: string = '';
  alcohol: string = '';
  bowel: string = '';
  mood: string = '';
  vision: string = '';
  hearing: string = '';
  updatedAt: number = 0;
  hasUpdatedAt: boolean = false;

  hasAnyField(): boolean {
    if (this.hasAge || this.hasHeightCm || this.hasWeightKg) return true;
    if (this.hasSleepHours || this.hasSleepDifficulty || this.hasNightAwakenings) return true;
    if (this.hasDietRegular || this.hasExerciseTimesPerWeek) return true;
    const texts: string[] = [
      this.medicalHistory, this.medications, this.restingBloodPressure, this.fastingGlucose,
      this.dietTaste, this.dietRestrictions, this.exerciseTypes, this.smoking, this.alcohol,
      this.bowel, this.mood, this.vision, this.hearing
    ];
    for (let i = 0; i < texts.length; i++) {
      if (texts[i].length > 0) return true;
    }
    return false;
  }
}

function readNullableNumber(value: any, key: string): number | null {
  if (!isRecord(value) || !hasOwn(value, key)) return null;
  const raw: any = value[key];
  if (typeof raw === 'number' && isFinite(raw)) return raw;
  return null;
}

function readNullableBoolean(value: any, key: string): boolean | null {
  if (!isRecord(value) || !hasOwn(value, key)) return null;
  const raw: any = value[key];
  return typeof raw === 'boolean' ? raw : null;
}

function readNullableText(value: any, key: string): string {
  if (!isRecord(value) || !hasOwn(value, key)) return '';
  const raw: string = asString(value, key, '');
  return raw.trim();
}

/** 防御式填充：缺字段/类型错误只回退默认，绝不抛异常；未知字段忽略。 */
export function fillHealthProfileDto(value: any): HealthProfileDto {
  const dto = new HealthProfileDto();
  if (!isRecord(value)) {
    return dto;
  }
  const age: number | null = readNullableNumber(value, 'age');
  if (age !== null) {
    dto.age = age;
    dto.hasAge = true;
  }
  dto.medicalHistory = readNullableText(value, 'medicalHistory');
  dto.medications = readNullableText(value, 'medications');
  const height: number | null = readNullableNumber(value, 'heightCm');
  if (height !== null) {
    dto.heightCm = height;
    dto.hasHeightCm = true;
  }
  const weight: number | null = readNullableNumber(value, 'weightKg');
  if (weight !== null) {
    dto.weightKg = weight;
    dto.hasWeightKg = true;
  }
  dto.restingBloodPressure = readNullableText(value, 'restingBloodPressure');
  dto.fastingGlucose = readNullableText(value, 'fastingGlucose');
  const sleep: any = asObject(value, 'sleep');
  if (sleep !== null) {
    const hours: number | null = readNullableNumber(sleep, 'hours');
    if (hours !== null) {
      dto.sleepHours = hours;
      dto.hasSleepHours = true;
    }
    const difficulty: boolean | null = readNullableBoolean(sleep, 'difficulty');
    if (difficulty !== null) {
      dto.sleepDifficulty = difficulty;
      dto.hasSleepDifficulty = true;
    }
    const nightAwakenings: number | null = readNullableNumber(sleep, 'nightAwakenings');
    if (nightAwakenings !== null) {
      dto.nightAwakenings = nightAwakenings;
      dto.hasNightAwakenings = true;
    }
  }
  const diet: any = asObject(value, 'diet');
  if (diet !== null) {
    const regular: boolean | null = readNullableBoolean(diet, 'regular');
    if (regular !== null) {
      dto.dietRegular = regular;
      dto.hasDietRegular = true;
    }
    dto.dietTaste = readNullableText(diet, 'taste');
    dto.dietRestrictions = readNullableText(diet, 'restrictions');
  }
  const exercise: any = asObject(value, 'exercise');
  if (exercise !== null) {
    const times: number | null = readNullableNumber(exercise, 'timesPerWeek');
    if (times !== null) {
      dto.exerciseTimesPerWeek = times;
      dto.hasExerciseTimesPerWeek = true;
    }
    dto.exerciseTypes = readNullableText(exercise, 'types');
  }
  dto.smoking = readNullableText(value, 'smoking');
  dto.alcohol = readNullableText(value, 'alcohol');
  dto.bowel = readNullableText(value, 'bowel');
  dto.mood = readNullableText(value, 'mood');
  dto.vision = readNullableText(value, 'vision');
  dto.hearing = readNullableText(value, 'hearing');
  const updatedAt: number = asFiniteNumber(value, 'updatedAt', 0);
  if (updatedAt > 0) {
    dto.updatedAt = updatedAt;
    dto.hasUpdatedAt = true;
  }
  return dto;
}

// ------------------------------------------------------------- 视图模型

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 服务端时间 → `YYYY-MM-DD HH:mm`（本机时区）。0/非法 → ''。 */
export function formatHealthTime(ms: number): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) {
    return '';
  }
  const date: Date = new Date(ms);
  const yyyy: string = `${date.getFullYear()}`;
  const mm: string = pad2(date.getMonth() + 1);
  const dd: string = pad2(date.getDate());
  const hh: string = pad2(date.getHours());
  const min: string = pad2(date.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/** 睡眠描述文本（未填写字段不出现在文本里）。 */
function sleepLine(dto: HealthProfileDto): string {
  const parts: string[] = [];
  if (dto.hasSleepHours) parts.push(`每晚约 ${formatHealthNumber(dto.sleepHours)} 小时`);
  if (dto.hasSleepDifficulty) parts.push(dto.sleepDifficulty ? '有入睡困难' : '无入睡困难');
  if (dto.hasNightAwakenings) {
    parts.push(`夜间醒来 ${formatHealthNumber(dto.nightAwakenings)} 次`);
  }
  return parts.join(' · ');
}

function dietLine(dto: HealthProfileDto): string {
  const parts: string[] = [];
  if (dto.hasDietRegular) parts.push(dto.dietRegular ? '饮食规律' : '饮食不规律');
  if (dto.dietTaste.length > 0) parts.push(`口味${healthTasteLabel(dto.dietTaste)}`);
  if (dto.dietRestrictions.length > 0) parts.push(`忌口：${dto.dietRestrictions}`);
  return parts.join(' · ');
}

function exerciseLine(dto: HealthProfileDto): string {
  const parts: string[] = [];
  if (dto.hasExerciseTimesPerWeek) {
    parts.push(`每周运动 ${formatHealthNumber(dto.exerciseTimesPerWeek)} 次`);
  }
  if (dto.exerciseTypes.length > 0) parts.push(dto.exerciseTypes);
  return parts.join(' · ');
}

/** 页面 @StorageLink('gv.healthProfile') 使用的只读视图（可回填表单）。 */
export class HealthProfileView {
  present: boolean = false;
  ageText: string = '';
  medicalHistory: string = '';
  medications: string = '';
  heightText: string = '';
  weightText: string = '';
  systolicText: string = '';
  diastolicText: string = '';
  glucoseText: string = '';
  sleepHoursText: string = '';
  sleepDifficulty: string = '';
  nightAwakeningsText: string = '';
  dietRegular: string = '';
  dietTaste: string = '';
  dietRestrictions: string = '';
  exerciseTimesText: string = '';
  exerciseTypes: string = '';
  smoking: string = '';
  alcohol: string = '';
  bowel: string = '';
  mood: string = '';
  vision: string = '';
  hearing: string = '';
  updatedAt: number = 0;
  hasUpdatedAt: boolean = false;
  updatedAtText: string = '';
  /** “年龄：72 岁”“静息血压：135/82”等展示行（只含服务端已保存的真实资料）。 */
  basicLines: string[] = [];
  habitLines: string[] = [];
}

export function emptyHealthProfileView(): HealthProfileView {
  return new HealthProfileView();
}

export function healthProfileViewFrom(dto: HealthProfileDto): HealthProfileView {
  const view = new HealthProfileView();
  if (dto === null || dto === undefined || !dto.hasAnyField()) {
    view.present = false;
    return view;
  }
  view.present = true;
  if (dto.hasAge) view.ageText = formatHealthNumber(dto.age);
  view.medicalHistory = dto.medicalHistory;
  view.medications = dto.medications;
  if (dto.hasHeightCm) view.heightText = formatHealthNumber(dto.heightCm);
  if (dto.hasWeightKg) view.weightText = formatHealthNumber(dto.weightKg);
  const pressure: string = dto.restingBloodPressure.trim();
  if (pressure.length > 0) {
    const parts: string[] = pressure.split('/');
    if (parts.length === 2) {
      view.systolicText = parts[0].trim();
      view.diastolicText = parts[1].trim();
    }
  }
  view.glucoseText = dto.fastingGlucose;
  if (dto.hasSleepHours) view.sleepHoursText = formatHealthNumber(dto.sleepHours);
  view.sleepDifficulty = healthBooleanToTernary(
    dto.hasSleepDifficulty ? dto.sleepDifficulty : null);
  if (dto.hasNightAwakenings) {
    view.nightAwakeningsText = formatHealthNumber(dto.nightAwakenings);
  }
  view.dietRegular = healthBooleanToTernary(dto.hasDietRegular ? dto.dietRegular : null);
  view.dietTaste = dto.dietTaste;
  view.dietRestrictions = dto.dietRestrictions;
  if (dto.hasExerciseTimesPerWeek) {
    view.exerciseTimesText = formatHealthNumber(dto.exerciseTimesPerWeek);
  }
  view.exerciseTypes = dto.exerciseTypes;
  view.smoking = dto.smoking;
  view.alcohol = dto.alcohol;
  view.bowel = dto.bowel;
  view.mood = dto.mood;
  view.vision = dto.vision;
  view.hearing = dto.hearing;
  view.updatedAt = dto.updatedAt;
  view.hasUpdatedAt = dto.hasUpdatedAt;
  view.updatedAtText = formatHealthTime(dto.updatedAt);

  // 展示行（只展示服务端确实保存过的字段，缺失不补默认值）
  const basic: string[] = [];
  if (dto.hasAge) basic.push(`年龄：${formatHealthNumber(dto.age)} 岁`);
  if (dto.hasHeightCm) basic.push(`身高：${formatHealthNumber(dto.heightCm)} cm`);
  if (dto.hasWeightKg) basic.push(`体重：${formatHealthNumber(dto.weightKg)} kg`);
  if (pressure.length > 0) basic.push(`静息血压：${pressure} mmHg`);
  if (dto.fastingGlucose.length > 0) basic.push(`空腹血糖：${dto.fastingGlucose} mmol/L`);
  if (dto.medicalHistory.length > 0) basic.push(`既往病史：${dto.medicalHistory}`);
  if (dto.medications.length > 0) basic.push(`长期用药：${dto.medications}`);
  view.basicLines = basic;

  const habit: string[] = [];
  const sleep: string = sleepLine(dto);
  if (sleep.length > 0) habit.push(`睡眠：${sleep}`);
  const diet: string = dietLine(dto);
  if (diet.length > 0) habit.push(`饮食：${diet}`);
  const exercise: string = exerciseLine(dto);
  if (exercise.length > 0) habit.push(`运动：${exercise}`);
  if (dto.smoking.length > 0) habit.push(`吸烟：${dto.smoking}`);
  if (dto.alcohol.length > 0) habit.push(`饮酒：${dto.alcohol}`);
  if (dto.bowel.length > 0) habit.push(`排便：${dto.bowel}`);
  if (dto.mood.length > 0) habit.push(`情绪：${dto.mood}`);
  if (dto.vision.length > 0) habit.push(`视力：${dto.vision}`);
  if (dto.hearing.length > 0) habit.push(`听力：${dto.hearing}`);
  view.habitLines = habit;
  return view;
}

/** 编辑已保存资料：把视图回填成两页表单（不做任何猜测/补默认值）。 */
export function healthFormFromView(view: HealthProfileView): HealthFormState {
  const state = new HealthFormState();
  if (view === null || view === undefined) {
    return state;
  }
  state.ageText = view.ageText;
  state.medicalHistory = view.medicalHistory;
  state.medications = view.medications;
  state.heightText = view.heightText;
  state.weightText = view.weightText;
  state.systolicText = view.systolicText;
  state.diastolicText = view.diastolicText;
  state.glucoseText = view.glucoseText;
  state.sleepHoursText = view.sleepHoursText;
  state.sleepDifficulty = view.sleepDifficulty;
  state.nightAwakeningsText = view.nightAwakeningsText;
  state.dietRegular = view.dietRegular;
  state.dietTaste = view.dietTaste;
  state.dietRestrictions = view.dietRestrictions;
  state.exerciseTimesText = view.exerciseTimesText;
  state.exerciseTypes = view.exerciseTypes;
  state.smoking = view.smoking;
  state.alcohol = view.alcohol;
  state.bowel = view.bowel;
  state.mood = view.mood;
  state.vision = view.vision;
  state.hearing = view.hearing;
  return state;
}
