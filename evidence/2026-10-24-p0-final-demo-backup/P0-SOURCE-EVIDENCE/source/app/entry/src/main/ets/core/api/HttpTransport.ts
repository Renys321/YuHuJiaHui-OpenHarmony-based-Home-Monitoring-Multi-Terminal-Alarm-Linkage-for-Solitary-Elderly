/**
 * HTTP 抽象：平台实现（HarmonyOS http）与测试 fake 都实现这个接口。
 */

export class HttpRequestSpec {
  method: string = 'GET';
  /** 以 / 开头的 API 路径，例如 /api/v1/overview */
  path: string = '';
  /** Bearer token；为空表示不带 Authorization */
  token: string = '';
  /** JSON 请求体字符串；为空表示无 body */
  body: string = '';
  timeoutMs: number = 15000;

  constructor(method: string = 'GET', path: string = '', token: string = '',
    body: string = '', timeoutMs: number = 15000) {
    this.method = method;
    this.path = path;
    this.token = token;
    this.body = body;
    this.timeoutMs = timeoutMs;
  }
}

export class HttpRawResponse {
  status: number = 0;
  bodyText: string = '';
  retryAfterSeconds: number = 0;
  networkError: boolean = false;
  timedOut: boolean = false;
  errorMessage: string = '';

  constructor(status: number = 0, bodyText: string = '', retryAfterSeconds: number = 0) {
    this.status = status;
    this.bodyText = bodyText;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  static ok(status: number, bodyText: string, retryAfterSeconds: number = 0): HttpRawResponse {
    return new HttpRawResponse(status, bodyText, retryAfterSeconds);
  }

  static networkFailure(timedOut: boolean, message: string): HttpRawResponse {
    const response = new HttpRawResponse(0, '', 0);
    response.networkError = true;
    response.timedOut = timedOut;
    response.errorMessage = message;
    return response;
  }
}

export interface HttpTransport {
  send(request: HttpRequestSpec): Promise<HttpRawResponse>;
}
