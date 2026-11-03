'use strict';
/**
 * MQTT PUBLISH client tests -- uses the real production MqttClient exported by
 * mqtt_bridge.js. Frames are hand-built from MQTT 3.1.1 bytes; no production encoder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { MqttClient } = require('./mqtt_bridge.js');

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
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function str(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u16(b.length), b]); }
function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(body.length), body]);
}
function publish(topic, payload, qos, pid) {
  const parts = [str(topic)];
  if (qos > 0) parts.push(u16(pid));
  parts.push(Buffer.from(String(payload), 'utf8'));
  return packet(3, (qos & 3) << 1, Buffer.concat(parts));
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parsePackets(state, data) {
  state.buf = Buffer.concat([state.buf, data]);
  while (state.buf.length >= 2) {
    let mult = 1, len = 0, i = 1;
    while (true) {
      if (i >= state.buf.length) return;
      const b = state.buf[i];
      len += (b & 127) * mult;
      mult *= 128;
      i++;
      if ((b & 128) === 0) break;
    }
    const total = i + len;
    if (state.buf.length < total) return;
    const type = state.buf[0] >> 4;
    const flags = state.buf[0] & 0x0f;
    const body = state.buf.slice(i, total);
    state.buf = state.buf.slice(total);
    state.received.push({ type, flags, body });
    if (type === 1) state.sock.write(packet(2, 0, Buffer.from([0, 0])));
  }
}

function startFakeBroker() {
  return new Promise((resolve, reject) => {
    const state = { sock: null, buf: Buffer.alloc(0), received: [], sockets: new Set() };
    const server = net.createServer((sock) => {
      state.sock = sock;
      state.sockets.add(sock);
      sock.on('data', (d) => parsePackets(state, d));
      sock.on('close', () => state.sockets.delete(sock));
      sock.on('error', () => {});
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, state, port: server.address().port });
    });
  });
}

function makeClient(port) {
  const queue = [];
  const waiters = [];
  const client = new MqttClient('127.0.0.1', port, 'bridge-test-' + Date.now(), (topic, payload) => {
    const w = waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve({ topic, payload });
    } else {
      queue.push({ topic, payload });
    }
  });
  client.connect();
  return { client, queue, waiters };
}

function next(state, timeout = TIMEOUT) {
  if (state.queue.length > 0) return Promise.resolve(state.queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('callback timeout')), timeout);
    state.waiters.push({ resolve, reject, timer });
  });
}

async function waitUntil(fn, timeout = TIMEOUT) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await delay(20);
  }
  throw new Error('waitUntil timeout');
}

async function stop(state, fake) {
  const c = state.client;
  c.connected = false;
  c.scheduleReconnect = () => {};
  if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
  try { if (c.sock) c.sock.destroy(); } catch { /* ignore */ }
  for (const s of fake?.state?.sockets || []) {
    try { s.destroy(); } catch { /* ignore */ }
  }
  if (fake?.server) await new Promise((r) => fake.server.close(r));
}

test('bridge client QoS0 callback gets exact topic/payload', async () => {
  const fake = await startFakeBroker();
  const state = makeClient(fake.port);
  await waitUntil(() => fake.state.received.some((p) => p.type === 1));
  fake.state.sock.write(publish('home/dev/status', 'bridge-q0', 0, 0));
  const got = await next(state);
  assert.deepEqual(got, { topic: 'home/dev/status', payload: 'bridge-q0' });
  assert.equal(state.queue.length, 0);
  await stop(state, fake);
});

test('bridge client QoS1 0x1234 callback + exact PUBACK', async () => {
  const fake = await startFakeBroker();
  const state = makeClient(fake.port);
  await waitUntil(() => fake.state.received.some((p) => p.type === 1));
  fake.state.sock.write(publish('home/dev/cmd', '{"cmd":"ack"}', 1, 0x1234));
  const got = await next(state);
  assert.deepEqual(got, { topic: 'home/dev/cmd', payload: '{"cmd":"ack"}' });
  assert.equal(state.queue.length, 0);
  await waitUntil(() => fake.state.received.some((p) => p.type === 4));
  const ack = fake.state.received.find((p) => p.type === 4);
  assert.equal(ack.body.readUInt16BE(0), 0x1234);
  await stop(state, fake);
});

test('bridge client TCP split/glue/multi-byte remaining length', async () => {
  const fake = await startFakeBroker();
  const state = makeClient(fake.port);
  await waitUntil(() => fake.state.received.some((p) => p.type === 1));
  const p1 = publish('home/split/status', 'S'.repeat(300), 0, 0);
  const p2 = publish('home/glue/status', 'B', 0, 0);
  fake.state.sock.write(p1.slice(0, 5));
  await delay(20);
  fake.state.sock.write(Buffer.concat([p1.slice(5), p2]));
  const a = await next(state);
  const b = await next(state);
  assert.equal(a.topic, 'home/split/status');
  assert.equal(a.payload, 'S'.repeat(300));
  assert.deepEqual(b, { topic: 'home/glue/status', payload: 'B' });
  await stop(state, fake);
});

test('bridge client rejects QoS2 and stays alive', async () => {
  const fake = await startFakeBroker();
  const state = makeClient(fake.port);
  await waitUntil(() => fake.state.received.some((p) => p.type === 1));
  fake.state.sock.write(publish('home/q2/cmd', 'bad', 2, 0x4444));
  fake.state.sock.write(packet(3, 6, Buffer.concat([str('home/q3/cmd'), u16(0x5555), Buffer.from('bad3')])));
  await delay(200);
  assert.equal(state.queue.length, 0);
  assert.equal(fake.state.received.some((p) => p.type === 4), false);
  fake.state.sock.write(publish('home/ok/status', 'ok', 0, 0));
  const got = await next(state);
  assert.deepEqual(got, { topic: 'home/ok/status', payload: 'ok' });
  await stop(state, fake);
});

test('bridge client rejects malformed QoS1 (missing/zero PacketId) and stays alive', async () => {
  const fake = await startFakeBroker();
  const state = makeClient(fake.port);
  await waitUntil(() => fake.state.received.some((p) => p.type === 1));
  // Topic length 0xFFFF but body too short
  fake.state.sock.write(packet(3, 0, Buffer.from([0xFF, 0xFF, 0x41])));
  // Missing Packet Id after topic
  fake.state.sock.write(packet(3, 2, str('home/bad/missing')));
  // Zero Packet Id
  fake.state.sock.write(packet(3, 2, Buffer.concat([str('home/bad/zero'), u16(0)])));
  await delay(150);
  assert.equal(state.queue.length, 0);
  assert.equal(fake.state.received.some((p) => p.type === 4), false);
  fake.state.sock.write(publish('home/ok/status', 'ok', 0, 0));
  const got = await next(state);
  assert.deepEqual(got, { topic: 'home/ok/status', payload: 'ok' });
  await stop(state, fake);
});
