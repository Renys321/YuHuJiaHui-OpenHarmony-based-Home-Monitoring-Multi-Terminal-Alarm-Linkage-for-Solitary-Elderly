'use strict';

/**
 * 后端专用的 DeepSeek 健康科普建议客户端，规范见 docs/AI-HEALTH-ASSESSMENT-SPEC.md §2.3/§3。
 *
 * API Key 只靠注入（main.js 从 process.env.DEEPSEEK_API_KEY 读），本模块不读环境变量、
 * 不硬编码、不打印、不返回、不落盘 Key。端点固定为 {DEEPSEEK_BASE_URL}/chat/completions，
 * 必须 https，客户端改不了。
 *
 * 超时是单次 AbortSignal.timeout，总预算不超过 (maxRetries+1) × timeout；最多重试 1 次，
 * 且只对网络错误、超时、429、5xx 重试。
 *
 * 上游响应必须 2xx、JSON 可解析、choices[0].message.content 是非空字符串、内容 ≤ 20000 字节、
 * 剥掉 ```json 围栏后是对象、四段字段类型和长度合法、且不命中红线词。任一不满足就返回明确
 * 错误码，绝不编造建议。disclaimer 由服务端固定常量覆盖，模型给的一律丢弃。
 *
 * 允许内存短期缓存，key = ownerRef + "\0" + sha256(profile)，TTL 默认 300000ms、容量 64；
 * 只缓存已校验的建议对象，不落盘，进程退出即失效，命中时也会重新强制 disclaimer。
 * 本模块不打日志，失败码由路由层以 [backend] HEALTH_* 打印。
 */

const {
  HEALTH_ADVICE_DISCLAIMER,
  HEALTH_ADVICE_SYSTEM_PROMPT,
  buildHealthAdviceUserMessage,
  scanHealthAdviceRedLines
} = require('./health-advice-prompt');
const { hashHealthProfile, isPlainObject } = require('./health-profile');

/** AI 未配置（无 DEEPSEEK_API_KEY）。 */
const AI_NOT_CONFIGURED = 'AI_NOT_CONFIGURED';
/** AI 超时（含重试后仍超时）。 */
const AI_TIMEOUT = 'AI_TIMEOUT';
/** AI 其它失败：网络/非 2xx/空内容/非法 JSON/超长/红线词。 */
const AI_UPSTREAM_ERROR = 'AI_UPSTREAM_ERROR';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_CACHE_TTL_MS = 300000;
const DEFAULT_CACHE_MAX = 64;
/** 上游 content 最大字节数（§3）。 */
const MAX_CONTENT_BYTES = 20000;
/** 模型名白名单（§3）。 */
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** 建议四段数组的字段名。 */
const ADVICE_SECTION_FIELDS = Object.freeze(['diet', 'exerciseAndSleep', 'warningSigns']);
const MAX_SECTION_ITEMS = 8;
const MAX_SECTION_ITEM_CHARS = 300;
const MAX_SUMMARY_CHARS = 2000;

