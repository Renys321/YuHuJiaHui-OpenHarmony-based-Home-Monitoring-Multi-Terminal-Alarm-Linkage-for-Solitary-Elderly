/**
 * 视频 relay HTTP / WebSocket 控制消息的纯逻辑解析（VIDEO-VISIT-CONTRACT §2.2/§3）。
 *
 * 只做“响应 → 结果对象”的确定性映射，不做网络请求；平台层（GuardianService / net 适配器）
 * 负责真实 HTTP/WS，页面只消费这里定义的结果。
 */
import { defaultWsPath } from './VideoConfig';
import { parseJsonObject } from '../util/Json';

export class VideoErrorKind {
  /** 没有登录 token：不发起任何请求。 */
  static readonly NO_TOKEN: string = 'no_token';
  static readonly UNAUTHORIZED: string = 'unauthorized';
  static readonly RATE_LIMITED: string = 'rate_limited';
  static readonly TIMEOUT: string = 'timeout';
  static readonly NETWORK: string = 'network';
  static readonly SERVER: string = 'server';
  static readonly BAD_RESPONSE: string = 'bad_response';
  /** relay 返回的 WS 控制错误码：DAYU_DOWN / NO_AGENT / BUSY。 */
  static readonly RELAY_ERROR: string = 'relay_error';
  /** WS 非正常关闭且重连次数耗尽。 */
  static readonly DISCONNECTED: string = 'disconnected';
}

/** 有 token 才允许请求 /video/session（无 token 直接失败，不发请求）。 */
export function shouldRequestVideoSession(token: string): boolean {
  return typeof token === 'string' && token.length > 0;
}

/** POST /video/session 的 2xx 响应体。 */
export class VideoTicketDto {
  ticket: string = '';
  expiresInMs: number = 0;
  wsPath: string = '';
}

const TICKET_RE: RegExp = /^[0-9a-zA-Z_-]{16,256}$/;

/**
 * 严格解析 ticket 响应：ticket 必须是 16–256 位安全字符；wsPath 缺失时按 ticket 兜底。
 * 非法 JSON/缺 ticket → null。
 */
export function parseVideoTicket(bodyText: string): VideoTicketDto | null {
  const root: any = parseJsonObject(bodyText);
  if (root === null) return null;
  const ticket: any = root['ticket'];
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return null;
  const dto = new VideoTicketDto();
  dto.ticket = ticket;
  const expires: any = root['expiresInMs'];
  dto.expiresInMs = typeof expires === 'number' && isFinite(expires) && expires > 0
    ? Math.floor(expires) : 0;
  const wsPath: any = root['wsPath'];
  dto.wsPath = typeof wsPath === 'string' && wsPath.length > 0 && wsPath.charAt(0) === '/'
    ? wsPath : defaultWsPath(ticket);
  return dto;
}

/** 申请会话的结果（成功=ticket 可用；失败=kind/message 供页面显示 + 重试）。 */
export class VideoTicketOutcome {
  ok: boolean = false;
  ticket: string = '';
  wsPath: string = '';
  expiresInMs: number = 0;
  kind: string = '';
  message: string = '';
  status: number = 0;

  static success(dto: VideoTicketDto): VideoTicketOutcome {
    const outcome = new VideoTicketOutcome();
    outcome.ok = true;
    outcome.ticket = dto.ticket;
    outcome.wsPath = dto.wsPath;
    outcome.expiresInMs = dto.expiresInMs;
    return outcome;
  }

  static failure(kind: string, message: string, status: number = 0): VideoTicketOutcome {
    const outcome = new VideoTicketOutcome();
    outcome.ok = false;
    outcome.kind = kind;
    outcome.message = message;
    outcome.status = status;
    return outcome;
  }
}

export function ticketOutcomeForNoToken(): VideoTicketOutcome {
  return VideoTicketOutcome.failure(VideoErrorKind.NO_TOKEN, '登录已失效，请重新登录后再试探望', 0);
}

/**
 * 把 POST /video/session 的 HTTP 结果映射为结果对象。
 * 401/403 → 鉴权失败；429 → 频率限制；超时/网络错误 → 可重试；非法 JSON → 服务异常。
 */
