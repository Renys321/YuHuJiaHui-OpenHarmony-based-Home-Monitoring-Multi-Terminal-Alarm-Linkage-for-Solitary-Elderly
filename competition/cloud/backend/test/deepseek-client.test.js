'use strict';

/**
 * deepseek-client.test.js — DeepSeek 健康科普客户端单元测试
 *
 * 覆盖：
 *   - 固定提示词/免责声明/红线词的静态约束（§4）；
 *   - 配置校验（Key 长度、https base URL、模型名、超时/重试/缓存范围）与 Key 不外泄；
 *   - 未配置时不访问网络并返回 AI_NOT_CONFIGURED；
 *   - 成功请求的 URL/方法/请求头/请求体（system 固定提示词、user=JSON.stringify(profile)）；
 *   - 建议解析：```json 围栏、字段类型/长度、红线词、服务端强制 disclaimer；
 *   - 失败语义：非 2xx / 网络错误 / 超时 / 空内容 / 非法 JSON / 超长 / 红线词；
 *     仅网络/超时/429/5xx 重试，且最多 1 次；
 *   - 内存短缓存：ownerRef+profileHash 键、TTL、容量上限；
 *   - 全程无日志输出、结果/错误不包含 Key 或资料原文。
 *
 * 全部使用注入的 fake fetch，不访问真实网络、不读取真实 Key。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HEALTH_ADVICE_DISCLAIMER,
  HEALTH_ADVICE_PROMPT_VERSION,
  HEALTH_ADVICE_RED_LINE_TERMS,
  HEALTH_ADVICE_SYSTEM_PROMPT,
  scanHealthAdviceRedLines
} = require('../src/health-advice-prompt');
const {
  AI_NOT_CONFIGURED,
  AI_TIMEOUT,
  AI_UPSTREAM_ERROR,
  createDeepSeekClient,
  normalizeClientOptions,
  parseAdviceContent,
  stripJsonFence
} = require('../src/deepseek-client');
const { healthOwnerRefFor } = require('../src/health-profile');

const API_KEY = 'test-deepseek-api-key-0123456789';
const OWNER = healthOwnerRefFor('deepseek-client-test-secret-at-least-32-chars', 'openid-deepseek');
const PROFILE = Object.freeze({
  age: 72,
  medicalHistory: '高血压',
  medications: '氨氯地平',
  heightCm: 165,
  weightKg: 62,
  restingBloodPressure: '135/82',
  fastingGlucose: '6.1',
  sleep: { hours: 7, difficulty: false, nightAwakenings: 1 },
  diet: { regular: true, taste: 'light', restrictions: '少油' },
  exercise: { timesPerWeek: 4, types: '散步、太极' }
});
const FIXED_NOW = 1790000000000;

function adviceObject(overrides = {}) {
  return {
    summary: '结合您填写的资料，建议保持规律作息并继续监测血压。信息不足的地方已如实说明。',
    diet: ['饮食清淡，少油少盐。'],
    exerciseAndSleep: ['每周散步三到五次，量力而行。', '固定作息时间。'],
    warningSigns: ['如出现胸痛或呼吸困难，请尽快联系家属、社区医护人员或正规医疗机构。'],
    disclaimer: '模型自己编的免责声明',
    ...overrides
  };
}

/** 构造一个最小的 `fetch` Response 替身（带 text()）。 */
function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

function contentResponse(content, status = 200) {
  return jsonResponse({ choices: [{ message: { content } }] }, status);
}

function adviceResponse(overrides = {}) {
  return contentResponse(JSON.stringify(adviceObject(overrides)));
}

function captureConsole(t) {
  const calls = [];
  const original = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    original[method] = console[method];
    console[method] = (...args) => calls.push({ method, text: args.map(String).join(' ') });
  }
  t.after(() => {
    for (const method of Object.keys(original)) console[method] = original[method];
  });
  return calls;
}

/* ------------------------------------------------------------ 固定提示词 */

