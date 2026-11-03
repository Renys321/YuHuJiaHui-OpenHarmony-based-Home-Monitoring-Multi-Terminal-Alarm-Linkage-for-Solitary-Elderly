#!/usr/bin/env node
/**
 * command-sync.js — 边缘 ACK 命令同步器
 *
 * 为什么需要它：微信小程序提交 ACK 后，命令只落在可信后端的队列里，
 * 而设备只会执行本地 `home/<deviceId>/cmd`。缺少这一环时小程序点了“已确认”
 * 但老人房间的设备永远收不到，后端的告警也永远停在 `ackPending=true`。
 *
 * 完整链路：
 *   小程序 -> 后端 /api/v1/alerts/<id>/ack（命令入队 PENDING）
 *         -> (本模块) GET  /internal/v1/commands?after=<id>
 *         -> 严格校验 command=ACK 且 id/deviceId/alarmId/action 全部合法
 *         -> 精确发布 home/<deviceId>/cmd   {"cmd":"ack","alarmId":"...","action":"..."}
 *         -> 观察同一设备后续状态，alarm.id 精确匹配且 state=ACKED
 *         -> POST /internal/v1/commands/<id>/result  {status:"ACKED",deviceState}
 *         失败（发布失败或超时）-> POST {status:"FAILED",code}
 *
 * 安全与语义边界（与 docs/AI-COLLAB.md 的共享契约 v1 一一对应）：
 *   1. `x-ingest-key` 只从显式配置/环境变量读取，绝不写入源码、日志或命令行。
 *   2. 只接受 `command === 'ACK'`，且必须同时具备合法 id / deviceId / alarmId / action；
 *      任何一项不合法只记账、不回写、不下发（**绝不猜测设备**，绝不广播）。
 *   3. 发布后**不得**立即伪造成功：必须观测到同一 deviceId 的**新**状态（观测序号在命令
 *      之后），且 `state === 'ACKED'`、`alarm.id` 与命令的 alarmId 精确相等。
 *   4. 重复轮询幂等：同一个命令（同 id+alarmId）在一次进程生命周期内只下发一次；
 *      已结算的命令重新出现时直接跳过，既不重发也不重复回写。
 *   5. 结果回写与结算解耦：设备真实 ACKED/FAILED 后，只有 `POST /result` 成功才记 settled；
 *      回写失败时保留**原始结果体**（含 ACKED 的 deviceState），下一轮只重试回写，
 *      绝不重发 MQTT、绝不重新等待回执，也绝不推进游标。
 *   6. 一切外部依赖可注入，单元测试不访问真实后端、不连接真实 Broker、不读任何真实密钥。
 *
 * 未实现的边界（不夸大）：结算台账只在内存中，进程重启后无法识别“上一进程已下发过”的命令；
 * 该情况由后端 completeCommand 的幂等语义兜底（同状态重复回写返回既有命令，见 store.js）。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_ACK_TIMEOUT_MS = 8000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
/* 成功轮询的脱敏日志限频（毫秒）：0 = 每次都记。默认 60s，避免 1 秒一次轮询刷屏。 */
const DEFAULT_POLL_OK_LOG_INTERVAL_MS = 60000;
const DEFAULT_MAX_RESULTS = 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 2000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** 与 cloud/backend/src/store.js 完全一致，避免本地通过、后端拒绝的不对称校验。 */
const COMMAND_ID_RE = /^[1-9][0-9]{0,15}$/;
const ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RESULT_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;
/** 后端 completeCommand -> normalizeStatus 只认这四种状态。 */
const SYNC_STATES = new Set(['NORMAL', 'WARN', 'ALARM', 'ACKED']);

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isEnvLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/** 只放行白名单字符，避免把任意字符串写进日志。 */
function safeCode(value) {
  return typeof value === 'string' && RESULT_CODE_RE.test(value) ? value : 'UNKNOWN';
}

/**
 * 命令 `action` 是自由文本，后端 `requestAck` 的默认值就是中文“监护人已确认”，
 * 因此**不能**只放行 ASCII 字符（否则所有中文确认备注都会被丢弃，链路永远不通）。
 * 这里只拒绝控制字符（含 CR/LF，避免日志/载荷注入），其余可打印文本（含中文）放行；
 * 长度 1..120，与后端 `boundedText(action, 120)` 对齐。
 */
