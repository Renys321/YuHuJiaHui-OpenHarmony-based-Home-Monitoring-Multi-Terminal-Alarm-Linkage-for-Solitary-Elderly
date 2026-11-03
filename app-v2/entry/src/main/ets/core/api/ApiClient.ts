/**
 * APP API v1 客户端（纯逻辑；真正的 HTTPS 由注入的 HttpTransport 完成）。
 *
 * 统一处理：超时/网络失败、401、403、429 + Retry-After、5xx、非法 JSON。
 * 不根据服务端错误文案判断业务，不记录 token/password。
 */
import {
  AckDto, ActivityReportDto, AlertDto, ContactDto, DeviceDto, DispositionDto, DispositionResultDto,
  DoorEventDto, ElderSafeEventDto, HealthAdviceEnvelopeDto, HealthProfileEnvelopeDto, LocationPointDto,
  LoginDto, OverviewDto, RoomDto, SafetyLogDto,
  DISPOSITION_NOTE_MAX, DISPOSITION_OUTCOME_OTHER,
  hasDispositionNoteControlChars, normalizeDispositionNote, normalizeSafetyLogLimit,
  parseAck, parseActivityReport, parseAlerts, parseContacts, parseDevices, parseDispositionResult,
  parseDispositions, parseDoorEvents, parseElderSafeEvents, parseHealthAdviceEnvelope,
  parseHealthProfileEnvelope, parseLocations, parseLogin, parseOverview, parseRooms, parseSafetyLogs,
  validClientDispositionId, validDispositionAlarmId, validDispositionOutcome
} from './Contracts';
import { ApiError, ApiErrorKinds, ApiResult, errorForStatus } from './Errors';
import { HttpRawResponse, HttpRequestSpec, HttpTransport } from './HttpTransport';
import { HealthProfileBody, healthProfileBodyJson } from '../health/HealthModels';
import { isValidActivityScope, isValidIsoDate } from '../activity/ActivityReport';
import {
  EVIDENCE_TIMEOUT_MS, EvidenceImageBytes, EvidenceRequestCancellation,
  MAX_EVIDENCE_JPEG_BYTES, isBasicJpeg, isJpegContentType, validEvidenceAlarmId
} from '../evidence/EvidenceCore';

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
      if (response.cancelled) {
        return ApiResult.failure<HttpRawResponse>(
          new ApiError(ApiErrorKinds.CANCELLED, 0, 'request cancelled'));
      }
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

  /**
   * 设备最近定位（GET /api/v1/location）。
   * 仅用于 MANUAL_SOS 告警缺少 sosLocation 时的兜底展示，调用方必须标注“最近定位”；
   * 200 + {"locations":[...]}；空数组合法；结构非法按 MALFORMED 处理，绝不伪造坐标。
   */
  async locations(token: string): Promise<ApiResult<LocationPointDto[]>> {
    if (token.length === 0) return this.unauthorized<LocationPointDto[]>();
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', '/api/v1/location', token, '', 12000));
    if (!result.ok) return ApiResult.failure<LocationPointDto[]>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 200) {
      return ApiResult.failure<LocationPointDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected location status'));
    }
    const items: LocationPointDto[] | null = parseLocations(response.bodyText);
    if (items === null) {
      return ApiResult.failure<LocationPointDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid location response'));
    }
    return ApiResult.success<LocationPointDto[]>(items);
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

  /**
   * 活动报告（GET /api/v1/activity/report?scope=day|week|month&date=YYYY-MM-DD）。
   * 12s 超时；scope/date 先在本地校验（非法直接 400，不发无意义请求）；
   * 解析只接受 JSON 对象，count 缺失保持 null（绝不默认成 0）。
   */
  async activityReport(token: string, scope: string,
    date: string): Promise<ApiResult<ActivityReportDto>> {
    if (token.length === 0) return this.unauthorized<ActivityReportDto>();
    if (!isValidActivityScope(scope)) {
      return ApiResult.failure<ActivityReportDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'invalid activity scope'));
    }
    const hasDate: boolean = typeof date === 'string' && date.length > 0;
    if (hasDate && !isValidIsoDate(date)) {
      return ApiResult.failure<ActivityReportDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'invalid activity date'));
    }
    let path: string = `/api/v1/activity/report?scope=${encodeURIComponent(scope)}`;
    if (hasDate) {
      path = `${path}&date=${encodeURIComponent(date)}`;
    }
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', path, token, '', 12000));
    if (!result.ok) return ApiResult.failure<ActivityReportDto>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 200) {
      return ApiResult.failure<ActivityReportDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected activity report status'));
    }
    const dto: ActivityReportDto | null = parseActivityReport(response.bodyText);
    if (dto === null) {
      return ApiResult.failure<ActivityReportDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid activity report response'));
    }
    return ApiResult.success<ActivityReportDto>(dto);
  }

  /** 下载私有 FALL 证据。Token 只进入 transport 的 Authorization 请求头。 */
  async evidence(token: string, alarmId: string,
    cancellation: EvidenceRequestCancellation | null = null): Promise<ApiResult<EvidenceImageBytes>> {
    if (token.length === 0) return this.unauthorized<EvidenceImageBytes>();
    if (!validEvidenceAlarmId(alarmId)) {
      return ApiResult.failure<EvidenceImageBytes>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'invalid alarm id'));
    }
    const path: string = `/api/v1/alerts/${encodeURIComponent(alarmId)}/evidence/content`;
    const spec = new HttpRequestSpec('GET', path, token, '', EVIDENCE_TIMEOUT_MS);
    spec.responseType = 'binary';
    spec.maxResponseBytes = MAX_EVIDENCE_JPEG_BYTES;
    spec.cancellation = cancellation;
    const result: ApiResult<HttpRawResponse> = await this.send(spec);
    if (!result.ok) return ApiResult.failure<EvidenceImageBytes>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (!isJpegContentType(response.contentType)) {
      return ApiResult.failure<EvidenceImageBytes>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'content-type is not image/jpeg'));
    }
    if (response.contentLengthValid === false) {
      return ApiResult.failure<EvidenceImageBytes>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid content-length'));
    }
    if ((response.contentLength > MAX_EVIDENCE_JPEG_BYTES) ||
      response.bodyBytes.byteLength > MAX_EVIDENCE_JPEG_BYTES) {
      return ApiResult.failure<EvidenceImageBytes>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'evidence exceeds size limit'));
    }
    if (!isBasicJpeg(response.bodyBytes)) {
      return ApiResult.failure<EvidenceImageBytes>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid jpeg payload'));
    }
    const image = new EvidenceImageBytes();
    image.alarmId = alarmId;
    image.contentType = response.contentType;
    image.payload = response.bodyBytes;
    return ApiResult.success<EvidenceImageBytes>(image);
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

  // ---------------------------------------------------------------------
  // 处置结果 / 安全日志（CONTRACT v1 增量；与 ACK 完全独立）
  // ---------------------------------------------------------------------

  /**
   * 查询单条告警已保存的处置记录。
   * 200 + {"dispositions":[...]}；404=未知 alarmId；结构非法按 MALFORMED 处理，不伪造空列表。
   */
  async dispositions(token: string, alarmId: string): Promise<ApiResult<DispositionDto[]>> {
    if (token.length === 0) return this.unauthorized<DispositionDto[]>();
    if (!validDispositionAlarmId(alarmId)) {
      return ApiResult.failure<DispositionDto[]>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'invalid alarm id'));
    }
    const path: string = `/api/v1/alerts/${encodeURIComponent(alarmId)}/dispositions`;
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', path, token, '', 12000));
    if (!result.ok) return ApiResult.failure<DispositionDto[]>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 200) {
      // 合同只定义了 200；其他 2xx 说明服务端实现与合同不符，不能当成功。
      return ApiResult.failure<DispositionDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected dispositions status'));
    }
    const items: DispositionDto[] | null = parseDispositions(response.bodyText);
    if (items === null) {
      return ApiResult.failure<DispositionDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid dispositions response'));
    }
    return ApiResult.success<DispositionDto[]>(items);
  }

  /**
   * 登记处置结果（独立于 ACK，绝不触发设备确认）。
   * 严格区分 201（首次创建）/ 200（同内容幂等重放）；其他 2xx 一律 MALFORMED。
   * 请求体只允许 clientDispositionId/outcome/note 三个字段。
   */
  async createDisposition(token: string, alarmId: string, clientDispositionId: string,
    outcome: string, note: string): Promise<ApiResult<DispositionResultDto>> {
    if (token.length === 0) return this.unauthorized<DispositionResultDto>();
    if (!validDispositionAlarmId(alarmId)) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'invalid alarm id'));
    }
    if (!validClientDispositionId(clientDispositionId)) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'invalid client disposition id'));
    }
    if (!validDispositionOutcome(outcome)) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'invalid disposition outcome'));
    }
    const cleanNote: string = normalizeDispositionNote(note);
    if (cleanNote.length > DISPOSITION_NOTE_MAX) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'disposition note too long'));
    }
    if (hasDispositionNoteControlChars(cleanNote)) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'disposition note has control characters'));
    }
    if (outcome === DISPOSITION_OUTCOME_OTHER && cleanNote.length === 0) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'disposition note required for OTHER'));
    }
    const path: string = `/api/v1/alerts/${encodeURIComponent(alarmId)}/dispositions`;
    const body: string = JSON.stringify({
      clientDispositionId: clientDispositionId,
      outcome: outcome,
      note: cleanNote
    });
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('POST', path, token, body, 12000));
    if (!result.ok) return ApiResult.failure<DispositionResultDto>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 201 && response.status !== 200) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected disposition status'));
    }
    const parsed: DispositionResultDto | null = parseDispositionResult(response.bodyText);
    if (parsed === null || parsed.disposition === null) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid disposition response'));
    }
    // 严格合同一致性：201 必须是首次创建，200 必须是幂等重放；否则不接受为“已保存”。
    if (response.status === 201 && !parsed.created) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, '201 without created'));
    }
    if (response.status === 200 && parsed.created) {
      return ApiResult.failure<DispositionResultDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, '200 with created'));
    }
    if (response.status === 200) parsed.duplicate = true;
    parsed.httpStatus = response.status;
    return ApiResult.success<DispositionResultDto>(parsed);
  }

  /** 安全日志历史（持久化台账，不是由当前 alerts 推导）；limit 非法时回退默认 50。 */
  async safetyLogs(token: string, limit: number = 50): Promise<ApiResult<SafetyLogDto[]>> {
    if (token.length === 0) return this.unauthorized<SafetyLogDto[]>();
    const cleanLimit: number = normalizeSafetyLogLimit(limit);
    const path: string = `/api/v1/safety-logs?limit=${cleanLimit}`;
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', path, token, '', 12000));
    if (!result.ok) return ApiResult.failure<SafetyLogDto[]>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 200) {
      return ApiResult.failure<SafetyLogDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected safety-logs status'));
    }
    const items: SafetyLogDto[] | null = parseSafetyLogs(response.bodyText);
    if (items === null) {
      return ApiResult.failure<SafetyLogDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid safety-logs response'));
    }
    return ApiResult.success<SafetyLogDto[]>(items);
  }

  /**
   * 门磁开关事件历史（持久化台账，不是由当前 door 状态推导）。
   * deviceId 为空返回全部房间；limit 1-100，非法值回退 20。
   * 空事件列表返回空数组（绝不伪造记录）。
   */
  async doorEvents(token: string, deviceId: string = '', limit: number = 20): Promise<ApiResult<DoorEventDto[]>> {
    if (token.length === 0) return this.unauthorized<DoorEventDto[]>();
    const cleanLimit: number = Number.isFinite(limit) && limit >= 1 && limit <= 100 ? Math.round(limit) : 20;
    const suffix: string = deviceId.length > 0 ? `&deviceId=${encodeURIComponent(deviceId)}` : '';
    const path: string = `/api/v1/door-events?limit=${cleanLimit}${suffix}`;
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', path, token, '', 12000));
    if (!result.ok) return ApiResult.failure<DoorEventDto[]>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 200) {
      return ApiResult.failure<DoorEventDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected door-events status'));
    }
    const events: DoorEventDto[] | null = parseDoorEvents(response.bodyText);
    if (events === null) {
      return ApiResult.failure<DoorEventDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid door-events response'));
    }
    return ApiResult.success<DoorEventDto[]>(events);
  }

  /**
   * 老人自述安全事件（GET /api/v1/elder-safe?limit=N）。
   * 只读记录；失败返回真实错误，页面显示“加载失败”，不得用样例数据冒充。
   */
  async elderSafeEvents(token: string, limit: number = 20): Promise<ApiResult<ElderSafeEventDto[]>> {
    if (token.length === 0) return this.unauthorized<ElderSafeEventDto[]>();
    const cleanLimit: number = Number.isFinite(limit) && limit >= 1 && limit <= 100 ? Math.round(limit) : 20;
    const path: string = `/api/v1/elder-safe?limit=${cleanLimit}`;
    const result: ApiResult<HttpRawResponse> =
      await this.send(new HttpRequestSpec('GET', path, token, '', 12000));
    if (!result.ok) return ApiResult.failure<ElderSafeEventDto[]>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 200) {
      return ApiResult.failure<ElderSafeEventDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected elder-safe status'));
    }
    const events: ElderSafeEventDto[] | null = parseElderSafeEvents(response.bodyText);
    if (events === null) {
      return ApiResult.failure<ElderSafeEventDto[]>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid elder-safe response'));
    }
    return ApiResult.success<ElderSafeEventDto[]>(events);
  }

  // ---------------------------------------------------------------------
  // 健康科普评估（AI-HEALTH-ASSESSMENT-SPEC §2）
  //
  // - GET/PUT 超时 12000ms；AI 生成超时 20000ms（> 后端单次 15s 上限）；
  // - 只走 Bearer；绝不把 profile 内容或 token 写进日志（本类不做任何日志）；
  // - 失败一律 ApiResult.failure，绝不在客户端伪造建议。
  // ---------------------------------------------------------------------

  static readonly HEALTH_PROFILE_TIMEOUT_MS: number = 12000;
  static readonly HEALTH_ADVICE_TIMEOUT_MS: number = 20000;
  static readonly HEALTH_PROFILE_PATH: string = '/api/v1/health-profile';
  static readonly HEALTH_ADVICE_PATH: string = '/api/v1/health-advice';

  /**
   * GET /api/v1/health-profile。
   * 200 + `{"profile": <HealthProfile>}` 或 `{"profile": null}`（还没有资料，属于成功）。
   */
  async getHealthProfile(token: string): Promise<ApiResult<HealthProfileEnvelopeDto>> {
    if (token.length === 0) return this.unauthorized<HealthProfileEnvelopeDto>();
    const result: ApiResult<HttpRawResponse> = await this.send(
      new HttpRequestSpec('GET', ApiClient.HEALTH_PROFILE_PATH, token, '',
        ApiClient.HEALTH_PROFILE_TIMEOUT_MS));
    if (!result.ok) return ApiResult.failure<HealthProfileEnvelopeDto>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 200) {
      return ApiResult.failure<HealthProfileEnvelopeDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected health profile status'));
    }
    const dto: HealthProfileEnvelopeDto | null = parseHealthProfileEnvelope(response.bodyText);
    if (dto === null) {
      return ApiResult.failure<HealthProfileEnvelopeDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid health profile response'));
    }
    return ApiResult.success<HealthProfileEnvelopeDto>(dto);
  }

  /**
   * PUT /api/v1/health-profile。请求体只含白名单且“未填写字段不出现”。
   * 成功 200 必须回 profile；400（校验失败）/413/503 等原样映射为失败。
   */
  async putHealthProfile(token: string,
    body: HealthProfileBody | null): Promise<ApiResult<HealthProfileEnvelopeDto>> {
    if (token.length === 0) return this.unauthorized<HealthProfileEnvelopeDto>();
    if (body === null || body === undefined) {
      return ApiResult.failure<HealthProfileEnvelopeDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'missing health profile body'));
    }
    const bodyText: string = healthProfileBodyJson(body);
    if (bodyText === '{}') {
      return ApiResult.failure<HealthProfileEnvelopeDto>(
        new ApiError(ApiErrorKinds.BAD_REQUEST, 400, 'empty health profile body'));
    }
    const result: ApiResult<HttpRawResponse> = await this.send(
      new HttpRequestSpec('PUT', ApiClient.HEALTH_PROFILE_PATH, token, bodyText,
        ApiClient.HEALTH_PROFILE_TIMEOUT_MS));
    if (!result.ok) return ApiResult.failure<HealthProfileEnvelopeDto>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 200) {
      return ApiResult.failure<HealthProfileEnvelopeDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected health profile status'));
    }
    const dto: HealthProfileEnvelopeDto | null = parseHealthProfileEnvelope(response.bodyText);
    if (dto === null || !dto.present) {
      return ApiResult.failure<HealthProfileEnvelopeDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid health profile response'));
    }
    return ApiResult.success<HealthProfileEnvelopeDto>(dto);
  }

  /**
   * POST /api/v1/health-advice。
   * profile=null → 使用服务端已保存资料（请求体 `{}`）；否则带 `{"profile": {...}}`（不落盘）。
   * 409/502/503/504 等失败原样返回 ApiError，绝不返回任何本地生成的建议。
   */
  async generateHealthAdvice(token: string,
    profile: HealthProfileBody | null = null): Promise<ApiResult<HealthAdviceEnvelopeDto>> {
    if (token.length === 0) return this.unauthorized<HealthAdviceEnvelopeDto>();
    let bodyText: string = '{}';
    if (profile !== null && profile !== undefined && profile.hasAnyField()) {
      bodyText = `{"profile":${healthProfileBodyJson(profile)}}`;
    }
    const result: ApiResult<HttpRawResponse> = await this.send(
      new HttpRequestSpec('POST', ApiClient.HEALTH_ADVICE_PATH, token, bodyText,
        ApiClient.HEALTH_ADVICE_TIMEOUT_MS));
    if (!result.ok) return ApiResult.failure<HealthAdviceEnvelopeDto>(result.error as ApiError);
    const response: HttpRawResponse = result.value as HttpRawResponse;
    if (response.status !== 200) {
      return ApiResult.failure<HealthAdviceEnvelopeDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'unexpected health advice status'));
    }
    const dto: HealthAdviceEnvelopeDto | null = parseHealthAdviceEnvelope(response.bodyText);
    if (dto === null) {
      return ApiResult.failure<HealthAdviceEnvelopeDto>(
        new ApiError(ApiErrorKinds.MALFORMED, response.status, 'invalid health advice response'));
    }
    return ApiResult.success<HealthAdviceEnvelopeDto>(dto);
  }
}

/** 去掉 URL 末尾斜杠，保持 baseUrl 只含 origin。 */
export function baseUrlOf(url: string): string {
  return url.endsWith('/') ? url.substring(0, url.length - 1) : url;
}