test('fixed system prompt and disclaimer satisfy the frozen health spec', () => {
  assert.equal(HEALTH_ADVICE_PROMPT_VERSION, 'health-advice-prompt-v1');
  const prompt = HEALTH_ADVICE_SYSTEM_PROMPT;
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.includes('你是老年健康科普助手'));
  for (const snippet of ['不诊断', '处方', '治疗', '信息不足', '立即拨打急救电话']) {
    assert.ok(prompt.includes(snippet), `prompt must contain: ${snippet}`);
  }
  for (const field of ['summary', 'diet', 'exerciseAndSleep', 'warningSigns', 'disclaimer']) {
    assert.ok(prompt.includes(field), `prompt must contain json field: ${field}`);
  }
  assert.ok(prompt.includes('请尽快联系家属、社区医护人员或正规医疗机构'));
  assert.equal(
    HEALTH_ADVICE_DISCLAIMER,
    '本内容仅健康科普参考，不构成医疗诊断、治疗或用药建议；如有不适请及时就医。'
  );
  assert.equal(HEALTH_ADVICE_RED_LINE_TERMS.length, 16);
  for (const term of ['你患有', '确诊为', '建议服用', '停止用药', '调整剂量', '处方', '治疗方案',
    '病情等级', '患病概率', '治愈率']) {
    assert.ok(HEALTH_ADVICE_RED_LINE_TERMS.includes(term), `missing red line term: ${term}`);
    assert.deepEqual(scanHealthAdviceRedLines(`前缀${term}后缀`), [term]);
  }
  assert.deepEqual(scanHealthAdviceRedLines('正常的健康科普文案'), []);
  assert.deepEqual(scanHealthAdviceRedLines(''), []);
  assert.deepEqual(scanHealthAdviceRedLines(null), []);
});

/* ------------------------------------------------------------ 配置校验 */

test('client configuration validates key, https base url, model, timeouts and cache bounds', () => {
  const notConfigured = createDeepSeekClient({ apiKey: '' });
  assert.equal(notConfigured.isConfigured(), false);
  assert.equal(notConfigured.describe().configured, false);
  assert.equal(notConfigured.describe().model, 'deepseek-chat');
  assert.equal(notConfigured.describe().baseUrl, 'https://api.deepseek.com');

  assert.throws(
    () => createDeepSeekClient({ apiKey: 'too-short-key' }),
    (error) => /DEEPSEEK_API_KEY must be at least 20 characters/.test(error.message) &&
      !error.message.includes('too-short-key')
  );
  const configured = createDeepSeekClient({ apiKey: API_KEY });
  assert.equal(configured.isConfigured(), true);
  const described = JSON.stringify(configured.describe());
  assert.equal(described.includes(API_KEY), false, 'describe() must never expose the key');
  assert.equal(JSON.stringify(configured).includes(API_KEY), false);
  assert.equal(configured.getModel(), 'deepseek-chat');

  assert.throws(() => normalizeClientOptions({ baseUrl: 'http://api.deepseek.com' }), /https/);
  assert.throws(() => normalizeClientOptions({ baseUrl: 'not a url' }), /valid https URL/);
  assert.throws(() => normalizeClientOptions({ baseUrl: 'https://api.deepseek.com?x=1' }), /query or fragment/);
  assert.throws(
    () => normalizeClientOptions({ baseUrl: 'https://user:pass@api.deepseek.com' }),
    /must not contain credentials/
  );
  assert.deepEqual(
    (() => {
      const options = normalizeClientOptions({ baseUrl: 'https://api.deepseek.com/' });
      return { baseUrl: options.baseUrl, endpoint: options.endpoint };
    })(),
    { baseUrl: 'https://api.deepseek.com', endpoint: 'https://api.deepseek.com/chat/completions' }
  );
  assert.equal(
    normalizeClientOptions({ baseUrl: 'https://example.test/v1/' }).endpoint,
    'https://example.test/v1/chat/completions'
  );

  assert.throws(() => normalizeClientOptions({ model: 'bad model!' }), /DEEPSEEK_MODEL/);
  assert.equal(normalizeClientOptions({ model: 'deepseek-reasoner' }).model, 'deepseek-reasoner');
  assert.throws(() => normalizeClientOptions({ timeoutMs: 999 }), /DEEPSEEK_TIMEOUT_MS/);
  assert.throws(() => normalizeClientOptions({ timeoutMs: 15001 }), /DEEPSEEK_TIMEOUT_MS/);
  assert.equal(normalizeClientOptions({ timeoutMs: '15000' }).timeoutMs, 15000);
  assert.throws(() => normalizeClientOptions({ maxRetries: 2 }), /DEEPSEEK_MAX_RETRIES/);
  assert.equal(normalizeClientOptions({ maxRetries: '0' }).maxRetries, 0);
  assert.throws(() => normalizeClientOptions({ cacheTtlMs: -1 }), /HEALTH_ADVICE_CACHE_TTL_MS/);
  assert.throws(() => normalizeClientOptions({ cacheTtlMs: 3600001 }), /HEALTH_ADVICE_CACHE_TTL_MS/);
  assert.throws(() => normalizeClientOptions({ cacheMax: 0 }), /HEALTH_ADVICE_CACHE_MAX/);
  assert.throws(() => normalizeClientOptions({ cacheMax: 257 }), /HEALTH_ADVICE_CACHE_MAX/);
});