function isSafeAction(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return false;
  return !/[\u0000-\u001F\u007F]/.test(value);
}

/* ------------------------------------------------------------ 命令严格校验 */

/**
 * 校验后端的一条命令。
 * @returns {{ok:true, command:object} | {ok:false, code:string}}
 */
function validateCommand(raw) {
  if (!isPlainObject(raw)) return { ok: false, code: 'INVALID_COMMAND_SHAPE' };
  if (typeof raw.id !== 'string' || !COMMAND_ID_RE.test(raw.id)) return { ok: false, code: 'INVALID_COMMAND_ID' };
  if (raw.command !== 'ACK') return { ok: false, code: 'UNSUPPORTED_COMMAND' };
  if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) {
    return { ok: false, code: 'INVALID_DEVICE_ID' };
  }
  if (typeof raw.alarmId !== 'string' || !ALARM_ID_RE.test(raw.alarmId)) {
    return { ok: false, code: 'INVALID_ALARM_ID' };
  }
  if (!isSafeAction(raw.action)) return { ok: false, code: 'INVALID_ACTION' };
  // 后端 listCommands 会把已完成命令一并返回；进程重启后 cursor=0 会重新拉到它们。
  // 只处理 PENDING，避免重启后重复下行（字段缺失时按契约放行，不做猜测）。
  if (raw.status !== undefined && raw.status !== 'PENDING') {
    return { ok: false, code: 'COMMAND_NOT_PENDING' };
  }
  return {
    ok: true,
    command: Object.freeze({
      id: raw.id,
      deviceId: raw.deviceId,
      alarmId: raw.alarmId,
      action: raw.action.trim()
    })
  };
}

/** 下发到 `home/<deviceId>/cmd` 的载荷；字段名与 Bridge/homemon 约定一致。 */
function buildCommandPayload(command) {
  return {
    cmd: 'ack',
    alarmId: command.alarmId,
    action: command.action
  };
}

/**
 * 默认 HTTP 实现：单次请求，返回 { statusCode, text }。
 * 只读够用于判断的状态码与响应体，超限即断开，避免后端异常响应把内存读爆。
 */
