#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseAppGuardianConfig } = require('./auth');
const { createApiServer } = require('./server');
const { EvidenceStore } = require('./evidence-store');
const { createHouseholdAuthorizer } = require('./household-auth');
const { PersistentStore } = require('./persistent-store');
const { ActivityStore } = require('./activity-store');
const { parseHouseholdTimezone } = require('./activity');
const { createWechatProvider } = require('./notify-provider');
const { createNotificationDelivery } = require('./notify-delivery');
const { safeLogLine } = require('./notify-privacy');
const { ownerRefFor } = require('./comms-core');

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredSecret(env, name) {
  const value = required(env, name);
  if (value.length < 32 || value.length > 512) {
    throw new Error(`${name} must be 32-512 characters`);
  }
  return value;
}

function optionalAuthConfig(env) {
  const appId = String(env.WECHAT_APP_ID || '').trim();
  const appSecret = String(env.WECHAT_APP_SECRET || '');
  const allowedOpenIds = String(env.WECHAT_ALLOWED_OPENIDS || '').trim();
  const supplied = [appId, appSecret, allowedOpenIds].filter(Boolean).length;
  if (supplied !== 0 && supplied !== 3) {
    throw new Error('WECHAT_APP_ID, WECHAT_APP_SECRET and WECHAT_ALLOWED_OPENIDS must be configured together');
  }
  const wechatAuthorizer = supplied === 3 ? createHouseholdAuthorizer(allowedOpenIds) : null;

  const guardianId = String(env.APP_GUARDIAN_ID || '').trim();
  const guardianPassword = String(env.APP_GUARDIAN_PASSWORD || '');
  if (Boolean(guardianId) !== Boolean(guardianPassword)) {
    throw new Error('APP_GUARDIAN_ID and APP_GUARDIAN_PASSWORD must be configured together');
  }
  const appAuth = guardianId ? parseAppGuardianConfig(guardianId, guardianPassword) : null;
  if (!appAuth && !wechatAuthorizer) {
    throw new Error('at least one guardian authentication method must be configured');
  }
  return { appAuth, appId, appSecret, wechatAuthorizer };
}

function parsePort(value) {
  const port = Number(value || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer in [1, 65535]');
  return port;
}

function parsePositiveInt(value, fallback, name, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer in [1, ${maximum}]`);
  }
  return parsed;
}

function parseContacts(value) {
  if (!value) return [];
  const contacts = JSON.parse(value);
  if (!Array.isArray(contacts)) throw new Error('CONTACTS_JSON must be a JSON array');
  return contacts;
}

/** 模板 ID 的合法字符集（微信模板 ID 为长数字串，这里放宽到常见安全字符）。 */
const TEMPLATE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/**
 * 占位模板 ID 黑名单：绝不把「假模板」当成已配置。
 * 未配置时订阅消息功能必须明确显示为未配置，而不是拿一个占位值去调用微信。
 */
const PLACEHOLDER_TEMPLATE_RE = /(replace|placeholder|changeme|change-me|your[-_]?template|template[-_]?id[-_]?here|xxx+|todo|example)/i;

/**
 * 解析 `WECHAT_SUBSCRIBE_TEMPLATE_ID`。
 * - 未设置/空串 -> `''`（未配置，通知链路整体关闭）
 * - 命中占位串或字符集非法 -> 抛错（fail closed，而不是带着假模板启动）
 * - 合法 -> 返回模板 ID
 */
function parseSubscribeTemplateId(value) {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim();
  if (raw === '') return '';
  if (PLACEHOLDER_TEMPLATE_RE.test(raw)) {
    throw new Error('WECHAT_SUBSCRIBE_TEMPLATE_ID must not be a placeholder value');
  }
  if (!TEMPLATE_ID_RE.test(raw)) {
    throw new Error('WECHAT_SUBSCRIBE_TEMPLATE_ID must be 1-64 characters of [A-Za-z0-9._-]');
  }
  return raw;
}

/** 订阅消息跳转页（非敏感，可留空使用默认页）。 */
function parseSubscribePage(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 'pages/alarms/index';
  const raw = String(value).trim();
  if (raw.length > 128 || !/^[A-Za-z0-9/_-]+$/.test(raw)) {
    throw new Error('WECHAT_SUBSCRIBE_PAGE must be a plain miniprogram path');
  }
  return raw;
}

function probeDataPath(filePath) {
  const directory = path.dirname(filePath);
  let descriptor;
  let probePath;
  try {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(filePath)) {
      fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
    }
    probePath = path.join(
      directory,
      `.backend-ready-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
    );
    descriptor = fs.openSync(probePath, 'wx', 0o600);
    fs.writeSync(descriptor, 'ready', null, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.unlinkSync(probePath);
    probePath = undefined;
    return true;
  } catch (_) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* retain the original failure */ }
    }
    if (probePath) {
      try { fs.unlinkSync(probePath); } catch { /* best-effort cleanup */ }
    }
    const error = new Error('BACKEND_DATA_FILE storage unavailable');
    error.code = 'STORAGE_UNAVAILABLE';
    throw error;
  }
}