function intInRange(value, fallback, name, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

/**
 * 规范化 HTTPS base URL：必须 https，不带账号密码、query 和 fragment，去掉尾部斜杠。
 * 非 https 一律 fail-closed（§3）。
 */
function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const candidate = raw === '' ? DEFAULT_BASE_URL : raw;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('DEEPSEEK_BASE_URL must be a valid https URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('DEEPSEEK_BASE_URL must be an https URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('DEEPSEEK_BASE_URL must not contain credentials');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('DEEPSEEK_BASE_URL must not contain a query or fragment');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * 校验并规范化客户端配置。
 *
 * @param {object} options
 * @param {string} [options.apiKey] 空串 = 未配置（功能关闭）
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {number|string} [options.timeoutMs]
 * @param {number|string} [options.maxRetries]
 * @param {number|string} [options.cacheTtlMs]
 * @param {number|string} [options.cacheMax]
 * @returns {{configured:boolean, apiKey:string, baseUrl:string, endpoint:string,
 *            model:string, timeoutMs:number, maxRetries:number,
 *            cacheTtlMs:number, cacheMax:number}}
 */
function normalizeClientOptions(options = {}) {
  if (!isPlainObject(options)) throw new Error('deepseek options must be a plain object');
  const rawKey = typeof options.apiKey === 'string' ? options.apiKey : '';
  const apiKey = rawKey.trim();
  if (apiKey !== '' && apiKey.length < 20) {
    // 只报规则，不回显 Key 内容，连长度之外的片段也不带。
    throw new Error('DEEPSEEK_API_KEY must be at least 20 characters when set');
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const model = (() => {
    const raw = options.model === undefined || options.model === null ? DEFAULT_MODEL : options.model;
    if (typeof raw !== 'string' || !MODEL_RE.test(raw.trim())) {
      throw new Error('DEEPSEEK_MODEL must match ^[A-Za-z0-9._-]{1,64}$');
    }
    return raw.trim();
  })();
  return {
    configured: apiKey !== '',
    apiKey,
    baseUrl,
    endpoint: `${baseUrl}/chat/completions`,
    model,
    timeoutMs: intInRange(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'DEEPSEEK_TIMEOUT_MS', 1000, 15000),
    maxRetries: intInRange(options.maxRetries, DEFAULT_MAX_RETRIES, 'DEEPSEEK_MAX_RETRIES', 0, 1),
    cacheTtlMs: intInRange(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 'HEALTH_ADVICE_CACHE_TTL_MS', 0, 3600000),
    cacheMax: intInRange(options.cacheMax, DEFAULT_CACHE_MAX, 'HEALTH_ADVICE_CACHE_MAX', 1, 256)
  };
}

function isTimeoutError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return error.code === 'ETIMEDOUT' ||
    error.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    error.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    error.code === 'UND_ERR_BODY_TIMEOUT';
}

/** 剥离 ```json ... ``` / ``` ... ``` 围栏（§3.3）。 */
function stripJsonFence(text) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/** 从上游 JSON 载荷中取 `choices[0].message.content`（非空字符串）。 */
function extractMessageContent(payload) {
  if (!isPlainObject(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isPlainObject(first)) return null;
  const message = first.message;
  if (!isPlainObject(message)) return null;
  const content = message.content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  return trimmed === '' ? null : content;
}

/**
 * 解析并校验模型输出的建议 JSON。
 *
 * @param {string} content `choices[0].message.content`
 * @returns {{ok:true, advice:object} | {ok:false, reason:string}}
 *          reason 只用于内部区分（不含上游文本），不进入响应/日志。
 */
function parseAdviceContent(content) {
  if (typeof content !== 'string' || content.trim() === '') return { ok: false, reason: 'empty' };
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) return { ok: false, reason: 'too_large' };
  const stripped = stripJsonFence(content);
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'not_object' };

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (summary === '' || Array.from(summary).length > MAX_SUMMARY_CHARS) {
    return { ok: false, reason: 'invalid_summary' };
  }
  const sections = {};
  for (const field of ADVICE_SECTION_FIELDS) {
    const raw = parsed[field];
    if (!Array.isArray(raw) || raw.length < 1) {
      return { ok: false, reason: `invalid_${field}` };
    }
    // 模型偶尔会多给 1-2 条：丢弃超出上限的部分而不是整份失败（内容仍是真实模型输出，
    // 只是截断到合同允许的条数）；低于 1 条仍视为结构非法。
    const kept = raw.length > MAX_SECTION_ITEMS ? raw.slice(0, MAX_SECTION_ITEMS) : raw;
    const items = [];
    for (const item of kept) {
      if (typeof item !== 'string') return { ok: false, reason: `invalid_${field}` };
      const text = item.trim();
      if (text === '' || Array.from(text).length > MAX_SECTION_ITEM_CHARS) {
        return { ok: false, reason: `invalid_${field}` };
      }
      items.push(text);
    }
    sections[field] = items;
  }

  // 红线词只扫描四段文本（§3.5）：命中即视为越界输出。
  const scanned = [summary, sections.diet, sections.exerciseAndSleep, sections.warningSigns]
    .flat()
    .join('\n');
  const hits = scanHealthAdviceRedLines(scanned);
  if (hits.length > 0) return { ok: false, reason: 'red_line' };

  return {
    ok: true,
    advice: {
      summary,
      diet: sections.diet,
      exerciseAndSleep: sections.exerciseAndSleep,
      warningSigns: sections.warningSigns,
      // 免责声明永远由服务端覆盖，模型返回值直接丢弃。
      disclaimer: HEALTH_ADVICE_DISCLAIMER
    }
  };
}

/** 重新构造响应建议对象，强制固定 disclaimer 并复制数组（防止缓存被调用方改写）。 */
function buildPublicAdvice(advice) {
  return {
    summary: advice.summary,
    diet: advice.diet.slice(),
    exerciseAndSleep: advice.exerciseAndSleep.slice(),
    warningSigns: advice.warningSigns.slice(),
    disclaimer: HEALTH_ADVICE_DISCLAIMER
  };
}

function failure(code) {
  return { ok: false, code };
}

/**
 * 创建 DeepSeek 客户端（每个后端进程一个实例）。
 *
 * @param {object} options
 * @param {string} [options.apiKey]   来自 `process.env.DEEPSEEK_API_KEY`；空串 = 功能关闭
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxRetries]
 * @param {number} [options.cacheTtlMs]
 * @param {number} [options.cacheMax]
 * @param {Function} [options.fetchImpl] 测试注入的 fetch（默认 globalThis.fetch）
 * @param {Function} [options.now]       时间来源（测试可注入），默认 Date.now
 */
function createDeepSeekClient(options = {}) {
  const config = normalizeClientOptions(options);
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (config.configured && !fetchImpl) {
    throw new Error('fetch is unavailable');
  }
  const now = typeof options.now === 'function' ? options.now : Date.now;
  /** key -> {advice, model, generatedAt, expiresAt}；只存已校验建议，不存原始响应。 */
  const cache = new Map();

  function cacheKey(ownerRef, profile) {
    return `${ownerRef}\u0000${hashHealthProfile(profile)}`;
  }

  function cacheGet(key) {
    if (config.cacheTtlMs <= 0) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    return entry;
  }

  function cacheSet(key, value) {
    if (config.cacheTtlMs <= 0) return;
    if (cache.size >= config.cacheMax) {
      // 先清过期项，再按插入顺序淘汰最旧的（Map 保证插入序）。
      for (const [existingKey, entry] of cache) {
        if (entry.expiresAt <= now()) cache.delete(existingKey);
      }
      while (cache.size >= config.cacheMax) {
        cache.delete(cache.keys().next().value);
      }
    }
    cache.set(key, { ...value, expiresAt: now() + config.cacheTtlMs });
  }

  /** 单次尝试：成功返回建议；失败返回 {code, retryable}。 */
  async function attempt(profile) {
    const body = JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: HEALTH_ADVICE_SYSTEM_PROMPT },
        { role: 'user', content: buildHealthAdviceUserMessage(profile) }
      ],
      temperature: 0.3,
      max_tokens: 1200,
      stream: false,
      response_format: { type: 'json_object' }
    });

    let response;
    try {
      response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Key 只进请求头，绝不进 URL/日志/响应/快照。
          authorization: `Bearer ${config.apiKey}`
        },
        body,
        signal: AbortSignal.timeout(config.timeoutMs)
      });
    } catch (error) {
      if (isTimeoutError(error)) return { ok: false, code: AI_TIMEOUT, retryable: true };
      // 网络错误（DNS/连接被拒/TLS 失败等）可重试，但不泄露底层错误文本。
      return { ok: false, code: AI_UPSTREAM_ERROR, retryable: true };
    }

    if (!response || typeof response !== 'object') {
      return { ok: false, code: AI_UPSTREAM_ERROR, retryable: false };
    }
    if (response.ok !== true) {
      const status = Number(response.status);
      // 只有 429 与 5xx 可重试；其它非 2xx（4xx 等）立即失败。
      const retryable = status === 429 || (status >= 500 && status <= 599);
      return { ok: false, code: AI_UPSTREAM_ERROR, retryable };
    }

    // 只读取一次响应体；优先 text()（可做字节上限校验），否则退回 json()。
    let payload;
    try {
      if (typeof response.text === 'function') {
        const raw = await response.text();
        if (typeof raw !== 'string' || raw.trim() === '') {
          return { ok: false, code: AI_UPSTREAM_ERROR, retryable: false };
        }
        payload = JSON.parse(raw);
      } else if (typeof response.json === 'function') {
        payload = await response.json();
      } else {
        return { ok: false, code: AI_UPSTREAM_ERROR, retryable: false };
      }
    } catch (error) {
      // 超时也可能发生在读取响应体阶段（headers 已到、body 尚未读完）：
      // 必须仍然归类为 AI_TIMEOUT（→504），而不是笼统的上游失败（→502）。
      if (isTimeoutError(error)) return { ok: false, code: AI_TIMEOUT, retryable: true };
      return { ok: false, code: AI_UPSTREAM_ERROR, retryable: false };
    }

    const content = extractMessageContent(payload);
    if (content === null) {
      return { ok: false, code: AI_UPSTREAM_ERROR, retryable: false, reason: 'missing_content' };
    }
    const parsed = parseAdviceContent(content);
    if (!parsed.ok) {
      // reason 是固定短码（不含上游文本），仅用于安全诊断。
      return { ok: false, code: AI_UPSTREAM_ERROR, retryable: false, reason: parsed.reason };
    }
    return { ok: true, advice: parsed.advice };
  }

  return Object.freeze({
    /** 是否已配置 Key（唯一的对外配置状态；绝不暴露 Key 本身）。 */
    isConfigured() {
      return config.configured;
    },
    /** 配置的模型名（非密钥，可出现在响应 `model` 字段）。 */
    getModel() {
      return config.model;
    },
    /** 说明性配置摘要（不含 Key）：仅用于启动日志/诊断。 */
    describe() {
      return Object.freeze({
        configured: config.configured,
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        cacheTtlMs: config.cacheTtlMs,
        cacheMax: config.cacheMax
      });
    },

    /**
     * 生成健康科普建议。
     *
     * @param {object} profile 已校验的 HealthProfile（白名单字段，无身份）
     * @param {{ownerRef?: string}} [context] `ownerRef` 用于内存缓存键（不含身份）
     * @returns {Promise<{ok:true, advice:object, model:string, generatedAt:number, cached:boolean}
     *                  | {ok:false, code:string}>}
     */
    async generateAdvice(profile, context = {}) {
      if (!config.configured) return failure(AI_NOT_CONFIGURED);
      if (!isPlainObject(profile)) return failure(AI_UPSTREAM_ERROR);
      const ownerRef = context && typeof context.ownerRef === 'string' ? context.ownerRef : '';
      const key = ownerRef === '' ? '' : cacheKey(ownerRef, profile);

      if (key !== '') {
        const hit = cacheGet(key);
        if (hit) {
          return {
            ok: true,
            advice: buildPublicAdvice(hit.advice),
            model: hit.model,
            generatedAt: hit.generatedAt,
            cached: true
          };
        }
      }

      let lastCode = AI_UPSTREAM_ERROR;
      let lastReason = 'unknown';
      for (let attemptIndex = 0; attemptIndex <= config.maxRetries; attemptIndex += 1) {
        const result = await attempt(profile);
        if (result.ok) {
          const generatedAt = now();
          const advice = buildPublicAdvice(result.advice);
          if (key !== '') {
            cacheSet(key, { advice, model: config.model, generatedAt });
          }
          return { ok: true, advice, model: config.model, generatedAt, cached: false };
        }
        lastCode = result.code;
        lastReason = typeof result.reason === 'string' ? result.reason : 'unknown';
        if (!result.retryable) break;
      }
      // 只把固定短码交给诊断回调（不含上游文本/profile/key）。
      if (typeof options.onFailure === 'function') {
        try {
          options.onFailure({ code: lastCode, reason: lastReason });
        } catch (_) {
          // 诊断回调失败绝不影响失败语义。
        }
      }
      return failure(lastCode);
    },

    /** 清空内存缓存（测试/运维用；正常请求链路不需要）。 */
    clearCache() {
      cache.clear();
    }
  });
}

module.exports = {
  ADVICE_SECTION_FIELDS,
  AI_NOT_CONFIGURED,
  AI_TIMEOUT,
  AI_UPSTREAM_ERROR,
  DEFAULT_BASE_URL,
  DEFAULT_CACHE_MAX,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_CONTENT_BYTES,
  MODEL_RE,
  buildPublicAdvice,
  createDeepSeekClient,
  extractMessageContent,
  normalizeClientOptions,
  normalizeBaseUrl,
  parseAdviceContent,
  stripJsonFence
};