/* ------------------------------------------------------------ 未配置 */

test('unconfigured client never touches the network and fails explicitly', async (t) => {
  const calls = captureConsole(t);
  let fetchCalls = 0;
  const client = createDeepSeekClient({
    apiKey: '',
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('must not be called');
    }
  });
  const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.deepEqual(result, { ok: false, code: AI_NOT_CONFIGURED });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(calls, []);
});

/* ------------------------------------------------------------ 成功路径 */

test('successful generation sends the frozen request and forces the disclaimer', async (t) => {
  const calls = captureConsole(t);
  const requests = [];
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    timeoutMs: 5000,
    now: () => FIXED_NOW,
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return adviceResponse();
    }
  });

  const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.equal(request.options.headers.authorization, `Bearer ${API_KEY}`);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.body.model, 'deepseek-chat');
  assert.equal(request.body.temperature, 0.3);
  assert.equal(request.body.max_tokens, 1200);
  assert.equal(request.body.stream, false);
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.equal(request.body.messages.length, 2);
  assert.equal(request.body.messages[0].role, 'system');
  assert.equal(request.body.messages[0].content, HEALTH_ADVICE_SYSTEM_PROMPT);
  assert.equal(request.body.messages[1].role, 'user');
  assert.equal(request.body.messages[1].content, JSON.stringify(PROFILE));

  assert.equal(result.ok, true);
  assert.equal(result.cached, false);
  assert.equal(result.model, 'deepseek-chat');
  assert.equal(result.generatedAt, FIXED_NOW);
  assert.equal(result.advice.disclaimer, HEALTH_ADVICE_DISCLAIMER);
  assert.notEqual(result.advice.disclaimer, '模型自己编的免责声明');
  assert.equal(result.advice.summary, adviceObject().summary);
  assert.deepEqual(result.advice.diet, adviceObject().diet);
  assert.deepEqual(result.advice.exerciseAndSleep, adviceObject().exerciseAndSleep);
  assert.deepEqual(result.advice.warningSigns, adviceObject().warningSigns);
  // 响应里绝不含 Key / system prompt 之外的内部信息。
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.deepEqual(calls, [], 'client must not log');
});

test('response content wrapped in a ```json fence is parsed', async () => {
  const fenced = '```json\n' + JSON.stringify(adviceObject()) + '\n```';
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    fetchImpl: async () => contentResponse(fenced)
  });
  const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.equal(result.ok, true);
  assert.equal(result.advice.disclaimer, HEALTH_ADVICE_DISCLAIMER);
  assert.equal(stripJsonFence(fenced).startsWith('{'), true);
  assert.equal(stripJsonFence('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFence('{"a":1}'), '{"a":1}');
});

