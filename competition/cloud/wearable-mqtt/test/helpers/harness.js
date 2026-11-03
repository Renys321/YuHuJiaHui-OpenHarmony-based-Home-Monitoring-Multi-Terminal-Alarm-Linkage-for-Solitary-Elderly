'use strict';

/**
 * test/helpers/harness.js — 把“假后端 + 真实 broker/adapter/status”装成一个可测试进程内服务。
 * 所有端口用 0（系统分配），绝不占用本机 1883/9101。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createService } = require('../../src/main');
const { createLogger } = require('../../src/logger');
const { FakeBackend } = require('./fake-backend');

const UP_TOPIC = 'eldercare/wearable/sos-001/up';
const DOWN_TOPIC = 'eldercare/wearable/sos-001/down';

const BASE_ENV = Object.freeze({
  MQTT_USER: 'wearable-user',
  MQTT_PASS: 'wearable-pass',
  MQTT_CLIENT_ID: 'wearable-sos-001,test-device,test-observer',
  // 测试设备统一用 test-device 连接 broker；把“设备侧 MQTT 身份”指到它，
  // 这样链路恢复事件（clientConnect）与业务上行恢复路径都能被真实测试覆盖。
  DEVICE_MQTT_CLIENT_ID: 'test-device',
  // 断连自愈测试用（默认保持 60s，避免干扰其它用例的 device-status 计数断言）。
  DEVICE_ALIVE_TIMEOUT_MS: '60000',
  MQTT_PORT: '0',
  UP_TOPIC,
  DOWN_TOPIC,
  INGEST_KEY: 'test-ingest-key',
  STATUS_HOST: '127.0.0.1',
  STATUS_PORT: '0',
  DEVICE_ID: 'esp32-sos',
  LOCATION_DEVICE_ID: 'wearable-sos-001',
  COMMAND_POLL_INTERVAL_MS: '100',
  COMMAND_RETRY_INTERVAL_MS: '150',
  COMMAND_PARKED_RETRY_MS: '300',
  COMMAND_MAX_ROUNDS: '2',
  COMMAND_MAX_ATTEMPTS: '3',
  HTTP_MAX_ATTEMPTS: '1',
  HTTP_BACKOFF_BASE_MS: '10',
  HTTP_BACKOFF_MAX_MS: '100',
  HTTP_TIMEOUT_MS: '3000',
  SOS_DEDUPE_TTL_MS: '60000',
  LOG_LEVEL: 'error'
});

function waitFor(check, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 4000 : options.timeoutMs;
  const intervalMs = options.intervalMs === undefined ? 20 : options.intervalMs;
  const desired = options.desired === undefined ? true : options.desired;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let value;
      try {
        value = await check();
      } catch (error) {
        value = false;
      }
      if (value === desired || (desired === true && Boolean(value))) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const label = options.label ? ` (${options.label})` : '';
        reject(new Error(`waitFor timed out after ${timeoutMs}ms${label}`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(port, pathname, options = {}) {
  const host = options.host || '127.0.0.1';
  const method = options.method || 'GET';
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, path: pathname, method, timeout: 3000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ statusCode: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('request timed out')));
    request.end();
  });
}

/**
 * @param {object} [options]
 * @param {object} [options.env] 环境变量覆盖
 * @param {string} [options.dataDir] 复用已有数据目录（重启续读测试）
 * @param {FakeBackend} [options.fake] 复用已有假后端（重启续读测试）
 */
async function createHarness(options = {}) {
  const ownsFake = !options.fake;
  const fake = options.fake || new FakeBackend({
    ingestKey: BASE_ENV.INGEST_KEY
  });
  if (ownsFake) await fake.start();

  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wearable-mqtt-test-'));
  const env = {
    ...BASE_ENV,
    BACKEND_BASE: fake.url,
    DATA_DIR: dataDir,
    ...(options.env || {})
  };
  const logs = [];
  const logger = createLogger({
    level: options.logLevel || 'error',
    sink: (line) => logs.push(line)
  });
  let service;
  try {
    service = await createService({ env, logger });
    await service.start();
  } catch (error) {
    // 启动失败也必须关闭假后端，否则遗留的 HTTP server 会让 node --test 无法退出。
    if (ownsFake) await fake.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  const brokerAddress = service.broker.address();
  const statusAddress = service.statusServer.address();

  const harness = {
    fake,
    service,
    logs,
    dataDir,
    env,
    upTopic: env.UP_TOPIC,
    downTopic: env.DOWN_TOPIC,
    brokerPort: brokerAddress.port,
    statusPort: statusAddress.port,
    broker: service.broker,
    adapter: service.adapter,
    state: service.state,
    status: () => requestJson(statusAddress.port, '/status'),
    healthz: () => requestJson(statusAddress.port, '/healthz'),
    async stopService() {
      await service.stop('TEST_STOP');
    },
    async stop(cleanup = true) {
      await service.stop('TEST_STOP');
      if (ownsFake) await fake.stop();
      if (cleanup && !options.keepDataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    },
    async restart() {
      await service.stop('TEST_RESTART');
      return createHarness({
        ...options,
        dataDir,
        fake,
        keepDataDir: true
      });
    }
  };
  return harness;
}

module.exports = Object.freeze({
  createHarness,
  waitFor,
  sleep,
  requestJson,
  UP_TOPIC,
  DOWN_TOPIC,
  BASE_ENV
});
