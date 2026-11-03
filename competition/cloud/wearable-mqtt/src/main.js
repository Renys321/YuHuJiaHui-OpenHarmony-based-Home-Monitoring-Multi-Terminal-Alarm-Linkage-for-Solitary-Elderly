'use strict';

/**
 * main.js — wearable-mqtt 单进程入口：
 *   内置 MQTT 3.1.1 Broker（0.0.0.0:1883）+ 后端适配器 + 本地诊断 HTTP（127.0.0.1:8099）。
 *
 * 启动顺序：加载持久化状态（失败即退出，绝不静默重置 seq）→ 诊断服务 →
 * MQTT Broker → 适配器（开始轮询 ACK 命令）。
 * SIGTERM/SIGINT 优雅关闭：先停适配器（不再下发/轮询），再关 Broker 与诊断端口。
 */

const path = require('node:path');

const { loadConfig, describeConfig } = require('./config');
const { createLogger, safeErrorCode } = require('./logger');
const { StateStore } = require('./state-store');
const { BackendClient } = require('./backend-client');
const { MqttBroker } = require('./mqtt-broker');
const { WearableAdapter } = require('./adapter');
const { createStatusServer } = require('./status-server');

const SERVICE_NAME = 'wearable-mqtt';
const SERVICE_VERSION = '1.0.1';

function flattenCounters(groups) {
  const flat = {};
  for (const [prefix, counters] of Object.entries(groups)) {
    if (!counters || typeof counters !== 'object') continue;
    for (const [key, value] of Object.entries(counters)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        flat[`${prefix}_${key}`] = value;
      }
    }
  }
  return flat;
}

async function createService(options = {}) {
  const env = options.env || process.env;
  const config = options.config || loadConfig(env);
  const logger = options.logger || createLogger({ level: config.logLevel });

  const state = new StateStore({ dataDir: config.dataDir, logger });
  // 状态文件损坏/不可写时直接抛错：seq 回退会让后端把新位置当 stale 永久丢弃。
  state.load();

  const broker = new MqttBroker({
    host: config.mqtt.host,
    port: config.mqtt.port,
    username: config.mqtt.user,
    password: config.mqtt.pass,
    clientIds: config.mqtt.clientIds,
    logger,
    maxPacketBytes: config.mqtt.maxPacketBytes,
    connectTimeoutMs: config.mqtt.connectTimeoutMs
  });

  const backend = new BackendClient({
    baseUrl: config.backendBase,
    ingestKey: config.ingestKey,
    timeoutMs: config.http.timeoutMs,
    maxAttempts: config.http.maxAttempts,
    backoffBaseMs: config.http.backoffBaseMs,
    backoffMaxMs: config.http.backoffMaxMs,
    logger
  });

  const adapter = new WearableAdapter({ broker, backend, state, config, logger });

  const startedAt = Date.now();
  let shutdownStarted = false;

  const statusServer = createStatusServer({
    host: config.status.host,
    port: config.status.port,
    logger,
    isHealthy: () => broker.listening === true && shutdownStarted === false,
    getStatus: () => ({
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      startedAt,
      uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      config: describeConfig(config),
      state: state.snapshot(),
      broker: broker.snapshot(),
      adapter: adapter.snapshot(),
      backend: backend.snapshot(),
      counters: flattenCounters({
        broker: broker.counters,
        adapter: adapter.counters,
        http: backend.counters
      })
    })
  });

  async function start() {
    const statusAddress = await statusServer.start();
    const brokerAddress = await broker.start();
    adapter.start();
    logger.info('SERVICE_STARTED', {
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      mqttHost: brokerAddress.host,
      mqttPort: brokerAddress.port,
      statusHost: statusAddress.host,
      statusPort: statusAddress.port,
      dataDir: config.dataDir,
      backendBase: config.backendBase
    });
    logger.info('SERVICE_CONFIG', describeConfig(config));
    return { broker, adapter, statusServer, backend, state, config };
  }

  async function stop(reason = 'STOPPED') {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info('SERVICE_STOPPING', { reason });
    try {
      await adapter.stop();
    } catch (error) {
      logger.warn('ADAPTER_STOP_FAILED', { code: safeErrorCode(error) });
    }
    try {
      await statusServer.close();
    } catch (error) {
      logger.warn('STATUS_CLOSE_FAILED', { code: safeErrorCode(error) });
    }
    try {
      await broker.close();
    } catch (error) {
      logger.warn('BROKER_CLOSE_FAILED', { code: safeErrorCode(error) });
    }
    logger.info('SERVICE_STOPPED', { reason });
  }

  return { start, stop, broker, adapter, statusServer, backend, state, config, logger };
}

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // 配置错误只打印“哪个变量不合法”，绝不打印值。
    process.stderr.write(`wearable-mqtt: invalid configuration: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel });
  const service = await createService({ config, logger });

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info('SIGNAL_RECEIVED', { signal });
    const forceTimer = setTimeout(() => {
      logger.error('SHUTDOWN_TIMEOUT', { code: 'FORCED_EXIT' });
      process.exit(1);
    }, 8000);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
    service.stop(signal).then(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    }).catch((error) => {
      logger.error('SHUTDOWN_FAILED', { code: safeErrorCode(error) });
      process.exit(1);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED_REJECTION', { code: safeErrorCode(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('UNCAUGHT_EXCEPTION', { code: safeErrorCode(error) });
    process.exit(1);
  });

  try {
    await service.start();
  } catch (error) {
    const code = safeErrorCode(error);
    logger.error('SERVICE_START_FAILED', { code });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`wearable-mqtt: fatal: ${safeErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  createService,
  main,
  SERVICE_NAME,
  SERVICE_VERSION
});
