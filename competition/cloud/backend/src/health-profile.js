'use strict';

/**
 * HealthProfile 的白名单校验、规范化，以及健康域 ownerRef 派生。
 * 规范见 docs/AI-HEALTH-ASSESSMENT-SPEC.md §1。
 *
 * 只接受 §1 列出的字段（含固定的一层嵌套 sleep/diet/exercise），其它一律校验失败，
 * 包括身份类字段、updatedAt 和多层嵌套。错误信息只带字段路径和规则短句，不回显原始值。
 *
 * 字符串先 trim，trim 后为空就当“未填写”直接省略；数值 0 是合法值，null/缺失才是未填写。
 * 文本总字节数不超过 4 KiB。updatedAt 只能由服务端落盘时写入。
 *
 * 存储键 healthOwnerRefFor 是 h1_ 前缀的独立 HMAC 域，与 comms 的 r1_ 不同域，
 * 所以健康快照里不会出现 openid/sub，也没法和交流台账互相反查。
 *
 * 纯函数模块：不读环境变量、不写文件、不打日志、不访问网络。
 */

const crypto = require('node:crypto');

/** 健康资料 ownerRef 前缀（与 comms 的 `r1_` 明确区分）。 */
const HEALTH_OWNER_REF_PREFIX = 'h1_';
/** HMAC 域分离串：与 comms 的 `eldercare-comms-owner:v1\0` 不同。 */
const HEALTH_OWNER_DOMAIN = 'eldercare-health-owner:v1\u0000';
/** base64url(HMAC-SHA256) = 43 字符。 */
const HEALTH_OWNER_REF_RE = /^h1_[A-Za-z0-9_-]{43}$/;
/** 请求体上限（§1.5）：超过由路由层返回 413。 */
const HEALTH_PROFILE_BODY_LIMIT = 8 * 1024;
/** 所有文本字段的 UTF-8 总字节上限（§1.5）。 */
const HEALTH_PROFILE_TEXT_LIMIT = 4 * 1024;

/** 顶层字段白名单（顺序即响应字段顺序）。 */
const PROFILE_FIELDS = Object.freeze([
  'age',
  'medicalHistory',
  'medications',
  'heightCm',
  'weightKg',
  'restingBloodPressure',
  'fastingGlucose',
  'sleep',
  'diet',
  'exercise',
  'smoking',
  'alcohol',
  'bowel',
  'mood',
  'vision',
  'hearing'
]);
const PROFILE_FIELD_SET = new Set(PROFILE_FIELDS);

const SLEEP_FIELDS = Object.freeze(['hours', 'difficulty', 'nightAwakenings']);
const SLEEP_FIELD_SET = new Set(SLEEP_FIELDS);
const DIET_FIELDS = Object.freeze(['regular', 'taste', 'restrictions']);
const DIET_FIELD_SET = new Set(DIET_FIELDS);
const EXERCISE_FIELDS = Object.freeze(['timesPerWeek', 'types']);
const EXERCISE_FIELD_SET = new Set(EXERCISE_FIELDS);

/** diet.taste 枚举（§1）。 */
const HEALTH_TASTES = Object.freeze(['light', 'normal', 'salty']);
const HEALTH_TASTE_SET = new Set(HEALTH_TASTES);

/**
 * 身份类字段拒绝名单（§1.4）。匹配前把键名归一成小写去符号，
 * 所以 idCard / id_card / ID-CARD 都会归到 idcard。
 */
const IDENTITY_FIELDS = Object.freeze([
  'idcard',
  'idnumber',
  'phone',
  'mobile',
  'telephone',
  'tel',
  'address',
  'name',
  'token',
  'accesstoken',
  'apikey',
  'password',
  'passwd',
  'secret',
  'iccid',
  'wifipassword',
  'openid',
  'unionid',
  'ownerref',
  'subject',
  'sub'
]);
const IDENTITY_FIELD_SET = new Set(IDENTITY_FIELDS);

/**
 * 正在发生的急性症状关键词（§1.7）。只用于把用户主诉识别成“需要就医预警”，
 * 不改变校验和保存行为，也不新增专用存储。
 */
const ACUTE_SYMPTOM_PATTERN =
  /胸痛|呼吸困难|昏迷|大出血|剧烈头痛|意识不清|抽搐|偏瘫|口角歪斜/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 归一化字段名用于身份名单匹配：小写并去掉非字母数字。 */
