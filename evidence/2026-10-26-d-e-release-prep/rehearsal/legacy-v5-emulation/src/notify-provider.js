'use strict';

/**
 * notify-provider.js — 微信订阅消息「提供者接口」+ 生产实现 + access_token 管理
 *
 * 为什么要有提供者接口：告警推送必须能在**没有真实微信账号**的环境下被确定性地测试。
 * 因此本模块把「怎么拿到 access_token」「怎么发一条订阅消息」收敛成一个可替换的 provider，
 * 由 `sendAlarmNotification` 通过依赖注入使用。测试注入 fake provider 即可覆盖
 * 用户拒绝、永久失败、429、5xx、超时、token 过期刷新与进程重启恢复。
 *
 * 安全边界：
 *   - 本模块**不读取 process.env**；AppID/AppSecret 由调用方（main.js）显式注入。
 *   - 日志与错误消息一律经 notify-privacy 脱敏；任何错误都不回显 openid、secret、
 *     access_token 或完整请求 URL。
 *   - 真实 API 调用只在生产 provider 里发生，且默认超时（8s），不重试整页请求。
 */

const { boundText, redactLine } = require('./notify-privacy');

const TOKEN_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/token';
const SEND_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send';

/** 稳定错误码：调用方按码判断，不解析错误文本。 */
const NOTIFY_CODES = Object.freeze({
  NOT_CONFIGURED: 'NOTIFY_NOT_CONFIGURED',
  INVALID_INPUT: 'NOTIFY_INVALID_INPUT',
  HTTP_ERROR: 'NOTIFY_HTTP_ERROR',
  RATE_LIMITED: 'NOTIFY_RATE_LIMITED',
  SERVER_ERROR: 'NOTIFY_SERVER_ERROR',
  PERMANENT: 'NOTIFY_PERMANENT',
  NETWORK: 'NOTIFY_NETWORK',
  TIMEOUT: 'NOTIFY_TIMEOUT',
  TOKEN_FAILED: 'NOTIFY_TOKEN_FAILED',
  TOKEN_INVALID: 'NOTIFY_TOKEN_INVALID'
});

/**
 * 微信订阅消息返回码分类表。
 *
 * 依据微信公开错误码语义，把「重试有意义」和「重试无意义」分开：
 *   43101 用户拒绝接收订阅消息 / 未订阅 -> 永久（继续重试只会浪费配额）
 *   40003 非法 openid                  -> 永久
 *   40037 模板 ID 无效                 -> 永久（本地模板配置错误）
 *   41030 页面路径不存在               -> 永久
 *   40001/42001 access_token 失效      -> 需要刷新 token 后重试
 *   45009 接口调用超过限制             -> 限流，退避后重试
 *   -1    系统繁忙                     -> 临时，退避后重试
 */
const WECHAT_ERROR_RULES = Object.freeze({
  40001: { code: NOTIFY_CODES.TOKEN_INVALID, retry: 'refresh_token', permanent: false },
  40003: { code: NOTIFY_CODES.PERMANENT, retry: 'never', permanent: true },
  40037: { code: NOTIFY_CODES.PERMANENT, retry: 'never', permanent: true },
  41030: { code: NOTIFY_CODES.PERMANENT, retry: 'never', permanent: true },
  42001: { code: NOTIFY_CODES.TOKEN_INVALID, retry: 'refresh_token', permanent: false },
  43101: { code: NOTIFY_CODES.PERMANENT, retry: 'never', permanent: true },
  45009: { code: NOTIFY_CODES.RATE_LIMITED, retry: 'backoff', permanent: false },
  45011: { code: NOTIFY_CODES.RATE_LIMITED, retry: 'backoff', permanent: false }
});

/**
 * 一个 HTTP 状态码 -> 稳定错误码的兜底规则（当响应体不是微信 errcode JSON 时使用）。
 * 429 -> 限流；5xx -> 服务端错误。
 */
function codeForHttpStatus(status) {
  if (status === 429) return NOTIFY_CODES.RATE_LIMITED;
  if (Number.isFinite(status) && status >= 500) return NOTIFY_CODES.SERVER_ERROR;
  if (status === 401 || status === 403) return NOTIFY_CODES.TOKEN_FAILED;
  return NOTIFY_CODES.HTTP_ERROR;
}