export function ticketOutcomeForResponse(status: number, bodyText: string,
  timedOut: boolean = false, networkError: boolean = false): VideoTicketOutcome {
  if (networkError || status <= 0) {
    return ticketOutcomeForNetwork(timedOut);
  }
  if (status === 401 || status === 403) {
    return VideoTicketOutcome.failure(VideoErrorKind.UNAUTHORIZED,
      `登录已失效或无观看权限（HTTP ${status}），请重新登录后再试`, status);
  }
  if (status === 429) {
    return VideoTicketOutcome.failure(VideoErrorKind.RATE_LIMITED,
      '视频请求过于频繁（HTTP 429），请稍后重试', status);
  }
  if (status < 200 || status >= 300) {
    return VideoTicketOutcome.failure(VideoErrorKind.SERVER,
      `视频服务暂时不可用（HTTP ${status}），请稍后重试`, status);
  }
  const dto: VideoTicketDto | null = parseVideoTicket(bodyText);
  if (dto === null) {
    return VideoTicketOutcome.failure(VideoErrorKind.BAD_RESPONSE,
      '视频服务返回的会话信息异常，暂时无法观看', status);
  }
  return VideoTicketOutcome.success(dto);
}

function ticketOutcomeForNetwork(timedOut: boolean): VideoTicketOutcome {
  if (timedOut) {
    return VideoTicketOutcome.failure(VideoErrorKind.TIMEOUT, '连接视频服务超时，请检查网络后重试');
  }
  return VideoTicketOutcome.failure(VideoErrorKind.NETWORK, '无法连接视频服务，请检查网络后重试');
}

export class VideoEndOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  status: number = 0;
}

/** POST /video/session/end 的结果；失败只影响服务端尽快停止推流，不影响页面已退出。 */
export function endOutcomeForResponse(status: number, timedOut: boolean = false,
  networkError: boolean = false): VideoEndOutcome {
  const outcome = new VideoEndOutcome();
  outcome.status = status;
  if (networkError || status <= 0) {
    outcome.kind = timedOut ? VideoErrorKind.TIMEOUT : VideoErrorKind.NETWORK;
    outcome.message = timedOut ? '结束会话请求超时' : '结束会话请求网络失败';
    return outcome;
  }
  if (status >= 200 && status < 300) {
    outcome.ok = true;
    return outcome;
  }
  outcome.kind = status === 401 || status === 403 ? VideoErrorKind.UNAUTHORIZED : VideoErrorKind.SERVER;
  outcome.message = `结束会话失败（HTTP ${status}）`;
  return outcome;
}

/** WS 文本控制消息（ready / error / resumed / heartbeat）。 */
export class VideoControlMessage {
  type: string = '';
  code: string = '';
  proto: number = 0;
  camera: string = '';
  ts: number = 0;
  fps: number = 0;
}

export function parseControlMessage(text: string): VideoControlMessage | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const root: any = parseJsonObject(text);
  if (root === null) return null;
  const type: any = root['type'];
  if (typeof type !== 'string' || type.length === 0) return null;
  const message = new VideoControlMessage();
  message.type = type;
  const code: any = root['code'];
  message.code = typeof code === 'string' ? code : '';
  const proto: any = root['proto'];
  message.proto = typeof proto === 'number' && isFinite(proto) ? Math.floor(proto) : 0;
  const camera: any = root['camera'];
  message.camera = typeof camera === 'string' ? camera : '';
  const ts: any = root['ts'];
  message.ts = typeof ts === 'number' && isFinite(ts) && ts > 0 ? Math.floor(ts) : 0;
  const fps: any = root['fps'];
  message.fps = typeof fps === 'number' && isFinite(fps) && fps >= 0 ? fps : 0;
  return message;
}

/** relay WS 控制错误码 → 用户可读文案（不冒充“正在直播”）。 */
export function relayErrorText(code: string): string {
  if (code === 'DAYU_DOWN') return '客厅摄像头链路中断（DAYU_DOWN），暂时无法观看';
  if (code === 'NO_AGENT') return '视频中继未连接设备端（NO_AGENT），暂时无法观看';
  if (code === 'BUSY') return '设备正忙或观看人数已达上限（BUSY），请稍后再试';
  if (code.length > 0) return `视频连接异常（${code}）`;
  return '视频连接异常';
}

/** ticket 是否已过期（expiresInMs 来自 relay，0 表示未提供、不本地判过期）。 */
export function ticketExpired(expiresInMs: number, requestedAtMs: number, nowMs: number): boolean {
  if (!isFinite(expiresInMs) || expiresInMs <= 0) return false;
  return nowMs - requestedAtMs >= expiresInMs;
}

/** 便于测试/日志引用（不包含 ticket 明文）。 */
export function ticketPrefix(ticket: string): string {
  return ticket.length > 6 ? ticket.substring(0, 6) : ticket;
}
