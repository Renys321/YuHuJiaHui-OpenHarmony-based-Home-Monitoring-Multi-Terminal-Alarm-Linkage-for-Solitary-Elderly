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
      if (exceeded) return; // drain excess bytes without retaining or destroying the response socket
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
  const wechat = options.wechat || {};
  const appAuth = options.appAuth || null;
  const authFailureLimiter = options.authFailureLimiter || createAuthFailureLimiter();
  const readyCheck = typeof options.readyCheck === 'function' ? options.readyCheck : () => true;
  const evidenceStore = options.evidenceStore || null;
  /**
   * PIR 活动聚合存储（可选，独立状态文件）。未注入时活动报告接口返回 503；
   * 设备摄入、告警、命令、证据与既有响应字段完全不变。
   */
  const activityStore =
    options.activityStore && typeof options.activityStore.recordStatus === 'function'
      ? options.activityStore
      : null;
  const authorizeIdentity = typeof options.authorizeIdentity === 'function'
    ? options.authorizeIdentity
    : () => false;
  /**
   * 告警订阅消息投递器（可选）。未注入时整条通知链路直接关闭，
   * 设备状态摄入、ACK 与主服务行为与之前完全一致。
   */
  const notificationDelivery =
    options.notificationDelivery && typeof options.notificationDelivery.notifyAlarmInBackground === 'function'
      ? options.notificationDelivery
      : null;
  /**
   * 允许登录的监护人 openid 列表（**只**用于派生 recipientRef / 启动恢复，绝不写日志或快照）。
   * 注意：允许登录 ≠ 已订阅；实际收件人还要与已登记授权求交集。
   */
  const listGuardians = typeof options.listGuardians === 'function'
    ? options.listGuardians
    : () => [];

  /**
   * 把会话身份派生为不可反查的 ownerRef（交流台账里绝不保存 openid）。
   * 未注入时返回 ''，交流接口以 503 表示未配置，而不是退化成保存 openid。
   */
  const ownerRefForIdentity = typeof options.ownerRefForIdentity === 'function'
    ? options.ownerRefForIdentity
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

  /**
   * 把当前允许名单过滤成**真正可投递**的收件人：允许登录 ∩ 已登记且有可用额度。
   *
   * 这是"WECHAT_ALLOWED_OPENIDS 只代表允许登录"这一事实的落点：
   * 从未通过 wx.requestSubscribeMessage 接受并登记的用户不会被投递。
   */
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
   * 在告警摄入成功后**异步**触发订阅消息。
   *
   * 硬性约束：绝不能阻塞或影响设备状态摄入、ACK 命令与后端主服务。
   * 因此这里不 await、不把异常向上抛；所有失败都在投递器内部收敛为结构化结果。
   * 幂等与重试状态由投递台账（PersistentStore）承担，进程重启后依然有效。
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

        /* ---------------- 远程交流：设备侧（DAYU 领取与状态回报） ---------------- */

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

      const identity = bearer(request, tokenSecret);
      if (!identity) return sendJson(response, 401, { error: 'unauthorized' });
      if (!isAuthorized(identity.sub)) return sendJson(response, 403, { error: 'forbidden' });

      if (request.method === 'GET' && path === '/api/v1/overview') {
        return sendJson(response, 200, store.overview());
      }
      if (request.method === 'GET' && path === '/api/v1/rooms') {
        return sendJson(response, 200, { rooms: store.listRooms() });
      }
      if (request.method === 'GET' && path === '/api/v1/alerts') {
        const alerts = store.listAlerts().map((alert) => {
          const { evidenceId, ...publicAlert } = alert;
          const internalAlert = typeof store.getAlert === 'function' ? store.getAlert(alert.alarmId) : null;
          const evidence = evidenceStore && internalAlert ? evidenceStore.forAlert(internalAlert) : null;
          return {
            ...publicAlert,
            evidence: evidence ? {
              available: true,
              evidenceId: evidence.evidenceId,
              bytes: evidence.bytes,
              capturedAt: evidence.capturedAt
            } : { available: false }
          };
        });
        return sendJson(response, 200, { alerts });
      }
      if (request.method === 'GET' && path === '/api/v1/devices') {
        return sendJson(response, 200, { devices: store.listPublicDevices() });
      }
      /**
       * 活动规律报告（只新增接口，不改任何既有响应字段）。
       *
       * - 与 /api/v1/devices 共用同一段 Bearer 鉴权（上方统一 401/403 拦截）；
       * - query 校验失败（scope 非 day/week/month、date 非法/非真实日期）-> 400；
       * - 未配置活动存储 -> 503，绝不返回伪造数据；
       * - 没有任何样本的日期/小时一律是 null，不用 0 冒充“无活动”。
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
       * 告警订阅消息授权登记。
       *
       * 硬性约束：
       *   - 必须经过现有 Bearer 会话鉴权（上面已 401/403 拦截）；
       *   - **只能登记当前登录监护人自己**：收件人取自 token 的 `sub`，
       *     请求体里的任何 openid 字段一律忽略，客户端无法替别人登记；
       *   - 幂等：同一 grantEventId 重复登记只记一次额度；
       *   - 响应只回布尔/配额结论，绝不回显 openid、recipientRef 或 token。
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
       * 远程交流（监护人家 → DAYU200）。
       *
       * 身份**只**来自会话 token：请求体里出现 openid/ownerRef/household 等字段直接被拒，
       * 因此客户端无法替别人创建消息，也无法指定收件人身份。
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
          try { store.reportCommunication(item.messageId, 'EXPIRED', {}); } catch (_) { /* read remains available */ }
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
       * 告警处置结果 / 安全日志（v1 增量，schema v6）。
       *
       * 硬性边界（合同 §0）：
       *   - **独立于 ACK**：本组路由绝不调用 `store.requestAck()`/`store.completeCommand()`，
       *     因此不会生成 ACK 命令、不会把告警改成 ACKED、不会清 `ackPending`、不触发设备 reset；
       *   - 鉴权沿用上面既有的 Bearer 会话（401/403 已由既有逻辑处理）；
       *   - 请求体 8 KiB 上限；`serverTime`/`operator`/`alarmId`/`deviceId` 一律由服务端决定；
       *   - 家庭权限 = 合法 Bearer 监护人会话（单户部署，见 `household-auth.js`）。
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

