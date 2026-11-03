#!/usr/bin/env node
'use strict';

/**
 * PC 侧 agent 常驻进程入口（契约 §2.1 / §2.4）。
 *
 *   node agent.js --relay wss://api.luxunacc.xyz/video/agent --key <KEY> --dayu 127.0.0.1:9301
 *
 * 也支持环境变量兜底：VIDEO_AGENT_RELAY / VIDEO_AGENT_KEY / DAYU_HOST / DAYU_PORT。
 * 日志不打印 key；relay URL 的 query（含 key）也不会进日志。
 */

const { createLogger } = require('./src/logger');
const { AgentClient } = require('./src/agent-client');

const USAGE = `用法:
  node agent.js --relay <ws(s)://host/video/agent> --key <VIDEO_AGENT_KEY> [--dayu 127.0.0.1:9301]

选项:
  --relay URL      relay 的 agent 注册地址（wss://api.luxunacc.xyz/video/agent）
                   也接受 https://api.luxunacc.xyz（自动补 /video/agent）
  --key KEY        relay 的 VIDEO_AGENT_KEY（也可用环境变量 VIDEO_AGENT_KEY）
  --dayu HOST:PORT DAYU200 VideoStreamServer（默认 127.0.0.1:9301，经 hdc fport）
  --log-level L    debug|info|warn|error（默认 info）
  --help           显示本帮助

说明:
  - agent 只在手机实际观看时经 relay 指令才连 DAYU 取帧；没人看就停止，不常驻拉流。
  - 断线自动重连 relay（0.5/1/2/5/10s 退避），日志不会输出 key。`;

function parseDayu(value) {
  const text = String(value || '').trim();
  const match = /^\[?([^\]\s:]+)\]?:(\d{1,5})$/.exec(text);
  if (!match) throw new Error(`--dayu 必须是 HOST:PORT（收到 ${JSON.stringify(text)}）`);
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('--dayu 端口非法');
  return { host: match[1], port };
}

function parseArgs(argv) {
  const parsed = { relay: '', key: '', dayu: '', logLevel: '' };
  const args = [...argv];
  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case '--relay': parsed.relay = args.shift() || ''; break;
      case '--key': parsed.key = args.shift() || ''; break;
      case '--dayu': parsed.dayu = args.shift() || ''; break;
      case '--log-level': parsed.logLevel = args.shift() || ''; break;
      case '--help':
      case '-h':
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数: ${flag}（--help 查看用法）`);
    }
  }
  return parsed;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const relay = parsed.relay || process.env.VIDEO_AGENT_RELAY || '';
  const key = parsed.key || process.env.VIDEO_AGENT_KEY || '';
  if (!key) throw new Error('缺少 --key（或 VIDEO_AGENT_KEY）；key 只能从部署机 video.env 获取');
  if (!relay) {
    throw new Error('缺少 --relay（例如 wss://api.luxunacc.xyz/video/agent）');
  }
  const dayuRaw = parsed.dayu
    || (process.env.DAYU_HOST ? `${process.env.DAYU_HOST}:${process.env.DAYU_PORT || 9301}` : '');
  const dayu = parseDayu(dayuRaw || '127.0.0.1:9301');
  const logLevel = (parsed.logLevel || process.env.VIDEO_LOG_LEVEL || 'info').toLowerCase();

  const logger = createLogger({ level: logLevel });
  logger.registerSecret(key);

  const client = new AgentClient({
    relayUrl: relay,
    key,
    dayuHost: dayu.host,
    dayuPort: dayu.port,
    logger
  });
  logger.info('video agent starting', {
    relay: client.sanitizedRelayUrl(),
    dayu: `${dayu.host}:${dayu.port}`
  });
  client.start();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info('video agent shutting down', { signal });
    try {
      await client.stop();
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
  return client;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[video-agent] fatal: ${(error && error.message) || error}\n`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, parseDayu };
