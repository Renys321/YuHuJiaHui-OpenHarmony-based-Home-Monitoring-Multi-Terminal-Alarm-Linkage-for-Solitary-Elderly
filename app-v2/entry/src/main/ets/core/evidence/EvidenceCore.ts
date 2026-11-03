/** FALL 证据 JPEG 的纯逻辑合同：资格、校验、取消与账号隔离内存缓存。 */

export const MAX_EVIDENCE_JPEG_BYTES: number = 2 * 1024 * 1024;
export const EVIDENCE_TIMEOUT_MS: number = 15000;
export const MAX_EVIDENCE_CACHE_ENTRIES: number = 6;
export const MAX_EVIDENCE_CACHE_BYTES: number = 12 * 1024 * 1024;

const ALARM_ID_RE: RegExp = /^[A-Za-z0-9._:-]{1,80}$/;

export interface EvidenceAlertLike {
  type: string;
  evidenceAvailable: boolean;
  alarmId: string;
}

export function validEvidenceAlarmId(alarmId: string): boolean {
  return ALARM_ID_RE.test(alarmId);
}

export function canViewFallEvidence(alert: EvidenceAlertLike): boolean {
  return alert.type === 'FALL' && alert.evidenceAvailable && validEvidenceAlarmId(alert.alarmId);
}

export function isJpegContentType(contentType: string): boolean {
  const normalized: string = contentType.split(';')[0].trim().toLowerCase();
  return normalized === 'image/jpeg';
}

export function isBasicJpeg(payload: Uint8Array): boolean {
  if (payload.byteLength < 5) return false;
  const end: number = payload.byteLength - 1;
  return payload[0] === 0xFF && payload[1] === 0xD8 &&
    payload[end - 1] === 0xFF && payload[end] === 0xD9;
}

export function validEvidencePayload(payload: Uint8Array, contentType: string): boolean {
  if (!isJpegContentType(contentType)) return false;
  if (payload.byteLength < 5 || payload.byteLength > MAX_EVIDENCE_JPEG_BYTES) return false;
  return isBasicJpeg(payload);
}

export class EvidenceRequestCancellation {
  private cancelledValue: boolean = false;
  private handlers: Array<() => void> = [];

  isCancelled(): boolean {
    return this.cancelledValue;
  }

  onCancel(handler: () => void): void {
    if (this.cancelledValue) {
      handler();
      return;
    }
    this.handlers.push(handler);
  }

  cancel(): void {
    if (this.cancelledValue) return;
    this.cancelledValue = true;
    const pending: Array<() => void> = this.handlers;
    this.handlers = [];
    for (let i = 0; i < pending.length; i++) {
      try {
        pending[i]();
      } catch (_) {
        // 取消必须是 best-effort，单个适配器失败不能阻断其他取消处理。
      }
    }
  }
}

export class EvidenceImageBytes {
  alarmId: string = '';
  contentType: string = '';
  payload: Uint8Array = new Uint8Array(0);
  fromCache: boolean = false;
}

class EvidenceCacheEntry {
  guardianId: string;
  payload: Uint8Array;

  constructor(guardianId: string, payload: Uint8Array) {
    this.guardianId = guardianId;
    this.payload = payload;
  }
}

/**
 * 仅进程内缓存压缩 JPEG；key 同时包含账号和 alarmId，绝不写 Asset Store/文件/相册。
 * PixelMap 不进入缓存，由页面持有并在离开时释放。
 */
export class EvidenceMemoryCache {
  private entries: Map<string, EvidenceCacheEntry> = new Map<string, EvidenceCacheEntry>();
  private payloadBytes: number = 0;
  private maxEntries: number;
  private maxBytes: number;

  constructor(maxEntries: number = MAX_EVIDENCE_CACHE_ENTRIES,
    maxBytes: number = MAX_EVIDENCE_CACHE_BYTES) {
    this.maxEntries = Math.max(0, Math.floor(maxEntries));
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
  }

  private key(guardianId: string, alarmId: string): string {
    return `${guardianId.length}:${guardianId}|${alarmId}`;
  }

  get(guardianId: string, alarmId: string): Uint8Array | null {
    if (guardianId.length === 0 || !validEvidenceAlarmId(alarmId)) return null;
    const cacheKey: string = this.key(guardianId, alarmId);
    const entry: EvidenceCacheEntry | undefined = this.entries.get(cacheKey);
    if (entry === undefined) return null;
    // Map 的插入顺序就是 LRU 顺序；命中后移到队尾成为最近使用。
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return new Uint8Array(entry.payload);
  }

  put(guardianId: string, alarmId: string, payload: Uint8Array): void {
    if (guardianId.length === 0 || !validEvidenceAlarmId(alarmId)) return;
    if (payload.byteLength < 5 || payload.byteLength > MAX_EVIDENCE_JPEG_BYTES) return;
    if (this.maxEntries === 0 || payload.byteLength > this.maxBytes) return;

    const cacheKey: string = this.key(guardianId, alarmId);
    const existing: EvidenceCacheEntry | undefined = this.entries.get(cacheKey);
    if (existing !== undefined) {
      this.entries.delete(cacheKey);
      this.payloadBytes -= existing.payload.byteLength;
    }

    const ownedPayload: Uint8Array = new Uint8Array(payload);
    while (this.entries.size >= this.maxEntries ||
      this.payloadBytes + ownedPayload.byteLength > this.maxBytes) {
      if (!this.evictLeastRecentlyUsed()) break;
    }
    if (this.entries.size >= this.maxEntries ||
      this.payloadBytes + ownedPayload.byteLength > this.maxBytes) return;

    this.entries.set(cacheKey, new EvidenceCacheEntry(guardianId, ownedPayload));
    this.payloadBytes += ownedPayload.byteLength;
  }

  private evictLeastRecentlyUsed(): boolean {
    const iterator: IterableIterator<string> = this.entries.keys();
    const oldest: IteratorResult<string> = iterator.next();
    if (oldest.done) return false;
    const entry: EvidenceCacheEntry | undefined = this.entries.get(oldest.value);
    if (entry === undefined) return false;
    this.entries.delete(oldest.value);
    this.payloadBytes -= entry.payload.byteLength;
    return true;
  }

  clearGuardian(guardianId: string): void {
    if (guardianId.length === 0) return;
    const keys: string[] = [];
    this.entries.forEach((entry: EvidenceCacheEntry, cacheKey: string): void => {
      if (entry.guardianId === guardianId) keys.push(cacheKey);
    });
    for (let i = 0; i < keys.length; i++) {
      const entry: EvidenceCacheEntry | undefined = this.entries.get(keys[i]);
      if (entry !== undefined) this.payloadBytes -= entry.payload.byteLength;
      this.entries.delete(keys[i]);
    }
  }

  clearAll(): void {
    this.entries.clear();
    this.payloadBytes = 0;
  }

  /** 兼容旧调用；新代码应使用语义明确的 clearAll()。 */
  clear(): void {
    this.clearAll();
  }

  size(): number {
    return this.entries.size;
  }

  totalBytes(): number {
    return this.payloadBytes;
  }
}
