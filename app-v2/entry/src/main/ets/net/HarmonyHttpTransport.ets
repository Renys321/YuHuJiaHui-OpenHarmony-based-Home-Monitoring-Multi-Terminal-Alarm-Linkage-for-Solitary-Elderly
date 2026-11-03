/**
 * HarmonyOS HTTPS 传输实现：把统一 HttpRequestSpec 映射到 @kit.NetworkKit。
 * JSON 返回文本；证据接口返回受 2 MiB 上限约束的二进制。
 * 不记录 URL 查询中的任何敏感信息（本项目 token 只放 Authorization 头，且本类不打印请求头）。
 */
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { HttpRawResponse, HttpRequestSpec, HttpTransport } from '../core/api/HttpTransport';
import { ContentLengthResult, headerValue, parseContentLength } from '../core/api/HttpHeaders';

const CONNECT_TIMEOUT_MS: number = 10000;
/** HarmonyOS 网络栈请求超时错误码（见 @ohos.net.http.d.ts） */
const TIMEOUT_ERROR_CODE: number = 2300028;

export class HarmonyHttpTransport implements HttpTransport {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
  }

  async send(request: HttpRequestSpec): Promise<HttpRawResponse> {
    const client = http.createHttp();
    try {
      if (request.cancellation !== null && request.cancellation.isCancelled()) {
        return HttpRawResponse.cancelledRequest();
      }
      if (request.cancellation !== null) {
        request.cancellation.onCancel((): void => {
          client.destroy();
        });
      }
      const header: Record<string, string> = {
        'Accept': request.responseType === 'binary' ? 'image/jpeg' : 'application/json'
      };
      if (request.body.length > 0) header['Content-Type'] = 'application/json';
      if (request.token.length > 0) {
        header['Authorization'] = `Bearer ${request.token}`;
      }
      const options: http.HttpRequestOptions = {
        method: request.method === 'POST' ? http.RequestMethod.POST : http.RequestMethod.GET,
        header: header,
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: request.timeoutMs > 0 ? request.timeoutMs : 15000,
        expectDataType: request.responseType === 'binary'
          ? http.HttpDataType.ARRAY_BUFFER : http.HttpDataType.STRING,
        usingCache: false
      };
      if (request.maxResponseBytes > 0) {
        options.maxLimit = request.maxResponseBytes;
      }
      if (request.body.length > 0) {
        options.extraData = request.body;
      }
      const response: http.HttpResponse = await client.request(this.baseUrl + request.path, options);
      if (request.cancellation !== null && request.cancellation.isCancelled()) {
        return HttpRawResponse.cancelledRequest();
      }
      const status: number = typeof response.responseCode === 'number' ? response.responseCode : 0;
      if (request.responseType === 'binary') {
        let payload: Uint8Array = new Uint8Array(0);
        if (response.result instanceof ArrayBuffer) {
          payload = new Uint8Array(response.result as ArrayBuffer);
        }
        const contentType: string = headerValue(response.header, 'content-type');
        const contentLength: ContentLengthResult = parseContentLength(response.header);
        return HttpRawResponse.binary(status, payload, contentType,
          contentLength.present && contentLength.valid ? contentLength.value : -1,
          contentLength.valid);
      }
      let bodyText: string = '';
      if (typeof response.result === 'string') {
        bodyText = response.result;
      } else if (response.result !== undefined && response.result !== null) {
        bodyText = JSON.stringify(response.result);
      }
      const retryAfterText: string = headerValue(response.header, 'retry-after');
      const retryAfter: number = Number.parseInt(retryAfterText, 10);
      return HttpRawResponse.ok(
        status,
        bodyText,
        isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
      );
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      const code: number = typeof businessError.code === 'number' ? businessError.code : 0;
      if (request.cancellation !== null && request.cancellation.isCancelled()) {
        return HttpRawResponse.cancelledRequest();
      }
      if (request.responseType === 'binary' && code === 2300063) {
        return HttpRawResponse.ok(413, '', 0);
      }
      const message: string = typeof businessError.message === 'string' && businessError.message.length > 0
        ? businessError.message : 'network request failed';
      const timedOut: boolean = code === TIMEOUT_ERROR_CODE || /timeout|timed out/i.test(message);
      return HttpRawResponse.networkFailure(timedOut, message);
    } finally {
      client.destroy();
    }
  }
}
