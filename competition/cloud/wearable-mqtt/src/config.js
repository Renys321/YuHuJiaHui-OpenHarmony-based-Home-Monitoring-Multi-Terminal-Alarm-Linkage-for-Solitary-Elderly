'use strict';

/**
 * config.js — 环境变量解析与严格校验（fail-fast，错误信息不含任何密钥值）。
 *
 * 必需变量（缺失即拒绝启动）：
 *   MQTT_USER / MQTT_PASS / INGEST_KEY
 * 可选变量（有生产默认值）：
 *   MQTT_PORT=1883、MQTT_CLIENT_ID=wearable-sos-001、
 *   UP_TOPIC=eldercare/wearable/sos-001/up、DOWN_TOPIC=eldercare/wearable/sos-001/down、
 *   BACKEND_BASE=http://backend:8080、DEVICE_ID=esp32-sos、
 *   LOCATION_DEVICE_ID=wearable-sos-001（仅身份/诊断，公网后端没有 location 路由）、
 *   DEVICE_MQTT_CLIENT_ID=<MQTT_CLIENT_ID 的第一个>（设备侧 MQTT 身份，用于链路恢复事件）、
 *   DATA_DIR=<cwd>/data、STATUS_HOST=127.0.0.1、STATUS_PORT=8099、
 *   DEVICE_ALIVE_TIMEOUT_MS=120000（业务上行静默多久判设备离线并如实上报 online=false）
 */

const path = require('node:path');

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ROOM = '随身求助';

