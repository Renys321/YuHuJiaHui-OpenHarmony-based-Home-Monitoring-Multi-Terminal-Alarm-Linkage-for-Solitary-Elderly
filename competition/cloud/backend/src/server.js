'use strict';

const http = require('http');
const {
  authenticateAppGuardian,
  createSessionToken,
  exchangeWechatCode,
  timingSafeTextEqual,
  verifySessionToken
} = require('./auth');
const { ALARM_ID_RE, MemoryStore, normalizeStatus } = require('./store');
const {
  validateDispositionInput,
  publicDisposition
} = require('./safety-log');
const {
  validateComposeInput,
  publicMessage,
  deriveStatus,
  MESSAGE_ID_RE,
  VOICE_MAP,
  DEFAULT_MESSAGE_CAP,
  isValidFailureCode
} = require('./comms-core');
const {
  HEALTH_PROFILE_BODY_LIMIT,
  validateHealthProfile
} = require('./health-profile');
const { HEALTH_ADVICE_DISCLAIMER } = require('./health-advice-prompt');

/** voiceId -> 固定资源文件名（服务端解析；设备端还会用同一份白名单再校验一次）。 */
const VOICE_RESOURCES = Object.freeze(
  Object.fromEntries(Object.entries(VOICE_MAP).map(([id, entry]) => [id, entry.resource]))
);

/** 设备可以回报的事件（EXPIRED 只能由服务端推导）。 */
const COMM_DEVICE_EVENTS = Object.freeze(['DELIVERED', 'PLAYED', 'ACKED', 'FAILED']);
const COMM_DEVICE_EVENT_SET = new Set(COMM_DEVICE_EVENTS);

function sendJson(response, status, value, headers = {}) {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    ...headers
  });
  response.end(data);
}

function createAuthFailureLimiter(options = {}) {
  const maxFailures = options.maxFailures || 5;
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const maxEntries = options.maxEntries || 10000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const failures = new Map();

  function active(key) {
    const entry = failures.get(key);
    if (!entry) return null;
    if (now() - entry.startedAt >= windowMs) {
      failures.delete(key);
      return null;
    }
    return entry;
  }

  return Object.freeze({
    retryAfterSeconds(key) {
      const entry = active(key);
      if (!entry || entry.count < maxFailures) return 0;
      return Math.max(1, Math.ceil((windowMs - (now() - entry.startedAt)) / 1000));
    },
    failure(key) {
      const entry = active(key) || { count: 0, startedAt: now() };
      entry.count += 1;
      if (!failures.has(key) && failures.size >= maxEntries) {
        failures.delete(failures.keys().next().value);
      }
      failures.set(key, entry);
    },
    success(key) {
      failures.delete(key);
    }
  });
}

function authClientKey(request, route) {
  // 公网部署中 backend 只接受 Caddy 容器流量，X-Forwarded-For 由可信反代写入。
  const forwarded = typeof request.headers['x-forwarded-for'] === 'string'
    ? request.headers['x-forwarded-for'].split(',')[0].trim()
    : '';
  const address = forwarded || request.socket.remoteAddress || 'unknown';
  return `${route}:${address.slice(0, 128)}`;
}

async function readJson(request, limit = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    throw new Error('invalid JSON');
  }
}

async function readBinary(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on('data', (chunk) => {
      if (exceeded) return; // 超额字节继续读掉但不保留，也不销毁 socket
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
        reject(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
    request.once('error', reject);
    request.once('aborted', () => reject(new Error('incomplete evidence body')));
  });
}

function sendJpeg(response, value) {
  response.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': value.length,
    'cache-control': 'private, no-store',
    'content-disposition': 'inline; filename="fall-evidence.jpg"',
    'x-content-type-options': 'nosniff'
  });
  response.end(value);
}

function bearer(request, secret) {
  const match = /^Bearer (.+)$/.exec(request.headers.authorization || '');
  return match ? verifySessionToken(match[1], secret) : null;
}

const STORAGE_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOSPC', 'EPERM', 'EROFS']);
const HOUSEHOLD_ACTOR = 'household-guardian';

function publicError(error) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  if ((error && STORAGE_ERROR_CODES.has(error.code)) || /^persistent store /.test(message)) {
    return { status: 503, message: 'storage unavailable' };
  }
  if (error && error.code === 'EVIDENCE_STORAGE') return { status: 503, message: 'storage unavailable' };
  if (error && error.code === 'EVIDENCE_CONFLICT') return { status: 409, message };
  if (error && error.code === 'BODY_TOO_LARGE') return { status: 413, message: 'request body too large' };
  if (/not configured/.test(message)) return { status: 503, message: 'service unavailable' };
  return { status: 400, message: message || 'bad request' };
}

