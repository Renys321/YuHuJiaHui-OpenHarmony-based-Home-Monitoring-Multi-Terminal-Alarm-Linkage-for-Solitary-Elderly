'use strict';

/**
 * mqtt-broker.js — 内置最小 MQTT 3.1.1 Broker（零第三方依赖）。
 *
 * 能力（与 DESIGN-CONTRACT.md 和交付要求一一对应）：
 *   - CONNECT：用户名/密码鉴权 + Client ID 白名单；拒绝时先回 CONNACK 再断开；
 *   - CONNACK / SUBSCRIBE / SUBACK / UNSUBSCRIBE / UNSUBACK；
 *   - PUBLISH QoS0/QoS1（QoS1 回 PUBACK）；QoS2 只做 PUBREC/PUBCOMP 握手（按至少一次投递）；
 *   - PINGREQ/PINGRESP；Keep Alive 1.5 倍空闲超时断开；
 *   - clean session（不持久化会话，sessionPresent 恒为 0）；
 *   - `+` / `#` 通配匹配；retain 报文可接受、不保存；
 *   - 下行 QoS1 发布（适配器把 APP ACK 命令推到 down 主题）。
 *
 * 设计取舍：
 *   - 鉴权失败/协议错误只记录固定短码，绝不打印用户名、密码或原始载荷；
 *   - 每个连接一个解析缓冲区，报文上限 maxPacketBytes（默认 64 KiB），
 *     超限/畸形直接断开，防止一个坏客户端拖垮进程；
 *   - 内部适配器不走 MQTT client，直接监听 `message` 事件 + 调 `publish()`。
 */

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  PACKET_TYPE,
  TYPE_NAME,
  ProtocolError,
  buildAck,
  buildConnack,
  buildPingresp,
  buildPublish,
  buildSuback,
  buildUnsuback,
  isValidTopicFilter,
  isValidTopicName,
  parseConnect,
  parsePublish,
  parseSubscribeLike,
  readRemainingLength,
  topicMatches
} = require('./mqtt-protocol');

const DEFAULT_MAX_PACKET_BYTES = 64 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10 * 1000;
const MAX_OUTBOUND_PACKET_IDS = 65535;

