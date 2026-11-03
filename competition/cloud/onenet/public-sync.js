#!/usr/bin/env node
/**
 * 对外后端的边缘网关入口。
 *
 * 这个进程不连 OneNET：订阅本机已有的 MQTT 状态主题，把校验过的状态上报到公网 HTTPS
 * 后端，再轮询后端取 ACK 命令。ingest key 用隐藏交互输入读取，不进 argv、process.env，
 * 也不落到项目文件里。
 */
'use strict';

const { EventEmitter } = require('node:events');
const { createGateway } = require('./gateway');

const DEFAULT_PUBLIC_BACKEND_URL = 'https://api.luxunacc.xyz';

/* 本机房间设备白名单
 * public-sync 只承接这些本机已接入设备的 ACK 下行。随身求助 esp32-sos 走 4G→ECS，
 * 不经过本机 Bridge/homemon；如果这里也去领它的 ACK 命令，命令会发到
 * home/esp32-sos/cmd，本机没有消费者，后端永远拿不到 ACKED。
 * 白名单外的命令只推进游标。可用 COMMAND_SYNC_ALLOWED_DEVICES（逗号分隔）覆盖。 */
const DEFAULT_LOCAL_DEVICE_IDS = Object.freeze(['dayu200-living', 'esp32-kitchen', 'esp32-bath']);

function resolveLocalDeviceIds(env = process.env) {
  const raw = typeof env.COMMAND_SYNC_ALLOWED_DEVICES === 'string' ? env.COMMAND_SYNC_ALLOWED_DEVICES : '';
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return list.length > 0 ? list : DEFAULT_LOCAL_DEVICE_IDS.slice();
}

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
    commandSyncOptions: { backendUrl, ingestKey, allowedDeviceIds: resolveLocalDeviceIds(env) }
  });
  // 上面的客户端各自在闭包里留着 key，进长循环前把这个引用丢掉。
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
  DEFAULT_LOCAL_DEVICE_IDS,
  resolveLocalDeviceIds,
  validatePublicOrigin,
  describeBroker,
  readHidden,
  createBackendOnlyTransport,
  main
});