/**
 * 判定一个微信 errcode 是否属于「永久失败」（重试无意义）。
 * 未知 errcode 视为**临时**失败，退避重试，避免把可恢复问题误判为永久。
 */
function isPermanentWechatError(errcode) {
  const rule = WECHAT_ERROR_RULES[Number(errcode)];
  if (rule) return rule.permanent === true;
  // 未登记的 4 万段错误码按回退规则处理，其余视为临时。
  return false;
}

/** 判定一个微信 errcode 是否要求刷新 access_token 后重试。 */
function requiresTokenRefresh(errcode) {
  const rule = WECHAT_ERROR_RULES[Number(errcode)];
  return Boolean(rule && rule.retry === 'refresh_token');
}

/**
 * 把微信 errcode 映射为稳定的内部错误码。
 * 未知 errcode 归入 PERMANENT？不：归入 SERVER_ERROR（临时），并标 permanent=false。
 */
function codeForWechatError(errcode) {
  const rule = WECHAT_ERROR_RULES[Number(errcode)];
  return rule ? rule.code : NOTIFY_CODES.SERVER_ERROR;
}

/** 构造一个带稳定 code 的通知错误（消息本身也脱敏）。 */
function notifyError(code, message, extra = {}) {
  const error = new Error(redactLine(boundText(String(message || code), 200)));
  error.code = code;
  if (extra.errcode !== undefined) error.errcode = Number(extra.errcode);
  if (extra.status !== undefined) error.status = Number(extra.status);
  if (extra.retryable !== undefined) error.retryable = extra.retryable === true;
  if (extra.permanent !== undefined) error.permanent = extra.permanent === true;
  if (extra.refreshToken !== undefined) error.refreshToken = extra.refreshToken === true;
  return error;
}

/**
 * 把「HTTP 状态码 + 传输异常」分类为稳定错误码。
 * 429 -> RATE_LIMITED（可退避重试）；5xx -> SERVER_ERROR（可退避重试）；
 * AbortError/TimeoutError -> TIMEOUT；其他网络异常 -> NETWORK。
 * 这些都不含永久标记，因此会进入退避重试。
 */
function classifyHttpFailure(status, error) {
  if (error) {
    const name = error && typeof error.name === 'string' ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError' || /abort|timeout/i.test(String(error.message || ''))) {
      return notifyError(NOTIFY_CODES.TIMEOUT, 'WeChat API request timed out', { retryable: true });
    }
    return notifyError(NOTIFY_CODES.NETWORK, 'WeChat API request failed', { retryable: true });
  }
  if (status === 429) {
    return notifyError(NOTIFY_CODES.RATE_LIMITED, 'WeChat API rate limited', { status, retryable: true });
  }
  if (Number.isFinite(status) && status >= 500) {
    return notifyError(NOTIFY_CODES.SERVER_ERROR, 'WeChat API server error', { status, retryable: true });
  }
  return notifyError(NOTIFY_CODES.HTTP_ERROR, 'WeChat API rejected the request', { status, retryable: false });
}

/* ------------------------------------------------------------ 提供者接口 */

/**
 * 提供者接口（鸭子类型）。实现必须提供：
 *
 *   provider.name                            // 稳定名字，用于台账与日志
 *   provider.isConfigured()                  // 未配置时返回 false，调用方跳过发送
 *   provider.getAccessToken({ force })       // -> { token, expiresInMs }（force=true 时强制刷新）
 *   provider.sendSubscribeMessage({ accessToken, openid, templateId, page, data })
 *                                            // -> { ok: true } 或 throw notifyError(...)
 *
 * 约束：实现**不得**把 openid / access_token / secret 写入日志或返回值。
 */
function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') throw notifyError(NOTIFY_CODES.NOT_CONFIGURED, 'notification provider is required');
  for (const method of ['isConfigured', 'getAccessToken', 'sendSubscribeMessage']) {
    if (typeof provider[method] !== 'function') {
      throw notifyError(NOTIFY_CODES.NOT_CONFIGURED, `notification provider must implement ${method}()`);
    }
  }
  return provider;
}

/* ------------------------------------------------------------ 生产提供者 */

