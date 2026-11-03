/**
 * 会话隔离与请求提交控制（纯逻辑，可被 Node 行为测试直接使用）。
 *
 * 目的：请求发起时捕获所属会话；响应返回后，在任何数据提交/副作用之前确认仍属当前会话。
 * 旧会话（登出、切换账号、会话失效后）的迟到响应不得写页面、不得改网络状态、不得清掉新会话。
 */
import { SessionCore } from './SessionCore';

export class SessionTicket {
  version: number = -1;
  token: string = '';
  guardianId: string = '';
}

export class RequestGuard {
  private session: SessionCore;

  constructor(session: SessionCore) {
    this.session = session;
  }

  currentVersion(): number {
    return this.session.generationId();
  }

  /** 在请求发起前调用；之后所有提交都必须用这个 ticket 校验。 */
  capture(): SessionTicket {
    const ticket = new SessionTicket();
    ticket.version = this.session.generationId();
    ticket.token = this.session.token();
    ticket.guardianId = this.session.guardianId();
    return ticket;
  }

  /**
   * 当前会话是否仍是 ticket 所属会话：
   * 版本相同 + token 相同非空 + 未过期。任一不满足都视为过期响应。
   */
  isCurrent(ticket: SessionTicket, nowMs: number): boolean {
    if (ticket.version !== this.session.generationId()) return false;
    if (ticket.token.length === 0) return false;
    if (this.session.token() !== ticket.token) return false;
    return this.session.isActive(nowMs);
  }

  /** 只有当前会话的 401/403 才允许清除会话；旧会话的 401 必须忽略。 */
  shouldInvalidate(ticket: SessionTicket, nowMs: number): boolean {
    return this.isCurrent(ticket, nowMs);
  }
}

/** 提交保护：校验通过才执行数据写入/副作用；返回是否真正提交。 */
export class SessionCommit {
  private guard: RequestGuard;

  constructor(guard: RequestGuard) {
    this.guard = guard;
  }

  commitIfCurrent(ticket: SessionTicket, nowMs: number, action: () => void): boolean {
    if (!this.guard.isCurrent(ticket, nowMs)) {
      return false;
    }
    action();
    return true;
  }
}