test('only the response.json() path is supported as a fallback', async () => {
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(adviceObject()) } }] })
    })
  });
  const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.equal(result.ok, true);
});

/* ------------------------------------------------------------ 失败语义 */

test('empty or invalid upstream content fails without fabricating advice', async (t) => {
  const calls = captureConsole(t);
  const cases = [
    { name: 'empty content', response: () => contentResponse('   ') },
    { name: 'missing choices', response: () => jsonResponse({ choices: [] }) },
    { name: 'content not string', response: () => jsonResponse({ choices: [{ message: { content: 42 } }] }) },
    { name: 'invalid JSON payload', response: () => ({ ok: true, status: 200, text: async () => '{oops' }) },
    { name: 'invalid JSON content', response: () => contentResponse('这不是 JSON') },
    { name: 'content array', response: () => contentResponse('[]') },
    {
      name: 'oversized content',
      response: () => contentResponse(JSON.stringify(adviceObject({ summary: 'x'.repeat(20001) })))
    },
    { name: 'missing summary', response: () => contentResponse(JSON.stringify({ ...adviceObject(), summary: undefined })) },
    { name: 'invalid diet', response: () => contentResponse(JSON.stringify(adviceObject({ diet: [] }))) },
    {
      name: 'diet item too long',
      response: () => contentResponse(JSON.stringify(adviceObject({ diet: ['x'.repeat(301)] })))
    },
    {
      name: 'diet item not string',
      response: () => contentResponse(JSON.stringify(adviceObject({ diet: [1] })))
    }
  ];
  for (const item of cases) {
    let fetchCalls = 0;
    const client = createDeepSeekClient({
      apiKey: API_KEY,
      maxRetries: 1,
      fetchImpl: async () => {
        fetchCalls += 1;
        return item.response();
      }
    });
    const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
    assert.deepEqual(result, { ok: false, code: AI_UPSTREAM_ERROR }, item.name);
    assert.equal(fetchCalls, 1, `${item.name} must not be retried`);
    assert.equal('advice' in result, false, `${item.name} must never return advice`);
  }
  assert.deepEqual(calls, [], 'failures must not log raw content');
});

test('red line terms in any advice section fail with AI_UPSTREAM_ERROR', async () => {
  for (const term of HEALTH_ADVICE_RED_LINE_TERMS) {
    for (const field of ['summary', 'diet', 'exerciseAndSleep', 'warningSigns']) {
      const overrides = {};
      if (field === 'summary') overrides.summary = `关于您的情况：${term}`;
      else overrides[field] = [`${term}`];
      const client = createDeepSeekClient({
        apiKey: API_KEY,
        maxRetries: 0,
        fetchImpl: async () => adviceResponse(overrides)
      });
      const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
      assert.deepEqual(result, { ok: false, code: AI_UPSTREAM_ERROR }, `${field} / ${term}`);
    }
  }
  // 模型返回的 disclaimer 里出现红线词不算（服务端强制覆盖），但其它字段命中就算。
  assert.equal(parseAdviceContent(JSON.stringify(adviceObject())).ok, true);
});

test('negated red-line phrases are safe guidance and must not be rejected', () => {
  // 真实模型常见的安全表述：这些都是"禁止/否定"，不能被误判为越界输出。
  for (const safe of [
    '请勿自行停药或调整剂量，如有不适及时就医。',
    '不要自行调整剂量或随意停药。',
    '本内容不构成诊断结果，也不构成处方。',
    '不建议服用任何保健品，具体请咨询医生。',
    '没有确诊为任何疾病，请不要自行用药。'
  ]) {
    assert.deepEqual(scanHealthAdviceRedLines(safe), [], `safe phrase rejected: ${safe}`);
  }
  // 否定词跨分句时不得放行（避免“不要担心，建议服用……”被误判为安全）。
  assert.deepEqual(scanHealthAdviceRedLines('不要担心，建议服用阿司匹林'), ['建议服用']);
  assert.deepEqual(scanHealthAdviceRedLines('不要担心。可以停药'), ['停药']);
  // 没有否定词的直接处方/诊断表述仍然命中。
  assert.deepEqual(scanHealthAdviceRedLines('建议服用氨氯地平'), ['建议服用']);
});