function normalizeFieldName(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 字段名回显安全化：去控制字符并限长（错误信息里只出现字段路径，不出现值）。 */
function safeFieldLabel(key) {
  const text = typeof key === 'string' ? key : String(key);
  const printable = text.replace(/[\u0000-\u001f\u007f]/g, '?');
  return printable.length > 64 ? `${printable.slice(0, 64)}...` : printable;
}

function codePointLength(text) {
  return Array.from(text).length;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** 数字最多 1 位小数（用容差处理 0.1*10 之类的浮点表示误差）。 */
function hasAtMostOneDecimal(value) {
  const scaled = value * 10;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9;
}

/* ---- 校验上下文 ---- */

function createContext() {
  return { fields: [], value: {}, textBytes: 0 };
}

function addStringField(ctx, source, key, path, maxLength) {
  if (!hasOwn(source, key)) return;
  const raw = source[key];
  if (raw === null) return; // null = 未填写
  if (typeof raw !== 'string') {
    ctx.fields.push(`${path} must be a string`);
    return;
  }
  const trimmed = raw.trim();
  if (trimmed === '') return; // trim 后为空 = 未填写，绝不写入 ""
  if (codePointLength(trimmed) > maxLength) {
    ctx.fields.push(`${path} must be at most ${maxLength} characters`);
    return;
  }
  ctx.value[key] = trimmed;
  ctx.textBytes += Buffer.byteLength(trimmed, 'utf8');
}

function addNumberField(ctx, source, key, path, options) {
  if (!hasOwn(source, key)) return;
  const raw = source[key];
  if (raw === null) return;
  const { min, max, integer = false } = options;
  const expected = integer ? 'an integer' : 'a number';
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    ctx.fields.push(`${path} must be ${expected} in [${min}, ${max}]`);
    return;
  }
  if (integer && !Number.isInteger(raw)) {
    ctx.fields.push(`${path} must be ${expected} in [${min}, ${max}]`);
    return;
  }
  if (raw < min || raw > max) {
    ctx.fields.push(`${path} must be ${expected} in [${min}, ${max}]`);
    return;
  }
  if (!integer && !hasAtMostOneDecimal(raw)) {
    ctx.fields.push(`${path} must have at most 1 decimal place`);
    return;
  }
  ctx.value[key] = raw;
}

function addBooleanField(ctx, source, key, path) {
  if (!hasOwn(source, key)) return;
  const raw = source[key];
  if (raw === null) return;
  if (typeof raw !== 'boolean') {
    ctx.fields.push(`${path} must be a boolean`);
    return;
  }
  ctx.value[key] = raw;
}

function addTasteField(ctx, source, key, path) {
  if (!hasOwn(source, key)) return;
  const raw = source[key];
  if (raw === null) return;
  if (typeof raw !== 'string') {
    ctx.fields.push(`${path} must be one of ${HEALTH_TASTES.join('|')}`);
    return;
  }
  const trimmed = raw.trim();
  if (trimmed === '') return;
  if (!HEALTH_TASTE_SET.has(trimmed)) {
    ctx.fields.push(`${path} must be one of ${HEALTH_TASTES.join('|')}`);
    return;
  }
  ctx.value[key] = trimmed;
  ctx.textBytes += Buffer.byteLength(trimmed, 'utf8');
}

/** 静息血压："收缩压/舒张压"，60..260 / 40..160，且收缩压 > 舒张压。 */
function addBloodPressureField(ctx, source, key, path) {
  if (!hasOwn(source, key)) return;
  const raw = source[key];
  if (raw === null) return;
  if (typeof raw !== 'string') {
    ctx.fields.push(`${path} must be a string in the form systolic/diastolic`);
    return;
  }
  const trimmed = raw.trim();
  if (trimmed === '') return;
  const match = /^(\d{1,3})\s*\/\s*(\d{1,3})$/.exec(trimmed);
  if (!match) {
    ctx.fields.push(`${path} must be in the form systolic/diastolic`);
    return;
  }
  const systolic = Number(match[1]);
  const diastolic = Number(match[2]);
  if (systolic < 60 || systolic > 260) {
    ctx.fields.push(`${path} systolic must be an integer in [60, 260]`);
    return;
  }
  if (diastolic < 40 || diastolic > 160) {
    ctx.fields.push(`${path} diastolic must be an integer in [40, 160]`);
    return;
  }
  if (systolic <= diastolic) {
    ctx.fields.push(`${path} systolic must be greater than diastolic`);
    return;
  }
  ctx.value[key] = trimmed;
  ctx.textBytes += Buffer.byteLength(trimmed, 'utf8');
}

/** 空腹血糖："6.1" 形式十进制字符串，1.0..40.0，最多 1 位小数。 */
function addFastingGlucoseField(ctx, source, key, path) {
  if (!hasOwn(source, key)) return;
  const raw = source[key];
  if (raw === null) return;
  if (typeof raw !== 'string') {
    ctx.fields.push(`${path} must be a decimal string in [1.0, 40.0]`);
    return;
  }
  const trimmed = raw.trim();
  if (trimmed === '') return;
  if (!/^\d{1,2}(?:\.\d)?$/.test(trimmed)) {
    ctx.fields.push(`${path} must be a decimal string in [1.0, 40.0] with at most 1 decimal place`);
    return;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 1 || value > 40) {
    ctx.fields.push(`${path} must be in [1.0, 40.0]`);
    return;
  }
  ctx.value[key] = trimmed;
  ctx.textBytes += Buffer.byteLength(trimmed, 'utf8');
}

/**
 * 一层嵌套对象：对象内至少 1 个字段；未知嵌套字段与身份字段同样拒绝。
 * handler 负责把合法字段写入 target。
 */
function addNestedField(ctx, source, key, path, fieldSet, handler) {
  if (!hasOwn(source, key)) return;
  const raw = source[key];
  if (raw === null) return;
  if (!isPlainObject(raw)) {
    ctx.fields.push(`${path} must be an object`);
    return;
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    ctx.fields.push(`${path} must contain at least one field`);
    return;
  }
  const before = ctx.fields.length;
  const target = {};
  for (const nestedKey of keys) {
    if (!fieldSet.has(nestedKey) || IDENTITY_FIELD_SET.has(normalizeFieldName(nestedKey))) {
      // 嵌套层同样拒绝未知字段与身份类字段，错误信息只回显字段路径。
      ctx.fields.push(`unknown field: ${path}.${safeFieldLabel(nestedKey)}`);
      continue;
    }
    handler(raw, target, `${path}.${nestedKey}`);
  }
  if (ctx.fields.length !== before) return;
  if (Object.keys(target).length === 0) {
    // 嵌套字段存在但全部为 null/空串，等于"未填写"，对象内没有任何有效字段。
    ctx.fields.push(`${path} must contain at least one field`);
    return;
  }
  ctx.value[key] = target;
}

/* ---- 校验入口 ---- */

/**
 * 校验并规范化客户端提交的 HealthProfile。
 *
 * @param {unknown} input 请求体解析结果
 * @returns {{ok:true, value:object} | {ok:false, fields:string[]}}
 *          value 只含白名单字段，不含 updatedAt（由存储层写入服务端时间）。
 */
function validateHealthProfile(input) {
  const ctx = createContext();
  if (!isPlainObject(input)) {
    return { ok: false, fields: ['health profile must be a JSON object'] };
  }

  for (const key of Object.keys(input)) {
    const normalized = normalizeFieldName(key);
    if (key === 'updatedAt') {
      // §1：updatedAt 只能服务端写入，客户端提供即失败。
      ctx.fields.push('updatedAt is written by the server');
      continue;
    }
    if (IDENTITY_FIELD_SET.has(normalized) || !PROFILE_FIELD_SET.has(key)) {
      // 身份类字段显式拒绝，即使以后扩白名单也不放行。文案跟未知字段一致，
      // 只回显字段名，不回显值（§2.2 示例：unknown field: idCard）。
      ctx.fields.push(`unknown field: ${safeFieldLabel(key)}`);
      continue;
    }
    switch (key) {
      case 'age':
        addNumberField(ctx, input, key, 'age', { min: 1, max: 130, integer: true });
        break;
      case 'medicalHistory':
        addStringField(ctx, input, key, 'medicalHistory', 500);
        break;
      case 'medications':
        addStringField(ctx, input, key, 'medications', 500);
        break;
      case 'heightCm':
        addNumberField(ctx, input, key, 'heightCm', { min: 50, max: 250 });
        break;
      case 'weightKg':
        addNumberField(ctx, input, key, 'weightKg', { min: 20, max: 300 });
        break;
      case 'restingBloodPressure':
        addBloodPressureField(ctx, input, key, 'restingBloodPressure');
        break;
      case 'fastingGlucose':
        addFastingGlucoseField(ctx, input, key, 'fastingGlucose');
        break;
      case 'sleep':
        addNestedField(ctx, input, key, 'sleep', SLEEP_FIELD_SET, (raw, target, path) => {
          const previousValue = ctx.value;
          ctx.value = target;
          try {
            addNumberField(ctx, raw, 'hours', `${path}`, { min: 0, max: 24 });
            addBooleanField(ctx, raw, 'difficulty', `${path}`);
            addNumberField(ctx, raw, 'nightAwakenings', 'sleep.nightAwakenings', {
              min: 0, max: 20, integer: true
            });
          } finally {
            ctx.value = previousValue;
          }
        });
        break;
      case 'diet':
        addNestedField(ctx, input, key, 'diet', DIET_FIELD_SET, (raw, target, path) => {
          const previousValue = ctx.value;
          ctx.value = target;
          try {
            addBooleanField(ctx, raw, 'regular', 'diet.regular');
            addTasteField(ctx, raw, 'taste', 'diet.taste');
            addStringField(ctx, raw, 'restrictions', 'diet.restrictions', 200);
          } finally {
            ctx.value = previousValue;
          }
        });
        break;
      case 'exercise':
        addNestedField(ctx, input, key, 'exercise', EXERCISE_FIELD_SET, (raw, target, path) => {
          const previousValue = ctx.value;
          ctx.value = target;
          try {
            addNumberField(ctx, raw, 'timesPerWeek', 'exercise.timesPerWeek', {
              min: 0, max: 21, integer: true
            });
            addStringField(ctx, raw, 'types', 'exercise.types', 100);
          } finally {
            ctx.value = previousValue;
          }
        });
        break;
      case 'smoking':
        addStringField(ctx, input, key, 'smoking', 100);
        break;
      case 'alcohol':
        addStringField(ctx, input, key, 'alcohol', 100);
        break;
      case 'bowel':
        addStringField(ctx, input, key, 'bowel', 100);
        break;
      case 'mood':
        addStringField(ctx, input, key, 'mood', 200);
        break;
      case 'vision':
        addStringField(ctx, input, key, 'vision', 100);
        break;
      case 'hearing':
        addStringField(ctx, input, key, 'hearing', 100);
        break;
      default:
        // PROFILE_FIELD_SET 与 switch 必须同步；走到这里说明白名单被改坏了。
        ctx.fields.push(`unknown field: ${safeFieldLabel(key)}`);
        break;
    }
  }

  if (ctx.textBytes > HEALTH_PROFILE_TEXT_LIMIT) {
    ctx.fields.push(`total text must be at most ${HEALTH_PROFILE_TEXT_LIMIT} bytes`);
  }
  if (ctx.fields.length === 0 && Object.keys(ctx.value).length === 0) {
    ctx.fields.push('at least one health field is required');
  }
  if (ctx.fields.length > 0) return { ok: false, fields: ctx.fields };

  // 固定字段顺序，避免响应/快照字段顺序随客户端输入变化。
  const value = {};
  for (const field of PROFILE_FIELDS) {
    if (hasOwn(ctx.value, field)) value[field] = ctx.value[field];
  }
  return { ok: true, value };
}

/**
 * 校验已落盘的资料（严格模式）：除白名单外必须带服务端 updatedAt，
 * 且必须是规范化后的形态（字符串已 trim、空值已省略）。
 * 启动加载时用它 fail-closed，避免把被改坏或被注入的文件静默读进内存。
 *
 * @param {unknown} stored
 * @returns {{ok:true, value:object} | {ok:false, fields:string[]}}
 */
function validateStoredHealthProfile(stored) {
  if (!isPlainObject(stored)) return { ok: false, fields: ['profile must be an object'] };
  const updatedAt = stored.updatedAt;
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    return { ok: false, fields: ['updatedAt must be a non-negative safe integer'] };
  }
  const rest = { ...stored };
  delete rest.updatedAt;
  const validated = validateHealthProfile(rest);
  if (!validated.ok) return validated;
  if (canonicalJson(validated.value) !== canonicalJson(rest)) {
    return { ok: false, fields: ['stored profile is not normalized'] };
  }
  const ordered = orderHealthProfile(validated.value);
  ordered.updatedAt = updatedAt;
  return { ok: true, value: ordered };
}

