#!/usr/bin/env node
/**
 * mqtt_broker.js — 极简 MQTT 3.1.1 Broker（零依赖，仅用于本项目自包含演示/测试）
 *
 * 为什么自带一个：
 * 本机到 broker.emqx.io:1883 不通（TCP 1883 被拦），赛场 WiFi 也可能封端口，
 * 依赖公网 broker 的演示太脆。自带这个最小 broker，本机/局域网内就能跑通
 * 「板子 -> 桥接 -> 云(MQTT) -> 多台手机 APP」全链路。
 *
 * 支持：CONNECT/CONNACK、SUBSCRIBE/SUBACK、PUBLISH(QoS0)、PINGREQ/PINGRESP、DISCONNECT
 * 主题通配：+（单层）与 #（多层）
 *
 * 用法：node mqtt_broker.js [port] 默认 1883
 */
'use strict';
const net = require('net');

const PORT = parseInt(process.argv[2] || '1883', 10);
const clients = new Set();

function encLen(n) { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return Buffer.from(o); }
function encStr(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length, 0); return Buffer.concat([l, b]); }
function pkt(type, flags, payload) { return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(payload.length), payload]); }

/** MQTT 主题匹配：filter 可含 + / # */
function topicMatch(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;                       // 多层通配，匹配剩余全部
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;     // + 为单层通配
  }
  return f.length === t.length;
}

const server = net.createServer((sock) => {
  const c = { sock, subs: new Set(), id: '-', buf: Buffer.alloc(0) };
  clients.add(c);
  console.log(`[broker] + 连接来自 ${sock.remoteAddress}:${sock.remotePort}（当前 ${clients.size} 个）`);

  sock.on('data', (d) => {
    c.buf = Buffer.concat([c.buf, d]);
    while (c.buf.length >= 2) {
      let mult = 1, len = 0, i = 1;
      while (true) {
        if (i >= c.buf.length) return;
        const b = c.buf[i]; len += (b & 127) * mult; mult *= 128; i++;
        if ((b & 128) === 0) break;
      }
      const total = i + len;
      if (c.buf.length < total) return;
      const type = c.buf[0] >> 4;
      const flags = c.buf[0] & 0x0f;
      const body = c.buf.slice(i, total);
      c.buf = c.buf.slice(total);

      try {
      if (type === 1) {                                  // CONNECT
        // 畸形/截断的 CONNECT（比如只有 3 字节 body）不能让整个 broker 崩：
        // 协议名长度、clientId 长度都先查边界，超界就直接丢弃这条连接，别 throw。
        if (body.length < 2) {
          console.error('[broker] CONNECT 拒绝 code=TRUNCATED');
          sock.destroy();
          return;
        }
        const plen = body.readUInt16BE(0);
        if (plen < 1 || plen > 64 || body.length < 2 + plen + 4) {
          console.error('[broker] CONNECT 拒绝 code=INVALID_VARIABLE_HEADER');
          sock.destroy();
          return;
        }
        let off = 2 + plen + 1 + 1 + 2;                  // proto + level + flags + keepalive
        if (off + 2 > body.length) {
          console.error('[broker] CONNECT 拒绝 code=MISSING_CLIENT_ID_LENGTH');
          sock.destroy();
          return;
        }
        const idl = body.readUInt16BE(off); off += 2;
        if (off + idl > body.length) {
          console.error('[broker] CONNECT 拒绝 code=TRUNCATED_CLIENT_ID');
          sock.destroy();
          return;
        }
        c.id = body.slice(off, off + idl).toString('utf8');
        sock.write(pkt(2, 0, Buffer.from([0, 0])));      // CONNACK 成功
        console.log(`[broker] CONNACK → ${c.id}`);
      } else if (type === 8) {                           // SUBSCRIBE
        if (body.length < 2) {
          console.error('[broker] SUBSCRIBE 拒绝 code=TRUNCATED');
          continue;
        }
        const pid = body.readUInt16BE(0);
        let off = 2;
        const granted = [];
        while (off < body.length) {
          if (off + 2 > body.length) {
            console.error('[broker] SUBSCRIBE 拒绝 code=TRUNCATED_TOPIC_LENGTH');
            break;
          }
          const tl = body.readUInt16BE(off); off += 2;
          if (tl === 0 || off + tl + 1 > body.length) {
            console.error('[broker] SUBSCRIBE 拒绝 code=INVALID_TOPIC_LENGTH');
            break;
          }
          const filter = body.slice(off, off + tl).toString('utf8'); off += tl;
          const qos = body[off]; off += 1;
          c.subs.add(filter);
          granted.push(qos);
          console.log(`[broker] SUBSCRIBE ${c.id} → ${filter}`);
        }
        sock.write(pkt(9, 0, Buffer.concat([Buffer.from([pid >> 8, pid & 0xff]), Buffer.from(granted)])));
      } else if (type === 3) {                           // PUBLISH
        // PUBLISH 变长头顺序：topic 长度(2) → topic → [QoS>0 时的 packetId(2)] → payload，
        // 先读 topic 再读 packetId。往下转发一律用 QoS0。
        const qos = (flags >> 1) & 0x03;
        if (qos !== 0 && qos !== 1) {
          console.error(`[broker] PUBLISH 拒绝 code=UNSUPPORTED_QOS qos=${qos}`);
          continue;
        }
        if (body.length < 2) {
          console.error('[broker] PUBLISH 拒绝 code=TRUNCATED_TOPIC_LENGTH');
          continue;
        }
        const tl = body.readUInt16BE(0);
        if (tl === 0 || body.length < 2 + tl) {
          console.error('[broker] PUBLISH 拒绝 code=INVALID_TOPIC_LENGTH');
          continue;
        }
        const topic = body.slice(2, 2 + tl).toString('utf8');
        let off = 2 + tl;
        let pubPid = 0;
        if (qos === 1) {
          if (body.length < off + 2) {
            console.error('[broker] PUBLISH 拒绝 code=MISSING_PACKET_ID');
            continue;
          }
          pubPid = body.readUInt16BE(off);
          if (pubPid === 0) {
            console.error('[broker] PUBLISH 拒绝 code=ZERO_PACKET_ID');
            continue;
          }
          off += 2;
        }
        const payload = body.slice(off);
        if (qos === 1) {
          sock.write(pkt(4, 0, Buffer.from([pubPid >> 8, pubPid & 0xff])));
        }
        let n = 0;
        for (const cl of clients) {
          for (const f of cl.subs) {
            if (topicMatch(f, topic)) {
              cl.sock.write(pkt(3, 0, Buffer.concat([encStr(topic), payload])));
              n++;
              break;
            }
          }
        }
        console.log(`[broker] PUBLISH ${topic} (${payload.length}B) → 转发给 ${n} 个订阅者`);
      } else if (type === 12) {                          // PINGREQ
        sock.write(pkt(13, 0, Buffer.alloc(0)));
      }
      } catch (err) {
        // 单个畸形报文只断开这一条连接，不拖垮 broker 进程。
        console.error(`[broker] 丢弃畸形报文 code=PACKET_HANDLE_FAILED type=${type} err=${err && err.message ? err.message : err}`);
        sock.destroy();
        return;
      }
    }
  });

  const bye = () => {
    clients.delete(c);
    console.log(`[broker] - 断开 ${c.id}（当前 ${clients.size} 个）`);
  };
  sock.on('close', bye);
  sock.on('error', bye);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[broker] 监听 0.0.0.0:${PORT}（自包含 MQTT broker，Ctrl+C 退出）`);
  });
}
module.exports = { server, topicMatch };
