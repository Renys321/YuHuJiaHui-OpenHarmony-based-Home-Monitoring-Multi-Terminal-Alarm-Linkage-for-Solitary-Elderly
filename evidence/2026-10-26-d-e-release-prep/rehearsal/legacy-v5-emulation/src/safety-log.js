'use strict';

/**
 * safety-log.js — 告警处置结果 / 安全日志的**纯逻辑核心**
 *
 * 合同来源：`competition/evidence/2026-10-26-alert-disposition-safety-log/CONTRACT.md`
 * 任务：ALERT-DISPOSITION-SAFETY-LOG（v1 增量，schema v6）
 *
 * 定位与本轮边界（必须与结论一起引用）：
 *   - 处置结果是**独立于 ACK** 的人工处置记录（已联系家属/社区、现场确认正常、误报、其他）。
 *   - 本模块只做输入校验、公开形状投影与固定常量，不读写文件、不访问网络、不含任何密钥。
 *   - 本模块**不**调用 `store.requestAck()` / `store.completeCommand()`，也不生成 ACK 命令；
 *     处置≠确认，登记处置不得把告警改成 ACKED、不得清 `ackPending`、不得触发设备 reset。
 *   - 不使用客户端时间，也不接受客户端提供操作者身份：`serverTime` 由服务端 `Date.now()` 决定，
 *     `actor` 固定为单户部署下的通用角色 `household-guardian`（不落 openid/token/手机号）。
 *
 * 设计约束：
 *   - 纯函数、无 IO、不读 `process.env`；
 *   - `validateDispositionInput` 对任何输入（undefined / 数组 / 超长 / 控制字符）都不抛异常，
 *     只返回结构化结果；失败时**不回显**任何提交值；
 *   - 公开形状 `publicDisposition` 是严格白名单：内部字段（`clientDispositionId`/`actor`）不外泄。
 */

/* ------------------------------------------------------------ 处置结果枚举 */

/** 合同第 1 节的五个处置结果，顺序即 APP 展示顺序。 */
const DISPOSITION_OUTCOMES = Object.freeze([
  'CONTACTED_FAMILY',
  'CONTACTED_COMMUNITY',
  'ON_SITE_CONFIRMED_NORMAL',
  'FALSE_ALARM',
  'OTHER'
]);

const DISPOSITION_OUTCOME_SET = new Set(DISPOSITION_OUTCOMES);

/** outcome -> 固定展示文案（服务端唯一来源，APP 不得自行发明）。 */
const DISPOSITION_LABELS = Object.freeze({
  CONTACTED_FAMILY: '已联系家属',
  CONTACTED_COMMUNITY: '已联系社区',
  ON_SITE_CONFIRMED_NORMAL: '现场确认正常',
  FALSE_ALARM: '误报',
  OTHER: '其他说明'
});

/* ------------------------------------------------------------ 常量 / 正则 */

/** 持久化处置 ID：`dsp-<正整数>`，与合同 §3 完全一致。 */
const DISPOSITION_ID_RE = /^dsp-[1-9][0-9]{0,15}$/;
/** 客户端生成的幂等 ID：与留言客户端 ID 同规则（8-64 位，且不含 `..`）。 */
const CLIENT_DISPOSITION_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** 单户部署的通用操作者角色；与既有 ACK 审计约定一致，不落 openid/token。 */
const DISPOSITION_ACTOR = 'household-guardian';
/** 操作者角色 -> 展示用处理人名称。 */
const ACTOR_LABELS = Object.freeze({ 'household-guardian': '家庭监护人' });

/** 说明最多 200 字符（按 UTF-16 code unit 计数，与既有留言文本限制口径一致）。 */
const DISPOSITION_NOTE_MAX = 200;
/** 安全日志台账容量上限：超出按写入顺序淘汰最旧（告警本身不淘汰）。 */
const SAFETY_LOG_CAP = 2000;

/** 请求体字段白名单：其余字段一律 400（含 alarmId/deviceId/operator/serverTime/openid/...）。 */
const DISPOSITION_FIELDS = Object.freeze(['clientDispositionId', 'outcome', 'note']);
const DISPOSITION_FIELD_SET = new Set(DISPOSITION_FIELDS);

/** 公开形状白名单（见合同 §2.1 PublicDisposition）。 */
const PUBLIC_DISPOSITION_FIELDS = Object.freeze([
  'dispositionId', 'alarmId', 'deviceId', 'roomName', 'alarmType', 'alarmCreatedAt',
  'outcome', 'outcomeLabel', 'note', 'operator', 'operatorRole', 'serverTime'
]);

/** 持久化记录字段白名单（见合同 §3）。 */
const SAFETY_LOG_FIELDS = Object.freeze([
  'dispositionId', 'clientDispositionId', 'alarmId', 'deviceId', 'room', 'type',
  'outcome', 'note', 'actor', 'serverTime'
]);

/** C0 / DEL / C1 控制字符（含 \t \r \n，但 note 已先把换行归一成空格）。 */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

/* ------------------------------------------------------------ 校验 */

function isDispositionOutcome(value) {
  return typeof value === 'string' && DISPOSITION_OUTCOME_SET.has(value);
}

