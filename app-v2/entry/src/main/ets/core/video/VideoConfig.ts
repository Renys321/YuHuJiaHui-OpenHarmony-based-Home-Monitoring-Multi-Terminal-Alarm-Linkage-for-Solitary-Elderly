/**
 * 视频探望配置（VIDEO-VISIT-CONTRACT §3）。
 *
 * relay 地址只有一个来源：默认常量 + AppStorage key `video.relayBase` 覆盖。
 * - 模拟器验收默认 `http://10.0.2.2:9443`（QEMU NAT 到宿主 relay）；
 * - 生产可设为 `https://api.luxunacc.xyz`（http→ws / https→wss 自动转换）。
 * 页面与其它源码不得再写死任何 relay 地址。
 */
export class VideoConfig {
  /** 默认 relay 地址：HarmonyOS 模拟器经 QEMU NAT 访问宿主 relay。 */
  static readonly DEFAULT_RELAY_BASE: string = 'http://10.0.2.2:9443';
  /** AppStorage 覆盖键（生产域名等由运行环境注入，不写死到页面）。 */
  static readonly RELAY_BASE_STORAGE_KEY: string = 'video.relayBase';
  /** 申请一次性 ticket 的接口路径。 */
  static readonly SESSION_PATH: string = '/video/session';
  /** 结束本次观看的接口路径。 */
  static readonly SESSION_END_PATH: string = '/video/session/end';
  static readonly SESSION_TIMEOUT_MS: number = 10000;
  static readonly END_TIMEOUT_MS: number = 5000;
  /** 断线自动重连次数上限（退避 1/2/4s）。 */
  static readonly MAX_RECONNECT_ATTEMPTS: number = 3;
  /** 第一次重连延迟（之后 2x 递增）。 */
  static readonly RECONNECT_BASE_DELAY_MS: number = 1000;
  /** 单帧约束（契约 §1：4096 ≤ N ≤ 1048576）。 */
  static readonly FRAME_MIN_BYTES: number = 4096;
  static readonly FRAME_MAX_BYTES: number = 1048576;
  /** DAYU200 相机分辨率（仅用于校验/展示，不参与伪造）。 */
  static readonly TARGET_CAMERA: string = '640x480';
  /** 固定隐私提示（契约 §3 逐字要求）。 */
  static readonly PRIVACY_TEXT: string = '仅本次会话实时查看，不录像、不留存、不录音';
  /** relay WS 路径前缀（由 /video/session 返回的 wsPath 提供，缺失时才用前缀兜底）。 */
  static readonly WS_PATH_PREFIX: string = '/video/stream';
  /** 首帧等待超时：超过该时间仍无任何帧则提示重试（不是“正在直播”）。 */
  static readonly FIRST_FRAME_TIMEOUT_MS: number = 15000;
}

/** 只接受 http(s) 主机[:端口]，不接受路径/查询串（避免把 relay 地址拼坏）。 */
const RELAY_BASE_RE: RegExp = /^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?$/;

/** 归一化 relay 基址：去空白/末尾斜杠；非法返回空串。 */
export function normalizeRelayBase(value: string): string {
  if (typeof value !== 'string') return '';
  let base: string = value.trim();
  while (base.length > 0 && base.charAt(base.length - 1) === '/') {
    base = base.substring(0, base.length - 1);
  }
  if (base.length === 0) return '';
  if (!RELAY_BASE_RE.test(base)) return '';
  return base;
}

/** AppStorage 覆盖值优先；空/非法时回退默认模拟器地址。 */
export function relayBaseOrDefault(override: string): string {
  const normalized: string = normalizeRelayBase(override);
  return normalized.length > 0 ? normalized : VideoConfig.DEFAULT_RELAY_BASE;
}

function ensureLeadingSlash(path: string): string {
  const trimmed: string = typeof path === 'string' ? path.trim() : '';
  if (trimmed.length === 0) return '/';
  return trimmed.charAt(0) === '/' ? trimmed : `/${trimmed}`;
}

/** 拼 HTTP(S) 接口 URL（基址非法返回空串，调用方必须按失败处理）。 */
export function relayHttpUrl(relayBase: string, path: string): string {
  const base: string = normalizeRelayBase(relayBase);
  if (base.length === 0) return '';
  return base + ensureLeadingSlash(path);
}

/**
 * 由 relay 基址 + wsPath 生成 WebSocket URL：http→ws、https→wss。
 * 基址/路径非法返回空串（调用方按“连接失败”处理，不猜测地址）。
 */
export function wsUrlFor(relayBase: string, wsPath: string): string {
  const base: string = normalizeRelayBase(relayBase);
  if (base.length === 0) return '';
  const path: string = ensureLeadingSlash(wsPath);
  if (base.indexOf('https://') === 0) {
    return `wss://${base.substring('https://'.length)}${path}`;
  }
  if (base.indexOf('http://') === 0) {
    return `ws://${base.substring('http://'.length)}${path}`;
  }
  return '';
}

/** 由 ticket 兜底拼 ws 路径（relay 正常会返回完整 wsPath）。 */
export function defaultWsPath(ticket: string): string {
  return `${VideoConfig.WS_PATH_PREFIX}?ticket=${encodeURIComponent(ticket)}`;
}
