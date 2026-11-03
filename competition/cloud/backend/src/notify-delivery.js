'use strict';

/**
 * 告警订阅消息投递：把一条本地告警（deviceId + alarmId）转成模板字段，只发给调用方
 * 给定的已授权监护人，本模块不读配置。
 *
 * 幂等按 (deviceId, alarmId) 做，已 SENT 的不重发；临时失败（超时、网络、429、5xx、
 * token 失效）按指数退避重试，永久失败（用户拒收、非法 openid、模板无效、页面不存在）
 * 立即停止。每次尝试都写台账，进程重启后仍能判断幂等并继续未完成的重试。
 *
 * 绝不阻塞设备摄入、ACK 或主服务：调用方只能 fire-and-forget，所有异常在本模块内收敛成
 * 结构化结果，不向调用方抛。台账只存 deviceId / alarmId / templateId 与状态计数，
 * 不保存 openid、unionid、access_token、AppSecret、手机号或精确坐标。
 */

const { boundText, redactLine, safeLogLine, recipientRefFor } = require('./notify-privacy');
const { NOTIFY_CODES, TokenManager, assertProvider, notifyError } = require('./notify-provider');

/** 字段与文案上限（微信 thing/time 类型限制）。 */
const MAX_FIELD_CHARS = 20;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8000;

const ALARM_TYPE_LABELS = Object.freeze({
  FALL: '跌倒报警',
  MANUAL_SOS: '一键求助',
  NO_MOTION: '长时间无活动',
  GAS: '燃气异常',
  SMOKE: '烟雾异常',
  DOOR: '门磁异常',
  UNKNOWN: '检测到异常'
});

/** 台账状态（按收件人）。 */
const DELIVERY_STATUS = Object.freeze({
  SENT: 'SENT',
  FAILED: 'FAILED',
  PERMANENT_FAILED: 'PERMANENT_FAILED'
});

