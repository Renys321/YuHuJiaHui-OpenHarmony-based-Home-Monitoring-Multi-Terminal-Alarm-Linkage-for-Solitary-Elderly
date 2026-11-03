'use strict';

/**
 * 测试夹具：假公网 APP-API（http 服务器），只实现 mirror 用到的 4 个端点：
 *   POST /api/v1/auth/app
 *   GET  /api/v1/devices
 *   GET  /api/v1/alerts
 *   GET  /api/v1/location
 * 可注入 device/alerts/locations，并在测试里改状态（模拟 SOS → ACKED → NORMAL）。
 */

const http = require('node:http');

class FakeApi {
  constructor(options = {}) {
    this.guardianId = options.guardianId || 'test-guardian';
    this.password = options.password || 'test-password';
    this.sessionToken = options.sessionToken || 'session-token-1';
    this.tokenExpiresIn = options.tokenExpiresIn || 7200;
    this.devices = options.devices || [];
    this.alerts = options.alerts || [];
    this.locations = options.locations || [];
    this.port = 0;
    this.server = null;
    this.requests = [];
    this.counters = { logins: 0, devices: 0, alerts: 0, locations: 0, rejected: 0 };
    this.forceUnauthorizedOnce = false;
    this.failNext = false;
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      this.server = server;
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = server.address().port;
        resolve(this);
      });
    });
  }

  handle(req, res) {
    this.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    };
    if (req.method === 'POST' && req.url === '/api/v1/auth/app') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (err) { body = {}; }
        if (body.guardianId !== this.guardianId || body.password !== this.password) {
          this.counters.rejected += 1;
          send(401, { error: 'bad credentials' });
          return;
        }
        this.counters.logins += 1;
        send(200, { sessionToken: this.sessionToken, tokenType: 'Bearer', expiresIn: this.tokenExpiresIn });
      });
      return;
    }
    if (this.failNext) {
      this.failNext = false;
      send(500, { error: 'boom' });
      return;
    }
    const auth = req.headers.authorization || '';
    if (this.forceUnauthorizedOnce) {
      this.forceUnauthorizedOnce = false;
      this.counters.rejected += 1;
      send(401, { error: 'expired' });
      return;
    }
    if (auth !== `Bearer ${this.sessionToken}`) {
      this.counters.rejected += 1;
      send(401, { error: 'unauthorized' });
      return;
    }
    if (req.url === '/api/v1/devices') {
      this.counters.devices += 1;
      send(200, { devices: this.devices });
      return;
    }
    if (req.url === '/api/v1/alerts') {
      this.counters.alerts += 1;
      send(200, { alerts: this.alerts });
      return;
    }
    if (req.url === '/api/v1/location') {
      this.counters.locations += 1;
      send(200, { locations: this.locations });
      return;
    }
    send(404, { error: 'not found' });
  }

  close() {
    return new Promise((resolve) => {
      if (this.server === null) return resolve();
      const server = this.server;
      this.server = null;
      server.close(() => resolve());
    });
  }
}

module.exports = Object.freeze({ FakeApi });
