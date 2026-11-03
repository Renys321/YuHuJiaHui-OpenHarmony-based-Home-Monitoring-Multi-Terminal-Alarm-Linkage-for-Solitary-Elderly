'use strict';

const { createTransportFromEnv } = require('./transport');

const PRODUCT_ID = 'I19NBBq4xe';
const DEVICE_NAME = 'dayu200-home-gateway';
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const SAFE_ERROR_CODES = new Set([
  'COMMAND_TIMEOUT',
  'CONNECT_SETUP_FAILED',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'MESSAGE_FAILED',
  'MISSING_DEVICE_KEY',
  'MQTT_ERROR',
  'SUBSCRIBE_FAILED',
  'TRANSPORT_STOPPED'
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeCode(error) {
  return error && SAFE_ERROR_CODES.has(error.code) ? error.code : 'DOWNLINK_CHECK_FAILED';
}

function requireEnvironment(env) {
  if (!env || typeof env !== 'object') throw codedError('INVALID_ENVIRONMENT');
  if (env.ONENET_PRODUCT_ID !== PRODUCT_ID) throw codedError('INVALID_PRODUCT_ID');
  if (env.ONENET_DEVICE_NAME !== DEVICE_NAME) throw codedError('INVALID_DEVICE_NAME');
  if (typeof env.ONENET_DEVICE_KEY !== 'string' || env.ONENET_DEVICE_KEY.length === 0) {
    throw codedError('MISSING_DEVICE_KEY');
  }
}

function waitForEventOrError(transport, eventName, timeoutMs, timeoutCode) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      transport.off(eventName, onEvent);
      transport.off('transportError', onError);
    };
    const onEvent = (event) => {
      cleanup();
      resolve(event);
    };
    const onError = (error) => {
      cleanup();
      reject(codedError(safeCode(error)));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(codedError(timeoutCode));
    }, timeoutMs);
    transport.once(eventName, onEvent);
    transport.once('transportError', onError);
  });
}

async function runDownlinkCheck(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const connectTimeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
  const transportFactory = options.transportFactory || ((sourceEnv, overrides) => (
    createTransportFromEnv(sourceEnv, overrides)
  ));

  requireEnvironment(env);
  for (const [name, value] of Object.entries({ connectTimeoutMs, commandTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 100 || value > 900_000) {
      throw codedError(`INVALID_${name.toUpperCase()}`);
    }
  }

  const handleCommand = async (command) => {
    if (!command || command.command !== 'RESET') {
      return { ok: false, message: 'downlink check accepts RESET only' };
    }
    logger.log('[OneNET] DOWNLINK_RECEIVED command=RESET');
    return { ok: true };
  };
  const transport = transportFactory(env, { handleCommand });
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

  logger.log(`[OneNET] START_DOWNLINK product=${env.ONENET_PRODUCT_ID} device=${env.ONENET_DEVICE_NAME}`);
  try {
    const ready = waitForEventOrError(transport, 'ready', connectTimeoutMs, 'CONNECT_TIMEOUT');
    transport.start();
    await ready;
    logger.log(`[OneNET] WAITING_FOR_COMMAND command=RESET timeout_ms=${commandTimeoutMs}`);

    while (true) {
      const handled = await waitForEventOrError(
        transport,
        'commandHandled',
        commandTimeoutMs,
        'COMMAND_TIMEOUT'
      );
      if (handled && handled.command === 'RESET' && handled.ok === true) {
        logger.log('[OneNET] DOWNLINK_REPLIED command=RESET code=200');
        return Object.freeze({ connected: true, subscribed: true, command: 'RESET', replied: true });
      }
      logger.log('[OneNET] DOWNLINK_REJECTED reason=UNEXPECTED_COMMAND');
    }
  } finally {
    transport.off('connected', onConnected);
    transport.off('subscribed', onSubscribed);
    await transport.stop();
  }
}

async function main() {
  try {
    await runDownlinkCheck();
  } catch (error) {
    console.error(`[OneNET] FAILED code=${safeCode(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = Object.freeze({ runDownlinkCheck, safeCode });