/** 整体投递状态：ALL_SENT 全部已发送，PARTIAL 部分成功，FAILED 一个都没成功，NO_RECIPIENTS 没有可投递收件人。 */
const AGGREGATE_STATUS = Object.freeze({
  ALL_SENT: 'ALL_SENT',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  NO_RECIPIENTS: 'NO_RECIPIENTS'
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 单行化 + 去控制字符 + 按「字符」截断（微信按字符计数，不是字节）。 */
function templateField(value, maxChars = MAX_FIELD_CHARS) {
  const text = String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim();
  if (text.length === 0) return '—';
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** 把毫秒时间戳格式化为 `YYYY-MM-DD HH:mm`（本地时区，供模板展示）。 */
function formatAlarmTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '——';
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function alarmTypeLabel(type) {
  const key = String(type || '').toUpperCase();
  return ALARM_TYPE_LABELS[key] || ALARM_TYPE_LABELS.UNKNOWN;
}

/**
 * 构造订阅消息模板数据，字段名对应「告警通知」模板的常规四个位置。真实模板字段名要
 * 和申请到的一致，所以这里只保证格式与长度，不假设模板 ID。
 *
 * @param {object} alarm { deviceId, alarmId, room, type, createdAt }
 * @returns {object} 冻结的 data 对象
 */
function buildTemplateData(alarm) {
  const source = isPlainObject(alarm) ? alarm : {};
  return Object.freeze({
    thing1: Object.freeze({ value: templateField(source.room || '未分配') }),
    thing2: Object.freeze({ value: templateField(alarmTypeLabel(source.type)) }),
    time3: Object.freeze({ value: formatAlarmTime(source.createdAt) }),
    thing4: Object.freeze({ value: templateField(source.deviceId ? `${source.deviceId} 告警` : '设备告警') })
  });
}

/**
 * 指数退避：base * 2^(attempt-1)，上限 max，attempt 从 1 开始。
 */
function backoffDelayMs(attempt, config) {
  const base = Number.isSafeInteger(config && config.baseDelayMs) ? config.baseDelayMs : DEFAULT_BASE_DELAY_MS;
  const max = Number.isSafeInteger(config && config.maxDelayMs) ? config.maxDelayMs : DEFAULT_MAX_DELAY_MS;
  const safeAttempt = Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : 1;
  return Math.min(Math.max(1, max), Math.max(1, base) * Math.pow(2, Math.min(safeAttempt - 1, 20)));
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 不阻止进程退出：通知重试不应把后端钉在事件循环里。
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 校验并规范化告警条目，非法输入返回 null 由调用方跳过，不抛异常。
 */
function normalizeAlarmInput(alarm) {
  if (!isPlainObject(alarm)) return null;
  const deviceId = boundText(String(alarm.deviceId || ''), 64);
  const alarmId = boundText(String(alarm.alarmId || alarm.id || ''), 80);
  if (!deviceId || !alarmId) return null;
  return Object.freeze({
    deviceId,
    alarmId,
    room: boundText(String(alarm.room || ''), 32),
    type: boundText(String(alarm.type || ''), 32),
    createdAt: Number.isSafeInteger(alarm.createdAt) && alarm.createdAt > 0 ? alarm.createdAt : 0
  });
}

/**
 * 创建一个告警订阅消息投递器。
 *
 * @param {object} options
 * @param {object}   options.provider       见 notify-provider 的提供者接口（必填）
 * @param {object}   options.ledger         投递台账（可选）：需实现
 *                                          `readNotification(deviceId, alarmId, recipientRef)`、
 *                                          `upsertNotification(record)`、
 *                                          `readSubscription(ref)` / `consumeSubscription(ref)`；
 *                                          缺省时退化为纯内存（不跨重启，但仍按人幂等）
 * @param {string}   [options.recipientRefSecret] 生成 recipientRef 的 HMAC 密钥（≥32 字符）。
 *                                          只用于派生稳定标识，绝不持久化、绝不输出。
 * @param {string}   [options.templateId]   模板 ID（必填且非占位值）
 * @param {string}   [options.page]         点击通知后的跳转页
 * @param {object}   [options.logger]       可选日志接口 { error(message) }；默认不输出
 * @param {Function} [options.sleepImpl]    注入的 sleep（测试用）
 * @param {Function} [options.now]          注入的时钟（测试用）
 * @param {Function} [options.listAllowed]  返回当前允许登录的 openid 列表（启动恢复用）
 * @param {Function} [options.resolveAlarm] (deviceId, alarmId) => 告警上下文或 null（启动恢复用）
 * @param {number}   [options.maxAttempts]  单个收件人的最大尝试次数（默认 3）
 * @param {number}   [options.baseDelayMs]  退避基数（默认 500）
 * @param {number}   [options.maxDelayMs]   退避上限（默认 8000）
 */
function createNotificationDelivery(options = {}) {
  const provider = options.provider ? assertProvider(options.provider) : null;
  /**
   * 台账按鸭子类型判定而不是 isPlainObject：PersistentStore 是 class 实例，原型不是
   * Object.prototype，用 isPlainObject 会把真实台账当成“没有台账”，退化为纯内存并丢掉
   * 跨重启幂等。这里只要求实现必需的方法。
   */
  const ledger =
    options.ledger &&
    typeof options.ledger === 'object' &&
    typeof options.ledger.readNotification === 'function' &&
    typeof options.ledger.upsertNotification === 'function'
      ? options.ledger
      : null;
  const recipientRefSecret = typeof options.recipientRefSecret === 'string' ? options.recipientRefSecret : '';
  let listAllowed = typeof options.listAllowed === 'function' ? options.listAllowed : null;
  let resolveAlarm = typeof options.resolveAlarm === 'function' ? options.resolveAlarm : null;
  const templateId = typeof options.templateId === 'string' && options.templateId.trim() !== ''
    ? options.templateId.trim()
    : '';
  const page = typeof options.page === 'string' ? options.page : 'pages/alarms/index';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleepImpl === 'function' ? options.sleepImpl : defaultSleep;
  const logger =
    options.logger && typeof options.logger.error === 'function' ? options.logger : null;
  const config = Object.freeze({
    maxAttempts: Number.isSafeInteger(options.maxAttempts) && options.maxAttempts >= 1 ? options.maxAttempts : DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: Number.isSafeInteger(options.baseDelayMs) && options.baseDelayMs >= 1 ? options.baseDelayMs : DEFAULT_BASE_DELAY_MS,
    maxDelayMs: Number.isSafeInteger(options.maxDelayMs) && options.maxDelayMs >= 1 ? options.maxDelayMs : DEFAULT_MAX_DELAY_MS
  });

  const tokens = provider ? new TokenManager(provider, { now }) : null;
  /**
   * 进程内单飞表：同一 (deviceId, alarmId) 并发触发只跑一次，值为收件人数组而非单个 Promise。
   */
  const inflight = new Map();
  /** 无台账时的进程内兜底台账。 */
  const memoryNotifications = new Map();
  const memorySubscriptions = new Map();
  /** 启动恢复的单飞：重复调用 recoverPending 只跑一次。 */
  let recoveryPromise = null;
  let shuttingDown = false;
  let deliverCount = 0;
  let recoveredCount = 0;

  const deliveryKey = (deviceId, alarmId) => `${deviceId}\u0000${alarmId}`;
  const notificationKey = (deviceId, alarmId, ref) => `${deviceId}\u0000${alarmId}\u0000${ref}`;

  /* ---- 台账适配 ---- */

  function readRecord(deviceId, alarmId, ref) {
    if (ledger) return ledger.readNotification(deviceId, alarmId, ref);
    return memoryNotifications.get(notificationKey(deviceId, alarmId, ref)) || null;
  }

  function readGrant(ref) {
    if (ledger && typeof ledger.readSubscription === 'function') return ledger.readSubscription(ref);
    return memorySubscriptions.get(ref) || null;
  }

  /**
   * 写台账。台账字段是严格白名单（见 PersistentStore 的校验），只允许写规定字段，任何
   * 额外字段尤其是 openid 都会被拒；收件人只以 recipientRef 形式出现。
   *
   * 写入失败不得让投递变成异常：告警推送是旁路，不能反过来影响告警主链路，失败只记脱敏日志。
   */
  function writeRecord(record) {
    const payload = {
      deviceId: record.deviceId,
      alarmId: record.alarmId,
      recipientRef: record.recipientRef,
      templateId: record.templateId,
      status: record.status,
      attempts: record.attempts,
      attemptCount: record.attemptCount,
      sentAt: record.sentAt,
      updatedAt: record.updatedAt,
      errorCode: record.errorCode
    };
    if (ledger) {
      try {
        return ledger.upsertNotification(payload);
      } catch (error) {
        logFailure('ledger_write', error, { deviceId: record.deviceId, alarmId: record.alarmId });
        return Object.freeze(payload);
      }
    }
    const frozen = Object.freeze(payload);
    memoryNotifications.set(notificationKey(payload.deviceId, payload.alarmId, payload.recipientRef), frozen);
    return frozen;
  }

  const configured = () =>
    provider !== null && typeof provider.isConfigured === 'function' && provider.isConfigured() === true && templateId !== '';

  function logFailure(stage, error, context) {
    if (!logger) return;
    try {
      const code = error && typeof error.code === 'string' ? error.code : 'NOTIFY_UNKNOWN';
      // message 会经 deepRedact/redactLine 脱敏（openid、token、secret、手机号、坐标）。
      // 不输出 stack：它可能夹带请求上下文。
      const message = error && typeof error.message === 'string' ? error.message : '';
      logger.error(safeLogLine({ stage, code, message, ...context }));
    } catch (_) {
      // 日志失败不得影响投递。
    }
  }

  /* ---- 收件人 ---- */

  /** 把一个 openid 解析为稳定的 recipientRef；密钥缺失时返回 ''（调用方降级）。 */
  function refFor(openid) {
    if (recipientRefSecret === '') return '';
    try {
      return recipientRefFor(recipientRefSecret, openid);
    } catch (error) {
      logFailure('recipient_ref', error, {});
      return '';
    }
  }

  /**
   * 规范化调用方传入的收件人，按 openid 去重，避免同一监护人被重复投递。
   *
   * 字符串形式是允许名单里的 openid，只保留给旧调用方，不参与额度检查；
   * 对象形式 { ref, openid, granted, remaining } 中 granted === false 直接跳过，
   * remaining === 0 表示额度用完。
   */
  function normalizeRecipientInput(input) {
    if (typeof input === 'string') {
      const openid = input.trim();
      if (openid === '') return null;
      const ref = refFor(openid);
      if (ref === '') return null;
      return { openid, ref, granted: true, checkQuota: false, remaining: Number.POSITIVE_INFINITY };
    }
    if (!isPlainObject(input)) return null;
    const openid = typeof input.openid === 'string' ? input.openid.trim() : '';
    const ref = typeof input.ref === 'string' && input.ref !== '' ? input.ref : refFor(openid);
    if (ref === '' || openid === '') return null;
    return {
      openid,
      ref,
      granted: input.granted !== false,
      checkQuota: input.granted !== undefined,
      remaining: Number.isSafeInteger(input.remaining) && input.remaining >= 0 ? input.remaining : 0
    };
  }

  /** 构造某条告警的收件人列表（已去重、已解析 ref）。 */
  function resolveRecipients(recipients) {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(recipients) ? recipients : []) {
      const normalizedRecipient = normalizeRecipientInput(item);
      if (!normalizedRecipient) continue;
      if (seen.has(normalizedRecipient.openid)) continue;
      seen.add(normalizedRecipient.openid);
      out.push(normalizedRecipient);
    }
    return out;
  }

  /**
   * 把允许登录名单过滤成可投递收件人：允许登录 ∩ 已登记授权且有可用额度。
   * 只出现在 WECHAT_ALLOWED_OPENIDS 里、却从未通过 wx.requestSubscribeMessage 登记的用户，
   * 不会出现在结果里。
   */
  function toRecipients(allowedOpenIds) {
    const candidates = Array.isArray(allowedOpenIds) ? allowedOpenIds : [];
    const out = [];
    const seen = new Set();
    for (const item of candidates) {
      if (typeof item !== 'string') continue;
      const openid = item.trim();
      if (openid === '' || seen.has(openid)) continue;
      seen.add(openid);
      const ref = refFor(openid);
      if (ref === '') continue;
      const grant = readGrant(ref);
      const totalGranted = grant ? Number(grant.totalGranted) || 0 : 0;
      const consumed = grant ? Number(grant.consumed) || 0 : 0;
      // 43101 会把尚未消耗的本地额度记入 revoked。收件人筛选必须同时
      // 扣除 revoked，否则该用户会在下一条新告警中再次进入发送名单。
      const revoked = grant ? Number(grant.revoked) || 0 : 0;
      const remaining = Math.max(0, totalGranted - consumed - revoked);
      if (remaining <= 0) continue;
      out.push(Object.freeze({ ref, openid, granted: true, remaining }));
    }
    return out;
  }

  /**
   * 登记一次订阅授权（用户 accept / acceptWithAudio 后由小程序调后端接口触发）。
   * 同一 (recipientRef, grantEventId) 重复登记只加一次额度。
   *
   * @returns {Readonly<{ok: boolean, duplicate: boolean, remaining: number, reason?: string}>}
   */
  function recordSubscription(openid, grantEventId) {
    if (typeof openid !== 'string' || openid.trim() === '') {
      return Object.freeze({ ok: false, duplicate: false, remaining: 0, reason: 'invalid_recipient' });
    }
    const ref = refFor(openid);
    if (ref === '') return Object.freeze({ ok: false, duplicate: false, remaining: 0, reason: 'recipient_ref_unavailable' });
    if (typeof grantEventId !== 'string' || grantEventId.trim() === '') {
      return Object.freeze({ ok: false, duplicate: false, remaining: 0, reason: 'invalid_grant_event' });
    }
    if (ledger && typeof ledger.grantSubscription === 'function') {
      try {
        const result = ledger.grantSubscription(ref, templateId, grantEventId.trim(), now());
        return Object.freeze({ ok: true, duplicate: result.duplicate === true, remaining: result.remaining });
      } catch (error) {
        logFailure('grant_write', error, {});
        return Object.freeze({ ok: false, duplicate: false, remaining: 0, reason: 'grant_persist_failed' });
      }
    }
    const existing = memorySubscriptions.get(ref);
    const eventIds = existing ? existing.grantEventIds : [];
    const duplicate = eventIds.includes(grantEventId);
    const next = Object.freeze({
      recipientRef: ref,
      templateId,
      totalGranted: (existing ? existing.totalGranted : 0) + (duplicate ? 0 : 1),
      consumed: existing ? existing.consumed : 0,
      grantEventIds: Object.freeze(duplicate ? eventIds : [...eventIds, grantEventId].slice(-32)),
      grantedAt: existing ? existing.grantedAt : now(),
      updatedAt: now()
    });
    memorySubscriptions.set(ref, next);
    return Object.freeze({ ok: true, duplicate, remaining: Math.max(0, next.totalGranted - next.consumed) });
  }

  /** 微信确认发送成功后消耗一次额度，返回 { ok, remaining }。 */
  function consumeGrant(ref) {
    if (ledger && typeof ledger.consumeSubscription === 'function') {
      try {
        return ledger.consumeSubscription(ref, now());
      } catch (error) {
        logFailure('quota_consume', error, {});
        return { ok: false, reason: 'consume_failed', remaining: 0 };
      }
    }
    const existing = memorySubscriptions.get(ref);
    if (!existing) return { ok: false, reason: 'no_grant', remaining: 0 };
    if (existing.totalGranted - existing.consumed <= 0) return { ok: false, reason: 'no_quota', remaining: 0 };
    const next = Object.freeze({ ...existing, consumed: existing.consumed + 1, updatedAt: now() });
    memorySubscriptions.set(ref, next);
    return { ok: true, remaining: Math.max(0, next.totalGranted - next.consumed) };
  }

  /** 43101（用户永久拒收）：把该收件人的本地可用额度校正为 0。 */
  function revokeGrant(ref) {
    if (ledger && typeof ledger.revokeSubscriptionQuota === 'function') {
      try {
        ledger.revokeSubscriptionQuota(ref, now());
      } catch (error) {
        logFailure('quota_revoke', error, {});
      }
      return;
    }
    const existing = memorySubscriptions.get(ref);
    if (!existing) return;
    memorySubscriptions.set(ref, Object.freeze({ ...existing, consumed: existing.totalGranted, updatedAt: now() }));
  }

  /* ---- 单收件人投递 ---- */

  /**
   * 向一个收件人投递一条告警，直到成功 / 永久失败 / 尝试耗尽。
   *
   * 只有微信确认收到后才消耗这次额度；临时失败（网络、超时、429、5xx）不消耗，退避后重试；
   * 永久失败（43101 / 非法 openid / 模板无效）立即停本收件人，不影响别人；
   * token 失效是全局问题，作废缓存、强制刷新后重试本收件人。
   */
  async function sendToRecipient(alarm, recipient, data, startAttemptCount, forceRefreshInitial) {
    let attemptCount = startAttemptCount;
    let forceRefresh = forceRefreshInitial === true;
    let lastError = null;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      attemptCount += 1;
      let accessToken = null;
      try {
        accessToken = await tokens.getToken({ force: forceRefresh });
        forceRefresh = false;
      } catch (error) {
        lastError = error;
        // provider 侧判定永久（例如 AppID/AppSecret 非法）：本收件人停止。
        if (error && error.permanent === true) {
          return { outcome: 'permanent', attemptCount, error };
        }
        if (attempt < config.maxAttempts) {
          const delay = backoffDelayMs(attempt, config);
          logFailure('token_retry', error, { recipientRef: recipient.ref, attempt, delayMs: delay });
          await sleep(delay);
          forceRefresh = true;
        }
        continue;
      }

      try {
        await provider.sendSubscribeMessage({
          accessToken,
          openid: recipient.openid,
          templateId,
          page,
          data
        });
        return { outcome: 'sent', attemptCount, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (error && error.permanent === true) {
          return { outcome: 'permanent', attemptCount, error };
        }
        if (error && error.refreshToken === true) {
          tokens.invalidate();
          forceRefresh = true;
        }
      }

      if (attempt < config.maxAttempts) {
        const delay = backoffDelayMs(attempt, config);
        logFailure('retry', lastError, { recipientRef: recipient.ref, attempt, delayMs: delay });
        await sleep(delay);
      }
    }

    return { outcome: 'failed', attemptCount, error: lastError };
  }

  /**
   * 对一组收件人执行一轮投递，返回按收件人独立的结果；已成功的不会再进入后续结果，
   * 重试时只重发失败者。
   */
  async function deliverToRecipients(alarm, seedRecipients, options = {}) {
    void options;
    const data = buildTemplateData(alarm);
    const results = new Map();
    const pending = [];

    for (const seed of seedRecipients) {
      const prior = readRecord(alarm.deviceId, alarm.alarmId, seed.ref);
      if (prior && prior.status === DELIVERY_STATUS.SENT) {
        results.set(seed.ref, Object.freeze({
          recipientRef: seed.ref, status: 'SENT', attemptCount: prior.attemptCount || 0,
          remaining: seed.remaining, alreadySent: true, taskId: `${alarm.deviceId}|${alarm.alarmId}|${seed.ref}`
        }));
        continue;
      }
      if (prior && prior.status === DELIVERY_STATUS.PERMANENT_FAILED) {
        results.set(seed.ref, Object.freeze({
          recipientRef: seed.ref, status: 'PERMANENT_FAILED', attemptCount: prior.attemptCount || 0,
          remaining: seed.remaining, reason: 'permanent_failure_recorded',
          errorCode: prior.errorCode || '', taskId: `${alarm.deviceId}|${alarm.alarmId}|${seed.ref}`
        }));
        continue;
      }
      if (seed.granted !== true) {
        results.set(seed.ref, Object.freeze({
          recipientRef: seed.ref, status: 'SKIPPED', attemptCount: 0,
          remaining: seed.remaining, reason: 'no_grant',
          taskId: `${alarm.deviceId}|${alarm.alarmId}|${seed.ref}`
        }));
        continue;
      }
      if (seed.checkQuota === true && seed.remaining <= 0) {
        results.set(seed.ref, Object.freeze({
          recipientRef: seed.ref, status: 'SKIPPED', attemptCount: 0,
          remaining: 0, reason: 'no_quota',
          taskId: `${alarm.deviceId}|${alarm.alarmId}|${seed.ref}`
        }));
        continue;
      }
      pending.push({ ...seed, attemptCount: prior ? Number(prior.attemptCount) || 0 : 0 });
    }

    if (pending.length > 0) {
      const settled = await Promise.all(pending.map((recipient) => (
        sendToRecipient(alarm, recipient, data, recipient.attemptCount, false)
      )));
      for (let index = 0; index < pending.length; index += 1) {
        const recipient = pending[index];
        const outcome = settled[index];
        const taskId = `${alarm.deviceId}|${alarm.alarmId}|${recipient.ref}`;

        if (outcome.outcome === 'sent') {
          // 微信确认发送成功后才消耗一次性额度。
          const consumed = consumeGrant(recipient.ref);
          const remaining = consumed && Number.isSafeInteger(consumed.remaining) ? consumed.remaining : recipient.remaining - 1;
          writeRecord({
            deviceId: alarm.deviceId, alarmId: alarm.alarmId, recipientRef: recipient.ref,
            templateId, status: DELIVERY_STATUS.SENT,
            attempts: outcome.attempts || 1, attemptCount: outcome.attemptCount,
            sentAt: now(), updatedAt: now(), errorCode: ''
          });
          deliverCount += 1;
          results.set(recipient.ref, Object.freeze({
            recipientRef: recipient.ref, status: 'SENT', attemptCount: outcome.attemptCount,
            attempts: outcome.attempts || 1, remaining: Math.max(0, remaining), taskId
          }));
          continue;
        }

        if (outcome.outcome === 'permanent') {
          const errcode = outcome.error && outcome.error.errcode;
          const permanentCode = outcome.error && typeof outcome.error.code === 'string'
            ? outcome.error.code
            : NOTIFY_CODES.PERMANENT;
          // 43101 = 用户永久拒收：把该收件人的本地可用额度校正为 0。
          if (Number(errcode) === 43101) revokeGrant(recipient.ref);
          writeRecord({
            deviceId: alarm.deviceId, alarmId: alarm.alarmId, recipientRef: recipient.ref,
            templateId, status: DELIVERY_STATUS.PERMANENT_FAILED,
            attempts: outcome.attemptCount, attemptCount: outcome.attemptCount,
            sentAt: 0, updatedAt: now(), errorCode: permanentCode
          });
          logFailure('permanent', outcome.error, { recipientRef: recipient.ref });
          results.set(recipient.ref, Object.freeze({
            recipientRef: recipient.ref, status: 'PERMANENT_FAILED', attemptCount: outcome.attemptCount,
            remaining: 0, reason: 'permanent', errorCode: permanentCode, taskId
          }));
          continue;
        }

        writeRecord({
          deviceId: alarm.deviceId, alarmId: alarm.alarmId, recipientRef: recipient.ref,
          templateId, status: DELIVERY_STATUS.FAILED,
          attempts: config.maxAttempts, attemptCount: outcome.attemptCount,
          sentAt: 0, updatedAt: now(),
          errorCode: outcome.error && typeof outcome.error.code === 'string' ? outcome.error.code : NOTIFY_CODES.NETWORK
        });
        logFailure('exhausted', outcome.error, { recipientRef: recipient.ref, attemptCount: outcome.attemptCount });
        results.set(recipient.ref, Object.freeze({
          recipientRef: recipient.ref, status: 'FAILED', attemptCount: outcome.attemptCount,
          remaining: recipient.remaining, reason: 'temporary_exhausted',
          errorCode: outcome.error && typeof outcome.error.code === 'string' ? outcome.error.code : NOTIFY_CODES.NETWORK,
          taskId
        }));
      }
    }

    return seedRecipients.map((seed) => results.get(seed.ref)).filter(Boolean);
  }

  /** 把按收件人的结果聚合成清晰的整体状态。 */
  function aggregate(deviceId, alarmId, results) {
    const sent = results.filter((item) => item.status === 'SENT');
    const permanent = results.filter((item) => item.status === 'PERMANENT_FAILED');
    const failed = results.filter((item) => item.status === 'FAILED');
    const skipped = results.filter((item) => item.status === 'SKIPPED');
    let status;
    if (results.length === 0) status = AGGREGATE_STATUS.NO_RECIPIENTS;
    else if (sent.length === results.length) status = AGGREGATE_STATUS.ALL_SENT;
    else if (sent.length > 0) status = AGGREGATE_STATUS.PARTIAL;
    else status = AGGREGATE_STATUS.FAILED;
    return Object.freeze({
      deviceId,
      alarmId,
      status,
      total: results.length,
      sent: sent.length,
      failed: failed.length,
      permanentFailed: permanent.length,
      skipped: skipped.length,
      allSent: sent.length === results.length && results.length > 0,
      fullyDelivered: sent.length === results.length && results.length > 0,
      recipients: Object.freeze(results),
      attemptCount: results.reduce((max, item) => Math.max(max, item.attemptCount || 0), 0)
    });
  }

  /**
   * 向已授权监护人投递一条告警。
   *
   * @param {object} alarm       { deviceId, alarmId, room, type, createdAt }
   * @param {Array}  recipients  收件人；字符串按“允许名单 openid”处理，不做额度检查，
   *                             对象按 { ref, openid, granted, remaining } 处理
   * @returns {Promise<object>} 冻结的结构化结果，从不抛出
   */
  async function notifyAlarm(alarm, recipients) {
    const normalized = normalizeAlarmInput(alarm);
    if (!normalized) {
      logFailure('validate', notifyError(NOTIFY_CODES.INVALID_INPUT, 'alarm input rejected'), {});
      return Object.freeze({
        deviceId: '', alarmId: '', status: AGGREGATE_STATUS.NO_RECIPIENTS,
        total: 0, sent: 0, failed: 0, permanentFailed: 0, skipped: 0,
        recipients: Object.freeze([]), reason: 'invalid_alarm'
      });
    }
    const { deviceId, alarmId } = normalized;
    const key = deliveryKey(deviceId, alarmId);

    // 同一进程内的并发触发：复用同一次投递，避免重复发送。
    if (inflight.has(key)) return inflight.get(key);

    const seed = resolveRecipients(recipients);

    const run = (async () => {
      if (!configured()) {
        const reason = provider === null
          ? 'provider_missing'
          : templateId === '' ? 'template_not_configured' : 'provider_not_configured';
        logFailure('configure', notifyError(NOTIFY_CODES.NOT_CONFIGURED, reason), { deviceId, alarmId });
        return Object.freeze({
          deviceId, alarmId, status: 'NOT_CONFIGURED',
          total: seed.length, sent: 0, failed: 0, permanentFailed: 0, skipped: 0,
          recipients: Object.freeze([]), reason
        });
      }
      if (seed.length === 0) {
        // 没有可投递收件人（允许名单为空，或没有人登记过可用授权）：不发送、不写台账。
        return Object.freeze({
          deviceId, alarmId, status: AGGREGATE_STATUS.NO_RECIPIENTS,
          total: 0, sent: 0, failed: 0, permanentFailed: 0, skipped: 0,
          recipients: Object.freeze([]), reason: 'no_authorized_guardian'
        });
      }
      const results = await deliverToRecipients(normalized, seed);
      return aggregate(deviceId, alarmId, results);
    })();

    inflight.set(key, run);
    try {
      return await run;
    } finally {
      inflight.delete(key);
    }
  }

  /** fire-and-forget 入口，供后端告警主链路调用：立即返回，不留下未处理的 Promise 拒绝。 */
  function notifyAlarmInBackground(alarm, recipients) {
    try {
      const promise = notifyAlarm(alarm, recipients);
      promise.catch((error) => logFailure('background', error, {}));
      return promise;
    } catch (error) {
      logFailure('background', error, {});
      return Promise.resolve(Object.freeze({ status: 'SKIPPED', reason: 'dispatch_failed' }));
    }
  }

  /* ---- 启动恢复 ---- */

  /**
   * 配置启动恢复用的两个回调，可重复调用（幂等覆盖）。恢复依赖允许名单与告警上下文，
   * 它们由 server.js 组装，但投递器得先创建才能注入 server，所以单独留一个方法。
   */
  function configureRecovery(options2 = {}) {
    if (typeof options2.listAllowed === 'function') listAllowed = options2.listAllowed;
    if (typeof options2.resolveAlarm === 'function') resolveAlarm = options2.resolveAlarm;
    return getStatus();
  }

  /**
   * 扫描台账里未完成的收件人任务并自动恢复投递：完成态（SENT / PERMANENT_FAILED）永不重发，
   * 只恢复 FAILED（临时失败耗尽）的任务。
   *
   * 恢复要用的两样东西都不落盘：收件人 openid 由允许名单配合同一 HMAC 重新派生 ref 后匹配，
   * 只存在内存里；告警上下文从既有 alerts/devices 状态重建（room/type/createdAt），
   * 因此不需要持久化位置或身份信息。恢复在后台跑，不阻塞 /healthz、/readyz、摄入或 ACK。
   *
   * @returns {Promise<object>} 恢复摘要；重复调用返回同一个 Promise
   */
  function recoverPending() {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const summary = { scanned: 0, recovered: 0, skipped: 0, sent: 0, failed: 0, permanent: 0 };
      // 已在关闭流程中：不再发起任何新的恢复重试。
      if (shuttingDown) return Object.freeze({ ...summary, reason: 'shutting_down' });
      if (!configured()) return Object.freeze({ ...summary, reason: 'not_configured' });
      if (!ledger || typeof ledger.listNotifications !== 'function') {
        return Object.freeze({ ...summary, reason: 'no_ledger' });
      }
      if (!listAllowed || recipientRefSecret === '') {
        return Object.freeze({ ...summary, reason: 'no_recipient_source' });
      }

      let openids = [];
      try {
        const listed = listAllowed();
        openids = Array.isArray(listed) ? listed.filter((item) => typeof item === 'string' && item.trim() !== '') : [];
      } catch (error) {
        logFailure('recovery_allowlist', error, {});
        return Object.freeze({ ...summary, reason: 'allowlist_failed' });
      }

      const byRef = new Map();
      for (const openid of openids) {
        const ref = refFor(openid);
        if (ref !== '') byRef.set(ref, openid);
      }

      const tasks = new Map();
      for (const record of ledger.listNotifications()) {
        summary.scanned += 1;
        // SENT 与 PERMANENT_FAILED 是终态：绝不重发。
        if (record.status !== DELIVERY_STATUS.FAILED) continue;
        if (shuttingDown) break;
        const openid = byRef.get(record.recipientRef);
        if (!openid) {
          // 该收件人已不在允许名单里（或密钥变了）：不恢复，也不算失败。
          summary.skipped += 1;
          continue;
        }
        const taskKey = deliveryKey(record.deviceId, record.alarmId);
        if (!tasks.has(taskKey)) tasks.set(taskKey, { deviceId: record.deviceId, alarmId: record.alarmId, records: [] });
        tasks.get(taskKey).records.push({ record, openid });
      }

      for (const task of tasks.values()) {
        if (shuttingDown) break;
        let alarmContext = null;
        try {
          alarmContext = resolveAlarm ? resolveAlarm(task.deviceId, task.alarmId) : null;
        } catch (error) {
          logFailure('recovery_context', error, {});
          alarmContext = null;
        }
        if (!alarmContext) {
          // 无法安全重建告警上下文：不猜测、不发送。
          summary.skipped += task.records.length;
          continue;
        }
        const recipients2 = task.records.map(({ record, openid }) => ({
          ref: record.recipientRef,
          openid,
          granted: true,
          remaining: (() => {
            const grant = readGrant(record.recipientRef);
            if (!grant) return 0;
            return Math.max(
              0,
              (Number(grant.totalGranted) || 0) -
                (Number(grant.consumed) || 0) -
                (Number(grant.revoked) || 0)
            );
          })(),
          checkQuota: true
        }));
        const result = await deliverToRecipients(alarmContext, recipients2, { recovery: true });
        summary.recovered += recipients2.length;
        for (const item of result) {
          if (item.status === 'SENT') summary.sent += 1;
          else if (item.status === 'PERMANENT_FAILED') summary.permanent += 1;
          else if (item.status === 'FAILED') summary.failed += 1;
          else summary.skipped += 1;
        }
        recoveredCount += result.filter((item) => item.status === 'SENT').length;
      }

      logFailure('recovery_complete', null, {
        scanned: summary.scanned, recovered: summary.recovered, sent: summary.sent
      });
      return Object.freeze({ ...summary });
    })();
    return recoveryPromise;
  }

  /** 进入关闭流程：不再发起新的重试。返回当前是否仍有在途投递。 */
  function beginShutdown() {
    shuttingDown = true;
    return inflight.size > 0;
  }

  /** 等待当前在途投递结束（有界）；关闭时用于不留未处理 Promise。 */
  async function drain() {
    const active = [...inflight.values()];
    if (active.length === 0) return;
    try {
      await Promise.all(active.map((promise) => promise.catch(() => {})));
    } catch (_) {
      // 关闭路径上不得抛出。
    }
  }

  /** 诊断快照：不含 openid、token 或 secret。 */
  function getStatus() {
    return Object.freeze({
      configured: configured(),
      templateConfigured: templateId !== '',
      provider: provider && provider.name ? provider.name : null,
      recipientRefReady: recipientRefSecret !== '',
      recoveryEnabled: Boolean(ledger && listAllowed && resolveAlarm && recipientRefSecret !== ''),
      maxAttempts: config.maxAttempts,
      baseDelayMs: config.baseDelayMs,
      maxDelayMs: config.maxDelayMs,
      deliveries: deliverCount,
      recovered: recoveredCount,
      inflight: inflight.size,
      shuttingDown,
      token: tokens ? tokens.getStatus() : null
    });
  }

  return {
    notifyAlarm,
    notifyAlarmInBackground,
    recordSubscription,
    toRecipients,
    recoverPending,
    configureRecovery,
    beginShutdown,
    drain,
    getStatus,
    refFor,
    /** 当前配置的模板 ID（供授权登记接口校验一致性；不是密钥，但仍不应写进日志）。 */
    templateId: () => templateId,
    buildTemplateData: (alarm) => buildTemplateData(normalizeAlarmInput(alarm) || {}),
    backoffDelayMs: (attempt) => backoffDelayMs(attempt, config),
    configured
  };
}

module.exports = {
  MAX_FIELD_CHARS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  ALARM_TYPE_LABELS,
  DELIVERY_STATUS,
  AGGREGATE_STATUS,
  templateField,
  formatAlarmTime,
  alarmTypeLabel,
  buildTemplateData,
  backoffDelayMs,
  normalizeAlarmInput,
  createNotificationDelivery
};
