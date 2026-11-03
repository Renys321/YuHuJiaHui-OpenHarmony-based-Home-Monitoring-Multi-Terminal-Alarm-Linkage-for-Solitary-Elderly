'use strict';
/**
 * MQTT PUBLISH broker tests -- uses the real production server exported by
 * mqtt_broker.js. Packets are hand-built here, not by production encoders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { server: brokerServer } = require('./mqtt_broker.js');

const TIMEOUT = 5000;

function encLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
function str(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([u16(b.length), b]);
}
function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(body.length), body]);
}
function publish(topic, payload, qos, pid) {
  const parts = [str(topic)];
  if (qos > 0) parts.push(u16(pid));
  parts.push(Buffer.from(String(payload), 'utf8'));
  return packet(3, (qos & 3) << 1, Buffer.concat(parts));
}
function connectPacket(clientId) {
  return packet(1, 0, Buffer.concat([str('MQTT'), Buffer.from([4, 2]), u16(60), str(clientId)]));
}
function subscribePacket(pid, filter) {
  return packet(8, 2, Buffer.concat([u16(pid), str(filter), Buffer.from([0])]));
}
function parseTopic(body) {
  const len = body.readUInt16BE(0);
  return body.slice(2, 2 + len).toString('utf8');
}
function parsePayload(body) {
  const len = body.readUInt16BE(0);
  return body.slice(2 + len).toString('utf8');
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class Stream {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    sock.on('data', (d) => this._data(d));
    sock.on('error', () => {});
    sock.on('close', () => {
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error('socket closed'));
      }
    });
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      let mult = 1, len = 0, i = 1;
      while (true) {
        if (i >= this.buf.length) return;
        const b = this.buf[i];
        len += (b & 127) * mult;
        mult *= 128;
        i++;
        if ((b & 128) === 0) break;
      }
      const total = i + len;
      if (this.buf.length < total) return;
      const type = this.buf[0] >> 4;
      const flags = this.buf[0] & 0x0f;
      const body = this.buf.slice(i, total);
      this.buf = this.buf.slice(total);
      const p = { type, flags, body };
      const idx = this.waiters.findIndex((w) => w.predicate(p));
      if (idx >= 0) {
        const w = this.waiters.splice(idx, 1)[0];
        clearTimeout(w.timer);
        w.resolve(p);
      } else {
        this.queue.push(p);
      }
    }
  }
  send(bytes) { this.sock.write(bytes); }
  waitFor(predicate, label) {
    const idx = this.queue.findIndex(predicate);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('timeout: ' + (label || 'packet')));
      }, TIMEOUT);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }
}

async function connectRaw(port, id) {
  const sock = net.createConnection({ host: '127.0.0.1', port });
  const stream = new Stream(sock);
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.once('connect', resolve);
  });
  stream.send(connectPacket(id));
  await stream.waitFor((p) => p.type === 2, 'CONNACK');
  return { sock, stream };
}

let brokerPort;

test.before(async () => {
  await new Promise((resolve, reject) => {
    brokerServer.once('error', reject);
    brokerServer.listen(0, '127.0.0.1', () => {
      brokerServer.removeListener('error', reject);
      resolve();
    });
  });
  brokerPort = brokerServer.address().port;
});

test.after(async () => {
  await new Promise((resolve) => brokerServer.close(resolve));
});

test('broker QoS0 forwards exact topic/payload', async () => {
  const sub = await connectRaw(brokerPort, 'sub-q0');
  sub.stream.send(subscribePacket(1, 'home/+/status'));
  await sub.stream.waitFor((p) => p.type === 9, 'SUBACK');
  const pub = await connectRaw(brokerPort, 'pub-q0');
  pub.stream.send(publish('home/dev-a/status', 'qos0-payload', 0, 0));
  const m = await sub.stream.waitFor((p) => p.type === 3, 'PUBLISH');
  assert.equal(m.flags, 0);
  assert.equal(parseTopic(m.body), 'home/dev-a/status');
  assert.equal(parsePayload(m.body), 'qos0-payload');
  sub.sock.destroy(); pub.sock.destroy();
});

test('broker QoS1 uses nontrivial PacketId 0x1234 and forwards clean payload', async () => {
  const sub = await connectRaw(brokerPort, 'sub-q1');
  sub.stream.send(subscribePacket(2, 'home/+/cmd'));
  await sub.stream.waitFor((p) => p.type === 9, 'SUBACK');
  const pub = await connectRaw(brokerPort, 'pub-q1');
  pub.stream.send(publish('home/esp32-bath/cmd', '{"cmd":"ack"}', 1, 0x1234));
  const ack = await pub.stream.waitFor((p) => p.type === 4, 'PUBACK');
  assert.equal(ack.body.readUInt16BE(0), 0x1234);
  const m = await sub.stream.waitFor((p) => p.type === 3, 'PUBLISH');
  assert.equal(m.flags & 6, 0);
  assert.equal(parseTopic(m.body), 'home/esp32-bath/cmd');
  assert.equal(parsePayload(m.body), '{"cmd":"ack"}');
  sub.sock.destroy(); pub.sock.destroy();
});

test('broker TCP split and multi-byte remaining length', async () => {
  const sub = await connectRaw(brokerPort, 'sub-split');
  sub.stream.send(subscribePacket(3, 'home/+/status'));
  await sub.stream.waitFor((p) => p.type === 9, 'SUBACK');
  const pub = await connectRaw(brokerPort, 'pub-split');
  const payload = 'X'.repeat(400);
  const whole = publish('home/split/status', payload, 0, 0);
  pub.stream.send(whole.slice(0, 1));
  await delay(30);
  pub.stream.send(whole.slice(1, 3));
  await delay(30);
  pub.stream.send(whole.slice(3));
  const m = await sub.stream.waitFor((p) => p.type === 3, 'PUBLISH');
  assert.equal(parsePayload(m.body), payload);
  sub.sock.destroy(); pub.sock.destroy();
});

test('broker TCP coalesced packets are handled separately', async () => {
  const sub = await connectRaw(brokerPort, 'sub-glue');
  sub.stream.send(subscribePacket(4, 'home/+/cmd'));
  await sub.stream.waitFor((p) => p.type === 9, 'SUBACK');
  const pub = await connectRaw(brokerPort, 'pub-glue');
  pub.stream.send(Buffer.concat([
    publish('home/glue-a/cmd', 'A', 1, 0x1111),
    publish('home/glue-b/cmd', 'B', 1, 0x2222)
  ]));
  const a = await pub.stream.waitFor((p) => p.type === 4 && p.body.readUInt16BE(0) === 0x1111, 'PUBACK 1111');
  const b = await pub.stream.waitFor((p) => p.type === 4 && p.body.readUInt16BE(0) === 0x2222, 'PUBACK 2222');
  assert.equal(a.body.readUInt16BE(0), 0x1111);
  assert.equal(b.body.readUInt16BE(0), 0x2222);
  const m1 = await sub.stream.waitFor((p) => p.type === 3 && parseTopic(p.body) === 'home/glue-a/cmd', 'glue A');
  const m2 = await sub.stream.waitFor((p) => p.type === 3 && parseTopic(p.body) === 'home/glue-b/cmd', 'glue B');
  assert.equal(parsePayload(m1.body), 'A');
  assert.equal(parsePayload(m2.body), 'B');
  sub.sock.destroy(); pub.sock.destroy();
});

test('broker rejects QoS2 without forwarding/PUBACK and stays alive', async () => {
  const sub = await connectRaw(brokerPort, 'sub-q2');
  sub.stream.send(subscribePacket(8, 'home/+/cmd'));
  await sub.stream.waitFor((p) => p.type === 9, 'SUBACK');
  const bad = await connectRaw(brokerPort, 'pub-q2');
  bad.stream.send(publish('home/q2/cmd', 'NO', 2, 0x3333));
  await delay(200);
  assert.equal(sub.stream.queue.some((p) => p.type === 3), false);
  assert.equal(bad.stream.queue.some((p) => p.type === 4), false);
  const ok = await connectRaw(brokerPort, 'pub-q2-ok');
  ok.stream.send(publish('home/q2/cmd', 'alive', 0, 0));
  const m = await sub.stream.waitFor((p) => p.type === 3, 'alive');
  assert.equal(parsePayload(m.body), 'alive');
  sub.sock.destroy(); bad.sock.destroy(); ok.sock.destroy();
});

test('broker rejects QoS1 missing/zero PacketId without forwarding', async () => {
  const sub = await connectRaw(brokerPort, 'sub-badpid');
  sub.stream.send(subscribePacket(7, 'home/+/cmd'));
  await sub.stream.waitFor((p) => p.type === 9, 'SUBACK');
  const bad = await connectRaw(brokerPort, 'pub-badpid');
  // Topic length 0xFFFF but body too short
  bad.stream.send(packet(3, 0, Buffer.from([0xFF, 0xFF, 0x41])));
  // Missing Packet Identifier after topic
  bad.stream.send(packet(3, 2, str('home/bad/missing')));
  // Explicit zero Packet Identifier
  bad.stream.send(packet(3, 2, Buffer.concat([str('home/bad/zero'), u16(0)])));
  await delay(150);
  assert.equal(sub.stream.queue.some((p) => p.type === 3), false);
  assert.equal(bad.stream.queue.some((p) => p.type === 4), false);
  // still alive and accepts valid QoS0
  const ok = await connectRaw(brokerPort, 'pub-badpid-ok');
  ok.stream.send(publish('home/bad/cmd', 'ok', 0, 0));
  const m = await sub.stream.waitFor((p) => p.type === 3 && parseTopic(p.body) === 'home/bad/cmd', 'ok');
  assert.equal(parsePayload(m.body), 'ok');
  sub.sock.destroy(); bad.sock.destroy(); ok.sock.destroy();
});