/** 微信 access_token 的官方有效期是 7200 秒；这里提前 300 秒刷新。 */
const TOKEN_TTL_MS = 7200 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 300 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 生产微信提供者。
 * @param {object} options
 * @param {string} options.appId
 * @param {string} options.appSecret
 * @param {Function} [options.fetchImpl]  注入的 fetch（测试用）
 * @param {Function} [options.now]        注入的时钟（测试用）
 * @param {number}  [options.timeoutMs]
 */
function createWechatProvider(options = {}) {
  const appId = typeof options.appId === 'string' ? options.appId : '';
  const appSecret = typeof options.appSecret === 'string' ? options.appSecret : '';
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  let cached = null; // { token, expiresAtMs }
  let inflight = null;

  const configured = () => appId !== '' && appSecret !== '' && typeof fetchImpl === 'function';

  async function fetchAccessToken() {
    const url = new URL(TOKEN_ENDPOINT);
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw classifyHttpFailure(undefined, error);
    }
    const status = Number(response && response.status);
    // 注意：微信经常用 HTTP 200 + errcode 表达业务错误，失败时也可能带 JSON body。
    // 因此先尝试读 body 里的 errcode，读不到再退回 HTTP 状态码分类。
    let payload = null;
    if (response && typeof response.json === 'function') {
      try {
        payload = await response.json();
      } catch (_) {
        payload = null;
      }
    }
    if (!response || response.ok !== true) {
      const errcode = payload && payload.errcode !== undefined ? Number(payload.errcode) : undefined;
      if (errcode !== undefined && !Number.isNaN(errcode)) {
        throw notifyError(codeForWechatError(errcode), 'WeChat token request was rejected', {
          errcode,
          permanent: isPermanentWechatError(errcode),
          retryable: !isPermanentWechatError(errcode)
        });
      }
      throw notifyError(
        codeForHttpStatus(status),
        status === 429 ? 'WeChat API rate limited' : 'WeChat API rejected the request',
        { status, retryable: status === 429 || (Number.isFinite(status) && status >= 500) }
      );
    }
    if (payload && payload.access_token) {
      const expiresInMs = Number.isFinite(Number(payload.expires_in))
        ? Math.max(60000, Number(payload.expires_in) * 1000)
        : TOKEN_TTL_MS;
      return { token: String(payload.access_token), expiresInMs };
    }
    const errcode = payload && payload.errcode !== undefined ? Number(payload.errcode) : undefined;
    throw notifyError(
      errcode === undefined ? NOTIFY_CODES.TOKEN_FAILED : codeForWechatError(errcode),
      'WeChat token request was rejected',
      {
        errcode,
        // 40013 非法 AppID、40125 非法 AppSecret 属配置错误，重试无意义。
        permanent: errcode === 40013 || errcode === 40125,
        retryable: !(errcode === 40013 || errcode === 40125)
      }
    );
  }

  return {
    name: 'wechat',
    isConfigured: configured,
    /** 仅供测试/诊断：清空内存缓存。 */
    resetTokenCache() {
      cached = null;
      inflight = null;
    },
    async getAccessToken({ force = false } = {}) {
      if (!configured()) throw notifyError(NOTIFY_CODES.NOT_CONFIGURED, 'WeChat credentials are not configured');
      if (force) {
        cached = null;
        inflight = null;
      } else if (cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now()) {
        return { token: cached.token, expiresInMs: cached.expiresAtMs - now() };
      }
      // 单飞：并发的告警推送共用同一次 token 请求，避免刷爆接口。
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const fresh = await fetchAccessToken();
          // 失效边界：不把绝对过期时间暴露给调用方以外的持久化路径。
          cached = { token: fresh.token, expiresAtMs: now() + fresh.expiresInMs };
          return { token: cached.token, expiresInMs: fresh.expiresInMs };
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    async sendSubscribeMessage({ accessToken, openid, templateId, page, data }) {
      if (!configured()) throw notifyError(NOTIFY_CODES.NOT_CONFIGURED, 'WeChat credentials are not configured');
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw notifyError(NOTIFY_CODES.TOKEN_INVALID, 'missing access token', { refreshToken: true, retryable: true });
      }
      const url = new URL(SEND_ENDPOINT);
      url.searchParams.set('access_token', accessToken);
      const body = {
        touser: openid,
        template_id: templateId,
        page: typeof page === 'string' && page ? page : undefined,
        miniprogram_state: options.miniprogramState || 'formal',
        lang: 'zh_CN',
        data
      };
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        throw classifyHttpFailure(undefined, error);
      }
      const status = Number(response && response.status);
      if (!response || response.ok !== true) throw classifyHttpFailure(status, null);
      let payload;
      try {
        payload = await response.json();
      } catch (_) {
        throw notifyError(NOTIFY_CODES.SERVER_ERROR, 'WeChat send response was not JSON', { retryable: true });
      }
      const errcode = payload && payload.errcode !== undefined ? Number(payload.errcode) : 0;
      if (errcode === 0) return { ok: true };
      throw notifyError(codeForWechatError(errcode), 'WeChat rejected the subscribe message', {
        errcode,
        permanent: isPermanentWechatError(errcode),
        refreshToken: requiresTokenRefresh(errcode),
        retryable: !isPermanentWechatError(errcode)
      });
    }
  };
}

