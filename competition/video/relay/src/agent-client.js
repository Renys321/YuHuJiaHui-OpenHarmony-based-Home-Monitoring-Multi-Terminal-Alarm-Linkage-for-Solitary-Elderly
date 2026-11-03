'use strict';

/**
 * PC 侧常驻 agent（契约 §2.1 agent 模式）。
 *
 * 数据流：
 *   DAYU200 TCP(127.0.0.1:9301，经 hdc fport) <- agent -> 出站 WSS(relay /video/agent)
 *
 * 关键约束：
 *   - agent 只在 relay 发来 start 时才开始连 DAYU 取帧；收到 stop / relay 断线立即停止
 *     （绝不自己一直取帧）；
 *   - 断线自动重连 relay（0.5/1/2/5/10s 退避）与 DAYU（同样的退避，仅在仍需要帧时）；
 *   - 日志不出现 agent key / relay URL 的 query。
 */

const net = require('net');
const { EventEmitter } = require('events');
const WebSocket = require('./ws');
const { createFrameParser, isJpeg } = require('./frames');

function normalizeRelayUrl(raw, key) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('--relay must be an absolute ws(s):// or http(s):// URL');
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('--relay must use ws://, wss://, http:// or https://');
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/video/agent';
  else if (url.pathname === '/video') url.pathname = '/video/agent';
  if (!/^[A-Za-z0-9._~+/=-]{1,512}$/.test(key)) {
    throw new Error('agent key must be 1..512 chars of [A-Za-z0-9._~+/=-]');
  }
  url.searchParams.set('key', key);
  return url.toString();
}