/** 按固定白名单顺序重排资料字段（忽略未知字段，不复制它们）。 */
function orderHealthProfile(profile) {
  const out = {};
  if (!isPlainObject(profile)) return out;
  for (const field of PROFILE_FIELDS) {
    if (hasOwn(profile, field)) out[field] = profile[field];
  }
  return out;
}

/** 稳定 JSON 序列化（对象键递归排序），用于哈希与"落盘形态"比较。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** 资料内容哈希（sha256 十六进制），用于 AI 建议内存缓存键。 */
function hashHealthProfile(profile) {
  return crypto.createHash('sha256').update(canonicalJson(profile), 'utf8').digest('hex');
}

/**
 * 脱敏描述：只暴露"有哪些字段 + 文本总字节"，绝不含任何字段值。
 * 供日志/诊断/测试使用；正常请求链路不需要它。
 */
function describeHealthProfile(profile) {
  if (!isPlainObject(profile)) return Object.freeze({ fields: Object.freeze([]), textBytes: 0 });
  let textBytes = 0;
  for (const value of Object.values(profile)) {
    if (typeof value === 'string') textBytes += Buffer.byteLength(value, 'utf8');
    else if (isPlainObject(value)) {
      for (const nested of Object.values(value)) {
        if (typeof nested === 'string') textBytes += Buffer.byteLength(nested, 'utf8');
      }
    }
  }
  return Object.freeze({
    fields: Object.freeze(Object.keys(profile).sort()),
    textBytes
  });
}

