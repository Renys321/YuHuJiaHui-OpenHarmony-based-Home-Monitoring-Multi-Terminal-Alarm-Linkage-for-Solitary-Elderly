'use strict';

/**
 * persistent-store.js — 可信后端的持久化存储（PersistentStore）
 *
 * 定位：把 `store.js` 里的 `MemoryStore` 从纯内存原型推进为“可重启恢复”的单进程版本。
 * 它继承 MemoryStore 的全部查询语义，只覆盖会改变状态的方法
 * （`ingest` / `requestAck` / `completeCommand` / `createDisposition`），在每次成功变更后**同步原子落盘**。
 *
 * 落盘策略（不使用任何第三方依赖，也不使用实验性的 node:sqlite）：
 *   1. 只持久化 devices / alerts / commands / contacts / notifications / subscriptions /
 *      communications / safetyLogs 八个白名单字段，以及显式 `schemaVersion = 6`；
 *      密钥类字段永远不进入快照。
 *   2. 同目录临时文件（权限 0600）+ `fsync` + `rename` 覆盖目标文件，
 *      绝不对目标文件做半截写入；rename 成功后尽力 fsync 目录。
 *   3. 若写入抛错，立刻把内存回滚到变更前状态再向上抛，
 *      绝不出现“API 报失败但内存已经成功”的不一致。
 *
 * 启动加载会**严格校验**：顶层字段必须精确落在白名单内（未知字段如 token/secret 直接拒绝）、
 * `savedAt` 必须是非负安全整数、schema 版本、设备、告警、命令、联系人、通知账本字段，
 * 命令 ID 必须是正的安全整数且严格递增，以及 alert→device、command→alert 的关联关系。
 * 通知记录同样只允许固定字段（openid / unionid / appSecret / token / phone 一律以“未知字段”拒绝），
 * 且 (deviceId, alarmId) 交付键必须唯一。
 * 损坏 JSON、未知 schema、重复/乱序命令 ID、命令/告警绑定错误都会直接拒绝启动，而不是静默清空数据。
 * 兼容迁移：v1 为既有告警补空 evidenceId；v1/v2 快照没有 `notifications` 键时视为空账本，
 * v3/v4 快照没有 `communications` 键时视为空账本，v1..v5 快照没有 `safetyLogs` 键时视为空台账，
 * 下一次成功变更写回 v6。通知账本上限 500 条，超出时按 updatedAt 淘汰最旧记录。
 * 安全日志台账上限 2000 条，超出按写入顺序淘汰最旧；`dispositionId` 唯一且严格递增，
 * 记录必须指向已加载告警且 `deviceId` 一致，`(alarmId, clientDispositionId)` 幂等键唯一。
 *
 * 进程模型：**仅限单进程使用**。同一 filePath 不允许多进程/多实例并发写，
 * 本模块不实现跨进程文件锁；调用方必须保证只有一个后端进程持有该文件。
 *
 * 命令 ID：基于“已加载的最大持久化 ID + 1”单调分配（而不是数组长度 + 1），
 * 因此重启、删除或历史空洞都不会导致 ID 复用。
 */

const fs = require('node:fs');
const path = require('node:path');

const { ALARM_ID_RE, COMMAND_ID_RE, DEVICE_ID_RE, EVIDENCE_ID_RE, MemoryStore } = require('./store');
const {
  DISPOSITION_ACTOR,
  DISPOSITION_ID_RE,
  SAFETY_LOG_CAP,
  SAFETY_LOG_FIELDS,
  isDispositionOutcome,
  isValidClientDispositionId,
  normalizeDispositionNote
} = require('./safety-log');
const { LEASE_MS, MESSAGE_TTL_MS, createMessageId, applyEvent } = require('./comms-core');

/**
 * 快照 schema 版本。
 *   v1 -> v2：为既有告警补空 evidenceId。
 *   v2 -> v3：新增 notifications 投递台账。
 *   v3 -> v4：投递台账按 recipientRef 独立；新增 subscriptions 订阅授权额度。
 *   v4 -> v5：新增 communications 远程交流消息台账（监护人留言 + DAYU 播放 + 老人确认）。
 *   v5 -> v6：新增 safetyLogs 告警处置结果 / 安全日志台账（独立于 ACK）。
 * v1..v5 快照都能加载：缺失的键一律视为空集合，下一次成功变更写 v6。
 */
const SCHEMA_VERSION = 5;
const READABLE_SCHEMA_VERSIONS = new Set([1, 2, 3, 4, 5]);

const STATES = new Set(['NORMAL', 'WARN', 'ALARM', 'ACKED']);
const ALERT_STATES = new Set(['ALARM', 'ACKED']);
const COMMAND_STATUSES = new Set(['PENDING', 'ACKED', 'FAILED']);
const NOTIFICATION_STATUSES = new Set(['SENT', 'FAILED', 'PERMANENT_FAILED']);
const RESULT_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;
const PHONE_RE = /^[0-9+ -]{1,24}$/;

/** 内部身份引用：与通知模块同一个不可反查前缀（绝不保存 openid）。 */
const RECIPIENT_REF_RE = /^r1_[A-Za-z0-9_-]{32,64}$/;
/** 交流消息状态（与 comms-core 的状态机一致）。 */
const COMM_MESSAGE_STATES = new Set(['QUEUED', 'DELIVERED', 'PLAYED', 'ACKED', 'FAILED', 'EXPIRED']);
/** 设备只能回报这四种事件；EXPIRED 由服务端在超时或读取时推导。 */
const COMM_DEVICE_EVENTS = new Set(['DELIVERED', 'PLAYED', 'ACKED', 'FAILED']);
const COMM_EVENTS = new Set(['DELIVERED', 'PLAYED', 'ACKED', 'FAILED', 'EXPIRED']);
const COMM_MESSAGE_ID_RE = /^cmsg-[A-Za-z0-9._-]{6,58}$/;
const COMM_CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const COMM_VOICE_IDS = new Set([
  'CHECK_IN', 'PLEASE_RESPOND', 'MEDICINE_REMINDER', 'FAMILY_MESSAGE', 'EMERGENCY_CONTACTING'
]);
const COMM_TEXT_MAX = 120;
/** 交流消息台账上限：超过后按 updatedAt 淘汰最旧。 */
const COMMUNICATION_CAP = 300;
/** 交流消息允许出现的字段（白名单：绝不持久化 openid/token/手机号/精确坐标）。 */
const COMMUNICATION_FIELDS = [
  'messageId', 'clientMessageId', 'ownerRef', 'deviceId', 'text', 'voiceId', 'requestAck',
  'status', 'createdAt', 'updatedAt', 'deliveredAt', 'playedAt', 'acknowledgedAt', 'failedAt',
  'expiredAt', 'expiresAt', 'failureCode', 'leaseId', 'leaseExpiresAt', 'attempts'
];
const COMMUNICATION_FIELD_SET = new Set(COMMUNICATION_FIELDS);

/** 通知模板 ID：订阅消息模板 ID 的实际字符集（1..64 位）。 */
const NOTIFICATION_TEMPLATE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 订阅授权事件 ID：客户端生成的幂等键（仅用于去重，不含个人信息）。 */
const GRANT_EVENT_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
/** 通知账本上限：超过 500 条时按 updatedAt 淘汰最旧条目（见 _trimNotifications）。 */
const NOTIFICATION_CAP = 500;
/** 订阅授权账本上限（按 recipientRef 计，最多也就是允许名单规模）。 */
const SUBSCRIPTION_CAP = 200;
/** 每个收件人保留的授权事件 ID 上限（去重窗口）。 */
const GRANT_EVENT_CAP = 32;
/** 通知记录允许出现的字段（白名单：绝不持久化 openid/unionid/appSecret/token/phone）。 */
const NOTIFICATION_FIELDS = [
  'deviceId', 'alarmId', 'recipientRef', 'templateId', 'status',
  'attempts', 'attemptCount', 'sentAt', 'updatedAt', 'errorCode'
];
const NOTIFICATION_FIELD_SET = new Set(NOTIFICATION_FIELDS);
/** 订阅授权记录允许出现的字段。 */
const SUBSCRIPTION_FIELDS = [
  'recipientRef', 'templateId', 'totalGranted', 'consumed', 'revoked', 'grantEventIds', 'grantedAt', 'updatedAt'
];
const SUBSCRIPTION_FIELD_SET = new Set(SUBSCRIPTION_FIELDS);

/** 安全日志记录允许出现的字段（白名单：绝不持久化 openid/token/手机号）。 */
const SAFETY_LOG_FIELD_SET = new Set(SAFETY_LOG_FIELDS);