function createRuntime(env = process.env) {
  const port = parsePort(env.PORT);
  const host = env.HOST || '127.0.0.1';
  if (typeof host !== 'string' || !host || /\s/.test(host) || host.length > 253) {
    throw new Error('HOST must be a valid non-empty host name or address');
  }
  const tokenSecret = requiredSecret(env, 'API_TOKEN_SECRET');
  const ingestKey = requiredSecret(env, 'INGEST_KEY');
  const authConfig = optionalAuthConfig(env);
  const dataFile = path.resolve(
    env.BACKEND_DATA_FILE || path.join(__dirname, '..', 'data', 'backend-state.json')
  );
  const evidenceDirectory = path.resolve(
    env.BACKEND_EVIDENCE_DIR || path.join(__dirname, '..', 'data', 'evidence')
  );
  const activityFile = path.resolve(
    env.BACKEND_ACTIVITY_FILE || path.join(path.dirname(dataFile), 'activity-state.json')
  );
  // 家庭时区非法时 fail-closed（拒绝启动），绝不静默退化成服务器本地时区。
  const householdTimezone = parseHouseholdTimezone(env.HOUSEHOLD_TIMEZONE);
  probeDataPath(dataFile);
  probeDataPath(path.join(evidenceDirectory, '.storage-probe'));
  probeDataPath(activityFile);
  const store = new PersistentStore({
    filePath: dataFile,
    contacts: parseContacts(env.CONTACTS_JSON)
  });
  const evidenceStore = new EvidenceStore({
    directory: evidenceDirectory,
    maxEvents: parsePositiveInt(env.EVIDENCE_MAX_EVENTS, 200, 'EVIDENCE_MAX_EVENTS', 10000),
    retentionMs: parsePositiveInt(env.EVIDENCE_RETENTION_DAYS, 30, 'EVIDENCE_RETENTION_DAYS', 3650) *
      24 * 60 * 60 * 1000
  });
  /**
   * PIR 活动聚合：独立状态文件，不并入 PersistentStore 的 schema，
   * 因此主快照的结构/版本演进与活动统计互不影响。
   */
  const activityStore = new ActivityStore({
    filePath: activityFile,
    timezone: householdTimezone
  });

  /**
   * 微信订阅消息（可选功能）。
   *
   * 设计取舍：
   *   - 模板 ID 未配置时**整体关闭**通知，不伪造默认模板；状态由 getStatus() 报告。
   *   - provider 与 delivery 都通过依赖注入组装，测试可换成 fake provider，
   *     无需真实 AppID/AppSecret/openid，也不会访问真实微信 API。
   *   - 持久化台账复用 PersistentStore（schema v3 的 notifications 字段），
   *     因此 (deviceId, alarmId) 的幂等与重试状态能跨进程重启恢复。
   */
  const subscribeTemplateId = parseSubscribeTemplateId(env.WECHAT_SUBSCRIBE_TEMPLATE_ID);
  const subscribePage = parseSubscribePage(env.WECHAT_SUBSCRIBE_PAGE);
  let notificationDelivery = null;
  if (subscribeTemplateId !== '') {
    if (!authConfig.wechatAuthorizer) {
      throw new Error('WECHAT_SUBSCRIBE_TEMPLATE_ID requires complete WeChat authentication configuration');
    }
    /**
     * recipientRef 的 HMAC 密钥。只用于把 openid 派生为稳定的、不可反查的收件人标识，
     * 因此**绝不允许**出现在日志、响应或持久化快照里。
     * 未单独提供时从 API_TOKEN_SECRET 做域分离派生，避免额外强制一个新变量。
     */
    const recipientRefSecret = typeof env.RECIPIENT_REF_SECRET === 'string' && env.RECIPIENT_REF_SECRET.length >= 32
      ? env.RECIPIENT_REF_SECRET
      : crypto.createHmac('sha256', tokenSecret).update('eldercare-recipient-ref-derivation:v1').digest('base64url');
    const provider = createWechatProvider({ appId: authConfig.appId, appSecret: authConfig.appSecret });
    notificationDelivery = createNotificationDelivery({
      provider,
      templateId: subscribeTemplateId,
      page: subscribePage,
      recipientRefSecret,
      ledger: typeof store.readNotification === 'function' && typeof store.upsertNotification === 'function'
        ? store
        : null,
      maxAttempts: parsePositiveInt(env.NOTIFY_MAX_ATTEMPTS, 3, 'NOTIFY_MAX_ATTEMPTS', 10),
      baseDelayMs: parsePositiveInt(env.NOTIFY_BASE_DELAY_MS, 500, 'NOTIFY_BASE_DELAY_MS', 60000),
      maxDelayMs: parsePositiveInt(env.NOTIFY_MAX_DELAY_MS, 8000, 'NOTIFY_MAX_DELAY_MS', 600000),
      logger: {
        error(message) {
          // message 已由 notify-privacy 脱敏。
          console.error(message);
        }
      }
    });
  }
  const { server, deliveryRecipients, resolveAlarmContext } = createApiServer({
    store,
    evidenceStore,
    tokenSecret,
    ingestKey,
    readyCheck: () => {
      probeDataPath(dataFile);
      probeDataPath(path.join(evidenceDirectory, '.storage-probe'));
      probeDataPath(activityFile);
      return true;
    },
    activityStore,
    authorizeIdentity: (identity) =>
      (authConfig.appAuth && identity === authConfig.appAuth.subject) ||
      (authConfig.wechatAuthorizer && authConfig.wechatAuthorizer.isAllowed(identity)) ||
      false,
    // 只用于派生 recipientRef 与启动恢复；允许登录 ≠ 已订阅。
    listGuardians: () => authConfig.wechatAuthorizer ? authConfig.wechatAuthorizer.listAllowed() : [],
    // 远程交流：会话身份 -> 不可反查的 ownerRef（台账里绝不保存 openid）。
    ownerRefForIdentity: (openid) => ownerRefFor(tokenSecret, openid),
    notificationDelivery,
    appAuth: authConfig.appAuth,
    wechat: {
      appId: authConfig.appId,
      appSecret: authConfig.appSecret
    }
  });

  // 启动自动恢复：扫描台账里未完成的收件人任务并在后台继续投递。
  // 不 await：绝不阻塞 /healthz、/readyz、设备摄入与 ACK。
  if (notificationDelivery) {
    notificationDelivery.configureRecovery({
      listAllowed: () => authConfig.wechatAuthorizer ? authConfig.wechatAuthorizer.listAllowed() : [],
      resolveAlarm: (deviceId, alarmId) => resolveAlarmContext(deviceId, alarmId)
    });
    // 后台恢复：不 await，不阻塞 /healthz、/readyz、设备摄入与 ACK。
    void notificationDelivery.recoverPending().catch(() => {
      // 恢复失败不影响服务可用性。
    });
  }
  void deliveryRecipients;
  void store;
  // Enforce age retention during idle operation too, not only on uploads or
  // restarts. Expired content is denied by forAlert even before the sweep.
  const retentionTimer = setInterval(() => {
    try { evidenceStore.prune(); } catch (_) {
      console.error('[backend] EVIDENCE_RETENTION_FAILED');
    }
  }, 60000);
  retentionTimer.unref();
  server.once('close', () => clearInterval(retentionTimer));

  /**
   * 交流消息过期清理：把超过 TTL 的 QUEUED/DELIVERED 消息持久化为 EXPIRED。
   * 与证据保留同一个模式（定时器 unref，服务关闭时清掉），不会阻止进程退出。
   */
  const communicationsTimer = setInterval(() => {
    try {
      if (typeof store.expireCommunications === 'function') store.expireCommunications(Date.now());
    } catch (_) {
      console.error('[backend] COMMUNICATIONS_EXPIRY_FAILED');
    }
  }, 60000);
  communicationsTimer.unref();
  server.once('close', () => clearInterval(communicationsTimer));

  return {
    dataFile,
    activityFile,
    activityStore,
    evidenceDirectory,
    evidenceStore,
    householdTimezone,
    host,
    port,
    server,
    store,
    notificationDelivery
  };
}

