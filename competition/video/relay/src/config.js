'use strict';

/**
 * 配置加载（全部来自环境变量，契约 §2.1 / §2.2 的可配置项）。
 *
 * 原则：
 *   - 所有值都有默认值，缺省即可在 PC 本地跑起来（local 模式连 127.0.0.1:9301）。
 *   - 模式只有两种：local（relay 自己连 DAYU TCP）与 agent（PC agent 出站注册）。
 *   - 没有 VIDEO_MODE 时按配置推断：给了 VIDEO_AGENT_KEY 就是 agent，否则 local。
 *     两者不会同时活动（契约要求）。
 *   - 本模块不接受、不打印任何密钥；agent key 只在 config 对象内部，日志层会脱敏。
 */

const DEFAULTS = Object.freeze({
  VIDEO_RELAY_HOST: '0.0.0.0',
  VIDEO_RELAY_PORT: '9443',
  VIDEO_MODE: '',
  BACKEND_BASE: 'http://127.0.0.1:8080',
  DAYU_HOST: '127.0.0.1',
  DAYU_PORT: '9301',
  DAYU_CONNECT_TIMEOUT_MS: '2000',
  DAYU_HELLO_TIMEOUT_MS: '2000',
  VIDEO_AGENT_KEY: '',
  VIDEO_MAX_VIEWERS: '2',
  VIDEO_IDLE_STOP_MS: '3000',
  VIDEO_TICKET_TTL_MS: '60000',
  VIDEO_RECONNECT_DELAYS_MS: '500,1000,2000,5000,10000',
  VIDEO_DAYU_DOWN_GRACE_MS: '30000',
  VIDEO_HEARTBEAT_MS: '5000',
  VIDEO_SESSION_RATE_LIMIT: '10',
  VIDEO_SESSION_RATE_WINDOW_MS: '60000',
  VIDEO_BACKEND_TIMEOUT_MS: '5000',
  VIDEO_ACCESS_LOG: '1',
  VIDEO_LOG_LEVEL: 'info'
});

function readRaw(env, name) {
  if (!Object.prototype.hasOwnProperty.call(env, name)) return DEFAULTS[name];
  const value = env[name];
  if (value === undefined || value === null) return DEFAULTS[name];
  return String(value).trim();
}

/**
 * VIDEO_RELAY_PORT 的兼容别名：运维文档/联调时也常用 VIDEO_PORT。
 * 显式设置 VIDEO_RELAY_PORT 时优先；两者都未设置时用默认 9443。
 */
function readRelayPortRaw(env) {
  const explicit = readRaw(env, 'VIDEO_RELAY_PORT');
  if (explicit !== DEFAULTS.VIDEO_RELAY_PORT) return explicit;
  if (Object.prototype.hasOwnProperty.call(env, 'VIDEO_PORT')) return readRaw(env, 'VIDEO_PORT');
  return explicit;
}

