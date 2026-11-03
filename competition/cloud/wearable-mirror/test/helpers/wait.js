'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询等待条件成立；超时抛错并带上 label，避免测试“静默通过”。
 */
async function waitFor(check, options = {}) {
  const timeout = options.timeout === undefined ? 4000 : options.timeout;
  const interval = options.interval === undefined ? 20 : options.interval;
  const label = options.label || 'condition';
  const started = Date.now();
  for (;;) {
    let value;
    try {
      value = await check();
    } catch (err) {
      value = false;
    }
    if (value) return value;
    if (Date.now() - started > timeout) {
      throw new Error(`waitFor timeout (${timeout}ms): ${label}`);
    }
    await sleep(interval);
  }
}

module.exports = Object.freeze({ sleep, waitFor });
