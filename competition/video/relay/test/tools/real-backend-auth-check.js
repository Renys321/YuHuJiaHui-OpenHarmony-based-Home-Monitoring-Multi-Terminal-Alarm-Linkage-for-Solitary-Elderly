#!/usr/bin/env node
'use strict';

/**
 * 真实生产后端鉴权探针（不发送、不打印任何 token）：
 *   - relay 配 BACKEND_BASE=https://api.luxunacc.xyz；
 *   - POST /video/session 不带 token -> 401（relay 本地短路，不调后端）；
 *   - POST /video/session 带明显伪造 token -> 401（relay 真实调后端 overview，后端拒绝）。
 *
 * 证明：relay 的鉴权确实是“向后端复核”，不是本地放行；
 * 同时不违反“不对生产做写操作、不打印 token”。
 *
 * 用法:
 *   node test/tools/real-backend-auth-check.js [--port 9444]
 */

const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { delay, waitFor } = require('./harness');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

async function main() {
  const port = Number(argValue('--port', '9444'));
  const relayLines = [];
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: {
      ...process.env,
      VIDEO_MODE: 'local',
      VIDEO_RELAY_HOST: '127.0.0.1',
      VIDEO_RELAY_PORT: String(port),
      BACKEND_BASE: 'https://api.luxunacc.xyz',
      DAYU_HOST: '127.0.0.1',
      DAYU_PORT: '9301',
      VIDEO_ACCESS_LOG: '1',
      VIDEO_LOG_LEVEL: 'info'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = { value: false };
  const stopping = { value: false };
  const capture = (stream) => {
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue;
        relayLines.push(line);
        process.stdout.write(`[relay] ${line}\n`);
      }
    });
  };
  capture(child.stdout);
  capture(child.stderr);
  child.on('exit', (code) => {
    exited.value = true;
    if (!stopping.value && code !== 0) console.error(`[auth-check] relay exited with code ${code}`);
  });

  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/video/healthz`, { signal: AbortSignal.timeout(1000) });
        return response.status === 200;
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 15000, intervalMs: 100, message: 'relay 未就绪' });
    console.log(`[auth-check] curl healthz: ${execFileSync('curl.exe', ['-sS', '--max-time', '5', `http://127.0.0.1:${port}/video/healthz`], { encoding: 'utf8' }).trim()}`);

    // 1) 无 token：relay 直接 401。
    const noToken = await fetch(`http://127.0.0.1:${port}/video/session`, { method: 'POST' });
    const noTokenBody = await noToken.json();
    console.log(`[auth-check] POST /video/session (no token) -> HTTP ${noToken.status} ${JSON.stringify(noTokenBody)}`);

    // 2) 伪造 token：relay 调真实后端 /api/v1/overview，后端拒绝。
    const forgedToken = `forged-${Date.now()}-not-a-real-token`;
    const forged = await fetch(`http://127.0.0.1:${port}/video/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${forgedToken}` }
    });
    const forgedBody = await forged.json();
    console.log(`[auth-check] POST /video/session (forged token) -> HTTP ${forged.status} ${JSON.stringify(forgedBody)}`);
    const backendLog = relayLines.filter((line) => /token verification failed/.test(line)).join('\n');
    console.log(`[auth-check] relay log (verification failed lines):\n${backendLog || '(none)'}`);

    const failures = [];
    if (noToken.status !== 401) failures.push(`no token 期望 401，实际 ${noToken.status}`);
    if (forged.status !== 401) failures.push(`forged token 期望 401，实际 ${forged.status}`);
    if (!/token verification failed/.test(relayLines.join('\n'))) {
      failures.push('relay 未记录后端校验失败（可能没有真正调后端）');
    }
    if (failures.length > 0) {
      console.error(`[auth-check] FAIL: ${failures.join('; ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('[auth-check] PASS: 生产后端真实复核生效，无 token/伪造 token 均 401');
  } finally {
    if (!exited.value) {
      stopping.value = true;
      child.kill('SIGTERM');
    }
    await delay(500);
  }
}

main().catch((error) => {
  console.error(`[auth-check] FAIL: ${(error && error.message) || error}`);
  process.exit(1);
});
