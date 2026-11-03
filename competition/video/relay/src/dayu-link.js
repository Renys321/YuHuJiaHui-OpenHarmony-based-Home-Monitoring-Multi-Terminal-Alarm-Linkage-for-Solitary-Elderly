'use strict';

/**
 * local 模式的 DAYU 链路：relay 自己 TCP 连 DAYU（默认 127.0.0.1:9301，经 hdc fport）。
 *
 * 契约 §1 控制流：
 *   服务端 -> {"type":"hello",...}\n
 *   客户端 -> {"type":"start","viewer":"<id>"}\n
 *   服务端 -> {"type":"started","proto":1}\n
 *   之后：4 字节大端长度 + JPEG
 *   客户端 -> {"type":"stop"}\n（或直接断开）
 *
 * 事件：
 *   'up'    DAYU 已进入取帧状态（收到 started）
 *   'down'  链路断开（仅在仍想取帧时触发，用于 relay 的宽限/重连状态机）
 *   'frame' 一帧 JPEG（Buffer）
 */

const net = require('net');
const { EventEmitter } = require('events');
const { createFrameParser, isJpeg } = require('./frames');

const STARTED_RE = /^\{"type":"started"/;

class DayuLink extends EventEmitter {
  constructor(options = {}) {
    super();
    this.mode = 'local';
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 9301;
    this.logger = options.logger || null;
    this.connectTimeoutMs = options.connectTimeoutMs || 2000;
    this.helloTimeoutMs = options.helloTimeoutMs || 2000;
    this.reconnectDelaysMs = Array.isArray(options.reconnectDelaysMs) && options.reconnectDelaysMs.length
      ? options.reconnectDelaysMs
      : [500, 1000, 2000, 5000, 10000];

    this._state = 'down';
    this._wantActive = false;
    this._socket = null;
    this._started = false;
    this._stopping = false;
    this._viewer = '';
    this._lineBuffer = Buffer.alloc(0);
    this._connectTimer = null;
    this._helloTimer = null;
    this._reconnectTimer = null;
    this._stopTimer = null;
    this._reconnectIndex = 0;
    this._lastError = null;
    this._framesSeen = 0;

    this._parser = createFrameParser(
      (frame) => this._onFrame(frame),
      (error) => {
        this._log('warn', 'dayu frame parser reset', { reason: error.message });
        // 帧边界损坏不崩溃：丢弃坏帧继续（服务端会在下一次正常帧重新对齐）。
      }
    );
  }

  get status() {
    return this._state;
  }

  /** local 模式没有 agent 概念；保留接口与 AgentChannel 对齐。 */
  hasAgent() {
    return false;
  }

  _log(level, message, fields) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](message, fields);
  }

  /** 有 viewer 时调用；幂等。 */
  start(viewerId) {
    if (viewerId) this._viewer = viewerId;
    this._wantActive = true;
    if (this._state === 'down' && !this._socket) this._connect();
  }

  /** 无 viewer（空闲停止）或主动结束：向 DAYU 发 stop 并断开 TCP。 */
  stop() {
    this._wantActive = false;
    this._clearReconnect();
    this._stopping = true;
    if (!this._socket) {
      this._state = 'down';
      return;
    }
    if (this._started && this._socket.writable) {
      try {
        this._socket.write('{"type":"stop"}\n');
      } catch (_) {
        // 忽略：下面仍会强制断开。
      }
      // 契约允许 500ms 内停止；等不到 stopped 行就直接断开。
      this._stopTimer = setTimeout(() => this._teardown(), 500);
      if (typeof this._stopTimer.unref === 'function') this._stopTimer.unref();
    } else {
      // 还没 started，直接断开即等于 stop（服务端 close 即停止取帧）。
      this._teardown();
    }
  }

  /** relay 关闭时调用，不等待握手。 */
  close() {
    this._wantActive = false;
    this._clearReconnect();
    this._teardown();
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._stopTimer) {
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
    }
  }

  _connect() {
    if (this._socket || !this._wantActive) return;
    this._state = 'connecting';
    this._started = false;
    this._stopping = false;
    this._lineBuffer = Buffer.alloc(0);
    this._parser.reset();
    this._log('info', 'dayu connecting', { host: this.host, port: this.port, attempt: this._reconnectIndex + 1 });

    const socket = net.connect({ host: this.host, port: this.port });
    this._socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);

    this._connectTimer = setTimeout(() => {
      this._onLinkFailure('connect timeout');
    }, this.connectTimeoutMs);

    socket.on('connect', () => {
      if (this._socket !== socket) return;
      this._clearTimer('_connectTimer');
      this._helloTimer = setTimeout(() => this._onLinkFailure('hello timeout'), this.helloTimeoutMs);
    });
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (error) => {
      this._lastError = error;
    });
    socket.on('close', () => {
      if (this._socket !== socket) return;
      this._onLinkFailure(this._lastError ? this._lastError.message : 'socket closed');
    });
  }

  _clearTimer(name) {
    if (this[name]) {
      clearTimeout(this[name]);
      this[name] = null;
    }
  }

  _onData(chunk) {
    if (!this._socket) return;
    if (this._stopping) {
      // stop 后等服务端回 {"type":"stopped"}，此时不应再有二进制帧。
      this._lineBuffer = Buffer.concat([this._lineBuffer, chunk]);
      if (this._lineBuffer.includes(0x0a)) {
        this._clearTimer('_stopTimer');
        this._teardown();
      }
      return;
    }
    if (this._started) {
      this._parser.push(chunk);
      return;
    }
    this._lineBuffer = Buffer.concat([this._lineBuffer, chunk]);
    let newline;
    while (!this._started && (newline = this._lineBuffer.indexOf(0x0a)) >= 0) {
      const line = this._lineBuffer.subarray(0, newline).toString('utf8').trim();
      this._lineBuffer = this._lineBuffer.subarray(newline + 1);
      if (line) this._handleControlLine(line);
    }
    if (this._started && this._lineBuffer.length > 0) {
      const rest = this._lineBuffer;
      this._lineBuffer = Buffer.alloc(0);
      this._parser.push(rest);
    }
  }

  _handleControlLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      this._log('warn', 'dayu non-json control line ignored');
      return;
    }
    switch (message.type) {
      case 'hello': {
        this._clearTimer('_helloTimer');
        this._log('info', 'dayu hello', {
          proto: message.proto,
          device: message.device,
          camera: message.camera,
          cameraActive: message.cameraActive
        });
        if (message.cameraActive === false) this._log('warn', 'dayu reports camera inactive');
        this._sendLine({ type: 'start', viewer: this._viewer || 'viewer' });
        this._helloTimer = setTimeout(() => this._onLinkFailure('started timeout'), this.helloTimeoutMs);
        break;
      }
      case 'started': {
        this._clearTimer('_helloTimer');
        this._started = true;
        this._state = 'connected';
        this._reconnectIndex = 0;
        this._log('info', 'dayu streaming', { device: message.device || '' });
        this.emit('up');
        break;
      }
      case 'busy': {
        this._onLinkFailure('dayu busy (another client holds the camera)');
        break;
      }
      case 'error': {
        this._log('warn', 'dayu control error', { code: message.code || '' });
        break;
      }
      case 'stopped': {
        // started 之前收到（异常路径上）按正常关闭处理。
        this._teardown();
        break;
      }
      default:
        this._log('debug', 'dayu control line', { type: message.type || 'unknown' });
    }
  }

  _sendLine(object) {
    if (!this._socket || !this._socket.writable) return;
    try {
      this._socket.write(`${JSON.stringify(object)}\n`);
    } catch (_) {
      // 写失败由 close 事件统一处理。
    }
  }

  _onFrame(frame) {
    if (!isJpeg(frame)) {
      this._log('warn', 'dayu frame rejected (not JPEG)', { bytes: frame.length });
      return;
    }
    this._framesSeen += 1;
    this.emit('frame', frame);
  }

  /** 链路失败：teardown 后在仍想取帧时通知 hub 并退避重连。 */
  _onLinkFailure(reason) {
    if (!this._socket) return;
    const wasConnected = this._state === 'connected';
    this._teardown();
    const message = typeof reason === 'string' ? reason : (reason && reason.message) || 'unknown';
    this._lastError = null;
    if (wasConnected) this._log('warn', 'dayu link lost', { reason: message });
    else this._log('warn', 'dayu link not established', { reason: message });
    if (!this._wantActive) return;
    this.emit('down', { reason: message });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._wantActive) return;
    const delay = this.reconnectDelaysMs[Math.min(this._reconnectIndex, this.reconnectDelaysMs.length - 1)];
    this._reconnectIndex += 1;
    this._log('info', 'dayu reconnect scheduled', { inMs: delay, attempt: this._reconnectIndex });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._wantActive) this._connect();
    }, delay);
    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  /** 清理 socket/解析状态，返回是否曾处于 connected（由调用方决定日志）。 */
  _teardown() {
    this._clearTimer('_connectTimer');
    this._clearTimer('_helloTimer');
    this._clearTimer('_stopTimer');
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
    }
    this._parser.reset();
    this._lineBuffer = Buffer.alloc(0);
    this._started = false;
    this._stopping = false;
    this._state = 'down';
    return true;
  }
}

module.exports = { DayuLink, STARTED_RE };
