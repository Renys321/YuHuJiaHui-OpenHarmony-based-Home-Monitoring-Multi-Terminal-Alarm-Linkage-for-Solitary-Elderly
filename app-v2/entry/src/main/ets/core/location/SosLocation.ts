/**
 * 随身求助（MANUAL_SOS）定位 → 地图状态（纯逻辑，可被 Node 测试）。
 *
 * 数据源（Lead 2026-10-27 实测更正：现网后端没有 wearable location 路由，
 * `/api/v1/alerts` 也不会带 sosLocation）：
 * - **主数据源**：`GET /api/v1/location`（Bearer）→ 取 `deviceId === 'esp32-sos'` 的最新点（WGS84）；
 *   现网该接口来自设备 device-status.gps，是唯一可用的真实位置来源；
 * - **状态由 APP 按 fixTime 计算**：无记录 → UNAVAILABLE；`now - fixTime > 120000ms` → STALE；
 *   否则 LOCATED。120s 与后端既有 SOS 阈值一致（基于服务器接收时间，这里是设备 fixTime）；
 * - **求助时刻 / 求助后更新**：`fixTime <= alert.createdAt + 5000` → “求助时刻位置”；
 *   `fixTime > alert.createdAt + 5000` → “求助后更新”（适配器在事件未 ACK 前冻结 gps，
 *   ACK 后恢复最新；5s 容差用于吸收设备/服务器时钟抖动）；
 * - **兼容**：告警里若出现可选字段 `sosLocation`，仍可解析/展示（不是唯一数据源、缺失不崩）。
 *
 * 坐标契约（DESIGN-CONTRACT §4）：
 * - 后端与设备始终是 **WGS84**；
 * - 本文件的 `wgs84ToGcj02()` 是 APP 内 **唯一** 的 WGS84→GCJ-02 转换点
 *   （`.ts` 编译为 JS 执行），目的是让坐标能叠加在高德（GCJ-02）栅格瓦片上；
 * - 传给 WebView（rawfile/map.html）的 JSON 由 `sosMapPayloadJson()` 生成，
 *   里面的 lat/lng **已经是 GCJ-02**；map.html 只做墨卡托投影，绝不再转一次；
 * - 页面/组件也不得再调用转换函数。转换只发生一次，避免“双重偏移”。
 *
 * 诚实性约束（与既有 ACK/处置同样的原则）：
 * - 无有效坐标时 available=false，绝不猜测/伪造位置；
 * - 状态未知（不是 LOCATED/STALE）一律按 UNAVAILABLE 处理；
 * - 没有可信时间时显示“时间未知”，不把 0 当成 1970；
 * - 没有任何位置记录时明确“暂无定位”，绝不拿其他设备的位置冒充。
 */
import { LocationPointDto } from '../api/Contracts';
import { AlertView, SosLocationView } from '../view/Models';

/** 后端 getWearableAlertLocation 只认这个 deviceId（DESIGN-CONTRACT §2，不可更改）。 */
export const SOS_DEVICE_ID: string = 'esp32-sos';
/** 后端位置记录使用的 deviceId（仅供排查/提示，APP 不直接使用）。 */
export const WEARABLE_LOCATION_DEVICE_ID: string = 'wearable-sos-001';
/** “定位时间晚于告警产生时间”的展示文案。 */
export const SOS_HELP_AFTER_LABEL: string = '求助后更新';
/** 定位于告警产生时刻附近（含 5s 时钟容差）的展示文案。 */
export const SOS_HELP_AT_LABEL: string = '求助时刻位置';
/** 告警时间未知时，不能判定“求助时刻/求助后”的固定标注。 */
export const SOS_RECENT_NOTE: string = '最近定位（可能晚于求助时刻）';
/** 定位有效期：与后端 SOS 阈值一致（固定 120s，不是接口参数）。 */
export const SOS_LOCATION_STALE_AFTER_MS: number = 120000;
/** “求助时刻”判定容差（设备/服务器时钟抖动）。 */
export const SOS_HELP_AT_TOLERANCE_MS: number = 5000;

