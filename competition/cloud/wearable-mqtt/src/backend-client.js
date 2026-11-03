'use strict';

/**
 * backend-client.js — 可信后端 HTTP 客户端（零依赖，手写 http/https）。
 *
 * 只封装契约 §5 用到的三个调用（公网现网镜像没有 wearable location 路由，
 * 位置改为随 device-status 的 gps 字段上报，见 DESIGN-CONTRACT §5.1）：
 *   POST /internal/v1/device-status            (x-ingest-key)  -> 202
 *   GET  /internal/v1/commands?after=N          (x-ingest-key)  -> {commands:[...]}
 *   POST /internal/v1/commands/<id>/result      (x-ingest-key)  -> 200
 *
 * 关键边界：
 *   - `x-ingest-key` 只存在内存与请求头，绝不写日志；
 *   - 失败按指数退避重试（网络错误/超时/429/5xx），4xx 业务错误不重试，避免放大误配置；
 *   - 日志/诊断只暴露固定错误码与 HTTP 状态码，不暴露响应体/密钥；
 *   - 响应体有硬上限（默认 256 KiB），异常大响应直接断开，防止内存被拖爆。
 */

const http = require('node:http');
const https = require('node:https');

const MAX_RESPONSE_BYTES = 256 * 1024;

const COMMAND_ID_RE = /^[1-9][0-9]{0,15}$/;
const ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const RESULT_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;

