'use strict';

/**
 * source-api.js — 公网 APP-API 只读镜像数据源（fallback）。
 *
 * 为什么存在：公网 ECS Broker 的 MQTT clientId 是**严格白名单**，镜像专用 clientId 未经
 * 运维加入白名单时无法订阅 UP_TOPIC；而镜像又绝不能复用设备 clientId（会踢掉设备）。
 * 本数据源用**现有监护人账号**（不新造账号体系）登录同一套公网 API，只读
 *   GET /api/v1/devices、/api/v1/alerts、/api/v1/location
 * 拉取与手机 APP 完全一致的设备状态 / alarmId / ACKED 状态 / 定位记录。
 *
 * ACKED 语义：后端只在收到**设备真实回执**后才置 ACKED（DESIGN-CONTRACT §5.3），
 * 本数据源原样镜像后端状态，绝不自行推断或代报确认。
 *
 * 凭据：只从 env/凭据文件读取，绝不打印；日志只出现“是否有凭据”。
 */

const DEVICE_ID = 'esp32-sos';
const ALARM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const MAX_BACKOFF_MS = 60000;

function normalizeBase(base) {
  return String(base || '').replace(/\/+$/, '');
}

class ApiSource {
  constructor(options = {}) {
    this.config = options.config;
    this.model = options.model;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {};
    this.onFatal = typeof options.onFatal === 'function' ? options.onFatal : () => {};
    this.base = normalizeBase(this.config.api.base);
    this.pollMs = this.config.api.pollMs;
    this.timeoutMs = this.config.api.requestTimeoutMs;
    this.token = '';
    this.tokenExpiresAt = 0;
    this.stopped = false;
    this.timer = null;
    this.polling = false;
    this.inflight = null;
    this.failures = 0;
    this.counters = {
      polls: 0, ok: 0, errors: 0, authFailures: 0, logins: 0,
      lastError: '', lastOkAt: 0, lastPollAt: 0
    };
    this.lastSnapshot = null;
  }

