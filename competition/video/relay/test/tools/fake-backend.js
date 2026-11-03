'use strict';

/**
 * fake 后端（仅测试用）：只实现 relay 需要的 GET /api/v1/overview。
 *
 * - 携带有效 Bearer token -> 200（relay 视为有监护权限）；
 * - 缺失/伪造 token -> 401；
 * - setDown(true) -> 503（模拟后端故障，用于验证 session/end 的隐私兜底）。
 *
 * 不记录 token 原文，只记录调用次数与最后状态码。
 */

const http = require('http');

class FakeBackend {
  constructor(options = {}) {
    this.tokens = new Set(options.tokens || []);
    this.port = 0;
    this.server = null;
    this.overviewCalls = 0;
    this.lastStatus = null;
    this._down = false;
  }

  addToken(token) {
    this.tokens.add(token);
  }

  setDown(value) {
    this._down = Boolean(value);
  }

  start(port = 0) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => this._handle(request, response));
      this.server = server;
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.port = server.address().port;
        server.removeListener('error', reject);
        server.on('error', () => {});
        resolve(this.port);
      });
    });
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  _handle(request, response) {
    const json = (status, body) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length });
      response.end(payload);
    };

    if (request.method !== 'GET' || request.url !== '/api/v1/overview') {
      return json(404, { error: 'not found' });
    }
    this.overviewCalls += 1;
    if (this._down) {
      this.lastStatus = 503;
      return json(503, { error: 'fake backend down' });
    }
    const header = request.headers.authorization || '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match || !this.tokens.has(match[1])) {
      this.lastStatus = 401;
      return json(401, { error: 'unauthorized' });
    }
    this.lastStatus = 200;
    this.overviewCalls += 0;
    return json(200, { ok: true, source: 'fake-backend', overview: {} });
  }
}

module.exports = { FakeBackend };
