'use strict';

/**
 * southbound/comms-agent.js — DAYU200 侧远程交流代理（第一阶段）
 *
 * 职责（对应工作包的"DAYU 获取与回报状态"）：
 *   1. 用**内部设备鉴权**（`x-ingest-key`）从可信后端领取属于自己的待处理消息；
 *   2. 把 `voiceId` 映射到**固定资源文件名**（服务端已解析，设备端再用自己的白名单复核一次）；
 *   3. 调用本机播放器拉起播放（默认走 `aa start ... SosVoiceAbility`，参数以 argv 传递，**不经 shell**）；
 *   4. 回报 DELIVERED / PLAYED / FAILED；
 *   5. 老人确认（本机按钮或被授权入口）后回报 ACKED。
 *
 * 能力边界（必须与结论一起引用）：
 *   - 本文件只保证"领取 → 映射 → 调用播放器 → 回报"这条软件链路正确；
 *   - **不保证、也不宣称 DAYU 真机已经播放成功**：真机需要 HAP 携带对应语音资源并安装，
 *     以及 homemon/Ability 的实际音频路由，这些尚未在本工作包验证；
 *   - 本阶段没有录音、没有实时通话、没有 WebRTC/VoLTE，也没有自动电话。
 *
 * 安全约束：
 *   - voiceId 只能来自固定允许列表；资源名、目标 Ability、包名都是代码内常量；
 *   - 播放命令用 `spawn(cmd, args)`（无 shell）执行，**不存在命令拼接**；
 *   - 绝不把 openid、Bearer token、内部 ingest key 或后端响应原文写入日志。
 */

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * voiceId → **固定资源文件名**（必须与 cloud/backend/src/comms-core.js 的 VOICE_MAP 一致）。
 * 设备端独立持有这份表：即便后端被攻破或被改配置，也不能让设备播放任意文件。
 */
const VOICE_RESOURCES = Object.freeze({
  CHECK_IN: 'check_in.wav',
  PLEASE_RESPOND: 'please_respond.wav',
  MEDICINE_REMINDER: 'medicine_reminder.wav',
  FAMILY_MESSAGE: 'family_message.wav',
  EMERGENCY_CONTACTING: 'emergency_contacting.wav'
});

const VOICE_IDS = Object.freeze(Object.keys(VOICE_RESOURCES));

/** 资源名白名单（值是文件名，不是路径）。 */
const RESOURCE_NAMES = Object.freeze(Object.values(VOICE_RESOURCES));

/** 播放目标：固定 Ability 与固定包名。 */
const VOICE_ABILITY = 'SosVoiceAbility';
const VOICE_BUNDLE = 'com.dsh.eldercare';

/**
 * 播放完成回执协议的固定部分。
 *
 * 回执通道 = HAP 作为客户端，POST 到 southbound 在**回环地址**上开的一次性监听端口。
 * 路径固定（HAP 不能自定义 URL）；端口由监听器动态分配后经 `want.parameters` 传入。
 */
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/playback-result';
const CALLBACK_RESULTS = Object.freeze(['COMPLETED', 'FAILED']);
/** 一次性 nonce：32 字节系统随机 → 256 bit，远超 128 bit 要求。 */
const CALLBACK_NONCE_BYTES = 32;
const CALLBACK_NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;
const CALLBACK_DEFAULT_TIMEOUT_MS = 30000;
const CALLBACK_MAX_BODY_BYTES = 4096;
const CALLBACK_BODY_FIELDS = Object.freeze(['playbackMessageId', 'callbackNonce', 'result', 'errorCode']);
const PLAYBACK_MESSAGE_ID_RE = /^[A-Za-z0-9._-]{6,64}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{0,64}$/;

/** 生成一次性回调 nonce（每次播放都不同）。 */
function createCallbackNonce() {
  return crypto.randomBytes(CALLBACK_NONCE_BYTES).toString('base64url');
}

