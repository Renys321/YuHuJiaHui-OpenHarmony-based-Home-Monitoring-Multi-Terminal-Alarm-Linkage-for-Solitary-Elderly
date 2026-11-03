'use strict';

/**
 * transport.js — 状态行的两条注入通道（零依赖）。
 *
 *   RelayTransport  —— PC 连 127.0.0.1:9001（hdc fport → DAYU homemon），
 *                      每行写成 `relay <单行JSON>\n`，homemon 原样广播给板上 APP。
 *   TcpStatusServer —— PC 监听 127.0.0.1:9002，配合 `hdc rport tcp:9002 tcp:9002`
 *                      让设备侧 APP 直连（APP 的候选端口本来就含 9002）。
 *                      作为 relay 通道被其它组件限流/未就绪时的可用 fallback。
 *
 * 两条通道都遵守：
 *   - 断线自动重连（relay 侧指数退避 1s→10s）；
 *   - 重连/新客户端接入时补发**当前**状态一次（不重放历史，不重复告警）；
 *   - 通道上收到的任何命令（APP 的 route/ack 等）一律忽略并只记日志，
 *     镜像绝不代替设备 ACK —— 随身事件只能由设备真实回执闭环。
 */

const net = require('node:net');

const RELAY_RECONNECT_MIN_MS = 1000;
const RELAY_RECONNECT_MAX_MS = 10000;
const MAX_TCP_CLIENTS = 8;

class RelayTransport {
  constructor(options = {}) {
    this.host = String(options.host || '127.0.0.1');
    this.port = options.port === undefined ? 9001 : Number(options.port);
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.socket = null;
    this.connected = false;
    this.stopped = false;
    this.lastLine = '';
    this.reconnectTimer = null;
    this.attempts = 0;
    this.stats = { connects: 0, disconnects: 0, linesSent: 0, lastSentAt: 0, lastError: '', lastConnectedAt: 0 };
  }

  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  connect() {
    if (this.stopped) return;
    const socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.connected = true;
      this.attempts = 0;
      this.stats.connects += 1;
      this.stats.lastConnectedAt = Date.now();
      this.log(`[relay] connected ${this.host}:${this.port}`);
      if (this.lastLine !== '') this.writeLine(this.lastLine);
      this.onStatus(this.status());
    });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
    socket.on('data', (chunk) => {
      /* homemon 会把板上状态和其他 relay 行广播回来；镜像只写不读，读到什么都忽略。 */
      if (this.logLevelDebug()) this.log(`[relay] rx ignored ${chunk.length}B`);
    });
    socket.on('error', (err) => {
      this.stats.lastError = err.code || err.message;
      this.connected = false;
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
      this.stats.disconnects += 1;
      this.log(`[relay] disconnected ${this.host}:${this.port}, reconnect in backoff`);
      this.onStatus(this.status());
      this.scheduleReconnect();
    });
  }

  logLevelDebug() {
    return false;
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(RELAY_RECONNECT_MAX_MS, RELAY_RECONNECT_MIN_MS * Math.pow(2, this.attempts));
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  writeLine(line) {
    if (!this.socket || !this.connected || this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(`relay ${line}\n`);
      this.stats.linesSent += 1;
      this.stats.lastSentAt = Date.now();
      return true;
    } catch (err) {
      this.stats.lastError = err.code || err.message;
      return false;
    }
  }

  /** 保存并尝试发送一行状态；未连接时保存，连上后自动补发一次 */
  sendLine(line) {
    this.lastLine = line;
    return this.writeLine(line);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket) socket.destroy();
  }

  status() {
    return {
      kind: 'relay',
      target: `${this.host}:${this.port}`,
      connected: this.connected,
      linesSent: this.stats.linesSent,
      lastSentAt: this.stats.lastSentAt,
      lastConnectedAt: this.stats.lastConnectedAt,
      connects: this.stats.connects,
      disconnects: this.stats.disconnects,
      lastError: this.stats.lastError
    };
  }
}

class TcpStatusServer {
  constructor(options = {}) {
    this.host = String(options.host || '127.0.0.1');
    this.port = options.port === undefined ? 9002 : Number(options.port);
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
    this.server = null;
    this.clients = new Set();
    this.lastLine = '';
    this.stopped = false;
    this.stats = { accepts: 0, rejects: 0, linesSent: 0, lastSentAt: 0, lastError: '' };
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onClient(socket));
      this.server = server;
      server.on('error', (err) => {
        this.stats.lastError = err.code || err.message;
        this.log(`[tcp] server error ${err.code || err.message}`);
        reject(err);
      });
      server.listen(this.port, this.host, () => {
        this.log(`[tcp] listening ${this.host}:${this.port}`);
        resolve(this);
      });
    });
  }

  onClient(socket) {
    if (this.clients.size >= MAX_TCP_CLIENTS) {
      this.stats.rejects += 1;
      this.log('[tcp] reject client: too many');
      socket.destroy();
      return;
    }
    this.clients.add(socket);
    this.stats.accepts += 1;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
    this.log(`[tcp] client connected (${this.clients.size})`);
    if (this.lastLine !== '') this.writeTo(socket, this.lastLine);
    socket.on('data', (chunk) => {
      /* APP 若对“随身求助”下 ACK，会在这条连接上下发 route/ack；
         镜像绝不代设备确认，也不改变状态，只记录后丢弃。 */
      const text = chunk.toString('utf8').replace(/\r/g, '');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed !== '') this.log(`[tcp] ignored inbound command: ${trimmed.slice(0, 120)}`);
      }
    });
    socket.on('error', () => { /* 忽略，close 会清理 */ });
    socket.on('close', () => {
      this.clients.delete(socket);
      this.log(`[tcp] client disconnected (${this.clients.size})`);
    });
  }

  writeTo(socket, line) {
    if (!socket || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(`${line}\n`);
      this.stats.linesSent += 1;
      this.stats.lastSentAt = Date.now();
      return true;
    } catch (err) {
      this.stats.lastError = err.code || err.message;
      return false;
    }
  }

  broadcast(line) {
    this.lastLine = line;
    for (const socket of this.clients) this.writeTo(socket, line);
  }

  stop() {
    this.stopped = true;
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      try { server.close(); } catch (err) { /* ignore */ }
    }
  }

  status() {
    return {
      kind: 'tcp',
      target: `${this.host}:${this.port}`,
      listening: this.server !== null && !this.stopped,
      clients: this.clients.size,
      accepts: this.stats.accepts,
      rejects: this.stats.rejects,
      linesSent: this.stats.linesSent,
      lastSentAt: this.stats.lastSentAt,
      lastError: this.stats.lastError
    };
  }
}

module.exports = Object.freeze({ RelayTransport, TcpStatusServer, RELAY_RECONNECT_MIN_MS, RELAY_RECONNECT_MAX_MS });
