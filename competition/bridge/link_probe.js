#!/usr/bin/env node
/**
 * link_probe.js — 模拟"板上 APP"：连到 homemon 的 TCP 通道，打印收到的全部设备状态。
 * 用于验证「其他节点状态经 relay 注入后，板上应用能同时看到多个房间」。
 *
 * 用法： node link_probe.js 127.0.0.1:9000
 */
'use strict';
const net = require('net');
const [host, port] = (process.argv[2] || '127.0.0.1:9000').split(':');
const seen = new Map();
let buf = '';
const s = net.createConnection({ host, port: parseInt(port || '9000', 10) }, () => {
  console.log(`[probe] 已连接 ${host}:${port}（模拟板上应用）`);
});
s.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      seen.set(o.deviceId, (seen.get(o.deviceId) || 0) + 1);
      console.log(`[probe] ← ${o.deviceId} (${o.room || '-'}) state=${o.state} count=${o.sensors && o.sensors.motion ? o.sensors.motion.countToday : '-'}`);
    } catch (e) {
      console.log('[probe] 非 JSON 行:', line.slice(0, 60));
    }
  }
});
s.on('error', (e) => console.error('[probe] 错误:', e.message));
setTimeout(() => {
  console.log('[probe] 汇总：看到 ' + seen.size + ' 个设备 → ' + Array.from(seen.keys()).join(' , '));
  process.exit(0);
}, 20000);