/** 常量时间比较，避免用 nonce 长度/前缀做时序侧信道。 */
function safeEqualText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 校验回执正文：字段固定、有界、无多余键。 */
function validateCallbackBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  for (const key of Object.keys(body)) {
    if (!CALLBACK_BODY_FIELDS.includes(key)) return `unexpected field: ${key}`;
  }
  if (typeof body.playbackMessageId !== 'string' || !PLAYBACK_MESSAGE_ID_RE.test(body.playbackMessageId)) {
    return 'invalid playbackMessageId';
  }
  if (typeof body.callbackNonce !== 'string' || !CALLBACK_NONCE_RE.test(body.callbackNonce)) {
    return 'invalid callbackNonce';
  }
  if (typeof body.result !== 'string' || !CALLBACK_RESULTS.includes(body.result)) {
    return 'invalid result';
  }
  const errorCode = body.errorCode === undefined || body.errorCode === null ? '' : body.errorCode;
  if (typeof errorCode !== 'string' || !ERROR_CODE_RE.test(errorCode)) return 'invalid errorCode';
  return '';
}

/**
 * 启动一次性播放结果回执监听器。
 *
 * 安全设计：
 *   - 只监听 127.0.0.1（绝不 0.0.0.0），端口由系统分配；
 *   - 路径固定为 /playback-result，HAP 无法指定任意 URL；
 *   - 每条播放任务一个独立 nonce，完成后立即关闭，重复回执返回 409；
 *   - 超时按 PLAYER_TIMEOUT 失败并自行关闭；
 *   - 正文有界（4 KiB）且字段固定。
 *
 * 可注入 `httpModule` 以便测试。
 *
 * @returns {Promise<object>} 监听器句柄（port / path / nonce / playbackMessageId / completion / close）
 */
