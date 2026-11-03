'use strict';

/**
 * relay 进程入口。
 *
 *   node server.js
 *
 * 全部参数来自环境变量（见 .env.example 与 README）：
 *   local 模式：VIDEO_MODE=local（默认）+ DAYU_HOST/DAYU_PORT
 *   agent 模式：VIDEO_MODE=agent + VIDEO_AGENT_KEY
 */

const { loadConfig, publicSummary } = require('./src/config');
const { createLogger } = require('./src/logger');
const { createRelay } = require('./src/relay');

async function main() {
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.logLevel });
  logger.registerSecret(config.agentKey);

  logger.info('video relay starting', publicSummary(config));
  const relay = createRelay({ config, logger });
  const address = await relay.start();
  logger.info('video relay ready', {
    listen: `${address.host || config.relayHost}:${address.port || config.relayPort}`,
    mode: config.mode
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info('video relay shutting down', { signal });
    try {
      await relay.stop();
    } catch (error) {
      logger.error('shutdown error', { reason: (error && error.message) || 'unknown' });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { reason: (error && error.message) || 'unknown' });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason)
    });
  });

  return relay;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[video-relay] fatal: ${(error && error.message) || error}\n`);
    process.exit(1);
  });
}

module.exports = { main };
