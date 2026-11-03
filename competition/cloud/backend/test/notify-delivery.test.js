'use strict';

/**
 * notify-delivery.test.js — 告警订阅消息投递的确定性测试
 *
 * 覆盖：用户接受 / 用户拒绝 / 未配置模板 / 重复告警幂等 / 临时失败重试 /
 * 永久失败停止 / token 失效刷新 / access_token 过期 / 429 / 5xx / 超时 /
 * 敏感字段不泄漏 / 进程重启恢复 / 不阻塞主链路。
 *
 * 全程使用 fake provider 与内存台账，**不访问真实微信 API**，
 * 不使用真实 AppID/AppSecret/openid，不部署公网，不安装依赖。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  NOTIFY_CODES,
  TokenManager,
  isPermanentWechatError,
  requiresTokenRefresh,
  codeForWechatError,
  notifyError,
  classifyHttpFailure,
  createWechatProvider,
  assertProvider
} = require('../src/notify-provider');
const {
  DELIVERY_STATUS,
  AGGREGATE_STATUS,
  templateField,
  formatAlarmTime,
  alarmTypeLabel,
  buildTemplateData,
  backoffDelayMs,
  normalizeAlarmInput,
  createNotificationDelivery
} = require('../src/notify-delivery');
const { deepRedact, redactLine, safeLogLine, boundText } = require('../src/notify-privacy');
const { PersistentStore } = require('../src/persistent-store');

/** 测试用的 recipientRef HMAC 密钥（≥32 字符，绝不用于生产）。 */
const RECIPIENT_REF_SECRET = 'unit-test-recipient-ref-secret-value-32';

/* ------------------------------------------------------------ 测试替身 */

/**
 * 内存台账：与 PersistentStore 的收件人级契约一致。
 * 幂等键是 (deviceId, alarmId, recipientRef)；订阅额度按 recipientRef 独立。
 */
function createMemoryLedger() {
  const map = new Map();
  const subs = new Map();
  const key = (deviceId, alarmId, ref) => `${deviceId}\u0000${alarmId}\u0000${ref}`;
  const remainingOf = (record) => Math.max(0, record.totalGranted - record.consumed - (record.revoked || 0));
  return {
    map,
    subs,
    readNotification(deviceId, alarmId, recipientRef) {
      if (typeof recipientRef !== 'string') return null;
      return map.get(key(deviceId, alarmId, recipientRef)) || null;
    },
    listNotifications() {
      return [...map.values()];
    },
    upsertNotification(record) {
      const frozen = Object.freeze({ ...record });
      map.set(key(record.deviceId, record.alarmId, record.recipientRef), frozen);
      return frozen;
    },
    countNotifications() {
      return map.size;
    },
    readSubscription(ref) {
      const existing = subs.get(ref);
      return existing ? { ...existing, remaining: remainingOf(existing) } : null;
    },
    listSubscriptions() {
      return [...subs.values()];
    },
    seedSubscription(ref, remaining, consumed = 0) {
      subs.set(ref, Object.freeze({
        recipientRef: ref, templateId: 'TEMPLATE_OK_1',
        totalGranted: remaining + consumed, consumed, revoked: 0,
        grantEventIds: [], grantedAt: 1, updatedAt: 1
      }));
    },
    consumeSubscription(ref, now = 1) {
      const existing = subs.get(ref);
      if (!existing) return { ok: false, reason: 'no_grant', remaining: 0 };
      if (remainingOf(existing) <= 0) return { ok: false, reason: 'no_quota', remaining: 0 };
      const next = Object.freeze({ ...existing, consumed: existing.consumed + 1, updatedAt: now });
      subs.set(ref, next);
      return { ok: true, remaining: remainingOf(next) };
    },
    revokeSubscriptionQuota(ref, now = 1) {
      const existing = subs.get(ref);
      if (!existing) return null;
      if (remainingOf(existing) <= 0) return existing;
      const next = Object.freeze({ ...existing, revoked: existing.totalGranted - existing.consumed, updatedAt: now });
      subs.set(ref, next);
      return next;
    }
  };
}

/**
 * 可编程 fake provider。
 * @param {object} options
 *   - configured            是否已配置（默认 true）
 *   - tokenExpiresInMs      token 有效期（默认 7200_000）
 *   - failPlan              按调用序号给出结果：{ kind: 'ok'|'throw', error?, delayMs? }
 *   - tokenPlan             按 token 请求序号给出结果
 */
