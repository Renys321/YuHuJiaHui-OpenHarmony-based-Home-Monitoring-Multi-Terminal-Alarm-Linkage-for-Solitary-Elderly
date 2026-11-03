/**
 * 会话状态机（纯逻辑）：token 仅在内存，落盘由平台安全存储适配器负责。
 * 不记录/打印 token。
 */

export class SessionSnapshot {
  token: string = '';
  guardianId: string = '';
  expiresAt: number = 0;
  storageMode: string = 'memory';
}

export class SessionCore {
  /** token 到期前提前视为过期的安全余量（毫秒） */
  private static readonly SKEW_MS: number = 30 * 1000;

  private current: SessionSnapshot | null = null;
  /** 会话代际：set/clear 都会递增，用于丢弃旧会话的迟到响应。 */
  private generation: number = 0;

  generationId(): number {
    return this.generation;
  }

  /** expiresInSeconds 来自服务端；无效值按 0 处理（立即过期）。 */
  set(token: string, guardianId: string, expiresInSeconds: number, nowMs: number,
    storageMode: string = 'memory'): void {
    this.generation += 1;
    const snapshot = new SessionSnapshot();
    snapshot.token = token;
    snapshot.guardianId = guardianId;
    const ttlMs: number = isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? Math.floor(expiresInSeconds) * 1000 : 0;
    snapshot.expiresAt = nowMs + ttlMs;
    snapshot.storageMode = storageMode;
    this.current = snapshot;
  }

  /** 从绝对有效期恢复（保留原始 expiresAt，避免秒级截断把刚过 30s 余量的会话变成无效）。 */
  setWithExpiry(token: string, guardianId: string, expiresAt: number, nowMs: number,
    storageMode: string = 'memory'): void {
    this.generation += 1;
    if (!isFinite(expiresAt) || expiresAt <= 0) {
      this.current = null;
      return;
    }
    const snapshot = new SessionSnapshot();
    snapshot.token = token;
    snapshot.guardianId = guardianId;
    snapshot.expiresAt = expiresAt;
    snapshot.storageMode = storageMode;
    this.current = snapshot;
  }

  get(): SessionSnapshot | null {
    return this.current;
  }

  token(): string {
    return this.current !== null ? this.current.token : '';
  }

  guardianId(): string {
    return this.current !== null ? this.current.guardianId : '';
  }

  storageMode(): string {
    return this.current !== null ? this.current.storageMode : 'memory';
  }

  isActive(nowMs: number): boolean {
    if (this.current === null) return false;
    if (this.current.token.length === 0) return false;
    if (!isFinite(this.current.expiresAt) || this.current.expiresAt <= 0) return false;
    return this.current.expiresAt > nowMs + SessionCore.SKEW_MS;
  }

  /** 收到 401/403 或主动登出时调用。 */
  clear(): void {
    this.generation += 1;
    this.current = null;
  }
}
