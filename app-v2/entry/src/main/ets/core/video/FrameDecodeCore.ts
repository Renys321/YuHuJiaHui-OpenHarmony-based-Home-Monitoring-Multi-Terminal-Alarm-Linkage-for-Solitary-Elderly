/**
 * JPEG 帧校验 / 帧统计纯逻辑（VIDEO-VISIT-CONTRACT §3，可被 Node 测试）。
 *
 * relay 的每条 WebSocket 二进制消息 = 一张完整 JPEG（FF D8 ... FF D9）。
 * 本模块只做本地校验与统计，不做解码（解码在页面用 @ohos.multimedia.image）：
 * - 头尾校验：SOI + EOI + 尺寸范围（4096–1048576，契约 §1）；
 * - SOF0/SOF1/SOF2 解析宽高（用于确认 640x480，不伪造）；
 * - 本地帧序号、丢弃计数与实时 fps（滑动窗口）。
 */

export class FrameRejectReason {
  static readonly NONE: string = '';
  static readonly EMPTY: string = 'EMPTY';
  static readonly TOO_SMALL: string = 'TOO_SMALL';
  static readonly TOO_LARGE: string = 'TOO_LARGE';
  static readonly BAD_SOI: string = 'BAD_SOI';
  static readonly BAD_EOI: string = 'BAD_EOI';
  static readonly BAD_SOF: string = 'BAD_SOF';
}

/** 一帧的校验结果（尺寸 0 表示无法解析）。 */
export class JpegFrameInfo {
  valid: boolean = false;
  bytes: number = 0;
  width: number = 0;
  height: number = 0;
  /** FrameRejectReason 之一；valid=true 时为空串。 */
  reason: string = FrameRejectReason.EMPTY;
}

/** 帧被丢弃的提示文案（设备页/视频页共用，不冒充播放成功）。 */
export function frameRejectText(reason: string): string {
  if (reason === FrameRejectReason.TOO_SMALL) return '收到异常小帧，已丢弃（不是有效画面）';
  if (reason === FrameRejectReason.TOO_LARGE) return '收到超大帧，已丢弃（超过单帧上限）';
  if (reason === FrameRejectReason.BAD_SOI) return '收到非 JPEG 帧，已丢弃';
  if (reason === FrameRejectReason.BAD_EOI) return '收到不完整 JPEG 帧，已丢弃';
  if (reason === FrameRejectReason.BAD_SOF) return 'JPEG 尺寸信息异常，已丢弃';
  return '收到空帧，已丢弃';
}

export function readUint16BE(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 1 >= data.length) return -1;
  return (data[offset] << 8) | data[offset + 1];
}

export function readUint32BE(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 3 >= data.length) return -1;
  return data[offset] * 16777216 + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3];
}

/** SOF0/1/2/3/5/6/7/9/10/11/13/14/15 标记（含高度/宽度）。 */
function isSofMarker(marker: number): boolean {
  return (marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
    (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF);
}

class JpegSize {
  width: number = 0;
  height: number = 0;
}

/** 解析 JPEG 的 SOF 段尺寸；解析失败返回 null（不猜测 640x480）。 */
export function parseJpegSize(data: Uint8Array): JpegSize | null {
  if (data.length < 4) return null;
  if (data[0] !== 0xFF || data[1] !== 0xD8) return null;
  let offset: number = 2;
  while (offset + 3 < data.length) {
    if (data[offset] !== 0xFF) {
      offset += 1;
      continue;
    }
    let marker: number = data[offset + 1];
    while (marker === 0xFF && offset + 2 < data.length) {
      offset += 1;
      marker = data[offset + 1];
    }
    offset += 2;
    if (marker === 0xD8 || marker === 0x01) continue;
    if (marker === 0xD9 || marker === 0xDA) return null;
    const segmentLength: number = readUint16BE(data, offset);
    if (segmentLength < 2) return null;
    if (isSofMarker(marker)) {
      if (offset + 6 >= data.length) return null;
      const size = new JpegSize();
      size.height = readUint16BE(data, offset + 3);
      size.width = readUint16BE(data, offset + 5);
      if (size.width <= 0 || size.height <= 0) return null;
      return size;
    }
    offset += segmentLength;
  }
  return null;
}

/**
 * 校验一帧 JPEG：
 * - 长度必须在 [minBytes, maxBytes]（契约 4096–1048576）；
 * - 首两字节 FF D8、末两字节 FF D9；
 * - 能解析出 SOF 宽高（用于确认尺寸，不硬编码）。
 */
export function inspectJpegFrame(data: Uint8Array, minBytes: number, maxBytes: number): JpegFrameInfo {
  const info = new JpegFrameInfo();
  info.bytes = data !== null && data !== undefined ? data.length : 0;
  if (data === null || data === undefined || data.length === 0) {
    info.reason = FrameRejectReason.EMPTY;
    return info;
  }
  if (data.length < minBytes) {
    info.reason = FrameRejectReason.TOO_SMALL;
    return info;
  }
  if (data.length > maxBytes) {
    info.reason = FrameRejectReason.TOO_LARGE;
    return info;
  }
  if (data[0] !== 0xFF || data[1] !== 0xD8) {
    info.reason = FrameRejectReason.BAD_SOI;
    return info;
  }
  if (data[data.length - 2] !== 0xFF || data[data.length - 1] !== 0xD9) {
    info.reason = FrameRejectReason.BAD_EOI;
    return info;
  }
  const size: JpegSize | null = parseJpegSize(data);
  if (size === null) {
    info.reason = FrameRejectReason.BAD_SOF;
    return info;
  }
  info.valid = true;
  info.width = size.width;
  info.height = size.height;
  info.reason = FrameRejectReason.NONE;
  return info;
}

/** 本地帧序号/丢弃计数（relay 二进制帧无显式序号，计数即本地接收序）。 */
export class FrameSequenceTracker {
  received: number = 0;
  dropped: number = 0;
  lastReason: string = '';

  next(): number {
    this.received += 1;
    return this.received;
  }

  drop(reason: string): void {
    this.dropped += 1;
    this.lastReason = reason;
  }

  reset(): void {
    this.received = 0;
    this.dropped = 0;
    this.lastReason = '';
  }
}

/**
 * 实时 fps：保留最近 maxSamples 个到达时间，
 * fps = (样本数-1) / (最新-最早)（秒）；不足 2 帧或时间跨度为 0 → 0。
 */
export class FrameRateTracker {
  private ticks: number[] = [];
  private maxSamples: number = 20;

  addFrame(nowMs: number): void {
    this.ticks.push(nowMs);
    if (this.ticks.length > this.maxSamples) {
      this.ticks.splice(0, this.ticks.length - this.maxSamples);
    }
  }

  fps(): number {
    if (this.ticks.length < 2) return 0;
    const first: number = this.ticks[0];
    const last: number = this.ticks[this.ticks.length - 1];
    const spanMs: number = last - first;
    if (!isFinite(spanMs) || spanMs <= 0) return 0;
    const value: number = ((this.ticks.length - 1) * 1000) / spanMs;
    if (!isFinite(value) || value < 0) return 0;
    return Math.round(value * 10) / 10;
  }

  reset(): void {
    this.ticks = [];
  }
}
