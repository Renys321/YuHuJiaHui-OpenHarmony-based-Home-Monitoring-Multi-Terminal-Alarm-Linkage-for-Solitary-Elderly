/**
 * 恢复流程的服务编排（纯逻辑，可被 Node 行为测试与 GuardianService 共同使用）。
 *
 * - 复用 SessionRecoveryCoordinator 的串行 load/save/clear 与生命周期 epoch；
 * - 在 commitRestore 时使用“当前时间”重新校验 expiresAt（排队/读取耗时后，调用时的 now 已过时）；
 * - 拒绝时绝不调用 applyRestored/syncSessionState；
 * - 返回 true 当且仅当：本次恢复被应用，或已有其他有效会话（例如期间 B 已成功登录）。
 */
import {
  SecureSession, SessionRecoveryCoordinator
} from './SessionRecoveryCoordinator';

/** 内存会话与 AppStorage 状态端口（生产实现由 GuardianService 提供）。 */
export interface MemorySessionPort {
  isActive(nowMs: number): boolean;
  /** 用安全存储中的绝对 expiresAt 恢复内存会话（不得用 Math.max(1, ...) 兜底过期记录）。 */
  applyRestored(token: string, guardianId: string, expiresAt: number, nowMs: number): void;
  syncSessionState(): void;
}

export class SessionRestorer {
  private coordinator: SessionRecoveryCoordinator;
  private memory: MemorySessionPort;
  private now: () => number;

  constructor(coordinator: SessionRecoveryCoordinator, memory: MemorySessionPort,
    now: () => number = (): number => Date.now()) {
    this.coordinator = coordinator;
    this.memory = memory;
    this.now = now;
  }

  async restore(): Promise<boolean> {
    const startNow: number = this.now();
    if (this.memory.isActive(startNow)) {
      this.memory.syncSessionState();
      return true;
    }
    const ticket = await this.coordinator.restore(startNow, (): boolean => {
      return this.memory.isActive(this.now());
    });
    const commitNow: number = this.now();
    const applied: boolean = this.coordinator.commitRestore(ticket, commitNow,
      (): boolean => this.memory.isActive(this.now()),
      (session: SecureSession): void => {
        this.memory.applyRestored(session.token, session.guardianId, session.expiresAt, this.now());
        this.memory.syncSessionState();
      });
    if (applied) {
      return true;
    }
    // 恢复失败/过期/失效：若期间已有 B 的有效会话，则以 B 的真实状态返回 true。
    return this.memory.isActive(this.now());
  }
}
