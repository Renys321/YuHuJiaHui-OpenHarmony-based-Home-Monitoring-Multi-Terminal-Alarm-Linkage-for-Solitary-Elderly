'use strict';

/**
 * relay 主服务（契约 §2）：HTTP 鉴权接口 + WebSocket 帧分发。
 *
 *   GET  /video/healthz          无鉴权健康检查
 *   POST /video/session          Bearer token -> 后端 /api/v1/overview 校验 -> 一次性 ticket
 *   GET  /video/stream?ticket=   WS 升级；文本 ready，之后每帧一个二进制 JPEG
 *   POST /video/session/end      Bearer token -> 关闭该 token 的 viewer
 *   GET  /video/agent?key=       agent 模式下的 agent WSS 注册（key 校验）
 *
 * 安全约束：
 *   - 不在日志里写 Authorization / token / agent key / ticket 明文；
 *   - 访问日志只记 pathname，不记 query（ticket 不出现在日志）；
 *   - relay 不提供 DAYU 端口直通，也没有任何“无鉴权流”入口。
 */

const http = require('http');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const { TicketStore } = require('./ticket-store');
const { createRateLimiter } = require('./rate-limit');
const { FrameHub } = require('./frame-hub');
const { DayuLink } = require('./dayu-link');
const { AgentChannel } = require('./agent-channel');
const { WebSocketServer } = require('./ws');

const BEARER_RE = /^Bearer (.+)$/;
const MAX_TOKEN_LENGTH = 512;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function timingSafeKeyEqual(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected || ''), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function extractBearer(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = BEARER_RE.exec(header);
  if (!match) return '';
  const token = match[1].trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return '';
  return token;
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(payload);
}

