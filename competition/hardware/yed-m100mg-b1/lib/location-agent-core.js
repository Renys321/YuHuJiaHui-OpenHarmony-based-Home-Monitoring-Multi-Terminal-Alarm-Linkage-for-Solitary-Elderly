'use strict';

/**
 * lib/location-agent-core.js — YED 定位代理的核心循环（IO 全部注入，可确定性单测）
 *
 * 每一轮：
 *   1) 通过注入的 readDevice() 做一次只读固件查询（真实实现复用 lib/device.js + lib/transport.js）；
 *   2) 用 lib/location-status.js 组装符合现有合同的 status 报文；
 *   3) 通过注入的 publish(topic, payload) 发到本机 MQTT（真实实现复用 bridge/mqtt_tool.js）。
 *
 * 读失败/掉线时不沉默：仍然发布一份 gps.valid=false 的降级报文（避免公网后端沿用旧坐标），
 * 并按有界退避降低重试频率。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  buildStatusPayload,
  buildUnavailablePayload,
  DEFAULT_DEVICE_ID,
  DEFAULT_ROOM
} = require('./location-status');

const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_READ_BACKOFF_MS = Object.freeze([5000, 10000, 30000, 60000]);

function readInt(value, fallback, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

/** 退避序列取值（第 attempt 次失败，从 1 开始），超出长度则封顶。 */
function backoffForAttempt(attempt, readBackoffMs) {
  const list = Array.isArray(readBackoffMs) && readBackoffMs.length > 0
    ? readBackoffMs
    : DEFAULT_READ_BACKOFF_MS;
  const index = Math.min(Math.max(attempt, 1), list.length) - 1;
  return list[index];
}

/**
 * 下一轮等待时长的纯函数决策（便于确定性单测）：
 *   - 读成功 -> 正常轮询间隔；
 *   - 读失败 -> 有界退避（第 consecutiveFailures 次）。
 */
function nextDelayMs(result, stats, options = {}) {
  const intervalMs = readInt(options.intervalMs, DEFAULT_INTERVAL_MS, 1000, 3600000);
  if (result && result.ok === true) return intervalMs;
  const failures = stats && Number.isSafeInteger(stats.consecutiveFailures) ? stats.consecutiveFailures : 1;
  return backoffForAttempt(failures, options.readBackoffMs);
}

/**
 * PID 锁：第二个代理必须被明确拒绝。
 * 说明：Node 的 process.kill(pid, 0) 在 Windows 上只做存活探测（libuv 不会发 CTRL_C_EVENT），
 * 与 Python os.kill(pid, 0) 的语义不同，因此在 Node 里是安全的。
 */
function createInstanceLock(lockPath) {
  const file = path.resolve(lockPath);
  function pidAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error && error.code === 'EPERM';
    }
  }
  return {
    path: file,
    acquire() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        const previous = Number.parseInt(String(fs.readFileSync(file, 'utf8')).trim(), 10);
        if (pidAlive(previous)) {
          throw new Error('another YED location agent is already running (pid ' + previous + ')');
        }
        fs.rmSync(file, { force: true });
      }
      fs.writeFileSync(file, String(process.pid), 'utf8');
    },
    release() {
      try {
        if (fs.existsSync(file) && String(fs.readFileSync(file, 'utf8')).trim() === String(process.pid)) {
          fs.rmSync(file, { force: true });
        }
      } catch (_) {
        /* 释放失败不影响退出 */
      }
    }
  };
}

/**
 * @param {object} deps
 *   - readDevice(): Promise<{ ok:boolean, device?:object, errorCode?:string }>
 *   - publish(topic:string, payload:object): Promise<void>
 *   - now(): number            13 位毫秒
 *   - log(line:string): void
 *   - sleep(ms:number): Promise<void>
 * @param {object} [options]
 */
function createLocationAgent(deps = {}, options = {}) {
  if (!deps || typeof deps.readDevice !== 'function') throw new TypeError('readDevice is required');
  if (typeof deps.publish !== 'function') throw new TypeError('publish is required');
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const intervalMs = readInt(options.intervalMs, DEFAULT_INTERVAL_MS, 1000, 3600000);
  const deviceId = typeof options.deviceId === 'string' && options.deviceId.length > 0
    ? options.deviceId : DEFAULT_DEVICE_ID;
  const room = typeof options.room === 'string' && options.room.length > 0 ? options.room : DEFAULT_ROOM;
  const maxFixAgeMs = options.maxFixAgeMs;
  const readBackoffMs = Array.isArray(options.readBackoffMs) && options.readBackoffMs.length > 0
    ? options.readBackoffMs.slice()
    : DEFAULT_READ_BACKOFF_MS.slice();
  const topic = 'home/' + deviceId + '/status';

  const stats = { polls: 0, published: 0, readFailures: 0, consecutiveFailures: 0, lastError: null };
  let stopped = false;
  let timer = null;
  let wake = null;

  /** 可被 stop() 提前唤醒的 sleep，避免退出时卡在一个长退避里。 */
  function sleepInterruptible(ms) {
    if (deps.sleep) return deps.sleep(ms);
    return new Promise((resolve) => {
      const handle = setTimeout(() => { wake = null; resolve(); }, ms);
      wake = () => { clearTimeout(handle); wake = null; resolve(); };
    });
  }

  /** 一轮：读 → 组装 → 发布。永不抛出。 */
  async function pollOnce() {
    stats.polls += 1;
    const nowMs = now();
    let payload;
    let ok = true;
    let errorCode = null;
    try {
      const result = await deps.readDevice();
      if (result && result.ok === true && result.device) {
        payload = buildStatusPayload(result.device, { nowMs, deviceId, room, maxFixAgeMs });
      } else {
        ok = false;
        errorCode = (result && result.errorCode) || 'READ_FAILED';
        payload = buildUnavailablePayload({ nowMs, deviceId, room });
      }
    } catch (error) {
      ok = false;
      errorCode = (error && error.code) || 'READ_EXCEPTION';
      payload = buildUnavailablePayload({ nowMs, deviceId, room });
    }

    if (ok) {
      stats.consecutiveFailures = 0;
      stats.lastError = null;
    } else {
      stats.readFailures += 1;
      stats.consecutiveFailures += 1;
      stats.lastError = errorCode;
      log('[location-agent] read failed code=' + errorCode + ' -> publishing gps.valid=false');
    }

    try {
      await deps.publish(topic, payload);
      stats.published += 1;
      log('[location-agent] publish topic=' + topic +
        ' gps.valid=' + payload.gps.valid +
        ' fixTime=' + payload.gps.fixTime +
        ' csq=' + payload.csq);
    } catch (error) {
      stats.lastError = (error && error.code) || 'PUBLISH_FAILED';
      log('[location-agent] publish failed code=' + stats.lastError);
    }
    return { ok, errorCode, payload };
  }

  async function runLoop() {
    while (!stopped) {
      const result = await pollOnce();
      if (stopped) break;
      await sleepInterruptible(nextDelayMs(result, stats, { intervalMs, readBackoffMs }));
    }
  }

  return {
    topic,
    stats: () => Object.assign({}, stats),
    pollOnce,
    start() {
      if (timer === null) {
        timer = runLoop();
      }
    },
    async stop() {
      stopped = true;
      if (wake) wake();
      if (timer) {
        await timer;
        timer = null;
      }
    }
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_READ_BACKOFF_MS,
  backoffForAttempt,
  nextDelayMs,
  createInstanceLock,
  createLocationAgent
};
