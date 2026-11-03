'use strict';

/**
 * FrameHub：两种模式共用的帧分发/会话状态机（契约 §2.2）。
 *
 * 职责：
 *   - 维护 viewer 集合与单次 ticket 关联的会话（用 sha256(token) 作 sessionKey）；
 *   - 首个 viewer 到达 -> 启动帧源（local 直连 / agent start 指令）；
 *   - 最后一个 viewer 离开 -> VIDEO_IDLE_STOP_MS 后没有新 viewer 就停止帧源（隐私要求）；
 *   - DAYU 链路断开 -> 保留 viewer、暂停画面，重连成功发 resumed；
 *     超过 VIDEO_DAYU_DOWN_GRACE_MS 仍未恢复 -> 发 error DAYU_DOWN 并 1011 关闭；
 *   - 帧广播、心跳、fps/健康指标、慢客户端丢帧保护。
 */

class FrameHub {
  constructor(options = {}) {
    this.config = options.config;
    this.logger = options.logger || null;
    this.clock = options.clock || Date.now;
    this.source = null;
    this.viewers = new Map(); // id -> viewer
    this.viewerSeq = 0;
    this.framesReceived = 0;
    this.lastFrameAt = 0;
    this._frameTimes = [];
    this._idleTimer = null;
    this._graceTimer = null;
    this._heartbeatTimer = null;
    this._pendingResume = false;
    this._closed = false;
  }

