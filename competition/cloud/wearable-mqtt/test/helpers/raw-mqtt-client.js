'use strict';

/**
 * test/helpers/raw-mqtt-client.js — 测试专用“裸 TCP MQTT 客户端”。
 *
 * 刻意**不复用** src/mqtt-protocol.js，而是重新实现最小 MQTT 3.1.1 编解码，
 * 这样测试能独立验证 broker 的报文格式，而不是“实现自己验证自己”。
 * 只支持测试需要的：CONNECT/CONNACK、SUBSCRIBE/SUBACK、PUBLISH(QoS0/1)、PUBACK、
 * PINGREQ/PINGRESP、DISCONNECT、UNSUBSCRIBE/UNSUBACK。
 */

const net = require('node:net');
const { EventEmitter } = require('node:events');

function encodeVarint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) digit |= 0x80;
    bytes.push(digit);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function encodeString(value) {
  const body = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

function packet(type, flags, parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeVarint(body.length), body]);
}

function readVarint(buffer, offset) {
  let multiplier = 1;
  let value = 0;
  let index = offset;
  for (let count = 0; count < 4; count += 1) {
    if (index >= buffer.length) return null;
    const byte = buffer[index];
    index += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: index };
    multiplier *= 128;
  }
  return null;
}

function readString(buffer, offset) {
  if (offset + 2 > buffer.length) return null;
  const length = buffer.readUInt16BE(offset);
  const start = offset + 2;
  if (start + length > buffer.length) return null;
  return { value: buffer.toString('utf8', start, start + length), next: start + length };
}

class RawMqttClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.closed = false;
    this.closeReason = null;
    this.messages = [];
    this.packetId = 0;
    this.pendingAcks = new Map();
    this._waiters = [];
    this._connectResolve = null;
    this._connectReject = null;
  }

  nextPacketId() {
    this.packetId = this.packetId >= 65535 ? 1 : this.packetId + 1;
    return this.packetId;
  }

  connect(options = {}) {
    const host = options.host || '127.0.0.1';
    const port = options.port;
    const clientId = options.clientId || 'test-client';
    const username = options.username;
    const password = options.password;
    const keepAlive = options.keepAlive === undefined ? 60 : options.keepAlive;
    const cleanSession = options.cleanSession !== false;
    const protocolLevel = options.protocolLevel === undefined ? 4 : options.protocolLevel;
    const protocolName = options.protocolName || 'MQTT';

    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
      const socket = net.connect({ host, port }, () => {
        let flags = 0;
        if (cleanSession) flags |= 0x02;
        const payload = [encodeString(clientId)];
        if (username !== undefined) {
          flags |= 0x80;
          payload.push(encodeString(username));
        }
        if (password !== undefined) {
          flags |= 0x40;
          payload.push(encodeString(password));
        }
        const variable = Buffer.alloc(2);
        variable.writeUInt16BE(keepAlive, 0);
        const body = [
          encodeString(protocolName),
          Buffer.from([protocolLevel, flags]),
          variable
        ].concat(payload);
        socket.write(packet(1, 0, body));
      });
      this.socket = socket;
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (error) => {
        this.lastError = error;
        if (this._connectReject) {
          const rejectFn = this._connectReject;
          this._connectReject = null;
          rejectFn(error);
        }
        // 测试用客户端：没有监听者时不能 throw（EventEmitter 'error' 默认行为），
        // 否则 broker 关闭/对端 RST 会变成 node --test 的未捕获异常。
        if (this.listenerCount('error') > 0) this.emit('error', error);
      });
      socket.on('close', () => {
        this.closed = true;
        this.connected = false;
        for (const waiter of this.pendingAcks.values()) {
          waiter.reject(new Error('socket closed'));
        }
        this.pendingAcks.clear();
        this.emit('close');
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const firstByte = this.buffer[0];
      const type = firstByte >> 4;
      const flags = firstByte & 0x0f;
      const length = readVarint(this.buffer, 1);
      if (!length) return;
      const total = length.next + length.value;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(length.next, total);
      this.buffer = this.buffer.subarray(total);
      this._handlePacket(type, flags, body);
    }
  }

  _handlePacket(type, flags, body) {
    switch (type) {
      case 2: { // CONNACK
        const returnCode = body.length >= 2 ? body[1] : 0xff;
        const sessionPresent = body.length >= 2 ? (body[0] & 0x01) === 1 : false;
        this.connected = returnCode === 0;
        if (this._connectResolve) {
          const resolveFn = this._connectResolve;
          this._connectResolve = null;
          resolveFn({ returnCode, sessionPresent });
        }
        return;
      }
      case 3: { // PUBLISH
        const qos = (flags >> 1) & 0x03;
        const retain = (flags & 0x01) === 1;
        const topicResult = readString(body, 0);
        if (!topicResult) return;
        let offset = topicResult.next;
        let packetId = null;
        if (qos > 0) {
          if (offset + 2 > body.length) return;
          packetId = body.readUInt16BE(offset);
          offset += 2;
        }
        const payload = body.subarray(offset);
        if (qos === 1 && packetId !== null) {
          const ack = Buffer.alloc(2);
          ack.writeUInt16BE(packetId, 0);
          this.socket.write(packet(4, 0, [ack]));
        }
        const message = {
          topic: topicResult.value,
          payload: payload.toString('utf8'),
          qos,
          retain,
          packetId
        };
        this.messages.push(message);
        this.emit('message', message);
        for (const waiter of this._waiters.slice()) {
          if (waiter.predicate(message)) {
            this._waiters.splice(this._waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
        }
        return;
      }
      case 4: { // PUBACK
        if (body.length < 2) return;
        const packetId = body.readUInt16BE(0);
        const pending = this.pendingAcks.get(packetId);
        if (pending) {
          this.pendingAcks.delete(packetId);
          clearTimeout(pending.timer);
          pending.resolve({ packetId });
        }
        return;
      }
      case 9: { // SUBACK
        if (body.length < 2) return;
        const packetId = body.readUInt16BE(0);
        const codes = Array.from(body.subarray(2));
        const pending = this.pendingAcks.get(packetId);
        if (pending) {
          this.pendingAcks.delete(packetId);
          clearTimeout(pending.timer);
          pending.resolve({ packetId, codes });
        }
        return;
      }
      case 11: { // UNSUBACK
        if (body.length < 2) return;
        const packetId = body.readUInt16BE(0);
        const pending = this.pendingAcks.get(packetId);
        if (pending) {
          this.pendingAcks.delete(packetId);
          clearTimeout(pending.timer);
          pending.resolve({ packetId });
        }
        return;
      }
      case 13: { // PINGRESP
        this.emit('pingresp');
        return;
      }
      default:
        this.emit('packet', { type, flags, body });
    }
  }

  subscribe(filters, timeoutMs = 2000) {
    const packetId = this.nextPacketId();
    const parts = [];
    const idBuffer = Buffer.alloc(2);
    idBuffer.writeUInt16BE(packetId, 0);
    parts.push(idBuffer);
    for (const entry of filters) {
      parts.push(encodeString(entry.filter));
      parts.push(Buffer.from([entry.qos === 1 ? 1 : 0]));
    }
    return this._sendExpectAck(packetId, packet(8, 2, parts), timeoutMs);
  }

  unsubscribe(filters, timeoutMs = 2000) {
    const packetId = this.nextPacketId();
    const parts = [];
    const idBuffer = Buffer.alloc(2);
    idBuffer.writeUInt16BE(packetId, 0);
    parts.push(idBuffer);
    for (const filter of filters) parts.push(encodeString(filter));
    return this._sendExpectAck(packetId, packet(10, 2, parts), timeoutMs);
  }

  publish(topic, payload, options = {}) {
    const qos = options.qos === 1 ? 1 : 0;
    const retain = options.retain === true;
    const dup = options.dup === true;
    const flags = (qos << 1) | (retain ? 0x01 : 0) | (dup ? 0x08 : 0);
    const parts = [encodeString(topic)];
    let packetId = null;
    if (qos === 1) {
      packetId = this.nextPacketId();
      const idBuffer = Buffer.alloc(2);
      idBuffer.writeUInt16BE(packetId, 0);
      parts.push(idBuffer);
    }
    parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
    if (qos === 1) return this._sendExpectAck(packetId, packet(3, flags, parts));
    this.socket.write(packet(3, flags, parts));
    return Promise.resolve({ packetId: null });
  }

  _sendExpectAck(packetId, buffer, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(packetId);
        reject(new Error(`timeout waiting for ack packetId=${packetId}`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pendingAcks.set(packetId, { resolve, reject, timer });
      this.socket.write(buffer);
    });
  }

  /** 等待下一条匹配的 PUBLISH（可带已有消息）。 */
  waitForMessage(predicate = () => true, timeoutMs = 3000) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this._waiters.indexOf(waiter);
        if (index >= 0) this._waiters.splice(index, 1);
        reject(new Error('timeout waiting for MQTT message'));
      }, timeoutMs);
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      this._waiters.push(waiter);
    });
  }

  clearMessages() {
    this.messages.length = 0;
  }

  ping(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for PINGRESP')), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.once('pingresp', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.write(packet(12, 0, []));
    });
  }

  waitForClose(timeoutMs = 4000) {
    if (this.closed) return Promise.resolve({ forced: false });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for socket close')), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.once('close', () => {
        clearTimeout(timer);
        resolve({ forced: false });
      });
    });
  }

  disconnect() {
    if (!this.socket || this.socket.destroyed) return Promise.resolve();
    try {
      this.socket.write(packet(14, 0, []));
    } catch {
      /* 忽略 */
    }
    return new Promise((resolve) => {
      this.socket.end(() => resolve());
    });
  }

  destroy() {
    if (this.socket) this.socket.destroy();
  }
}

module.exports = Object.freeze({ RawMqttClient, encodeString, encodeVarint, packet });