class AgentClient extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.key) throw new Error('agent key is required');
    this.logger = options.logger || null;
    this.key = options.key;
    this.relayUrl = normalizeRelayUrl(options.relayUrl || 'wss://127.0.0.1:9443/video/agent', options.key);
    this.dayuHost = options.dayuHost || '127.0.0.1';
    this.dayuPort = options.dayuPort || 9301;
    this.connectTimeoutMs = options.connectTimeoutMs || 2000;
    this.helloTimeoutMs = options.helloTimeoutMs || 2000;
    this.relayReconnectDelaysMs = options.reconnectDelaysMs || [500, 1000, 2000, 5000, 10000];
    this.dayuReconnectDelaysMs = this.relayReconnectDelaysMs;

    this._ws = null;
    this._wsReady = false;
    this._relayRetryIndex = 0;
    this._relayTimer = null;
    this._relayStopped = false;

    this._dayuSocket = null;
    this._dayuStarted = false;
    this._dayuStopping = false;
    this._dayuStatus = 'down';
    this._dayuRetryIndex = 0;
    this._dayuTimer = null;
    this._dayuStopTimer = null;
    this._dayuLineBuffer = Buffer.alloc(0);
    this._lastDayuError = null;
    this._wantFrames = false;
    this._stopped = false;

    this._parser = createFrameParser(
      (frame) => this._onDayuFrame(frame),
      (error) => this._log('warn', 'dayu frame parser reset', { reason: error.message })
    );
  }

  _log(level, message, fields) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](message, fields);
  }

  sanitizedRelayUrl() {
    const url = new URL(this.relayUrl);
    url.search = '';
    return url.toString();
  }

  start() {
    this._stopped = false;
    this._relayStopped = false;
    this._connectRelay();
  }

  async stop() {
    this._stopped = true;
    this._relayStopped = true;
    this._wantFrames = false;
    this._clearRelayTimer();
    this._clearDayuTimer();
    this._stopDayu();
    const ws = this._ws;
    this._ws = null;
    this._wsReady = false;
    if (ws) {
      try {
        ws.close(1000, 'agent shutdown');
      } catch (_) {
        // ignore
      }
    }
  }

  _clearRelayTimer() {
    if (this._relayTimer) {
      clearTimeout(this._relayTimer);
      this._relayTimer = null;
    }
  }

  _clearDayuTimer() {
    if (this._dayuTimer) {
      clearTimeout(this._dayuTimer);
      this._dayuTimer = null;
    }
    if (this._dayuStopTimer) {
      clearTimeout(this._dayuStopTimer);
      this._dayuStopTimer = null;
    }
  }

  _connectRelay() {
    if (this._stopped || this._ws) return;
    this._log('info', 'relay connecting', { relay: this.sanitizedRelayUrl() });
    const ws = new WebSocket(this.relayUrl, { handshakeTimeout: 10000, perMessageDeflate: false });
    this._ws = ws;
    ws.on('open', () => {
      if (this._ws !== ws) return;
      this._wsReady = true;
      this._relayRetryIndex = 0;
      this._log('info', 'relay connected');
      this._sendJson({ type: 'hello', proto: 1, device: 'dayu200-living', camera: '640x480' });
    });
    ws.on('message', (data, isBinary) => {
      if (this._ws !== ws || isBinary) return;
      this._onRelayText(String(data));
    });
    ws.on('close', () => {
      if (this._ws !== ws) return;
      this._ws = null;
      this._wsReady = false;
      // relay 断开 -> 立刻停止取帧，等重连后由 relay 重新下发 start。
      this._wantFrames = false;
      this._stopDayu();
      this._scheduleRelayReconnect();
    });
    ws.on('error', (error) => this._log('warn', 'relay socket error', { reason: error.message }));
  }

  _scheduleRelayReconnect() {
    if (this._relayStopped || this._relayTimer) return;
    const delay = this.relayReconnectDelaysMs[Math.min(this._relayRetryIndex, this.relayReconnectDelaysMs.length - 1)];
    this._relayRetryIndex += 1;
    this._log('warn', 'relay disconnected, reconnect scheduled', { inMs: delay, attempt: this._relayRetryIndex });
    this._relayTimer = setTimeout(() => {
      this._relayTimer = null;
      this._connectRelay();
    }, delay);
    if (typeof this._relayTimer.unref === 'function') this._relayTimer.unref();
  }

  _sendJson(object) {
    if (!this._ws || this._ws.readyState !== 1) return false;
    try {
      this._ws.send(JSON.stringify(object));
      return true;
    } catch (_) {
      return false;
    }
  }

  _onRelayText(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      this._log('warn', 'relay non-json message ignored');
      return;
    }
    switch (message.type) {
      case 'agent-ready':
        this._log('info', 'registered with relay', { proto: message.proto });
        return;
      case 'start':
        this._log('info', 'relay requested start', { viewer: message.viewer || '' });
        this._wantFrames = true;
        this._ensureDayu();
        return;
      case 'stop':
        this._log('info', 'relay requested stop');
        this._wantFrames = false;
        this._stopDayu();
        return;
      case 'ping':
        return;
      default:
        this._log('debug', 'relay message ignored', { type: message.type || 'unknown' });
    }
  }

  _ensureDayu() {
    if (!this._wantFrames || this._dayuSocket || this._dayuTimer) return;
    this._connectDayu();
  }

  _connectDayu() {
    if (!this._wantFrames || this._dayuSocket || this._stopped) return;
    this._dayuStatus = 'connecting';
    this._sendStatus();
    this._dayuStarted = false;
    this._dayuStopping = false;
    this._dayuLineBuffer = Buffer.alloc(0);
    this._parser.reset();
    this._log('info', 'dayu connecting', { host: this.dayuHost, port: this.dayuPort });

    const socket = net.connect({ host: this.dayuHost, port: this.dayuPort });
    this._dayuSocket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    const connectTimer = setTimeout(() => this._onDayuFailure('connect timeout'), this.connectTimeoutMs);
    this._dayuConnectTimer = connectTimer;

    socket.on('connect', () => {
      if (this._dayuSocket !== socket) return;
      clearTimeout(connectTimer);
      if (this._dayuConnectTimer === connectTimer) this._dayuConnectTimer = null;
      this._dayuHelloTimer = setTimeout(() => this._onDayuFailure('hello timeout'), this.helloTimeoutMs);
    });
    socket.on('data', (chunk) => this._onDayuData(chunk));
    socket.on('error', (error) => {
      this._lastDayuError = error;
    });
    socket.on('close', () => {
      clearTimeout(connectTimer);
      if (this._dayuSocket !== socket) return;
      this._onDayuFailure(this._lastDayuError ? this._lastDayuError.message : 'socket closed');
    });
  }

  _onDayuData(chunk) {
    if (!this._dayuSocket) return;
    if (this._dayuStopping) return;
    if (this._dayuStarted) {
      this._parser.push(chunk);
      return;
    }
    this._dayuLineBuffer = Buffer.concat([this._dayuLineBuffer, chunk]);
    let newline;
    while (!this._dayuStarted && (newline = this._dayuLineBuffer.indexOf(0x0a)) >= 0) {
      const line = this._dayuLineBuffer.subarray(0, newline).toString('utf8').trim();
      this._dayuLineBuffer = this._dayuLineBuffer.subarray(newline + 1);
      if (line) this._onDayuControlLine(line);
    }
    if (this._dayuStarted && this._dayuLineBuffer.length > 0) {
      const rest = this._dayuLineBuffer;
      this._dayuLineBuffer = Buffer.alloc(0);
      this._parser.push(rest);
    }
  }

  _onDayuControlLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      this._log('warn', 'dayu non-json control line ignored');
      return;
    }
    switch (message.type) {
      case 'hello': {
        if (this._dayuHelloTimer) {
          clearTimeout(this._dayuHelloTimer);
          this._dayuHelloTimer = null;
        }
        this._log('info', 'dayu hello', { proto: message.proto, camera: message.camera });
        this._writeDayu({ type: 'start', viewer: 'relay-agent' });
        this._dayuHelloTimer = setTimeout(() => this._onDayuFailure('started timeout'), this.helloTimeoutMs);
        return;
      }
      case 'started': {
        if (this._dayuHelloTimer) {
          clearTimeout(this._dayuHelloTimer);
          this._dayuHelloTimer = null;
        }
        this._dayuStarted = true;
        this._dayuStatus = 'connected';
        this._dayuRetryIndex = 0;
        this._sendStatus();
        this._log('info', 'dayu streaming');
        this.emit('dayu-up');
        return;
      }
      case 'busy':
        this._onDayuFailure('dayu busy');
        return;
      case 'stopped':
        this._teardownDayu();
        return;
      case 'error':
        this._log('warn', 'dayu control error', { code: message.code || '' });
        return;
      default:
        this._log('debug', 'dayu control line', { type: message.type || 'unknown' });
    }
  }

  _writeDayu(object) {
    if (!this._dayuSocket || !this._dayuSocket.writable) return;
    try {
      this._dayuSocket.write(`${JSON.stringify(object)}\n`);
    } catch (_) {
      // close 统一处理。
    }
  }

  _onDayuFrame(frame) {
    if (!isJpeg(frame)) {
      this._log('warn', 'dayu frame rejected (not JPEG)', { bytes: frame.length });
      return;
    }
    if (!this._ws || this._ws.readyState !== 1) return;
    try {
      this._ws.send(frame, { binary: true });
    } catch (error) {
      this._log('warn', 'frame send failed', { reason: error.message });
    }
  }

  _sendStatus() {
    this._sendJson({ type: 'status', dayuLink: this._dayuStatus });
  }

  _onDayuFailure(reason) {
    if (!this._dayuSocket) return;
    const wasStarted = this._dayuStarted;
    this._teardownDayu();
    this._dayuStatus = 'down';
    this._sendStatus();
    this._lastDayuError = null;
    if (wasStarted) this._log('warn', 'dayu link lost', { reason });
    else this._log('warn', 'dayu link not established', { reason });
    if (!this._wantFrames) return;
    this._scheduleDayuReconnect();
  }

  _scheduleDayuReconnect() {
    if (this._dayuTimer || !this._wantFrames) return;
    const delay = this.dayuReconnectDelaysMs[Math.min(this._dayuRetryIndex, this.dayuReconnectDelaysMs.length - 1)];
    this._dayuRetryIndex += 1;
    this._log('info', 'dayu reconnect scheduled', { inMs: delay, attempt: this._dayuRetryIndex });
    this._dayuTimer = setTimeout(() => {
      this._dayuTimer = null;
      this._connectDayu();
    }, delay);
    if (typeof this._dayuTimer.unref === 'function') this._dayuTimer.unref();
  }

  _teardownDayu() {
    if (this._dayuConnectTimer) {
      clearTimeout(this._dayuConnectTimer);
      this._dayuConnectTimer = null;
    }
    if (this._dayuHelloTimer) {
      clearTimeout(this._dayuHelloTimer);
      this._dayuHelloTimer = null;
    }
    if (this._dayuStopTimer) {
      clearTimeout(this._dayuStopTimer);
      this._dayuStopTimer = null;
    }
    const socket = this._dayuSocket;
    this._dayuSocket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
    }
    this._parser.reset();
    this._dayuLineBuffer = Buffer.alloc(0);
    this._dayuStarted = false;
    this._dayuStopping = false;
  }

  _stopDayu() {
    this._clearDayuTimer();
    if (!this._dayuSocket) {
      this._dayuStatus = 'down';
      this._sendStatus();
      return;
    }
    if (this._dayuStarted && this._dayuSocket.writable) {
      this._dayuStopping = true;
      try {
        this._dayuSocket.write('{"type":"stop"}\n');
      } catch (_) {
        // 下面仍会断开。
      }
      this._dayuStopTimer = setTimeout(() => {
        this._dayuStatus = 'down';
        this._sendStatus();
        this._teardownDayu();
        // relay 在 agent 重连后可能马上又下发了 start（viewer 还在）：
        // 停流收尾完成后要立刻重新建立 DAYU 链路，而不是等外部再推一次。
        if (this._wantFrames) this._ensureDayu();
      }, 300);
      if (typeof this._dayuStopTimer.unref === 'function') this._dayuStopTimer.unref();
    } else {
      this._dayuStatus = 'down';
      this._sendStatus();
      this._teardownDayu();
    }
  }
}

module.exports = { AgentClient, normalizeRelayUrl };