/** 快照允许出现的顶层字段（白名单，防止把配置/密钥带进文件）。 */
const SNAPSHOT_KEYS = [
  'schemaVersion', 'savedAt', 'devices', 'alerts', 'commands', 'contacts', 'notifications', 'subscriptions',
  'communications', 'safetyLogs'
];
const SNAPSHOT_KEY_SET = new Set(SNAPSHOT_KEYS);

let tempCounter = 0;

function fail(message) {
  throw new Error(message);
}

/**
 * 幂等键：deviceId / clientMessageId 字符集都不含 '|'，ownerRef 也不含，拼接无歧义。
 */
function communicationClientKey(ownerRef, deviceId, clientMessageId) {
  return `${ownerRef}|${deviceId}|${clientMessageId}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function boundedText(value, max, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function safeNonNegativeInt(value, name, prefix = 'persistent store corrupt: ') {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${prefix}${name} must be a non-negative safe integer`);
  return value;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------ 内存 -> 快照 */

function deviceToDocument(device) {
  return {
    deviceId: device.deviceId,
    room: device.room,
    online: device.online,
    monitorOnline: device.monitorOnline,
    state: device.state,
    ts: device.ts,
    receivedAt: device.receivedAt,
    sensors: cloneJson(device.sensors) || {},
    alarm: {
      id: device.alarm.id,
      type: device.alarm.type,
      countToday: device.alarm.countToday,
      evidenceId: device.alarm.evidenceId || ''
    },
    gps: {
      valid: device.gps.valid,
      latitude: device.gps.latitude,
      longitude: device.gps.longitude,
      fixTime: device.gps.fixTime
    },
    csq: device.csq
  };
}

function alertToDocument(alert) {
  return {
    alarmId: alert.alarmId,
    deviceId: alert.deviceId,
    room: alert.room,
    type: alert.type,
    createdAt: alert.createdAt,
    status: alert.status,
    ackPending: alert.ackPending,
    acknowledgedAt: alert.acknowledgedAt,
    acknowledgedBy: alert.acknowledgedBy,
    action: alert.action,
    evidenceId: alert.evidenceId || ''
  };
}

function commandToDocument(command) {
  const document = {
    id: command.id,
    createdAt: command.createdAt,
    requestedBy: command.requestedBy,
    deviceId: command.deviceId,
    command: command.command,
    alarmId: command.alarmId,
    action: command.action,
    status: command.status
  };
  if (command.completedAt !== undefined) document.completedAt = command.completedAt;
  if (command.resultCode !== undefined) document.resultCode = command.resultCode;
  return document;
}

function contactToDocument(contact) {
  return {
    id: contact.id,
    name: contact.name,
    relation: contact.relation,
    phone: contact.phone,
    primary: contact.primary
  };
}

function notificationToDocument(record) {
  return {
    deviceId: record.deviceId,
    alarmId: record.alarmId,
    recipientRef: record.recipientRef,
    templateId: record.templateId,
    status: record.status,
    attempts: record.attempts,
    attemptCount: record.attemptCount,
    sentAt: record.sentAt,
    updatedAt: record.updatedAt,
    errorCode: record.errorCode || ''
  };
}

function subscriptionToDocument(record) {
  return {
    recipientRef: record.recipientRef,
    templateId: record.templateId,
    totalGranted: record.totalGranted,
    consumed: record.consumed,
    revoked: record.revoked || 0,
    grantEventIds: [...(record.grantEventIds || [])],
    grantedAt: record.grantedAt,
    updatedAt: record.updatedAt
  };
}

function communicationToDocument(record) {
  return {
    messageId: record.messageId,
    clientMessageId: record.clientMessageId,
    ownerRef: record.ownerRef,
    deviceId: record.deviceId,
    text: record.text,
    voiceId: record.voiceId,
    requestAck: record.requestAck === true,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deliveredAt: record.deliveredAt || 0,
    playedAt: record.playedAt || 0,
    acknowledgedAt: record.acknowledgedAt || 0,
    failedAt: record.failedAt || 0,
    expiredAt: record.expiredAt || 0,
    expiresAt: record.expiresAt || 0,
    failureCode: record.failureCode || '',
    leaseId: record.leaseId || '',
    leaseExpiresAt: record.leaseExpiresAt || 0,
    attempts: record.attempts || 0
  };
}

/** 安全日志记录 -> 持久化文档（严格白名单，合同 §3 的十个字段）。 */
function safetyLogToDocument(record) {
  return {
    dispositionId: record.dispositionId,
    clientDispositionId: record.clientDispositionId,
    alarmId: record.alarmId,
    deviceId: record.deviceId,
    room: record.room,
    type: record.type,
    outcome: record.outcome,
    note: record.note,
    actor: record.actor,
    serverTime: record.serverTime
  };
}

/* ------------------------------------------------------------ 快照 -> 内存（严格校验） */
function deviceFromDocument(raw, index) {
  const at = `device[${index}]`;
  if (!isPlainObject(raw)) fail(`persistent store corrupt: ${at} must be an object`);
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) fail(`persistent store corrupt: ${at}.deviceId`);
  if (!STATES.has(raw.state)) fail(`persistent store corrupt: ${at}.state`);
  const monitorOnline = raw.monitorOnline === undefined ? -1 : raw.monitorOnline;
  if (!Number.isSafeInteger(monitorOnline) || ![-1, 0, 1].includes(monitorOnline)) {
    fail(`persistent store corrupt: ${at}.monitorOnline`);
  }
  if (!isPlainObject(raw.alarm)) fail(`persistent store corrupt: ${at}.alarm`);
  const alarmId = typeof raw.alarm.id === 'string' ? raw.alarm.id : '';
  if (alarmId && !ALARM_ID_RE.test(alarmId)) fail(`persistent store corrupt: ${at}.alarm.id`);
  const evidenceId = raw.alarm.evidenceId === undefined ? '' : raw.alarm.evidenceId;
  if (typeof evidenceId !== 'string' || (evidenceId && !EVIDENCE_ID_RE.test(evidenceId))) {
    fail(`persistent store corrupt: ${at}.alarm.evidenceId`);
  }
  if (!isPlainObject(raw.gps)) fail(`persistent store corrupt: ${at}.gps`);
  if (!isPlainObject(raw.sensors)) fail(`persistent store corrupt: ${at}.sensors`);

  return {
    deviceId: raw.deviceId,
    room: boundedText(raw.room, 32, '未分配'),
    online: raw.online !== false,
    monitorOnline,
    state: raw.state,
    ts: safeNonNegativeInt(raw.ts, `${at}.ts`),
    receivedAt: safeNonNegativeInt(raw.receivedAt, `${at}.receivedAt`),
    sensors: cloneJson(raw.sensors) || {},
    alarm: {
      id: alarmId,
      type: boundedText(raw.alarm.type, 32),
      countToday: Number.isSafeInteger(raw.alarm.countToday) && raw.alarm.countToday >= 0 ? raw.alarm.countToday : 0,
      evidenceId
    },
    gps: {
      valid: raw.gps.valid === true,
      latitude: finiteOrNull(raw.gps.latitude),
      longitude: finiteOrNull(raw.gps.longitude),
      fixTime: Number.isSafeInteger(raw.gps.fixTime) && raw.gps.fixTime >= 0 ? raw.gps.fixTime : 0
    },
    csq: Number.isInteger(raw.csq) && raw.csq >= 0 && raw.csq <= 99 ? raw.csq : null
  };
}

function alertFromDocument(raw, index) {
  const at = `alert[${index}]`;
  if (!isPlainObject(raw)) fail(`persistent store corrupt: ${at} must be an object`);
  if (typeof raw.alarmId !== 'string' || !ALARM_ID_RE.test(raw.alarmId)) fail(`persistent store corrupt: ${at}.alarmId`);
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) fail(`persistent store corrupt: ${at}.deviceId`);
  if (!ALERT_STATES.has(raw.status)) fail(`persistent store corrupt: ${at}.status`);
  const evidenceId = raw.evidenceId === undefined ? '' : raw.evidenceId;
  if (typeof evidenceId !== 'string' || (evidenceId && !EVIDENCE_ID_RE.test(evidenceId))) {
    fail(`persistent store corrupt: ${at}.evidenceId`);
  }

  return {
    alarmId: raw.alarmId,
    deviceId: raw.deviceId,
    room: boundedText(raw.room, 32, '未分配'),
    type: boundedText(raw.type, 32),
    createdAt: safeNonNegativeInt(raw.createdAt, `${at}.createdAt`),
    status: raw.status,
    ackPending: raw.ackPending === true,
    acknowledgedAt: Number.isSafeInteger(raw.acknowledgedAt) && raw.acknowledgedAt >= 0 ? raw.acknowledgedAt : 0,
    acknowledgedBy: typeof raw.acknowledgedBy === 'string' ? raw.acknowledgedBy.slice(0, 64) : '',
    action: boundedText(raw.action, 120),
    evidenceId
  };
}

