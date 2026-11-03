/**
 * HarmonyOS HTTPS 传输实现：把统一 HttpRequestSpec 映射到 @kit.NetworkKit。
 * 只返回状态码/正文/Retry-After；错误分类由纯逻辑 ApiClient 完成。
 * 不记录 URL 查询中的任何敏感信息（本项目 token 只放 Authorization 头，且本类不打印请求头）。
 */
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { HttpRawResponse, HttpRequestSpec, HttpTransport } from '../core/api/HttpTransport';
import { DiagTrace } from '../core/diag/DiagTrace';

const CONNECT_TIMEOUT_MS: number = 10000;
/** HarmonyOS 网络栈请求超时错误码（见 @ohos.net.http.d.ts） */
const TIMEOUT_ERROR_CODE: number = 2300028;

function headerValue(headers: Object, name: string): string {
  try {
    const map = headers as Record<string, string>;
    const value: string = map[name];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    const upper: string = map[name.toUpperCase()];
    return typeof upper === 'string' ? upper : '';
  } catch (error) {
    return '';
  }
}

export class HarmonyHttpTransport implements HttpTransport {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
  }

  async send(request: HttpRequestSpec): Promise<HttpRawResponse> {
    const client = http.createHttp();
    const startedAt: number = Date.now();
    DiagTrace.log(DiagTrace.currentRefreshId, 'http.start',
      `method=${request.method}|path=${request.path}|cache=false|origin=${this.baseUrl}`);
    try {
      const header: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };
      if (request.token.length > 0) {
        header['Authorization'] = `Bearer ${request.token}`;
      }
      const options: http.HttpRequestOptions = {
        method: request.method === 'POST' ? http.RequestMethod.POST : http.RequestMethod.GET,
        header: header,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: request.timeoutMs > 0 ? request.timeoutMs : 15000,
        expectDataType: http.HttpDataType.STRING,
        usingCache: false
      };
      if (request.body.length > 0) {
        options.extraData = request.body;
      }
      const response: http.HttpResponse = await client.request(this.baseUrl + request.path, options);
      DiagTrace.log(DiagTrace.currentRefreshId, 'http.end',
        `path=${request.path}|status=${String(response.responseCode)}|elapsedMs=${Date.now() - startedAt}`);
      let bodyText: string = '';
      if (typeof response.result === 'string') {
        bodyText = response.result;
      } else if (response.result !== undefined && response.result !== null) {
        bodyText = JSON.stringify(response.result);
      }
      const retryAfterText: string = headerValue(response.header, 'retry-after');
      const retryAfter: number = Number.parseInt(retryAfterText, 10);
      return HttpRawResponse.ok(
        typeof response.responseCode === 'number' ? response.responseCode : 0,
        bodyText,
        isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
      );
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      const code: number = typeof businessError.code === 'number' ? businessError.code : 0;
      const message: string = typeof businessError.message === 'string' && businessError.message.length > 0
        ? businessError.message : 'network request failed';
      const timedOut: boolean = code === TIMEOUT_ERROR_CODE || /timeout|timed out/i.test(message);
      DiagTrace.log(DiagTrace.currentRefreshId, 'http.error',
        `path=${request.path}|code=${String(code)}|timedOut=${String(timedOut)}|elapsedMs=${Date.now() - startedAt}`);
      return HttpRawResponse.networkFailure(timedOut, message);
    } finally {
      client.destroy();
    }
  }
}
