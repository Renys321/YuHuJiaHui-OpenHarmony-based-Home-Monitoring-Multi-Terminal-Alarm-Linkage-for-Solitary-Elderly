'use strict';

/**
 * server.js — 随身 SOS PC 镜像服务入口。
 *
 * 用法示例：
 *   node server.js --source api --transport relay            # 当前推荐（公网 API → homemon relay）
 *   node server.js --source api --transport tcp --listen-port 9002   # 直连 fallback（配 hdc rport）
 *   node server.js --source mqtt --transport both            # ECS MQTT 白名单就绪后
 *   node server.js --print-config                            # 只打印脱敏配置后退出
 *
 * 安全：凭据只来自 env/凭据文件，日志与状态文件里不出现任何密码。
 */

const { buildConfig, describeConfig, ConfigError } = require('./src/config');
const { Mirror } = require('./src/mirror');

function timestamp() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function log(line) {
  process.stdout.write(`[${timestamp()}] ${line}\n`);
}

async function main() {
  let config;
  try {
    config = buildConfig(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[mirror] config error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  if (process.argv.includes('--print-config')) {
    process.stdout.write(`${JSON.stringify(describeConfig(config), null, 2)}\n`);
    return;
  }

  const mirror = new Mirror({ config, log });
  let stopping = false;

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`[mirror] ${signal} received, graceful shutdown`);
    mirror.stop(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        process.stderr.write(`[mirror] shutdown error: ${err && (err.stack || err.message)}\n`);
        process.exit(1);
      });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[mirror] uncaught exception: ${err && (err.stack || err.message)}\n`);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[mirror] unhandled rejection: ${err && (err.stack || err.message)}\n`);
  });

  try {
    await mirror.start();
  } catch (err) {
    if (err && err.code === 'ELOCKED') {
      process.stderr.write(`[mirror] 单实例锁冲突：${err.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`[mirror] start failed: ${err && (err.stack || err.message)}\n`);
    process.exit(1);
  }

  log(`[mirror] ready (source=${config.source}, transport=${config.transport}, ` +
    `heartbeat=${config.heartbeatMs}ms, status=${config.statusFile})`);
}

main().catch((err) => {
  process.stderr.write(`[mirror] fatal: ${err && (err.stack || err.message)}\n`);
  process.exit(1);
});