function commandFromDocument(raw, index) {
  const at = `command[${index}]`;
  if (!isPlainObject(raw)) fail(`persistent store corrupt: ${at} must be an object`);
  if (typeof raw.id !== 'string' || !COMMAND_ID_RE.test(raw.id)) fail(`persistent store corrupt: ${at}.id`);
  // 正则只保证 1-16 位数字；如 "9999999999999999" 会通过正则但 Number 不是安全整数，
  // 会让 _maxCommandId 失效并可能复用 id=1，因此这里必须再校验一次。
  const numericId = Number(raw.id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    fail(`persistent store corrupt: ${at}.id is not a safe positive integer`);
  }
  if (raw.command !== 'ACK') fail(`persistent store corrupt: ${at}.command`);
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) fail(`persistent store corrupt: ${at}.deviceId`);
  if (typeof raw.alarmId !== 'string' || !ALARM_ID_RE.test(raw.alarmId)) fail(`persistent store corrupt: ${at}.alarmId`);
  if (!COMMAND_STATUSES.has(raw.status)) fail(`persistent store corrupt: ${at}.status`);
  if (typeof raw.action !== 'string' || raw.action.trim().length === 0 || raw.action.length > 120) {
    fail(`persistent store corrupt: ${at}.action`);
  }

  const command = {
    id: raw.id,
    createdAt: safeNonNegativeInt(raw.createdAt, `${at}.createdAt`),
    requestedBy: typeof raw.requestedBy === 'string' ? raw.requestedBy.slice(0, 64) : '',
    deviceId: raw.deviceId,
    command: 'ACK',
    alarmId: raw.alarmId,
    action: raw.action,
    status: raw.status
  };
  if (raw.status === 'PENDING') return command;

  command.completedAt = safeNonNegativeInt(raw.completedAt, `${at}.completedAt`);
  if (raw.status === 'FAILED') {
    if (typeof raw.resultCode !== 'string' || !RESULT_CODE_RE.test(raw.resultCode)) {
      fail(`persistent store corrupt: ${at}.resultCode`);
    }
    command.resultCode = raw.resultCode;
  } else {
    command.resultCode = '';
  }
  return command;
}

function contactFromDocument(raw, index) {
  const at = `contact[${index}]`;
  if (!isPlainObject(raw)) fail(`persistent store corrupt: ${at} must be an object`);
  if (typeof raw.phone !== 'string' || !PHONE_RE.test(raw.phone)) fail(`persistent store corrupt: ${at}.phone`);

  return {
    id: boundedText(raw.id, 64, `contact-${index + 1}`),
    name: boundedText(raw.name, 40, '联系人'),
    relation: boundedText(raw.relation, 24),
    phone: raw.phone,
    primary: raw.primary === true
  };
}

/**
 * 投递键：deviceId / alarmId / recipientRef 的字符集都不含 '|'，所以拼接不存在歧义。
 * v4 起按**收件人**独立记录，幂等键为 deviceId + alarmId + recipientRef。
 */
function notificationKey(deviceId, alarmId, recipientRef) {
  return `${deviceId}|${alarmId}|${recipientRef}`;
}

/** 订阅键：recipientRef 本身。 */
function subscriptionKey(recipientRef) {
  return recipientRef;
}

/**
 * 校验并冻结一条通知投递记录。
 * label 用于错误定位（加载时是 `notification[i]`，写入时是 `input`）；prefix 区分
 * “快照损坏”与“调用方传入非法记录”两种失败语义。
 * 记录字段是白名单：openid / unionid / appSecret / token / phone 之类一旦出现即拒绝，
 * 保证通知账本里不可能持久化任何身份或密钥。收件人只以 recipientRef 形式出现。
 */
function normalizeNotification(raw, label, prefix) {
  if (!isPlainObject(raw)) fail(`${prefix}${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!NOTIFICATION_FIELD_SET.has(key)) fail(`${prefix}unknown field ${key} in ${label}`);
  }
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) fail(`${prefix}${label}.deviceId`);
  if (typeof raw.alarmId !== 'string' || !ALARM_ID_RE.test(raw.alarmId)) fail(`${prefix}${label}.alarmId`);
  if (typeof raw.recipientRef !== 'string' || !RECIPIENT_REF_RE.test(raw.recipientRef)) {
    fail(`${prefix}${label}.recipientRef`);
  }
  if (typeof raw.templateId !== 'string' || !NOTIFICATION_TEMPLATE_ID_RE.test(raw.templateId)) {
    fail(`${prefix}${label}.templateId`);
  }
  if (!NOTIFICATION_STATUSES.has(raw.status)) fail(`${prefix}${label}.status`);
  // attempts 是“成功发送所需的尝试序号”，必须 >= 1；attemptCount 是累计尝试次数，允许 0。
  if (!Number.isSafeInteger(raw.attempts) || raw.attempts < 1) fail(`${prefix}${label}.attempts`);
  if (!Number.isSafeInteger(raw.attemptCount) || raw.attemptCount < 0) fail(`${prefix}${label}.attemptCount`);
  const errorCode = raw.errorCode === undefined ? '' : raw.errorCode;
  if (typeof errorCode !== 'string' || (errorCode && !RESULT_CODE_RE.test(errorCode))) {
    fail(`${prefix}${label}.errorCode`);
  }
  return Object.freeze({
    deviceId: raw.deviceId,
    alarmId: raw.alarmId,
    recipientRef: raw.recipientRef,
    templateId: raw.templateId,
    status: raw.status,
    attempts: raw.attempts,
    attemptCount: raw.attemptCount,
    sentAt: safeNonNegativeInt(raw.sentAt, `${label}.sentAt`, prefix),
    updatedAt: safeNonNegativeInt(raw.updatedAt, `${label}.updatedAt`, prefix),
    errorCode
  });
}

/**
 * 校验并冻结一条订阅授权额度记录。
 *
 * 语义：`totalGranted` 是用户累计接受的次数（每次 accept 记 1）；`consumed` 是
 * **微信确认发送成功**后消耗掉的次数；`revoked` 是被服务端作废的次数
 * （例如微信返回 43101 用户永久拒收时把本地可用额度校正为 0）。
 * 可用额度 = totalGranted - consumed - revoked。
 * `grantEventIds` 是客户端生成的授权事件 ID 去重窗口（有界，不含个人信息）。
 * 记录里同样不允许出现 openid 或任何密钥。
 */
function normalizeSubscription(raw, label, prefix) {
  if (!isPlainObject(raw)) fail(`${prefix}${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!SUBSCRIPTION_FIELD_SET.has(key)) fail(`${prefix}unknown field ${key} in ${label}`);
  }
  if (typeof raw.recipientRef !== 'string' || !RECIPIENT_REF_RE.test(raw.recipientRef)) {
    fail(`${prefix}${label}.recipientRef`);
  }
  if (typeof raw.templateId !== 'string' || !NOTIFICATION_TEMPLATE_ID_RE.test(raw.templateId)) {
    fail(`${prefix}${label}.templateId`);
  }
  const totalGranted = safeNonNegativeInt(raw.totalGranted, `${label}.totalGranted`, prefix);
  const consumed = safeNonNegativeInt(raw.consumed, `${label}.consumed`, prefix);
  // revoked 是 v4 新增字段；缺失视为 0，兼容同版本内更早写入的记录。
  const revoked = raw.revoked === undefined ? 0 : safeNonNegativeInt(raw.revoked, `${label}.revoked`, prefix);
  if (consumed + revoked > totalGranted) fail(`${prefix}${label}.consumed + revoked exceeds totalGranted`);
  const eventIds = raw.grantEventIds === undefined ? [] : raw.grantEventIds;
  if (!Array.isArray(eventIds) || eventIds.length > GRANT_EVENT_CAP) {
    fail(`${prefix}${label}.grantEventIds`);
  }
  for (const eventId of eventIds) {
    if (typeof eventId !== 'string' || !GRANT_EVENT_ID_RE.test(eventId)) {
      fail(`${prefix}${label}.grantEventIds entry`);
    }
  }
  return Object.freeze({
    recipientRef: raw.recipientRef,
    templateId: raw.templateId,
    totalGranted,
    consumed,
    revoked,
    grantEventIds: Object.freeze([...eventIds]),
    grantedAt: safeNonNegativeInt(raw.grantedAt, `${label}.grantedAt`, prefix),
    updatedAt: safeNonNegativeInt(raw.updatedAt, `${label}.updatedAt`, prefix)
  });
}