async function createPlaybackCallbackListener(options = {}) {
  const httpModule = options.httpModule || http;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : CALLBACK_DEFAULT_TIMEOUT_MS;
  const nonce = typeof options.nonce === 'string' && CALLBACK_NONCE_RE.test(options.nonce)
    ? options.nonce
    : createCallbackNonce();
  const playbackMessageId = typeof options.playbackMessageId === 'string'
    && PLAYBACK_MESSAGE_ID_RE.test(options.playbackMessageId)
    ? options.playbackMessageId
    : 'cmsg-callback0001';
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};

  let settle = () => {};
  const completion = new Promise((resolve) => { settle = resolve; });

  let finished = false;
  let timer = null;
  let server = null;

  const settleOnce = (outcome) => {
    if (finished) return;
    finished = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    settle(outcome);
  };

  server = httpModule.createServer((request, response) => {
    const send = (status, payload) => {
      try {
        const text = JSON.stringify(payload);
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        response.end(text);
      } catch (_) {
        try { response.destroy(); } catch (_e) { /* 已断开 */ }
      }
    };

    if (request.method !== 'POST' || request.url !== CALLBACK_PATH) {
      send(404, { ok: false });
      return;
    }
    if (finished) {
      // 成功一次后监听器即失效，重复回执无效。
      send(409, { ok: false, reason: 'already_finished' });
      return;
    }

    let size = 0;
    const chunks = [];
    let aborted = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > CALLBACK_MAX_BODY_BYTES) {
        aborted = true;
        send(413, { ok: false });
        try { request.destroy(); } catch (_) { /* 忽略 */ }
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (aborted) return;
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {
        send(400, { ok: false, reason: 'invalid_json' });
        return;
      }
      const problem = validateCallbackBody(body);
      if (problem !== '') {
        send(400, { ok: false, reason: problem });
        return;
      }
      // 必须同时匹配 messageId 与 nonce，且都用常量时间比较。
      const messageOk = safeEqualText(body.playbackMessageId, playbackMessageId);
      const nonceOk = safeEqualText(body.callbackNonce, nonce);
      if (!messageOk || !nonceOk) {
        send(403, { ok: false, reason: 'mismatch' });
        return;
      }
      send(200, { ok: true });
      settleOnce(Object.freeze({
        result: body.result,
        errorCode: typeof body.errorCode === 'string' ? body.errorCode : ''
      }));
    });
    request.on('error', () => { /* 连接中断：不影响其它路径 */ });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, CALLBACK_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addressInfo = server.address();
  const handle = {
    address: CALLBACK_HOST,
    port: addressInfo && typeof addressInfo === 'object' ? addressInfo.port : 0,
    path: CALLBACK_PATH,
    nonce,
    playbackMessageId,
    completion,
    /** 关闭监听器（幂等）。所有路径都必须调用它，避免悬挂句柄。 */
    close: async () => {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      await new Promise((resolve) => {
        try { server.close(() => resolve()); } catch (_) { resolve(); }
      });
      settleOnce(Object.freeze({ result: 'FAILED', errorCode: AGENT_FAILURE_CODES.PLAYER_TIMEOUT }));
      onClose();
      if (typeof server.unref === 'function') server.unref();
    }
  };

  timer = setTimeout(() => {
    settleOnce(Object.freeze({ result: 'FAILED', errorCode: AGENT_FAILURE_CODES.PLAYER_TIMEOUT }));
    try { server.close(); } catch (_) { /* 已关闭 */ }
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  return handle;
}


/** 稳定失败码（上报给后端）。 */
const AGENT_FAILURE_CODES = Object.freeze({
  UNKNOWN_VOICE: 'UNKNOWN_VOICE',
  PLAYER_FAILED: 'PLAYER_FAILED',
  PLAYER_TIMEOUT: 'PLAYER_TIMEOUT',
  DEVICE_REQUEST_FAILED: 'DEVICE_REQUEST_FAILED',
  DELIVERY_REPORT_FAILED: 'DELIVERY_REPORT_FAILED',
  PLAY_REPORT_FAILED: 'PLAY_REPORT_FAILED'
});

/**
 * 解析 voiceId 到资源名。
 * 只接受精确匹配；任何路径、URL、扩展名变体或额外字符都拒绝。
 */
function resolveVoiceResource(voiceId) {
  if (typeof voiceId !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(VOICE_RESOURCES, voiceId)) return null;
  return VOICE_RESOURCES[voiceId];
}

/** 资源名必须是白名单里的纯文件名（无路径分隔、无 ..、无 scheme）。 */
function isAllowedResourceName(resource) {
  if (typeof resource !== 'string' || resource === '') return false;
  if (resource !== path.basename(resource)) return false;
  if (resource.includes('..') || resource.includes('/') || resource.includes('\\')) return false;
  if (/[:?#%]/.test(resource)) return false;
  return RESOURCE_NAMES.includes(resource);
}

/**
 * 构造 `aa start` 的参数数组。
 *
 * 关键安全点：返回的是**参数数组**，调用方必须用 spawn(cmd, args) 而非 shell 拼接。
 * 所有取值都来自代码内常量、已通过白名单的资源名，以及**本机生成**的回执上下文
 * （playbackMessageId / callbackPort / callbackNonce），不存在客户端可控的字符串。
 *
 * @param {string} resource 已通过白名单的资源文件名
 * @param {object} [callbackContext] 回执上下文；省略时退化为"仅拉起 Ability"的旧行为
 */
function buildPlayerArgs(resource, callbackContext) {
  if (!isAllowedResourceName(resource)) throw new Error('resource not allowed');
  const args = [
    'start',
    '-a', VOICE_ABILITY,
    '-b', VOICE_BUNDLE,
    '--ps', 'voiceResource', resource
  ];

  if (callbackContext === undefined || callbackContext === null) {
    return Object.freeze(args);
  }

  const messageId = callbackContext.playbackMessageId;
  const port = callbackContext.callbackPort;
  const nonce = callbackContext.callbackNonce;
  if (typeof messageId !== 'string' || !PLAYBACK_MESSAGE_ID_RE.test(messageId)) {
    throw new Error('invalid callback playbackMessageId');
  }
  // port / nonce 由**默认播放器**在监听器启动后填入；调用方可以只给 messageId。
  // 一旦提供就必须合法，不允许"给了但格式不对"而被悄悄忽略。
  const hasPort = port !== undefined && port !== null;
  const hasNonce = nonce !== undefined && nonce !== null;
  if (hasPort && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) {
    throw new Error('invalid callback port');
  }
  if (hasNonce && (typeof nonce !== 'string' || !CALLBACK_NONCE_RE.test(nonce))) {
    throw new Error('invalid callback nonce');
  }

  args.push('--ps', 'playbackMessageId', messageId);
  if (hasPort) args.push('--ps', 'callbackPort', String(port));
  if (hasNonce) args.push('--ps', 'callbackNonce', nonce);
  return Object.freeze(args);
}

/** 从已构建的参数数组里取回 `--ps playbackMessageId` 的值。 */
function extractPlaybackMessageId(args) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '--ps' && args[index + 1] === 'playbackMessageId'
        && typeof args[index + 2] === 'string' && PLAYBACK_MESSAGE_ID_RE.test(args[index + 2])) {
      return args[index + 2];
    }
  }
  return '';
}

