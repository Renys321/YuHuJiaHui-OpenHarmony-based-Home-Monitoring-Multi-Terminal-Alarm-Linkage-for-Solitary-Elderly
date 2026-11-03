#!/usr/bin/env node
/**
 * cloud-sync.js — 把网关聚合后的设备状态同步到可信后端
 *
 * 为什么需要它：产业链是
 *   设备 -> 网关 -> OneNET -> 可信后端(/internal/v1/device-status) -> 微信小程序
 * `cloud/backend/README.md` 明确列出“尚未把 OneNET 消息同步到 /internal/v1/device-status”，
 * 缺少这一环时小程序永远拿不到云数据。本模块补上这一步。
 *
 * 安全边界：
 *   - `x-ingest-key` 只从环境变量/显式配置读取，绝不写入源码、日志或命令行。
 *   - 日志只输出目标主机、deviceId、安全错误码，不输出状态载荷全文或密钥。
 *   - 同步失败**不得**影响本地告警、OneNET 上报或网关聚合。
 *
 * 依赖可注入（httpRequest），因此单元测试不需要真实后端，也不访问网络。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DETAIL_BYTES = 16 * 1024;
/* 成功同步的脱敏日志限频（毫秒）：0 = 每次都记。默认 30s，避免每台设备 3~5 秒一条刷屏。 */
const DEFAULT_OK_LOG_INTERVAL_MS = 30000;
// 与 cloud/backend/src/store.js 的 STATES 保持一致
const SYNC_STATES = new Set(['NORMAL', 'WARN', 'ALARM', 'ACKED']);
const EVIDENCE_ID_RE = /^fall-[0-9]{1,16}-(?:na|[0-9]{1,12})$/;

function fail(message) {
  throw new TypeError(message);
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z_]{3,40}$/.test(value) ? value : 'UNKNOWN';
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneBoundedObject(value, name) {
  if (!isPlainObject(value)) fail(`${name} must be a plain object`);
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(`${name} must be JSON serializable`);
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_DETAIL_BYTES) fail(`${name} is too large`);
  return JSON.parse(encoded);
}

/** 构造后端要求的摄取载荷。deviceId/room 缺失时抛出，交给调用方决定是否降级。 */
function buildIngestPayload(device, receivedAtMs) {
  if (!isPlainObject(device)) fail('device must be a plain object');
  if (typeof device.deviceId !== 'string' || device.deviceId.length === 0) fail('deviceId is required');
  if (!isPlainObject(device.alarm)) fail('device.alarm must be a plain object');
  const monitorOnline = device.monitorOnline === undefined ? -1 : device.monitorOnline;
  if (!Number.isSafeInteger(monitorOnline) || ![-1, 0, 1].includes(monitorOnline)) {
    fail('device.monitorOnline must be one of -1, 0, 1');
  }
  const evidenceId = device.alarm.evidenceId || '';
  if (typeof evidenceId !== 'string' || (evidenceId && !EVIDENCE_ID_RE.test(evidenceId))) {
    fail('invalid alarm evidenceId');
  }

  // 后端只认 NORMAL/WARN/ALARM/ACKED；网关本地的 OFFLINE 不是后端状态，
  // 改用 online=false 表达离线（后端会据此标记离线）。
  const state = SYNC_STATES.has(device.state) ? device.state : 'NORMAL';
  const payload = {
    deviceId: device.deviceId,
    room: device.room,
    online: device.online !== false,
    monitorOnline,
    state,
    ts: receivedAtMs,
    alarm: {
      id: device.alarm.id || '',
      type: device.alarm.type || '',
      countToday: device.alarm.countToday || 0,
      evidenceId
    }
  };
  if (device.sensors !== undefined) payload.sensors = cloneBoundedObject(device.sensors, 'device.sensors');
  if (device.gps !== undefined) payload.gps = cloneBoundedObject(device.gps, 'device.gps');
  if (device.csq !== undefined) {
    if (!Number.isSafeInteger(device.csq) || (device.csq > 31 && device.csq !== 99) || device.csq < 0) {
      fail('device.csq must be 0-31 or 99');
    }
    payload.csq = device.csq;
  }
  return payload;
}

/** 默认 HTTP 实现。只返回“够了就停”，避免后端异常响应把内存读爆。 */
function defaultHttpRequest(options, body, callback) {
  const transport = options.protocol === 'https:' ? https : http;
  const request = transport.request(options, (response) => {
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) response.destroy();
    });
    response.resume();
    response.on('end', () => callback(null, { statusCode: response.statusCode }));
  });
  request.on('error', (error) => callback(error));
  request.setTimeout(options.timeout || DEFAULT_TIMEOUT_MS, () => {
    request.destroy(Object.assign(new Error('backend request timed out'), { code: 'SYNC_TIMEOUT' }));
  });
  request.end(body);
}

/**
 * 创建同步客户端。
 *
 * @param {object} options
 * @param {string} [options.backendUrl]  可信后端基址；默认 http://127.0.0.1:8080
 * @param {string} [options.ingestKey]   x-ingest-key 值；缺失时同步直接跳过（不报错）
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.httpRequest] 注入点，签名 (options, body, cb)
 * @param {() => number} [options.now]
 * @param {object} [options.logger]
 */
