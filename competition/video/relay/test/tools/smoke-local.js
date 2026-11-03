#!/usr/bin/env node
'use strict';

/**
 * 真实网络自测（本机）：真实 relay 进程（local 模式）+ fake DAYU TCP（合成帧）
 * + fake 后端（token 校验替身）；用 node 直连 WebSocket 统计帧。
 *
 * 输出会标注 FAKE-DAYU：帧是 test/tools/jpeg.js 合成的 640x480 JPEG，
 * 图上写着 TEST ONLY，不是真实摄像头画面，不能当验收证据。
 *
 * 用法:
 *   node test/tools/smoke-local.js [--frames 100] [--port 9443] [--stream-ms 25000]
 *
 * 验收点：
 *   - /video/healthz 200 且 connected；
 *   - WS 收到 >= frames 帧，每帧 FF D8 ... FF D9，逐帧 hash 不同；
 *   - WS 打开后 1s 内收到第一帧；
 *   - 关闭 viewer 后 <=5s fake DAYU 收到 stop；
 *   - 全程 curl /video/healthz 的输出被打印并记录。
 */

const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { FakeBackend } = require('./fake-backend');
const { FakeDayuServer } = require('./fake-dayu');
const { delay, waitFor } = require('./harness');
const WebSocket = require('../../src/ws');
const { isJpeg } = require('../../src/frames');
const crypto = require('crypto');

const TOKEN = 'smoke-local-app-token-0123456789';

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

