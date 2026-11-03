'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildTopics,
  makePropertySetReply,
  mapPropertySet,
  toAlarmEvent,
  toPropertyPost
} = require('./adapter');
const { createDeviceToken } = require('./token');

const MAX_PAYLOAD_BYTES = 16 * 1024;
const DEFAULT_PORT = 8883;
const DEFAULT_TOKEN_TTL_SEC = 3600;
const DEFAULT_ACK_TIMEOUT_MS = 10000;
const DEFAULT_RECONNECT_MIN_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30000;
const ONENET_CERT_FINGERPRINT256 = '7D:E9:BC:4C:1A:ED:01:34:46:67:64:56:78:D4:49:74:12:10:B1:70:49:48:98:38:BF:63:79:53:B3:E9:01:17';
const DEFAULT_CA = fs.readFileSync(path.join(__dirname, 'certs', 'onenet-mqtt-ca.pem'));

function fail(message) {
  throw new TypeError(message);
}

function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function requireInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requireHost(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253) fail('host is invalid');
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(value)) {
    fail('host must be a DNS name');
  }
  return value.toLowerCase();
}

function requireFingerprint(value) {
  if (typeof value !== 'string' || !/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(value)) {
    fail('certificateFingerprint256 must be a SHA-256 fingerprint');
  }
  return value.toUpperCase();
}

function checkOneNetServerIdentity(_host, certificate, expectedFingerprint = ONENET_CERT_FINGERPRINT256) {
  const expected = requireFingerprint(expectedFingerprint);
  const actual = certificate && typeof certificate.fingerprint256 === 'string'
    ? certificate.fingerprint256.toUpperCase()
    : '';
  const commonName = certificate && certificate.subject && certificate.subject.CN;
  if (actual !== expected || commonName !== 'OneNET MQTTS') {
    return safeError('OneNET TLS certificate pin mismatch', 'ONENET_CERT_MISMATCH');
  }
  return undefined;
}

function safeError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function parseJsonPayload(payload, name) {
  let text;
  if (Buffer.isBuffer(payload)) {
    if (payload.length > MAX_PAYLOAD_BYTES) throw safeError(`${name} is too large`, 'PAYLOAD_TOO_LARGE');
    text = payload.toString('utf8');
  } else if (typeof payload === 'string') {
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw safeError(`${name} is too large`, 'PAYLOAD_TOO_LARGE');
    }
    text = payload;
  } else {
    throw safeError(`${name} is invalid`, 'INVALID_PAYLOAD');
  }
  try {
    return requireObject(JSON.parse(text), name);
  } catch {
    throw safeError(`${name} is invalid`, 'INVALID_PAYLOAD');
  }
}

function extractRequestId(payload) {
  try {
    const parsed = parseJsonPayload(payload, 'property/set payload');
    return typeof parsed.id === 'string' && /^\d{1,13}$/.test(parsed.id) ? parsed.id : null;
  } catch {
    return null;
  }
}

function parseCloudReply(payload) {
  const parsed = parseJsonPayload(payload, 'OneNET reply');
  if (typeof parsed.id !== 'string' || !/^\d{1,13}$/.test(parsed.id)) {
    throw safeError('OneNET reply id is invalid', 'INVALID_REPLY');
  }
  if (!Number.isSafeInteger(parsed.code)) throw safeError('OneNET reply code is invalid', 'INVALID_REPLY');
  return Object.freeze({ id: parsed.id, code: parsed.code });
}

function loadMqttConnect() {
  return require('mqtt').connect;
}

