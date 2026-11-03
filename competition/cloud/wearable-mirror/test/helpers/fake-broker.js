'use strict';

/**
 * 测试夹具：最小 MQTT 3.1.1 Broker（只够验证 mirror 的订阅/收包/鉴权拒绝语义）。
 * - 校验 username/password 与 clientId 白名单（与 ECS 适配器同语义：不在白名单 → CONNACK 5）；
 * - 支持 SUBSCRIBE(qos0) 与 server.publish(topic, payload) 向匹配的订阅者推 PUBLISH(qos0)。
 * 仅测试用，不追求协议完整性。
 */

const net = require('node:net');

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
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function packet(type, flags, payload) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(payload.length), payload]);
}

function topicMatches(filter, topic) {
  const filterParts = filter.split('/');
  const topicParts = topic.split('/');
  for (let i = 0; i < filterParts.length; i++) {
    if (filterParts[i] === '#') return true;
    if (i >= topicParts.length) return false;
    if (filterParts[i] !== '+' && filterParts[i] !== topicParts[i]) return false;
  }
  return filterParts.length === topicParts.length;
}

function parsePublishPacket(body) {
  const topicLen = body.readUInt16BE(0);
  const topic = body.subarray(2, 2 + topicLen).toString('utf8');
  return { topic, payload: body.subarray(2 + topicLen) };
}

class FakeBroker {
  constructor(options = {}) {
    this.username = options.username || 'test-user';
    this.password = options.password || 'test-pass';
    this.clientIds = new Set(options.clientIds || ['mirror-test-client']);
    this.port = 0;
    this.server = null;
    this.clients = new Set();
    this.published = [];
    this.subscriptions = [];
    this.counters = { connects: 0, authFailures: 0, clientIdRejected: 0 };
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      this.server = server;
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = server.address().port;
        resolve(this);
      });
    });
  }

  onConnection(socket) {
    socket.setNoDelay(true);
    const state = { socket, clientId: '', topics: new Set(), buf: Buffer.alloc(0) };
    this.clients.add(state);
    socket.on('data', (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      for (;;) {
        if (state.buf.length < 2) return;
        let mult = 1;
        let len = 0;
        let index = 1;
        for (;;) {
          if (index >= state.buf.length) return;
          const byte = state.buf[index];
          len += (byte & 0x7f) * mult;
          mult *= 128;
          index += 1;
          if ((byte & 0x80) === 0) break;
        }
        const total = index + len;
        if (state.buf.length < total) return;
        const header = state.buf[0];
        const body = state.buf.subarray(index, total);
        state.buf = state.buf.subarray(total);
        this.handlePacket(state, header >> 4, header & 0x0f, Buffer.from(body));
      }
    });
    socket.on('close', () => this.clients.delete(state));
    socket.on('error', () => { /* ignore */ });
  }

  handlePacket(state, type, flags, body) {
    if (type === 1) {
      let offset = 2 + body.readUInt16BE(0);
      const level = body[offset];
      const connectFlags = body[offset + 1];
      offset += 4;
      const clientIdLen = body.readUInt16BE(offset);
      const clientId = body.subarray(offset + 2, offset + 2 + clientIdLen).toString('utf8');
      offset += 2 + clientIdLen;
      let username = '';
      let password = '';
      if ((connectFlags & 0x80) !== 0) {
        const userLen = body.readUInt16BE(offset);
        username = body.subarray(offset + 2, offset + 2 + userLen).toString('utf8');
        offset += 2 + userLen;
      }
      if ((connectFlags & 0x40) !== 0) {
        const passLen = body.readUInt16BE(offset);
        password = body.subarray(offset + 2, offset + 2 + passLen).toString('utf8');
      }
      this.counters.connects += 1;
      let rc = 0;
      if (level !== 4) rc = 1;
      else if (username !== this.username || password !== this.password) rc = 4;
      else if (!this.clientIds.has(clientId)) rc = 5;
      state.clientId = clientId;
      state.socket.write(packet(2, 0, Buffer.from([0, rc])));
      if (rc !== 0) {
        if (rc === 5) this.counters.clientIdRejected += 1;
        if (rc === 4) this.counters.authFailures += 1;
        setTimeout(() => state.socket.destroy(), 10);
      }
      return;
    }
    if (type === 8) {
      const packetId = body.readUInt16BE(0);
      const topicLen = body.readUInt16BE(2);
      const filter = body.subarray(4, 4 + topicLen).toString('utf8');
      state.topics.add(filter);
      this.subscriptions.push({ clientId: state.clientId, filter });
      state.socket.write(packet(9, 0, Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff, 0])));
      return;
    }
    if (type === 12) {
      state.socket.write(packet(13, 0, Buffer.alloc(0)));
      return;
    }
    if (type === 14) {
      state.socket.end();
    }
  }

  /** 服务端主动发布（模拟设备上行），推给所有订阅匹配的客户端 */
  publish(topic, payload) {
    this.published.push({ topic, payload: String(payload) });
    for (const state of this.clients) {
      for (const filter of state.topics) {
        if (topicMatches(filter, topic)) {
          state.socket.write(packet(3, 0, Buffer.concat([encodeString(topic), Buffer.from(String(payload), 'utf8')])));
          break;
        }
      }
    }
  }

  close() {
    for (const state of this.clients) state.socket.destroy();
    this.clients.clear();
    if (this.server) {
      try { this.server.close(); } catch (err) { /* ignore */ }
      this.server = null;
    }
  }
}

module.exports = Object.freeze({ FakeBroker, packet, encodeString, encodeLength, topicMatches, parsePublishPacket });