function defaultHttpRequest(options, body, callback) {
  const transport = options.protocol === 'https:' ? https : http;
  let settled = false;
  const done = (error, response) => {
    if (settled) return;
    settled = true;
    callback(error, response);
  };
  let request;
  try {
    request = transport.request(options, (response) => {
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy();
          done(Object.assign(new Error('backend response too large'), { code: 'RESPONSE_TOO_LARGE' }), null);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => done(null, {
        statusCode: response.statusCode,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
  } catch {
    done(Object.assign(new Error('backend request could not be created'), { code: 'REQUEST_FAILED' }), null);
    return;
  }
  request.on('error', (error) => done(error, null));
  request.setTimeout(options.timeout || DEFAULT_TIMEOUT_MS, () => {
    request.destroy(Object.assign(new Error('backend request timed out'), { code: 'SYNC_TIMEOUT' }));
  });
  request.end(body === undefined ? undefined : body);
}

/* --------------------------------------------------------------- 同步器主体 */

/**
 * 创建 ACK 命令同步器。
 *
 * @param {object} options
 * @param {string}   [options.backendUrl]        可信后端基址；默认 http://127.0.0.1:8080
 * @param {string}   [options.ingestKey]         x-ingest-key；缺失时 enabled=false 且完全不动作
 * @param {number}   [options.timeoutMs]         单次后端请求超时
 * @param {number}   [options.ackTimeoutMs]      等待设备真实 ACKED 回执的超时
 * @param {number}   [options.maxResults]        结算台账容量上限
 * @param {number}   [options.maxAttempts]       单个命令的最大下发尝试次数
 * @param {number}   [options.retryBackoffMs]    两次尝试之间的最小间隔
 * @param {Function} [options.httpRequest]       注入点，签名 (options, body, cb)
 * @param {object}   [options.mqttClient]        注入点，需实现 publish(topic, message, opts, cb)
 * @param {object}   [options.publisher]         更底层的注入点：publish(topic, payload) => Promise
 * @param {Function} [options.publishCommand]    最上层注入点：(deviceId, payload) => bool|Promise<bool>；设此则忽略上面两者
 * @param {object}   [options.logger]            { info, warn, error }
 */
function createCommandSync(options = {}) {
  if (!isPlainObject(options)) fail('options must be a plain object');

  const backendUrl = options.backendUrl || DEFAULT_BACKEND_URL;
  const ingestKey = typeof options.ingestKey === 'string' ? options.ingestKey : '';
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  requireInteger(timeoutMs, 'timeoutMs', 100, 60000);
  const ackTimeoutMs = options.ackTimeoutMs === undefined ? DEFAULT_ACK_TIMEOUT_MS : options.ackTimeoutMs;
  requireInteger(ackTimeoutMs, 'ackTimeoutMs', 100, 120000);
  const maxResults = options.maxResults === undefined ? DEFAULT_MAX_RESULTS : options.maxResults;
  requireInteger(maxResults, 'maxResults', 1, 100000);
  const maxAttempts = options.maxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : options.maxAttempts;
  requireInteger(maxAttempts, 'maxAttempts', 1, 10);
  const retryBackoffMs = options.retryBackoffMs === undefined ? DEFAULT_RETRY_BACKOFF_MS : options.retryBackoffMs;
  requireInteger(retryBackoffMs, 'retryBackoffMs', 0, 600000);
  const pollIntervalMs = options.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : options.pollIntervalMs;
  requireInteger(pollIntervalMs, 'pollIntervalMs', 50, 600000);
  const pollOkLogIntervalMs = options.pollOkLogIntervalMs === undefined
    ? DEFAULT_POLL_OK_LOG_INTERVAL_MS : options.pollOkLogIntervalMs;
  requireInteger(pollOkLogIntervalMs, 'pollOkLogIntervalMs', 0, 600000);
  let lastPollOkLogAt = 0;

  const httpRequest = options.httpRequest || defaultHttpRequest;
  if (typeof httpRequest !== 'function') fail('httpRequest must be a function');

  // 发布通道三选一，优先级：publishCommand > publisher > mqttClient。
  if (options.publishCommand !== undefined && typeof options.publishCommand !== 'function') {
    fail('publishCommand must be a function');
  }
  if (options.publisher !== undefined && typeof options.publisher !== 'function') {
    fail('publisher must be a function');
  }
  if (options.mqttClient !== undefined && (options.mqttClient === null || typeof options.mqttClient.publish !== 'function')) {
    fail('mqttClient must expose publish(topic, message, options, callback)');
  }

  const now = options.now || (() => Date.now());
  if (typeof now !== 'function') fail('now must be a function');
  const logger = options.logger || {
    info: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line)
  };
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  let parsed;
  try {
    parsed = new URL('/internal/v1/commands', backendUrl);
  } catch {
    fail('backendUrl must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('backendUrl must use http or https');
  }
  if (parsed.username || parsed.password) fail('backendUrl must not contain credentials');
  // `new URL('/path', base)` 会丢弃 base 的 query/fragment，所以必须检查原始字符串。
  if (/[?#]/.test(backendUrl)) fail('backendUrl must not contain query or fragment');

  const origin = `${parsed.protocol}//${parsed.host}`;
  const commandsPath = parsed.pathname;
  const resultsPathPrefix = `${commandsPath}/`;

  /** 上一次成功处理到的后端命令 id（数值比较，后端 id 单调递增）。 */
  let cursor = 0;
  let running = false;
  let stopped = false;
  let stoppedReason = null;
  let cycleTimer = null;
  let chain = Promise.resolve();

  /** 命令结算台账：`${id}\u0000${alarmId}` -> {status, at}，仅用于本地幂等（有界）。 */
  const ledger = new Map();
  /**
   * 待回写结果：`${id}\u0000${alarmId}` -> {command, body}。
   * 只有在 `POST /result` 成功后才会写入 ledger；回写失败时命令**不算 settled**，
   * 下一轮只重试回写，绝不重发 MQTT、绝不重新等待回执（有界）。
   */
  const pendingResults = new Map();
  /** 正在等待设备回执的 waiter：`${deviceId}\u0000${alarmId}` -> {settle, timer}。 */
  const waiters = new Map();
  /** 每设备最近一次被观测到的状态快照（用于构造 deviceState 回写）。 */
  const observations = new Map();
  /** 每个命令的尝试次数 / 下次允许尝试时间。 */
  const attempts = new Map();
  /** 单调递增的观测序号：只有晚于命令发布的观测才算真实回执。 */
  let observationSeq = 0;

  const stats = {
    polls: 0,
    fetched: 0,
    delivered: 0,
    acked: 0,
    failed: 0,
    ignored: 0,
    duplicates: 0,
    resultRetries: 0,
    errors: 0
  };

  /* ------------------------------------------------------------ HTTP 小工具 */

  function requestOnce(method, path, body) {
    const headers = { 'x-ingest-key': ingestKey };
    let encoded;
    if (body !== undefined) {
      encoded = Buffer.from(JSON.stringify(body), 'utf8');
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(encoded.length);
    }
    const requestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path,
      method,
      timeout: timeoutMs,
      headers
    };
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      try {
        httpRequest(requestOptions, encoded, (error, response) => {
          if (error) return done({ ok: false, code: safeCode(error && error.code) });
          const status = response && response.statusCode;
          if (typeof status !== 'number') return done({ ok: false, code: 'SYNC_BAD_RESPONSE' });
          if (status < 200 || status >= 300) {
            return done({ ok: false, code: 'SYNC_HTTP_ERROR', statusCode: status });
          }
          const text = response && typeof response.text === 'string' ? response.text : '';
          if (text.length === 0) return done({ ok: true, statusCode: status, json: null });
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            return done({ ok: false, code: 'SYNC_BAD_JSON', statusCode: status });
          }
          return done({ ok: true, statusCode: status, json });
        });
      } catch {
        done({ ok: false, code: 'SYNC_REQUEST_FAILED' });
      }
    });
  }

  /* ------------------------------------------------------------ 下发通道 */

  /** 把一条已校验的命令发到 home/<deviceId>/cmd。返回 null 表示成功，否则返回安全错误码。 */
  function publishDownlink(deviceId, payload) {
    const topic = `home/${deviceId}/cmd`;
    const message = JSON.stringify(payload);

    if (typeof options.publishCommand === 'function') {
      return new Promise((resolve) => {
        let result;
        try {
          result = options.publishCommand(deviceId, payload, topic, message);
        } catch {
          return resolve('PUBLISH_FAILED');
        }
        return Promise.resolve(result)
          .then((ok) => resolve(ok === false ? 'PUBLISH_FAILED' : null))
          .catch(() => resolve('PUBLISH_FAILED'));
      });
    }

    if (typeof options.publisher === 'function') {
      return Promise.resolve()
        .then(() => options.publisher(topic, payload, message))
        .then((ok) => (ok === false ? 'PUBLISH_FAILED' : null))
        .catch(() => 'PUBLISH_FAILED');
    }

    const client = options.mqttClient;
    return new Promise((resolve) => {
      let settled = false;
      const done = (code) => { if (!settled) { settled = true; resolve(code); } };
      try {
        client.publish(topic, message, { qos: 1, retain: false }, (error) => {
          done(error ? 'PUBLISH_FAILED' : null);
        });
      } catch {
        done('PUBLISH_FAILED');
      }
    });
  }

  /* ------------------------------------------------------------ 回执等待 */

  function waiterKey(deviceId, alarmId) {
    return `${deviceId}\u0000${alarmId}`;
  }

  /**
   * 等待“命令发布之后到达”的 ACKED 回执。
   * baselineSeq 之前的观测一律不算，避免把命令前就已存在的旧状态当成回执。
   */
  function waitForReceipt(deviceId, alarmId, baselineSeq) {
    const key = waiterKey(deviceId, alarmId);
    return new Promise((resolve) => {
      const settle = (ok, info) => {
        if (waiters.get(key) !== waiter) return;
        waiters.delete(key);
        clearTimeout(waiter.timer);
        resolve(ok ? { ok: true } : { ok: false, code: (info && info.code) || 'COMMAND_FAILED' });
      };
      const waiter = { settle, timer: null, baselineSeq, key };
      waiter.timer = setTimeout(
        () => settle(false, { code: 'ACK_TIMEOUT' }),
        ackTimeoutMs
      );
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      // 同一 deviceId+alarmId 正常不会并发（命令 id 单调 + 台账幂等）；真并发时显式结束
      // 旧等待，避免它一直挂到超时。
      const previous = waiters.get(key);
      if (previous) previous.settle(false, { code: 'COMMAND_SUPERSEDED' });
      waiters.set(key, waiter);
    });
  }

  /** 主动取消某个等待（如发布失败、进程停止），绝不留悬挂 Promise。 */
  function cancelReceipt(deviceId, alarmId, code) {
    const waiter = waiters.get(waiterKey(deviceId, alarmId));
    if (waiter) waiter.settle(false, { code });
  }

  function closeWaiters(code) {
    for (const waiter of Array.from(waiters.values())) {
      waiter.settle(false, { code });
    }
    waiters.clear();
  }

  /* ------------------------------------------------------------ 观测状态 */

  /**
   * 消费一台设备的一条状态（来自本地 `home/+/status`）。
   * 绝不抛异常：它是 MQTT 回调入口，异常会打挂订阅。
   * @returns {{accepted:boolean, code?:string}}
   */
  function observe(payload) {
    let raw = payload;
    if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return { accepted: false, code: 'INVALID_JSON' };
      }
    }
    if (!isPlainObject(raw)) return { accepted: false, code: 'INVALID_STATUS' };
    if (typeof raw.deviceId !== 'string' || !DEVICE_ID_RE.test(raw.deviceId)) {
      return { accepted: false, code: 'INVALID_DEVICE_ID' };
    }
    if (!SYNC_STATES.has(raw.state)) return { accepted: false, code: 'INVALID_STATE' };
    const alarm = isPlainObject(raw.alarm) ? raw.alarm : {};
    const alarmId = typeof alarm.id === 'string' ? alarm.id : '';
    if (alarmId && !ALARM_ID_RE.test(alarmId)) return { accepted: false, code: 'INVALID_ALARM_ID' };
    if (raw.monitorOnline !== undefined &&
        (!Number.isSafeInteger(raw.monitorOnline) || ![-1, 0, 1].includes(raw.monitorOnline))) {
      return { accepted: false, code: 'INVALID_MONITOR_STATUS' };
    }

    observationSeq += 1;
    const seq = observationSeq;
    const ts = Number.isSafeInteger(raw.ts) && raw.ts >= 0 ? raw.ts : now();
    observations.set(raw.deviceId, {
      deviceId: raw.deviceId,
      room: typeof raw.room === 'string' && raw.room.length > 0 ? raw.room.slice(0, 32) : '未分配',
      online: raw.online !== false,
      state: raw.state,
      monitorOnline: raw.monitorOnline,
      alarmId,
      ts,
      seq
    });
    // 有界：只保留最近若干个设备的观测。
    if (observations.size > 256) {
      const oldest = observations.keys().next();
      if (!oldest.done) observations.delete(oldest.value);
    }

    if (raw.state === 'ACKED' && alarmId) {
      const waiter = waiters.get(waiterKey(raw.deviceId, alarmId));
      if (waiter && seq > waiter.baselineSeq) waiter.settle(true);
    }
    return { accepted: true };
  }

  /** 构造回写用的 deviceState；没有观测到该设备时返回 null（不允许猜测）。 */
  function buildDeviceState(deviceId, alarmId) {
    const seen = observations.get(deviceId);
    if (!seen) return null;
    if (seen.alarmId && seen.alarmId !== alarmId) return null;
    const state = {
      deviceId,
      room: seen.room,
      online: seen.online !== false,
      state: 'ACKED',
      ts: seen.ts,
      alarm: { id: alarmId, type: 'MANUAL_SOS', countToday: 1 }
    };
    if (seen.monitorOnline !== undefined) state.monitorOnline = seen.monitorOnline;
    return state;
  }

  /* ------------------------------------------------------------ 命令处理 */

  function ledgerKey(command) {
    return `${command.id}\u0000${command.alarmId}`;
  }

  function rememberResult(command, status) {
    const key = ledgerKey(command);
    ledger.delete(key);
    ledger.set(key, { status, at: now() });
    while (ledger.size > maxResults) {
      const oldest = ledger.keys().next();
      if (oldest.done) break;
      ledger.delete(oldest.value);
    }
  }

  /** 回写结果。返回 true 表示后端已接受（或已按幂等接受）。 */
  async function reportResult(command, body) {
    const path = `${resultsPathPrefix}${encodeURIComponent(command.id)}/result`;
    const result = await requestOnce('POST', path, body);
    if (!result.ok) {
      logger.warn(`[command-sync] RESULT_FAIL code=${safeCode(result.code)} id=${command.id} device=${command.deviceId}`);
      return false;
    }
    return true;
  }

  /**
   * 只重试一次结果回写：不发布、不等待回执。
   * POST 成功 -> 记入 ledger、清掉待回写、返回 'settled'；
   * POST 仍失败 -> 原样保留结果体（含 ACKED 的 deviceState），返回 'waiting'。
   */
  async function flushPendingResult(key) {
    const pending = pendingResults.get(key);
    if (!pending) return 'waiting';
    const ok = await reportResult(pending.command, pending.body);
    if (!ok) return 'waiting';
    rememberResult(pending.command, pending.body.status);
    pendingResults.delete(key);
    attempts.delete(key);
    return 'settled';
  }

  /**
   * 进入终态：先把结果登记为待回写，再立即尝试一次。
   * 只有后端确认收到后才 rememberResult；否则保留结果体，下一轮继续只回写。
   */
  async function settleWithResult(command, body) {
    const key = ledgerKey(command);
    pendingResults.delete(key);
    pendingResults.set(key, { command, body });
    while (pendingResults.size > maxResults) {
      const oldest = pendingResults.keys().next();
      if (oldest.done || oldest.value === key) break;
      pendingResults.delete(oldest.value);
    }
    return flushPendingResult(key);
  }

  /** 处理一条已通过严格校验的命令。任何分支都不抛异常。 */
  async function handleCommand(command) {
    const attemptKey = ledgerKey(command);
    const previously = ledger.get(attemptKey);
    if (previously) {
      // 重复轮询：绝不重复下发，也不重复回写。
      stats.duplicates += 1;
      return 'settled';
    }
    if (pendingResults.has(attemptKey)) {
      // 设备结果早已拿到，只是上一次回写没成功：这一轮只重试 POST，
      // 绝不再发布 MQTT、绝不再等待回执。
      stats.resultRetries += 1;
      return flushPendingResult(attemptKey);
    }

    const attempt = attempts.get(attemptKey) || { count: 0, nextAt: 0 };
    if (attempt.count >= maxAttempts) return 'exhausted';
    if (attempt.count > 0 && now() < attempt.nextAt) return 'waiting';
    attempt.count += 1;
    attempt.nextAt = now() + retryBackoffMs;
    attempts.set(attemptKey, attempt);

    const payload = buildCommandPayload(command);
    // baseline 必须在发布**之前**取得（同步，无 await 竞争）。
    const baselineSeq = observationSeq;
    const pending = waitForReceipt(command.deviceId, command.alarmId, baselineSeq);
    void pending.catch(() => {});

    const publishError = await publishDownlink(command.deviceId, payload);
    if (publishError) {
      // 发布失败不会产生回执，先取消等待再回写失败。
      cancelReceipt(command.deviceId, command.alarmId, 'PUBLISH_FAILED');
      await pending;
      if (attempt.count < maxAttempts) {
        attempt.nextAt = now() + retryBackoffMs;
        onEvent(Object.freeze({ type: 'retry', commandId: command.id, deviceId: command.deviceId, code: publishError }));
        return 'waiting';
      }
      stats.failed += 1;
      onEvent(Object.freeze({ type: 'failed', commandId: command.id, deviceId: command.deviceId, code: publishError }));
      logger.warn(`[command-sync] ACK_FAIL code=${publishError} id=${command.id} device=${command.deviceId}`);
      // 回写成功前绝不记 settled：失败则保留结果体，下一轮只重试回写。
      return settleWithResult(command, { status: 'FAILED', code: publishError });
    }

    stats.delivered += 1;
    onEvent(Object.freeze({ type: 'delivered', commandId: command.id, deviceId: command.deviceId, alarmId: command.alarmId }));
    logger.info(`[command-sync] ACK_SENT id=${command.id} device=${command.deviceId}`);

    const receipt = await pending;
    if (receipt.ok) {
      const deviceState = buildDeviceState(command.deviceId, command.alarmId);
      if (!deviceState) {
        // 理论上 observe 已写入观测，这里只作为防御：不猜测，按失败处理。
        stats.failed += 1;
        return settleWithResult(command, { status: 'FAILED', code: 'RECEIPT_STATE_MISSING' });
      }
      stats.acked += 1;
      onEvent(Object.freeze({ type: 'acked', commandId: command.id, deviceId: command.deviceId, alarmId: command.alarmId }));
      logger.info(`[command-sync] ACKED id=${command.id} device=${command.deviceId}`);
      // deviceState 原样交给待回写台账；回写成功前不记 settled，也不推进游标。
      return settleWithResult(command, { status: 'ACKED', deviceState });
    }

    // 进程停止 / 等待被顶替都不是“设备拒绝”：绝不能回写 FAILED，
    // 否则会错误清除后端 ackPending 并让告警永久停在未确认。留给下一次运行重试。
    if (receipt.code === 'COMMAND_SUPERSEDED' || receipt.code === 'COMMAND_CLOSED' ||
        receipt.code === 'COMMAND_STOPPED') {
      return 'waiting';
    }
    if (attempt.count < maxAttempts) {
      attempt.nextAt = now() + retryBackoffMs;
      onEvent(Object.freeze({ type: 'retry', commandId: command.id, deviceId: command.deviceId, code: receipt.code }));
      return 'waiting';
    }
    stats.failed += 1;
    onEvent(Object.freeze({ type: 'failed', commandId: command.id, deviceId: command.deviceId, code: receipt.code }));
    logger.warn(`[command-sync] ACK_FAIL code=${safeCode(receipt.code)} id=${command.id} device=${command.deviceId}`);
    return settleWithResult(command, { status: 'FAILED', code: safeCode(receipt.code) });
  }

  /* ------------------------------------------------------------ 轮询循环 */

  /** 拉取一轮命令。返回本轮统计；从不抛异常。 */
  async function pollOnce() {
    if (!ingestKey) return { ok: false, code: 'SYNC_DISABLED' };
    stats.polls += 1;
    const path = `${commandsPath}?after=${cursor}`;
    const response = await requestOnce('GET', path);
    if (!response.ok) {
      stats.errors += 1;
      logger.warn(`[command-sync] POLL_FAIL code=${safeCode(response.code)}`);
      return { ok: false, code: response.code };
    }
    const list = response.json && Array.isArray(response.json.commands) ? response.json.commands : null;
    if (!list) {
      stats.errors += 1;
      logger.warn('[command-sync] POLL_FAIL code=SYNC_BAD_JSON');
      return { ok: false, code: 'SYNC_BAD_JSON' };
    }
    /* 脱敏成功日志（公网 200 证据）：只输出后端路径、HTTP 状态码与 UTC 时间。
       不含请求头、x-ingest-key、Token、Cookie 或响应体；按固定间隔限频。 */
    {
      const pollAt = now();
      if (pollAt - lastPollOkLogAt >= pollOkLogIntervalMs) {
        lastPollOkLogAt = pollAt;
        logger.info(`[command-sync] POLL_OK path=${commandsPath} status=${response.statusCode} at=${new Date(pollAt).toISOString()}`);
      }
    }

    let processed = 0;
    let highest = cursor;
    let blocked = false;
    for (const raw of list) {
      if (stopped) break;
      const numericId = Number(raw && raw.id);
      if (Number.isSafeInteger(numericId) && numericId > highest) highest = numericId;

      const checked = validateCommand(raw);
      if (!checked.ok) {
        // 非法命令：只记账，绝不猜设备、绝不下发、绝不回写。
        stats.ignored += 1;
        logger.warn(`[command-sync] COMMAND_IGNORED code=${checked.code}`);
        onEvent(Object.freeze({ type: 'ignored', code: checked.code }));
        continue;
      }
      stats.fetched += 1;
      const outcome = await handleCommand(checked.command);
      if (outcome === 'settled') {
        processed += 1;
        continue;
      }
      // 仍在重试窗口内：本轮到此为止，游标不推进，下一轮继续处理同一条。
      blocked = true;
      break;
    }

    if (!blocked && highest > cursor) cursor = highest;
    return {
      ok: true,
      fetched: list.length,
      processed,
      cursor,
      blocked
    };
  }

  function scheduleNext() {
    if (!running || stopped) return;
    cycleTimer = setTimeout(() => {
      cycleTimer = null;
      if (!running || stopped) return;
      chain = chain.then(() => pollOnce()).catch(() => {}).then(() => scheduleNext());
    }, pollIntervalMs);
    if (typeof cycleTimer.unref === 'function') cycleTimer.unref();
  }

  /* ------------------------------------------------------------ 对外接口 */

  const api = {
    enabled: ingestKey.length > 0,
    endpoint: `${origin}${commandsPath}`,
    cursor: () => cursor,
    stats: () => Object.assign({ cursor }, stats),
    observations: () => observations.size,
    pendingResults: () => pendingResults.size,
    waiters: () => waiters.size,

    /** MQTT 状态订阅回调；可直接传给 statusSource.subscribe。 */
    observe,

    /** 单轮轮询：拉取 + 严格校验 + 定向下发 + 等待回执 + 回写。 */
    pollOnce,

    /** 常驻轮询。重复调用是空操作。 */
    start(intervalMs = pollIntervalMs) {
      if (stopped) fail('command sync has been stopped');
      if (running) return;
      requireInteger(intervalMs, 'intervalMs', 50, 600000);
      running = true;
      chain = chain.then(() => pollOnce()).catch(() => {}).then(() => scheduleNext());
    },

    /** 停止常驻轮询；所有等待回执的 Promise 以 COMMAND_STOPPED 结束，绝不悬挂。 */
    async stop(reason = 'STOPPED') {
      stopped = true;
      running = false;
      if (cycleTimer) clearTimeout(cycleTimer);
      cycleTimer = null;
      stoppedReason = safeCode(reason);
      closeWaiters('COMMAND_STOPPED');
      try {
        await chain;
      } catch { /* 轮询自身从不抛异常，这里只是兜底 */ }
      logger.info(`[command-sync] STOP reason=${stoppedReason}`);
      return stoppedReason;
    },

    stoppedReason: () => stoppedReason
  };
  return Object.freeze(api);
}

/** 从环境变量创建同步器；缺 `BACKEND_INGEST_KEY` 时得到一个 disabled 客户端（不报错）。 */
function createCommandSyncFromEnv(env = process.env, overrides = {}) {
  if (!isEnvLike(env)) fail('env must be an object');
  if (!isPlainObject(overrides)) fail('overrides must be a plain object');
  return createCommandSync(Object.assign({
    backendUrl: env.BACKEND_URL || undefined,
    ingestKey: env.BACKEND_INGEST_KEY || '',
    timeoutMs: env.BACKEND_TIMEOUT_MS ? Number.parseInt(env.BACKEND_TIMEOUT_MS, 10) : undefined
  }, overrides));
}

module.exports = Object.freeze({
  createCommandSync,
  createCommandSyncFromEnv,
  validateCommand,
  buildCommandPayload,
  isSafeAction,
  COMMAND_ID_RE,
  ALARM_ID_RE,
  DEVICE_ID_RE,
  RESULT_CODE_RE,
  SYNC_STATES,
  DEFAULT_BACKEND_URL,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_POLL_OK_LOG_INTERVAL_MS
});
