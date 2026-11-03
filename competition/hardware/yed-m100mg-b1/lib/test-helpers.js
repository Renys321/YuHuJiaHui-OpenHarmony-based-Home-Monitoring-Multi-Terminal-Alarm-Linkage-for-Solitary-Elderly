'use strict';

/**
 * lib/test-helpers.js — 测试专用工具（不含生产逻辑）
 *
 * createFakeTimers() 提供确定性的 setTimeout/clearTimeout，用于验证：
 *   - 命令超时与重试；
 *   - 静默窗口收尾；
 *   - 指数退避重连；
 *   - 主动关闭后不再存在任何定时器。
 */

/** 创建假定时器。返回 { setTimeout, clearTimeout, advance, pendingCount, pending }。 */
function createFakeTimers() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();

  function setTimeoutImpl(callback, delay = 0) {
    sequence += 1;
    const id = sequence;
    const normalized = Number.isFinite(delay) && delay > 0 ? delay : 0;
    timers.set(id, { id, due: now + normalized, callback, order: sequence });
    return id;
  }

  function clearTimeoutImpl(id) {
    timers.delete(id);
  }

  /** 推进虚拟时间并执行到期回调（按到期时间、创建顺序）。 */
  function advance(ms) {
    const target = now + (Number.isFinite(ms) && ms > 0 ? ms : 0);
    let guard = 0;
    for (;;) {
      if (guard > 10000) throw new Error('fake timer loop did not settle');
      guard += 1;
      const due = [...timers.values()]
        .filter((timer) => timer.due <= target)
        .sort((left, right) => (left.due - right.due) || (left.order - right.order));
      if (due.length === 0) break;
      const timer = due[0];
      timers.delete(timer.id);
      now = Math.max(now, timer.due);
      timer.callback();
    }
    now = target;
    return now;
  }

  /** 只运行当前已到期的回调，不推进时间。 */
  function runDue() {
    return advance(0);
  }

  return {
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    advance,
    runDue,
    now: () => now,
    pendingCount: () => timers.size,
    pending: () => [...timers.values()].map((timer) => ({ id: timer.id, due: timer.due }))
  };
}

module.exports = { createFakeTimers };
