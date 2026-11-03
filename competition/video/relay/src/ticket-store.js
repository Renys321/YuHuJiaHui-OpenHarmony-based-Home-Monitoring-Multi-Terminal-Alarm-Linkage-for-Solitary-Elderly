'use strict';

/**
 * 一次性观看 ticket（契约 §2.2）：
 *   - 64 位 hex（crypto.randomBytes(32)），不是 token、不含 token 信息；
 *   - TTL 默认 60s（VIDEO_TICKET_TTL_MS），过期不可用；
 *   - 一次性：consume 后立即从表中删除，重放返回 null；
 *   - 只保存 token 的 sha256（sessionKey），ticket 被拿到也无法反推 APP token。
 */

const crypto = require('crypto');

class TicketStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || 60000;
    this.clock = options.clock || Date.now;
    this.maxTickets = options.maxTickets || 1000;
    this.tickets = new Map(); // ticket -> { sessionKey, expiresAt }
    this.pruneTimer = null;
    if (options.autoPrune !== false) {
      const interval = Math.max(5000, Math.min(this.ttlMs, 30000));
      this.pruneTimer = setInterval(() => this.prune(), interval);
      if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
    }
  }

  issue(sessionKey) {
    this.prune();
    // 表满时淘汰最早过期的记录；正常情况下 60s TTL + 低频 session 不会触发。
    while (this.tickets.size >= this.maxTickets) {
      const oldest = this.tickets.keys().next();
      if (oldest.done) break;
      this.tickets.delete(oldest.value);
    }
    const ticket = crypto.randomBytes(32).toString('hex');
    this.tickets.set(ticket, {
      sessionKey,
      expiresAt: this.clock() + this.ttlMs,
      issuedAt: this.clock()
    });
    return ticket;
  }

  /** 校验并消费；成功返回 { sessionKey }，失败返回 null。 */
  consume(ticket) {
    if (typeof ticket !== 'string' || !/^[0-9a-f]{64}$/.test(ticket)) return null;
    const record = this.tickets.get(ticket);
    if (!record) return null;
    this.tickets.delete(ticket);
    if (record.expiresAt <= this.clock()) return null;
    return { sessionKey: record.sessionKey };
  }

  /** 结束会话时吊销该 token 尚未使用的 ticket。 */
  revokeForSession(sessionKey) {
    let removed = 0;
    for (const [ticket, record] of this.tickets) {
      if (record.sessionKey === sessionKey) {
        this.tickets.delete(ticket);
        removed += 1;
      }
    }
    return removed;
  }

  prune() {
    const now = this.clock();
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(ticket);
    }
  }

  size() {
    return this.tickets.size;
  }

  close() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    this.tickets.clear();
  }
}

module.exports = { TicketStore };
