'use strict';

const { createTransportFromEnv } = require('./transport');

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_POST_ACK_HOLD_MS = 10_000;
const DEFAULT_PRODUCT_ID = 'I19NBBq4xe';
const DEFAULT_DEVICE_NAME = 'dayu200-home-gateway';
const SAFE_ERROR_CODES = new Set([
  'ACK_TIMEOUT',
  'CLOUD_REJECTED',
  'CONNECT_SETUP_FAILED',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'INVALID_REPLY',
  'MESSAGE_FAILED',
  'MISSING_DEVICE_KEY',
  'MQTT_ERROR',
  'NOT_READY',
  'PUBLISH_FAILED',
  'SUBSCRIBE_FAILED',
  'TRANSPORT_STOPPED'
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireEnvironment(env) {
  if (!env || typeof env !== 'object') throw codedError('INVALID_ENVIRONMENT');
  if (env.ONENET_PRODUCT_ID !== DEFAULT_PRODUCT_ID) throw codedError('INVALID_PRODUCT_ID');
  if (env.ONENET_DEVICE_NAME !== DEFAULT_DEVICE_NAME) throw codedError('INVALID_DEVICE_NAME');
  if (typeof env.ONENET_DEVICE_KEY !== 'string' || env.ONENET_DEVICE_KEY.length === 0) {
    throw codedError('MISSING_DEVICE_KEY');
  }
}

function createMessageContext(now = Date.now) {
  const timestampMs = now();
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 1_000_000_000_000 || timestampMs > 9_999_999_999_999) {
    throw codedError('INVALID_CLOCK');
  }
  const id = String(timestampMs);
  if (!/^\d{1,13}$/.test(id)) throw codedError('INVALID_MESSAGE_ID');
  return Object.freeze({ id, timestampMs });
}

function buildGatewaySnapshot() {
  return Object.freeze({
    deviceId: DEFAULT_DEVICE_NAME,
    room: '家庭网关',
    online: true,
    state: 'NORMAL',
    motion: Object.freeze({ lastActiveTs: 0, countToday: 0 }),
    door: Object.freeze({ open: false, lastOpenTs: 0 }),
    fall: Object.freeze({ detected: false, confidence: 0, detectedAt: 0 }),
    alarm: Object.freeze({ id: '', type: '', countToday: 0 }),
    gps: Object.freeze({ valid: false, fixTime: 0 }),
    csq: 99
  });
}

function safeCode(error) {
  return error && SAFE_ERROR_CODES.has(error.code) ? error.code : 'LIVE_CHECK_FAILED';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForReadyOrError(transport, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      transport.off('ready', onReady);
      transport.off('transportError', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(codedError(safeCode(error)));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(codedError('CONNECT_TIMEOUT'));
    }, timeoutMs);
    transport.once('ready', onReady);
    transport.once('transportError', onError);
  });
}

async function runLiveCheck(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const now = options.now || Date.now;
  const timeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
  const postAckHoldMs = options.postAckHoldMs === undefined
    ? DEFAULT_POST_ACK_HOLD_MS
    : options.postAckHoldMs;
  if (!Number.isSafeInteger(postAckHoldMs) || postAckHoldMs < 0 || postAckHoldMs > 60_000) {
    throw codedError('INVALID_HOLD_TIME');
  }
  const transportFactory = options.transportFactory || ((sourceEnv) => createTransportFromEnv(sourceEnv));

  requireEnvironment(env);
  const context = createMessageContext(now);
  const transport = transportFactory(env);
  let connectedLogged = false;
  let subscribedLogged = false;
  const onConnected = () => {
    if (!connectedLogged) logger.log('[OneNET] MQTT_CONNECTED');
    connectedLogged = true;
  };
  const onSubscribed = () => {
    if (!subscribedLogged) logger.log('[OneNET] SUBSCRIPTIONS_OK');
    subscribedLogged = true;
  };
  transport.on('connected', onConnected);
  transport.on('subscribed', onSubscribed);

  logger.log(`[OneNET] START product=${env.ONENET_PRODUCT_ID} device=${env.ONENET_DEVICE_NAME}`);
  try {
    const ready = waitForReadyOrError(transport, timeoutMs);
    transport.start();
    await ready;
    const reply = await transport.publishProperty(buildGatewaySnapshot(), context);
    if (!reply || reply.code !== 200) throw codedError('CLOUD_REJECTED');
    logger.log(`[OneNET] PROPERTY_ACCEPTED code=200 id=${reply.id}`);
    if (postAckHoldMs > 0) {
      logger.log(`[OneNET] HOLDING_CONNECTION ms=${postAckHoldMs}`);
      await delay(postAckHoldMs);
    }
    return Object.freeze({ connected: true, subscribed: true, accepted: true, code: 200 });
  } finally {
    transport.off('connected', onConnected);
    transport.off('subscribed', onSubscribed);
    await transport.stop();
  }
}

async function main() {
  try {
    await runLiveCheck();
  } catch (error) {
    console.error(`[OneNET] FAILED code=${safeCode(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = Object.freeze({
  buildGatewaySnapshot,
  createMessageContext,
  runLiveCheck,
  safeCode
});