class OneNetTransport extends EventEmitter {
  constructor(options) {
    super();
    requireObject(options, 'options');
    const topics = buildTopics(options.productId, options.deviceName);
    if (typeof options.getDeviceKey !== 'function') fail('getDeviceKey must be a function');
    if (options.handleCommand !== undefined && typeof options.handleCommand !== 'function') {
      fail('handleCommand must be a function');
    }

    this.productId = options.productId;
    this.deviceName = options.deviceName;
    this.host = requireHost(options.host || `${options.productId}.mqttstls.acc.cmcconenet.cn`);
    this.port = requireInteger(options.port === undefined ? DEFAULT_PORT : options.port, 'port', 1, 65535);
    this.tokenTtlSec = requireInteger(
      options.tokenTtlSec === undefined ? DEFAULT_TOKEN_TTL_SEC : options.tokenTtlSec,
      'tokenTtlSec', 300, 86400
    );
    this.ackTimeoutMs = requireInteger(
      options.ackTimeoutMs === undefined ? DEFAULT_ACK_TIMEOUT_MS : options.ackTimeoutMs,
      'ackTimeoutMs', 100, 120000
    );
    this.reconnectMinMs = requireInteger(
      options.reconnectMinMs === undefined ? DEFAULT_RECONNECT_MIN_MS : options.reconnectMinMs,
      'reconnectMinMs', 10, 60000
    );
    this.reconnectMaxMs = requireInteger(
      options.reconnectMaxMs === undefined ? DEFAULT_RECONNECT_MAX_MS : options.reconnectMaxMs,
      'reconnectMaxMs', this.reconnectMinMs, 300000
    );
    this.getDeviceKey = options.getDeviceKey;
    this.handleCommand = options.handleCommand || (async () => ({
      ok: false,
      message: 'command handler unavailable'
    }));
    this.mqttConnect = options.mqttConnect || loadMqttConnect();
    if (typeof this.mqttConnect !== 'function') fail('mqttConnect must be a function');
    const hasCustomCa = options.ca !== undefined;
    const hasCustomFingerprint = options.certificateFingerprint256 !== undefined;
    if (hasCustomCa !== hasCustomFingerprint) {
      fail('ca and certificateFingerprint256 must be provided together');
    }
    this.ca = hasCustomCa ? options.ca : DEFAULT_CA;
    this.certificateFingerprint256 = requireFingerprint(
      hasCustomFingerprint ? options.certificateFingerprint256 : ONENET_CERT_FINGERPRINT256
    );
    this.nowSec = options.nowSec || (() => Math.floor(Date.now() / 1000));
    if (typeof this.nowSec !== 'function') fail('nowSec must be a function');

    this.topics = topics;
    this.running = false;
    this.ready = false;
    this.connecting = false;
    this.client = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.pending = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this._connect();
  }

  async stop() {
    this.running = false;
    this.ready = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._rejectPending(safeError('transport stopped', 'TRANSPORT_STOPPED'));
    const client = this.client;
    this.client = null;
    if (!client) return;
    await new Promise((resolve) => client.end(true, {}, resolve));
  }