function createApiServer(options = {}) {
  const store = options.store || new MemoryStore({ contacts: options.contacts });
  const tokenSecret = options.tokenSecret || '';
  const ingestKey = options.ingestKey || '';
  const wearableLocationToken = options.wearableLocationToken || '';
  const wechat = options.wechat || {};
  const appAuth = options.appAuth || null;
  const authFailureLimiter = options.authFailureLimiter || createAuthFailureLimiter();
  const readyCheck = typeof options.readyCheck === 'function' ? options.readyCheck : () => true;
  const evidenceStore = options.evidenceStore || null;
  /**
   * PIR 活动聚合存储（可选，独立状态文件）。未注入时活动报告接口返回 503，设备摄入、
   * 告警、命令、证据与既有响应字段都不变。
   */
  const activityStore =
    options.activityStore && typeof options.activityStore.recordStatus === 'function'
      ? options.activityStore
      : null;
  const authorizeIdentity = typeof options.authorizeIdentity === 'function'
    ? options.authorizeIdentity
    : () => false;
  /** 告警订阅消息投递器（可选）。未注入时整条通知链路关闭，摄入、ACK 与主服务行为不变。 */
  const notificationDelivery =
    options.notificationDelivery && typeof options.notificationDelivery.notifyAlarmInBackground === 'function'
      ? options.notificationDelivery
      : null;
  /**
   * 允许登录的监护人 openid 列表，只用于派生 recipientRef 和启动恢复，绝不写日志或快照。
   * 允许登录不等于已订阅，实际收件人还要与已登记授权求交集。
   */
  const listGuardians = typeof options.listGuardians === 'function'
    ? options.listGuardians
    : () => [];

  /** 把会话身份派生为不可反查的 ownerRef，交流台账里不保存 openid；未注入时返回 ''，接口按 503 处理。 */
  const ownerRefForIdentity = typeof options.ownerRefForIdentity === 'function'
    ? options.ownerRefForIdentity
    : null;

  /**
   * 健康资料的独立 ownerRef 派生（h1_ 域分离 HMAC），刻意不复用 comms 的 ownerRefForIdentity：
   * 健康档案与交流台账必须互相不可反查。未注入时健康接口返回 503。
   */
  const healthOwnerRefForIdentity = typeof options.healthOwnerRefForIdentity === 'function'
    ? options.healthOwnerRefForIdentity
    : null;

  /** 健康资料独立存储（可选，独立状态文件）。未注入时健康接口返回 503，绝不退化到主快照。 */
  const healthStore = options.healthStore &&
    typeof options.healthStore.get === 'function' &&
    typeof options.healthStore.put === 'function'
    ? options.healthStore
    : null;

  /**
   * 老人自述安全事件存储（可选，独立状态文件）。只记录网关上报的“我没事”，不修改
   * alerts/命令/ACK；未注入时接口显式 503，不退化到主快照或伪造记录。
   */
  const elderSafeStore = options.elderSafeStore &&
    typeof options.elderSafeStore.record === 'function' &&
    typeof options.elderSafeStore.list === 'function'
    ? options.elderSafeStore
    : null;

  /** DeepSeek 健康科普建议客户端（可选）。未注入或未配置 Key 时接口明确 503，绝不伪造建议。 */
  const healthAdviceClient = options.healthAdviceClient &&
    typeof options.healthAdviceClient.generateAdvice === 'function'
    ? options.healthAdviceClient
    : null;

  /** 交流接口是否可用：需要 store 支持台账 + 需要 ownerRef 派生能力。 */
  const communicationsSupported =
    typeof store.createCommunication === 'function' &&
    typeof store.getCommunication === 'function' &&
    typeof store.listCommunications === 'function' &&
    typeof store.countCommunications === 'function';

  /** 处置结果 / 安全日志接口是否可用：需要 store 实现合同 §3 的四个内存态方法。 */
  const dispositionsSupported =
    typeof store.createDisposition === 'function' &&
    typeof store.listDispositions === 'function' &&
    typeof store.listSafetyLogs === 'function' &&
    typeof store.getDisposition === 'function';

  /** 当前会话对应的 ownerRef；不可用时返回 ''（调用方按 503 处理）。 */
  function ownerRefFor(openid) {
    if (!ownerRefForIdentity) return '';
    try {
      const ref = ownerRefForIdentity(openid);
      return typeof ref === 'string' && ref !== '' ? ref : '';
    } catch (_) {
      return '';
    }
  }

  /** 当前会话对应的健康域 ownerRef；不可用时返回 ''（健康接口按 503 处理）。 */
  function healthOwnerRef(openid) {
    if (!healthOwnerRefForIdentity) return '';
    try {
      const ref = healthOwnerRefForIdentity(openid);
      return typeof ref === 'string' && ref !== '' ? ref : '';
    } catch (_) {
      return '';
    }
  }

  /**
   * 健康接口的日志安全码：只放行已知错误码/系统错误码，绝不打印 message（可能含路径等部署
   * 细节），更不打印请求体、资料、身份或 Key。
   */
  function healthErrorCode(error, fallback) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (/^[A-Z0-9_]{1,64}$/.test(code)) return code;
    return fallback;
  }

  /** 设备是否属于本户：交流消息不应创建给未知设备。 */
  function isKnownDevice(deviceId) {
    try {
      return store.listDevices().some((device) => device.deviceId === deviceId);
    } catch (_) {
      return false;
    }
  }

  function isAuthorized(openid) {
    try {
      return authorizeIdentity(openid) === true;
    } catch (_) {
      return false;
    }
  }

  /** 把允许名单过滤成真正可投递的收件人：允许登录 ∩ 已登记且有可用额度。 */
  function deliveryRecipients() {
    if (!notificationDelivery || typeof notificationDelivery.toRecipients !== 'function') return [];
    let allowed = [];
    try {
      const listed = listGuardians();
      allowed = Array.isArray(listed) ? listed : [];
    } catch (_) {
      allowed = [];
    }
    try {
      return notificationDelivery.toRecipients(allowed);
    } catch (_) {
      return [];
    }
  }

  /**
   * 启动恢复用的告警上下文重建：从既有 alerts + devices 安全重建。
   * 只使用 room/type/createdAt 这类展示字段，不含精确位置、openid 或 token。
   */
  function resolveAlarmContext(deviceId, alarmId) {
    try {
      const alert = typeof store.getAlert === 'function' ? store.getAlert(alarmId) : null;
      if (!alert || alert.deviceId !== deviceId) return null;
      return {
        deviceId,
        alarmId,
        room: alert.room || '未分配',
        type: alert.type || 'UNKNOWN',
        createdAt: alert.createdAt || 0
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * 告警摄入成功后异步触发订阅消息，绝不阻塞或影响摄入、ACK 与主服务：不 await、不向上抛，
   * 失败都在投递器内部收敛。幂等与重试状态由 PersistentStore 台账承担，重启后依然有效。
   */
  function dispatchAlarmNotification(status) {
    if (!notificationDelivery) return;
    try {
      if (!status || status.state !== 'ALARM' || !status.alarm || !status.alarm.id) return;
      notificationDelivery.notifyAlarmInBackground({
        deviceId: status.deviceId,
        alarmId: status.alarm.id,
        room: status.room,
        type: status.alarm.type,
        createdAt: status.alarm.createdAt || status.ts || status.receivedAt || Date.now()
      }, deliveryRecipients());
    } catch (_) {
      // 通知永远不得影响主链路。
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;

      if (request.method === 'GET' && path === '/healthz') {
        return sendJson(response, 200, { ok: true, service: 'eldercare-cloud-backend' });
      }

      if (request.method === 'GET' && path === '/readyz') {
        let ready = false;
        try {
          ready = (await readyCheck()) === true;
        } catch (_) {
          ready = false;
        }
        return ready
          ? sendJson(response, 200, { ok: true, service: 'eldercare-cloud-backend' })
          : sendJson(response, 503, { ok: false, error: 'storage unavailable' });
      }

      if (request.method === 'POST' && path === '/api/v1/auth/wechat') {
        if (!wechat.appId || !wechat.appSecret) {
          return sendJson(response, 503, { error: 'service unavailable' });
        }
        const clientKey = authClientKey(request, 'wechat');
        const retryAfter = authFailureLimiter.retryAfterSeconds(clientKey);
        if (retryAfter > 0) {
          return sendJson(response, 429, { error: 'too many attempts' }, { 'retry-after': String(retryAfter) });
        }
        try {
          const body = await readJson(request, 8 * 1024);
          const identity = await exchangeWechatCode(body.code, {
            appId: wechat.appId,
            appSecret: wechat.appSecret,
            fetchImpl: wechat.fetchImpl
          });
          if (!isAuthorized(identity.openid)) {
            authFailureLimiter.failure(clientKey);
            return sendJson(response, 403, { error: 'forbidden' });
          }
          authFailureLimiter.success(clientKey);
          return sendJson(response, 200, {
            sessionToken: createSessionToken(identity.openid, tokenSecret),
            expiresIn: 7200
          });
        } catch (error) {
          authFailureLimiter.failure(clientKey);
          throw error;
        }
      }

      if (request.method === 'POST' && path === '/api/v1/auth/app') {
        if (!appAuth) return sendJson(response, 503, { error: 'service unavailable' });
        const clientKey = authClientKey(request, 'app');
        const retryAfter = authFailureLimiter.retryAfterSeconds(clientKey);
        if (retryAfter > 0) {
          return sendJson(response, 429, { error: 'too many attempts' }, { 'retry-after': String(retryAfter) });
        }
        const body = await readJson(request, 8 * 1024);
        const subject = authenticateAppGuardian(body, appAuth);
        if (!subject || !isAuthorized(subject)) {
          authFailureLimiter.failure(clientKey);
          return sendJson(response, 401, { error: 'invalid credentials' });
        }
        authFailureLimiter.success(clientKey);
        return sendJson(response, 200, {
          sessionToken: createSessionToken(subject, tokenSecret),
          tokenType: 'Bearer',
          expiresIn: 7200
        });
      }

      if (path.startsWith('/internal/v1/')) {
        if (!ingestKey || !timingSafeTextEqual(request.headers['x-ingest-key'], ingestKey)) {
          return sendJson(response, 401, { error: 'unauthorized' });
        }
        if (request.method === 'POST' && path === '/internal/v1/device-status') {
          const incoming = normalizeStatus(await readJson(request));
          if (evidenceStore && incoming.alarm.evidenceId && incoming.alarm.id) {
            evidenceStore.checkBinding(incoming.alarm.evidenceId, incoming.deviceId, incoming.alarm.id);
          }
          const status = store.ingest(incoming);
          if (evidenceStore && status.alarm.evidenceId && status.alarm.id) {
            evidenceStore.bind(status.alarm.evidenceId, status.deviceId, status.alarm.id);
          }
          // 活动聚合是独立存储、独立失败域：写失败只记录安全错误码，
          // 绝不改变设备状态摄取的 202 语义，也不影响告警/命令链路。
          if (activityStore) {
            try {
              activityStore.recordStatus(status);
            } catch (error) {
              const code = error && typeof error.code === 'string' ? error.code : 'ACTIVITY_STORE_ERROR';
              console.error(`[backend] ACTIVITY_RECORD_FAILED code=${code}`);
            }
          }
          // 异步触发订阅消息：不 await，失败不影响 202 响应或主链路。
          dispatchAlarmNotification(status);
          return sendJson(response, 202, { accepted: true, deviceId: status.deviceId });
        }
        /**
         * 老人自述安全上报。只写独立自述台账，绝不调 store.requestAck/completeCommand；
         * 请求体严格白名单（deviceId/room/alarmId/text/at/source），非法 400；手机号落盘前
         * 打码，疑似密钥直接拒绝；写盘失败 503，不影响音箱播报与 S3 主链路。
         */
        if (request.method === 'POST' && path === '/internal/v1/elder-safe') {
          if (!elderSafeStore) return sendJson(response, 503, { error: 'elder safe storage unavailable' });
          let body;
          try {
            body = await readJson(request, 8 * 1024);
          } catch (error) {
            if (error && error.message === 'request body too large') {
              return sendJson(response, 413, { error: 'request body too large' });
            }
            return sendJson(response, 400, { error: 'invalid elder safe event' });
          }
          try {
            const event = elderSafeStore.record(body);
            return sendJson(response, 202, { accepted: true, eventId: event.eventId });
          } catch (error) {
            if (error && error.code === 'ELDER_SAFE_INVALID') {
              return sendJson(response, 400, { error: 'invalid elder safe event' });
            }
            const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
              ? error.code
              : 'ELDER_SAFE_STORE_ERROR';
            console.error(`[backend] ELDER_SAFE_WRITE_FAILED code=${code}`);
            return sendJson(response, 503, { error: 'storage unavailable' });
          }
        }
        const evidenceUploadMatch = /^\/internal\/v1\/evidence\/([^/]+)$/.exec(path);
        if (request.method === 'PUT' && evidenceUploadMatch) {
          if (!evidenceStore) return sendJson(response, 503, { error: 'evidence storage unavailable' });
          if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('image/jpeg')) {
            return sendJson(response, 415, { error: 'content-type must be image/jpeg' });
          }
          const evidenceId = decodeURIComponent(evidenceUploadMatch[1]);
          const deviceId = String(request.headers['x-device-id'] || '');
          const expectedSha256 = String(request.headers['x-evidence-sha256'] || '');
          const { MAX_JPEG_BYTES } = require('./evidence-store');
          const uploaded = evidenceStore.upload(
            evidenceId,
            deviceId,
            await readBinary(request, MAX_JPEG_BYTES),
            expectedSha256
          );
          const alert = typeof store.findAlertByEvidence === 'function'
            ? store.findAlertByEvidence(evidenceId, deviceId) : null;
          if (alert) evidenceStore.bind(evidenceId, deviceId, alert.alarmId);
          return sendJson(response, uploaded.created ? 201 : 200, {
            accepted: true,
            created: uploaded.created,
            bound: Boolean(alert)
          });
        }
        if (request.method === 'GET' && path === '/internal/v1/commands') {
          const after = Number.parseInt(url.searchParams.get('after') || '0', 10);
          return sendJson(response, 200, { commands: store.listCommands(Number.isFinite(after) ? after : 0) });
        }
        const commandResultMatch = /^\/internal\/v1\/commands\/([^/]+)\/result$/.exec(path);
        if (request.method === 'POST' && commandResultMatch) {
          const commandId = decodeURIComponent(commandResultMatch[1]);
          const command = store.completeCommand(commandId, await readJson(request));
          if (!command) return sendJson(response, 404, { error: 'command not found' });
          return sendJson(response, 200, {
            accepted: true,
            commandId: command.id,
            status: command.status
          });
        }

        /* ---- 远程交流：设备侧（DAYU 领取与状态回报） ---- */

        if (request.method === 'GET' && path === '/internal/v1/communications/pending') {
          if (!communicationsSupported) return sendJson(response, 503, { error: 'communications unavailable' });
          const deviceId = String(url.searchParams.get('deviceId') || '');
          const leaseId = String(url.searchParams.get('leaseId') || '');
          const limitRaw = Number.parseInt(url.searchParams.get('limit') || '10', 10);
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 20) : 10;
          if (!deviceId) return sendJson(response, 400, { error: 'deviceId is required' });
          try {
            const claimed = store.claimCommunications(deviceId, { leaseId, limit });
            return sendJson(response, 200, {
              messages: claimed.map((item) => Object.freeze({
                ...publicMessage(item),
                leaseId: item.leaseId,
                // 设备侧额外需要"播哪个固定资源"，这是服务端解析后的固定文件名，
                // 不是客户端提供的路径；设备仍会再用自己的白名单校验一次。
                voiceResource: (VOICE_RESOURCES[item.voiceId] || '')
              }))
            });
          } catch (error) {
            const message = error && typeof error.message === 'string' ? error.message : '';
            if (/deviceId|leaseId/.test(message)) return sendJson(response, 400, { error: 'invalid claim parameters' });
            throw error;
          }
        }

        const commReportMatch = /^\/internal\/v1\/communications\/([^/]+)\/report$/.exec(path);
        if (request.method === 'POST' && commReportMatch) {
          if (!communicationsSupported) return sendJson(response, 503, { error: 'communications unavailable' });
          const messageId = decodeURIComponent(commReportMatch[1]);
          if (!MESSAGE_ID_RE.test(messageId)) return sendJson(response, 400, { error: 'invalid message id' });
          const body = await readJson(request);
          // 设备只能回报 DELIVERED/PLAYED/ACKED/FAILED；EXPIRED 由服务端推导。
          const deviceEvent = typeof body.event === 'string' && COMM_DEVICE_EVENT_SET.has(body.event);
          if (!deviceEvent) return sendJson(response, 400, { error: 'invalid communication event' });
          // 非法 failureCode 是无效输入（400），不能被降级成"迁移冲突"（409）。
          if (!isValidFailureCode(body.failureCode)) {
            return sendJson(response, 400, { error: 'invalid failure code' });
          }
          const outcome = store.reportCommunication(messageId, body.event, {
            deviceId: typeof body.deviceId === 'string' ? body.deviceId : '',
            leaseId: typeof body.leaseId === 'string' ? body.leaseId : '',
            failureCode: body.failureCode
          });
          if (!outcome.message) return sendJson(response, 404, { error: 'message not found' });
          if (outcome.rejected) {
            const status = outcome.reason === 'device_mismatch' ? 403 : 409;
            return sendJson(response, status, { accepted: false, rejected: true, reason: outcome.reason });
          }
          return sendJson(response, 200, {
            accepted: true,
            changed: outcome.changed === true,
            message: publicMessage(outcome.message)
          });
        }

        return sendJson(response, 404, { error: 'not found' });
      }

      // M100MG-B1 GPS 上报：只写入预登记随身设备（deviceId=wearable-sos-001），
      // 使用独立 token，避免把 token 放入现有 ESP32 ingest 合同或设备状态。
      // 合同 §5.2 写明 POST/GET 均可：参数一律放 query（token/deviceId/fixValid/
      // latitude/longitude/positionTime/seq），请求体不参与解析，避免两套字段来源。
      if ((request.method === 'GET' || request.method === 'POST') &&
          path === '/api/v1/ingest/wearable/location') {
        if (!wearableLocationToken || typeof store.ingestWearableLocation !== 'function') {
          return sendJson(response, 503, { error: 'wearable location unavailable' });
        }
        const providedToken = url.searchParams.get('token') || '';
        if (!timingSafeTextEqual(providedToken, wearableLocationToken)) {
          return sendJson(response, 401, { error: 'unauthorized' });
        }
        try {
          const rawFix = url.searchParams.get('fixValid');
          // 关键：缺失参数必须是 undefined（再由 store 归一化），绝不能用
          // `Number(null) === 0` 把“没上报纬度”伪造成赤道坐标 / 定位时间 0。
          const numericParam = (name) => {
            const raw = url.searchParams.get(name);
            if (raw === null || raw.trim() === '') return undefined;
            return Number(raw);
          };
          const result = store.ingestWearableLocation({
            deviceId: url.searchParams.get('deviceId') || undefined,
            latitude: numericParam('latitude'),
            longitude: numericParam('longitude'),
            fixValid: rawFix === '1' || rawFix === 'true',
            positionTime: numericParam('positionTime'),
            seq: numericParam('seq')
          });
          return sendJson(response, 202, {
            accepted: true,
            duplicate: result.duplicate === true,
            stale: result.stale === true,
            deviceId: result.location.deviceId,
            seq: result.location.seq
          });
        } catch (error) {
          const mapped = publicError(error);
          return sendJson(response, mapped.status, { error: mapped.message });
        }
      }

      const identity = bearer(request, tokenSecret);
      if (!identity) return sendJson(response, 401, { error: 'unauthorized' });
      if (!isAuthorized(identity.sub)) return sendJson(response, 403, { error: 'forbidden' });

      if (request.method === 'GET' && path === '/api/v1/overview') {
        return sendJson(response, 200, store.overview());
      }
      /**
       * 健康资料。与 overview 共用上面的 Bearer 鉴权，不允许任何 query 参数；存储用独立文件
       * 与 h1_ 域分离 ownerRef，快照里不出现 sub/openid。未知字段或身份字段一律 400，错误信息
       * 不回显字段值；未配置存储 503，写盘失败 503 storage unavailable，不影响其它接口。
       */
      if ((request.method === 'GET' || request.method === 'PUT') && path === '/api/v1/health-profile') {
        if (url.search !== '') {
          return sendJson(response, 400, { error: 'query parameters are not allowed' });
        }
        if (!healthStore || !healthOwnerRefForIdentity) {
          return sendJson(response, 503, { error: 'storage unavailable' });
        }
        const ownerRef = healthOwnerRef(identity.sub);
        if (!ownerRef) return sendJson(response, 503, { error: 'storage unavailable' });

        if (request.method === 'GET') {
          let profile = null;
          try {
            profile = healthStore.get(ownerRef);
          } catch (error) {
            console.error(`[backend] HEALTH_PROFILE_READ_FAILED code=${healthErrorCode(error, 'HEALTH_STORE_ERROR')}`);
            return sendJson(response, 503, { error: 'storage unavailable' });
          }
          return sendJson(response, 200, { profile: profile || null });
        }

        // PUT：请求体 ≤ 8 KiB（§1.5）；超限 413，非法 JSON 400，绝不回显原始值。
        let body;
        try {
          body = await readJson(request, HEALTH_PROFILE_BODY_LIMIT);
        } catch (error) {
          if (error && error.message === 'request body too large') {
            return sendJson(response, 413, { error: 'request body too large' });
          }
          return sendJson(response, 400, {
            error: 'invalid health profile',
            fields: ['request body must be valid JSON']
          });
        }
        const validated = validateHealthProfile(body);
        if (!validated.ok) {
          return sendJson(response, 400, { error: 'invalid health profile', fields: validated.fields });
        }
        let stored;
        try {
          stored = healthStore.put(ownerRef, validated.value);
        } catch (error) {
          console.error(`[backend] HEALTH_PROFILE_SAVE_FAILED code=${healthErrorCode(error, 'HEALTH_STORE_ERROR')}`);
          return sendJson(response, 503, { error: 'storage unavailable' });
        }
        return sendJson(response, 200, { profile: stored });
      }

      /**
       * 健康科普建议，只做科普：不诊断、不开药、不给治疗方案。请求体二选一：空体用服务端
       * 已保存资料，{"profile": {...}} 用内联资料且不落盘。任何 AI 失败都返回明确错误码，
       * 绝不伪造建议，disclaimer 由服务端强制覆盖。
       */
      if (request.method === 'POST' && path === '/api/v1/health-advice') {
        if (url.search !== '') {
          return sendJson(response, 400, { error: 'query parameters are not allowed' });
        }
        if (!healthOwnerRefForIdentity) {
          return sendJson(response, 503, { error: 'storage unavailable' });
        }
        const ownerRef = healthOwnerRef(identity.sub);
        if (!ownerRef) return sendJson(response, 503, { error: 'storage unavailable' });

        let body;
        try {
          body = await readJson(request, HEALTH_PROFILE_BODY_LIMIT);
        } catch (error) {
          if (error && error.message === 'request body too large') {
            return sendJson(response, 413, { error: 'request body too large' });
          }
          return sendJson(response, 400, {
            error: 'invalid health advice request',
            fields: ['request body must be valid JSON']
          });
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(response, 400, {
            error: 'invalid health advice request',
            fields: ['request body must be a JSON object']
          });
        }
        const unknownKeys = Object.keys(body).filter((key) => key !== 'profile');
        if (unknownKeys.length > 0) {
          return sendJson(response, 400, {
            error: 'invalid health advice request',
            fields: unknownKeys.map((key) => {
              const label = String(key).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 64);
              return `unknown field: ${label}`;
            })
          });
        }

        let profile;
        if (Object.prototype.hasOwnProperty.call(body, 'profile')) {
          // 客户端内联资料：同样完整白名单校验，但不落盘。
          const validated = validateHealthProfile(body.profile);
          if (!validated.ok) {
            return sendJson(response, 400, { error: 'invalid health profile', fields: validated.fields });
          }
          profile = validated.value;
        } else {
          if (!healthStore) return sendJson(response, 503, { error: 'storage unavailable' });
          try {
            profile = healthStore.get(ownerRef);
          } catch (error) {
            console.error(`[backend] HEALTH_PROFILE_READ_FAILED code=${healthErrorCode(error, 'HEALTH_STORE_ERROR')}`);
            return sendJson(response, 503, { error: 'storage unavailable' });
          }
          if (!profile) {
            return sendJson(response, 409, { error: 'health profile is empty', code: 'HEALTH_PROFILE_EMPTY' });
          }
        }

        const configured = Boolean(healthAdviceClient) &&
          (typeof healthAdviceClient.isConfigured !== 'function' ||
            healthAdviceClient.isConfigured() === true);
        if (!configured) {
          return sendJson(response, 503, { error: 'ai service unavailable', code: 'AI_NOT_CONFIGURED' });
        }

        let result;
        try {
          result = await healthAdviceClient.generateAdvice(profile, { ownerRef });
        } catch (_) {
          // 客户端实现不应抛异常；兜底也必须是明确失败，绝不伪造建议。
          console.error('[backend] HEALTH_ADVICE_FAILED code=AI_UPSTREAM_ERROR');
          return sendJson(response, 502, { error: 'ai service failed', code: 'AI_UPSTREAM_ERROR' });
        }
        if (!result || result.ok !== true || !result.advice) {
          const code = result && result.code;
          if (code === 'AI_NOT_CONFIGURED') {
            return sendJson(response, 503, { error: 'ai service unavailable', code: 'AI_NOT_CONFIGURED' });
          }
          if (code === 'AI_TIMEOUT') {
            console.error('[backend] HEALTH_ADVICE_FAILED code=AI_TIMEOUT');
            return sendJson(response, 504, { error: 'ai service timeout', code: 'AI_TIMEOUT' });
          }
          console.error('[backend] HEALTH_ADVICE_FAILED code=AI_UPSTREAM_ERROR');
          return sendJson(response, 502, { error: 'ai service failed', code: 'AI_UPSTREAM_ERROR' });
        }
        const advice = result.advice;
        return sendJson(response, 200, {
          advice: {
            summary: typeof advice.summary === 'string' ? advice.summary : '',
            diet: Array.isArray(advice.diet) ? advice.diet : [],
            exerciseAndSleep: Array.isArray(advice.exerciseAndSleep) ? advice.exerciseAndSleep : [],
            warningSigns: Array.isArray(advice.warningSigns) ? advice.warningSigns : [],
            // 服务端强制覆盖：模型返回的 disclaimer 永远不生效。
            disclaimer: HEALTH_ADVICE_DISCLAIMER
          },
          generatedAt: Number.isSafeInteger(result.generatedAt) ? result.generatedAt : Date.now(),
          model: typeof result.model === 'string' && result.model !== ''
            ? result.model
            : (typeof healthAdviceClient.getModel === 'function'
              ? healthAdviceClient.getModel()
              : 'deepseek-chat')
        });
      }
      if (request.method === 'GET' && path === '/api/v1/rooms') {
        return sendJson(response, 200, { rooms: store.listRooms() });
      }
      if (request.method === 'GET' && path === '/api/v1/alerts') {
        const alerts = store.listAlerts().map((alert) => {
          const { evidenceId, ...publicAlert } = alert;
          const internalAlert = typeof store.getAlert === 'function' ? store.getAlert(alert.alarmId) : null;
          const evidence = evidenceStore && internalAlert ? evidenceStore.forAlert(internalAlert) : null;
          const responseAlert = {
            ...publicAlert,
            evidence: evidence ? {
              available: true,
              evidenceId: evidence.evidenceId,
              bytes: evidence.bytes,
              capturedAt: evidence.capturedAt
            } : { available: false }
          };
          if (typeof store.getWearableAlertLocation === 'function') {
            const location = store.getWearableAlertLocation(alert);
            if (location) responseAlert.sosLocation = location;
          }
          return responseAlert;
        });
        return sendJson(response, 200, { alerts });
      }
      if (request.method === 'GET' && path === '/api/v1/devices') {
        return sendJson(response, 200, { devices: store.listPublicDevices() });
      }
      /**
       * 门磁开关事件历史。deviceId 为空返回全部房间；limit 1-100，非法值回退 20。
       * 事件来自持久化台账（eventId 降序，最新在前），不由当前状态临时推导；无事件返回空数组。
       */
      if (request.method === 'GET' && path === '/api/v1/door-events') {
        const deviceId = String(url.searchParams.get('deviceId') || '');
        const limitRaw = Number.parseInt(url.searchParams.get('limit') || '20', 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
        if (deviceId && !/^[A-Za-z0-9._-]{1,64}$/.test(deviceId)) {
          return sendJson(response, 400, { error: 'invalid deviceId' });
        }
        return sendJson(response, 200, { events: store.listDoorEvents(deviceId, limit) });
      }
      /**
       * 老人自述安全事件（只读）。limit 1-100，非法值回退 20，最新在前；无记录返回空数组，
       * 未配置存储 503。这里不提供 ACK/处置入口，原告警状态保持不变。
       */
      if (request.method === 'GET' && path === '/api/v1/elder-safe') {
        if (!elderSafeStore) return sendJson(response, 503, { error: 'storage unavailable' });
        const limitRaw = Number.parseInt(url.searchParams.get('limit') || '20', 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
        try {
          return sendJson(response, 200, { events: elderSafeStore.list(limit) });
        } catch (error) {
          const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
            ? error.code
            : 'ELDER_SAFE_STORE_ERROR';
          console.error(`[backend] ELDER_SAFE_READ_FAILED code=${code}`);
          return sendJson(response, 503, { error: 'storage unavailable' });
        }
      }
      /**
       * 活动规律报告。query 校验失败（scope 不是 day/week/month、date 非法）返回 400；
       * 未配置活动存储 503，绝不返回伪造数据；没有样本的日期/小时一律 null，不用 0 冒充无活动。
       */
      if (request.method === 'GET' && path === '/api/v1/activity/report') {
        if (!activityStore) return sendJson(response, 503, { error: 'activity report unavailable' });
        const scopeParam = url.searchParams.get('scope');
        const dateParam = url.searchParams.get('date');
        let deviceList = [];
        try {
          if (typeof store.listDevices === 'function') deviceList = store.listDevices();
        } catch (_) {
          deviceList = [];
        }
        try {
          return sendJson(response, 200, activityStore.getActivityReport({
            scope: scopeParam === null ? undefined : scopeParam,
            date: dateParam === null ? undefined : dateParam
          }, deviceList));
        } catch (error) {
          if (error && error.code === 'ACTIVITY_QUERY_INVALID') {
            return sendJson(response, 400, { error: error.message });
          }
          throw error;
        }
      }
      if (request.method === 'GET' && path === '/api/v1/location') {
        return sendJson(response, 200, { locations: store.listLocations() });
      }
      if (request.method === 'GET' && path === '/api/v1/contacts') {
        return sendJson(response, 200, { contacts: store.contacts });
      }

      /**
       * 告警订阅消息授权登记。必须经过上面的 Bearer 鉴权，且只能登记当前登录监护人自己：
       * 收件人取自 token 的 sub，请求体里的 openid 一律忽略。同一 grantEventId 重复登记只记
       * 一次额度；响应只回布尔与配额结论，不回显 openid、recipientRef 或 token。
       */
      if (request.method === 'POST' && path === '/api/v1/notifications/subscription') {
        if (!notificationDelivery) {
          // 未配置订阅消息：显式未配置，绝不假装登记成功。
          return sendJson(response, 503, { error: 'subscribe messages are not configured' });
        }
        const body = await readJson(request);
        const grantEventId = typeof body.grantEventId === 'string' ? body.grantEventId.trim() : '';
        if (!/^[A-Za-z0-9._-]{8,64}$/.test(grantEventId)) {
          return sendJson(response, 400, { error: 'grantEventId must be 8-64 characters of [A-Za-z0-9._-]' });
        }
        const bodyTemplateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
        if (bodyTemplateId !== '' && bodyTemplateId !== notificationDelivery.templateId()) {
          // fail closed：客户端报的模板与后端配置不一致时不登记。
          return sendJson(response, 409, { error: 'templateId does not match the configured template' });
        }
        const recorded = notificationDelivery.recordSubscription(identity.sub, grantEventId);
        if (!recorded.ok) {
          return sendJson(response, 503, { error: 'subscription registration unavailable' });
        }
        return sendJson(response, 200, {
          accepted: true,
          duplicate: recorded.duplicate,
          remaining: recorded.remaining,
          oneTime: true,
          message: '已订阅下一次告警通知'
        });
      }

      /**
       * 远程交流（监护人家 → DAYU200）。身份只来自会话 token，请求体出现 openid/ownerRef/
       * household 等字段直接拒绝，客户端无法替别人建消息或指定收件人身份。
       */
      if (request.method === 'POST' && path === '/api/v1/communications/messages') {
        if (!communicationsSupported || !ownerRefForIdentity) {
          return sendJson(response, 503, { error: 'communications unavailable' });
        }
        const ownerRef = ownerRefFor(identity.sub);
        if (!ownerRef) return sendJson(response, 503, { error: 'communications unavailable' });

        const body = await readJson(request);
        const validated = validateComposeInput(body);
        if (!validated.ok) return sendJson(response, 400, { error: 'invalid message', errors: validated.errors });
        if (!isKnownDevice(validated.value.deviceId)) {
          return sendJson(response, 404, { error: 'unknown device' });
        }

        const created = store.createCommunication({
          ownerRef,
          clientMessageId: validated.value.clientMessageId,
          deviceId: validated.value.deviceId,
          text: validated.value.text,
          voiceId: validated.value.voiceId,
          requestAck: validated.value.requestAck
        });
        if (created.conflict === true) {
          return sendJson(response, 409, { error: 'clientMessageId payload conflict' });
        }
        return sendJson(response, created.created ? 201 : 200, {
          created: created.created,
          message: publicMessage(created.message)
        });
      }

      if (request.method === 'GET' && path === '/api/v1/communications/messages') {
        if (!communicationsSupported || !ownerRefForIdentity) {
          return sendJson(response, 503, { error: 'communications unavailable' });
        }
        const ownerRef = ownerRefFor(identity.sub);
        if (!ownerRef) return sendJson(response, 503, { error: 'communications unavailable' });
        const limitRaw = Number.parseInt(url.searchParams.get('limit') || '20', 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
        const messages = store.listCommunications({ ownerRef, limit })
          .map((item) => {
            // 到期的非终态消息在读取时推导为 EXPIRED，并持久化这一次迁移，
            // 这样小程序立刻看到正确状态，设备轮询也不会再领取到它。
            const status = deriveStatus(item, Date.now());
            if (status === 'EXPIRED' && item.status !== 'EXPIRED') {
              try {
                store.reportCommunication(item.messageId, 'EXPIRED', {});
              } catch (_) {
                // 过期落盘失败不影响本次读取结果。
              }
              return publicMessage({ ...item, status: 'EXPIRED' });
            }
            return publicMessage({ ...item, status });
          });
        return sendJson(response, 200, { messages });
      }

      const commMessageMatch = /^\/api\/v1\/communications\/messages\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && commMessageMatch) {
        if (!communicationsSupported || !ownerRefForIdentity) {
          return sendJson(response, 503, { error: 'communications unavailable' });
        }
        const ownerRef = ownerRefFor(identity.sub);
        const messageId = decodeURIComponent(commMessageMatch[1]);
        if (!MESSAGE_ID_RE.test(messageId)) return sendJson(response, 400, { error: 'invalid message id' });
        const item = store.getCommunication(messageId);
        // 只能看自己创建的消息；不存在与不属于自己都返回 404，避免探测他人消息。
        if (!item || item.ownerRef !== ownerRef) return sendJson(response, 404, { error: 'message not found' });
        const status = deriveStatus(item, Date.now());
        if (status === 'EXPIRED' && item.status !== 'EXPIRED') {
          try { store.reportCommunication(item.messageId, 'EXPIRED', {}); } catch (_) { /* 读取照常返回 */ }
        }
        return sendJson(response, 200, { message: publicMessage({ ...item, status }) });
      }

      const evidenceMatch = /^\/api\/v1\/alerts\/([^/]+)\/evidence(?:\/(content))?$/.exec(path);
      if (request.method === 'GET' && evidenceMatch) {
        if (!evidenceStore) return sendJson(response, 404, { error: 'evidence not found' });
        const alarmId = decodeURIComponent(evidenceMatch[1]);
        const alert = typeof store.getAlert === 'function' ? store.getAlert(alarmId) : null;
        if (!alert) return sendJson(response, 404, { error: 'alarm not found' });
        if (evidenceMatch[2] === 'content') {
          const content = evidenceStore.readForAlert(alert);
          if (!content) return sendJson(response, 404, { error: 'evidence not found' });
          return sendJpeg(response, content.payload);
        }
        const metadata = evidenceStore.forAlert(alert);
        if (!metadata) return sendJson(response, 404, { error: 'evidence not found' });
        return sendJson(response, 200, { evidence: metadata });
      }

      /**
       * 告警处置结果 / 安全日志。独立于 ACK：这组路由绝不调 store.requestAck() 或
       * store.completeCommand()，不会生成 ACK 命令、不会把告警改成 ACKED、不会清 ackPending、
       * 不触发设备 reset。鉴权沿用上面的 Bearer；请求体 8 KiB 上限；serverTime/operator/
       * alarmId/deviceId 都由服务端决定。
       */
      const dispositionMatch = /^\/api\/v1\/alerts\/([^/]+)\/dispositions$/.exec(path);
      if (dispositionMatch && request.method === 'POST') {
        if (!dispositionsSupported) return sendJson(response, 503, { error: 'storage unavailable' });
        const alarmId = decodeURIComponent(dispositionMatch[1]);
        if (!ALARM_ID_RE.test(alarmId)) return sendJson(response, 400, { error: 'invalid alarm id' });
        const body = await readJson(request, 8 * 1024);
        const validated = validateDispositionInput(body);
        if (!validated.ok) return sendJson(response, 400, { error: 'invalid disposition' });
        const alert = typeof store.getAlert === 'function' ? store.getAlert(alarmId) : null;
        if (!alert) return sendJson(response, 404, { error: 'alarm not found' });
        const result = store.createDisposition({
          alarmId,
          clientDispositionId: validated.value.clientDispositionId,
          outcome: validated.value.outcome,
          note: validated.value.note
        });
        if (!result) return sendJson(response, 404, { error: 'alarm not found' });
        if (result.conflict === true) {
          return sendJson(response, 409, { error: 'clientDispositionId payload conflict' });
        }
        const disposition = publicDisposition(result.disposition, alert);
        if (result.created === true) return sendJson(response, 201, { created: true, disposition });
        return sendJson(response, 200, { created: false, duplicate: true, disposition });
      }

      if (dispositionMatch && request.method === 'GET') {
        if (!dispositionsSupported) return sendJson(response, 503, { error: 'storage unavailable' });
        const alarmId = decodeURIComponent(dispositionMatch[1]);
        if (!ALARM_ID_RE.test(alarmId)) return sendJson(response, 400, { error: 'invalid alarm id' });
        const alert = typeof store.getAlert === 'function' ? store.getAlert(alarmId) : null;
        if (!alert) return sendJson(response, 404, { error: 'alarm not found' });
        const dispositions = store.listDispositions(alarmId)
          .map((record) => publicDisposition(record, alert));
        return sendJson(response, 200, { alarmId, dispositions });
      }

      if (request.method === 'GET' && path === '/api/v1/safety-logs') {
        if (!dispositionsSupported) return sendJson(response, 503, { error: 'storage unavailable' });
        // limit：1-200，默认 50；非法值回退默认（合同 §2.3）。
        const limitRaw = Number.parseInt(url.searchParams.get('limit') || '', 10);
        const limit = Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 50;
        const rawAlarmFilter = url.searchParams.get('alarmId');
        const alarmIdFilter = typeof rawAlarmFilter === 'string' ? rawAlarmFilter.trim() : '';
        if (alarmIdFilter !== '') {
          if (!ALARM_ID_RE.test(alarmIdFilter)) return sendJson(response, 400, { error: 'invalid alarm id' });
          const alert = typeof store.getAlert === 'function' ? store.getAlert(alarmIdFilter) : null;
          if (!alert) return sendJson(response, 404, { error: 'alarm not found' });
        }
        const logs = store.listSafetyLogs(alarmIdFilter === '' ? { limit } : { limit, alarmId: alarmIdFilter })
          .map((record) => publicDisposition(record, store.getAlert(record.alarmId)));
        return sendJson(response, 200, { logs });
      }

      const ackMatch = /^\/api\/v1\/alerts\/([^/]+)\/ack$/.exec(path);
      if (request.method === 'POST' && ackMatch) {
        const body = await readJson(request);
        const alarmId = decodeURIComponent(ackMatch[1]);
        const command = store.requestAck(alarmId, body.note, HOUSEHOLD_ACTOR);
        if (!command) return sendJson(response, 404, { error: 'alarm not found' });
        return sendJson(response, 202, { accepted: true, status: 'PENDING', commandId: command.id });
      }

      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      const exposed = publicError(error);
      return sendJson(response, exposed.status, { error: exposed.message });
    }
  });

  return { server, store, deliveryRecipients, resolveAlarmContext };
}

module.exports = {
  HOUSEHOLD_ACTOR,
  createAuthFailureLimiter,
  createApiServer,
  publicError,
  readBinary,
  readJson,
  sendJpeg,
  sendJson,
  VOICE_RESOURCES,
  COMM_DEVICE_EVENTS
};

