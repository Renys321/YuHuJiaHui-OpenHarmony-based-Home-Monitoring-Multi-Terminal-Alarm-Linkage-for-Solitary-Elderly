#!/usr/bin/env node
/**
 * relay 端到端验收客户端（Lead 工具）：用真实 APP 登录 token 申请 ticket，
 * 经 WebSocket 接收 relay 转发的 DAYU200 实时 JPEG 帧，统计真实到达的帧。
 *
 * 用法（token 只经环境变量传入，不打印、不落盘）：
 *   $env:VIDEO_APP_TOKEN='<token>'
 *   node relay-ws-client.js --relay http://127.0.0.1:9443 --seconds 12 --save-dir <dir>
 *
 * 退出码 0 = 鉴权成功 + 收到 ≥10 帧 + 每帧 JPEG 合法 + 帧 hash 逐帧不同 + 主动结束成功。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

function loadWs() {
  const candidates = [
    path.join(__dirname, '..', 'relay', 'vendor', 'ws'),
    path.join(__dirname, '..', '..', 'cloud', 'onenet', 'node_modules', 'ws'),
    'ws'
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (err) { /* try next */ }
  }
  throw new Error('ws module not found');
}

function parseArgs(argv) {
  const args = { relay: 'http://127.0.0.1:9443', seconds: 12, saveDir: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--relay') { args.relay = value; i += 1; }
    else if (key === '--seconds') { args.seconds = Number(value); i += 1; }
    else if (key === '--save-dir') { args.saveDir = value; i += 1; }
  }
  return args;
}

function requestJson(method, urlString, token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlString);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request({
      method,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch (err) { body = { raw: text }; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function wsUrl(baseHttp, wsPath) {
  const base = baseHttp.replace(/\/+$/, '');
  if (base.startsWith('https://')) return `wss://${base.slice('https://'.length)}${wsPath}`;
  if (base.startsWith('http://')) return `ws://${base.slice('http://'.length)}${wsPath}`;
  throw new Error('bad relay base');
}

async function main() {
  const args = parseArgs(process.argv);
  const token = (process.env.VIDEO_APP_TOKEN || '').trim();
  if (!token) { throw new Error('VIDEO_APP_TOKEN is required'); }
  const WebSocket = loadWs();

  const started = Date.now();
  const session = await requestJson('POST', `${args.relay}/video/session`, token);
  if (session.status !== 200 || !session.body || typeof session.body.ticket !== 'string') {
    console.log(JSON.stringify({ ok: false, stage: 'session', status: session.status }, null, 2));
    process.exit(2);
  }
  const wsTarget = args.relay + session.body.wsPath;
  const ws = new WebSocket(wsUrl(args.relay, session.body.wsPath));
  const frameTimes = [];
  const frameHashes = [];
  const frameSizes = [];
  const control = [];
  let jpegValid = 0;
  let jpegInvalid = 0;
  let saved = 0;
  let settled = false;
  let wsError = '';

  const finish = async (code, reason) => {
    if (settled) return;
    settled = true;
    let endStatus = 0;
    try {
      const end = await requestJson('POST', `${args.relay}/video/session/end`, token, 4000);
      endStatus = end.status;
    } catch (err) {
      endStatus = -1;
    }
    const totalMs = Date.now() - started;
    const frames = frameTimes.length;
    const unique = new Set(frameHashes).size;
    const stats = {
      ok: code === 0 && frames >= 10 && jpegInvalid === 0 && unique === frames,
      stage: reason,
      relay: args.relay,
      sessionStatus: session.status,
      ticketIssued: true,
      wsError,
      frames,
      jpegValid,
      jpegInvalid,
      uniqueFrameHashes: unique,
      avgFps: frames > 0 ? Number((frames * 1000 / totalMs).toFixed(2)) : 0,
      minFrameBytes: frames > 0 ? Math.min(...frameSizes) : 0,
      maxFrameBytes: frames > 0 ? Math.max(...frameSizes) : 0,
      savedFrames: saved,
      endStatus,
      controlMessages: control
    };
    console.log(JSON.stringify(stats, null, 2));
    try { ws.close(); } catch (err) { /* ignore */ }
    setTimeout(() => process.exit(stats.ok ? 0 : 1), 200);
  };

  ws.on('open', () => { control.push('ws-open'); });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      control.push(text.slice(0, 160));
      return;
    }
    const jpeg = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const valid = jpeg.length > 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 &&
      jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;
    if (valid) jpegValid += 1; else jpegInvalid += 1;
    frameTimes.push(Date.now() - started);
    frameHashes.push(crypto.createHash('sha1').update(jpeg).digest('hex'));
    frameSizes.push(jpeg.length);
    if (args.saveDir && saved < 5 && valid) {
      fs.mkdirSync(args.saveDir, { recursive: true });
      fs.writeFileSync(path.join(args.saveDir, `relay-live-frame-${String(saved).padStart(2, '0')}.jpg`), jpeg);
      saved += 1;
    }
  });
  ws.on('error', (err) => { wsError = err.message; });
  ws.on('close', () => { control.push('ws-close'); });

  setTimeout(async () => { await finish(0, 'completed-window'); }, args.seconds * 1000);
  setTimeout(async () => { await finish(1, 'hard-timeout'); }, (args.seconds + 20) * 1000);
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, stage: 'exception', error: err.message }, null, 2));
  process.exit(3);
});
