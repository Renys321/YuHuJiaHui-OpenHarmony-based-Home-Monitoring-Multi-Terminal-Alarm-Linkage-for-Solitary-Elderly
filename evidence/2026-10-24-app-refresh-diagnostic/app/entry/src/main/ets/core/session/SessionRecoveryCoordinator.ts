/**
 * 会话恢复编排（纯逻辑，可测）。
 *
 * 解决的问题：安全存储的 save / clear 虽已串行，但 restore 的 load 在队列外执行，
 * 会出现“401→清除排队未完成→restore 读到旧 Token→旧会话被写回内存”的竞争。
 *
 * 顺序保证：
 * 1. load / save / clear 全部进入同一个 SerialQueue，restore 的 load 排在已排队的 clear 之后；
 * 2. restore 在排队开始时、读取完成后、提交到内存会话前都校验生命周期 epoch；
 * 3. 401/登出通过 invalidate() 立即标记失效并递增 epoch，旧 restore 不得再写会话；
 * 4. 过期记录的清理只在“仍是同一 epoch 且未失效”时于当前串行回合内执行，
 *    不会删除后续成功登录 B 已保存/将要保存的记录；
 * 5. 存储异常被吞掉并转为失败/空结果，队列继续可用，不产生未处理的 Promise 拒绝。
 */
import { SerialQueue } from './SerialQueue';

/** 与平台 TokenVault 解耦的安全存储条目。 */
export class SecureSession {
  token: string = '';
  guardianId: string = '';
  expiresAt: number = 0;
}

/** 平台安全存储端口（生产实现包装 TokenVault/AssetStore）。 */
export interface SecureSessionVault {
  load(): Promise<SecureSession | null>;
  save(session: SecureSession): Promise<boolean>;
  clear(): Promise<void>;
}

/** 会话生命周期：epoch 每次登录尝试/登录完成/失效都会递增；invalidated 只由成功登录清除。 */
export class SessionLifecycleState {
  private epoch: number = 0;
  private invalidated: boolean = false;
  private loginInProgress: boolean = false;

  epochId(): number {
    return this.epoch;
  }

  isInvalidated(): boolean {
    return this.invalidated;
  }

  isLoginInProgress(): boolean {
    return this.loginInProgress;
  }

  /** 登录尝试开始：让旧 restore/旧登录结果失效，但保留 invalidated 直到登录成功。 */
  markLoginStart(): number {
    this.epoch += 1;
    this.loginInProgress = true;
    return this.epoch;
  }

  /** 登录尝试失败/取消：恢复“当前没有登录进行中”，但不把已失效状态改成可恢复。 */
  markLoginAbandoned(attemptEpoch: number): void {
    if (this.epoch === attemptEpoch) {
      this.loginInProgress = false;
    }
  }

  /** 登录成功提交：新一轮有效会话。 */
  markLoginCommitted(): void {
    this.epoch += 1;
    this.invalidated = false;
    this.loginInProgress = false;
  }

  /** 401/403/登出：内存会话必须立即失效；restore 在用户重新登录前一律不再恢复。 */
  markInvalidated(): void {
    this.epoch += 1;
    this.invalidated = true;
    this.loginInProgress = false;
  }

  isAttemptCurrent(attemptEpoch: number): boolean {
    return this.loginInProgress && this.epoch === attemptEpoch;
  }
}

export class RestoreTicket {
  /** 'restored' | 'none' | 'expired' | 'blocked' | 'stale' | 'error' */
  kind: string = 'none';
  epoch: number = -1;
  session: SecureSession | null = null;
}

/** 与 SessionCore 一致：必须严格大于当前时间 + 30s 安全余量，且 expiresAt 为有限正数。 */
export function isSessionExpiryUsable(expiresAt: number, nowMs: number): boolean {
  if (typeof expiresAt !== 'number' || !isFinite(expiresAt) || expiresAt <= 0) {
    return false;
  }
  if (typeof nowMs !== 'number' || !isFinite(nowMs)) {
    return false;
  }
  return expiresAt > nowMs + 30 * 1000;
}

export class SessionRecoveryCoordinator {
  private vault: SecureSessionVault;
  private queue: SerialQueue;
  readonly lifecycle: SessionLifecycleState;

  constructor(vault: SecureSessionVault, queue: SerialQueue = new SerialQueue(),
    lifecycle: SessionLifecycleState = new SessionLifecycleState()) {
    this.vault = vault;
    this.queue = queue;
    this.lifecycle = lifecycle;
  }

  /** 登录尝试开始：返回本次尝试的 epoch。 */
  beginLoginAttempt(): number {
    return this.lifecycle.markLoginStart();
  }