function createCloudSync(options = {}) {
  if (!isPlainObject(options)) fail('options must be a plain object');
  const backendUrl = options.backendUrl || DEFAULT_BACKEND_URL;
  const ingestKey = typeof options.ingestKey === 'string' ? options.ingestKey : '';
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    fail('timeoutMs must be an integer in [100, 60000]');
  }
  const okLogIntervalMs = options.okLogIntervalMs === undefined ? DEFAULT_OK_LOG_INTERVAL_MS : options.okLogIntervalMs;
  if (!Number.isSafeInteger(okLogIntervalMs) || okLogIntervalMs < 0 || okLogIntervalMs > 600000) {
    fail('okLogIntervalMs must be an integer in [0, 600000]');
  }
  const lastOkLogAt = new Map();   // deviceId -> 上次成功日志时间
  const httpRequest = options.httpRequest || defaultHttpRequest;
  if (typeof httpRequest !== 'function') fail('httpRequest must be a function');
  const now = options.now || (() => Date.now());
  const logger = options.logger || {
    warn: (line) => console.warn(line),
    info: (line) => console.log(line)
  };

  let parsed;
  try {
    parsed = new URL('/internal/v1/device-status', backendUrl);
  } catch {
    fail('backendUrl must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('backendUrl must use http or https');
  }
  if (parsed.username || parsed.password) fail('backendUrl must not contain credentials');
  // 注意：`new URL('/path', base)` 会丢弃 base 自带的 query/fragment，
  // 因此必须直接检查传入的字符串，不能只看解析结果。
  if (/[?#]/.test(backendUrl)) fail('backendUrl must not contain query or fragment');

  const requestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname,
    method: 'POST',
    timeout: timeoutMs,
    headers: {
      'content-type': 'application/json',
      'x-ingest-key': ingestKey
    }
  };

  return Object.freeze({
    enabled: ingestKey.length > 0,
    endpoint: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,

    /**
     * 同步一台设备的状态。**从不抛异常**：任何失败都降级为返回值 + 安全日志，
     * 以便调用方（常驻网关）把同步当作旁路，而不是关键路径。
     * @returns {Promise<{ok:boolean, code?:string, statusCode?:number}>}
     */
    async publish(device, receivedAtMs = now()) {
      if (!this.enabled) return { ok: false, code: 'SYNC_DISABLED' };

      let payload;
      try {
        payload = buildIngestPayload(device, receivedAtMs);
      } catch {
        return { ok: false, code: 'SYNC_INVALID_STATUS' };
      }

      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const result = await new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; resolve(value); } };
        try {
          httpRequest(requestOptions, body, (error, response) => {
            if (error) return done({ ok: false, code: safeCode(error && error.code) });
            const status = response && response.statusCode;
            if (status >= 200 && status < 300) return done({ ok: true, statusCode: status });
            return done({ ok: false, code: 'SYNC_HTTP_ERROR', statusCode: status });
          });
        } catch {
          done({ ok: false, code: 'SYNC_REQUEST_FAILED' });
        }
      });

      if (!result.ok) {
        logger.warn(`[cloud-sync] FAIL code=${safeCode(result.code)} device=${payload.deviceId}`);
      } else {
        /* 脱敏成功日志（公网 202 证据）：只输出 deviceId、请求路径、HTTP 状态码与 UTC 时间。
           绝不输出请求头、x-ingest-key、Token、Cookie 或请求体任何字段；按设备限频防刷屏。 */
        const at = now();
        const prev = lastOkLogAt.get(payload.deviceId) || 0;
        if (at - prev >= okLogIntervalMs) {
          lastOkLogAt.set(payload.deviceId, at);
          const deviceTs = device && device.deviceTs !== undefined ? device.deviceTs : '-';
          logger.info(`[cloud-sync] OK device=${payload.deviceId} ts=${payload.ts} deviceTs=${deviceTs} path=${parsed.pathname} status=${result.statusCode} at=${new Date(at).toISOString()}`);
        }
      }
      return result;
    }
  });
}

/** 从环境变量创建同步客户端。密钥缺失时返回一个 disabled 的客户端（不报错）。 */
function createCloudSyncFromEnv(env = process.env, overrides = {}) {
  return createCloudSync(Object.assign({
    backendUrl: env.BACKEND_URL || undefined,
    ingestKey: env.BACKEND_INGEST_KEY || '',
    timeoutMs: env.BACKEND_TIMEOUT_MS ? Number.parseInt(env.BACKEND_TIMEOUT_MS, 10) : undefined
  }, overrides));
}

module.exports = Object.freeze({
  createCloudSync,
  createCloudSyncFromEnv,
  buildIngestPayload,
  EVIDENCE_ID_RE,
  SYNC_STATES,
  DEFAULT_BACKEND_URL,
  DEFAULT_OK_LOG_INTERVAL_MS
});