function rejectUpgrade(socket, status, message) {
  const body = Buffer.from(JSON.stringify({ error: message }), 'utf8');
  const headline = `${status} ${http.STATUS_CODES[status] || 'Error'}`;
  try {
    socket.write(
      `HTTP/1.1 ${headline}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: application/json; charset=utf-8\r\n'
      + `Content-Length: ${body.length}\r\n\r\n`
    );
    socket.write(body);
  } catch (_) {
    // socket 可能已断开。
  }
  try {
    socket.destroy();
  } catch (_) {
    // ignore
  }
}

function drainBody(request, maxBytes = 4096) {
  return new Promise((resolve) => {
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        // 这些接口不接受 body；超限直接忽略剩余数据（不读进内存）。
        request.removeAllListeners('data');
        request.resume();
        resolve(false);
      }
    });
    request.on('end', () => resolve(true));
    request.on('error', () => resolve(false));
  });
}

function createRelay(options = {}) {
  const config = options.config;
  if (!config) throw new Error('createRelay requires config');
  const clock = options.clock || Date.now;
  const logger = options.logger || createLogger({ level: config.logLevel });
  if (config.agentKey) logger.registerSecret(config.agentKey);
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  const tickets = new TicketStore({ ttlMs: config.ticketTtlMs, clock });
  const rateLimiter = createRateLimiter({
    limit: config.sessionRateLimit,
    windowMs: config.sessionRateWindowMs,
    clock
  });

  const source = config.mode === 'agent'
    ? new AgentChannel({ logger })
    : new DayuLink({
      host: config.dayuHost,
      port: config.dayuPort,
      connectTimeoutMs: config.dayuConnectTimeoutMs,
      helloTimeoutMs: config.dayuHelloTimeoutMs,
      reconnectDelaysMs: config.reconnectDelaysMs,
      logger
    });

  const hub = new FrameHub({ config, logger, clock });
  hub.attachSource(source);

  const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, clientTracking: true });
  wsServer.on('error', (error) => logger.error('ws server error', { reason: error && error.message }));

  /** 调后端 /api/v1/overview 复核 token；只返回状态，不保留/不打印 token。 */
  async function verifyToken(token) {
    const url = `${config.backendBase}/api/v1/overview`;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(config.backendTimeoutMs)
      });
      // 必须消费响应体释放连接；内容不需要（可能含家庭数据）。
      try {
        await response.arrayBuffer();
      } catch (_) {
        // ignore
      }
      return { ok: response.status >= 200 && response.status < 300, status: response.status };
    } catch (error) {
      return { ok: false, status: 0, errorName: (error && error.name) || 'Error' };
    }
  }

  async function handleSessionCreate(request, response) {
    const token = extractBearer(request);
    await drainBody(request);
    if (!token) {
      logger.warn('session rejected: missing bearer token');
      return sendJson(response, 401, { error: 'unauthorized' });
    }
    const sessionKey = sha256Hex(token);
    if (!rateLimiter.check(sessionKey)) {
      logger.warn('session rejected: rate limited');
      return sendJson(response, 429, { error: 'too many requests' });
    }
    const verdict = await verifyToken(token);
    if (!verdict.ok) {
      logger.info('session rejected: token verification failed', { backendStatus: verdict.status });
      return sendJson(response, 401, { error: 'unauthorized' });
    }
    const ticket = tickets.issue(sessionKey);
    logger.info('session ticket issued', {
      ticketPrefix: ticket.slice(0, 6),
      ttlMs: config.ticketTtlMs,
      backendStatus: verdict.status
    });
    return sendJson(response, 200, {
      ticket,
      expiresInMs: config.ticketTtlMs,
      wsPath: `/video/stream?ticket=${ticket}`
    });
  }

  async function handleSessionEnd(request, response) {
    const token = extractBearer(request);
    await drainBody(request);
    if (!token) {
      logger.warn('session end rejected: missing bearer token');
      return sendJson(response, 401, { error: 'unauthorized' });
    }
    const sessionKey = sha256Hex(token);
    const verdict = await verifyToken(token);
    const explicitlyRejected = verdict.status >= 400 && verdict.status < 500;
    if (explicitlyRejected) {
      logger.info('session end rejected: token verification failed', { backendStatus: verdict.status });
      return sendJson(response, 401, { error: 'unauthorized' });
    }
    // 隐私优先：后端暂时不可达（status 0 / 5xx）也必须能停流，不能让“结束探望”失效。
    const revokedTickets = tickets.revokeForSession(sessionKey);
    const closed = hub.endSession(sessionKey);
    logger.info('session end', {
      viewersClosed: closed,
      ticketsRevoked: revokedTickets,
      verified: verdict.ok,
      backendStatus: verdict.status
    });
    return sendJson(response, 200, { ok: true, closed, verified: verdict.ok });
  }

  const server = http.createServer((request, response) => {
    const startedAt = clock();
    const url = new URL(request.url || '/', 'http://relay.local');
    const path = url.pathname;
    response.on('finish', () => {
      if (!config.accessLog) return;
      logger.info('http', {
        method: request.method,
        path,
        status: response.statusCode,
        ms: clock() - startedAt
      });
    });

    const dispatch = async () => {
      if (path === '/video/healthz') {
        if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' });
        return sendJson(response, 200, hub.health());
      }
      if (path === '/video/session') {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
        return handleSessionCreate(request, response);
      }
      if (path === '/video/session/end') {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
        return handleSessionEnd(request, response);
      }
      return sendJson(response, 404, { error: 'not found' });
    };

    dispatch().catch((error) => {
      logger.error('http handler error', { path, reason: (error && error.message) || 'unknown' });
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      else response.destroy();
    });
  });

  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.on('clientError', (error, socket) => {
    logger.debug('client error', { reason: error && error.code });
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch (_) {
      // ignore
    }
  });

  function onUpgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url || '/', 'http://relay.local');
    } catch (_) {
      rejectUpgrade(socket, 400, 'bad request');
      return;
    }
    const path = url.pathname;
    if (path === '/video/stream') {
      const ticket = url.searchParams.get('ticket') || '';
      const record = tickets.consume(ticket);
      if (!record) {
        logger.warn('stream upgrade rejected: invalid/expired/reused ticket');
        rejectUpgrade(socket, 401, 'invalid or expired ticket');
        return;
      }
      wsServer.handleUpgrade(request, socket, head, (ws) => {
        const result = hub.addViewer(ws, record.sessionKey);
        if (!result.ok) {
          try {
            ws.send(JSON.stringify({ type: 'error', code: 'BUSY' }));
          } catch (_) {
            // ignore
          }
          ws.close(1013, 'busy');
          return;
        }
        ws.on('message', () => {
          // 手机端只有下行帧；忽略任何上行消息（不实现控制面）。
        });
        ws.on('error', () => {
          // close 事件统一清理。
        });
        ws.on('close', () => hub.removeViewer(result.id));
      });
      logger.info('stream upgrade accepted', { ticketPrefix: ticket.slice(0, 6) });
      return;
    }
    if (path === '/video/agent') {
      if (config.mode !== 'agent' || !config.agentKey) {
        logger.warn('agent registration rejected: agent mode disabled');
        rejectUpgrade(socket, 404, 'agent mode disabled');
        return;
      }
      const providedKey = url.searchParams.get('key') || '';
      if (!timingSafeKeyEqual(providedKey, config.agentKey)) {
        logger.warn('agent registration rejected: bad key');
        rejectUpgrade(socket, 401, 'unauthorized');
        return;
      }
      wsServer.handleUpgrade(request, socket, head, (ws) => source.attach(ws));
      logger.info('agent websocket accepted');
      return;
    }
    rejectUpgrade(socket, 404, 'not found');
  }

  server.on('upgrade', onUpgrade);

  let started = false;
  let stopped = false;

  function start() {
    if (started) return Promise.resolve(server.address());
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        started = true;
        server.removeListener('error', onError);
        const address = server.address();
        logger.info('relay listening', {
          host: config.relayHost,
          port: address && address.port,
          mode: config.mode
        });
        resolve({ host: config.relayHost, port: address && address.port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.relayPort, config.relayHost);
    });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    hub.close();
    tickets.close();
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      const timer = setTimeout(resolve, 1000);
      if (typeof timer.unref === 'function') timer.unref();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      wsServer.close();
    } catch (_) {
      // 已经关闭。
    }
  }

  return {
    config,
    logger,
    server,
    hub,
    tickets,
    source,
    start,
    stop,
    address() {
      return server.address();
    }
  };
}

module.exports = {
  createRelay,
  extractBearer,
  timingSafeKeyEqual,
  sha256Hex
};