  /** 登录失败/取消：允许后续 restore 逻辑不被“登录进行中”永久阻塞。 */
  endLoginAttempt(attemptEpoch: number): void {
    this.lifecycle.markLoginAbandoned(attemptEpoch);
  }

  /** 登录成功提交时调用（在任何旧 restore 提交之前完成 epoch 递增）。 */
  markLoginCommitted(): void {
    this.lifecycle.markLoginCommitted();
  }

  /** 401/退出登录：内存会话立即失效；安全存储清除入同一串行队列。 */
  invalidate(): void {
    this.lifecycle.markInvalidated();
  }

  /** 排队清除安全存储；异常被吞掉，队列继续。 */
  clearSecure(): Promise<void> {
    return this.queue.enqueue(async (): Promise<void> => {
      try {
        await this.vault.clear();
      } catch (error) {
        // 存储不可用：保持仅内存策略，队列继续。
      }
    });
  }

  /**
   * 登录保存（remember=false 则清除）。返回是否成功写入安全存储。
   * 排队执行，且执行时 epoch 已变化/已失效则不写入。
   */
  saveForLogin(session: SecureSession, attemptEpoch: number, remember: boolean): Promise<boolean> {
    return this.queue.enqueue(async (): Promise<boolean> => {
      if (!this.lifecycle.isAttemptCurrent(attemptEpoch)) {
        return false;
      }
      try {
        if (remember) {
          return await this.vault.save(session);
        }
        await this.vault.clear();
        return false;
      } catch (error) {
        return false;
      }
    });
  }

  /**
   * 恢复：load 与 save/clear 同队列，因此一定排在已排队的清除之后。
   * 返回 ticket 供调用方在应用前再做一次生命周期校验。
   */
  restore(nowMs: number, isSessionActive: () => boolean): Promise<RestoreTicket> {
    return this.queue.enqueue(async (): Promise<RestoreTicket> => {
      const ticket = new RestoreTicket();
      // 已经失效/登出，或正在登录：不得读回旧会话。
      if (this.lifecycle.isInvalidated() || this.lifecycle.isLoginInProgress()) {
        ticket.kind = 'blocked';
        return ticket;
      }
      ticket.epoch = this.lifecycle.epochId();
      if (isSessionActive()) {
        ticket.kind = 'none';
        return ticket;
      }
      let stored: SecureSession | null = null;
      try {
        stored = await this.vault.load();
      } catch (error) {
        ticket.kind = 'error';
        return ticket;
      }
      // 读取期间可能发生：新登录开始/成功、401、登出。过期结果一律丢弃。
      if (this.lifecycle.epochId() !== ticket.epoch || this.lifecycle.isInvalidated() ||
        this.lifecycle.isLoginInProgress()) {
        ticket.kind = 'stale';
        return ticket;
      }
      if (isSessionActive()) {
        ticket.kind = 'none';
        return ticket;
      }
      if (stored === null || stored.token.length === 0) {
        ticket.kind = 'none';
        return ticket;
      }
      if (!isSessionExpiryUsable(stored.expiresAt, nowMs)) {
        // 过期/无效记录清理：仅在同一 epoch 且未失效/未在登录时执行（当前串行回合内，B 的 save 不会交错）。
        if (this.lifecycle.epochId() === ticket.epoch && !this.lifecycle.isInvalidated() &&
          !this.lifecycle.isLoginInProgress()) {
          try {
            await this.vault.clear();
          } catch (error) {
            // 清理失败不阻塞队列；下次 restore 或登录会再次处理。
          }
        }
        ticket.kind = 'expired';
        return ticket;
      }
      ticket.kind = 'restored';
      ticket.session = stored;
      return ticket;
    });
  }

  /**
   * 应用恢复结果前再次确认：epoch 未变、未失效、当前没有已建立的会话。
   * 通过后才执行 apply（写内存会话与 AppStorage）。
   */
  commitRestore(ticket: RestoreTicket, nowMs: number, isSessionActive: () => boolean,
    apply: (session: SecureSession) => void): boolean {
    if (ticket.kind !== 'restored' || ticket.session === null) {
      return false;
    }
    // 提交时必须用“当前时间”重新验证：排队/读取可能已耗时，调用时的 now 已过时。
    if (!isSessionExpiryUsable(ticket.session.expiresAt, nowMs)) {
      return false;
    }
    if (ticket.epoch !== this.lifecycle.epochId()) {
      return false;
    }
    if (this.lifecycle.isInvalidated() || this.lifecycle.isLoginInProgress()) {
      return false;
    }
    if (isSessionActive()) {
      return false;
    }
    apply(ticket.session);
    return true;
  }

  /** 登录响应返回后使用：日期/epoch 未变才允许继续提交会话。 */
  isAttemptCurrent(attemptEpoch: number): boolean {
    return this.lifecycle.isAttemptCurrent(attemptEpoch);
  }
}
