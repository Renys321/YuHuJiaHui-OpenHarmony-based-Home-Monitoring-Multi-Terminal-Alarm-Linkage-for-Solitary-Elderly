'use strict';

/**
 * status-server.js — 本地诊断 HTTP（默认 127.0.0.1:8099）。
 *
 * 只监听回环地址，**不加入 compose 的 ports**，公网无法访问。
 *   GET /healthz  -> 200 {"ok":true,...}（broker 在监听） / 503
 *   GET /status   -> 200 JSON 全量诊断（counters / clients / 设备状态 / 命令游标）
 *   GET /metrics  -> 200 简版计数（便于 shell 里 grep，不要求 Prometheus 格式）
 *
 * 安全边界：诊断 JSON 由调用方（main.js）组装成白名单结构，
 * 本模块不做任何键名猜测，也绝不回显请求头 / query / 密钥。
 */

const http = require('node:http');

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * @param {object} options
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {() => object} options.getStatus
 * @param {() => boolean} options.isHealthy
 * @param {object} options.logger
 */
function createStatusServer(options) {
  if (typeof options.getStatus !== 'function') throw new TypeError('getStatus is required');
  if (typeof options.isHealthy !== 'function') throw new TypeError('isHealthy is required');
  const host = options.host || '127.0.0.1';
  let port = options.port === undefined ? 8099 : options.port;
  const logger = options.logger || null;
  let server = null;
  let listening = false;

  function sendJson(response, statusCode, value) {
    let body;
    try {
      body = Buffer.from(JSON.stringify(value), 'utf8');
    } catch {
      statusCode = 500;
      body = Buffer.from('{"ok":false,"error":"status serialization failed"}', 'utf8');
    }
    if (body.length > MAX_RESPONSE_BYTES) {
      statusCode = 500;
      body = Buffer.from('{"ok":false,"error":"status too large"}', 'utf8');
    }
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    response.end(body);
  }

  server = http.createServer((request, response) => {
    const method = request.method || '';
    const rawUrl = request.url || '/';
    const path = rawUrl.split('?')[0];
    try {
      if (method !== 'GET' && method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' });
        response.end('{"ok":false,"error":"method not allowed"}');
        return;
      }
      if (path === '/healthz') {
        const healthy = options.isHealthy() === true;
        sendJson(response, healthy ? 200 : 503, {
          ok: healthy,
          service: 'wearable-mqtt',
          at: Date.now()
        });
        return;
      }
      if (path === '/status') {
        sendJson(response, 200, options.getStatus());
        return;
      }
      if (path === '/metrics') {
        const status = options.getStatus() || {};
        const counters = status.counters || {};
        const lines = [];
        for (const [key, value] of Object.entries(counters)) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            lines.push(`wearable_mqtt_${key} ${value}`);
          }
        }
        const body = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'content-length': String(body.length),
          'cache-control': 'no-store'
        });
        response.end(body);
        return;
      }
      sendJson(response, 404, { ok: false, error: 'not found' });
    } catch (error) {
      if (logger) logger.error('STATUS_HANDLER_FAILED', { code: error && error.code ? error.code : 'UNKNOWN' });
      try {
        sendJson(response, 500, { ok: false, error: 'internal error' });
      } catch {
        /* 忽略 */
      }
    }
  });

  server.on('clientError', (error, socket) => {
    if (logger) logger.warn('STATUS_CLIENT_ERROR', { code: error && error.code ? error.code : 'UNKNOWN' });
    try {
      socket.destroy();
    } catch {
      /* 忽略 */
    }
  });

  return Object.freeze({
    start() {
      if (listening) return Promise.resolve({ host, port });
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          listening = true;
          const address = server.address();
          if (address && typeof address === 'object') port = address.port;
          resolve({ host, port });
        });
      });
    },
    address() {
      const address = server.address();
      return {
        host: address && typeof address === 'object' ? address.address : host,
        port: address && typeof address === 'object' ? address.port : port
      };
    },
    close() {
      if (!listening) return Promise.resolve();
      const closing = server;
      listening = false;
      return new Promise((resolve) => {
        closing.close(() => resolve());
        // Docker healthcheck / 诊断 curl 可能留下 keep-alive 空闲连接；
        // 显式断开，避免优雅关闭被拖到 keepAliveTimeout。
        if (typeof closing.closeAllConnections === 'function') closing.closeAllConnections();
      });
    },
    snapshot() {
      return { listening, host, port };
    }
  });
}

module.exports = Object.freeze({ createStatusServer, MAX_RESPONSE_BYTES });