  waitForReady(timeoutMs = 15000) {
    requireInteger(timeoutMs, 'timeoutMs', 1, 300000);
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('ready', onReady);
        reject(safeError('OneNET connection timed out', 'CONNECT_TIMEOUT'));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('ready', onReady);
    });
  }

  publishProperty(status, options = {}) {
    const payload = toPropertyPost(status, options);
    return this._publishWithCloudAck(
      this.topics.propertyPost,
      this.topics.propertyPostReply,
      payload
    );
  }

  publishAlarm(status, options = {}) {
    const payload = toAlarmEvent(status, options);
    return this._publishWithCloudAck(
      this.topics.eventPost,
      this.topics.eventPostReply,
      payload
    );
  }

  async _connect() {
    if (!this.running || this.connecting || this.client) return;
    this.connecting = true;
    try {
      const now = this.nowSec();
      requireInteger(now, 'nowSec()', 1, 9_999_999_999);
      const deviceKey = await this.getDeviceKey();
      if (!this.running) return;
      const password = createDeviceToken({
        productId: this.productId,
        deviceName: this.deviceName,
        deviceKey,
        expiresAtSec: now + this.tokenTtlSec
      });
      const connectOptions = {
        protocol: 'mqtts',
        protocolVersion: 4,
        clientId: this.deviceName,
        username: this.productId,
        password,
        clean: true,
        keepalive: 60,
        connectTimeout: 10000,
        reconnectPeriod: 0,
        resubscribe: false,
        queueQoSZero: false,
        rejectUnauthorized: true,
        servername: this.host,
        ca: this.ca,
        checkServerIdentity: (host, certificate) => checkOneNetServerIdentity(
          host,
          certificate,
          this.certificateFingerprint256
        )
      };
      const client = this.mqttConnect(`mqtts://${this.host}:${this.port}`, connectOptions);
      if (!client || typeof client.on !== 'function') fail('mqttConnect returned an invalid client');
      this.client = client;
      this._bindClient(client);
    } catch {
      this.emit('transportError', safeError('OneNET connection setup failed', 'CONNECT_SETUP_FAILED'));
      this._scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  _bindClient(client) {
    client.on('connect', () => void this._onConnected(client));
    client.on('message', (topic, payload) => {
      void this._onMessage(client, topic, payload).catch(() => {
        this.emit('transportError', safeError('OneNET message handling failed', 'MESSAGE_FAILED'));
      });
    });
    client.on('error', () => {
      this.emit('transportError', safeError('OneNET MQTT connection error', 'MQTT_ERROR'));
    });
    client.on('close', () => this._onClosed(client));
  }

  async _onConnected(client) {
    if (!this.running || client !== this.client) return;
    this.emit('connected');
    try {
      await new Promise((resolve, reject) => {
        client.subscribe({
          [this.topics.propertyPostReply]: { qos: 1 },
          [this.topics.propertySet]: { qos: 1 },
          [this.topics.eventPostReply]: { qos: 1 }
        }, (error) => error ? reject(error) : resolve());
      });
      if (!this.running || client !== this.client) return;
      this.ready = true;
      this.reconnectAttempt = 0;
      this.emit('subscribed');
      this.emit('ready');
    } catch {
      this.emit('transportError', safeError('OneNET topic subscription failed', 'SUBSCRIBE_FAILED'));
      client.end(true);
    }
  }

  _onClosed(client) {
    if (client !== this.client) return;
    this.client = null;
    this.ready = false;
    this._rejectPending(safeError('OneNET connection closed', 'CONNECTION_CLOSED'));
    this.emit('disconnected');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMinMs * (2 ** Math.min(this.reconnectAttempt, 16)),
      this.reconnectMaxMs
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this._connect();
    }, delay);
  }

  async _onMessage(client, topic, payload) {
    if (!this.running || client !== this.client) return;
    if (topic === this.topics.propertySet) {
      await this._onPropertySet(client, payload);
      return;
    }
    if (topic === this.topics.propertyPostReply || topic === this.topics.eventPostReply) {
      let reply;
      try {
        reply = parseCloudReply(payload);
      } catch {
        this.emit('transportError', safeError('OneNET returned an invalid reply', 'INVALID_REPLY'));
        return;
      }
      const key = `${topic}:${reply.id}`;
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (reply.code === 200) pending.resolve(reply);
      else pending.reject(safeError(`OneNET rejected message with code ${reply.code}`, 'CLOUD_REJECTED'));
      this.emit('cloudReply', reply);
    }
  }

  async _onPropertySet(client, payload) {
    const fallbackId = extractRequestId(payload);
    let request;
    try {
      request = mapPropertySet(payload);
    } catch {
      if (fallbackId) {
        await this._publishJson(client, this.topics.propertySetReply, makePropertySetReply(fallbackId, {
          ok: false,
          message: 'invalid command'
        }));
      }
      this.emit('commandRejected', Object.freeze({ requestId: fallbackId, reason: 'invalid-command' }));
      return;
    }

    let result;
    try {
      result = await this.handleCommand(request.command, Object.freeze({ requestId: request.requestId }));
      requireObject(result, 'command result');
      result = makePropertySetReply(request.requestId, result);
    } catch {
      result = makePropertySetReply(request.requestId, { ok: false, message: 'command failed' });
    }
    await this._publishJson(client, this.topics.propertySetReply, result);
    this.emit('commandHandled', Object.freeze({
      requestId: request.requestId,
      command: request.command.command,
      ok: result.code === 200
    }));
  }

  _publishWithCloudAck(topic, replyTopic, payload) {
    if (!this.ready || !this.client) {
      return Promise.reject(safeError('OneNET transport is not ready', 'NOT_READY'));
    }
    const key = `${replyTopic}:${payload.id}`;
    if (this.pending.has(key)) {
      return Promise.reject(safeError('message id is already pending', 'DUPLICATE_MESSAGE_ID'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(safeError('OneNET application reply timed out', 'ACK_TIMEOUT'));
      }, this.ackTimeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      this._publishJson(this.client, topic, payload).catch((error) => {
        const pending = this.pending.get(key);
        if (!pending) return;
        this.pending.delete(key);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  _publishJson(client, topic, payload) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
      return Promise.reject(safeError('outgoing payload is too large', 'PAYLOAD_TOO_LARGE'));
    }
    return new Promise((resolve, reject) => {
      client.publish(topic, body, { qos: 1, retain: false }, (error) => {
        if (error) reject(safeError('MQTT publish failed', 'PUBLISH_FAILED'));
        else resolve();
      });
    });
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function createTransportFromEnv(env = process.env, overrides = {}) {
  requireObject(env, 'env');
  requireObject(overrides, 'overrides');
  const productId = overrides.productId || env.ONENET_PRODUCT_ID;
  const deviceName = overrides.deviceName || env.ONENET_DEVICE_NAME;
  const getDeviceKey = overrides.getDeviceKey || (() => {
    const value = env.ONENET_DEVICE_KEY;
    if (!value) throw safeError('ONENET_DEVICE_KEY is not configured', 'MISSING_DEVICE_KEY');
    return value;
  });
  return new OneNetTransport({ ...overrides, productId, deviceName, getDeviceKey });
}

module.exports = Object.freeze({
  ONENET_CERT_FINGERPRINT256,
  OneNetTransport,
  checkOneNetServerIdentity,
  createTransportFromEnv,
  parseCloudReply
});