const DEFAULTS = Object.freeze({
  MQTT_PORT: 1883,
  MQTT_CLIENT_ID: 'wearable-sos-001',
  UP_TOPIC: 'eldercare/wearable/sos-001/up',
  DOWN_TOPIC: 'eldercare/wearable/sos-001/down',
  BACKEND_BASE: 'http://backend:8080',
  DEVICE_ID: 'esp32-sos',
  LOCATION_DEVICE_ID: 'wearable-sos-001',
  STATUS_HOST: '127.0.0.1',
  STATUS_PORT: 8099
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(env, name) {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function parseInteger(env, name, fallback, min, max) {
  const raw = readString(env, name);
  if (raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requireString(env, name) {
  const value = readString(env, name);
  if (value === '') throw new Error(`${name} is required`);
  return value;
}

function parseTopic(env, name, fallback) {
  const value = readString(env, name) || fallback;
  if (value.length === 0 || value.length > 1024) throw new Error(`${name} must be 1..1024 characters`);
  if (/[\u0000#+]/.test(value)) throw new Error(`${name} must not contain wildcards or NUL`);
  return value;
}

function parseBackendBase(env) {
  const raw = readString(env, 'BACKEND_BASE') || DEFAULTS.BACKEND_BASE;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('BACKEND_BASE must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('BACKEND_BASE must use http or https');
  }
  if (parsed.username || parsed.password) throw new Error('BACKEND_BASE must not contain credentials');
  if (parsed.search || parsed.hash) throw new Error('BACKEND_BASE must not contain query or fragment');
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

/**
 * @param {object} env process.env 形状
 * @param {object} [overrides] 测试/嵌入场景直接覆盖解析结果（优先级最高）
 */
function loadConfig(env = process.env, overrides = {}) {
  if (!isPlainObject(env)) throw new TypeError('env must be an object');
  if (!isPlainObject(overrides)) throw new TypeError('overrides must be a plain object');

  const mqttUser = requireString(env, 'MQTT_USER');
  const mqttPass = requireString(env, 'MQTT_PASS');
  const ingestKey = requireString(env, 'INGEST_KEY');

  const clientIdsRaw = readString(env, 'MQTT_CLIENT_ID') || DEFAULTS.MQTT_CLIENT_ID;
  const clientIds = clientIdsRaw.split(/[\s,]+/).filter(Boolean);
  if (clientIds.length === 0) throw new Error('MQTT_CLIENT_ID must contain at least one client id');
  for (const clientId of clientIds) {
    if (!CLIENT_ID_RE.test(clientId)) throw new Error('MQTT_CLIENT_ID contains an invalid client id');
  }

  const deviceId = readString(env, 'DEVICE_ID') || DEFAULTS.DEVICE_ID;
  if (!DEVICE_ID_RE.test(deviceId)) throw new Error('DEVICE_ID is invalid');
  // 设备侧 MQTT 身份：默认取白名单第一个；用于识别 broker 的链路事件。
  const deviceClientId = readString(env, 'DEVICE_MQTT_CLIENT_ID') || clientIds[0];
  if (!CLIENT_ID_RE.test(deviceClientId)) throw new Error('DEVICE_MQTT_CLIENT_ID is invalid');
  const locationDeviceId = readString(env, 'LOCATION_DEVICE_ID') || DEFAULTS.LOCATION_DEVICE_ID;
  if (!DEVICE_ID_RE.test(locationDeviceId)) throw new Error('LOCATION_DEVICE_ID is invalid');

  const dataDirRaw = readString(env, 'DATA_DIR') || path.join(process.cwd(), 'data');
  const dataDir = path.resolve(dataDirRaw);

  const statusHost = readString(env, 'STATUS_HOST') || DEFAULTS.STATUS_HOST;
  if (!/^[A-Za-z0-9.:_-]+$/.test(statusHost)) throw new Error('STATUS_HOST is invalid');

  const config = {
    mqtt: {
      host: '0.0.0.0',
      port: parseInteger(env, 'MQTT_PORT', DEFAULTS.MQTT_PORT, 0, 65535),
      user: mqttUser,
      pass: mqttPass,
      clientIds,
      maxPacketBytes: parseInteger(env, 'MQTT_MAX_PACKET_BYTES', 64 * 1024, 1024, 1024 * 1024),
      connectTimeoutMs: parseInteger(env, 'MQTT_CONNECT_TIMEOUT_MS', 10000, 1000, 120000)
    },
    upTopic: parseTopic(env, 'UP_TOPIC', DEFAULTS.UP_TOPIC),
    downTopic: parseTopic(env, 'DOWN_TOPIC', DEFAULTS.DOWN_TOPIC),
    backendBase: parseBackendBase(env),
    ingestKey,
    deviceId,
    deviceClientId,
    locationDeviceId,
    room: ROOM,
    dataDir,
    device: {
      /**
       * 业务上行（sos/hb/boot/ack，不含 M100 主动上报的 GPS 固定格式行）
       * 静默超过该时长即判定设备离线，并如实向 backend 上报 online=false。
       * 默认 120s = 4 倍固件心跳周期（30s），容忍 2 次丢帧后再报离线，避免抖动。
       */
      aliveTimeoutMs: parseInteger(env, 'DEVICE_ALIVE_TIMEOUT_MS', 120000, 1000, 24 * 3600 * 1000)
    },
    status: {
      host: statusHost,
      port: parseInteger(env, 'STATUS_PORT', DEFAULTS.STATUS_PORT, 0, 65535)
    },
    poll: {
      intervalMs: parseInteger(env, 'COMMAND_POLL_INTERVAL_MS', 1000, 50, 60000),
      maxAttempts: parseInteger(env, 'COMMAND_MAX_ATTEMPTS', 3, 1, 10),
      retryIntervalMs: parseInteger(env, 'COMMAND_RETRY_INTERVAL_MS', 5000, 50, 600000),
      parkedRetryMs: parseInteger(env, 'COMMAND_PARKED_RETRY_MS', 60000, 100, 3600000),
      slowRetryMs: parseInteger(env, 'COMMAND_SLOW_RETRY_MS', 5 * 60 * 1000, 1000, 24 * 3600 * 1000),
      maxRounds: parseInteger(env, 'COMMAND_MAX_ROUNDS', 3, 1, 10),
      backoffMaxMs: parseInteger(env, 'COMMAND_POLL_BACKOFF_MAX_MS', 30000, 1000, 600000)
    },
    http: {
      timeoutMs: parseInteger(env, 'HTTP_TIMEOUT_MS', 5000, 500, 60000),
      maxAttempts: parseInteger(env, 'HTTP_MAX_ATTEMPTS', 4, 1, 10),
      backoffBaseMs: parseInteger(env, 'HTTP_BACKOFF_BASE_MS', 500, 10, 60000),
      backoffMaxMs: parseInteger(env, 'HTTP_BACKOFF_MAX_MS', 8000, 100, 600000)
    },
    sos: {
      dedupeTtlMs: parseInteger(env, 'SOS_DEDUPE_TTL_MS', 30 * 60 * 1000, 1000, 24 * 3600 * 1000),
      httpMaxAttempts: parseInteger(env, 'SOS_HTTP_MAX_ATTEMPTS', 5, 1, 10)
    },
    logLevel: readString(env, 'LOG_LEVEL') || 'info'
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) {
      throw new Error(`unknown config override: ${key}`);
    }
    config[key] = value;
  }
  return Object.freeze(deepFreeze(config));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** 只包含可安全写入日志/诊断的字段（绝不含 user/pass/token/ingestKey）。 */
function describeConfig(config) {
  return {
    mqttPort: config.mqtt.port,
    mqttClientIds: config.mqtt.clientIds.slice(),
    upTopic: config.upTopic,
    downTopic: config.downTopic,
    backendBase: config.backendBase,
    deviceId: config.deviceId,
    deviceClientId: config.deviceClientId,
    deviceAliveTimeoutMs: config.device.aliveTimeoutMs,
    locationDeviceId: config.locationDeviceId,
    dataDir: config.dataDir,
    statusHost: config.status.host,
    statusPort: config.status.port,
    hasMqttCredentials: Boolean(config.mqtt.user && config.mqtt.pass),
    hasIngestKey: config.ingestKey.length > 0
  };
}

module.exports = Object.freeze({
  loadConfig,
  describeConfig,
  DEFAULTS,
  ROOM,
  DEVICE_ID_RE,
  CLIENT_ID_RE
});