function createFakeProvider(options = {}) {
  const calls = { token: 0, send: 0, sends: [], tokens: [] };
  const state = {
    configured: options.configured !== false,
    tokenExpiresInMs: Number.isSafeInteger(options.tokenExpiresInMs) ? options.tokenExpiresInMs : 7200 * 1000
  };
  const sendPlan = Array.isArray(options.sendPlan) ? [...options.sendPlan] : [];
  const tokenPlan = Array.isArray(options.tokenPlan) ? [...options.tokenPlan] : [];

  return {
    name: 'fake',
    calls,
    state,
    isConfigured() {
      return state.configured === true;
    },
    async getAccessToken({ force } = {}) {
      calls.token += 1;
      const planned = tokenPlan.length > 0 ? tokenPlan.shift() : null;
      if (planned && planned.throw) throw planned.throw;
      const token = planned && planned.token ? planned.token : `token-${calls.token}`;
      calls.tokens.push({ token, force: force === true });
      return { token, expiresInMs: planned && planned.expiresInMs ? planned.expiresInMs : state.tokenExpiresInMs };
    },
    async sendSubscribeMessage(payload) {
      calls.send += 1;
      calls.sends.push({ ...payload });
      const planned = sendPlan.length > 0 ? sendPlan.shift() : { kind: 'ok' };
      if (planned.delayMs) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, planned.delayMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
        });
      }
      if (planned.kind === 'throw' || planned.error) throw planned.error || notifyError(NOTIFY_CODES.SERVER_ERROR, 'fake failure');
      return { ok: true };
    }
  };
}

function alarm(overrides = {}) {
  return {
    deviceId: 'dayu200-room-1',
    alarmId: 'alarm-1',
    room: '客厅',
    type: 'FALL',
    createdAt: 1_700_000_000_000,
    ...overrides
  };
}

/** 记录 sleep 调用，避免测试真的等待。 */
function recordingSleep() {
  const delays = [];
  const sleep = async (ms) => { delays.push(ms); };
  sleep.delays = delays;
  return sleep;
}

/* ------------------------------------------------------------ 隐私脱敏 */

test('redacts openid, access_token, AppSecret, phone and precise coordinates', () => {
  const line = redactLine(
    'openid=oABC123456789012345678 send access_token=abcdef1234567890 appsecret=deadbeefdeadbeef phone 13800001111 at 39.9042000,116.4074000'
  );
  assert.equal(line.includes('oABC123456789012345678'), false);
  assert.equal(line.includes('abcdef1234567890'), false);
  assert.equal(line.includes('deadbeefdeadbeef'), false);
  assert.equal(line.includes('13800001111'), false);
  assert.equal(line.includes('39.9042000'), false);
  assert.equal(line.includes('116.4074000'), false);
  assert.match(line, /<redacted,openid,/);
  assert.match(line, /<redacted,secret,/);
  assert.match(line, /<redacted,phone/);
  assert.match(line, /<redacted,coordinate/);
});

test('redacts secrets embedded in a URL query string', () => {
  const line = redactLine('GET https://api.weixin.qq.com/cgi-bin/token?secret=supersecretvalue&other=1');
  assert.equal(line.includes('supersecretvalue'), false);
  assert.match(line, /<redacted,secret,/);
});

test('deepRedact removes cycle-safe sensitive values from nested structures', () => {
  const payload = {
    event: 'send',
    openid: 'oXYZ987654321098765432',
    access_token: 'tok_abcdef123456',
    nested: { phone: '13900002222', list: ['ok', 'oXYZ987654321098765432'] }
  };
  const redacted = JSON.stringify(deepRedact(payload));
  assert.equal(redacted.includes('oXYZ987654321098765432'), false);
  assert.equal(redacted.includes('tok_abcdef123456'), false);
  assert.equal(redacted.includes('13900002222'), false);
  assert.equal(redacted.includes('"event":"send"'), true);
});