async function main() {
  const runtime = createRuntime(process.env);
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen(runtime.port, runtime.host, () => {
      runtime.server.off('error', reject);
      resolve();
    });
  });

  console.log(`eldercare cloud backend listening on ${runtime.host}:${runtime.port}`);
  console.log('Persistent state enabled; terminate TLS at a trusted reverse proxy before public exposure.');
  // 只输出「是否配置」这类布尔结论，绝不输出模板 ID、openid、AppSecret 或 access_token。
  console.log(safeLogLine({
    event: 'subscribe_message_status',
    configured: runtime.notificationDelivery !== null,
    status: runtime.notificationDelivery ? runtime.notificationDelivery.getStatus() : null
  }));

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    // 不再发起新的通知重试；等待在途投递结束（有界），不留未处理 Promise。
    if (runtime.notificationDelivery) runtime.notificationDelivery.beginShutdown();
    const forceTimer = setTimeout(() => process.exit(1), 10000);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
    const finish = (error) => {
      clearTimeout(forceTimer);
      if (error) console.error(`[backend] STOP_FAIL signal=${signal}`);
      process.exit(error ? 1 : 0);
    };
    const drain = runtime.notificationDelivery && typeof runtime.notificationDelivery.drain === 'function'
      ? runtime.notificationDelivery.drain().catch(() => {})
      : Promise.resolve();
    drain.then(() => {
      runtime.server.close(finish);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && /^persistent store (?:corrupt|unsupported)/.test(error.message)
      ? 'persistent state validation failed'
      : (error && error.message) || 'startup failed';
    console.error(`[backend] FATAL message=${message}`);
    process.exit(1);
  });
}

module.exports = {
  createRuntime,
  optionalAuthConfig,
  parseContacts,
  parseHouseholdTimezone,
  parsePort,
  parsePositiveInt,
  parseSubscribePage,
  parseSubscribeTemplateId,
  probeDataPath
};

