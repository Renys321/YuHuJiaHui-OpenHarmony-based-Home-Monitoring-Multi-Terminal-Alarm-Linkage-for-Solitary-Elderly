#!/usr/bin/env node
/**
 * 帧率测量客户端（独立文件，避免与其他会话共享工具冲突）。
 * 连接 DAYU VideoStreamServer，发送 config（可选 crop）与 start，统计真实收到的帧。
 * 用法：node fps-client.js --host 10.127.130.131 --port 9301 --seconds 20 --width 320 --height 240 --quality 60 --interval 0 --crop 1
 */
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function parseArgs(argv) {
  const a = { host: '127.0.0.1', port: 9301, seconds: 20, saveDir: '', width: 0, height: 0, quality: 0, interval: -1, crop: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--host') { a.host = v; i += 1; }
    else if (k === '--port') { a.port = num(v, 9301); i += 1; }
    else if (k === '--seconds') { a.seconds = num(v, 20); i += 1; }
    else if (k === '--save-dir') { a.saveDir = v; i += 1; }
    else if (k === '--width') { a.width = num(v, 0); i += 1; }
    else if (k === '--height') { a.height = num(v, 0); i += 1; }
    else if (k === '--quality') { a.quality = num(v, 0); i += 1; }
    else if (k === '--interval') { a.interval = num(v, -1); i += 1; }
    else if (k === '--crop') { a.crop = num(v, 0); i += 1; }
  }
  return a;
}
const args = parseArgs(process.argv);
const startedAt = Date.now();
const frameTimes = []; const frameSizes = []; const hashes = [];
const control = [];
let pending = Buffer.alloc(0);
let streaming = false; let finished = false; let saved = 0;
let jpegValid = 0; let jpegInvalid = 0; let firstFrameAt = 0; let helloAt = 0; let startAt = 0;
const sock = net.createConnection({ host: args.host, port: args.port });
sock.setNoDelay(true);
function log(...p) { process.stdout.write(p.join(' ') + '\n'); }
function finish() {
  if (finished) return; finished = true;
  const totalMs = Date.now() - startedAt;
  const frames = frameTimes.length; const unique = new Set(hashes).size;
  const out = {
    ok: frames >= 20 && jpegInvalid === 0 && unique === frames,
    host: args.host, port: args.port, durationMs: totalMs,
    width: args.width, height: args.height, quality: args.quality, interval: args.interval, crop: args.crop,
    frames, jpegValid, jpegInvalid, uniqueFrameHashes: unique,
    avgFps: frames > 0 ? Number((frames * 1000 / totalMs).toFixed(2)) : 0,
    minFrameBytes: frames ? Math.min(...frameSizes) : 0,
    maxFrameBytes: frames ? Math.max(...frameSizes) : 0,
    avgFrameBytes: frames ? Math.round(frameSizes.reduce((a, b) => a + b, 0) / frames) : 0,
    firstFrameAfterHelloMs: firstFrameAt && helloAt ? firstFrameAt - helloAt : -1,
    firstFrameAfterStartMs: firstFrameAt && startAt ? firstFrameAt - startAt : -1,
    controlLines: control
  };
  log(JSON.stringify(out, null, 2));
  try { sock.destroy(); } catch (e) { /* ignore */ }
  process.exit(out.ok ? 0 : 1);
}
sock.on('connect', () => log(`[connect] ${args.host}:${args.port}`));
sock.on('error', (e) => { log('[error] ' + e.message); finish(); });
sock.on('close', () => { log('[close]'); finish(); });
sock.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (streaming && pending.length > 0 && pending[0] === 0x7b) {
    const nl = pending.indexOf(0x0a);
    if (nl < 0) return;
    control.push(pending.subarray(0, nl).toString('utf8'));
    pending = pending.subarray(nl + 1);
  }
  while (!streaming) {
    const nl = pending.indexOf(0x0a);
    if (nl < 0) return;
    const line = pending.subarray(0, nl).toString('utf8').trim();
    pending = pending.subarray(nl + 1);
    if (!line) continue;
    control.push(line);
    let msg = null; try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.type === 'hello') {
      helloAt = Date.now();
      if (args.width > 0 && args.height > 0) {
        const cfg = { type: 'config', width: args.width, height: args.height };
        if (args.quality > 0) cfg.quality = args.quality;
        if (args.interval >= 0) cfg.intervalMs = args.interval;
        if (args.crop > 0) cfg.crop = 1;
        sock.write(JSON.stringify(cfg) + '\n');
      }
      sock.write(JSON.stringify({ type: 'start', viewer: 'fps-measure' }) + '\n');
      startAt = Date.now();
    } else if (msg.type === 'started') { streaming = true; }
    else if (msg.type === 'error') { log('[server-error] ' + line); }
  }
  while (streaming && pending.length >= 4) {
    const len = pending.readUInt32BE(0);
    if (len < 2048 || len > 1048576) { log('[bad-length] ' + len); finish(); return; }
    if (pending.length < 4 + len) return;
    const jpg = pending.subarray(4, 4 + len);
    pending = pending.subarray(4 + len);
    const ok = jpg[0] === 0xff && jpg[1] === 0xd8 && jpg[jpg.length - 2] === 0xff && jpg[jpg.length - 1] === 0xd9;
    if (ok) jpegValid += 1; else jpegInvalid += 1;
    const now = Date.now();
    if (!firstFrameAt) firstFrameAt = now;
    frameTimes.push(now - startedAt); frameSizes.push(len);
    hashes.push(crypto.createHash('sha1').update(jpg).digest('hex'));
    if (args.saveDir && saved < 5 && ok) {
      fs.mkdirSync(args.saveDir, { recursive: true });
      fs.writeFileSync(path.join(args.saveDir, `frame-${String(saved).padStart(2, '0')}.jpg`), jpg);
      saved += 1;
    }
  }
});
setTimeout(() => finish(), args.seconds * 1000);
