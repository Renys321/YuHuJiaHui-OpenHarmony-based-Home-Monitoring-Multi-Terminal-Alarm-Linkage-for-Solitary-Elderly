#!/usr/bin/env node
/**
 * DAYU200 板端 VideoStreamServer 直连测试客户端（Lead 验收工具）。
 *
 * 用途：经 `hdc fport tcp:9301 tcp:9301` 后，从 PC 连接设备回环 9301，
 * 按契约握手并统计真实 JPEG 帧；用于证明“设备端确实在按需取帧 + 编码 + 发送”。
 * 不生成任何假帧：收到的每一帧都来自 DAYU200 相机 Surface。
 *
 * 用法：
 *   node dayu-frame-client.js --seconds 12 --save-dir <dir> [--host 127.0.0.1] [--port 9301]
 * 输出：JSON 统计 + 可选保存前 5 帧；退出码 0 表示帧数/格式/停止语义全部通过。
 */
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 9301, seconds: 12, saveDir: '', width: 0, height: 0, quality: 0, interval: -1 };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--host') { args.host = value; i += 1; }
    else if (key === '--port') { args.port = Number(value); i += 1; }
    else if (key === '--seconds') { args.seconds = Number(value); i += 1; }
    else if (key === '--save-dir') { args.saveDir = value; i += 1; }
    else if (key === '--width') { args.width = Number(value); i += 1; }
    else if (key === '--height') { args.height = Number(value); i += 1; }
    else if (key === '--quality') { args.quality = Number(value); i += 1; }
    else if (key === '--interval') { args.interval = Number(value); i += 1; }
  }
  return args;
}

const args = parseArgs(process.argv);
const startedAt = Date.now();
const frameTimes = [];
const frameSizes = [];
const frameHashes = [];
let savedFrames = 0;
let jpegValid = 0;
let jpegInvalid = 0;
let controlLines = [];
let pending = Buffer.alloc(0);
let streaming = false;
let finished = false;
let sawStopped = false;
let exitCode = 0;

const sock = net.createConnection({ host: args.host, port: args.port });
sock.setNoDelay(true);

function log(...parts) {
  process.stdout.write(`${parts.join(' ')}\n`);
}

function handleControlLine(line) {
  const text = line.trim();
  if (!text) return;
  controlLines.push(text);
  log(`[control] ${text}`);
  try {
    const msg = JSON.parse(text);
    if (msg.type === 'hello') {
      if (args.width > 0 && args.height > 0) {
        const cfg = { type: 'config', width: args.width, height: args.height };
        if (args.quality > 0) cfg.quality = args.quality;
        if (args.interval >= 0) cfg.intervalMs = args.interval;
        sock.write(`${JSON.stringify(cfg)}\n`);
      }
      sock.write(`${JSON.stringify({ type: 'start', viewer: 'lead-acceptance-client' })}\n`);
    }
  } catch (err) {
    log(`[control-invalid] ${text}`);
  }
}

sock.on('connect', () => {
  log(`[connect] ${args.host}:${args.port} connected`);
});

sock.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  // 控制行阶段：hello/started/stopped 都是 JSON 行
  while (!streaming) {
    const newline = pending.indexOf(0x0a);
    if (newline < 0) return;
    const line = pending.subarray(0, newline).toString('utf8');
    pending = pending.subarray(newline + 1);
    handleControlLine(line);
    if (line.includes('"started"')) streaming = true;
    if (line.includes('"stopped"')) { sawStopped = true; }
    if (line.includes('"busy"')) { log('[error] device busy'); exitCode = 1; finish(); return; }
    if (line.includes('"error"')) { log('[error] device control error'); exitCode = 1; }
  }
  // 帧阶段：4 字节大端长度 + JPEG；期间仍可能收到 JSON 控制行（waiting/stopped/pong）
  while (streaming && pending.length >= 1) {
    if (pending[0] === 0x7b) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) return;
      const line = pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      if (line.includes('"stopped"')) sawStopped = true;
      handleControlLine(line);
      continue;
    }
    if (pending.length < 4) return;
    const length = pending.readUInt32BE(0);
    if (length < 2048 || length > 1048576) {
      log(`[error] invalid frame length ${length}`);
      exitCode = 1;
      finish();
      return;
    }
    if (pending.length < 4 + length) return;
    const jpeg = pending.subarray(4, 4 + length);
    pending = pending.subarray(4 + length);
    const valid = jpeg.length > 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 &&
      jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;
    if (valid) jpegValid += 1; else jpegInvalid += 1;
    frameTimes.push(Date.now() - startedAt);
    frameSizes.push(length);
    frameHashes.push(crypto.createHash('sha1').update(jpeg).digest('hex'));
    if (args.saveDir && savedFrames < 5) {
      fs.mkdirSync(args.saveDir, { recursive: true });
      const name = path.join(args.saveDir, `dayu-live-frame-${String(savedFrames).padStart(2, '0')}.jpg`);
      fs.writeFileSync(name, jpeg);
      savedFrames += 1;
    }
  }
});

function finish() {
  if (finished) return;
  finished = true;
  const totalMs = Date.now() - startedAt;
  const frames = frameTimes.length;
  const uniqueHashes = new Set(frameHashes).size;
  const stats = {
    ok: exitCode === 0 && frames >= 30 && jpegInvalid === 0 && sawStopped,
    host: args.host,
    port: args.port,
    durationMs: totalMs,
    frames,
    jpegValid,
    jpegInvalid,
    uniqueFrameHashes: uniqueHashes,
    avgFps: frames > 0 ? Number((frames * 1000 / totalMs).toFixed(2)) : 0,
    minFrameBytes: frames > 0 ? Math.min(...frameSizes) : 0,
    maxFrameBytes: frames > 0 ? Math.max(...frameSizes) : 0,
    avgFrameBytes: frames > 0 ? Math.round(frameSizes.reduce((a, b) => a + b, 0) / frames) : 0,
    savedFrames,
    sawStopped,
    controlLines
  };
  log(JSON.stringify(stats, null, 2));
  sock.destroy();
  process.exit(exitCode === 0 && stats.ok ? 0 : 1);
}

sock.on('error', (err) => {
  log(`[error] socket: ${err.message}`);
  exitCode = 1;
  finish();
});

sock.on('close', () => {
  log('[close] socket closed');
  finish();
});

setTimeout(() => {
  if (streaming) {
    log('[stop] sending stop control');
    sock.write(`${JSON.stringify({ type: 'stop' })}\n`);
    setTimeout(() => finish(), 800);
  } else {
    exitCode = 1;
    finish();
  }
}, args.seconds * 1000);
