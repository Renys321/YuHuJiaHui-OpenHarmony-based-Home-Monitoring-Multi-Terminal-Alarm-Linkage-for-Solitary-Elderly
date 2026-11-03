'use strict';

/**
 * lib/failover.js — Wi-Fi / 4G 备链切换状态机（纯软件、确定性）
 *
 * 状态：
 *   WIFI_PRIMARY         Wi-Fi 正常，主链路走 Wi-Fi
 *   CELLULAR_CONNECTING  正在尝试建立 4G 备链
 *   CELLULAR_ACTIVE      4G 已承载（Wi-Fi 不可用）
 *   OFFLINE              Wi-Fi 与 4G 都不可用
 *
 * 已实现（纯软件，可单元测试）：
 *   - 失败次数、回退延迟、指数退避（`backoffBaseMs * 2^attempt`，上限 `backoffMaxMs`）；
 *   - 去抖动：Wi-Fi 短暂抖动（短于 `wifiDownDelayMs`）不触发切换；
 *   - 回切迟滞：Wi-Fi 必须连续稳定 `wifiStableMs` 才允许回切；
 *   - 4G 连接结果超时（`cellularAttemptTimeoutMs`）按失败处理；
 *   - 手动 `forceWifi()` / `forceCellular()`（运维与测试用）。
 *
 * 本模块刻意不做的事：
 *   - 不操作真实网络、不调用串口、不读写任何系统配置；
 *   - 不声称“已完成真实 Wi-Fi 到 4G 自动接管”——真实接管尚未在硬件上验证。
 *
 * 时间来源完全由调用方通过 `tick(nowMs)` 与事件参数提供，因此测试完全确定。
 */

const STATES = Object.freeze({
  WIFI_PRIMARY: 'WIFI_PRIMARY',
  CELLULAR_CONNECTING: 'CELLULAR_CONNECTING',
  CELLULAR_ACTIVE: 'CELLULAR_ACTIVE',
  OFFLINE: 'OFFLINE'
});

const ACTIONS = Object.freeze({
  NONE: 'NONE',
  CONNECT_CELLULAR: 'CONNECT_CELLULAR',
  SWITCH_TO_WIFI: 'SWITCH_TO_WIFI',
  DISABLE_CELLULAR: 'DISABLE_CELLULAR'
});

const PATHS = Object.freeze({ WIFI: 'WIFI', CELLULAR: 'CELLULAR', NONE: 'NONE' });

const DEFAULT_FAILOVER_CONFIG = Object.freeze({
  /** Wi-Fi 掉线后等待多久才认为“确实失效”。 */
  wifiDownDelayMs: 3000,
  /** Wi-Fi 恢复后必须连续稳定多久才允许回切。 */
  wifiStableMs: 10000,
  /** 4G 连接尝试结果的最长等待时间。 */
  cellularAttemptTimeoutMs: 20000,
  /** 指数退避基数与上限。 */
  backoffBaseMs: 1000,
  backoffMaxMs: 60000,
  /** 连续失败达到该次数后直接进入 OFFLINE，等 Wi-Fi 恢复再复位。 */
  maxAttemptsBeforeOffline: 5,
  /** 是否允许 4G 备链（false 时退化为纯 Wi-Fi 监测）。 */
  cellularEnabled: true
});

function resolveFailoverConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const pick = (key) => {
    const value = config[key];
    return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_FAILOVER_CONFIG[key];
  };
  const cellularEnabled =
    typeof config.cellularEnabled === 'boolean' ? config.cellularEnabled : DEFAULT_FAILOVER_CONFIG.cellularEnabled;
  return Object.freeze({
    wifiDownDelayMs: pick('wifiDownDelayMs'),
    wifiStableMs: pick('wifiStableMs'),
    cellularAttemptTimeoutMs: pick('cellularAttemptTimeoutMs'),
    backoffBaseMs: Math.max(1, pick('backoffBaseMs')),
    backoffMaxMs: Math.max(pick('backoffBaseMs'), pick('backoffMaxMs')),
    maxAttemptsBeforeOffline: Math.max(1, pick('maxAttemptsBeforeOffline')),
    cellularEnabled
  });
}

