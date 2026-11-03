'use strict';

/**
 * mqtt-client.js — 零依赖的最小 MQTT 3.1.1 客户端（只做镜像服务需要的事）：
 *   CONNECT(username/password, clean session) / SUBSCRIBE(qos0) / 收 PUBLISH(qos0/1) /
 *   PINGREQ 保活 / 断线自动重连（鉴权拒绝不重连，交给上层决定 fallback）。
 *
 * 安全约束：
 *   - 绝不在日志里输出用户名/密码；clientId / host / topic 可以出现。
 *   - 解析失败、超长包、非法 topic 一律断开重连，不静默吞掉成“假数据”。
 */

const net = require('node:net');

const CONNECT_TIMEOUT_MS = 10000;
const MAX_PACKET_BYTES = 256 * 1024;

const CONNACK_MEANING = Object.freeze({
  1: 'unacceptable protocol version',
  2: 'identifier rejected',
  3: 'server unavailable',
  4: 'bad user name or password',
  5: 'not authorized (client id not in broker whitelist)'
});

function encodeLength(n) {
  const out = [];
  let value = n;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    out.push(byte);
  } while (value > 0);
  return Buffer.from(out);
}

function encodeString(text) {
  const body = Buffer.from(String(text), 'utf8');
  if (body.length > 65535) throw new Error('mqtt field too long');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function encodePacket(type, flags, payload) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(payload.length), payload]);
}

function readLength(buffer, offset) {
  let value = 0;
  let multiplier = 1;
  let index = offset;
  for (;;) {
    if (index >= buffer.length) return null;
    const byte = buffer[index];
    value += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    index += 1;
    if ((byte & 0x80) === 0) break;
    if (index - offset > 4) return null;
  }
  if (value > MAX_PACKET_BYTES) return null;
  return { value, next: index };
}