/**
 * 校验客户端生成的幂等 ID。
 * 与 comms-core 的 `isValidClientMessageId` 完全同一规则，并额外明确禁止 `..`，
 * 杜绝任何"点号组合成路径"的解读空间。
 */
function isValidClientDispositionId(value) {
  return typeof value === 'string' && CLIENT_DISPOSITION_ID_RE.test(value) && !value.includes('..');
}

/**
 * 归一化说明文本：`\r` / `\n` / `\r\n` 统一变成**一个**空格，再去掉首尾空白。
 * 非法输入（非字符串、超长、仍含控制字符）返回 `null`，不抛异常。
 *
 * @returns {string|null} 归一化后的文本（可能是空串），非法时为 null
 */
function normalizeDispositionNote(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n|[\r\n]/g, ' ').trim();
  if (text.length > DISPOSITION_NOTE_MAX) return null;
  if (CONTROL_CHAR_RE.test(text)) return null;
  return text;
}

/**
 * 校验并规范化一条处置提交。
 *
 * @param {*} input 请求体（JSON 解析结果，任意类型）
 * @returns {{ok: boolean, errors: object, value: {clientDispositionId: string, outcome: string, note: string}|null}}
 *   失败时 `errors` 只描述字段，**不回显提交值**（避免把 openid/token 之类反射回去）。
 */
function validateDispositionInput(input) {
  const errors = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: { body: '请求体必须是对象' }, value: null };
  }

  // 严格白名单：出现任何合同外字段即拒绝（客户端不得提交身份、设备、时间、告警 ID）。
  for (const key of Object.keys(input)) {
    if (!DISPOSITION_FIELD_SET.has(key)) errors[key] = '该字段不允许由客户端提交';
  }

  const clientDispositionId = typeof input.clientDispositionId === 'string'
    ? input.clientDispositionId.trim()
    : '';
  if (!isValidClientDispositionId(clientDispositionId)) {
    errors.clientDispositionId = '幂等 ID 必须是 8-64 位字母、数字、点、下划线或连字符，且不能包含 ..';
  }

  const outcome = typeof input.outcome === 'string' ? input.outcome : '';
  if (!isDispositionOutcome(outcome)) {
    errors.outcome = '必须是合同允许的处置结果';
  }

  let note = '';
  if (input.note !== undefined) {
    const normalized = normalizeDispositionNote(input.note);
    if (normalized === null) {
      errors.note = `说明必须是不含控制字符、且不超过 ${DISPOSITION_NOTE_MAX} 字符的字符串`;
    } else {
      note = normalized;
    }
  }

  if (Object.keys(errors).length === 0 && outcome === 'OTHER' && note === '') {
    errors.note = '选择“其他说明”时必须填写说明';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: {},
    value: Object.freeze({ clientDispositionId, outcome, note })
  };
}

/* ------------------------------------------------------------ 公开形状 */

/**
 * 把内部持久化记录投影成合同 §2.1 的 `PublicDisposition`。
 *
 * @param {object} record 内部安全日志记录（持久化白名单字段）
 * @param {object|null} [alarm] 对应告警（提供 `createdAt` 作为 `alarmCreatedAt`）；
 *   告警已不在时传 null/省略，`alarmCreatedAt` 归一为 0（APP 不得把它显示为有效时间）。
 * @returns {Readonly<object>} 只含合同公开字段的冻结对象
 */
function publicDisposition(record, alarm) {
  const source = record && typeof record === 'object' ? record : {};
  const alert = alarm && typeof alarm === 'object' ? alarm : null;
  const actor = typeof source.actor === 'string' && source.actor !== '' ? source.actor : DISPOSITION_ACTOR;
  const outcome = isDispositionOutcome(source.outcome) ? source.outcome : '';

  return Object.freeze({
    dispositionId: typeof source.dispositionId === 'string' ? source.dispositionId : '',
    alarmId: typeof source.alarmId === 'string' ? source.alarmId : '',
    deviceId: typeof source.deviceId === 'string' ? source.deviceId : '',
    roomName: typeof source.room === 'string' ? source.room : '',
    alarmType: typeof source.type === 'string' ? source.type : '',
    alarmCreatedAt: alert && Number.isSafeInteger(alert.createdAt) && alert.createdAt >= 0
      ? alert.createdAt
      : 0,
    outcome,
    outcomeLabel: outcome === '' ? '' : DISPOSITION_LABELS[outcome],
    note: typeof source.note === 'string' ? source.note : '',
    // operator 是展示名，operatorRole 是持久化的通用角色；两者都不携带 openid。
    operator: ACTOR_LABELS[actor] || '家庭监护人',
    operatorRole: actor,
    serverTime: Number.isSafeInteger(source.serverTime) && source.serverTime >= 0 ? source.serverTime : 0
  });
}

module.exports = {
  DISPOSITION_OUTCOMES,
  DISPOSITION_LABELS,
  DISPOSITION_ID_RE,
  DISPOSITION_FIELDS,
  PUBLIC_DISPOSITION_FIELDS,
  SAFETY_LOG_FIELDS,
  DISPOSITION_ACTOR,
  DISPOSITION_NOTE_MAX,
  SAFETY_LOG_CAP,
  isDispositionOutcome,
  isValidClientDispositionId,
  normalizeDispositionNote,
  validateDispositionInput,
  publicDisposition
};