/** 定位状态：服务端 sosLocation 可能给 LOCATED/STALE/UNAVAILABLE；APP 兜底/主路径也复用这三个值。 */
export class SosStatus {
  static readonly LOCATED: string = 'LOCATED';
  static readonly STALE: string = 'STALE';
  static readonly UNAVAILABLE: string = 'UNAVAILABLE';
}

/** GCJ-02 坐标（高德瓦片使用的坐标系）。 */
export class GcjPoint {
  latitude: number = 0;
  longitude: number = 0;
}

const GCJ_PI: number = 3.1415926535897932384626;
const GCJ_A: number = 6378245.0;
const GCJ_EE: number = 0.00669342162296594323;

function transformLat(x: number, y: number): number {
  let ret: number = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * GCJ_PI) + 40.0 * Math.sin(y / 3.0 * GCJ_PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * GCJ_PI) + 320.0 * Math.sin(y * GCJ_PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret: number = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * GCJ_PI) + 40.0 * Math.sin(x / 3.0 * GCJ_PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * GCJ_PI) + 300.0 * Math.sin(x / 30.0 * GCJ_PI)) * 2.0 / 3.0;
  return ret;
}

/** 中国境外不做偏移（标准做法）；境内才应用 GCJ-02 偏移。 */
export function outOfChina(latitude: number, longitude: number): boolean {
  if (longitude < 72.004 || longitude > 137.8347) return true;
  if (latitude < 0.8293 || latitude > 55.8271) return true;
  return false;
}

/**
 * WGS84 → GCJ-02。**APP 内唯一转换点**：只在 core 层调用一次，
 * 结果放进 SosMapState.latitude/longitude（已转）后再交给 Web。
 * 非法输入原样返回（不产生虚假坐标）。
 */
export function wgs84ToGcj02(latitude: number, longitude: number): GcjPoint {
  const point = new GcjPoint();
  point.latitude = latitude;
  point.longitude = longitude;
  if (!isFinite(latitude) || !isFinite(longitude)) return point;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return point;
  if (outOfChina(latitude, longitude)) return point;
  let dLat: number = transformLat(longitude - 105.0, latitude - 35.0);
  let dLng: number = transformLng(longitude - 105.0, latitude - 35.0);
  const radLat: number = latitude / 180.0 * GCJ_PI;
  let magic: number = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic: number = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * GCJ_PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * GCJ_PI);
  point.latitude = latitude + dLat;
  point.longitude = longitude + dLng;
  return point;
}

/** 缺省/非法一律 UNAVAILABLE：未知状态不得显示成“定位有效”。 */
export function normalizeSosStatus(value: string): string {
  if (value === SosStatus.LOCATED) return SosStatus.LOCATED;
  if (value === SosStatus.STALE) return SosStatus.STALE;
  return SosStatus.UNAVAILABLE;
}

export function validLatitudeValue(value: number | null): number | null {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  if (value < -90 || value > 90) return null;
  return value;
}

export function validLongitudeValue(value: number | null): number | null {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  if (value < -180 || value > 180) return null;
  return value;
}

/** epoch 毫秒：只接受 >0 的有限数；其余一律 0（=无有效时间，不显示 1970）。 */
export function validEpochMs(value: number): number {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return 0;
  return value;
}

