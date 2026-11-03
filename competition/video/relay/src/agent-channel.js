'use strict';

/**
 * agent 模式：relay 侧接受 PC agent 的**出站** WSS 注册并转发帧。
 *
 * 内部协议（relay <-> agent，写在 README；不是给手机 APP 的）：
 *   agent -> relay  文本 {"type":"hello","proto":1,"device":"dayu200-living","camera":"640x480"}
 *   relay -> agent  文本 {"type":"agent-ready","proto":1}
 *   relay -> agent  文本 {"type":"start","viewer":"<viewerId>"}  // 有 viewer 时
 *   relay -> agent  文本 {"type":"stop"}                          // 空闲停止
 *   agent -> relay  文本 {"type":"status","dayuLink":"connected|connecting|down"}
 *   agent -> relay  二进制消息 = 一帧完整 JPEG（WS 帧本身就是消息边界）
 *
 * 事件与 DayuLink 对齐：'up'（agent 报告 DAYU 已连接）、'down'、'frame'。
 */

const { EventEmitter } = require('events');
const { isJpeg } = require('./frames');

function normalizeDayuStatus(value) {
  if (value === 'connected') return 'connected';
  if (value === 'connecting') return 'connecting';
  return 'down';
}

class AgentChannel extends EventEmitter {
  constructor(options = {}) {
    super();
    this.mode = 'agent';
    this.logger = options.logger || null;
    this._ws = null;
    this._ready = false;
    this._agentDayu = 'down';
    this._wantActive = false;
    this._viewer = '';
    this._device = '';
    this._camera = '';
    this._framesSeen = 0;
  }

  get status() {
    if (!this._ws || !this._ready) return 'down';
    if (this._agentDayu === 'connected') return 'connected';
    if (this._agentDayu === 'down') return 'down';
    return 'connecting';
  }

  hasAgent() {
    return Boolean(this._ws && this._ready);
  }

  _log(level, message, fields) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](message, fields);
  }

  /** 由 relay 在 key 校验通过、WS 升级完成后调用。 */
  attach(ws) {
    if (this._ws && this._ws !== ws) {
      const previous = this._ws;
      this._detach(previous, 'replaced');
      try {
        previous.close(1013, 'replaced');
      } catch (_) {
        // 旧连接已失效。
      }
    }
    this._ws = ws;
    this._ready = false;
    this._agentDayu = 'down';
    this._device = '';
    this._camera = '';

    ws.on('message', (data, isBinary) => {
      if (this._ws !== ws) return;
      if (isBinary) {
        if (!this._ready) return;
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!isJpeg(frame)) {
          this._log('warn', 'agent frame rejected (not JPEG)', { bytes: frame.length });
          return;
        }
        this._framesSeen += 1;
        this.emit('frame', frame);
        return;
      }
      this._onText(data, ws);
    });
    ws.on('close', () => {
      if (this._ws !== ws) return;
      this._detach(ws, 'connection closed');
    });
    ws.on('error', () => {
      // close 事件会统一处理；这里避免未捕获 error。
    });
    this._log('info', 'agent channel attached');
  }

  _detach(ws, reason) {
    if (this._ws !== ws) return;
    this._ws = null;
    this._ready = false;
    const wasConnected = this._agentDayu === 'connected';
    this._agentDayu = 'down';
    this._log('warn', 'agent disconnected', { reason });
    this.emit('down', { reason });
    if (!wasConnected) this._log('debug', 'agent was not streaming when it left');
  }

  _onText(data, ws) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch (_) {
      this._log('warn', 'agent non-json message ignored');
      return;
    }
    if (message.type === 'hello') {
      if (message.proto !== 1) {
        this._log('warn', 'agent hello with unsupported proto', { proto: message.proto });
        try {
          ws.close(1002, 'unsupported proto');
        } catch (_) {
          // ignore
        }
        return;
      }
      this._ready = true;
      this._device = typeof message.device === 'string' ? message.device : '';
      this._camera = typeof message.camera === 'string' ? message.camera : '';
      this._log('info', 'agent registered', { device: this._device, camera: this._camera });
      this._send({ type: 'agent-ready', proto: 1 });
      if (this._wantActive) this._sendStart();
      return;
    }
    if (message.type === 'status') {
      const previous = this._agentDayu;
      this._agentDayu = normalizeDayuStatus(message.dayuLink);
      if (this._agentDayu !== previous) {
        this._log('info', 'agent dayu status', { dayuLink: this._agentDayu, previous });
        if (this._agentDayu === 'connected') this.emit('up');
        else if (previous === 'connected') this.emit('down', { reason: `dayu ${this._agentDayu}` });
      }
      if (this._agentDayu === 'connected' && this._wantActive) this._sendStart();
      return;
    }
    if (message.type === 'error') {
      this._log('warn', 'agent reported error', { code: message.code || '' });
      return;
    }
    this._log('debug', 'agent message ignored', { type: message.type || 'unknown' });
  }

  _send(object) {
    if (!this._ws || this._ws.readyState !== 1) return false;
    try {
      this._ws.send(JSON.stringify(object));
      return true;
    } catch (_) {
      return false;
    }
  }

  _sendStart() {
    return this._send({ type: 'start', viewer: this._viewer || 'viewer' });
  }

  start(viewerId) {
    if (viewerId) this._viewer = viewerId;
    this._wantActive = true;
    if (this._ready) this._sendStart();
  }

  stop() {
    this._wantActive = false;
    if (this._ready) this._send({ type: 'stop' });
  }

  close() {
    this._wantActive = false;
    const ws = this._ws;
    this._ws = null;
    this._ready = false;
    this._agentDayu = 'down';
    if (ws) {
      try {
        ws.close(1000, 'relay shutdown');
      } catch (_) {
        // ignore
      }
    }
  }
}

module.exports = { AgentChannel, normalizeDayuStatus };