  _log(level, message, fields) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](message, fields);
  }

  attachSource(source) {
    this.source = source;
    source.on('frame', (frame) => this._onFrame(frame));
    source.on('up', () => this._onSourceUp());
    source.on('down', (info) => this._onSourceDown(info));
    return this;
  }

  get mode() {
    return this.source ? this.source.mode : this.config.mode;
  }

  get viewerCount() {
    return this.viewers.size;
  }

  /** 契约 §2.2 healthz 字段。 */
  health() {
    const now = this.clock();
    const cutoff = now - 2000;
    this._frameTimes = this._frameTimes.filter((ts) => ts >= cutoff);
    const fps = this._frameTimes.length === 0 ? 0 : Number((this._frameTimes.length / 2).toFixed(1));
    return {
      ok: true,
      mode: this.mode,
      dayuLink: this.source ? this.source.status : 'down',
      framesReceived: this.framesReceived,
      fps,
      lastFrameAgeMs: this.lastFrameAt ? Math.max(0, now - this.lastFrameAt) : -1,
      viewers: this.viewers.size
    };
  }

  /**
   * 在 WS 升级成功后加入观看。返回 { ok:false, reason:'busy' } 表示超出并发上限
   * （由调用方发 BUSY 并以 1013 关闭）。
   */
  addViewer(ws, sessionKey) {
    if (this._closed) return { ok: false, reason: 'closed' };
    if (this.viewers.size >= this.config.maxViewers) {
      this._log('warn', 'viewer rejected: concurrency limit', {
        viewers: this.viewers.size,
        maxViewers: this.config.maxViewers
      });
      return { ok: false, reason: 'busy' };
    }
    this._clearTimer('_idleTimer');
    this.viewerSeq += 1;
    const id = `v${this.viewerSeq}`;
    const viewer = { id, ws, sessionKey, framesSent: 0, dropped: 0, joinedAt: this.clock() };
    this.viewers.set(id, viewer);
    this._log('info', 'viewer joined', { viewer: id, viewers: this.viewers.size, mode: this.mode });

    this._sendText(viewer, { type: 'ready', proto: 1, camera: '640x480' });
    if (this.mode === 'agent' && this.source && !this.source.hasAgent()) {
      this._sendText(viewer, { type: 'error', code: 'NO_AGENT' });
    }
    this._ensureHeartbeat();
    if (this.source) this.source.start(id);
    return { ok: true, id };
  }

  removeViewer(id) {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    this.viewers.delete(id);
    this._log('info', 'viewer left', {
      viewer: id,
      viewers: this.viewers.size,
      framesSent: viewer.framesSent,
      dropped: viewer.dropped
    });
    if (this.viewers.size > 0) return;
    this._clearTimer('_heartbeatTimer');
    this._clearTimer('_graceTimer');
    this._pendingResume = false;
    if (this._closed) return;
    // 空闲停止：默认 3s 内没有新 viewer 就停止取帧/推流（契约“用户离开页面后停止采集”）。
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.viewers.size !== 0 || this._closed) return;
      this._log('info', 'idle stop: no viewers', { idleStopMs: this.config.idleStopMs });
      if (this.source) this.source.stop();
    }, this.config.idleStopMs);
    if (typeof this._idleTimer.unref === 'function') this._idleTimer.unref();
    this._log('debug', 'idle stop scheduled', { inMs: this.config.idleStopMs });
  }

  /** 主动结束某 token 的观看（POST /video/session/end）。返回关闭的 viewer 数。 */
  endSession(sessionKey) {
    let closed = 0;
    for (const viewer of [...this.viewers.values()]) {
      if (viewer.sessionKey !== sessionKey) continue;
      closed += 1;
      try {
        viewer.ws.close(1000, 'session-ended');
      } catch (_) {
        // close 事件会走到 removeViewer。
      }
    }
    if (closed > 0) this._log('info', 'session ended by request', { viewers: closed });
    return closed;
  }

  _onFrame(frame) {
    this.framesReceived += 1;
    const now = this.clock();
    this.lastFrameAt = now;
    this._frameTimes.push(now);
    const cutoff = now - 2000;
    if (this._frameTimes.length > 400) {
      this._frameTimes = this._frameTimes.filter((ts) => ts >= cutoff);
    }
    for (const viewer of this.viewers.values()) {
      const ws = viewer.ws;
      if (!ws || ws.readyState !== 1) continue;
      // 手机端解码慢时丢帧，不让 relay 内存被 bufferedAmount 拖爆。
      if (ws.bufferedAmount > 2 * 1024 * 1024) {
        viewer.dropped += 1;
        continue;
      }
      try {
        ws.send(frame, { binary: true });
        viewer.framesSent += 1;
        if (viewer.framesSent === 1) {
          // 联调指标：WS handshake 后首帧延迟（契约要求 1s 内出第一帧）。
          this._log('info', 'viewer first frame', {
            viewer: viewer.id,
            firstFrameAfterMs: Math.max(0, now - viewer.joinedAt)
          });
        }
      } catch (_) {
        viewer.dropped += 1;
      }
    }
  }

  _onSourceUp() {
    this._clearTimer('_graceTimer');
    if (this._closed) return;
    if (this._pendingResume && this.viewers.size > 0) {
      this._pendingResume = false;
      this._log('info', 'dayu recovered, notifying viewers', { viewers: this.viewers.size });
      for (const viewer of this.viewers.values()) this._sendText(viewer, { type: 'resumed' });
    } else {
      this._log('info', 'frame source up', { viewers: this.viewers.size });
    }
  }

  _onSourceDown(info) {
    if (this._closed) return;
    const reason = info && info.reason ? info.reason : 'link down';
    if (this.viewers.size === 0) {
      this._log('info', 'frame source down (no viewers)', { reason });
      return;
    }
    if (this._graceTimer) return;
    this._pendingResume = true;
    this._log('warn', 'frame source down, keeping viewers', {
      reason,
      viewers: this.viewers.size,
      graceMs: this.config.dayuDownGraceMs
    });
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      if (this._closed || this.viewers.size === 0) return;
      this._log('warn', 'dayu did not recover within grace, closing viewers', { graceMs: this.config.dayuDownGraceMs });
      for (const viewer of [...this.viewers.values()]) {
        this._sendText(viewer, { type: 'error', code: 'DAYU_DOWN' });
        try {
          viewer.ws.close(1011, 'dayu down');
        } catch (_) {
          // removeViewer 由 close 事件触发。
        }
      }
    }, this.config.dayuDownGraceMs);
    if (typeof this._graceTimer.unref === 'function') this._graceTimer.unref();
  }

  _ensureHeartbeat() {
    if (this._heartbeatTimer || this.config.heartbeatMs <= 0) return;
    this._heartbeatTimer = setInterval(() => {
      if (this.viewers.size === 0) return;
      const health = this.health();
      for (const viewer of this.viewers.values()) {
        this._sendText(viewer, { type: 'heartbeat', ts: this.clock(), fps: health.fps });
      }
    }, this.config.heartbeatMs);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  _sendText(viewer, object) {
    const ws = viewer.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(object));
      return true;
    } catch (_) {
      return false;
    }
  }

  _clearTimer(name) {
    if (this[name]) {
      clearTimeout(this[name]);
      clearInterval(this[name]);
      this[name] = null;
    }
  }

  close() {
    this._closed = true;
    this._clearTimer('_idleTimer');
    this._clearTimer('_graceTimer');
    this._clearTimer('_heartbeatTimer');
    for (const viewer of this.viewers.values()) {
      try {
        viewer.ws.close(1001, 'relay shutdown');
      } catch (_) {
        // ignore
      }
    }
    this.viewers.clear();
    if (this.source) this.source.close();
  }
}

module.exports = { FrameHub };