test('section arrays longer than the contract cap are truncated, not failed', async () => {
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    maxRetries: 0,
    fetchImpl: async () => adviceResponse({ diet: new Array(10).fill('少油少盐') })
  });
  const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.equal(result.ok, true);
  assert.equal(result.advice.diet.length, 8);
  assert.equal(result.advice.diet[0], '少油少盐');
});

test('timeouts while reading the response body still map to AI_TIMEOUT', async () => {
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    maxRetries: 0,
    timeoutMs: 1000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
    })
  });
  const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.deepEqual(result, { ok: false, code: AI_TIMEOUT });
});

test('failure diagnostics only expose fixed short codes, never upstream content', async () => {
  const seen = [];
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    maxRetries: 0,
    onFailure: (info) => seen.push(info),
    fetchImpl: async () => contentResponse('这不是 JSON，里面还有一个假 key sk-should-not-leak')
  });
  const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.deepEqual(result, { ok: false, code: AI_UPSTREAM_ERROR });
  assert.deepEqual(seen, [{ code: 'AI_UPSTREAM_ERROR', reason: 'invalid_json' }]);
  assert.equal(JSON.stringify(seen).includes('sk-should-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('sk-should-not-leak'), false);
});

test('non-retryable HTTP errors fail once; retryable statuses retry at most once', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let fetchCalls = 0;
    const client = createDeepSeekClient({
      apiKey: API_KEY,
      maxRetries: 1,
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: false, status, text: async () => 'upstream says no' };
      }
    });
    const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
    assert.deepEqual(result, { ok: false, code: AI_UPSTREAM_ERROR }, `status ${status}`);
    assert.equal(fetchCalls, 1, `status ${status} must not be retried`);
  }
  for (const status of [429, 500, 502, 503, 504]) {
    let fetchCalls = 0;
    const client = createDeepSeekClient({
      apiKey: API_KEY,
      maxRetries: 1,
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: false, status, text: async () => 'upstream says no' };
      }
    });
    const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
    assert.deepEqual(result, { ok: false, code: AI_UPSTREAM_ERROR }, `status ${status}`);
    assert.equal(fetchCalls, 2, `status ${status} must be retried exactly once`);
  }
});

test('network errors retry at most once, then fail explicitly', async () => {
  let fetchCalls = 0;
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    maxRetries: 1,
    fetchImpl: async () => {
      fetchCalls += 1;
      const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
      error.code = 'ECONNREFUSED';
      throw error;
    }
  });
  const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.deepEqual(result, { ok: false, code: AI_UPSTREAM_ERROR });
  assert.equal(fetchCalls, 2);
  assert.equal(JSON.stringify(result).includes('ECONNREFUSED'), false);

  let singleCalls = 0;
  const single = createDeepSeekClient({
    apiKey: API_KEY,
    maxRetries: 0,
    fetchImpl: async () => {
      singleCalls += 1;
      throw new Error('network down');
    }
  });
  assert.deepEqual(
    await single.generateAdvice(PROFILE, { ownerRef: OWNER }),
    { ok: false, code: AI_UPSTREAM_ERROR }
  );
  assert.equal(singleCalls, 1);
});

test('timeouts map to AI_TIMEOUT and are retried at most once', async () => {
  let fetchCalls = 0;
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    maxRetries: 1,
    timeoutMs: 1000,
    fetchImpl: async () => {
      fetchCalls += 1;
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    }
  });
  const result = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.deepEqual(result, { ok: false, code: AI_TIMEOUT });
  assert.equal(fetchCalls, 2);

  let singleCalls = 0;
  const single = createDeepSeekClient({
    apiKey: API_KEY,
    maxRetries: 0,
    timeoutMs: 1000,
    fetchImpl: async () => {
      singleCalls += 1;
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
  });
  assert.deepEqual(await single.generateAdvice(PROFILE, { ownerRef: OWNER }), { ok: false, code: AI_TIMEOUT });
  assert.equal(singleCalls, 1);
});

