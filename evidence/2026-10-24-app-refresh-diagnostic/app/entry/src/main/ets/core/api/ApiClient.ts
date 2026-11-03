/**
 * APP API v1 客户端（纯逻辑；真正的 HTTPS 由注入的 HttpTransport 完成）。
 *
 * 统一处理：超时/网络失败、401、403、429 + Retry-After、5xx、非法 JSON。
 * 不根据服务端错误文案判断业务，不记录 token/password。
 */
import {
  AckDto, AlertDto, ContactDto, DeviceDto, LoginDto, OverviewDto, RoomDto,
  parseAck, parseAlerts, parseContacts, parseDevices, parseLogin, parseOverview, parseRooms
} from './Contracts';
import { ApiError, ApiErrorKinds, ApiResult, errorForStatus } from './Errors';
import { HttpRawResponse, HttpRequestSpec, HttpTransport } from './HttpTransport';
import { IdentityTrace } from '../diag/IdentityTrace';

export class ApiClient {
  private baseUrl: string;
  private transport: HttpTransport;

  constructor(baseUrl: string, transport: HttpTransport) {
    this.baseUrl = baseUrl;
    this.transport = transport;
  }

  private async send(spec: HttpRequestSpec): Promise<ApiResult<HttpRawResponse>> {
    let response: HttpRawResponse;
    try {
      response = await this.transport.send(spec);
    } catch (error) {
      return ApiResult.failure<HttpRawResponse>(
        new ApiError(ApiErrorKinds.NETWORK, 0, 'transport threw'));
    }
    if (response.networkError) {
      if (response.timedOut) {
        return ApiResult.failure<HttpRawResponse>(
          new ApiError(ApiErrorKinds.TIMEOUT, 0, 'request timed out'));
      }
      return ApiResult.failure<HttpRawResponse>(
        new ApiError(ApiErrorKinds.NETWORK, 0, 'network unavailable'));
    }
    if (response.status >= 200 && response.status < 300) {
      return ApiResult.success<HttpRawResponse>(response);
    }
    return ApiResult.failure<HttpRawResponse>(
      errorForStatus(response.status, response.retryAfterSeconds));
  }

  private unauthorized<T>(): ApiResult<T> {
    return ApiResult.failure<T>(new ApiError(ApiErrorKinds.UNAUTHORIZED, 401, 'no session'));
  }

  async login(guardianId: string, password: string): Promise<ApiResult<LoginDto>> {
    const body: string = JSON.stringify({ guardianId: guardianId, password: password });
    const spec = new HttpRequestSpec('POST', '/api/v1/auth/app', '', body, 15000);
    const result: ApiResult<HttpRawResponse> = await this.send(spec);
    if (!result.ok) {
      return ApiResult.failure<LoginDto>(result.error as ApiError);
    }
    const response: HttpRawResponse = result.value as HttpRawResponse;
    const dto = parseLogin(response.bodyText);
    if (dto === null) {
      return ApiResult.failure<LoginDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid login response'));
    }
    return ApiResult.success<LoginDto>(dto);
  }

  async overview(token: string): Promise<ApiResult<OverviewDto>> {
    if (token.length === 0) return this.unauthorized<OverviewDto>();
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', '/api/v1/overview', token, '', 12000));
    if (!result.ok) return ApiResult.failure<OverviewDto>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    const dto = parseOverview(response.bodyText);
    if (dto === null) {
      return ApiResult.failure<OverviewDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid overview response'));
    }
    return ApiResult.success<OverviewDto>(dto);
  }

  async rooms(token: string): Promise<ApiResult<RoomDto[]>> {
    if (token.length === 0) return this.unauthorized<RoomDto[]>();
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', '/api/v1/rooms', token, '', 12000));
    if (!result.ok) return ApiResult.failure<RoomDto[]>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    const rooms = parseRooms(response.bodyText);
    if (rooms === null) {
      return ApiResult.failure<RoomDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid rooms response'));
    }
    return ApiResult.success<RoomDto[]>(rooms);
  }

  async devices(token: string): Promise<ApiResult<DeviceDto[]>> {
    if (token.length === 0) return this.unauthorized<DeviceDto[]>();
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', '/api/v1/devices', token, '', 12000));
    if (!result.ok) return ApiResult.failure<DeviceDto[]>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    IdentityTrace.raw(response.bodyText);
    const devices = parseDevices(response.bodyText);
    if (devices === null) {
      return ApiResult.failure<DeviceDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid devices response'));
    }
    return ApiResult.success<DeviceDto[]>(devices);
  }

  async alerts(token: string): Promise<ApiResult<AlertDto[]>> {
    if (token.length === 0) return this.unauthorized<AlertDto[]>();
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', '/api/v1/alerts', token, '', 12000));
    if (!result.ok) return ApiResult.failure<AlertDto[]>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    const alerts = parseAlerts(response.bodyText);
    if (alerts === null) {
      return ApiResult.failure<AlertDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid alerts response'));
    }
    return ApiResult.success<AlertDto[]>(alerts);
  }

  async contacts(token: string): Promise<ApiResult<ContactDto[]>> {
    if (token.length === 0) return this.unauthorized<ContactDto[]>();
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', '/api/v1/contacts', token, '', 12000));
    if (!result.ok) return ApiResult.failure<ContactDto[]>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    const contacts = parseContacts(response.bodyText);
    if (contacts === null) {
      return ApiResult.failure<ContactDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid contacts response'));
    }
    return ApiResult.success<ContactDto[]>(contacts);
  }

  /** 提交告警确认：202 只表示命令入队，调用方必须继续刷新 alerts 等待 ACKED。 */
  async ack(token: string, alarmId: string, note: string): Promise<ApiResult<AckDto>> {
    if (token.length === 0) return this.unauthorized<AckDto>();
    if (alarmId.length === 0) {
      return ApiResult.failure<AckDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'missing alarm id'));
    }
    const path: string = `/api/v1/alerts/${encodeURIComponent(alarmId)}/ack`;
    const body: string = JSON.stringify({ note: note });
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('POST', path, token, body, 12000));
    if (!result.ok) return ApiResult.failure<AckDto>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    const dto = parseAck(response.bodyText);
    if (dto === null) {
      // 202 本身已是服务端接受证据；body 解析失败时按 PENDING 处理，但绝不视为设备已确认。
      if (response.status === 202) {
        const fallback = new AckDto();
        fallback.accepted = true;
        fallback.status = 'PENDING';
        return ApiResult.success<AckDto>(fallback);
      }
      return ApiResult.failure<AckDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid ack response'));
    }
    return ApiResult.success<AckDto>(dto);
  }
}

/** 去掉 URL 末尾斜杠，保持 baseUrl 只含 origin。 */
export function baseUrlOf(url: string): string {
  return url.endsWith('/') ? url.substring(0, url.length - 1) : url;
}