async function waitHealthz(port, timeoutMs = 15000) {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/video/healthz`, { signal: AbortSignal.timeout(1000) });
      return response.status === 200;
    } catch (_) {
      return false;
    }
  }, { timeoutMs, intervalMs: 100, message: `relay ${port} 未在 ${timeoutMs}ms 内就绪` });
}

async function main() {
  const framesTarget = Number(argValue('--frames', '100'));
  const port = Number(argValue('--port', '9443'));
  const streamMs = Number(argValue('--stream-ms', '25000'));
  const fakeDurationMs = 120000;

  const backend = new FakeBackend({ tokens: [TOKEN] });
  await backend.start();
  const dayu = new FakeDayuServer({ frameIntervalMs: 100 }); // 10 fps
  await dayu.start();
  console.log(`[smoke] FAKE-DAYU: synthetic TCP frame source on 127.0.0.1:${dayu.port} (max lifetime ${fakeDurationMs}ms)`);
  console.log(`[smoke] fake backend: http://127.0.0.1:${backend.port} (only for local self-test; not production)`);

  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: {
      ...process.env,
      VIDEO_MODE: 'local',
      VIDEO_RELAY_HOST: '127.0.0.1',
      VIDEO_RELAY_PORT: String(port),
      BACKEND_BASE: `http://127.0.0.1:${backend.port}`,
      DAYU_HOST: '127.0.0.1',
      DAYU_PORT: String(dayu.port),
      VIDEO_ACCESS_LOG: '1',
      VIDEO_LOG_LEVEL: 'debug'
    },
    stdio: 'inherit'
  });
  let childExited = false;
  let stoppingChild = false;
  child.on('exit', (code) => {
    childExited = true;
    if (!stoppingChild && code !== 0) console.error(`[smoke] relay process exited with code ${code}`);
  });

  const fakeLifetime = setTimeout(() => {
    if (!fakeLifetimeDone) dayu.stop().catch(() => {});
  }, fakeDurationMs);
  if (typeof fakeLifetime.unref === 'function') fakeLifetime.unref();
  let fakeLifetimeDone = false;

  let viewer = null;
  const failures = [];
  try {
    await waitHealthz(port);
    console.log(`[smoke] curl healthz #1: ${curlHealthz(port)}`);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/video/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const session = await sessionResponse.json();
    if (sessionResponse.status !== 200 || !session.ticket) {
      throw new Error(`session 创建失败: HTTP ${sessionResponse.status} ${JSON.stringify(session)}`);
    }
    console.log(`[smoke] session ticket prefix=${session.ticket.slice(0, 6)} (完整值不写日志)`);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/video/stream?ticket=${session.ticket}`, {
      perMessageDeflate: false
    });
    viewer = ws;
    const frames = [];
    const readyTexts = [];
    const openedAt = Date.now();
    let firstFrameAt = 0;
    let closed = null;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (frames.length === 0) firstFrameAt = Date.now();
        frames.push(frame);
      } else {
        readyTexts.push(JSON.parse(String(data)));
      }
    });
    ws.on('close', (code, reason) => {
      closed = { code, reason: String(reason || '') };
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    await waitFor(() => frames.length >= framesTarget, {
      timeoutMs: streamMs,
      intervalMs: 20,
      message: `只收到 ${frames.length}/${framesTarget} 帧（${streamMs}ms 内）`
    });

    const hashes = new Set(frames.map(sha));
    const sizes = frames.map((frame) => frame.length);
    const allJpeg = frames.every((frame) => isJpeg(frame));
    console.log(`[smoke] frames=${frames.length} uniqueHashes=${hashes.size} jpeg=${allJpeg}`
      + ` size[min/avg/max]=${Math.min(...sizes)}/${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)}/${Math.max(...sizes)}`);
    console.log(`[smoke] readyTexts=${JSON.stringify(readyTexts)} firstFrameAfterOpenMs=${firstFrameAt - openedAt}`);
    console.log(`[smoke] receiveWindowMs=${firstFrameAt ? Date.now() - firstFrameAt : 0}`
      + ` measuredFps≈${(frames.length / Math.max(1, (Date.now() - firstFrameAt) / 1000)).toFixed(1)}`);

    if (!allJpeg) failures.push('存在非 JPEG 帧');
    if (hashes.size !== frames.length) failures.push('存在重复帧（疑似静态图冒充）');
    if (!(firstFrameAt - openedAt <= 1000)) failures.push('WS 打开后 >1s 才收到第一帧');

    console.log(`[smoke] curl healthz #2 (viewing): ${curlHealthz(port)}`);

    const closedBeforeOwnClose = closed;
    const closeAt = Date.now();
    await new Promise((resolve) => {
      if (ws.readyState === 3) return resolve();
      ws.once('close', resolve);
      ws.close(1000, 'smoke done');
    });
    await waitFor(() => dayu.stops >= 1, {
      timeoutMs: 5000,
      intervalMs: 50,
      message: '最后一个 viewer 关闭后 5s 内 fake DAYU 未收到 stop'
    });
    const stopLatency = dayu.stopEvents[0] - closeAt;
    console.log(`[smoke] idle stop: fake DAYU received stop ${stopLatency}ms after last viewer closed`
      + ` (starts=${dayu.starts} stops=${dayu.stops} framesSent=${dayu.framesSent} connections=${dayu.connections})`);
    await waitFor(async () => {
      const health = await (await fetch(`http://127.0.0.1:${port}/video/healthz`)).json();
      return health.dayuLink === 'down';
    }, { timeoutMs: 3000, intervalMs: 50, message: '空闲停止后 healthz.dayuLink 仍不是 down' });
    console.log(`[smoke] curl healthz #3 (after idle stop): ${curlHealthz(port)}`);

    if (closedBeforeOwnClose !== null) failures.push(`viewer 在看流期间被关闭: ${JSON.stringify(closedBeforeOwnClose)}`);
    if (dayu.stops < 1) failures.push('fake DAYU 未收到 stop');
    if (backend.overviewCalls < 1) failures.push('relay 未调用后端校验 token');
  } finally {
    if (viewer && viewer.readyState === 1) {
      try {
        viewer.close(1000, 'smoke abort');
      } catch (_) {
        // ignore
      }
    }
    fakeLifetimeDone = true;
    clearTimeout(fakeLifetime);
    stoppingChild = true;
    if (!childExited) child.kill('SIGTERM');
    await delay(600);
    await dayu.stop();
    await backend.stop();
  }

  if (failures.length > 0) {
    console.error(`[smoke] FAIL: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('[smoke] PASS: FAKE-DAYU 合成帧经真实 relay local 模式 -> WS 收发验证通过（非真实摄像头画面）');
}

main().catch((error) => {
  console.error(`[smoke] FAIL: ${(error && error.message) || error}`);
  process.exit(1);
});
