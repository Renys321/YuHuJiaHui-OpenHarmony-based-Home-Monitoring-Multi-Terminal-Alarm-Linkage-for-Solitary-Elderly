/**
 * 统一错误语义。页面/服务只按 kind/HTTP 状态处理，不依赖服务端错误文案。
 */

export class ApiErrorKinds {
  static readonly BAD_REQUEST: string = 'bad_request';
  static readonly UNAUTHORIZED: string = 'unauthorized';
  static readonly FORBIDDEN: string = 'forbidden';
  static readonly NOT_FOUND: string = 'not_found';
  static readonly CONFLICT: string = 'conflict';
  static readonly TOO_LARGE: string = 'too_large';
  static readonly RATE_LIMITED: string = 'rate_limited';
  static readonly SERVER: string = 'server';
  static readonly SERVICE_UNAVAILABLE: string = 'service_unavailable';
  static readonly TIMEOUT: string = 'timeout';
  static readonly NETWORK: string = 'network';
  static readonly MALFORMED: string = 'malformed';
  static readonly UNKNOWN: string = 'unknown';
}

export class ApiError {
  kind: string = ApiErrorKinds.UNKNOWN;
  status: number = 0;
  retryAfterSeconds: number = 0;
  /** 仅用于开发者排障的安全短文案，不含 token/password/URL。 */
  message: string = '';

  constructor(kind: string = ApiErrorKinds.UNKNOWN, status: number = 0,
    message: string = '', retryAfterSeconds: number = 0) {
    this.kind = kind;
    this.status = status;
    this.message = message;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ApiResult<T> {
  ok: boolean = false;
  value: T | null = null;
  error: ApiError | null = null;

  constructor(ok: boolean = false, value: T | null = null, error: ApiError | null = null) {
    this.ok = ok;
    this.value = value;
    this.error = error;
  }

  static success<T>(value: T): ApiResult<T> {
    return new ApiResult<T>(true, value, null);
  }

  static failure<T>(error: ApiError): ApiResult<T> {
    return new ApiResult<T>(false, null, error);
  }
}

/** 按 HTTP 状态码映射。 */
export function errorForStatus(status: number, retryAfterSeconds: number = 0): ApiError {
  if (status === 400) return new ApiError(ApiErrorKinds.BAD_REQUEST, status, 'bad request');
  if (status === 401) return new ApiError(ApiErrorKinds.UNAUTHORIZED, status, 'unauthorized');
  if (status === 403) return new ApiError(ApiErrorKinds.FORBIDDEN, status, 'forbidden');
  if (status === 404) return new ApiError(ApiErrorKinds.NOT_FOUND, status, 'not found');
  if (status === 409) return new ApiError(ApiErrorKinds.CONFLICT, status, 'conflict');
  if (status === 413) return new ApiError(ApiErrorKinds.TOO_LARGE, status, 'too large');
  if (status === 429) {
    return new ApiError(ApiErrorKinds.RATE_LIMITED, status, 'rate limited', retryAfterSeconds);
  }
  if (status === 503) {
    return new ApiError(ApiErrorKinds.SERVICE_UNAVAILABLE, status, 'service unavailable');
  }
  if (status >= 500) return new ApiError(ApiErrorKinds.SERVER, status, 'server error');
  if (status >= 400) return new ApiError(ApiErrorKinds.UNKNOWN, status, 'http error');
  return new ApiError(ApiErrorKinds.UNKNOWN, status, 'unexpected status');
}
