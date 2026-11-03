'use strict';

/**
 * 测试脚手架：启动 fake 后端 + fake DAYU + 真实 relay（真实 HTTP/WS/TCP 端口），
 * 提供 config 覆盖、日志捕获、session/WS 客户端与等待工具。
 */

const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/logger');
const { createRelay } = require('../../src/relay');
const WebSocket = require('../../src/ws');
const { FakeDayuServer } = require('./fake-dayu');
const { FakeBackend } = require('./fake-backend');

const DEFAULT_VALID_TOKEN = 'test-app-token-0123456789abcdef';

const BASE_ENV = Object.freeze({
  VIDEO_RELAY_HOST: '127.0.0.1',
  VIDEO_RELAY_PORT: '0',
  VIDEO_MODE: 'local',
  BACKEND_BASE: 'http://127.0.0.1:1',
  DAYU_HOST: '127.0.0.1',
  DAYU_PORT: '9301',
  VIDEO_MAX_VIEWERS: '2',
  VIDEO_IDLE_STOP_MS: '300',
  VIDEO_TICKET_TTL_MS: '5000',
  VIDEO_RECONNECT_DELAYS_MS: '100,200',
  VIDEO_DAYU_DOWN_GRACE_MS: '3000',
  VIDEO_HEARTBEAT_MS: '200',
  VIDEO_SESSION_RATE_LIMIT: '100',
  VIDEO_SESSION_RATE_WINDOW_MS: '60000',
  VIDEO_BACKEND_TIMEOUT_MS: '1500',
  VIDEO_ACCESS_LOG: '1',
  VIDEO_LOG_LEVEL: 'debug'
});

function configFor(overrides = {}) {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

function createTestLogger(options = {}) {
  const lines = [];
  const logger = createLogger({
    level: options.level || 'debug',
    sink: (line) => lines.push(line),
    clock: options.clock
  });
  return { logger, lines };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const intervalMs = options.intervalMs || 10;
  const startedAt = Date.now();
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(options.message || `waitFor timeout after ${timeoutMs}ms`);
    }
    await delay(intervalMs);
  }
}

/**
 * 启动完整 local/agent 测试栈。
 *
 * options.env: 覆盖 config 环境变量（BACKEND_BASE / DAYU_PORT 由 harness 自动注入，
 *              显式传入会被覆盖）。
 */
async function startHarness(options = {}) {
  const validToken = options.validToken || DEFAULT_VALID_TOKEN;
  const extraTokens = options.extraTokens || [];
  const backend = new FakeBackend({ tokens: [validToken, ...extraTokens] });
  await backend.start();

  const dayu = new FakeDayuServer({
    frameIntervalMs: options.frameIntervalMs || 40,
    startDelayMs: options.dayuStartDelayMs || 0
  });
  await dayu.start();

  const { logger, lines } = createTestLogger();
  const env = {
    ...(options.env || {}),
    BACKEND_BASE: `http://127.0.0.1:${backend.port}`,
    DAYU_PORT: String(dayu.port)
  };
  const config = configFor(env);
  const relay = createRelay({ config, logger });
  const address = await relay.start();

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsBaseUrl = `ws://127.0.0.1:${address.port}`;

  const harness = {
    relay,
    config,
    backend,
    dayu,
    logger,
    logLines: lines,
    baseUrl,
    wsBaseUrl,
    validToken,
    agentKey: config.agentKey,
    async createSession(token = validToken) {
      const response = await fetch(`${baseUrl}/video/session`, {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {}
      });
      let body = null;
      try {
        body = await response.json();
      } catch (_) {
        body = null;
      }
      return { status: response.status, body };
    },
    async endSession(token = validToken) {
      const response = await fetch(`${baseUrl}/video/session/end`, {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {}
      });
      let body = null;
      try {
        body = await response.json();
      } catch (_) {
        body = null;
      }
      return { status: response.status, body };
    },
    async health() {
      const response = await fetch(`${baseUrl}/video/healthz`);
      return { status: response.status, body: await response.json() };
    },
    async close() {
      try {
        await relay.stop();
      } finally {
        try {
          await dayu.stop();
        } finally {
          await backend.stop();
        }
      }
    }
  };
  return harness;
}

/**
 * 打开一个 viewer WebSocket。返回句柄：
 *   ready: Promise（open 成功）
 *   frames: Buffer[]（已收到的 JPEG）
 *   texts: 服务端文本消息
 *   closed: {code, reason} | null
 */
function openViewer(baseUrl, ticket, options = {}) {
  const wsUrl = `${String(baseUrl).replace(/^http/, 'ws')}/video/stream?ticket=${encodeURIComponent(ticket)}`;
  const state = {
    ws: null,
    frames: [],
    texts: [],
    closed: null,
    errors: [],
    ready: null
  };
  const ws = new WebSocket(wsUrl, { handshakeTimeout: options.handshakeTimeoutMs || 5000 });
  state.ws = ws;
  state.ready = new Promise((resolve, reject) => {
    ws.on('open', () => resolve(state));
    ws.on('error', (error) => reject(error));
  });
  // 避免未 await ready 时 Promise rejection 变成 unhandled。
  state.ready.catch(() => {});
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      state.frames.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    try {
      state.texts.push(JSON.parse(String(data)));
    } catch (_) {
      state.texts.push({ raw: String(data) });
    }
  });
  ws.on('error', (error) => state.errors.push(error));
  ws.on('close', (code, reason) => {
    state.closed = { code, reason: String(reason || '') };
  });
  state.close = () => new Promise((resolve) => {
    if (ws.readyState === 3) return resolve();
    ws.once('close', () => resolve());
    try {
      ws.close(1000, 'test-done');
    } catch (_) {
      resolve();
    }
  });
  return state;
}

/** 打开一个原始未升级的 WS 客户端（用于断言 401 握手被拒）。 */
function tryOpenViewer(baseUrl, ticket) {
  return openViewer(baseUrl, ticket);
}

/** 起 harness、执行、无论成败都清理。 */
async function withHarness(options, fn) {
  const harness = await startHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

module.exports = {
  DEFAULT_VALID_TOKEN,
  BASE_ENV,
  configFor,
  createTestLogger,
  delay,
  waitFor,
  startHarness,
  withHarness,
  openViewer,
  tryOpenViewer,
  WebSocket
};