/**
 * 默认播放器：spawn（无 shell）拉起 Ability，并**等待 HAP 的播放完成回执**。
 *
 * 关键正确性要求（本工作包的核心）：
 *   - `aa start` 的退出码只说明 Ability 被拉起，**不能**当作"音频已播完"；
 *   - 因此这里先在回环地址开一次性监听器，把 port + nonce + messageId 通过
 *     `--ps` 传给 HAP，只有 HAP 真正回调 COMPLETED 才返回成功；
 *   - FAILED 回执 / 超时 / 非法回执 / nonce 不匹配 一律返回非零退出码 + 稳定失败码。
 *
 * 调用方必须通过 `buildPlayerArgs(resource, {playbackMessageId,...})` 提供真实的
 * playbackMessageId；本函数**不会**自己编造一个，否则回执会对应不到真实消息。
 *
 * 返回值仍是 `{code, stdout, stderr, failureCode}`，`code === 0` 表示**播放完成**。
 * 无论成功、失败还是超时，监听器都会被关闭（不留下悬挂句柄）。
 */
function createDefaultPlayerRunner(options = {}) {
  const command = typeof options.aaCommand === 'string' && options.aaCommand !== '' ? options.aaCommand : 'aa';
  const exitTimeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
  const callbackTimeoutMs = Number.isSafeInteger(options.callbackTimeoutMs) && options.callbackTimeoutMs > 0
    ? options.callbackTimeoutMs
    : CALLBACK_DEFAULT_TIMEOUT_MS;

  return async function runPlayer(args) {
    const playbackMessageId = extractPlaybackMessageId(args);
    if (playbackMessageId === '') {
      // 没有真实消息 ID 就无法把回执对应回消息：宁可失败，也不许凭猜报成功。
      return {
        code: -1,
        stdout: '',
        stderr: '',
        failureCode: AGENT_FAILURE_CODES.PLAYER_FAILED
      };
    }

    let listener = null;
    let child = null;
    try {
      listener = await createPlaybackCallbackListener({
        playbackMessageId,
        timeoutMs: callbackTimeoutMs,
        httpModule: options.httpModule
      });

      // 用真实的 callbackPort 与 callbackNonce 重新组装参数（保持 argv 数组语义）。
      // 注意：保留 `start` 之前的任何前导 argv（测试里用来把 `node` 指向替身脚本；
      // 生产环境没有前导项，因此等价于原样的 `aa start ...`）。
      const resourceIndex = args.indexOf('voiceResource');
      const resource = resourceIndex >= 0 ? args[resourceIndex + 1] : '';
      const startIndex = args.indexOf('start');
      const prefix = startIndex > 0 ? args.slice(0, startIndex) : [];
      const fullArgs = buildPlayerArgs(resource, {
        playbackMessageId,
        callbackPort: listener.port,
        callbackNonce: listener.nonce
      });
      const spawnArgs = [...prefix, ...fullArgs];

      const exitInfo = await new Promise((resolve) => {
        try {
          // 无 shell：args 作为 argv 精确传递，不存在命令注入面。
          child = spawn(command, spawnArgs, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          resolve({ code: -1, stdout: '', stderr: '' });
          return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const exitTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
          resolve({ code: -1, stdout, stderr });
        }, exitTimeoutMs);
        if (typeof exitTimer.unref === 'function') exitTimer.unref();
        if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', () => {
          if (settled) return;
          settled = true;
          clearTimeout(exitTimer);
          resolve({ code: -1, stdout, stderr });
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(exitTimer);
          resolve({ code: Number.isInteger(code) ? code : -1, stdout, stderr });
        });
      });

      // aa 非零退出表示 Ability 没有被可靠拉起。此时立即失败并在 finally
      // 关闭监听器，不能继续空等回执超时后误报 PLAYER_TIMEOUT。
      if (exitInfo.code !== 0) {
        return {
          code: exitInfo.code,
          stdout: exitInfo.stdout,
          stderr: exitInfo.stderr,
          failureCode: AGENT_FAILURE_CODES.PLAYER_FAILED
        };
      }

      // 等待 HAP 的真实回执（成功/失败/超时都从这里出结论）。
      const outcome = await listener.completion;

      if (outcome.result === 'COMPLETED') {
        return { code: 0, stdout: exitInfo.stdout, stderr: exitInfo.stderr, failureCode: '' };
      }
      const failureCode = typeof outcome.errorCode === 'string' && outcome.errorCode !== ''
        ? outcome.errorCode
        : AGENT_FAILURE_CODES.PLAYER_FAILED;
      return { code: 1, stdout: exitInfo.stdout, stderr: exitInfo.stderr, failureCode };
    } catch (error) {
      return {
        code: -1,
        stdout: '',
        stderr: '',
        failureCode: error && error.code === AGENT_FAILURE_CODES.PLAYER_TIMEOUT
          ? AGENT_FAILURE_CODES.PLAYER_TIMEOUT
          : AGENT_FAILURE_CODES.PLAYER_FAILED
      };
    } finally {
      // 所有路径都必须清理：监听器、定时器、子进程。
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
      }
      if (listener !== null) {
        try { await listener.close(); } catch (_) { /* 已关闭 */ }
      }
    }
  };
}