function textEqual(left, right) {
  const a = Buffer.from(typeof left === 'string' ? left : '', 'utf8');
  const b = Buffer.from(typeof right === 'string' ? right : '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

class MqttBroker extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.host] 监听地址，默认 0.0.0.0
   * @param {number} [options.port] 监听端口，默认 1883；0 = 随机端口（测试用）
   * @param {string} options.username 允许的唯一用户名
   * @param {string} options.password 允许的唯一密码
   * @param {string[]} options.clientIds Client ID 白名单
   * @param {object} [options.logger]
   * @param {number} [options.maxPacketBytes]
   * @param {number} [options.connectTimeoutMs]
   */
  constructor(options = {}) {
    super();
    if (typeof options.username !== 'string' || options.username.length === 0) {
      throw new TypeError('broker username is required');
    }
    if (typeof options.password !== 'string' || options.password.length === 0) {
      throw new TypeError('broker password is required');
    }
    const clientIds = Array.isArray(options.clientIds) ? options.clientIds : [];
    if (clientIds.length === 0) throw new TypeError('broker clientIds whitelist is required');
    for (const id of clientIds) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
        throw new TypeError('broker clientIds must be non-empty strings');
      }
    }

    this.host = typeof options.host === 'string' && options.host ? options.host : '0.0.0.0';
    const port = options.port === undefined ? 1883 : options.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('broker port must be 0..65535');
    this.port = port;
    this.username = options.username;
    this.password = options.password;
    this.clientIds = new Set(clientIds);
    this.logger = options.logger || null;
    this.maxPacketBytes = options.maxPacketBytes === undefined ? DEFAULT_MAX_PACKET_BYTES : options.maxPacketBytes;
    this.connectTimeoutMs = options.connectTimeoutMs === undefined
      ? DEFAULT_CONNECT_TIMEOUT_MS : options.connectTimeoutMs;

    this.server = net.createServer((socket) => this._handleSocket(socket));
    /** @type {Set<object>} 所有 socket 连接（含尚未 CONNECT 的） */
    this.connections = new Set();
    /** @type {Map<string, object>} clientId -> 已认证连接 */
    this.clients = new Map();
    this.listening = false;
    this.startedAt = null;
    this._closing = false;

    this.counters = {
      connections: 0,
      disconnections: 0,
      connectAccepted: 0,
      authFailures: 0,
      clientIdRejected: 0,
      protocolErrors: 0,
      keepaliveTimeouts: 0,
      socketErrors: 0,
      takeover: 0,
      messagesReceived: 0,
      messagesSent: 0,
      publishesOut: 0,
      subscriptions: 0,
      unsubscriptions: 0,
      pingRequests: 0,
      qos2Received: 0
    };
  }

  start() {
    if (this.listening) return Promise.resolve(this.address());
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.removeListener('error', onError);
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', onError);
        this.listening = true;
        this.startedAt = Date.now();
        const address = this.server.address();
        if (address && typeof address === 'object') this.port = address.port;
        resolve(this.address());
      });
    });
  }

  address() {
    const address = this.server.address();
    return {
      host: address && typeof address === 'object' ? address.address : this.host,
      port: address && typeof address === 'object' ? address.port : this.port,
      family: address && typeof address === 'object' ? address.family : null
    };
  }

  async close() {
    this._closing = true;
    for (const connection of Array.from(this.connections)) {
      this._destroy(connection, 'SERVER_SHUTDOWN');
    }
    await new Promise((resolve) => {
      this.server.close(() => resolve());
    });
    this.listening = false;
  }

  /**
   * 向所有匹配的订阅者投递消息（内部适配器也用它下发 ACK 命令）。
   * @returns {{matched:number}}
   */
  publish(topic, payload, options = {}) {
    if (!isValidTopicName(topic)) throw new TypeError('invalid publish topic');
    const qos = options.qos === 0 ? 0 : 1;
    const body = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(String(payload === undefined ? '' : payload), 'utf8');
    const message = {
      topic,
      payload: body,
      qos,
      retain: false,
      dup: false,
      clientId: null,
      receivedAt: Date.now()
    };
    const matched = this._dispatch(null, message);
    this.counters.publishesOut += 1;
    return { matched };
  }

  snapshot() {
    return {
      listening: this.listening,
      host: this.host,
      port: this.port,
      startedAt: this.startedAt,
      counters: { ...this.counters },
      clients: Array.from(this.clients.values()).map((connection) => ({
        clientId: connection.clientId,
        remoteAddress: connection.remoteAddress,
        connectedAt: connection.connectedAt,
        lastActivity: connection.lastActivity,
        keepAliveSec: connection.keepAliveSec,
        cleanSession: connection.cleanSession,
        subscriptions: Array.from(connection.subscriptions.keys())
      }))
    };
  }

  /* ------------------------------------------------------------- socket 层 */

  _handleSocket(socket) {
    const connection = {
      socket,
      clientId: null,
      connected: false,
      closed: false,
      cleanSession: true,
      keepAliveSec: 0,
      remoteAddress: typeof socket.remoteAddress === 'string' ? socket.remoteAddress : '',
      connectedAt: null,
      lastActivity: Date.now(),
      buffer: Buffer.alloc(0),
      subscriptions: new Map(),
      outboundPacketId: 0,
      inflightOutbound: new Map(),
      will: null,
      connectTimer: null,
      cleanDisconnect: false
    };
    this.connections.add(connection);
    this.counters.connections += 1;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this._onData(connection, chunk);
    });
    socket.on('error', (error) => {
      this.counters.socketErrors += 1;
      this._log('warn', 'BROKER_SOCKET_ERROR', { code: safeErrorCode(error) });
      // 'close' 事件会做清理，这里不重复 destroy。
    });
    socket.on('close', () => {
      this._onClose(connection, 'SOCKET_CLOSED');
    });
    connection.connectTimer = setTimeout(() => {
      if (!connection.connected) this._destroy(connection, 'CONNECT_TIMEOUT');
    }, this.connectTimeoutMs);
    if (typeof connection.connectTimer.unref === 'function') connection.connectTimer.unref();
  }

  _onData(connection, chunk) {
    if (connection.closed) return;
    connection.lastActivity = Date.now();
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    connection.buffer = connection.buffer.length === 0
      ? incoming
      : Buffer.concat([connection.buffer, incoming]);

    // 一个恶意客户端连发垃圾字节时，缓冲区最多保留略高于一个最大报文。
    if (connection.buffer.length > this.maxPacketBytes + 64) {
      this.counters.protocolErrors += 1;
      this._destroy(connection, 'PACKET_OVERFLOW');
      return;
    }

    while (!connection.closed) {
      if (connection.buffer.length < 2) return;
      let remaining = null;
      try {
        remaining = readRemainingLength(connection.buffer, 1);
      } catch (error) {
        this._protocolError(connection, error);
        return;
      }
      if (remaining === null) return;
      if (remaining.value > this.maxPacketBytes) {
        this.counters.protocolErrors += 1;
        this._destroy(connection, 'PACKET_TOO_LARGE');
        return;
      }
      const totalLength = remaining.next + remaining.value;
      if (connection.buffer.length < totalLength) return;

      const firstByte = connection.buffer[0];
      const type = firstByte >> 4;
      const flags = firstByte & 0x0f;
      const body = connection.buffer.subarray(remaining.next, totalLength);
      connection.buffer = connection.buffer.subarray(totalLength);

      try {
        this._handlePacket(connection, type, flags, body);
      } catch (error) {
        this._protocolError(connection, error);
        return;
      }
    }
  }

  _handlePacket(connection, type, flags, body) {
    if (!connection.connected) {
      if (type !== PACKET_TYPE.CONNECT) {
        throw new ProtocolError('FIRST_PACKET_NOT_CONNECT');
      }
      this._handleConnect(connection, body);
      return;
    }

    switch (type) {
      case PACKET_TYPE.CONNECT:
        throw new ProtocolError('DUPLICATE_CONNECT');
      case PACKET_TYPE.PUBLISH:
        this._handlePublish(connection, flags, body);
        return;
      case PACKET_TYPE.PUBACK:
        this._handleOutboundAck(connection, body);
        return;
      case PACKET_TYPE.PUBREL:
        this._handlePubrel(connection, body);
        return;
      case PACKET_TYPE.PUBREC:
      case PACKET_TYPE.PUBCOMP:
        // 服务器从不以 QoS2 下发，收到这两个报文只计数，不影响连接。
        return;
      case PACKET_TYPE.SUBSCRIBE:
        this._handleSubscribe(connection, flags, body);
        return;
      case PACKET_TYPE.UNSUBSCRIBE:
        this._handleUnsubscribe(connection, flags, body);
        return;
      case PACKET_TYPE.PINGREQ:
        this.counters.pingRequests += 1;
        this._send(connection, buildPingresp());
        return;
      case PACKET_TYPE.DISCONNECT:
        connection.cleanDisconnect = true;
        this._destroy(connection, 'CLIENT_DISCONNECT');
        return;
      default:
        throw new ProtocolError('UNEXPECTED_PACKET_TYPE');
    }
  }

  /* ---------------------------------------------------------------- CONNECT */

  _handleConnect(connection, body) {
    let parsed;
    try {
      parsed = parseConnect(body);
    } catch (error) {
      if (error instanceof ProtocolError && error.connackCode !== null) {
        this.counters.protocolErrors += 1;
        this._rejectConnect(connection, error.connackCode, error.code);
        return;
      }
      throw error;
    }

    const usernameOk = textEqual(parsed.username === null ? '' : parsed.username, this.username);
    const passwordOk = textEqual(parsed.password === null ? '' : parsed.password, this.password);
    if (!usernameOk || !passwordOk) {
      this.counters.authFailures += 1;
      this._rejectConnect(connection, 0x04, 'BAD_CREDENTIALS');
      return;
    }
    if (parsed.clientId.length === 0) {
      this.counters.clientIdRejected += 1;
      this._rejectConnect(connection, 0x02, 'EMPTY_CLIENT_ID');
      return;
    }
    if (!this.clientIds.has(parsed.clientId)) {
      this.counters.clientIdRejected += 1;
      this._rejectConnect(connection, 0x05, 'CLIENT_ID_NOT_ALLOWED');
      return;
    }

    // 同一 Client ID 重复连接：以新连接为准，踢掉旧连接（MQTT 3.1.1 允许）。
    const previous = this.clients.get(parsed.clientId);
    if (previous && previous !== connection) {
      this.counters.takeover += 1;
      this._destroy(previous, 'CLIENT_TAKEOVER');
    }

    connection.clientId = parsed.clientId;
    connection.connected = true;
    connection.cleanSession = parsed.cleanSession;
    connection.keepAliveSec = parsed.keepAlive;
    connection.will = parsed.will;
    connection.connectedAt = Date.now();
    this.clients.set(connection.clientId, connection);
    this.counters.connectAccepted += 1;
    if (connection.connectTimer) {
      clearTimeout(connection.connectTimer);
      connection.connectTimer = null;
    }

    this._send(connection, buildConnack(false, 0x00));
    this._applyKeepAlive(connection);
    this._log('info', 'BROKER_CLIENT_CONNECTED', {
      clientId: connection.clientId,
      remoteAddress: connection.remoteAddress,
      cleanSession: connection.cleanSession,
      keepAliveSec: connection.keepAliveSec
    });
    this.emit('clientConnect', Object.freeze({
      clientId: connection.clientId,
      remoteAddress: connection.remoteAddress,
      connectedAt: connection.connectedAt
    }));
  }

  _applyKeepAlive(connection) {
    if (connection.keepAliveSec <= 0) {
      connection.socket.setTimeout(0);
      return;
    }
    // MQTT 3.1.1 规定服务器在 1.5 倍 Keep Alive 内未收到任何报文可断开连接。
    const timeoutMs = Math.max(1000, Math.round(connection.keepAliveSec * 1000 * 1.5));
    connection.socket.setTimeout(timeoutMs);
    connection.socket.once('timeout', () => {
      if (connection.closed) return;
      this.counters.keepaliveTimeouts += 1;
      this._destroy(connection, 'KEEPALIVE_TIMEOUT');
    });
  }

  _rejectConnect(connection, returnCode, code) {
    this._log('warn', 'BROKER_CONNECT_REJECTED', { code, returnCode });
    this._endConnection(connection, buildConnack(false, returnCode), code);
  }

  /** 写完最后一个报文（如 CONNACK 拒绝）再优雅断开，避免客户端只能看到连接重置。 */
  _endConnection(connection, packet, code) {
    try {
      connection.socket.end(packet);
    } catch {
      /* socket 可能已断开 */
    }
    connection.cleanDisconnect = true;
    this._onClose(connection, code);
    const timer = setTimeout(() => {
      try {
        connection.socket.destroy();
      } catch {
        /* 忽略 */
      }
    }, 100);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /* ---------------------------------------------------------------- PUBLISH */

  _handlePublish(connection, flags, body) {
    const parsed = parsePublish(flags, body);
    if (!isValidTopicName(parsed.topic)) throw new ProtocolError('INVALID_PUBLISH_TOPIC');
    this.counters.messagesReceived += 1;

    if (parsed.qos === 2) {
      // 不实现 exactly-once 台账：立即按至少一次投递，完成 PUBREC/PUBREL/PUBCOMP 握手。
      this.counters.qos2Received += 1;
      this._dispatch(connection, parsed);
      this._send(connection, buildAck(PACKET_TYPE.PUBREC, parsed.packetId));
      this._emitMessage(connection, parsed);
      return;
    }

    this._dispatch(connection, parsed);
    if (parsed.qos === 1) {
      this._send(connection, buildAck(PACKET_TYPE.PUBACK, parsed.packetId));
    }
    this._emitMessage(connection, parsed);
  }

  _emitMessage(connection, parsed) {
    const message = Object.freeze({
      topic: parsed.topic,
      payload: Buffer.from(parsed.payload),
      qos: parsed.qos,
      retain: parsed.retain === true,
      dup: parsed.dup === true,
      clientId: connection.clientId,
      receivedAt: Date.now()
    });
    try {
      this.emit('message', message);
    } catch (error) {
      // 内部订阅者（适配器）抛错不能影响 MQTT 连接本身的正确性。
      this._log('error', 'BROKER_MESSAGE_HANDLER_FAILED', { code: safeErrorCode(error) });
    }
  }

  /** 把消息投递给所有匹配订阅者；返回实际匹配的订阅者数量。 */
  _dispatch(sourceConnection, message) {
    let matched = 0;
    for (const target of this.clients.values()) {
      if (target.closed) continue;
      let maxQos = -1;
      for (const [filter, grantedQos] of target.subscriptions) {
        if (topicMatches(filter, message.topic)) {
          maxQos = Math.max(maxQos, grantedQos);
        }
      }
      if (maxQos < 0) continue;
      matched += 1;
      const qos = Math.min(message.qos, maxQos) === 1 ? 1 : 0;
      let packetId;
      if (qos === 1) packetId = this._nextOutboundPacketId(target);
      try {
        const packet = buildPublish({
          topic: message.topic,
          payload: message.payload,
          qos,
          packetId,
          retain: false,
          dup: false
        });
        this._send(target, packet);
        this.counters.messagesSent += 1;
        if (qos === 1) target.inflightOutbound.set(packetId, { at: Date.now() });
      } catch (error) {
        this._log('warn', 'BROKER_DELIVER_FAILED', { code: safeErrorCode(error) });
      }
    }
    return matched;
  }

  _nextOutboundPacketId(connection) {
    for (let attempt = 0; attempt < MAX_OUTBOUND_PACKET_IDS; attempt += 1) {
      connection.outboundPacketId = connection.outboundPacketId >= MAX_OUTBOUND_PACKET_IDS
        ? 1
        : connection.outboundPacketId + 1;
      if (!connection.inflightOutbound.has(connection.outboundPacketId)) {
        return connection.outboundPacketId;
      }
    }
    throw new ProtocolError('OUTBOUND_PACKET_IDS_EXHAUSTED');
  }

  _handleOutboundAck(connection, body) {
    const parsed = readUInt16(body, 0);
    if (!parsed) throw new ProtocolError('INVALID_PUBACK');
    connection.inflightOutbound.delete(parsed.value);
  }

  _handlePubrel(connection, body) {
    const parsed = readUInt16(body, 0);
    if (!parsed) throw new ProtocolError('INVALID_PUBREL');
    this._send(connection, buildAck(PACKET_TYPE.PUBCOMP, parsed.value));
  }

  /* ------------------------------------------------- SUBSCRIBE/UNSUBSCRIBE */

  _handleSubscribe(connection, flags, body) {
    const parsed = parseSubscribeLike(flags, body, { withQos: true });
    const returnCodes = [];
    for (const entry of parsed.filters) {
      if (!isValidTopicFilter(entry.filter)) {
        returnCodes.push(0x80);
        continue;
      }
      // 本 broker 只支持 QoS0/1；请求 QoS2 降级为 QoS1。
      const granted = entry.qos >= 1 ? 1 : 0;
      connection.subscriptions.set(entry.filter, granted);
      this.counters.subscriptions += 1;
      returnCodes.push(granted);
    }
    this._send(connection, buildSuback(parsed.packetId, returnCodes));
  }

  _handleUnsubscribe(connection, flags, body) {
    const parsed = parseSubscribeLike(flags, body, { withQos: false });
    for (const entry of parsed.filters) {
      if (connection.subscriptions.delete(entry.filter)) {
        this.counters.unsubscriptions += 1;
      }
    }
    this._send(connection, buildUnsuback(parsed.packetId));
  }

  /* ------------------------------------------------------------- 断开清理 */

  _onClose(connection, reason) {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.connectTimer) {
      clearTimeout(connection.connectTimer);
      connection.connectTimer = null;
    }
    this.connections.delete(connection);
    if (connection.clientId && this.clients.get(connection.clientId) === connection) {
      this.clients.delete(connection.clientId);
    }
    connection.subscriptions.clear();
    connection.inflightOutbound.clear();
    this.counters.disconnections += 1;
    if (!this._closing) {
      this._log('info', 'BROKER_CLIENT_DISCONNECTED', {
        clientId: connection.clientId || '',
        code: reason
      });
    }
    this.emit('clientDisconnect', Object.freeze({
      clientId: connection.clientId,
      code: reason,
      clean: connection.cleanDisconnect === true
    }));
  }

  _destroy(connection, reason) {
    if (connection.closed) return;
    try {
      connection.socket.destroy();
    } catch {
      /* 忽略 */
    }
    this._onClose(connection, reason);
  }

  _protocolError(connection, error) {
    const code = error instanceof ProtocolError ? error.code : safeErrorCode(error);
    this.counters.protocolErrors += 1;
    this._log('warn', 'BROKER_PROTOCOL_ERROR', { code });
    const connackCode = error instanceof ProtocolError ? error.connackCode : null;
    if (connackCode !== null && !connection.connected) {
      this._endConnection(connection, buildConnack(false, connackCode), code);
      return;
    }
    this._destroy(connection, code);
  }

  _send(connection, packet) {
    if (connection.closed) return;
    if (connection.socket.destroyed) return;
    try {
      connection.socket.write(packet);
    } catch (error) {
      this._log('warn', 'BROKER_WRITE_FAILED', { code: safeErrorCode(error) });
    }
  }

  _log(level, code, fields) {
    if (!this.logger || typeof this.logger[level] !== 'function') return;
    this.logger[level](code, fields || {});
  }
}

function readUInt16(buffer, offset) {
  if (!Buffer.isBuffer(buffer) || offset + 2 > buffer.length) return null;
  return { value: buffer.readUInt16BE(offset), next: offset + 2 };
}

function safeErrorCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
  return /^[A-Z][A-Z0-9_]{2,39}$/.test(code) ? code : 'UNKNOWN';
}

module.exports = Object.freeze({
  MqttBroker,
  DEFAULT_MAX_PACKET_BYTES,
  DEFAULT_CONNECT_TIMEOUT_MS,
  TYPE_NAME
});
