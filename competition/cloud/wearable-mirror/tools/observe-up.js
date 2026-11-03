'use strict';

/**
 * tools/observe-up.js — 只读诊断：直接订阅 ECS Broker 的 UP_TOPIC，打印脱敏摘要。
 *
 * 用途：
 *   1) 证实随身 SOS 的 4G 上行确实只到公网（从不经过 PC bridge/homemon）；
 *   2) 观察 hb/GPS 频率与报文形状（不落盘原始 payload，不打印凭据）。
 *
 * 注意：Broker 的 clientId 是严格白名单。若未把本工具 clientId 加入 ECS 白名单，
 * 会得到 CONNACK rc=5（工具会如实打印拒绝原因并退出 4），绝不复用设备 clientId。
 *
 * 用法：node tools/observe-up.js [--seconds 40] [--client-id pc-mirror-observe]
 */

const { buildConfig } = require('../src/config');
const { MqttClient } = require('../src/mqtt-client');

function parseArgs(argv) {
  const out = { seconds: 40, clientId: 'pc-mirror-observe' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seconds') out.seconds = Number.parseInt(argv[i + 1], 10);
    else if (argv[i] === '--client-id') out.clientId = argv[i + 1];
  }
  if (!Number.isFinite(out.seconds) || out.seconds < 1 || out.seconds > 600) out.seconds = 40;
  return out;
}

function summarize(topic, payload) {
  const text = String(payload || '').trim();
  const at = new Date().toISOString();
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      return `${at} topic=${topic} json t=${obj.t || '?'} dev=${obj.dev || '?'} ` +
        `alarm=${obj.alarm || '-'} state=${obj.state || '-'} bytes=${text.length}`;
    } catch (err) {
      return `${at} topic=${topic} json MALFORMED bytes=${text.length}`;
    }
  }
  const shape = /^\s*[+-]?\d+(\.\d+)?_[+-]?\d+(\.\d+)?\s*$/.test(text) ? 'gps-fixed-format' : 'unknown-text';
  return `${at} topic=${topic} ${shape} bytes=${text.length}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  /* buildConfig 只读取自己认识的参数键，--seconds/--client-id 会被忽略 */
  const config = buildConfig(process.argv.slice(2), process.env);

  process.stdout.write(`[observe] broker=${config.mqtt.host}:${config.mqtt.port} topic=${config.mqtt.upTopic} ` +
    `seconds=${args.seconds} clientId=${args.clientId}\n`);

  const client = new MqttClient({
    host: config.mqtt.host,
    port: config.mqtt.port,
    clientId: args.clientId,
    username: config.mqtt.user,
    password: config.mqtt.pass,
    topics: [config.mqtt.upTopic],
    log: (line) => process.stdout.write(`${line}\n`),
    onMessage: (topic, payload) => process.stdout.write(`${summarize(topic, payload)}\n`),
    onConnect: () => process.stdout.write('[observe] subscribed; waiting for uplink (SOS/hb/GPS)\n'),
    onAuthRejected: (code, text) => {
      process.stderr.write(`[observe] CONNACK rc=${code} (${text}); clientId not whitelisted on ECS\n`);
      client.stop();
      process.exit(4);
    }
  });
  client.start();
  setTimeout(() => {
    process.stdout.write('[observe] done (read-only, no publish performed)\n');
    client.stop();
    process.exit(0);
  }, args.seconds * 1000);
}

main();