test('deepRedact and redactLine are total for hostile inputs', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => deepRedact(cyclic));
  assert.equal(redactLine(undefined), '');
  assert.equal(redactLine(12345), '');
  assert.equal(boundText('x'.repeat(5000)).length <= 512, true);
  const log = safeLogLine({ openid: 'oABC123456789012345678', err: notifyError(NOTIFY_CODES.NETWORK, 'failed') });
  assert.equal(log.includes('oABC123456789012345678'), false);
  assert.match(log, /^\[notify\] /);
});

/* ------------------------------------------------------------ 错误分类 */

test('classifies permanent vs retryable WeChat error codes', () => {
  assert.equal(isPermanentWechatError(43101), true, 'user refused the subscription');
  assert.equal(isPermanentWechatError(40003), true, 'invalid openid');
  assert.equal(isPermanentWechatError(40037), true, 'invalid template id');
  assert.equal(isPermanentWechatError(41030), true, 'invalid page path');
  assert.equal(isPermanentWechatError(45009), false, 'rate limited is retryable');
  assert.equal(isPermanentWechatError(-1), false, 'system busy is retryable');
  assert.equal(isPermanentWechatError(99999), false, 'unknown codes default to retryable');
  assert.equal(requiresTokenRefresh(40001), true);
  assert.equal(requiresTokenRefresh(42001), true);
  assert.equal(requiresTokenRefresh(43101), false);
  assert.equal(codeForWechatError(45009), NOTIFY_CODES.RATE_LIMITED);
  assert.equal(codeForWechatError(43101), NOTIFY_CODES.PERMANENT);
  assert.equal(codeForWechatError(-1), NOTIFY_CODES.SERVER_ERROR);
});

test('classifies HTTP 429, 5xx, timeout and network failures', () => {
  assert.equal(classifyHttpFailure(429).code, NOTIFY_CODES.RATE_LIMITED);
  assert.equal(classifyHttpFailure(429).retryable, true);
  assert.equal(classifyHttpFailure(503).code, NOTIFY_CODES.SERVER_ERROR);
  assert.equal(classifyHttpFailure(500).retryable, true);
  assert.equal(classifyHttpFailure(400).code, NOTIFY_CODES.HTTP_ERROR);
  assert.equal(classifyHttpFailure(400).retryable, false);
  const abort = new Error('The operation was aborted');
  abort.name = 'AbortError';
  assert.equal(classifyHttpFailure(undefined, abort).code, NOTIFY_CODES.TIMEOUT);
  assert.equal(classifyHttpFailure(undefined, new Error('socket hang up')).code, NOTIFY_CODES.NETWORK);
});

test('assertProvider rejects objects that do not implement the interface', () => {
  assert.throws(() => assertProvider(null), /provider/);
  assert.throws(() => assertProvider({ name: 'x' }), /isConfigured/);
  assert.doesNotThrow(() => assertProvider(createFakeProvider()));
});

/* ------------------------------------------------------------ access_token */

test('TokenManager caches a valid token and refreshes after expiry', async () => {
  let nowMs = 1_000_000;
  const provider = createFakeProvider({ tokenExpiresInMs: 7200 * 1000 });
  const manager = new TokenManager(provider, { now: () => nowMs });

  assert.equal(await manager.getToken(), 'token-1');
  assert.equal(await manager.getToken(), 'token-1', 'second call must hit the cache');
  assert.equal(provider.calls.token, 1);
  assert.equal(manager.cacheHitCount, 1);

  // 越过有效期（含提前刷新余量）后必须重新获取。
  nowMs += 7200 * 1000;
  assert.equal(await manager.getToken(), 'token-2');
  assert.equal(provider.calls.token, 2);
  assert.equal(manager.refreshCount, 2);
});

test('TokenManager coalesces concurrent token requests (single flight)', async () => {
  const provider = createFakeProvider();
  const manager = new TokenManager(provider);
  const [a, b, c] = await Promise.all([manager.getToken(), manager.getToken(), manager.getToken()]);
  assert.equal(a, 'token-1');
  assert.equal(b, 'token-1');
  assert.equal(c, 'token-1');
  assert.equal(provider.calls.token, 1, 'three concurrent callers must share one token request');
});

test('TokenManager.invalidate forces a refresh on the next call', async () => {
  const provider = createFakeProvider();
  const manager = new TokenManager(provider);
  assert.equal(await manager.getToken(), 'token-1');
  manager.invalidate();
  assert.equal(await manager.getToken(), 'token-2');
  assert.equal(provider.calls.token, 2);
});

