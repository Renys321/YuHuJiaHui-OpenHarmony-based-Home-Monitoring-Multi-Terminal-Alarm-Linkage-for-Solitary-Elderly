'use strict';

/**
 * test/helpers/fake-backend.js — 假可信后端（真实 HTTP server，测试不访问网络）。
 *
 * 复刻 backend/src/server.js 的契约入口：
 *   POST /internal/v1/device-status            x-ingest-key -> 202
 *   GET  /internal/v1/commands?after=N          x-ingest-key -> {commands}
 *   POST /internal/v1/commands/<id>/result      x-ingest-key -> 200
 *   GET  /api/v1/ingest/wearable/location?token -> 202
 * 并记录每个请求，支持注入一次性失败（验证指数退避重试）。
 * 测试断言只读这些记录，不会碰真实后端/真实网络。
 */

const http = require('node:http');

class FakeBackend {
  constructor(options = {}) {
    this.ingestKey = options.ingestKey || 'test-ingest-key';
    this.locationToken = options.locationToken || 'test-location-token';
    this.commands = (options.commands || []).map((item) => ({ ...item }));
    /** route -> 剩余失败次数（路由名：device-status / commands / result / location） */
    this.failures = new Map();
    /** route -> 失败状态码数组，按顺序消费；用完后回 503 */
    this.failureStatuses = new Map();
    this.requests = [];
    this.locationResponse = null;
    this.server = null;
    this.url = '';
    this.port = 0;
  }

  failNext(route, times = 1, statusCode = 500) {
    this.failures.set(route, (this.failures.get(route) || 0) + times);
    const statuses = this.failureStatuses.get(route) || [];
    for (let index = 0; index < times; index += 1) statuses.push(statusCode);
    this.failureStatuses.set(route, statuses);
  }

  clearFailures() {
    this.failures.clear();
    this.failureStatuses.clear();
  }

  setCommands(commands) {
    this.commands = commands.map((item) => ({ ...item }));
  }

  addCommand(command) {
    this.commands.push({ ...command });
  }

  findCommand(id) {
    return this.commands.find((item) => item.id === id) || null;
  }

  records(route) {
    return this.requests.filter((item) => item.route === route);
  }

  count(route) {
    return this.records(route).length;
  }

  start() {
    this.server = http.createServer((request, response) => {
      const chunks = [];
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => this._handle(request, Buffer.concat(chunks), response));
    });
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.removeListener('error', onError);
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        const address = this.server.address();
        this.port = address.port;
        this.url = `http://127.0.0.1:${address.port}`;
        resolve(this.url);
      });
    });
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => {
      server.close(() => resolve());
      // 测试请求可能用 keep-alive 连接；强制断开，避免 server.close() 一直等待。
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }

  _send(response, statusCode, value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length)
    });
    response.end(body);
  }

  _failIfInjected(route, response) {
    const remaining = this.failures.get(route) || 0;
    if (remaining <= 0) return false;
    this.failures.set(route, remaining - 1);
    const statuses = this.failureStatuses.get(route) || [];
    const statusCode = statuses.shift() || 503;
    if (statuses.length === 0) this.failureStatuses.delete(route);
    this._send(response, statusCode, { error: 'injected failure' });
    return true;
  }

  _record(route, request, url, json) {
    this.requests.push({
      route,
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { ...request.headers },
      body: json,
      at: Date.now()
    });
  }

  _authorized(request, tokenContext) {
    if (tokenContext === 'ingest') return request.headers['x-ingest-key'] === this.ingestKey;
    return false;
  }

  _handle(request, body, response) {
    const url = new URL(request.url, 'http://fake.local');
    const path = url.pathname;
    let json = null;
    if (body.length > 0) {
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        json = null;
      }
    }

    if (request.method === 'POST' && path === '/internal/v1/device-status') {
      this._record('device-status', request, url, json);
      if (!this._authorized(request, 'ingest')) {
        this._send(response, 401, { error: 'unauthorized' });
        return;
      }
      if (this._failIfInjected('device-status', response)) return;
      this._send(response, 202, { accepted: true, deviceId: json && json.deviceId });
      return;
    }

    if (request.method === 'GET' && path === '/internal/v1/commands') {
      this._record('commands', request, url, json);
      if (!this._authorized(request, 'ingest')) {
        this._send(response, 401, { error: 'unauthorized' });
        return;
      }
      if (this._failIfInjected('commands', response)) return;
      const after = Number.parseInt(url.searchParams.get('after') || '0', 10);
      const commands = this.commands
        .filter((item) => Number(item.id) > after)
        .sort((left, right) => Number(left.id) - Number(right.id));
      this._send(response, 200, { commands });
      return;
    }

    const resultMatch = /^\/internal\/v1\/commands\/([^/]+)\/result$/.exec(path);
    if (request.method === 'POST' && resultMatch) {
      this._record('result', request, url, json);
      if (!this._authorized(request, 'ingest')) {
        this._send(response, 401, { error: 'unauthorized' });
        return;
      }
      if (this._failIfInjected('result', response)) return;
      const commandId = decodeURIComponent(resultMatch[1]);
      const command = this.findCommand(commandId);
      if (!command) {
        this._send(response, 404, { error: 'command not found' });
        return;
      }
      if (!json || (json.status !== 'ACKED' && json.status !== 'FAILED')) {
        this._send(response, 400, { error: 'invalid command result status' });
        return;
      }
      command.status = json.status;
      this._send(response, 200, { accepted: true, commandId, status: json.status });
      return;
    }

    if (request.method === 'GET' && path === '/api/v1/ingest/wearable/location') {
      this._record('location', request, url, json);
      const provided = url.searchParams.get('token') || '';
      if (provided !== this.locationToken) {
        this._send(response, 401, { error: 'unauthorized' });
        return;
      }
      if (this._failIfInjected('location', response)) return;
      const seq = Number.parseInt(url.searchParams.get('seq') || '0', 10);
      const payload = {
        accepted: true,
        duplicate: false,
        stale: false,
        deviceId: url.searchParams.get('deviceId'),
        seq
      };
      this._send(response, 202, Object.assign(payload, this.locationResponse || {}));
      return;
    }

    this._send(response, 404, { error: 'not found' });
  }
}

module.exports = Object.freeze({ FakeBackend });