function parseIntegerValue(raw, name, { min, max }) {
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`${name} must be an integer (got ${JSON.stringify(text)})`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is out of range`);
  if (value < min || value > max) throw new Error(`${name} must be within ${min}..${max}`);
  return value;
}

function parseIntField(env, name, range) {
  return parseIntegerValue(readRaw(env, name), name, range);
}

function parseBoolField(env, name) {
  const raw = readRaw(env, name).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(raw)) return false;
  throw new Error(`${name} must be one of 1/0 true/false yes/no on/off`);
}

function parseDelays(env) {
  const raw = readRaw(env, 'VIDEO_RECONNECT_DELAYS_MS');
  if (raw === '') throw new Error('VIDEO_RECONNECT_DELAYS_MS must not be empty');
  const delays = raw.split(',').map((part) => {
    if (!/^\d+$/.test(part.trim())) throw new Error('VIDEO_RECONNECT_DELAYS_MS must be comma separated integers');
    return Number(part.trim());
  });
  if (delays.length === 0) throw new Error('VIDEO_RECONNECT_DELAYS_MS must have at least one entry');
  for (const delay of delays) {
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 60000) {
      throw new Error('VIDEO_RECONNECT_DELAYS_MS entries must be within 0..60000');
    }
  }
  return delays;
}

function normalizeBaseUrl(raw) {
  const value = raw || DEFAULTS.BACKEND_BASE;
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error('BACKEND_BASE must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('BACKEND_BASE must use http or https');
  }
  // 统一去掉尾部斜杠，后面拼 /api/v1/overview 时不会出现双斜杠。
  return value.replace(/\/+$/, '');
}

function loadConfig(env = process.env) {
  const relayHost = readRaw(env, 'VIDEO_RELAY_HOST');
  if (relayHost === '') throw new Error('VIDEO_RELAY_HOST must not be empty');

  const agentKey = readRaw(env, 'VIDEO_AGENT_KEY');

  let mode = readRaw(env, 'VIDEO_MODE').toLowerCase();
  if (mode === '') mode = agentKey ? 'agent' : 'local';
  if (mode !== 'local' && mode !== 'agent') {
    throw new Error('VIDEO_MODE must be "local" or "agent"');
  }
  if (mode === 'agent' && agentKey === '') {
    throw new Error('VIDEO_AGENT_KEY is required in agent mode');
  }

  const config = {
    mode,
    relayHost,
    // 0 仅用于测试/高级场景（由内核分配临时端口）；生产默认 9443。
    // 兼容 VIDEO_PORT 别名（显式 VIDEO_RELAY_PORT 优先）。
    relayPort: parseIntegerValue(readRelayPortRaw(env), 'VIDEO_RELAY_PORT', { min: 0, max: 65535 }),
    backendBase: normalizeBaseUrl(readRaw(env, 'BACKEND_BASE')),
    dayuHost: readRaw(env, 'DAYU_HOST') || DEFAULTS.DAYU_HOST,
    dayuPort: parseIntField(env, 'DAYU_PORT', { min: 1, max: 65535 }),
    dayuConnectTimeoutMs: parseIntField(env, 'DAYU_CONNECT_TIMEOUT_MS', { min: 100, max: 60000 }),
    dayuHelloTimeoutMs: parseIntField(env, 'DAYU_HELLO_TIMEOUT_MS', { min: 100, max: 60000 }),
    agentKey,
    maxViewers: parseIntField(env, 'VIDEO_MAX_VIEWERS', { min: 1, max: 16 }),
    idleStopMs: parseIntField(env, 'VIDEO_IDLE_STOP_MS', { min: 0, max: 600000 }),
    ticketTtlMs: parseIntField(env, 'VIDEO_TICKET_TTL_MS', { min: 50, max: 600000 }),
    reconnectDelaysMs: parseDelays(env),
    dayuDownGraceMs: parseIntField(env, 'VIDEO_DAYU_DOWN_GRACE_MS', { min: 50, max: 600000 }),
    heartbeatMs: parseIntField(env, 'VIDEO_HEARTBEAT_MS', { min: 0, max: 60000 }),
    sessionRateLimit: parseIntField(env, 'VIDEO_SESSION_RATE_LIMIT', { min: 1, max: 10000 }),
    sessionRateWindowMs: parseIntField(env, 'VIDEO_SESSION_RATE_WINDOW_MS', { min: 1000, max: 3600000 }),
    backendTimeoutMs: parseIntField(env, 'VIDEO_BACKEND_TIMEOUT_MS', { min: 100, max: 60000 }),
    accessLog: parseBoolField(env, 'VIDEO_ACCESS_LOG'),
    logLevel: readRaw(env, 'VIDEO_LOG_LEVEL').toLowerCase()
  };

  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(config.logLevel)) {
    throw new Error('VIDEO_LOG_LEVEL must be one of debug/info/warn/error/silent');
  }
  if (config.mode === 'local' && config.dayuHost === '') {
    throw new Error('DAYU_HOST must not be empty in local mode');
  }

  return Object.freeze(config);
}

/** 可安全打印的配置摘要（永远不含 agent key）。 */
function publicSummary(config) {
  return {
    mode: config.mode,
    relay: `${config.relayHost}:${config.relayPort}`,
    backendBase: config.backendBase,
    dayu: config.mode === 'local' ? `${config.dayuHost}:${config.dayuPort}` : '-',
    maxViewers: config.maxViewers,
    idleStopMs: config.idleStopMs,
    ticketTtlMs: config.ticketTtlMs,
    heartbeatMs: config.heartbeatMs,
    dayuDownGraceMs: config.dayuDownGraceMs,
    logLevel: config.logLevel
  };
}

module.exports = { DEFAULTS, loadConfig, publicSummary };