/* ---- 健康域 ownerRef ---- */

/**
 * 由会话身份派生健康资料的不可反查 ownerRef（§1.8）：
 * h1_ + base64url(HMAC-SHA256(secret, "eldercare-health-owner:v1\0" + sub))。
 *
 * 与 comms 的 ownerRefFor（r1_ + 另一个域串）完全域分离，同一个 secret 和身份在
 * 两个域得到不同值，健康快照没法与交流台账互相反查。
 *
 * @param {string} secret 服务端密钥（≥32 字符），只存在于内存/Secret
 * @param {string} subject 会话身份（token 的 sub）
 * @returns {string}
 */
function healthOwnerRefFor(secret, subject) {
  const key = typeof secret === 'string' ? secret : '';
  const value = typeof subject === 'string' ? subject.trim() : '';
  if (key.length < 32) throw new Error('health owner ref secret must be at least 32 characters');
  if (value === '' || value.length > 512) throw new Error('subject is required to derive a health owner ref');
  const digest = crypto
    .createHmac('sha256', key)
    .update(`${HEALTH_OWNER_DOMAIN}${value}`, 'utf8')
    .digest('base64url');
  return `${HEALTH_OWNER_REF_PREFIX}${digest}`;
}

/** 是否为合法的健康域 ownerRef（存储加载时严格校验键名）。 */
function isHealthOwnerRef(value) {
  return typeof value === 'string' && HEALTH_OWNER_REF_RE.test(value);
}

module.exports = {
  ACUTE_SYMPTOM_PATTERN,
  DIET_FIELDS,
  EXERCISE_FIELDS,
  HEALTH_OWNER_DOMAIN,
  HEALTH_OWNER_REF_PREFIX,
  HEALTH_OWNER_REF_RE,
  HEALTH_PROFILE_BODY_LIMIT,
  HEALTH_PROFILE_TEXT_LIMIT,
  HEALTH_TASTES,
  IDENTITY_FIELDS,
  PROFILE_FIELDS,
  SLEEP_FIELDS,
  canonicalJson,
  describeHealthProfile,
  hashHealthProfile,
  healthOwnerRefFor,
  isHealthOwnerRef,
  isValidHealthOwnerRef: isHealthOwnerRef,
  isPlainObject,
  normalizeFieldName,
  orderHealthProfile,
  validateHealthProfile,
  validateStoredHealthProfile
};
