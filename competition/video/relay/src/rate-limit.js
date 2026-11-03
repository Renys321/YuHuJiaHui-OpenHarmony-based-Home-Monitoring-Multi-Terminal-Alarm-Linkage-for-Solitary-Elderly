'use strict';

/**
 * 极简滑动窗口限流：契约 §2.2 要求 /video/session 超频返回 429。
 *
 * key 用 token 的 sha256（不落 token 原文），窗口内超过 limit 次即拒绝。
 * maxKeys 防止任意 token 撑爆内存（超出时淘汰最早写入的 key）。
 */
function createRateLimiter(options = {}) {
  const limit = options.limit || 10;
  const windowMs = options.windowMs || 60000;
  const clock = options.clock || Date.now;
  const maxKeys = options.maxKeys || 1000;
  const hits = new Map(); // key -> number[] 时间戳

  function pruneKey(key, now, timestamps) {
    const keep = [];
    for (const ts of timestamps) {
      if (now - ts < windowMs) keep.push(ts);
    }
    if (keep.length === 0) hits.delete(key);
    else hits.set(key, keep);
    return keep;
  }

  return {
    /** 返回 true 表示允许本次请求。 */
    check(key) {
      const now = clock();
      const existing = hits.get(key) || [];
      const timestamps = pruneKey(key, now, existing);
      if (timestamps.length >= limit) return false;
      timestamps.push(now);
      hits.set(key, timestamps);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next();
        if (oldest.done) break;
        hits.delete(oldest.value);
      }
      return true;
    },
    reset() {
      hits.clear();
    },
    get size() {
      return hits.size;
    }
  };
}

module.exports = { createRateLimiter };