test('createWechatProvider is not configured without credentials and never sends', async () => {
  const provider = createWechatProvider({ appId: '', appSecret: '', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(provider.isConfigured(), false);
  await assert.rejects(() => provider.getAccessToken(), (error) => error.code === NOTIFY_CODES.NOT_CONFIGURED);
  await assert.rejects(
    () => provider.sendSubscribeMessage({ accessToken: 't', openid: 'o', templateId: 'T', data: {} }),
    (error) => error.code === NOTIFY_CODES.NOT_CONFIGURED
  );
});

test('createWechatProvider surfaces 429 and 5xx from fetch without leaking the URL', async () => {
  const provider = createWechatProvider({
    appId: 'appid-placeholder',
    appSecret: 'secret-placeholder-value',
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) })
  });
  await assert.rejects(
    () => provider.getAccessToken(),
    (error) => error.code === NOTIFY_CODES.RATE_LIMITED && error.retryable === true
  );

  const serverError = createWechatProvider({
    appId: 'appid-placeholder',
    appSecret: 'secret-placeholder-value',
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) })
  });
  await assert.rejects(
    () => serverError.getAccessToken(),
    (error) => error.code === NOTIFY_CODES.SERVER_ERROR && error.message.includes('secret-placeholder-value') === false
  );
});

/* ------------------------------------------------------------ 模板字段 */