/** 只保留结论的安全日志：绝不输出 token / key / 后端原文。 */
function createAgentLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  return function log(event, fields = {}) {
    const safe = { event };
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'token' || key === 'ingestKey' || key === 'authorization' || key === 'openid') continue;
      safe[key] = value;
    }
    try {
      write(JSON.stringify(safe));
    } catch (_) {
      // 日志失败不得影响投递。
    }
  };
}

function getJson(url, ingestKey, fetchImpl, timeoutMs) {
  return fetchImpl(url, {
    method: 'GET',
    headers: { 'x-ingest-key': ingestKey, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function postJson(url, ingestKey, body, fetchImpl, timeoutMs) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'x-ingest-key': ingestKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

/**
 * 跑一轮领取与播放。返回结构化摘要（不抛异常）。
 *
 * @param {object} options
 * @param {string}   options.baseUrl      可信后端地址（如 http://127.0.0.1:8080）
 * @param {string}   options.deviceId     本机设备 ID
 * @param {string}   options.ingestKey    内部设备密钥（只用于请求头，绝不写日志）
 * @param {string}   [options.leaseId]    本轮租约 ID（默认自动生成）
 * @param {number}   [options.limit]
 * @param {boolean}  [options.dryRun]     true 时**不调用真实播放器**，仍走完整协议
 * @param {Function} [options.fetchImpl]  注入的 fetch（测试用）
 * @param {Function} [options.runPlayer]  注入的播放器（测试用）
 * @param {Function} [options.log]
 */
async function runOnce(options = {}) {
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl.replace(/\/+$/, '') : '';
  const deviceId = typeof options.deviceId === 'string' ? options.deviceId : '';
  const ingestKey = typeof options.ingestKey === 'string' ? options.ingestKey : '';
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const runPlayer = typeof options.runPlayer === 'function' ? options.runPlayer : createDefaultPlayerRunner(options);
  const log = typeof options.log === 'function' ? options.log : createAgentLogger();
  const timeoutMs = Number.isSafeInteger(options.httpTimeoutMs) && options.httpTimeoutMs > 0 ? options.httpTimeoutMs : 8000;
  const dryRun = options.dryRun === true;
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 5;
  const leaseId = typeof options.leaseId === 'string' && options.leaseId !== ''
    ? options.leaseId
    : `lease-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;

  const summary = {
    leaseId,
    claimed: 0,
    delivered: 0,
    played: 0,
    failed: 0,
    dryRun,
    failures: []
  };

  if (baseUrl === '' || deviceId === '' || ingestKey === '' || typeof fetchImpl !== 'function') {
    summary.failures.push({ stage: 'config', code: 'AGENT_NOT_CONFIGURED' });
    log('agent_not_configured', { deviceId });
    return Object.freeze(summary);
  }

  let messages = [];
  try {
    const response = await getJson(
      `${baseUrl}/internal/v1/communications/pending?deviceId=${encodeURIComponent(deviceId)}&leaseId=${encodeURIComponent(leaseId)}&limit=${limit}`,
      ingestKey, fetchImpl, timeoutMs
    );
    if (!response || response.ok !== true) {
      summary.failures.push({ stage: 'claim', code: 'CLAIM_HTTP_ERROR', status: response ? response.status : 0 });
      log('claim_failed', { status: response ? response.status : 0 });
      return Object.freeze(summary);
    }
    const body = await response.json();
    messages = Array.isArray(body && body.messages) ? body.messages : [];
  } catch (error) {
    summary.failures.push({ stage: 'claim', code: 'CLAIM_FAILED' });
    log('claim_failed', { reason: error && error.name ? error.name : 'error' });
    return Object.freeze(summary);
  }

  summary.claimed = messages.length;

  const report = async (messageId, event, extra = {}) => {
    try {
      const response = await postJson(
        `${baseUrl}/internal/v1/communications/${encodeURIComponent(messageId)}/report`,
        ingestKey, { deviceId, leaseId, event, ...extra }, fetchImpl, timeoutMs
      );
      return Boolean(response && response.ok === true);
    } catch (_) {
      return false;
    }
  };

  for (const message of messages) {
    const messageId = typeof message.messageId === 'string' ? message.messageId : '';
    if (messageId === '') continue;

    // 1) 领取成功即回报 DELIVERED（进入可播放状态）。
    if (await report(messageId, 'DELIVERED')) {
      summary.delivered += 1;
    } else {
      summary.failures.push({ messageId, code: AGENT_FAILURE_CODES.DELIVERY_REPORT_FAILED });
      log('delivery_report_failed', { messageId });
      continue;
    }

    // 2) 资源必须来自**设备自己的**白名单，不信后端传来的值。
    const resource = resolveVoiceResource(message.voiceId);
    if (resource === null || !isAllowedResourceName(resource)) {
      await report(messageId, 'FAILED', { failureCode: AGENT_FAILURE_CODES.UNKNOWN_VOICE });
      summary.failed += 1;
      summary.failures.push({ messageId, code: AGENT_FAILURE_CODES.UNKNOWN_VOICE });
      log('unknown_voice', { voiceId: String(message.voiceId || '') });
      continue;
    }

    // 3) 播放。dryRun 只走协议，不触碰真实播放器（用于无 HAP 的本地验证）。
    if (dryRun) {
      if (await report(messageId, 'PLAYED')) {
        summary.played += 1;
        log('voice_dry_run', { messageId, resource });
      } else {
        summary.failed += 1;
        summary.failures.push({ messageId, code: AGENT_FAILURE_CODES.PLAY_REPORT_FAILED });
        log('played_report_failed', { messageId });
      }
      continue;
    }

    let played = false;
    let playFailureCode = AGENT_FAILURE_CODES.PLAYER_FAILED;
    try {
      // 传入真实的 playbackMessageId：HAP 的回执必须能对应回这条消息。
      const args = buildPlayerArgs(resource, { playbackMessageId: messageId });
      const result = await runPlayer(args);
      played = Boolean(result && result.code === 0);
      if (!played) {
        if (result && typeof result.failureCode === 'string' && result.failureCode !== '') {
          playFailureCode = result.failureCode;
        }
        log('player_failed', { messageId, code: result ? result.code : -1, failureCode: playFailureCode });
      }
    } catch (error) {
      if (error && error.code === AGENT_FAILURE_CODES.PLAYER_TIMEOUT) {
        playFailureCode = AGENT_FAILURE_CODES.PLAYER_TIMEOUT;
      }
      log('player_error', { messageId, reason: error && error.name ? error.name : 'error' });
    }

    if (played) {
      // 走到这里代表 HAP 已经回调 COMPLETED（真实播放完成），而不是"Ability 被拉起"。
      if (await report(messageId, 'PLAYED')) {
        summary.played += 1;
        log('voice_played', { messageId, resource });
      } else {
        summary.failed += 1;
        summary.failures.push({ messageId, code: AGENT_FAILURE_CODES.PLAY_REPORT_FAILED });
        log('played_report_failed', { messageId, resource });
      }
    } else {
      await report(messageId, 'FAILED', { failureCode: playFailureCode });
      summary.failed += 1;
      summary.failures.push({ messageId, code: playFailureCode });
      log('voice_failed', { messageId, resource, failureCode: playFailureCode });
    }
  }

  log('run_complete', {
    claimed: summary.claimed, delivered: summary.delivered, played: summary.played, failed: summary.failed, dryRun
  });
  return Object.freeze(summary);
}

/** 老人确认后回报 ACKED（由按钮/被授权入口调用；本函数不做身份判断，由后端校验设备归属）。 */
async function reportAcknowledged(options, messageId) {
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl.replace(/\/+$/, '') : '';
  const ingestKey = typeof options.ingestKey === 'string' ? options.ingestKey : '';
  const deviceId = typeof options.deviceId === 'string' ? options.deviceId : '';
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const timeoutMs = Number.isSafeInteger(options.httpTimeoutMs) && options.httpTimeoutMs > 0 ? options.httpTimeoutMs : 8000;
  if (baseUrl === '' || ingestKey === '' || deviceId === '' || typeof messageId !== 'string') return false;
  try {
    const response = await postJson(
      `${baseUrl}/internal/v1/communications/${encodeURIComponent(messageId)}/report`,
      ingestKey, { deviceId, event: 'ACKED' }, fetchImpl, timeoutMs
    );
    return Boolean(response && response.ok === true);
  } catch (_) {
    return false;
  }
}

module.exports = {
  VOICE_RESOURCES,
  VOICE_IDS,
  RESOURCE_NAMES,
  VOICE_ABILITY,
  VOICE_BUNDLE,
  CALLBACK_HOST,
  CALLBACK_PATH,
  CALLBACK_RESULTS,
  AGENT_FAILURE_CODES,
  resolveVoiceResource,
  isAllowedResourceName,
  buildPlayerArgs,
  createCallbackNonce,
  createPlaybackCallbackListener,
  validateCallbackBody,
  extractPlaybackMessageId,
  createDefaultPlayerRunner,
  createAgentLogger,
  runOnce,
  reportAcknowledged
};