/* ------------------------------------------------------------ access_token 管理 */

/**
 * access_token 管理器：在提供者之上处理缓存、提前刷新、过期刷新与单飞。
 *
 * 与 provider 的分工：provider 只负责「真的去拿一次 token」，管理器负责
 * 「什么时候需要拿、并发怎么合并、失效后怎么强制刷新」。
 */
class TokenManager {
  constructor(provider, options = {}) {
    this.provider = assertProvider(provider);
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._token = null;
    this._expiresAtMs = 0;
    this._inflight = null;
    this.refreshCount = 0;
    this.cacheHitCount = 0;
  }

  /** 缓存是否仍然有效（留出提前刷新余量）。 */
  isValid() {
    return (
      typeof this._token === 'string' &&
      this._token !== '' &&
      this._expiresAtMs - TOKEN_REFRESH_MARGIN_MS > this._now()
    );
  }

  /** 丢弃当前 token（收到 40001/42001 后调用，下次请求强制刷新）。 */
  invalidate() {
    this._token = null;
    this._expiresAtMs = 0;
  }

  /**
   * 取一个可用 token。同一时刻只有一个真实请求在飞。
   * @param {object} [options]
   * @param {boolean} [options.force] 强制刷新
   * @returns {Promise<string>}
   */
  async getToken({ force = false } = {}) {
    if (force) this.invalidate();
    if (this.isValid()) {
      this.cacheHitCount += 1;
      return this._token;
    }
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      try {
        const result = await this.provider.getAccessToken({ force });
        const token = result && typeof result.token === 'string' ? result.token : '';
        const expiresInMs = result && Number.isFinite(Number(result.expiresInMs)) ? Number(result.expiresInMs) : TOKEN_TTL_MS;
        if (!token) throw notifyError(NOTIFY_CODES.TOKEN_FAILED, 'provider returned an empty access token', { retryable: true });
        this._token = token;
        this._expiresAtMs = this._now() + Math.max(60000, expiresInMs);
        this.refreshCount += 1;
        return token;
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  /** 诊断快照：**不包含 token 本身**。 */
  getStatus() {
    return Object.freeze({
      provider: this.provider.name || 'unknown',
      configured: this.provider.isConfigured() === true,
      hasToken: typeof this._token === 'string' && this._token !== '',
      valid: this.isValid(),
      refreshCount: this.refreshCount,
      cacheHitCount: this.cacheHitCount,
      expiresInMs: this.isValid() ? Math.max(0, this._expiresAtMs - this._now()) : 0
    });
  }
}

module.exports = {
  NOTIFY_CODES,
  TOKEN_ENDPOINT,
  TOKEN_TTL_MS,
  TOKEN_REFRESH_MARGIN_MS,
  WECHAT_ERROR_RULES,
  DEFAULT_TIMEOUT_MS,
  isPermanentWechatError,
  requiresTokenRefresh,
  codeForWechatError,
  notifyError,
  classifyHttpFailure,
  codeForHttpStatus,
  assertProvider,
  createWechatProvider,
  TokenManager
};