test('template fields are bounded to the WeChat 20-character limit', () => {
  assert.equal(templateField('客厅'), '客厅');
  assert.equal(templateField(''), '—');
  assert.equal(templateField('   '), '—');
  const long = templateField('x'.repeat(80));
  assert.equal(long.length <= 20, true);
  assert.equal(long.endsWith('…'), true);
  assert.equal(templateField('line\r\nbreak').includes('\n'), false);
  assert.equal(alarmTypeLabel('FALL'), '跌倒报警');
  assert.equal(alarmTypeLabel('unknown-type'), '检测到异常');
  assert.equal(formatAlarmTime(0), '——');
  assert.match(formatAlarmTime(1_700_000_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const data = buildTemplateData({ room: '卫生间', type: 'MANUAL_SOS', deviceId: 'dev-1', createdAt: 1_700_000_000_000 });
  assert.deepEqual(Object.keys(data), ['thing1', 'thing2', 'time3', 'thing4']);
  assert.equal(data.thing2.value, '一键求助');
});

test('backoff grows exponentially and is capped', () => {
  const config = { baseDelayMs: 500, maxDelayMs: 8000 };
  assert.equal(backoffDelayMs(1, config), 500);
  assert.equal(backoffDelayMs(2, config), 1000);
  assert.equal(backoffDelayMs(3, config), 2000);
  assert.equal(backoffDelayMs(4, config), 4000);
  assert.equal(backoffDelayMs(5, config), 8000);
  assert.equal(backoffDelayMs(9, config), 8000, 'must not exceed the cap');
});

test('normalizeAlarmInput rejects malformed alarms without throwing', () => {
  assert.equal(normalizeAlarmInput(null), null);
  assert.equal(normalizeAlarmInput({}), null);
  assert.equal(normalizeAlarmInput({ deviceId: 'dev-1' }), null);
  const normalized = normalizeAlarmInput({ id: 'alarm-9', deviceId: 'dev-1', createdAt: -5 });
  assert.equal(normalized.alarmId, 'alarm-9');
  assert.equal(normalized.createdAt, 0);
});

/* ------------------------------------------------------------ 投递行为 */

test('sends to every authorized guardian only after explicit opt-in', async () => {
  const provider = createFakeProvider();
  const delivery = createNotificationDelivery({ provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: createMemoryLedger() });
  const result = await delivery.notifyAlarm(alarm(), ['guardian-a', 'guardian-b']);

  assert.equal(result.status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(result.sent, 2);
  assert.equal(result.total, 2);
  assert.equal(provider.calls.send, 2);
  assert.deepEqual(provider.calls.sends.map((item) => item.openid), ['guardian-a', 'guardian-b']);
  assert.equal(provider.calls.sends[0].templateId, 'TEMPLATE_OK_1');
});

test('duplicate guardians are de-duplicated so nobody is notified twice', async () => {
  const provider = createFakeProvider();
  const delivery = createNotificationDelivery({ provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: createMemoryLedger() });
  const result = await delivery.notifyAlarm(alarm(), ['guardian-a', 'guardian-a', 'guardian-b', '']);
  assert.equal(result.sent, 2);
  assert.equal(result.total, 2);
  assert.equal(provider.calls.send, 2);
});

test('a user rejection is a permanent failure: no retry, recorded once', async () => {
  const ledger = createMemoryLedger();
  const sleep = recordingSleep();
  const provider = createFakeProvider({
    sendPlan: [{ kind: 'throw', error: notifyError(NOTIFY_CODES.PERMANENT, 'user refused', { errcode: 43101, permanent: true }) }]
  });
  const delivery = createNotificationDelivery({
    provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger, sleepImpl: sleep, maxAttempts: 3
  });
  const result = await delivery.notifyAlarm(alarm(), ['guardian-a']);

  assert.equal(result.status, AGGREGATE_STATUS.FAILED);
  assert.equal(result.permanentFailed, 1);
  assert.equal(provider.calls.send, 1, 'permanent failure must not be retried');
  assert.deepEqual(sleep.delays, [], 'no backoff sleep for permanent failures');
  const records = ledger.listNotifications();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, DELIVERY_STATUS.PERMANENT_FAILED);
  assert.equal(records[0].recipientRef.startsWith('r1_'), true, '台账只保存 recipientRef，不保存 openid');

  // 再次触发同一告警：该收件人已是终态，直接短路，不再调用 provider。
  const again = await delivery.notifyAlarm(alarm(), ['guardian-a']);
  assert.equal(again.status, AGGREGATE_STATUS.FAILED);
  assert.equal(provider.calls.send, 1);
});

test('an unconfigured template sends nothing and reports NOT_CONFIGURED', async () => {
  const provider = createFakeProvider();
  const ledger = createMemoryLedger();
  const delivery = createNotificationDelivery({ provider, templateId: '', recipientRefSecret: RECIPIENT_REF_SECRET, ledger });

  assert.equal(delivery.configured(), false);
  const result = await delivery.notifyAlarm(alarm(), ['guardian-a']);
  assert.equal(result.status, 'NOT_CONFIGURED');
  assert.equal(result.reason, 'template_not_configured');
  assert.equal(provider.calls.send, 0);
  assert.equal(provider.calls.token, 0);
  assert.equal(ledger.countNotifications(), 0, 'an unconfigured run must not consume a delivery attempt');
});

test('a provider that is not configured is treated as NOT_CONFIGURED', async () => {
  const provider = createFakeProvider({ configured: false });
  const delivery = createNotificationDelivery({ provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: createMemoryLedger() });
  const result = await delivery.notifyAlarm(alarm(), ['guardian-a']);
  assert.equal(result.status, 'NOT_CONFIGURED');
  assert.equal(provider.calls.send, 0);
});

test('no authorized guardian means nothing is sent and nothing is recorded', async () => {
  const provider = createFakeProvider();
  const ledger = createMemoryLedger();
  const delivery = createNotificationDelivery({ provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger });
  const result = await delivery.notifyAlarm(alarm(), []);
  assert.equal(result.status, 'NO_RECIPIENTS');
  assert.equal(provider.calls.send, 0);
  assert.equal(ledger.countNotifications(), 0);
});

test('the same deviceId + alarmId is delivered exactly once (idempotency)', async () => {
  const ledger = createMemoryLedger();
  const provider = createFakeProvider();
  const delivery = createNotificationDelivery({ provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger });

  const first = await delivery.notifyAlarm(alarm(), ['guardian-a']);
  assert.equal(first.status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(provider.calls.send, 1);

  const second = await delivery.notifyAlarm(alarm(), ['guardian-a']);
  assert.equal(second.status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(second.recipients[0].alreadySent, true);
  assert.equal(provider.calls.send, 1, 'a duplicate alarm must not be sent again');
  assert.equal(ledger.countNotifications(), 1);

  // 同一进程内的并发重复触发也只发送一次（单飞）。
  const concurrent = await Promise.all([
    delivery.notifyAlarm(alarm({ alarmId: 'alarm-2' }), ['guardian-a']),
    delivery.notifyAlarm(alarm({ alarmId: 'alarm-2' }), ['guardian-a'])
  ]);
  assert.equal(provider.calls.send, 2, 'one extra send for alarm-2 only');
  assert.equal(concurrent[0].status, AGGREGATE_STATUS.ALL_SENT);
});

test('temporary failures retry with exponential backoff and then succeed', async () => {
  const ledger = createMemoryLedger();
  const sleep = recordingSleep();
  const provider = createFakeProvider({
    sendPlan: [
      { kind: 'throw', error: notifyError(NOTIFY_CODES.SERVER_ERROR, 'boom', { retryable: true }) },
      { kind: 'throw', error: notifyError(NOTIFY_CODES.NETWORK, 'flaky', { retryable: true }) },
      { kind: 'ok' }
    ]
  });
  const delivery = createNotificationDelivery({
    provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger, sleepImpl: sleep,
    maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000
  });
  const result = await delivery.notifyAlarm(alarm(), ['guardian-a']);

  assert.equal(result.status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(result.recipients[0].attempts, 3);
  assert.equal(result.attemptCount, 3);
  assert.equal(provider.calls.send, 3);
  assert.deepEqual(sleep.delays, [500, 1000], 'exponential backoff between attempts');
  assert.equal(ledger.listNotifications()[0].attemptCount, 3);
});

test('exhausting temporary retries records FAILED and can be retried later', async () => {
  const ledger = createMemoryLedger();
  const sleep = recordingSleep();
  const provider = createFakeProvider({
    sendPlan: [
      { kind: 'throw', error: notifyError(NOTIFY_CODES.RATE_LIMITED, 'limited', { retryable: true }) },
      { kind: 'throw', error: notifyError(NOTIFY_CODES.RATE_LIMITED, 'limited', { retryable: true }) },
      { kind: 'throw', error: notifyError(NOTIFY_CODES.RATE_LIMITED, 'limited', { retryable: true }) },
      { kind: 'ok' }
    ]
  });
  const delivery = createNotificationDelivery({
    provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger, sleepImpl: sleep, maxAttempts: 3, baseDelayMs: 100
  });
  const exhausted = await delivery.notifyAlarm(alarm(), ['guardian-a']);
  assert.equal(exhausted.status, AGGREGATE_STATUS.FAILED);
  assert.equal(exhausted.recipients[0].errorCode, NOTIFY_CODES.RATE_LIMITED);
  assert.equal(ledger.listNotifications()[0].status, DELIVERY_STATUS.FAILED);

  // FAILED 不是终态：下一次触发继续重试并可以成功。
  const retried = await delivery.notifyAlarm(alarm(), ['guardian-a']);
  assert.equal(retried.status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(retried.attemptCount > exhausted.attemptCount, true, 'attemptCount is monotonic');
});

test('a token invalidation error triggers a forced refresh and the next attempt succeeds', async () => {
  const ledger = createMemoryLedger();
  const provider = createFakeProvider({
    sendPlan: [
      { kind: 'throw', error: notifyError(NOTIFY_CODES.TOKEN_INVALID, 'token expired', { errcode: 40001, refreshToken: true, retryable: true }) },
      { kind: 'ok' }
    ]
  });
  const delivery = createNotificationDelivery({
    provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger, sleepImpl: recordingSleep(), maxAttempts: 3
  });
  const result = await delivery.notifyAlarm(alarm(), ['guardian-a']);

  assert.equal(result.status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(result.recipients[0].attempts, 2);
  assert.equal(provider.calls.token, 2, 'the second attempt must fetch a fresh token');
  assert.equal(provider.calls.tokens[1].force, true, 'the refresh must be forced');
});

test('an expired token is refreshed by the TokenManager without any send failure', async () => {
  let nowMs = 0;
  const provider = createFakeProvider({ tokenExpiresInMs: 60000 });
  const delivery = createNotificationDelivery({
    provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: createMemoryLedger(), now: () => nowMs, sleepImpl: recordingSleep()
  });
  assert.equal((await delivery.notifyAlarm(alarm({ alarmId: 'a-1' }), ['g'])).status, AGGREGATE_STATUS.ALL_SENT);
  nowMs += 120000; // token expired
  assert.equal((await delivery.notifyAlarm(alarm({ alarmId: 'a-2' }), ['g'])).status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal(provider.calls.token, 2, 'an expired token must be re-fetched');
});

test('a permanent token/config failure stops retrying instead of hammering the API', async () => {
  const sleep = recordingSleep();
  const provider = createFakeProvider({
    tokenPlan: [{ throw: notifyError(NOTIFY_CODES.TOKEN_FAILED, 'bad appid', { permanent: true }) }]
  });
  const delivery = createNotificationDelivery({
    provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: createMemoryLedger(), sleepImpl: sleep, maxAttempts: 3
  });
  const result = await delivery.notifyAlarm(alarm(), ['guardian-a']);
  assert.equal(result.status, AGGREGATE_STATUS.FAILED);
  assert.equal(sleep.delays.length, 0, 'a permanent token failure must not sleep/retry');
  assert.equal(provider.calls.token, 1);
});

test('delivery never throws, even when the provider throws unexpected errors', async () => {
  const provider = createFakeProvider({
    sendPlan: [
      { kind: 'throw', error: new Error('unexpected internal failure') },
      { kind: 'throw', error: new Error('unexpected internal failure') },
      { kind: 'throw', error: new Error('unexpected internal failure') }
    ]
  });
  const delivery = createNotificationDelivery({
    provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: createMemoryLedger(), sleepImpl: recordingSleep(), maxAttempts: 3
  });
  const result = await delivery.notifyAlarm(alarm(), ['guardian-a']);
  assert.equal(result.status, AGGREGATE_STATUS.FAILED);
});

test('notifyAlarmInBackground never rejects and never throws synchronously', async () => {
  const provider = createFakeProvider({ sendPlan: [{ kind: 'throw', error: new Error('kaboom') }] });
  const delivery = createNotificationDelivery({
    provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: createMemoryLedger(), sleepImpl: recordingSleep(), maxAttempts: 1
  });
  const promise = delivery.notifyAlarmInBackground(alarm(), ['guardian-a']);
  assert.equal(typeof promise.then, 'function');
  await promise; // must resolve, not reject
  const bad = delivery.notifyAlarmInBackground(null, []);
  await bad;
});

test('delivery logs are redacted and never contain openid or access_token', async () => {
  const lines = [];
  const provider = createFakeProvider({
    sendPlan: [{ kind: 'throw', error: notifyError(NOTIFY_CODES.NETWORK, 'failed for openid=oSECRET123456789012345678', { retryable: true }) }]
  });
  const delivery = createNotificationDelivery({
    provider,
    templateId: 'TEMPLATE_OK_1',
    recipientRefSecret: RECIPIENT_REF_SECRET,
    ledger: createMemoryLedger(),
    sleepImpl: recordingSleep(),
    maxAttempts: 2,
    logger: { error: (message) => lines.push(String(message)) }
  });
  await delivery.notifyAlarm(alarm(), ['oGUARDIAN123456789012345678']);
  assert.equal(lines.length > 0, true, 'failures must be observable');
  const joined = lines.join('\n');
  assert.equal(joined.includes('oGUARDIAN123456789012345678'), false, 'openid must never be logged');
  assert.equal(joined.includes('oSECRET123456789012345678'), false, 'openid inside error text must be redacted');
  assert.match(joined, /<redacted,openid/);
});

test('the persisted ledger record never contains an openid', async () => {
  const ledger = createMemoryLedger();
  const provider = createFakeProvider();
  const delivery = createNotificationDelivery({ provider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger });
  await delivery.notifyAlarm(alarm(), ['oGUARDIAN123456789012345678']);
  const record = ledger.listNotifications()[0];
  const text = JSON.stringify(record);
  assert.equal(text.includes('oGUARDIAN123456789012345678'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'openid'), false);
  assert.deepEqual(Object.keys(record).sort(), [
    'alarmId', 'attemptCount', 'attempts', 'deviceId', 'errorCode', 'recipientRef', 'sentAt', 'status', 'templateId', 'updatedAt'
  ]);
});

test('getStatus reports configuration without leaking the template id or token', () => {
  const provider = createFakeProvider();
  const delivery = createNotificationDelivery({ provider, templateId: 'TEMPLATE_SECRETISH_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: createMemoryLedger() });
  const status = delivery.getStatus();
  const text = JSON.stringify(status);
  assert.equal(status.configured, true);
  assert.equal(status.templateConfigured, true);
  assert.equal(text.includes('TEMPLATE_SECRETISH_1'), false, 'status must not echo the template id');
  assert.equal(status.token.hasToken, false);
});

/* ------------------------------------------------------------ 进程重启恢复 */

test('restart recovery: a SENT alarm is not re-sent, a FAILED alarm is retried', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'state.json');

  // 第一次进程：告警 A 发送成功；告警 B 全部临时失败。
  const firstStore = new PersistentStore({ filePath });
  firstStore.ingest({
    deviceId: 'dayu200-room-1', room: '客厅', state: 'ALARM', ts: 1_700_000_000_000,
    alarm: { id: 'alarm-a', type: 'FALL' }
  });
  firstStore.ingest({
    deviceId: 'dayu200-room-1', room: '客厅', state: 'ALARM', ts: 1_700_000_001_000,
    alarm: { id: 'alarm-b', type: 'MANUAL_SOS' }
  });

  const firstProvider = createFakeProvider({
    sendPlan: [
      { kind: 'ok' },
      { kind: 'throw', error: notifyError(NOTIFY_CODES.NETWORK, 'down', { retryable: true }) },
      { kind: 'throw', error: notifyError(NOTIFY_CODES.NETWORK, 'down', { retryable: true }) }
    ]
  });
  const firstDelivery = createNotificationDelivery({
    provider: firstProvider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: firstStore, sleepImpl: recordingSleep(), maxAttempts: 2
  });
  assert.equal((await firstDelivery.notifyAlarm({ deviceId: 'dayu200-room-1', alarmId: 'alarm-a', room: '客厅', type: 'FALL', createdAt: 1_700_000_000_000 }, ['g'])).status, AGGREGATE_STATUS.ALL_SENT);
  assert.equal((await firstDelivery.notifyAlarm({ deviceId: 'dayu200-room-1', alarmId: 'alarm-b', room: '客厅', type: 'MANUAL_SOS', createdAt: 1_700_000_001_000 }, ['g'])).status, AGGREGATE_STATUS.FAILED);
  const failedRecord = firstStore.listNotifications().find((item) => item.alarmId === 'alarm-b');
  assert.ok(failedRecord, 'a failed delivery must be recorded in the ledger');
  assert.equal(failedRecord.attemptCount, 2);
  const ref = failedRecord.recipientRef;

  // 第二次进程：全新的 store 实例 + 全新的 delivery。
  const secondStore = new PersistentStore({ filePath });
  assert.equal(secondStore.readNotification('dayu200-room-1', 'alarm-a', ref).status, DELIVERY_STATUS.SENT);
  assert.equal(secondStore.readNotification('dayu200-room-1', 'alarm-b', ref).status, DELIVERY_STATUS.FAILED);

  const secondProvider = createFakeProvider();
  const secondDelivery = createNotificationDelivery({
    provider: secondProvider, templateId: 'TEMPLATE_OK_1', recipientRefSecret: RECIPIENT_REF_SECRET, ledger: secondStore, sleepImpl: recordingSleep()
  });
  const resent = await secondDelivery.notifyAlarm({ deviceId: 'dayu200-room-1', alarmId: 'alarm-a', room: '客厅', type: 'FALL', createdAt: 1_700_000_000_000 }, ['g']);
  assert.equal(resent.recipients[0].alreadySent, true);
  assert.equal(secondProvider.calls.send, 0, 'a SENT alarm must not be re-sent after restart');

  const resumed = await secondDelivery.notifyAlarm({ deviceId: 'dayu200-room-1', alarmId: 'alarm-b', room: '客厅', type: 'MANUAL_SOS', createdAt: 1_700_000_001_000 }, ['g']);
  assert.equal(resumed.status, AGGREGATE_STATUS.ALL_SENT, 'a FAILED alarm must be retried after restart');
  assert.equal(secondProvider.calls.send, 1);
  assert.equal(resumed.attemptCount > 2, true, 'attemptCount continued across the restart');

  // 台账文本里绝不出现 openid。
  const text = fs.readFileSync(filePath, 'utf8');
  assert.equal(text.includes('openid'), false);
  assert.equal(text.includes('access_token'), false);
});