/**
 * 校验并冻结一条远程交流消息记录。
 *
 * 字段是严格白名单：openid / unionid / token / phone / 精确坐标一旦出现即拒绝，
 * 因此交流台账里不可能持久化任何身份或密钥。内部身份只用 `ownerRef`（不可反查引用）。
 */
function normalizeCommunication(raw, label, prefix) {
  if (!isPlainObject(raw)) fail(`${prefix}${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!COMMUNICATION_FIELD_SET.has(key)) fail(`${prefix}unknown field ${key} in ${label}`);
  }
  if (typeof raw.messageId !== 'string' || !COMM_MESSAGE_ID_RE.test(raw.messageId)) fail(`${prefix}${label}.messageId`);
  if (typeof raw.clientMessageId !== 'string' || !COMM_CLIENT_ID_RE.test(raw.clientMessageId) || raw.clientMessageId.includes('..')) {
    fail(`${prefix}${label}.clientMessageId`);
  }
  if (typeof raw.ownerRef !== 'string' || !RECIPIENT_REF_RE.test(raw.ownerRef)) fail(`${prefix}${label}.ownerRef`);
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) fail(`${prefix}${label}.deviceId`);
  if (typeof raw.text !== 'string' || raw.text.length === 0 || raw.text.length > COMM_TEXT_MAX) fail(`${prefix}${label}.text`);
  if (typeof raw.voiceId !== 'string' || !COMM_VOICE_IDS.has(raw.voiceId)) fail(`${prefix}${label}.voiceId`);
  if (typeof raw.requestAck !== 'boolean') fail(`${prefix}${label}.requestAck`);
  if (typeof raw.status !== 'string' || !COMM_MESSAGE_STATES.has(raw.status)) fail(`${prefix}${label}.status`);
  const failureCode = raw.failureCode === undefined ? '' : raw.failureCode;
  if (typeof failureCode !== 'string' || (failureCode !== '' && !RESULT_CODE_RE.test(failureCode))) {
    fail(`${prefix}${label}.failureCode`);
  }
  const leaseId = raw.leaseId === undefined ? '' : raw.leaseId;
  if (typeof leaseId !== 'string' || (leaseId !== '' && !/^[A-Za-z0-9._-]{4,64}$/.test(leaseId))) {
    fail(`${prefix}${label}.leaseId`);
  }
  return Object.freeze({
    messageId: raw.messageId,
    clientMessageId: raw.clientMessageId,
    ownerRef: raw.ownerRef,
    deviceId: raw.deviceId,
    text: raw.text,
    voiceId: raw.voiceId,
    requestAck: raw.requestAck,
    status: raw.status,
    createdAt: safeNonNegativeInt(raw.createdAt, `${label}.createdAt`, prefix),
    updatedAt: safeNonNegativeInt(raw.updatedAt, `${label}.updatedAt`, prefix),
    deliveredAt: raw.deliveredAt === undefined ? 0 : safeNonNegativeInt(raw.deliveredAt, `${label}.deliveredAt`, prefix),
    playedAt: raw.playedAt === undefined ? 0 : safeNonNegativeInt(raw.playedAt, `${label}.playedAt`, prefix),
    acknowledgedAt: raw.acknowledgedAt === undefined ? 0 : safeNonNegativeInt(raw.acknowledgedAt, `${label}.acknowledgedAt`, prefix),
    failedAt: raw.failedAt === undefined ? 0 : safeNonNegativeInt(raw.failedAt, `${label}.failedAt`, prefix),
    expiredAt: raw.expiredAt === undefined ? 0 : safeNonNegativeInt(raw.expiredAt, `${label}.expiredAt`, prefix),
    expiresAt: raw.expiresAt === undefined ? 0 : safeNonNegativeInt(raw.expiresAt, `${label}.expiresAt`, prefix),
    failureCode,
    leaseId,
    leaseExpiresAt: raw.leaseExpiresAt === undefined ? 0 : safeNonNegativeInt(raw.leaseExpiresAt, `${label}.leaseExpiresAt`, prefix),
    attempts: raw.attempts === undefined ? 0 : safeNonNegativeInt(raw.attempts, `${label}.attempts`, prefix)
  });
}

/**
 * 校验并冻结一条安全日志（告警处置结果）记录。
 *
 * 字段是严格白名单：openid / token / 手机号 / 客户端时间 / 操作者身份一旦出现即拒绝。
 * 处置结果是**独立于 ACK** 的台账，因此这里不包含任何告警状态或命令字段。
 * `note` 必须是"已归一化"的文本（CR/LF 已换成空格、已 trim、无控制字符、≤200 字符），
 * 否则视为损坏快照 fail-fast，避免同一条记录在内存与文件里出现两种形态。
 */
function normalizeSafetyLog(raw, label, prefix) {
  if (!isPlainObject(raw)) fail(`${prefix}${label} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!SAFETY_LOG_FIELD_SET.has(key)) fail(`${prefix}unknown field ${key} in ${label}`);
  }
  if (typeof raw.dispositionId !== 'string' || !DISPOSITION_ID_RE.test(raw.dispositionId)) {
    fail(`${prefix}${label}.dispositionId`);
  }
  const numericId = Number(raw.dispositionId.slice(4));
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    // 正则允许 16 位数字，但超过安全整数会让 ID 单调分配失效并可能复用，必须显式拒绝。
    fail(`${prefix}${label}.dispositionId is not a safe positive integer`);
  }
  if (typeof raw.clientDispositionId !== 'string' || !isValidClientDispositionId(raw.clientDispositionId)) {
    fail(`${prefix}${label}.clientDispositionId`);
  }
  if (typeof raw.alarmId !== 'string' || !ALARM_ID_RE.test(raw.alarmId)) fail(`${prefix}${label}.alarmId`);
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) fail(`${prefix}${label}.deviceId`);
  if (typeof raw.room !== 'string' || raw.room.length > 32) fail(`${prefix}${label}.room`);
  if (typeof raw.type !== 'string' || raw.type.length > 32) fail(`${prefix}${label}.type`);
  if (!isDispositionOutcome(raw.outcome)) fail(`${prefix}${label}.outcome`);
  const note = typeof raw.note === 'string' ? normalizeDispositionNote(raw.note) : null;
  if (note === null || note !== raw.note) fail(`${prefix}${label}.note`);
  if (raw.outcome === 'OTHER' && note === '') fail(`${prefix}${label}.note must not be empty for OTHER`);
  if (raw.actor !== DISPOSITION_ACTOR) fail(`${prefix}${label}.actor`);
  return Object.freeze({
    dispositionId: raw.dispositionId,
    clientDispositionId: raw.clientDispositionId,
    alarmId: raw.alarmId,
    deviceId: raw.deviceId,
    room: raw.room,
    type: raw.type,
    outcome: raw.outcome,
    note,
    actor: raw.actor,
    serverTime: safeNonNegativeInt(raw.serverTime, `${label}.serverTime`, prefix)
  });
}

/* ------------------------------------------------------------ 原子写入 */
/**
 * 默认原子写入：同目录临时文件（0600）-> fsync -> rename。
 * 目标文件要么保持旧内容，要么是完整新内容，不会被写坏。
 */
function atomicWriteFile(filePath, text) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  tempCounter += 1;
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${tempCounter}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 忽略：保持原始错误 */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* 忽略：临时文件可能尚未创建 */ }
    throw error;
  }
  // rename 已让新内容出现在目标路径；再尽力 fsync 目录，让目录项也落盘。
  // Windows 上目录 fsync 可能不被支持，此处失败不影响正确性。
  try {
    const dirFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* 尽力而为 */ }
}

/* ------------------------------------------------------------ PersistentStore */

class PersistentStore extends MemoryStore {
  /**
   * @param {object} options
   * @param {string}   options.filePath      快照文件路径（必填）；父目录会自动创建
   * @param {Array}    [options.contacts]    初始联系人；仅在文件不存在时作为初始状态
   * @param {Function} [options.atomicWriter] 测试注入点：(filePath, text) => void；默认走临时文件 + fsync + rename
   */
  constructor(options = {}) {
    if (!isPlainObject(options)) fail('options must be a plain object');
    const filePath = options.filePath;
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      fail('filePath must be a non-empty string');
    }

    super(options);

