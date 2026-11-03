'use strict';
/* 只读 MQTT 订阅探针（本任务体检工具）。
 * 目的：给 home/# 的每条 status 打上"本机到达时刻(epoch ms)"，用于计算
 *       上报间隔抖动 = 相邻到达间隔；端到端延迟 = 到达时刻 - 报文 ts。
 * 安全：只发 CONNECT + SUBSCRIBE，绝不 PUBLISH；不写任何 system 状态。
 * 用法：node _probe_mqtt_ts.js 127.0.0.1:1883 "home/#" 65
 */
const net = require('net');

const [host, portStr] = (process.argv[2] || '127.0.0.1:1883').split(':');
const port = parseInt(portStr || '1883', 10);
const topicFilter = process.argv[3] || 'home/#';
const seconds = parseInt(process.argv[4] || '60', 10);

function encLen(n) { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return Buffer.from(o); }
function encStr(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length, 0); return Buffer.concat([l, b]); }
function pkt(type, flags, payload) { return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(payload.length), payload]); }

let buf = Buffer.alloc(0);
let subscribed = false;
const t0 = Date.now();

const sock = net.createConnection({ host, port }, () => {
  sock.write(pkt(1, 0, Buffer.concat([encStr('MQTT'), Buffer.from([4, 0x02, 0, 30]), encStr('probe-' + (Date.now() % 1000000))])));
});
sock.on('error', (e) => { console.log(JSON.stringify({ ev: 'error', msg: e.message })); });
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 2) {
    const type = buf[0] >> 4;
    let mult = 1, i = 1, len = 0, b;
    do { if (i >= buf.length) return; b = buf[i++]; len += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
    if (buf.length < i + len) return;
    const body = buf.slice(i, i + len);
    buf = buf.slice(i + len);
    if (type === 2) { // CONNACK -> now subscribe
      if (!subscribed) {
        subscribed = true;
        sock.write(pkt(8, 2, Buffer.concat([Buffer.from([0, 1]), encStr(topicFilter), Buffer.from([0])])));
        console.log(JSON.stringify({ ev: 'subscribed', at: Date.now(), filter: topicFilter }));
      }
      continue;
    }
    if (type !== 3) continue;
    const tl = body.readUInt16BE(0);
    const topicName = body.slice(2, 2 + tl).toString('utf8');
    const payload = body.slice(2 + tl).toString('utf8');
    const now = Date.now();
    let ts = null, dev = null, state = null, alarm = null;
    try { const o = JSON.parse(payload); ts = o.ts || null; dev = o.deviceId || null; state = o.state || null; alarm = o.alarm ? (o.alarm.type || null) : null; } catch (e) {}
    if (!/\/status$/.test(topicName)) {
      console.log(JSON.stringify({ ev: 'other', at: now, topic: topicName, payload: payload.slice(0, 120) }));
      continue;
    }
    console.log(JSON.stringify({ ev: 'status', at: now, topic: topicName, dev, ts, state, alarm, latencyMs: (ts ? now - ts : null), payloadLen: payload.length }));
  }
});
setTimeout(() => { try { sock.end(); } catch (e) {} console.log(JSON.stringify({ ev: 'end', at: Date.now(), elapsedMs: Date.now() - t0 })); process.exit(0); }, seconds * 1000);