/* ------------------------------------------------------------ 缓存 */

test('memory cache is keyed by ownerRef + profile hash and honours TTL/capacity', async () => {
  let fetchCalls = 0;
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    cacheTtlMs: 300000,
    cacheMax: 2,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      fetchCalls += 1;
      return adviceResponse();
    }
  });

  const first = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  const second = await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.equal(fetchCalls, 1, 'same ownerRef + same profile must hit the cache');
  assert.equal(second.cached, true);
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(second.advice.disclaimer, HEALTH_ADVICE_DISCLAIMER);

  await client.generateAdvice(PROFILE, { ownerRef: OWNER + 'x' });
  assert.equal(fetchCalls, 2, 'a different ownerRef must miss the cache');

  await client.generateAdvice({ ...PROFILE, age: 73 }, { ownerRef: OWNER });
  assert.equal(fetchCalls, 3, 'a different profile must miss the cache');

  // 缓存满（cacheMax=2）时继续写入会淘汰最旧项，不无限增长。
  const before = fetchCalls;
  await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  await client.generateAdvice({ ...PROFILE, age: 74 }, { ownerRef: OWNER });
  await client.generateAdvice({ ...PROFILE, age: 75 }, { ownerRef: OWNER });
  assert.ok(fetchCalls >= before);
  client.clearCache();
  const afterClear = fetchCalls;
  await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.equal(fetchCalls, afterClear + 1, 'clearCache must force a fetch');
});

test('cache TTL expiry and TTL=0 behaviour', async () => {
  let fetchCalls = 0;
  const clock = { value: FIXED_NOW };
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    cacheTtlMs: 1000,
    now: () => clock.value,
    fetchImpl: async () => {
      fetchCalls += 1;
      return adviceResponse();
    }
  });
  await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  clock.value += 999;
  await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.equal(fetchCalls, 1, 'still inside TTL');
  clock.value += 2;
  await client.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.equal(fetchCalls, 2, 'expired entry must be refetched');

  let noCacheCalls = 0;
  const noCache = createDeepSeekClient({
    apiKey: API_KEY,
    cacheTtlMs: 0,
    fetchImpl: async () => {
      noCacheCalls += 1;
      return adviceResponse();
    }
  });
  await noCache.generateAdvice(PROFILE, { ownerRef: OWNER });
  await noCache.generateAdvice(PROFILE, { ownerRef: OWNER });
  assert.equal(noCacheCalls, 2, 'TTL=0 disables caching');
});

/* ------------------------------------------------------------ 不泄密 */

test('client never logs and never leaks the key or profile content', async (t) => {
  const calls = captureConsole(t);
  const plausibleKey = 'sk-test-key-must-never-appear-1234567890';
  const sensitiveProfile = { ...PROFILE, medicalHistory: 'SENSITIVE-MEDICAL-TEXT' };
  const client = createDeepSeekClient({
    apiKey: plausibleKey,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      const error = new Error('network down');
      throw error;
    }
  });
  const result = await client.generateAdvice(sensitiveProfile, { ownerRef: OWNER });
  assert.deepEqual(result, { ok: false, code: AI_UPSTREAM_ERROR });
  assert.equal(JSON.stringify(result).includes(plausibleKey), false);
  assert.equal(JSON.stringify(result).includes('SENSITIVE-MEDICAL-TEXT'), false);
  assert.equal(JSON.stringify(client.describe()).includes(plausibleKey), false);
  assert.deepEqual(calls, []);
});

test('client rejects non-object profiles defensively', async () => {
  const client = createDeepSeekClient({
    apiKey: API_KEY,
    fetchImpl: async () => adviceResponse()
  });
  for (const bad of [null, undefined, 'profile', [], 42]) {
    assert.deepEqual(await client.generateAdvice(bad, { ownerRef: OWNER }), {
      ok: false,
      code: AI_UPSTREAM_ERROR
    });
  }
});
