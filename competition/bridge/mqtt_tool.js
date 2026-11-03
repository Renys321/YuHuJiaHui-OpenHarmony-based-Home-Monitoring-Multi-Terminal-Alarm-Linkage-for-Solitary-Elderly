#!/usr/bin/env node
/**
 * mqtt_tool.js — 极简 MQTT 3.1.1 命令行工具（订阅 / 发布），零依赖。
 *
 * 用途：
 * 1) 验证 mqtt_bridge.js 的上行/下行是否通；
 * 2) 比赛演示"多终端推送"——可同时开多个 sub 模拟子女手机 / 网格员 / 物业。
 *
 * 用法：
 * node mqtt_tool.js sub --broker broker.emqx.io:1883 --topic "home/dayu200-01/#" --seconds 15
 * node mqtt_tool.js pub --broker broker.emqx.io:1883 --topic home/dayu200-01/cmd \
 * --msg '{"cmd":"ack","alarmId":"a-1","action":"已联系社区网格员上门"}'
 */
'use strict';
const net = require('net');

function parseArgs(argv) {
  const a = { _: argv[2] };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}
const a = parseArgs(process.argv);
const mode = a._;
const [host, portStr] = (a.broker || 'broker.emqx.io:1883').split(':');
const port = parseInt(portStr || '1883', 10);
const topic = a.topic || 'home/dayu200-01/#';
const seconds = parseInt(a.seconds || '15', 10);

function encLen(n) { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return Buffer.from(o); }
function encStr(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length, 0); return Buffer.concat([l, b]); }
function pkt(type, flags, payload) { return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(payload.length), payload]); }

const sock = net.createConnection({ host, port }, () => {
  const connect = Buffer.concat([
    encStr('MQTT'), Buffer.from([4, 0x02, 0, 30]),
    encStr(`tool-${mode}-${Date.now() % 100000}`)
  ]);
  sock.write(pkt(1, 0, connect));
});

let buf = Buffer.alloc(0);
let pid = 1;

sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 2) {
    let mult = 1, len = 0, i = 1;
    while (true) {
      if (i >= buf.length) return;
      const b = buf[i]; len += (b & 127) * mult; mult *= 128; i++;
      if ((b & 128) === 0) break;
    }
    const total = i + len;
    if (buf.length < total) return;
    const type = buf[0] >> 4;
    const body = buf.slice(i, total);
    buf = buf.slice(total);

    if (type === 2) {                                   // CONNACK
      if (body[1] !== 0) { console.error('CONNACK rc=', body[1]); process.exit(1); }
      console.log(`[tool] 已连接 ${host}:${port}`);
      if (mode === 'sub') {
        const p = Buffer.concat([Buffer.from([0, pid]), encStr(topic), Buffer.from([0])]);
        pid++;
        sock.write(pkt(8, 2, p));
      } else if (mode === 'pub') {
        let msg = a.msg || '{}';
        if (a['msg-file']) {
          try { msg = require('fs').readFileSync(a['msg-file'], 'utf8').trim(); }
          catch (e) { console.error('[tool] 读取 --msg-file 失败:', e.message); process.exit(1); }
        }
        const payload = Buffer.concat([encStr(topic), Buffer.from(msg, 'utf8')]);
        sock.write(pkt(3, 0, payload));
        console.log(`[tool] 已发布 → ${topic}: ${msg}`);
        setTimeout(() => process.exit(0), 500);
      }
    } else if (type === 9) {                            // SUBACK
      console.log(`[tool] 订阅成功 ${topic}，监听 ${seconds} 秒…`);
      setTimeout(() => { console.log('[tool] 结束'); process.exit(0); }, seconds * 1000);
    } else if (type === 3) {                            // PUBLISH
      const tlen = body.readUInt16BE(0);
      const t = body.slice(2, 2 + tlen).toString('utf8');
      const msg = body.slice(2 + tlen).toString('utf8');
      console.log(`[tool] ← ${t}\n        ${msg}`);
    }
  }
});

sock.on('error', (e) => { console.error('[tool] 错误:', e.message); process.exit(1); });
