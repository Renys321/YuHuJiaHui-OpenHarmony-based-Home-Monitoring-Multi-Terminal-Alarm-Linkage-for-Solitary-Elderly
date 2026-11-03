/**
 * SIMULATED fake HttpTransport —— 仅用于 Node 单元测试。
 *
 * 严禁把本文件产生的响应当作真实公网/真实设备的 PASS 证据：
 * 所有响应都是测试脚本里手写的“模拟 API 响应”，不对应任何真实请求。
 *
 * 对齐 core/api/HttpTransport.ts（Lead 冻结接口）：
 *   class HttpRequestSpec { method; path; token; body; timeoutMs }
 *   class HttpRawResponse { status; bodyText; retryAfterSeconds; networkError; timedOut; errorMessage }
 *   interface HttpTransport { send(request: HttpRequestSpec): Promise<HttpRawResponse> }
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const BUILD_ROOT = path.join(HERE, 'build');

export const API_BASE = 'https://api.luxunacc.xyz';
export const SIMULATED = 'SIMULATED';

const require = createRequire(import.meta.url);

/** 从 tests/build 加载实际 core 编译产物（禁止复制逻辑）。 */
export function loadCore(relPath) {
  const abs = path.join(BUILD_ROOT, relPath);
  try {
    return require(abs);
  } catch (err) {
    throw new Error(
      `无法加载实际 core 编译产物 ${relPath}；先运行 tsc -p tests/tsconfig.json。根因: ${err.message}`
    );
  }
}

/** 构造模拟 HTTP 响应对象（与 HttpRawResponse 字段同名）。 */
export function jsonResponse(status, value, extra = {}) {
  return {
    status,
    bodyText: value === undefined ? '' : JSON.stringify(value),
    retryAfterSeconds: 0,
    networkError: false,
    timedOut: false,
    errorMessage: '',
    ...extra
  };
}

export function textResponse(status, bodyText, extra = {}) {
  return {
    status,
    bodyText,
    retryAfterSeconds: 0,
    networkError: false,
    timedOut: false,
    errorMessage: '',
    ...extra
  };
}

/** 模拟网络层失败（DNS/连接拒绝等，非 HTTP 状态）。 */
export function simulatedNetworkError(message = 'simulated: connection refused') {
  return {
    status: 0,
    bodyText: '',
    retryAfterSeconds: 0,
    networkError: true,
    timedOut: false,
    errorMessage: message
  };
}

/** 模拟底层读/连接超时（非 HTTP 状态；平台层同样置 networkError=true）。 */
export function simulatedTimeout(message = 'simulated: request timeout') {
  return {
    status: 0,
    bodyText: '',
    retryAfterSeconds: 0,
    networkError: true,
    timedOut: true,
    errorMessage: message
  };
}

/** 单条脚本化路由：method + path（字符串精确匹配或 RegExp）+ 一个或多个模拟响应。 */
export function route(method, pathMatcher, ...responses) {
  if (responses.length === 0) throw new Error('route() 至少需要一个模拟响应');
  return {
    method: method.toUpperCase(),
    pathMatcher,
    responses: responses.map((item) => ({ ...item })),
    used: 0
  };
}

function matchPath(matcher, requestPath) {
  if (matcher instanceof RegExp) return matcher.test(requestPath);
  return matcher === requestPath;
}

export class FakeTransport {
  constructor(script = []) {
    this.script = script.map((item) => ({ ...item, responses: item.responses.map((r) => ({ ...r })), used: 0 }));
    this.requests = [];
    this.unmatched = [];
  }

  /** HttpTransport.send 的唯一实现；记录请求供断言。 */
  async send(request) {
    const snapshot = {
      method: String(request && request.method ? request.method : ''),
      path: String(request && request.path ? request.path : ''),
      token: String(request && request.token ? request.token : ''),
      body: request && request.body !== undefined ? String(request.body) : '',
      timeoutMs: request && typeof request.timeoutMs === 'number' ? request.timeoutMs : 0
    };
    this.requests.push(snapshot);

    const matcher = this.script.find(
      (item) => item.used < item.responses.length &&
        item.method === snapshot.method.toUpperCase() &&
        matchPath(item.pathMatcher, snapshot.path)
    );
    if (!matcher) {
      this.unmatched.push(snapshot);
      throw new Error(`SIMULATED fake transport: 未脚本化的请求 ${snapshot.method} ${snapshot.path}`);
    }
    const response = matcher.responses[matcher.used];
    matcher.used += 1;
    return { ...response };
  }

  requestCount(method, pathMatcher) {
    return this.requests.filter(
      (r) => r.method === method.toUpperCase() && matchPath(pathMatcher, r.path)
    ).length;
  }

  lastRequest(method, pathMatcher) {
    const matched = this.requests.filter(
      (r) => r.method === method.toUpperCase() && matchPath(pathMatcher, r.path)
    );
    return matched.length > 0 ? matched[matched.length - 1] : null;
  }

  assertAllConsumed() {
    const pending = this.script.filter((item) => item.used < item.responses.length);
    if (pending.length > 0) {
      throw new Error(
        `SIMULATED fake transport: 有未使用的脚本化响应 ${pending
          .map((p) => `${p.method} ${String(p.pathMatcher)} (剩 ${p.responses.length - p.used})`)
          .join(', ')}`
      );
    }
  }
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从请求 body 文本安全解析 JSON。 */
export function parseBody(request) {
  if (!request || !request.body) return null;
  try {
    return JSON.parse(request.body);
  } catch (err) {
    return null;
  }
}

export { PROJECT_ROOT, BUILD_ROOT };