/** 服务端 ageSeconds：只接受 >=0 的有限数；缺失/非法一律 -1（未知）。 */
export function validAgeSeconds(value: number | null): number {
  if (typeof value !== 'number' || !isFinite(value) || value < 0) return -1;
  return Math.floor(value);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 本地时区时间格式化（设备本地时间；测试用本地 Date 构造，不依赖时区）。 */
export function formatLocalTime(ms: number): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '时间未知';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 经纬度固定小数位（页面要求 6 位；非法值显示 --）。 */
export function formatCoordValue(value: number, digits: number): string {
  if (typeof value !== 'number' || !isFinite(value)) return '--';
  return value.toFixed(digits);
}

/**
 * 定位年龄（秒）：优先用服务端接收时间本地计算（实时、可跨 poll 更新），
 * 其次用服务端 ageSeconds，最后用 positionTime。都不可用时返回 -1（未知）。
 */
export function sosAgeSeconds(positionTime: number, receivedAt: number,
  providedAgeSeconds: number, nowMs: number): number {
  const now: number = typeof nowMs === 'number' && isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  if (typeof receivedAt === 'number' && isFinite(receivedAt) && receivedAt > 0 && receivedAt <= now) {
    return Math.max(0, Math.floor((now - receivedAt) / 1000));
  }
  const provided: number = validAgeSeconds(providedAgeSeconds);
  if (provided >= 0) return provided;
  if (typeof positionTime === 'number' && isFinite(positionTime) && positionTime > 0 &&
    positionTime <= now) {
    return Math.max(0, Math.floor((now - positionTime) / 1000));
  }
  return -1;
}

/** 年龄文案：未知时明确说未知，不用 0 冒充。 */
export function formatAgeText(seconds: number): string {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '定位时间未知';
  if (seconds < 60) return `${Math.floor(seconds)} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

/** 状态徽章文案（列表页/地图卡共用）。 */
export function sosStatusText(status: string): string {
  if (status === SosStatus.LOCATED) return '定位有效';
  if (status === SosStatus.STALE) return '定位已过期';
  return '暂无定位';
}

export function sosStatusBadgeBg(status: string): string {
  if (status === SosStatus.LOCATED) return '#D1FAE5';
  if (status === SosStatus.STALE) return '#FEF3C7';
  return '#F1F5F9';
}

export function sosStatusBadgeFg(status: string): string {
  if (status === SosStatus.LOCATED) return '#059669';
  if (status === SosStatus.STALE) return '#B45309';
  return '#475569';
}

/** 只有随身求助（MANUAL_SOS）告警才显示地图卡。 */
export function isSosAlert(alert: AlertView): boolean {
  return alert.type === 'MANUAL_SOS';
}

/** 交给 rawfile/map.html 的 JSON（lat/lng 已经是 GCJ-02，Web 侧不再转换）。 */
export class SosMapPayload {
  available: boolean = false;
  status: string = SosStatus.UNAVAILABLE;
  statusText: string = '暂无定位';
  source: string = 'NONE';
  sourceText: string = '';
  /** GCJ-02（已转换；available=false 时无意义，Web 不得显示） */
  lat: number = 0;
  lng: number = 0;
  coordText: string = '--';
  positionTime: number = 0;
  receivedAt: number = 0;
  timeText: string = '定位时间未知';
  receivedText: string = '';
  ageText: string = '定位时间未知';
  updatedAfterSos: boolean = false;
  updateText: string = '';
  noteText: string = '';
  deviceId: string = '';
  zoom: number = 16;
}

/** 地图卡视图状态（ArkUI 侧文本 + 交给 Web 的 payload 字符串）。 */
export class SosMapState {
  /** 是否有可标记的真实坐标（false 时 Web 显示明确的空状态，不画假点）。 */
  available: boolean = false;
  status: string = SosStatus.UNAVAILABLE;
  statusText: string = '暂无定位';
  badgeBg: string = '#F1F5F9';
  badgeFg: string = '#475569';
  /** 'DEVICE'（/api/v1/location 的 esp32-sos 点，主数据源） / 'SOS'（告警可选 sosLocation，兼容） / 'NONE' */
  source: string = 'NONE';
  sourceText: string = '';
  /** GCJ-02（已转换；页面/组件不得再转换） */
  latitude: number = 0;
  longitude: number = 0;
  coordText: string = '--';
  positionTime: number = 0;
  receivedAt: number = 0;
  timeText: string = '定位时间未知';
  receivedText: string = '';
  ageSeconds: number = -1;
  ageText: string = '定位时间未知';
  /** fixTime 晚于 alert.createdAt + 5s 时为 true（“求助后更新”）。 */
  updatedAfterSos: boolean = false;
  updateText: string = '';
  noteText: string = '';
  deviceId: string = '';
  alertCreatedAt: number = 0;
  payloadJson: string = '{}';
}

function applyStatusLook(state: SosMapState): void {
  state.statusText = sosStatusText(state.status);
  state.badgeBg = sosStatusBadgeBg(state.status);
  state.badgeFg = sosStatusBadgeFg(state.status);
}

function fillTimeFields(state: SosMapState, messagePrefix: string): void {
  if (state.positionTime > 0) {
    state.timeText = `${messagePrefix}：${formatLocalTime(state.positionTime)}`;
  } else if (state.receivedAt > 0) {
    state.timeText = `接收时间：${formatLocalTime(state.receivedAt)}`;
  } else {
    state.timeText = '定位时间未知';
  }
  state.receivedText = state.receivedAt > 0 && state.receivedAt !== state.positionTime
    ? `服务端接收：${formatLocalTime(state.receivedAt)}` : '';
  state.ageText = formatAgeText(state.ageSeconds);
}

function applyGcjCoords(state: SosMapState, wgsLat: number, wgsLng: number): boolean {
  const gcj: GcjPoint = wgs84ToGcj02(wgsLat, wgsLng);
  if (!isFinite(gcj.latitude) || !isFinite(gcj.longitude)) return false;
  state.latitude = gcj.latitude;
  state.longitude = gcj.longitude;
  state.coordText = `${formatCoordValue(gcj.latitude, 6)}, ${formatCoordValue(gcj.longitude, 6)}`;
  state.available = true;
  return true;
}

export function sosMapPayload(state: SosMapState): SosMapPayload {
  const payload = new SosMapPayload();
  payload.available = state.available;
  payload.status = state.status;
  payload.statusText = state.statusText;
  payload.source = state.source;
  payload.sourceText = state.sourceText;
  payload.lat = state.available ? state.latitude : 0;
  payload.lng = state.available ? state.longitude : 0;
  payload.coordText = state.available ? state.coordText : '--';
  payload.positionTime = state.positionTime;
  payload.receivedAt = state.receivedAt;
  payload.timeText = state.timeText;
  payload.receivedText = state.receivedText;
  payload.ageText = state.ageText;
  payload.updatedAfterSos = state.updatedAfterSos;
  payload.updateText = state.updateText;
  payload.noteText = state.noteText;
  payload.deviceId = state.deviceId;
  return payload;
}

/** 生成传给 Web 的 JSON 字符串（坐标已 GCJ-02）。 */
export function sosMapPayloadJson(state: SosMapState): string {
  state.payloadJson = JSON.stringify(sosMapPayload(state));
  return state.payloadJson;
}

/** 无有效定位的明确中文状态（reason 必须是真实原因，不能是猜测）。 */
export function sosMapUnavailable(reason: string): SosMapState {
  const state = new SosMapState();
  state.status = SosStatus.UNAVAILABLE;
  state.source = 'NONE';
  state.sourceText = '';
  applyStatusLook(state);
  state.noteText = reason;
  sosMapPayloadJson(state);
  return state;
}

function stateForUnavailable(reason: string, alertCreatedAt: number, deviceId: string): SosMapState {
  const state = sosMapUnavailable(reason);
  state.alertCreatedAt = alertCreatedAt;
  state.deviceId = deviceId;
  state.timeText = '定位时间未知';
  state.ageText = '定位时间未知';
  sosMapPayloadJson(state);
  return state;
}

/**
 * 告警携带的 sosLocation → 地图状态（不发起网络请求）。
 * - sosLocation 缺失/非对象：unavailable，note 说明“告警未携带 sosLocation”；
 * - LOCATED/STALE 但坐标非法：降级 unavailable（不能既说“定位有效”又没坐标）。
 */
export function sosMapStateFromAlert(alert: AlertView, nowMs: number): SosMapState {
  if (!isSosAlert(alert)) {
    return stateForUnavailable('该告警不是随身求助（MANUAL_SOS），不显示求助地图',
      alert.createdAt, alert.deviceId);
  }
  if (alert.sosLocation === null || alert.sosLocation.present !== true) {
    return stateForUnavailable('告警未携带 sosLocation，正在查询最近定位…',
      alert.createdAt, alert.deviceId);
  }
  const loc: SosLocationView = alert.sosLocation;
  if (loc.status !== SosStatus.LOCATED && loc.status !== SosStatus.STALE) {
    const state = stateForUnavailable('服务端标记该求助暂无有效定位；不显示推测位置',
      alert.createdAt, alert.deviceId);
    state.positionTime = loc.positionTime;
    state.receivedAt = loc.receivedAt;
    state.ageSeconds = sosAgeSeconds(loc.positionTime, loc.receivedAt, loc.ageSeconds, nowMs);
    fillTimeFields(state, '定位时间');
    sosMapPayloadJson(state);
    return state;
  }
  if (loc.latitude === null || loc.longitude === null) {
    const state = stateForUnavailable('服务端定位缺少经纬度；不显示推测位置',
      alert.createdAt, alert.deviceId);
    state.positionTime = loc.positionTime;
    state.receivedAt = loc.receivedAt;
    state.ageSeconds = sosAgeSeconds(loc.positionTime, loc.receivedAt, loc.ageSeconds, nowMs);
    fillTimeFields(state, '定位时间');
    sosMapPayloadJson(state);
    return state;
  }
  const state = new SosMapState();
  state.status = loc.status;
  state.source = 'SOS';
  state.sourceText = '求助定位';
  state.deviceId = alert.deviceId;
  state.alertCreatedAt = alert.createdAt;
  state.positionTime = loc.positionTime;
  state.receivedAt = loc.receivedAt;
  state.ageSeconds = sosAgeSeconds(loc.positionTime, loc.receivedAt, loc.ageSeconds, nowMs);
  state.updatedAfterSos = loc.positionTime > 0 && alert.createdAt > 0 &&
    loc.positionTime > alert.createdAt;
  state.updateText = state.updatedAfterSos ? SOS_HELP_AFTER_LABEL : '';
  if (!applyGcjCoords(state, loc.latitude, loc.longitude)) {
    return stateForUnavailable('服务端定位坐标非法；不显示推测位置', alert.createdAt, alert.deviceId);
  }
  applyStatusLook(state);
  fillTimeFields(state, '定位时间');
  state.noteText = state.status === SosStatus.STALE
    ? '定位已超过有效时限（服务端判定过期），仅代表最后一次有效定位'
    : '';
  sosMapPayloadJson(state);
  return state;
}

/**
 * 从 /api/v1/location 的 locations 里挑出指定设备的最新点（fixTime 最大）。
 * fixTime 缺失/为 0 的记录无法判断“最新”，一律不采用（不猜测）。
 */
export function pickLatestLocation(points: LocationPointDto[], deviceId: string): LocationPointDto | null {
  if (deviceId.length === 0) return null;
  let best: LocationPointDto | null = null;
  let bestFixTime: number = 0;
  for (let i = 0; i < points.length; i++) {
    const point: LocationPointDto = points[i];
    if (point.deviceId !== deviceId) continue;
    if (validLatitudeValue(point.latitude) === null) continue;
    if (validLongitudeValue(point.longitude) === null) continue;
    const fixTime: number = validEpochMs(point.fixTime);
    if (fixTime <= 0) continue;
    if (best === null || fixTime > bestFixTime) {
      best = point;
      bestFixTime = fixTime;
    }
  }
  return best;
}

/** APP 侧按 fixTime 计算定位状态：无 fixTime → UNAVAILABLE；`now-fixTime > 120s` → STALE；否则 LOCATED。 */
export function sosStatusForFixTime(fixTime: number, nowMs: number): string {
  const fix: number = validEpochMs(fixTime);
  if (fix <= 0) return SosStatus.UNAVAILABLE;
  const now: number = typeof nowMs === 'number' && isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  if (now - fix > SOS_LOCATION_STALE_AFTER_MS) return SosStatus.STALE;
  return SosStatus.LOCATED;
}

/**
 * “求助时刻位置” vs “求助后更新”判定：
 * fixTime <= alertCreatedAt + 5000ms → 求助时刻（容差吸收时钟抖动）；
 * fixTime > alertCreatedAt + 5000ms → 求助后更新；告警时间未知 → 无法判定（false）。
 */
export function sosUpdatedAfterHelp(fixTime: number, alertCreatedAt: number): boolean {
  if (typeof fixTime !== 'number' || !isFinite(fixTime) || fixTime <= 0) return false;
  if (typeof alertCreatedAt !== 'number' || !isFinite(alertCreatedAt) || alertCreatedAt <= 0) {
    return false;
  }
  return fixTime > alertCreatedAt + SOS_HELP_AT_TOLERANCE_MS;
}

/**
 * 主数据源：`/api/v1/location` 里 deviceId=esp32-sos 的最新点 → 地图状态。
 * 状态由 APP 按 fixTime 计算（120s 阈值），并判定“求助时刻位置/求助后更新”。
 * 坐标只在 applyGcjCoords 里转换一次。
 */
export function sosMapStateFromDeviceLocation(point: LocationPointDto,
  alertCreatedAt: number, nowMs: number): SosMapState {
  const latitude: number | null = validLatitudeValue(point.latitude);
  const longitude: number | null = validLongitudeValue(point.longitude);
  const fixTime: number = validEpochMs(point.fixTime);
  if (latitude === null || longitude === null) {
    return stateForUnavailable('设备定位坐标无效；不显示推测位置', alertCreatedAt, point.deviceId);
  }
  if (fixTime <= 0) {
    return stateForUnavailable('设备定位缺少 fixTime，无法判断定位是否有效；不显示推测位置',
      alertCreatedAt, point.deviceId);
  }
  const state = new SosMapState();
  state.source = 'DEVICE';
  state.deviceId = point.deviceId;
  state.alertCreatedAt = alertCreatedAt;
  state.positionTime = fixTime;
  state.receivedAt = 0;
  const now: number = typeof nowMs === 'number' && isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  state.ageSeconds = Math.max(0, Math.floor((now - fixTime) / 1000));
  state.status = sosStatusForFixTime(fixTime, nowMs);
  state.updatedAfterSos = sosUpdatedAfterHelp(fixTime, alertCreatedAt);
  state.updateText = state.updatedAfterSos ? SOS_HELP_AFTER_LABEL : '';
  const notes: string[] = [];
  if (alertCreatedAt > 0) {
    state.sourceText = state.updatedAfterSos ? '求助位置' : SOS_HELP_AT_LABEL;
  } else {
    state.sourceText = '最近定位';
    notes.push(SOS_RECENT_NOTE);
  }
  if (!applyGcjCoords(state, latitude, longitude)) {
    return stateForUnavailable('设备定位坐标无效；不显示推测位置', alertCreatedAt, point.deviceId);
  }
  applyStatusLook(state);
  fillTimeFields(state, '定位时间');
  if (state.status === SosStatus.STALE) {
    notes.push(`定位已过期，展示最后一次定位位置（${state.ageText}）`);
  }
  state.noteText = notes.join('；');
  sosMapPayloadJson(state);
  return state;
}

/**
 * 主数据源全流程：从 `/api/v1/location` 的 locations 选 esp32-sos 最新点 → 地图状态。
 * 无可用点返回明确无定位状态（不拿其他设备的位置冒充）。
 */
export function sosMapStateFromLocations(points: LocationPointDto[], deviceId: string,
  alertCreatedAt: number, nowMs: number): SosMapState {
  const point: LocationPointDto | null = pickLatestLocation(points, deviceId);
  if (point === null) {
    return stateForUnavailable('未查询到该设备（esp32-sos）的定位记录；不显示推测位置',
      alertCreatedAt, deviceId);
  }
  return sosMapStateFromDeviceLocation(point, alertCreatedAt, nowMs);
}
