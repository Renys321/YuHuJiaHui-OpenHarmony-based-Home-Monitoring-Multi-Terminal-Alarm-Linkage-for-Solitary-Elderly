#!/usr/bin/env node
'use strict';

/**
 * 真实网络自测（本机，真实 DAYU200）：真实 relay 进程（local 模式）连真实板端
 * 127.0.0.1:9301（hdc fport），WS 收真实 JPEG 帧，验证 relay 端到端不引入额外损坏。
 *
 * 与 smoke-local.js 的区别：
 *   - 帧源是**真实 DAYU200 相机**（不是合成图）；
 *   - token 校验仍用 fake 后端（本机没有生产 APP token，也不能把 token 写进脚本）；
 *     其余链路（relay -> DAYU TCP -> WS -> 客户端）全部真实。
 *
 * 用法:
 *   node test/tools/smoke-real-dayu.js [--frames 20] [--port 9443] [--stream-ms 25000]
 *
 * 收完帧后主动关闭 viewer，检查 relay 日志里 3s 内出现 idle stop（向 DAYU 发 stop）。
 */

const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { FakeBackend } = require('./fake-backend');
const { delay, waitFor } = require('./harness');
const WebSocket = require('../../src/ws');
const { isJpeg, jpegDimensions } = require('./jpeg');

const TOKEN = 'smoke-real-dayu-app-token-0123456789';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function curlHealthz(port) {
  return execFileSync('curl.exe', ['-sS', '--max-time', '5', `http://127.0.0.1:${port}/video/healthz`], {
    encoding: 'utf8'
  }).trim();
}

async function main() {
  const framesTarget = Number(argValue('--frames', '20'));
  const port = Number(argValue('--port', '9443'));
  const streamMs = Number(argValue('--stream-ms', '25000'));

  const backend = new FakeBackend({ tokens: [TOKEN] });
  await backend.start();
  console.log('[smoke-real] REAL-DAYU source: 127.0.0.1:9301 (hdc fport), backend=fake (token 校验替身)');

  const relayLines = [];
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: {
      ...process.env,
      VIDEO_MODE: 'local',
      VIDEO_RELAY_HOST: '127.0.0.1',
      VIDEO_RELAY_PORT: String(port),
      BACKEND_BASE: `http://127.0.0.1:${backend.port}`,
      DAYU_HOST: '127.0.0.1',
      DAYU_PORT: '9301',
      VIDEO_ACCESS_LOG: '1',
      VIDEO_LOG_LEVEL: 'debug'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const relayExited = { value: false };
  const stoppingChild = { value: false };
  const capture = (stream) => {
    stream.on('data', (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        relayLines.push(line);
        process.stdout.write(`[relay] ${line}\n`);
      }
    });
  };
  capture(child.stdout);
  capture(child.stderr);
  child.on('exit', (code) => {
    relayExited.value = true;
    if (!stoppingChild.value && code !== 0) console.error(`[smoke-real] relay exited with code ${code}`);
  });

  const failures = [];
  let viewer = null;
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/video/healthz`, { signal: AbortSignal.timeout(1000) });
        return response.status === 200;
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15000, intervalMs: 100, message: 'relay 未在 15s 内就绪' });
    console.log(`[smoke-real] curl healthz #1: ${curlHealthz(port)}`);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/video/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const session = await sessionResponse.json();
    if (sessionResponse.status !== 200 || !session.ticket) {
      throw new Error(`session 创建失败: HTTP ${sessionResponse.status}`);
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/video/stream?ticket=${session.ticket}`, {
      perMessageDeflate: false
    });
    viewer = ws;
    const frames = [];
    const openedAt = Date.now();
    let firstFrameAt = 0;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        console.log(`[smoke-real] control text: ${String(data)}`);
        return;
      }
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (frames.length === 0) firstFrameAt = Date.now();
      frames.push(frame);
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    await waitFor(() => frames.length >= framesTarget, {
      timeoutMs: streamMs,
      intervalMs: 20,
      message: `只收到 ${frames.length}/${framesTarget} 帧真实画面`
    });
    const dimensions = jpegDimensions(frames[0]);
    const hashes = new Set(frames.map(sha));
    const sizes = frames.map((frame) => frame.length);
    const fps = Number((frames.length / Math.max(1, (Date.now() - firstFrameAt) / 1000)).toFixed(2));
    console.log(`[smoke-real] REAL frames=${frames.length} uniqueHashes=${hashes.size}`
      + ` size[min/avg/max]=${Math.min(...sizes)}/${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)}/${Math.max(...sizes)}`
      + ` dimensions=${JSON.stringify(dimensions)} firstFrameAfterOpenMs=${firstFrameAt - openedAt} fps≈${fps}`);
    if (!frames.every((frame) => isJpeg(frame))) failures.push('存在非 JPEG 帧');
    if (hashes.size !== frames.length) failures.push('存在重复帧（疑似静态图/旧帧冒充）');
    if (!dimensions || dimensions.width !== 640 || dimensions.height !== 480) {
      failures.push(`分辨率不是 640x480: ${JSON.stringify(dimensions)}`);
    }
    if (!(firstFrameAt - openedAt <= 3000)) failures.push('首帧延迟过大');
    if (!(fps >= 2.5)) failures.push(`实测 fps ${fps} < 2.5`);

    console.log(`[smoke-real] curl healthz #2 (viewing): ${curlHealthz(port)}`);

    await new Promise((resolve) => {
      if (ws.readyState === 3) return resolve();
      ws.once('close', resolve);
      ws.close(1000, 'smoke done');
    });
    await waitFor(() => relayLines.some((line) => /idle stop: no viewers/.test(line)), {
      timeoutMs: 6000,
      intervalMs: 50,
      message: 'relay 日志未出现 idle stop（未向 DAYU 发 stop）'
    });
    console.log('[smoke-real] relay log confirmed idle stop -> DAYU stop sent');
    await waitFor(async () => {
      const health = await (await fetch(`http://127.0.0.1:${port}/video/healthz`)).json();
      return health.dayuLink === 'down';
    }, { timeoutMs: 4000, intervalMs: 50, message: 'idle stop 后 healthz.dayuLink 仍不是 down' });
    console.log(`[smoke-real] curl healthz #3 (after idle stop): ${curlHealthz(port)}`);
  } finally {
    if (viewer && viewer.readyState === 1) {
      try {
        viewer.close(1000, 'smoke abort');
      } catch (_) {
        // ignore
      }
    }
    if (!relayExited.value) {
      stoppingChild.value = true;
      child.kill('SIGTERM');
    }
    await delay(700);
    await backend.stop();
  }

  if (failures.length > 0) {
    console.error(`[smoke-real] FAIL: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('[smoke-real] PASS: 真实 DAYU200 帧经真实 relay local 模式 -> WS 验证通过');
}

main().catch((error) => {
  console.error(`[smoke-real] FAIL: ${(error && error.message) || error}`);
  process.exit(1);
});
