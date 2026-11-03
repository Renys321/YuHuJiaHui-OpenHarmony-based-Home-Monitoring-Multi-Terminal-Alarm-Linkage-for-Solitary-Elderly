#!/usr/bin/env node
/**
 * Public backend edge gateway.
 *
 * This entry point deliberately does not connect to OneNET. It subscribes to the
 * existing local MQTT status topic, uploads validated state to the public HTTPS
 * backend, and polls that backend for ACK commands. The ingest key is read from
 * an interactive hidden prompt and is never placed in argv, process.env, or a
 * project file.
 */
'use strict';

const { EventEmitter } = require('node:events');
const { createGateway } = require('./gateway');

const DEFAULT_PUBLIC_BACKEND_URL = 'https://api.luxunacc.xyz';

function validatePublicOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('BACKEND_URL must be a valid absolute URL');
  }
  if (parsed.protocol !== 'https:') throw new TypeError('BACKEND_URL must use HTTPS');
  if (parsed.username || parsed.password) throw new TypeError('BACKEND_URL must not contain credentials');
  if (parsed.search || parsed.hash) throw new TypeError('BACKEND_URL must not contain query or fragment');
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new TypeError('BACKEND_URL must be an origin without a path');
  }
  return parsed.origin;
}

function describeBroker(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return 'configured';
  }
}

function readHidden(promptText, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(Object.assign(
      new Error('a TTY is required for hidden secret input'),
      { code: 'TTY_REQUIRED' }
    ));
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = Boolean(input.isRaw);

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const finish = () => {
      cleanup();
      output.write('\n');
      if (!value) {
        reject(Object.assign(new Error('INGEST_KEY must not be empty'), { code: 'EMPTY_SECRET' }));
        return;
      }
      resolve(value);
    };
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          output.write('\n');
          reject(Object.assign(new Error('secret input cancelled'), { code: 'INPUT_CANCELLED' }));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\b' || char === '\u007f') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (char >= ' ' && value.length < 4096) {
          value += char;
          output.write('*');
        }
      }
    };

    output.write(promptText);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function createBackendOnlyTransport() {
  const transport = new EventEmitter();
  transport.publishProperty = async () => ({ skipped: true });
  transport.publishAlarm = async () => ({ skipped: true });
  return transport;
}

async function main(options = {}) {
  const env = options.env || process.env;
  const backendUrl = validatePublicOrigin(env.BACKEND_URL || DEFAULT_PUBLIC_BACKEND_URL);
  const brokerUrl = env.GATEWAY_BROKER_URL || 'mqtt://127.0.0.1:1883';
  let ingestKey = options.ingestKey || '';
  if (!ingestKey) {
    ingestKey = await readHidden('Enter public backend INGEST_KEY (hidden): ');
  }

  const gateway = createGateway({
    env,
    brokerUrl,
    transport: createBackendOnlyTransport(),
    cloudSyncOptions: { backendUrl, ingestKey },
    commandSyncOptions: { backendUrl, ingestKey }
  });
  // The clients above retain the key in private closures. Drop this reference
  // before entering the long-running event loop.
  ingestKey = '';

  console.log(`[public-sync] CONFIG backend=${backendUrl}`);
  console.log(`[public-sync] CONFIG broker=${describeBroker(brokerUrl)}`);
  console.log('[public-sync] CONFIG ingestKey=set');

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    await gateway.stop(signal);
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  gateway.start();
  return gateway;
}

if (require.main === module) {
  main().catch((error) => {
    const code = error && typeof error.code === 'string' ? error.code : 'START_FAILED';
    console.error(`[public-sync] FATAL code=${code}`);
    process.exit(1);
  });
}

module.exports = Object.freeze({
  DEFAULT_PUBLIC_BACKEND_URL,
  validatePublicOrigin,
  describeBroker,
  readHidden,
  createBackendOnlyTransport,
  main
});