/** 指数退避：base * 2^attempt，上限 max。attempt 从 0 开始。 */
function backoffDelay(attempt, config = DEFAULT_FAILOVER_CONFIG) {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
  const base = Math.max(1, config.backoffBaseMs);
  const max = Math.max(base, config.backoffMaxMs);
  const raw = base * Math.pow(2, Math.min(safeAttempt, 30));
  return Math.min(max, Math.max(base, raw));
}

function toMillis(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

class FailoverStateMachine {
  /**
   * @param {object} config 见 DEFAULT_FAILOVER_CONFIG。
   * @param {object} deps 依赖注入：
   *   - actions: { connectCellular, disconnectCellular, switchToWifi } 可选的副作用执行器
   *   - onTransition(event) 或通过 on('transition') 订阅
   *   - onAction(event) 或通过 on('action') 订阅
   */
  constructor(config = {}, deps = {}) {
    this.config = resolveFailoverConfig(config);
    this.actions = deps.actions && typeof deps.actions === 'object' ? deps.actions : {};
    this._listeners = { transition: [], action: [] };
    if (typeof deps.onTransition === 'function') this.on('transition', deps.onTransition);
    if (typeof deps.onAction === 'function') this.on('action', deps.onAction);

    this.state = STATES.WIFI_PRIMARY;
    this.activePath = PATHS.WIFI;
    this.wifiReachable = true;
    this.cellularReachable = null; // null = 未知；true/false = 已知
    this.locked = false;
    this.attempt = 0;
    this.nextAttemptAtMs = null;
    this.attemptStartedAtMs = null;
    this.wifiDownSinceMs = null;
    this.wifiStableSinceMs = null;
    this.lastSwitchAtMs = null;
    this.transitionCount = 0;
  }

  get activePathName() {
    return this.activePath;
  }

  /** 订阅事件：'transition' | 'action'。 */
  on(event, listener) {
    if (this._listeners[event] && typeof listener === 'function') {
      this._listeners[event].push(listener);
    }
    return this;
  }

  off(event, listener) {
    const list = this._listeners[event];
    if (!Array.isArray(list)) return this;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
    return this;
  }

  _emit(event, payload) {
    const list = this._listeners[event];
    if (!Array.isArray(list) || list.length === 0) return;
    for (const listener of [...list]) {
      try {
        listener(payload);
      } catch (_) {
        // 有界：监听器异常不得破坏状态机。
      }
    }
  }

  /** 只读快照，供 JSON 输出与测试断言。 */
  getStatus() {
    return Object.freeze({
      state: this.state,
      activePath: this.activePath,
      wifiReachable: this.wifiReachable,
      cellularReachable: this.cellularReachable,
      locked: this.locked,
      attempt: this.attempt,
      nextAttemptAtMs: this.nextAttemptAtMs,
      transitionCount: this.transitionCount,
      config: this.config
    });
  }

  _setState(next, reason, atMs) {
    if (this.state === next) return false;
    const previous = this.state;
    this.state = next;
    this.transitionCount += 1;
    const event = Object.freeze({
      from: previous,
      to: next,
      reason,
      atMs: toMillis(atMs),
      attempt: this.attempt
    });
    this._emit('transition', event);
    return true;
  }

  _invoke(action, event) {
    this._emit('action', event);
    const handler = this.actions[action];
    if (typeof handler !== 'function') return;
    try {
      handler(event);
    } catch (_) {
      // 有界：执行器异常不得破坏状态机。
    }
  }

  /**
   * 上报 Wi-Fi 可用性变化。
   * 必需参数：`up`（布尔）；可选 `nowMs`。
   */
  reportWifi(up, nowMs = 0) {
    const reachable = up === true;
    const now = toMillis(nowMs);
    if (reachable === this.wifiReachable) {
      // 重复上报不改变时间基准，避免抖动被误当作恢复。
      return this.getStatus();
    }
    this.wifiReachable = reachable;
    if (reachable) {
      this.wifiDownSinceMs = null;
      this.wifiStableSinceMs = this.config.wifiStableMs > 0 ? now : null;
      this._emit('wifi', Object.freeze({ up: true, atMs: now }));
      return this.getStatus();
    }
    this.wifiStableSinceMs = null;
    this.wifiDownSinceMs = now;
    this._emit('wifi', Object.freeze({ up: false, atMs: now }));
    return this.getStatus();
  }

  /**
   * 上报 4G 连接结果（真实或模拟）。
   * @param {boolean} reachable
   * @param {number} nowMs
   */
  reportCellular(reachable, nowMs = 0) {
    const now = toMillis(nowMs);
    const becameReachable = reachable === true;
    this.cellularReachable = becameReachable;
    this.locked = false;

    if (becameReachable) {
      this.attempt = 0;
      this.nextAttemptAtMs = null;
      if (this.state !== STATES.CELLULAR_ACTIVE) {
        this.activePath = PATHS.CELLULAR;
        this.lastSwitchAtMs = now;
        this._setState(STATES.CELLULAR_ACTIVE, 'cellular_connected', now);
      }
      return this.getStatus();
    }

    // 连接失败：累加失败次数，安排指数退避；必要时降级为 OFFLINE。
    this.attempt += 1;
    this.nextAttemptAtMs = now + backoffDelay(this.attempt, this.config);
    const exhausted = this.attempt >= this.config.maxAttemptsBeforeOffline;
    if (exhausted) {
      this.nextAttemptAtMs = null;
      this.activePath = PATHS.NONE;
      this.cellularReachable = false;
      this._setState(STATES.OFFLINE, 'cellular_attempts_exhausted', now);
    } else if (this.state !== STATES.CELLULAR_CONNECTING) {
      this.activePath = PATHS.NONE;
      this._setState(STATES.CELLULAR_CONNECTING, 'cellular_failure_backoff', now);
    }
    return this.getStatus();
  }

  /** 该时刻是否允许发起（或重试）4G 连接。 */
  shouldAttemptCellular(nowMs) {
    if (!this.config.cellularEnabled) return false;
    if (this.state === STATES.OFFLINE) return false;
    if (this.wifiReachable) return false;
    if (this.locked) return false;
    const now = toMillis(nowMs);
    return this.nextAttemptAtMs === null || now >= this.nextAttemptAtMs;
  }

  /**
   * 推进状态机。所有基于时间的判断都使用传入的 `nowMs`。
   * @returns {object} 冻结的状态快照
   */
  tick(nowMs = 0) {
    const now = toMillis(nowMs);

    // 1) Wi-Fi 持续可用且已稳定 -> 回切 Wi-Fi。
    if (this.wifiReachable) {
      this.wifiStableSinceMs = this.wifiStableSinceMs === null ? now : this.wifiStableSinceMs;
      const stableFor = now - this.wifiStableSinceMs;
      if (stableFor >= this.config.wifiStableMs) {
        this._switchToWifi(now, 'wifi_stable');
      }
      return this.getStatus();
    }

    // 2) 4G 尝试结果超时 -> 按失败处理，进入指数退避。
    if (this.locked && this.attemptStartedAtMs !== null) {
      if (now - this.attemptStartedAtMs >= this.config.cellularAttemptTimeoutMs) {
        this.locked = false;
        this.attemptStartedAtMs = null;
        this.reportCellular(false, now);
        return this.getStatus();
      }
    }

    // 3) Wi-Fi 掉线未超过去抖延迟 -> 保持不变（避免抖动导致频繁切换）。
    if (this.wifiDownSinceMs !== null && now - this.wifiDownSinceMs < this.config.wifiDownDelayMs) {
      return this.getStatus();
    }

    if (!this.config.cellularEnabled) {
      // 未启用备链：只报告可观察状态，不发起切换。
      if (this.state !== STATES.OFFLINE) {
        this.activePath = PATHS.NONE;
        this._setState(STATES.OFFLINE, 'cellular_disabled_wifi_down', now);
      }
      return this.getStatus();
    }

    // 4) 需要并允许发起 4G 连接。
    if (this.shouldAttemptCellular(now)) {
      this.locked = true;
      this.attemptStartedAtMs = now;
      // 关键：尝试已经发起，退避截止时间必须清空。否则状态机会同时处于
      // 「已锁定」和「仍在退避」两种矛盾状态，`shouldAttemptCellular` 与
      // 超时判定互相打架，调用方按 nextAttemptAtMs 推进会永远原地打转。
      this.nextAttemptAtMs = null;
      this.activePath = PATHS.NONE;
      const connecting = this.state !== STATES.CELLULAR_CONNECTING;
      if (connecting) this._setState(STATES.CELLULAR_CONNECTING, 'wifi_down_failover', now);
      const event = Object.freeze({
        action: ACTIONS.CONNECT_CELLULAR,
        attempt: this.attempt + 1,
        atMs: now,
        reason: connecting ? 'wifi_down_failover' : 'cellular_retry'
      });
      this._invoke(ACTIONS.CONNECT_CELLULAR, event);
      return this.getStatus();
    }

    return this.getStatus();
  }

  _switchToWifi(now, reason) {
    const wasCellular = this.state === STATES.CELLULAR_ACTIVE || this.state === STATES.CELLULAR_CONNECTING;
    this.attempt = 0;
    this.nextAttemptAtMs = null;
    this.attemptStartedAtMs = null;
    this.locked = false;
    this.wifiStableSinceMs = this.config.wifiStableMs > 0 ? now : null;
    this.activePath = PATHS.WIFI;
    const changed = this._setState(STATES.WIFI_PRIMARY, reason, now);
    if (changed || wasCellular) {
      this._invoke(ACTIONS.SWITCH_TO_WIFI, Object.freeze({ action: ACTIONS.SWITCH_TO_WIFI, atMs: now, reason }));
    }
    return this.getStatus();
  }

  /** 手动强制回到 Wi-Fi 主链路（运维通道）。 */
  forceWifi(nowMs = 0) {
    const now = toMillis(nowMs);
    this.wifiReachable = true;
    this.wifiDownSinceMs = null;
    return this._switchToWifi(now, 'forced_wifi');
  }

  /** 手动强制 4G 承载（运维通道，不改变 Wi-Fi 可达性观测）。 */
  forceCellular(nowMs = 0) {
    const now = toMillis(nowMs);
    this.locked = false;
    this.wifiReachable = false;
    this.wifiStableSinceMs = null;
    this.wifiDownSinceMs = now;
    this.cellularReachable = true;
    this.attempt = 0;
    this.activePath = PATHS.CELLULAR;
    this._setState(STATES.CELLULAR_ACTIVE, 'forced_cellular', now);
    return this.getStatus();
  }

  /** 关闭备链并释放锁定（不触碰真实网络）。 */
  disableCellular(nowMs = 0) {
    const now = toMillis(nowMs);
    this.locked = false;
    this.attemptStartedAtMs = null;
    this._invoke(
      ACTIONS.DISABLE_CELLULAR,
      Object.freeze({ action: ACTIONS.DISABLE_CELLULAR, atMs: now, reason: 'disabled_by_caller' })
    );
    return this.getStatus();
  }
}

module.exports = {
  STATES,
  ACTIONS,
  PATHS,
  DEFAULT_FAILOVER_CONFIG,
  resolveFailoverConfig,
  backoffDelay,
  FailoverStateMachine
};