    this.filePath = path.resolve(filePath);
    /** 已持久化/已分配的最大命令 ID，保证重启后不复用。 */
    this._maxCommandId = 0;
    /** 已持久化/已分配的最大处置 ID（`dsp-<n>` 的 n），保证重启后不复用、不重复。 */
    this._maxDispositionId = 0;
    /**
     * 通知投递账本：键为 (deviceId|alarmId|recipientRef)，保持插入顺序，上限 NOTIFICATION_CAP。
     * 必须在 _load() 之前初始化：文件不存在（首次启动）时 _load 会直接返回，
     * 不会经过 _loadDocument 的赋值路径。
     */
    this.notifications = new Map();
    /** 订阅授权账本：键为 recipientRef（HMAC 派生，绝不是 openid），上限 SUBSCRIPTION_CAP。 */
    this.subscriptions = new Map();
    /** 远程交流消息台账：键为 messageId，上限 COMMUNICATION_CAP（v5 新增）。 */
    this.communications = new Map();
    /** 原子写入实现；测试可注入以模拟磁盘故障。 */
    this._atomicWriter = typeof options.atomicWriter === 'function' ? options.atomicWriter : atomicWriteFile;

    this._load();
  }

  /* ---------------------------------------------------------- 启动加载 */

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // 首次启动：保持空状态（使用构造函数传入的 contacts），第一次成功变更才落盘。
        this._maxCommandId = 0;
        return;
      }
      fail(`persistent store unreadable: ${error && error.message ? error.message : String(error)}`);
    }

    let document;
    try {
      document = JSON.parse(text);
    } catch {
      fail('persistent store corrupt: invalid JSON');
    }
    this._loadDocument(document);
  }

  _loadDocument(document) {
    if (!isPlainObject(document)) fail('persistent store corrupt: root must be an object');
    // 顶层字段必须精确等于白名单；未知字段（尤其 token/secret 之类）拒绝启动，绝不静默忽略。
    for (const key of Object.keys(document)) {
      if (!SNAPSHOT_KEY_SET.has(key)) fail(`persistent store corrupt: unknown top-level field ${key}`);
    }
    if (!READABLE_SCHEMA_VERSIONS.has(document.schemaVersion)) {
      fail(`persistent store unsupported schemaVersion: ${String(document.schemaVersion)}`);
    }
    if (!Number.isSafeInteger(document.savedAt) || document.savedAt < 0) {
      fail('persistent store corrupt: savedAt must be a non-negative safe integer');
    }
    if (!Array.isArray(document.devices)) fail('persistent store corrupt: devices must be an array');
    if (!Array.isArray(document.alerts)) fail('persistent store corrupt: alerts must be an array');
    if (!Array.isArray(document.commands)) fail('persistent store corrupt: commands must be an array');
    if (!Array.isArray(document.contacts)) fail('persistent store corrupt: contacts must be an array');
    // v1/v2/v3 快照没有 notifications / subscriptions 键：视为空账本（向后兼容），
    // 而不是拒绝加载；下一次成功变更会写 v4 快照。
    const rawNotifications = document.notifications === undefined ? [] : document.notifications;
    if (!Array.isArray(rawNotifications)) fail('persistent store corrupt: notifications must be an array');
    const rawSubscriptions = document.subscriptions === undefined ? [] : document.subscriptions;
    if (!Array.isArray(rawSubscriptions)) fail('persistent store corrupt: subscriptions must be an array');
    const rawCommunications = document.communications === undefined ? [] : document.communications;
    if (!Array.isArray(rawCommunications)) fail('persistent store corrupt: communications must be an array');
    // v1..v5 快照没有 safetyLogs 键：视为空台账（向后兼容），下一次成功变更写 v6。
    const rawSafetyLogs = document.safetyLogs === undefined ? [] : document.safetyLogs;
    if (!Array.isArray(rawSafetyLogs)) fail('persistent store corrupt: safetyLogs must be an array');
    if (rawSafetyLogs.length > SAFETY_LOG_CAP) {
      fail(`persistent store corrupt: safetyLogs exceeds capacity ${SAFETY_LOG_CAP}`);
    }

    const devices = new Map();
    for (let index = 0; index < document.devices.length; index += 1) {
      const device = deviceFromDocument(document.devices[index], index);
      if (devices.has(device.deviceId)) fail(`persistent store corrupt: duplicate device id ${device.deviceId}`);
      devices.set(device.deviceId, device);
    }

    const alerts = new Map();
    for (let index = 0; index < document.alerts.length; index += 1) {
      const alert = alertFromDocument(document.alerts[index], index);
      if (alerts.has(alert.alarmId)) fail(`persistent store corrupt: duplicate alarm id ${alert.alarmId}`);
      alerts.set(alert.alarmId, alert);
    }

    const commands = [];
    const commandIds = new Set();
    let previousCommandId = 0;
    for (let index = 0; index < document.commands.length; index += 1) {
      const command = commandFromDocument(document.commands[index], index);
      if (commandIds.has(command.id)) fail(`persistent store corrupt: duplicate command id ${command.id}`);
      // 命令 ID 必须严格递增（允许 1、3 这类空洞，但拒绝 3、1 或相等），
      // 否则 listCommands 的顺序会破坏边缘 cursor 的单调契约。
      const numericId = Number(command.id);
      if (numericId <= previousCommandId) {
        fail(`persistent store corrupt: command ids must be strictly increasing (${command.id} after ${previousCommandId})`);
      }
      commandIds.add(command.id);
      previousCommandId = numericId;
      commands.push(command);
    }

    const contacts = document.contacts.map((raw, index) => contactFromDocument(raw, index));

    const notifications = new Map();
    for (let index = 0; index < rawNotifications.length; index += 1) {
      const record = normalizeNotification(rawNotifications[index], `notification[${index}]`, 'persistent store corrupt: ');
      const key = notificationKey(record.deviceId, record.alarmId, record.recipientRef);
      if (notifications.has(key)) fail(`persistent store corrupt: duplicate notification delivery key ${key}`);
      notifications.set(key, record);
    }

    const subscriptions = new Map();
    for (let index = 0; index < rawSubscriptions.length; index += 1) {
      const record = normalizeSubscription(rawSubscriptions[index], `subscription[${index}]`, 'persistent store corrupt: ');
      const key = subscriptionKey(record.recipientRef);
      if (subscriptions.has(key)) fail(`persistent store corrupt: duplicate subscription key ${key}`);
      subscriptions.set(key, record);
    }

    const communications = new Map();
    const clientKeys = new Set();
    for (let index = 0; index < rawCommunications.length; index += 1) {
      const record = normalizeCommunication(rawCommunications[index], `communication[${index}]`, 'persistent store corrupt: ');
      if (communications.has(record.messageId)) {
        fail(`persistent store corrupt: duplicate communication messageId ${record.messageId}`);
      }
      // 幂等键必须唯一，否则同一 clientMessageId 会产生两条消息。
      const clientKey = communicationClientKey(record.ownerRef, record.deviceId, record.clientMessageId);
      if (clientKeys.has(clientKey)) {
        fail(`persistent store corrupt: duplicate communication idempotency key ${clientKey}`);
      }
      clientKeys.add(clientKey);
      communications.set(record.messageId, record);
    }

    // 关联关系：告警必须指向已知设备；命令必须绑定到 deviceId 一致的告警。
    const evidenceBindings = new Set();
    for (const alert of alerts.values()) {
      if (alert.evidenceId) {
        if (evidenceBindings.has(alert.evidenceId)) fail('persistent store corrupt: duplicate evidence binding');
        evidenceBindings.add(alert.evidenceId);
      }
      if (!devices.has(alert.deviceId)) {
        fail(`persistent store corrupt: alert ${alert.alarmId} references unknown device ${alert.deviceId}`);
      }
      const device = devices.get(alert.deviceId);
      if (device.alarm.id === alert.alarmId && device.alarm.evidenceId && alert.evidenceId &&
          device.alarm.evidenceId !== alert.evidenceId) {
        fail(`persistent store corrupt: alert ${alert.alarmId} evidence binding mismatch`);
      }
    }
    for (const command of commands) {
      const alert = alerts.get(command.alarmId);
      if (!alert) fail(`persistent store corrupt: command ${command.id} references unknown alarm ${command.alarmId}`);
      if (alert.deviceId !== command.deviceId) {
        fail(`persistent store corrupt: command ${command.id} alert binding mismatch`);
      }
    }

    // 安全日志：ID 唯一且严格递增、(alarmId, clientDispositionId) 幂等键唯一，
    // 且每条记录必须指向已加载告警并与其 deviceId 一致（绝不留下悬空处置记录）。
    const safetyLogs = [];
    const dispositionIds = new Set();
    const dispositionClientKeys = new Set();
    let previousDispositionId = 0;
    for (let index = 0; index < rawSafetyLogs.length; index += 1) {
      const record = normalizeSafetyLog(rawSafetyLogs[index], `safetyLog[${index}]`, 'persistent store corrupt: ');
      if (dispositionIds.has(record.dispositionId)) {
        fail(`persistent store corrupt: duplicate disposition id ${record.dispositionId}`);
      }
      const numericId = Number(record.dispositionId.slice(4));
      if (numericId <= previousDispositionId) {
        fail(`persistent store corrupt: disposition ids must be strictly increasing (${record.dispositionId} after ${previousDispositionId})`);
      }
      const alert = alerts.get(record.alarmId);
      if (!alert) {
        fail(`persistent store corrupt: safety log ${record.dispositionId} references unknown alarm ${record.alarmId}`);
      }
      if (alert.deviceId !== record.deviceId) {
        fail(`persistent store corrupt: safety log ${record.dispositionId} device binding mismatch`);
      }
      // alarmId 不含 '|'，clientDispositionId 也不含，拼接无歧义。
      const clientKey = `${record.alarmId}|${record.clientDispositionId}`;
      if (dispositionClientKeys.has(clientKey)) {
        fail(`persistent store corrupt: duplicate safety log client key ${clientKey}`);
      }
      dispositionClientKeys.add(clientKey);
      dispositionIds.add(record.dispositionId);
      previousDispositionId = numericId;
      safetyLogs.push(record);
    }

    // 已强校验严格递增，因此最后一个命令 ID 就是最大 ID。
    this.devices = devices;
    this.alerts = alerts;
    this.commands = commands;
    this.contacts = contacts;
    this.notifications = notifications;
    this.subscriptions = subscriptions;
    this.communications = communications;
    this.safetyLogs = safetyLogs;
    this._maxCommandId = previousCommandId;
    this._maxDispositionId = previousDispositionId;
  }

  /* ---------------------------------------------------------- 快照 / 回滚 */

  _document() {
    return {
      schemaVersion: SCHEMA_VERSION,
      savedAt: Date.now(),
      devices: [...this.devices.values()].map(deviceToDocument),
      alerts: [...this.alerts.values()].map(alertToDocument),
      commands: this.commands.map(commandToDocument),
      contacts: this.contacts.map(contactToDocument),
      notifications: [...this.notifications.values()].map(notificationToDocument),
      subscriptions: [...this.subscriptions.values()].map(subscriptionToDocument),
      communications: [...this.communications.values()].map(communicationToDocument)
    };
  }

  /** 深拷贝当前可变状态，用于写入失败时回滚。 */
  _captureState() {
    return {
      devices: [...this.devices.values()].map(deviceToDocument),
      alerts: [...this.alerts.values()].map(alertToDocument),
      commands: this.commands.map(commandToDocument),
      contacts: this.contacts.map(contactToDocument),
      notifications: [...this.notifications.values()].map(notificationToDocument),
      subscriptions: [...this.subscriptions.values()].map(subscriptionToDocument),
      communications: [...this.communications.values()].map(communicationToDocument),
      safetyLogs: this.safetyLogs.map(safetyLogToDocument),
      maxCommandId: this._maxCommandId,
      maxDispositionId: this._maxDispositionId
    };
  }

  _restoreState(snapshot) {
    this.devices = new Map(snapshot.devices.map((device) => [device.deviceId, device]));
    this.alerts = new Map(snapshot.alerts.map((alert) => [alert.alarmId, alert]));
    this.commands = snapshot.commands;
    this.contacts = snapshot.contacts;
    this.notifications = new Map(snapshot.notifications.map((record) => [
      notificationKey(record.deviceId, record.alarmId, record.recipientRef),
      Object.freeze({ ...record })
    ]));
    this.subscriptions = new Map(snapshot.subscriptions.map((record) => [
      subscriptionKey(record.recipientRef),
      Object.freeze({ ...record })
    ]));
    this.communications = new Map(snapshot.communications.map((record) => [record.messageId, record]));
    this.safetyLogs = snapshot.safetyLogs;
    this._maxCommandId = snapshot.maxCommandId;
    this._maxDispositionId = snapshot.maxDispositionId;
  }

  _flush() {
    const text = `${JSON.stringify(this._document(), null, 2)}\n`;
    this._atomicWriter(this.filePath, text);
  }

  /** 同步落盘；失败则回滚内存到 snapshot 并抛出，绝不返回虚假成功。 */
  _commit(snapshot) {
    try {
      this._flush();
    } catch (error) {
      this._restoreState(snapshot);
      throw error;
    }
  }

  _nextCommandId() {
    if (!Number.isSafeInteger(this._maxCommandId) || this._maxCommandId < 0) this._maxCommandId = 0;
    const next = this._maxCommandId + 1;
    // 超出安全整数范围或无法通过 COMMAND_ID_RE 时必须 fail-fast，
    // 绝不允许产生非法 ID（否则会再次出现复用/非单调）。
    if (!Number.isSafeInteger(next) || next <= 0 || !COMMAND_ID_RE.test(String(next))) {
      fail('command id space exhausted');
    }
    this._maxCommandId = next;
    return next;
  }

  /* ---------------------------------------------------------- 覆盖的变更入口 */

  ingest(input, receivedAt = Date.now()) {
    const snapshot = this._captureState();
    const status = super.ingest(input, receivedAt);
    this._commit(snapshot);
    return status;
  }

  /**
   * 与 MemoryStore.requestAck 语义一致，但命令 ID 取“已持久化最大 ID + 1”，
   * 且成功后同步落盘。无变化（告警不存在/已 ACKED/已有 PENDING）时不写盘。
   */
  requestAck(alarmId, action, requestedBy, now = Date.now()) {
    if (!ALARM_ID_RE.test(alarmId || '')) throw new Error('invalid alarm id');
    const alert = this.alerts.get(alarmId);
    if (!alert) return null;
    if (alert.status === 'ACKED') throw new Error('alarm already acknowledged');
    const cleanAction = boundedText(action, 120, '监护人已确认').replace(/\r|\n/g, ' ');
    const pending = this.commands.find((item) => item.alarmId === alarmId && item.status === 'PENDING');
    if (pending) return pending;

    const snapshot = this._captureState();
    const command = {
      id: String(this._nextCommandId()),
      createdAt: now,
      requestedBy: typeof requestedBy === 'string' ? requestedBy : '',
      deviceId: alert.deviceId,
      command: 'ACK',
      alarmId,
      action: cleanAction,
      status: 'PENDING'
    };
    this.commands.push(command);
    alert.ackPending = true;
    alert.action = cleanAction;
    this._commit(snapshot);
    return command;
  }

  completeCommand(commandId, result, now = Date.now()) {
    const prior = this.commands.find((item) => item.id === commandId);
    const priorStatus = prior ? prior.status : null;
    const snapshot = this._captureState();
    const command = super.completeCommand(commandId, result, now);
    // 只有真正从 PENDING 变为终态才算一次变更；幂等重复回写不写盘。
    if (command && priorStatus === 'PENDING') this._commit(snapshot);
    return command;
  }

  /**
   * 登记处置结果：成功后同步落盘；**仅首次创建写盘**（幂等重放与冲突都不写盘）。
   *
   * 处置台账与 ACK 完全解耦：本方法不调用 `requestAck`/`completeCommand`，
   * 因此不会生成 ACK 命令，也不会把告警改成 ACKED 或清 `ackPending`。
   * 写盘失败时回滚内存（含 `_maxDispositionId`），绝不返回虚假成功。
   */
  createDisposition(input, now = Date.now()) {
    const snapshot = this._captureState();
    const result = super.createDisposition(input, now);
    if (result && result.created === true) this._commit(snapshot);
    return result;
  }

  /** 分配处置 ID：基于已持久化最大 ID + 1 单调递增（重启/淘汰后都不复用、不重复）。 */
  _nextDispositionId() {
    if (!Number.isSafeInteger(this._maxDispositionId) || this._maxDispositionId < 0) {
      this._maxDispositionId = 0;
    }
    const next = this._maxDispositionId + 1;
    if (!Number.isSafeInteger(next) || next <= 0 || !DISPOSITION_ID_RE.test(`dsp-${next}`)) {
      fail('disposition id space exhausted');
    }
    this._maxDispositionId = next;
    return `dsp-${next}`;
  }

  /** 覆盖内存实现的"扫台账取最大 ID"，保证跨重启的单调性。 */
  _allocateDispositionId() {
    return this._nextDispositionId();
  }

  /** 台账容量上限：按写入顺序淘汰最旧（必须在写盘前调用）。 */
  _trimSafetyLogs() {
    if (this.safetyLogs.length <= SAFETY_LOG_CAP) return;
    this.safetyLogs.splice(0, this.safetyLogs.length - SAFETY_LOG_CAP);
  }

  /* ---------------------------------------------------------- 通知投递账本 */

  /**
   * 读取一条通知投递记录；不存在返回 null。
   * 幂等键是 (deviceId, alarmId, recipientRef)——**按收件人独立**，
   * 这样一个收件人成功不会掩盖另一个收件人的失败。
   */
  readNotification(deviceId, alarmId, recipientRef) {
    if (typeof deviceId !== 'string' || typeof alarmId !== 'string' || typeof recipientRef !== 'string') return null;
    return this.notifications.get(notificationKey(deviceId, alarmId, recipientRef)) || null;
  }

  /** 全部通知记录，按插入顺序（稳定顺序）。 */
  listNotifications() {
    return [...this.notifications.values()];
  }

  countNotifications() {
    return this.notifications.size;
  }

  /**
   * 按 (deviceId, alarmId, recipientRef) 插入或覆盖一条通知投递记录，成功后同步原子落盘。
   * 同一投递键重复写入只保留一条（幂等，不产生无界增长）；
   * 超过 500 条时先按 updatedAt 淘汰最旧记录再写盘；写入失败回滚内存并抛出。
   */
  upsertNotification(record) {
    const stored = normalizeNotification(record, 'input', 'invalid notification: ');
    const snapshot = this._captureState();
    this.notifications.set(notificationKey(stored.deviceId, stored.alarmId, stored.recipientRef), stored);
    this._trimNotifications();
    this._commit(snapshot);
    return stored;
  }

  /** 上限淘汰：按 updatedAt 从旧到新（同值保持插入顺序）删除多余条目；必须在写盘前调用。 */
  _trimNotifications() {
    if (this.notifications.size <= NOTIFICATION_CAP) return;
    const excess = this.notifications.size - NOTIFICATION_CAP;
    const ordered = [...this.notifications.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let index = 0; index < excess; index += 1) this.notifications.delete(ordered[index][0]);
  }

  /* ---------------------------------------------------------- 订阅授权账本 */

  /** 读取一个收件人的订阅授权额度记录；不存在返回 null。key 是 recipientRef，不是 openid。 */
  readSubscription(recipientRef) {
    if (typeof recipientRef !== 'string') return null;
    return this.subscriptions.get(subscriptionKey(recipientRef)) || null;
  }

  /** 全部订阅授权记录，按插入顺序。 */
  listSubscriptions() {
    return [...this.subscriptions.values()];
  }

  countSubscriptions() {
    return this.subscriptions.size;
  }

  /**
   * 登记一次订阅授权（用户 accept / acceptWithAudio）。
   *
   * 幂等：同一 (recipientRef, grantEventId) 重复登记只记一次额度，返回 `duplicate: true`。
   * 每次**新**的授权事件把 totalGranted 加 1（一次性订阅：接受一次，可推送一条）。
   * `grantEventIds` 只保留最近 GRANT_EVENT_CAP 个事件 ID（去重窗口有界）。
   *
   * @returns {Readonly<{record: object, duplicate: boolean, remaining: number}>}
   */
  grantSubscription(recipientRef, templateId, grantEventId, now = Date.now()) {
    if (typeof grantEventId !== 'string' || !GRANT_EVENT_ID_RE.test(grantEventId)) {
      fail('invalid grant event id');
    }
    const snapshot = this._captureState();
    const existing = this.subscriptions.get(subscriptionKey(recipientRef));
    const eventIds = existing ? [...existing.grantEventIds] : [];
    const duplicate = eventIds.includes(grantEventId);
    const record = normalizeSubscription({
      recipientRef,
      templateId: templateId || (existing ? existing.templateId : ''),
      totalGranted: (existing ? existing.totalGranted : 0) + (duplicate ? 0 : 1),
      consumed: existing ? existing.consumed : 0,
      revoked: existing ? existing.revoked || 0 : 0,
      grantEventIds: duplicate ? eventIds : [...eventIds, grantEventId].slice(-GRANT_EVENT_CAP),
      grantedAt: existing ? existing.grantedAt : now,
      updatedAt: now
    }, 'input', 'invalid subscription: ');
    if (!duplicate) {
      this.subscriptions.set(subscriptionKey(record.recipientRef), record);
      this._trimSubscriptions();
      this._commit(snapshot);
    }
    return Object.freeze({
      record,
      duplicate,
      remaining: Math.max(0, record.totalGranted - record.consumed - record.revoked)
    });
  }

  /**
   * 消耗一次可用额度（微信确认发送成功后才调用）。
   * 没有可用额度时返回 `{ ok: false, reason: 'no_quota' }`，绝不把额度消耗成负数。
   */
  consumeSubscription(recipientRef, now = Date.now()) {
    const existing = this.subscriptions.get(subscriptionKey(recipientRef));
    if (!existing) return Object.freeze({ ok: false, reason: 'no_grant', remaining: 0 });
    if (existing.totalGranted - existing.consumed - (existing.revoked || 0) <= 0) {
      return Object.freeze({ ok: false, reason: 'no_quota', remaining: 0 });
    }
    const snapshot = this._captureState();
    const record = normalizeSubscription({
      ...existing,
      consumed: existing.consumed + 1,
      updatedAt: now
    }, 'input', 'invalid subscription: ');
    this.subscriptions.set(subscriptionKey(record.recipientRef), record);
    this._commit(snapshot);
    return Object.freeze({
      ok: true,
      remaining: Math.max(0, record.totalGranted - record.consumed - record.revoked)
    });
  }

  /**
   * 把一个收件人的本地可用额度校正为 0（微信返回 43101 用户永久拒收时调用）。
   *
   * 用独立的 `revoked` 计数而不是把 `consumed` 拉满：永久拒收**不是一次成功发送**，
   * 混进 consumed 会让台账说谎。可用额度 = totalGranted - consumed - revoked。
   */
  revokeSubscriptionQuota(recipientRef, now = Date.now()) {
    const existing = this.subscriptions.get(subscriptionKey(recipientRef));
    if (!existing) return null;
    const currentRevoked = existing.revoked || 0;
    if (existing.totalGranted - existing.consumed - currentRevoked <= 0) return existing;
    const snapshot = this._captureState();
    const record = normalizeSubscription({
      ...existing,
      revoked: existing.totalGranted - existing.consumed,
      updatedAt: now
    }, 'input', 'invalid subscription: ');
    this.subscriptions.set(subscriptionKey(record.recipientRef), record);
    this._commit(snapshot);
    return record;
  }

  /** 上限淘汰：按 updatedAt 从旧到新删除多余订阅记录；必须在写盘前调用。 */
  _trimSubscriptions() {
    if (this.subscriptions.size <= SUBSCRIPTION_CAP) return;
    const excess = this.subscriptions.size - SUBSCRIPTION_CAP;
    const ordered = [...this.subscriptions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let index = 0; index < excess; index += 1) this.subscriptions.delete(ordered[index][0]);
  }

  /* ---------------------------------------------------------- 远程交流消息台账 */

  /**
   * 创建（或按幂等键复用）一条监护人留言。
   *
   * 幂等键 = ownerRef + deviceId + clientMessageId。同一键重试绝不产生第二条记录。
   * 成功后同步原子落盘；写失败回滚内存。
   *
   * @returns {{created: boolean, message: object}}
   */
  createCommunication(input) {
    if (!isPlainObject(input)) fail('invalid communication: input must be an object');
    const ownerRef = input.ownerRef;
    const deviceId = input.deviceId;
    const clientMessageId = input.clientMessageId;
    const text = input.text;
    const voiceId = input.voiceId;
    const requestAck = input.requestAck;
    const now = Number.isSafeInteger(input.now) && input.now >= 0 ? input.now : Date.now();
    const expiresAt = Number.isSafeInteger(input.expiresAt) && input.expiresAt > 0
      ? input.expiresAt
      : now + MESSAGE_TTL_MS;
    const cap = Number.isSafeInteger(input.messageCap) && input.messageCap >= 1
      ? input.messageCap
      : COMMUNICATION_CAP;

    // 先做一次完整形状校验（含白名单），再查幂等键。
    const draft = normalizeCommunication({
      messageId: typeof input.messageId === 'string' && COMM_MESSAGE_ID_RE.test(input.messageId)
        ? input.messageId
        : createMessageId(now),
      clientMessageId,
      ownerRef,
      deviceId,
      text,
      voiceId,
      requestAck,
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
      expiresAt,
      attempts: 0
    }, 'input', 'invalid communication: ');

    const existing = this._findCommunicationByClientKey(ownerRef, deviceId, clientMessageId);
    if (existing) {
      const conflict = existing.text !== draft.text || existing.voiceId !== draft.voiceId ||
        existing.requestAck !== draft.requestAck;
      return { created: false, conflict, message: existing };
    }

    const snapshot = this._captureState();
    this.communications.set(draft.messageId, draft);
    this._trimCommunications(cap);
    this._commit(snapshot);
    return { created: true, conflict: false, message: draft };
  }

  /** 按消息 ID 读取；不存在或输入非法返回 null（不抛异常）。 */
  getCommunication(messageId) {
    if (typeof messageId !== 'string' || !COMM_MESSAGE_ID_RE.test(messageId)) return null;
    return this.communications.get(messageId) || null;
  }

  /**
   * 列出交流消息。支持按 ownerRef / deviceId 过滤，按 createdAt 倒序（最新在前）。
   */
  listCommunications(options = {}) {
    const ownerRef = typeof options.ownerRef === 'string' ? options.ownerRef : '';
    const deviceId = typeof options.deviceId === 'string' ? options.deviceId : '';
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50;
    const all = [...this.communications.values()]
      .filter((item) => (ownerRef === '' || item.ownerRef === ownerRef))
      .filter((item) => (deviceId === '' || item.deviceId === deviceId))
      .sort((a, b) => (b.createdAt - a.createdAt) || a.messageId.localeCompare(b.messageId));
    return all.slice(0, limit);
  }

  countCommunications() {
    return this.communications.size;
  }

  /**
   * 领取属于该设备的待处理消息（带租约，避免并发轮询重复播放）。
   *
   * 可领取条件：属于该设备、状态 QUEUED/DELIVERED、且（无租约或租约已过期）。
   * DELIVERED 也可重领，避免代理在回报 DELIVERED 后、播放完成前崩溃造成永久卡死。
   * 过期消息在领取时被推导为 EXPIRED（并落盘），不再返回。
   *
   * @returns {Array<object>} 已施加租约的消息（FIFO）
   */
  claimCommunications(deviceId, options = {}) {
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
      throw new Error('invalid communication: deviceId');
    }
    const now = Number.isSafeInteger(options.now) && options.now >= 0 ? options.now : Date.now();
    const leaseId = typeof options.leaseId === 'string' && /^[A-Za-z0-9._-]{4,64}$/.test(options.leaseId)
      ? options.leaseId
      : '';
    if (leaseId === '') throw new Error('invalid communication: leaseId');
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 10;

    const snapshot = this._captureState();
    let dirty = false;
    const claimed = [];

    const candidates = [...this.communications.values()]
      .filter((item) => item.deviceId === deviceId)
      .sort((a, b) => (a.createdAt - b.createdAt) || a.messageId.localeCompare(b.messageId));

    for (const item of candidates) {
      if (claimed.length >= limit) break;
      if (item.status !== 'QUEUED' && item.status !== 'DELIVERED') continue;
      // 过期即 EXPIRED（终态），不再投递。
      if (item.expiresAt > 0 && now >= item.expiresAt) {
        const expired = Object.freeze({
          ...item, status: 'EXPIRED', updatedAt: now, expiredAt: now, leaseId: '', leaseExpiresAt: 0
        });
        this.communications.set(item.messageId, expired);
        dirty = true;
        continue;
      }
      // 已被别人持有且租约未过期：跳过，避免重复播放。
      if (item.leaseId !== '' && item.leaseExpiresAt > now) continue;
      const leased = Object.freeze({
        ...item,
        leaseId,
        leaseExpiresAt: now + LEASE_MS,
        attempts: (item.attempts || 0) + 1,
        updatedAt: now
      });
      this.communications.set(item.messageId, leased);
      claimed.push(leased);
      dirty = true;
    }

    if (dirty) this._commit(snapshot);
    return claimed;
  }

  /**
   * 回报一条交流消息的状态。
   *
   * 只接受事件名（DELIVERED/PLAYED/ACKED/FAILED）；状态迁移由 applyEvent 严格判定：
   * 合法迁移 -> changed=true；重复回报 -> changed=false（幂等）；非法迁移 -> rejected=true。
   * 设备只能回报属于自己的消息。DELIVERED/PLAYED/FAILED 必须携带当前租约；
   * 租约过期但尚未被接管时仍可回报，被新代理接管后旧租约会被拒绝。
   */
  reportCommunication(messageId, event, options = {}) {
    if (typeof messageId !== 'string' || !COMM_MESSAGE_ID_RE.test(messageId)) {
      throw new Error('invalid communication id');
    }
    if (typeof event !== 'string' || !COMM_EVENTS.has(event)) {
      throw new Error('invalid communication event');
    }
    const now = Number.isSafeInteger(options.now) && options.now >= 0 ? options.now : Date.now();
    const deviceId = typeof options.deviceId === 'string' ? options.deviceId : '';
    const item = this.communications.get(messageId);
    if (!item) return { changed: false, rejected: true, reason: 'not_found', message: null };

    // EXPIRED 是服务端推导事件；所有设备事件都必须明确携带正确 deviceId。
    if (event !== 'EXPIRED' && item.deviceId !== deviceId) {
      return { changed: false, rejected: true, reason: 'device_mismatch', message: item };
    }
    // 未领取过的消息不得直接进入 PLAYED/ACKED（必须先 DELIVERED）。
    if ((event === 'PLAYED' || event === 'ACKED') && item.status === 'QUEUED') {
      return { changed: false, rejected: true, reason: 'not_claimed', message: item };
    }

    // 设备事件里 EXPIRED 不是合法回报（由服务端推导），其余交给状态机。
    if (event === 'EXPIRED' && item.status !== 'QUEUED' && item.status !== 'DELIVERED') {
      return { changed: false, rejected: true, reason: 'not_expirable', message: item };
    }
    if (event !== 'EXPIRED' && !COMM_DEVICE_EVENTS.has(event)) {
      return { changed: false, rejected: true, reason: 'invalid_device_event', message: item };
    }

    // ACKED is a later physical/user action and does not belong to the playback lease.
    // Repeated state reports remain idempotent even after the lease was cleared.
    const targetState = event;
    const completedIdempotentReport = item.status === targetState && item.leaseId === '';
    if (event !== 'EXPIRED' && event !== 'ACKED' && !completedIdempotentReport) {
      const leaseId = typeof options.leaseId === 'string' ? options.leaseId : '';
      if (item.leaseId === '') {
        return { changed: false, rejected: true, reason: 'lease_required', message: item };
      }
      if (leaseId === '' || leaseId !== item.leaseId) {
        return { changed: false, rejected: true, reason: 'lease_mismatch', message: item };
      }
    }

    const outcome = applyEvent(item, event, now, { failureCode: options.failureCode });
    if (!outcome.changed) return outcome;

    const snapshot = this._captureState();
    const stored = normalizeCommunication(outcome.message, 'input', 'invalid communication: ');
    this.communications.set(messageId, stored);
    this._commit(snapshot);
    return { changed: true, rejected: false, reason: 'ok', message: stored };
  }

  /** 内部：按幂等键查找（扫描有界台账，无需额外索引）。 */
  _findCommunicationByClientKey(ownerRef, deviceId, clientMessageId) {
    for (const item of this.communications.values()) {
      if (item.ownerRef === ownerRef && item.deviceId === deviceId && item.clientMessageId === clientMessageId) {
        return item;
      }
    }
    return null;
  }

  /**
   * 按给定时刻回收**已过期**的非终态消息为 EXPIRED。
   *
   * 与 claimCommunications 里的即时推导互补：这里用于周期性清理，
   * 让"过期"成为持久化事实，而不是只在某次读取时才临时推导。
   *
   * @returns {string[]} 被置为 EXPIRED 的 messageId（有界）
   */
  expireCommunications(now = Date.now()) {
    const at = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
    const snapshot = this._captureState();
    const expired = [];
    for (const item of [...this.communications.values()]) {
      if (item.status !== 'QUEUED' && item.status !== 'DELIVERED') continue;
      if (!(item.expiresAt > 0) || at < item.expiresAt) continue;
      this.communications.set(item.messageId, Object.freeze({
        ...item, status: 'EXPIRED', updatedAt: at, expiredAt: at, leaseId: '', leaseExpiresAt: 0
      }));
      expired.push(item.messageId);
    }
    if (expired.length > 0) this._commit(snapshot);
    return expired;
  }

  /** 上限淘汰：按 updatedAt 从旧到新删除多余交流消息；必须在写盘前调用。 */
  _trimCommunications(cap = COMMUNICATION_CAP) {
    if (this.communications.size <= cap) return;
    const excess = this.communications.size - cap;
    const ordered = [...this.communications.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let index = 0; index < excess; index += 1) this.communications.delete(ordered[index][0]);
  }
}

module.exports = {
  SCHEMA_VERSION,
  SNAPSHOT_KEYS,
  NOTIFICATION_FIELDS,
  SUBSCRIPTION_FIELDS,
  NOTIFICATION_CAP,
  SUBSCRIPTION_CAP,
  GRANT_EVENT_CAP,
  PersistentStore
};