  start() {
    this.stopped = false;
    this.scheduleNext(0);
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      try { this.inflight.abort(); } catch (err) { /* ignore */ }
      this.inflight = null;
    }
  }

  scheduleNext(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pollOnce().catch((err) => {
        this.counters.errors += 1;
        this.counters.lastError = err && (err.code || err.message);
        this.log(`[source-api] poll crashed: ${this.counters.lastError}`);
        this.scheduleNext(this.nextDelay());
      });
    }, delayMs);
  }

  nextDelay() {
    const base = this.pollMs;
    const delay = Math.min(MAX_BACKOFF_MS, base * Math.pow(2, Math.min(this.failures, 6)));
    return Math.max(base, delay);
  }

  async requestJson(path, options = {}) {
    const controller = new AbortController();
    this.inflight = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { accept: 'application/json' };
      if (this.token !== '') headers.authorization = `Bearer ${this.token}`;
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${this.base}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });
      const text = await response.text();
      let body = null;
      if (text !== '') {
        try { body = JSON.parse(text); } catch (err) { body = null; }
      }
      return { status: response.status, body, retryAfter: response.headers.get('retry-after') };
    } finally {
      clearTimeout(timer);
      if (this.inflight === controller) this.inflight = null;
    }
  }

  async ensureToken() {
    if (this.token !== '' && Date.now() < this.tokenExpiresAt) return true;
    this.token = '';
    const login = await this.requestJson('/api/v1/auth/app', {
      method: 'POST',
      body: { guardianId: this.config.api.guardianId, password: this.config.api.password }
    });
    if (login.status === 429) {
      this.counters.authFailures += 1;
      this.counters.lastError = 'LOGIN_RATE_LIMITED';
      this.log(`[source-api] login rate limited (retry-after=${login.retryAfter || '?'})`);
      return false;
    }
    if (login.status !== 200 || login.body === null || typeof login.body.sessionToken !== 'string' ||
        login.body.sessionToken === '') {
      this.counters.authFailures += 1;
      this.counters.lastError = `LOGIN_HTTP_${login.status}`;
      this.log(`[source-api] login failed http=${login.status}`);
      return false;
    }
    this.token = login.body.sessionToken;
    const expiresIn = Number.isFinite(login.body.expiresIn) ? login.body.expiresIn : 7200;
    this.tokenExpiresAt = Date.now() + Math.max(60, expiresIn - 300) * 1000;
    this.counters.logins += 1;
    this.log('[source-api] login ok (token cached, value never logged)');
    return true;
  }

  async fetchWithAuth(path) {
    let result = await this.requestJson(path);
    if (result.status === 401) {
      this.token = '';
      this.counters.authFailures += 1;
      const relogged = await this.ensureToken();
      if (!relogged) return result;
      result = await this.requestJson(path);
    }
    return result;
  }

  async pollOnce() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    this.counters.polls += 1;
    this.counters.lastPollAt = Date.now();
    try {
      let tokenOk = await this.ensureToken();
      if (!tokenOk) {
        this.failures += 1;
        this.scheduleNext(this.nextDelay());
        return;
      }
      const devicesRes = await this.fetchWithAuth('/api/v1/devices');
      if (devicesRes.status === 401) {
        this.token = '';
        this.failures += 1;
        this.counters.errors += 1;
        this.counters.lastError = 'AUTH_401';
        this.log('[source-api] devices unauthorized even after re-login');
        this.scheduleNext(this.nextDelay());
        return;
      }
      if (devicesRes.status !== 200 || devicesRes.body === null || !Array.isArray(devicesRes.body.devices)) {
        this.failures += 1;
        this.counters.errors += 1;
        this.counters.lastError = `DEVICES_HTTP_${devicesRes.status}`;
        this.log(`[source-api] devices http=${devicesRes.status}`);
        this.scheduleNext(this.nextDelay());
        return;
      }
      const device = devicesRes.body.devices.find((item) => item && (item.id === DEVICE_ID || item.deviceId === DEVICE_ID)) || null;
      if (device === null) {
        this.failures = 0;
        this.counters.ok += 1;
        this.counters.lastOkAt = Date.now();
        /* 后端没有该设备（例如从未上报）：不伪造任何状态，只保持上一份真实快照。 */
        this.log('[source-api] device esp32-sos not present in /api/v1/devices');
        this.scheduleNext(this.pollMs);
        return;
      }

      let alerts = [];
      try {
        const alertsRes = await this.fetchWithAuth('/api/v1/alerts');
        if (alertsRes.status === 200 && alertsRes.body !== null && Array.isArray(alertsRes.body.alerts)) {
          alerts = alertsRes.body.alerts;
        }
      } catch (err) {
        this.log(`[source-api] alerts fetch failed: ${err && (err.code || err.message)}`);
      }

      let location = null;
      try {
        const locationRes = await this.fetchWithAuth('/api/v1/location');
        if (locationRes.status === 200 && locationRes.body !== null && Array.isArray(locationRes.body.locations)) {
          location = locationRes.body.locations.find((item) => item && item.deviceId === DEVICE_ID) || null;
        }
      } catch (err) {
        this.log(`[source-api] location fetch failed: ${err && (err.code || err.message)}`);
      }

      const snapshot = this.buildSnapshot(device, alerts, location);
      this.lastSnapshot = snapshot;
      this.counters.ok += 1;
      this.counters.lastOkAt = Date.now();
      this.failures = 0;
      const result = this.model.applyApiSnapshot(snapshot, Date.now());
      if (this.model.source !== 'api') this.model.source = 'api';
      this.onChanged(result);
      this.scheduleNext(this.pollMs);
    } catch (err) {
      this.failures += 1;
      this.counters.errors += 1;
      this.counters.lastError = err && (err.code || err.name || err.message);
      this.log(`[source-api] poll error: ${this.counters.lastError}`);
      this.scheduleNext(this.nextDelay());
    } finally {
      this.polling = false;
    }
  }

  buildSnapshot(device, alerts, location) {
    const state = typeof device.state === 'string' ? device.state.toUpperCase() : '';
    const online = typeof device.online === 'boolean' ? device.online : undefined;
    const lastSeenTs = Number.isFinite(device.lastSeenTs) ? device.lastSeenTs : 0;
    const candidates = alerts
      .filter((alert) => alert && alert.deviceId === DEVICE_ID && typeof (alert.alarmId || alert.id) === 'string')
      .map((alert) => ({
        id: alert.alarmId || alert.id,
        type: typeof alert.type === 'string' ? alert.type : '',
        state: typeof alert.state === 'string' ? alert.state.toUpperCase() : '',
        ackPending: alert.ackPending === true,
        createdAt: Number.isFinite(alert.createdAt) ? alert.createdAt : 0,
        acknowledgedAt: Number.isFinite(alert.acknowledgedAt) ? alert.acknowledgedAt : 0
      }))
      .filter((alert) => ALARM_ID_RE.test(alert.id))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    let alert = null;
    if (state === 'ALARM') {
      alert = candidates.find((item) => item.state !== 'ACKED') || candidates[0] || null;
    } else if (state === 'ACKED') {
      alert = candidates[0] || null;
    } else if (candidates.length > 0 && candidates[0].state !== 'ACKED') {
      /* 设备状态尚未刷新为 ALARM，但后端已有未 ACKED 的新告警：如实上报该告警。 */
      alert = candidates[0];
    }

    let gps = null;
    if (location !== null && location !== undefined &&
        Number.isFinite(location.latitude) && Number.isFinite(location.longitude) &&
        !(location.latitude === 0 && location.longitude === 0)) {
      gps = {
        valid: true,
        latitude: location.latitude,
        longitude: location.longitude,
        fixTime: Number.isFinite(location.fixTime) ? location.fixTime : 0
      };
    }
    return { online, lastSeenTs, state, alarm: alert, gps, location };
  }

  status() {
    return Object.assign({
      kind: 'api',
      base: this.base,
      running: !this.stopped,
      lastSnapshot: this.lastSnapshot === null ? null : {
        state: this.lastSnapshot.state,
        online: this.lastSnapshot.online,
        lastSeenTs: this.lastSnapshot.lastSeenTs,
        alarmId: this.lastSnapshot.alarm === null ? '' : this.lastSnapshot.alarm.id,
        alarmState: this.lastSnapshot.alarm === null ? '' : this.lastSnapshot.alarm.state,
        gpsValid: this.lastSnapshot.gps !== null
      }
    }, this.counters);
  }
}

module.exports = Object.freeze({ ApiSource, DEVICE_ID });
