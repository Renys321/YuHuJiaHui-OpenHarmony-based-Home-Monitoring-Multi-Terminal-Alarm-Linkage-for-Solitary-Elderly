#!/usr/bin/env node
/**
 * 现场断连/恢复连续取证（只读）：
 *  - 订阅本地 MQTT home/+/status，逐条记录接收时间（毫秒）+ 原始 JSON
 *  - 每 30s 抓一次生产 /api/v1/devices（紧凑摘要）与 /alerts 数量
 * 不打印任何凭据。用法: node live-monitor.js <out.ndjson>
 */
'use strict';
const fs = require('fs');
const net = require('net');
const https = require('https');
const path = require('path');

const OUT = process.argv[2] || path.join(__dirname, 'live-monitor.ndjson');
const out = fs.createWriteStream(OUT, { flags: 'a' });
function rec(o) { out.write(JSON.stringify(o) + '\n'); }

/* ---- 手写 MQTT 3.1.1 订阅 ---- */
function encLen(n) { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return Buffer.from(o); }
function encStr(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length, 0); return Buffer.concat([l, b]); }
function pkt(type, flags, payload) { return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(payload.length), payload]); }

function connectMqtt() {
  const sock = net.createConnection({ host: '127.0.0.1', port: 1883 }, () => {
    sock.write(pkt(1, 0, Buffer.concat([encStr('MQTT'), Buffer.from([4, 0x02, 0, 30]),
      encStr('monitor-' + Date.now() % 1000000)])));
  });
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      let mult = 1, len = 0, i = 1, done = false;
      for (;;) {
        if (i >= buf.length) return;
        const b = buf[i]; len += (b & 127) * mult; mult *= 128; i++;
        if ((b & 128) === 0) { done = true; break; }
      }
      if (!done || buf.length < i + len) return;
      const type = buf[0] >> 4;
      const body = buf.slice(i, i + len);
      buf = buf.slice(i + len);
      if (type === 2) {
        if (body[1] !== 0) { rec({ t: Date.now(), kind: 'mqtt_connack_error', rc: body[1] }); continue; }
        sock.write(pkt(8, 2, Buffer.concat([Buffer.from([0, 1]), encStr('home/+/status'), Buffer.from([0])])));
      } else if (type === 3) {
        const tlen = body.readUInt16BE(0);
        const topic = body.slice(2, 2 + tlen).toString('utf8');
        const msg = body.slice(2 + tlen).toString('utf8');
        let obj = null; try { obj = JSON.parse(msg); } catch (_) {}
        rec({ t: Date.now(), kind: 'mqtt_status', topic, obj, raw: obj ? undefined : msg });
      }
    }
  });
  sock.on('error', () => setTimeout(connectMqtt, 3000));
  sock.on('close', () => setTimeout(connectMqtt, 3000));
}
rec({ t: Date.now(), kind: 'monitor_start', out: OUT });
connectMqtt();

/* ---- 生产 API 每 30s 摘要（凭据只读、不打印） ---- */
const SECRETS = 'D:\\OpenHarmony\\competition\\.secrets\\app_guardian.txt';
let token = null;
function req(method, p, body, tok) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'content-type': 'application/json' };
    if (data) headers['content-length'] = data.length;
    if (tok) headers.authorization = 'Bearer ' + tok;
    const r = https.request({ hostname: 'api.luxunacc.xyz', path: p, method, headers, timeout: 12000 }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function login() {
  try {
    const lines = fs.readFileSync(SECRETS, 'utf8').split(/\r?\n/).filter(Boolean);
    const a = await req('POST', '/api/v1/auth/app', { guardianId: lines[0].trim(), password: lines[1].trim() });
    if (a.status === 200 && a.json && a.json.sessionToken) { token = a.json.sessionToken; rec({ t: Date.now(), kind: 'api_login', ok: true }); }
    else rec({ t: Date.now(), kind: 'api_login', ok: false, status: a.status });
  } catch (e) { rec({ t: Date.now(), kind: 'api_login', ok: false, err: e.message }); }
}
async function poll() {
  if (!token) await login();
  if (!token) return;
  try {
    const d = await req('GET', '/api/v1/devices', null, token);
    if (d.status === 401) { token = null; await login(); return; }
    const devs = (d.json && d.json.devices) || [];
    rec({
      t: Date.now(), kind: 'api_devices',
      devices: devs.map((x) => ({ deviceId: x.deviceId, online: x.online, state: x.state, lastSeenTs: x.lastSeenTs, alarm: x.sensors && x.alarm ? undefined : undefined }))
    });
    const a = await req('GET', '/api/v1/alerts', null, token);
    const alerts = (a.json && a.json.alerts) || [];
    rec({ t: Date.now(), kind: 'api_alerts', count: alerts.length, top: alerts.slice(0, 5).map((x) => ({ alarmId: x.alarmId || x.id, deviceId: x.deviceId, type: x.type, state: x.state, createdAt: x.createdAt, ackPending: x.ackPending })) });
  } catch (e) { rec({ t: Date.now(), kind: 'api_poll_error', err: e.message }); }
}
setTimeout(() => { login().then(() => { poll(); setInterval(poll, 30000); }); }, 2000);