function safeCode(error, fallback = 'UNKNOWN') {
  const code = error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : (typeof error === 'string' ? error : '');
  return /^[A-Z][A-Z0-9_]{2,39}$/.test(code) ? code : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

class BackendClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl 形如 http://backend:8080
   * @param {string} options.ingestKey
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxAttempts] 单次调用最多尝试次数（含首次）
   * @param {number} [options.backoffBaseMs]
   * @param {number} [options.backoffMaxMs]
   * @param {object} [options.logger]
   * @param {() => number} [options.now]
   * @param {Function} [options.httpRequest] 测试注入点 (options, body, cb)
   */
  constructor(options = {}) {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.length === 0) {
      throw new TypeError('BackendClient requires baseUrl');
    }
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError('BackendClient baseUrl must use http or https');
    }
    if (parsed.search || parsed.hash) throw new TypeError('BackendClient baseUrl must not contain query or fragment');
    this.protocol = parsed.protocol;
    this.hostname = parsed.hostname;
    this.port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    this.basePath = parsed.pathname.replace(/\/+$/, '');
    this.origin = `${parsed.protocol}//${parsed.host}`;
    this.ingestKey = typeof options.ingestKey === 'string' ? options.ingestKey : '';
    this.timeoutMs = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
    this.maxAttempts = options.maxAttempts === undefined ? 4 : options.maxAttempts;
    this.backoffBaseMs = options.backoffBaseMs === undefined ? 500 : options.backoffBaseMs;
    this.backoffMaxMs = options.backoffMaxMs === undefined ? 8000 : options.backoffMaxMs;
    this.logger = options.logger || null;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.httpRequest = typeof options.httpRequest === 'function' ? options.httpRequest : defaultHttpRequest;
    this.sleep = typeof options.sleep === 'function' ? options.sleep : sleep;

    this.counters = {
      requests: 0,
      responsesOk: 0,
      failures: 0,
      retries: 0,
      deviceStatus: 0,
      commandPolls: 0,
      commandResults: 0,
      lastErrorCode: '',
      lastErrorStatus: 0,
      lastErrorAt: 0
    };
  }

  /** POST /internal/v1/device-status；返回 {ok, statusCode, json, code, attempts} */
  async postDeviceStatus(body) {
    this.counters.deviceStatus += 1;
    return this._request('POST', '/internal/v1/device-status', { body, auth: true });
  }

  /** GET /internal/v1/commands?after=N；返回 {ok, statusCode, json, code, attempts} */
  async getCommands(after) {
    this.counters.commandPolls += 1;
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    return this._request('GET', `/internal/v1/commands?after=${cursor}`, { auth: true });
  }

  /** POST /internal/v1/commands/<id>/result；返回 {ok, statusCode, json, code, attempts} */
  async postCommandResult(commandId, body) {
    this.counters.commandResults += 1;
    if (typeof commandId !== 'string' || !COMMAND_ID_RE.test(commandId)) {
      return { ok: false, statusCode: 0, json: null, code: 'INVALID_COMMAND_ID', attempts: 0 };
    }
    return this._request('POST', `/internal/v1/commands/${encodeURIComponent(commandId)}/result`, {
      body,
      auth: true
    });
  }

  /**
   * 公网现网后端没有 `GET/POST /api/v1/ingest/wearable/location` 路由（实测 404），
   * 位置改为随 `POST /internal/v1/device-status` 的 `gps` 字段上报。
   * 这里不保留 location 请求方法，避免误配置后仍去刷不存在的接口。
   */

  /** 诊断快照：绝不含密钥、token、完整 URL。 */
  snapshot() {
    return {
      origin: this.origin,
      counters: { ...this.counters },
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts
    };
  }

  /* ------------------------------------------------------------------ 内部 */

  async _request(method, path, options) {
    let attempt = 0;
    let last = { ok: false, statusCode: 0, json: null, code: 'REQUEST_FAILED', attempts: 0 };
    while (attempt < this.maxAttempts) {
      attempt += 1;
      last = await this._requestOnce(method, path, options);
      last.attempts = attempt;
      if (last.ok) {
        this.counters.responsesOk += 1;
        return last;
      }
      const retryable = last.retryable === true;
      this.counters.failures += 1;
      this.counters.lastErrorCode = safeCode(last.code);
      this.counters.lastErrorStatus = last.statusCode || 0;
      this.counters.lastErrorAt = this.now();
      if (!retryable || attempt >= this.maxAttempts) break;
      this.counters.retries += 1;
      const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * (2 ** (attempt - 1)));
      this._log('warn', 'BACKEND_RETRY', {
        method,
        path: path.split('?')[0],
        code: this.counters.lastErrorCode,
        statusCode: this.counters.lastErrorStatus,
        attempt,
        delayMs: delay
      });
      await this.sleep(delay);
    }
    this._log('warn', 'BACKEND_REQUEST_FAILED', {
      method,
      path: path.split('?')[0],
      code: safeCode(last.code),
      statusCode: last.statusCode || 0,
      attempts: attempt
    });
    return last;
  }

  _requestOnce(method, path, options) {
    const fullPath = `${this.basePath}${path}`;
    const headers = { accept: 'application/json' };
    let encodedBody;
    if (options.body !== undefined) {
      encodedBody = Buffer.from(JSON.stringify(options.body), 'utf8');
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(encodedBody.length);
    }
    if (options.auth) headers['x-ingest-key'] = this.ingestKey;

    const requestOptions = {
      protocol: this.protocol,
      hostname: this.hostname,
      port: this.port,
      path: fullPath,
      method,
      timeout: this.timeoutMs,
      headers,
      // 每次请求独立短连接：长连接 keep-alive 会让后端/测试服务器 close() 等待空闲连接，
      // 单进程小流量场景下没有复用收益。
      agent: false
    };

    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        this.counters.requests += 1;
        resolve(value);
      };
      try {
        this.httpRequest(requestOptions, encodedBody, (error, response) => {
          if (error) {
            done({
              ok: false,
              statusCode: 0,
              json: null,
              code: safeCode(error, 'NETWORK_ERROR'),
              retryable: true
            });
            return;
          }
          const statusCode = response && response.statusCode;
          if (typeof statusCode !== 'number') {
            done({ ok: false, statusCode: 0, json: null, code: 'BAD_RESPONSE', retryable: true });
            return;
          }
          const text = response && typeof response.text === 'string' ? response.text : '';
          let json = null;
          if (text.length > 0) {
            try {
              json = JSON.parse(text);
            } catch {
              // 2xx 但响应不是 JSON：调用方需要按业务语义判断，标记为 BAD_JSON。
              done({
                ok: statusCode >= 200 && statusCode < 300,
                statusCode,
                json: null,
                code: statusCode >= 200 && statusCode < 300 ? 'BAD_JSON' : 'HTTP_ERROR',
                retryable: statusCode >= 500
              });
              return;
            }
          }
          if (statusCode >= 200 && statusCode < 300) {
            done({ ok: true, statusCode, json, code: '' });
            return;
          }
          done({
            ok: false,
            statusCode,
            json,
            code: statusCode === 429 ? 'HTTP_429' : 'HTTP_ERROR',
            retryable: statusCode === 429 || statusCode >= 500
          });
        });
      } catch (error) {
        done({ ok: false, statusCode: 0, json: null, code: safeCode(error, 'REQUEST_CREATE_FAILED'), retryable: true });
      }
    });
  }

  _log(level, code, fields) {
    if (!this.logger || typeof this.logger[level] !== 'function') return;
    this.logger[level](code, fields || {});
  }
}

function defaultHttpRequest(options, body, callback) {
  const transport = options.protocol === 'https:' ? https : http;
  let settled = false;
  const done = (error, response) => {
    if (settled) return;
    settled = true;
    callback(error, response);
  };
  let request;
  try {
    request = transport.request(options, (response) => {
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy();
          const error = new Error('backend response too large');
          error.code = 'RESPONSE_TOO_LARGE';
          done(error, null);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => done(null, {
        statusCode: response.statusCode,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
  } catch (error) {
    done(Object.assign(new Error('backend request could not be created'), { code: 'REQUEST_CREATE_FAILED' }), null);
    return;
  }
  request.on('error', (error) => done(error, null));
  request.setTimeout(options.timeout || 5000, () => {
    const error = new Error('backend request timed out');
    error.code = 'REQUEST_TIMEOUT';
    request.destroy(error);
  });
  request.end(body === undefined ? undefined : body);
}

module.exports = Object.freeze({
  BackendClient,
  MAX_RESPONSE_BYTES,
  COMMAND_ID_RE,
  ALARM_ID_RE,
  RESULT_CODE_RE,
  defaultHttpRequest
});