class MqttClient {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} options.port
   * @param {string} options.clientId
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {string[]} [options.topics] 连接成功后要订阅的 topic（qos0）
   * @param {(topic:string,payload:string)=>void} [options.onMessage]
   * @param {(info:object)=>void} [options.onConnect]
   * @param {(code:number,text:string)=>void} [options.onAuthRejected]
   * @param {(err:Error)=>void} [options.onError]
   * @param {(info:object)=>void} [options.onDisconnect]
   * @param {(line:string)=>void} [options.log]
   */
  constructor(options) {
    if (!options || typeof options !== 'object') throw new TypeError('options required');
    this.host = String(options.host || '');
    this.port = Number(options.port);
    this.clientId = String(options.clientId || '');
    this.username = typeof options.username === 'string' ? options.username : '';
    this.password = typeof options.password === 'string' ? options.password : '';
    this.topics = Array.isArray(options.topics) ? options.topics.slice() : [];
    this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
    this.onConnect = typeof options.onConnect === 'function' ? options.onConnect : () => {};
    this.onAuthRejected = typeof options.onAuthRejected === 'function' ? options.onAuthRejected : () => {};
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.onDisconnect = typeof options.onDisconnect === 'function' ? options.onDisconnect : () => {};
    this.log = typeof options.log === 'function' ? options.log : () => {};

    this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs) ? options.connectTimeoutMs : CONNECT_TIMEOUT_MS;
    this.keepaliveSec = Number.isFinite(options.keepaliveSec) ? options.keepaliveSec : 30;
    this.reconnectMinMs = Number.isFinite(options.reconnectMinMs) ? options.reconnectMinMs : 2000;
    this.reconnectMaxMs = Number.isFinite(options.reconnectMaxMs) ? options.reconnectMaxMs : 30000;

    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.connected = false;
    this.rejected = false;
    this.stopped = false;
    this.packetId = 1;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.pingTimer = null;
    this.connectedAt = 0;
    this.lastMessageAt = 0;
    this.stats = { connects: 0, disconnects: 0, publishes: 0, parseErrors: 0 };
  }

  start() {
    this.stopped = false;
    this.rejected = false;
    this.connect();
    return this;
  }

  connect() {
    if (this.stopped || this.rejected) return;
    this.clearTimers();
    this.buf = Buffer.alloc(0);
    const socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.log(`[mqtt] tcp connected ${this.host}:${this.port}`);
      this.sendConnect();
    });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
    socket.on('data', (chunk) => {
      if (this.socket !== socket) return;
      this.onData(chunk);
    });
    socket.on('error', (err) => {
      if (this.socket !== socket) return;
      this.onError(err);
      this.connected = false;
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      this.clearConnectTimer();
      this.clearPing();
      this.stats.disconnects += 1;
      if (wasConnected) this.onDisconnect({ at: Date.now() });
      this.scheduleReconnect();
    });
    this.connectTimer = setTimeout(() => {
      if (!this.connected && this.socket === socket) {
        this.log('[mqtt] connect timeout, reconnect');
        socket.destroy();
      }
    }, this.connectTimeoutMs);
  }

  sendConnect() {
    const flags = 0x02 | (this.username !== '' ? 0x80 : 0) | (this.password !== '' ? 0x40 : 0);
    const variable = Buffer.concat([
      encodeString('MQTT'),
      Buffer.from([4, flags]),
      Buffer.from([(this.keepaliveSec >> 8) & 0xff, this.keepaliveSec & 0xff])
    ]);
    const parts = [variable, encodeString(this.clientId)];
    if (this.username !== '') parts.push(encodeString(this.username));
    if (this.password !== '') parts.push(encodeString(this.password));
    this.socket.write(encodePacket(1, 0, Buffer.concat(parts)));
  }

  subscribe(topic, qos = 0) {
    if (!this.connected || !this.socket) return false;
    const id = this.nextPacketId();
    const payload = Buffer.concat([
      Buffer.from([(id >> 8) & 0xff, id & 0xff]),
      encodeString(topic),
      Buffer.from([qos & 0x03])
    ]);
    this.socket.write(encodePacket(8, 0x02, payload));
    return true;
  }

  nextPacketId() {
    this.packetId = (this.packetId % 65535) + 1;
    return this.packetId;
  }

  ping() {
    if (this.connected && this.socket && this.socket.writable) {
      this.socket.write(encodePacket(12, 0, Buffer.alloc(0)));
    }
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > MAX_PACKET_BYTES) {
      this.stats.parseErrors += 1;
      this.log('[mqtt] incoming buffer too large, reconnect');
      this.destroyAndReconnect();
      return;
    }
    for (;;) {
      if (this.buf.length < 2) return;
      const length = readLength(this.buf, 1);
      if (length === null) {
        this.stats.parseErrors += 1;
        this.log('[mqtt] invalid remaining length, reconnect');
        this.destroyAndReconnect();
        return;
      }
      const total = 1 + (length.next - 1) + length.value;
      if (this.buf.length < total) return;
      const header = this.buf[0];
      const body = this.buf.subarray(length.next, total);
      this.buf = this.buf.subarray(total);
      this.handlePacket(header >> 4, header & 0x0f, Buffer.from(body));
    }
  }

  handlePacket(type, flags, body) {
    if (type === 2) {
      this.handleConnack(body);
      return;
    }
    if (type === 3) {
      this.handlePublish(flags, body);
      return;
    }
    if (type === 9) return;                       // SUBACK
    if (type === 13) return;                       // PINGRESP
    if (type === 14) return;                       // DISCONNECT
    // 其他类型（PUBACK/UNSUBACK…）对镜像服务无意义，忽略
  }

  handleConnack(body) {
    if (body.length < 2) {
      this.log('[mqtt] malformed CONNACK, reconnect');
      this.destroyAndReconnect();
      return;
    }
    const code = body[1];
    if (code !== 0) {
      const text = CONNACK_MEANING[code] || `code ${code}`;
      this.rejected = true;
      this.connected = false;
      this.log(`[mqtt] CONNACK rejected rc=${code} (${text})`);
      this.onAuthRejected(code, text);
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
      return;
    }
    this.connected = true;
    this.reconnectAttempts = 0;
    this.connectedAt = Date.now();
    this.stats.connects += 1;
    this.clearConnectTimer();
    this.log(`[mqtt] connected ${this.host}:${this.port} clientId=${this.clientId}`);
    for (const topic of this.topics) this.subscribe(topic, 0);
    this.pingTimer = setInterval(() => this.ping(), Math.max(5000, (this.keepaliveSec * 1000) / 2));
    this.onConnect({ at: this.connectedAt, topics: this.topics.slice() });
  }

  handlePublish(flags, body) {
    const qos = (flags >> 1) & 0x03;
    if (qos !== 0 && qos !== 1) {
      this.stats.parseErrors += 1;
      this.log(`[mqtt] unsupported PUBLISH qos=${qos}, reconnect`);
      this.destroyAndReconnect();
      return;
    }
    if (body.length < 2) return;
    const topicLen = body.readUInt16BE(0);
    if (topicLen === 0 || body.length < 2 + topicLen) {
      this.stats.parseErrors += 1;
      this.log('[mqtt] malformed PUBLISH topic, reconnect');
      this.destroyAndReconnect();
      return;
    }
    const topic = body.subarray(2, 2 + topicLen).toString('utf8');
    let offset = 2 + topicLen;
    if (qos === 1) {
      if (body.length < offset + 2) return;
      const packetId = body.readUInt16BE(offset);
      offset += 2;
      const ack = Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]);
      if (this.socket && this.socket.writable) this.socket.write(encodePacket(4, 0, ack));
    }
    const payload = body.subarray(offset).toString('utf8');
    this.stats.publishes += 1;
    this.lastMessageAt = Date.now();
    this.onMessage(topic, payload);
  }

  destroyAndReconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.rejected || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.log(`[mqtt] reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  clearPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  clearTimers() {
    this.clearConnectTimer();
    this.clearPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket) {
      try {
        if (socket.writable) socket.write(encodePacket(14, 0, Buffer.alloc(0)));
      } catch (err) { /* ignore */ }
      socket.destroy();
    }
  }

  status() {
    return {
      host: this.host,
      port: this.port,
      clientId: this.clientId,
      connected: this.connected,
      rejected: this.rejected,
      reconnectAttempts: this.reconnectAttempts,
      connectedAt: this.connectedAt,
      lastMessageAt: this.lastMessageAt,
      stats: Object.assign({}, this.stats)
    };
  }
}

module.exports = Object.freeze({ MqttClient, CONNACK_MEANING });
