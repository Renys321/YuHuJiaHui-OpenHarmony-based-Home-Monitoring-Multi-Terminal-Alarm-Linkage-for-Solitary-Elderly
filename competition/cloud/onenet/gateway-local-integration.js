#!/usr/bin/env node
/**
 * gateway-local-integration.js — 分层验收第 2/3 层
 *
 * 用“真实本地 Broker + 真实设备报文 + 伪 OneNET Transport”跑通网关，不接触公网、不需要密钥。
 *
 *   1. 起仓库自带的 bridge/mqtt_broker.js（真实 MQTT 3.1.1 Broker）
 *   2. 网关用 mqtt.js 订阅 home/+/status（真实 MQTT 客户端）
 *   3. 用 bridge/mqtt_tool.js 以真实设备报文形状发布状态
 *   4. 断言 OneNET property/post 与 safetyAlarm event/post 的调用
 *
 * 用法：
 *   node gateway-local-integration.js            # 默认 127.0.0.1:18830
 *   node gateway-local-integration.js --port 18831
 */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const { createGateway } = require('./gateway');

const BRIDGE_DIR = path.join(__dirname, '..', '..', 'bridge');
const BROKER = path.join(BRIDGE_DIR, 'mqtt_broker.js');
const TOOL = path.join(BRIDGE_DIR, 'mqtt_tool.js');

const NOW = 1791609077775;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PORT = parseInt(arg('port', '18830'), 10);
const BROKER_URL = `mqtt://127.0.0.1:${PORT}`;

function statusLine(overrides = {}) {
  return Object.assign({
    deviceId: 'esp32-bath',
    room: '卫生间',
    ts: NOW,
    state: 'NORMAL',
    sensors: {
      motion: { lastActiveTs: NOW - 308220, countToday: 3 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 24.6, rh: 41.2, ok: true },
      gas: { raw: 123, ok: true },
      smoke: { raw: 45, ok: true }
    },
    history: [0, 0, 0, 0, 0, 0, 0],
    slots: [0, 0, 0, 0],
    alarm: { id: '', type: '', countToday: 0 }
  }, overrides);
}

function alarmLine(overrides = {}) {
  return statusLine(Object.assign({ state: 'ALARM', alarm: { id: 'e-1791608799-2', type: 'NO_MOTION', countToday: 1 } }, overrides));
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

function runTool(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mqtt_tool exited ${code}`))));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('=== 家庭云网关本地分层验收（真实 Broker + 伪 OneNET） ===');
  console.log(`  broker   : ${BROKER_URL}`);
  console.log(`  node ver : ${process.version}`);

  const broker = spawn(process.execPath, [BROKER, String(PORT)], { stdio: ['ignore', 'ignore', 'ignore'] });
  let brokerExited = false;
  broker.on('exit', () => { brokerExited = true; });

  await sleep(700);
  check('real in-repo MQTT broker started', !brokerExited);

  const calls = { property: [], alarm: [] };
  const fakeOneNet = {
    publishProperty(status, opts) {
      calls.property.push({ status: JSON.parse(JSON.stringify(status)), opts });
      return Promise.resolve({ id: opts.id, code: 200 });
    },
    publishAlarm(status, opts) {
      calls.alarm.push({ status: JSON.parse(JSON.stringify(status)), opts });
      return Promise.resolve({ id: opts.id, code: 200 });
    },
    on() {},
    off() {}
  };

  // 真实链路用可推进的时钟：否则限频窗口会（正确地）压掉后续上云调用，
  // 让“云断线”这一步测不出东西来。
  let clock = NOW;
  const gateway = createGateway({
    env: {
      GATEWAY_BROKER_URL: BROKER_URL,
      ONENET_DEVICE_NAME: 'dayu200-home-gateway',
      GATEWAY_RESET_MODE: 'self'
    },
    transport: fakeOneNet,
    now: () => (clock += 1000),
    logger: { info: (m) => console.log('  [gw] ' + m), warn: (m) => console.log('  [gw] ' + m), error: (m) => console.log('  [gw] ' + m) }
  });
  gateway.start();

  // 等真实 MQTT 连接与订阅完成
  await sleep(900);

  // --- 1. 正常状态上云
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/esp32-bath/status', '--msg', JSON.stringify(statusLine())]);
  await sleep(500);
  check('normal status reached the gateway through real MQTT', calls.property.length === 1, `property=${calls.property.length}`);
  check('property payload kept deviceId/room/state', calls.property[0]
    && calls.property[0].status.deviceId === 'esp32-bath'
    && calls.property[0].status.room === '卫生间'
    && calls.property[0].status.state === 'NORMAL');

  // --- 2. 稳定状态限频
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/esp32-bath/status', '--msg', JSON.stringify(statusLine())]);
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/esp32-bath/status', '--msg', JSON.stringify(statusLine())]);
  await sleep(500);
  check('stable state was rate limited (no cloud flood)', calls.property.length === 1, `property=${calls.property.length}`);

  // --- 3. 新 alarmId -> 一次 safetyAlarm
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/esp32-bath/status', '--msg', JSON.stringify(alarmLine())]);
  await sleep(500);
  check('new alarmId produced exactly one safetyAlarm', calls.alarm.length === 1, `alarm=${calls.alarm.length}`);
  check('safetyAlarm carried the alarmId binding', calls.alarm[0] && calls.alarm[0].status.alarm.id === 'e-1791608799-2');

  // --- 4. 同 alarmId 重复 -> 不重复告警
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/esp32-bath/status', '--msg', JSON.stringify(alarmLine())]);
  await sleep(500);
  check('duplicate alarmId did not re-alarm', calls.alarm.length === 1, `alarm=${calls.alarm.length}`);

  // --- 5. 非法报文被拒绝
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/esp32-bath/status', '--msg', '{"deviceId":"bad id!","room":"x","ts":1791609077775,"state":"NORMAL"}']);
  const before = calls.property.length;
  await sleep(400);
  check('illegal deviceId was rejected (no cloud publish)', calls.property.length === before);

  // --- 6. 10 位秒时间戳被拒绝
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/esp32-bath/status', '--msg', JSON.stringify(statusLine({ ts: 1791609077 }))]);
  await sleep(400);
  check('10-digit second timestamp was rejected', calls.property.length === before);

  // --- 7. RESET 下行：无回执必须失败
  const gwDevice = statusLine({
    deviceId: 'dayu200-home-gateway',
    room: '家庭网关',
    state: 'ALARM',
    alarm: { id: 'a-local-1', type: 'MANUAL_SOS', countToday: 1 }
  });
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/dayu200-home-gateway/status', '--msg', JSON.stringify(gwDevice)]);
  await sleep(500);
  const resetNoReceipt = await gateway.handleCommand({ command: 'RESET' }, { requestId: '9001' });
  check('RESET without a device receipt fails closed', resetNoReceipt.ok === false, JSON.stringify(resetNoReceipt));

  // --- 7b. RESET 成功闭环：命令必须真的到达 home/<id>/cmd，并等真实设备回执才 code=200
  const received = [];
  const mqtt = require('mqtt');
  const watcher = mqtt.connect(BROKER_URL, { clientId: `reset-watcher-${Date.now() % 100000}` });
  await new Promise((resolve) => watcher.once('connect', resolve));
  await new Promise((resolve) => watcher.subscribe('home/dayu200-home-gateway/cmd', { qos: 0 }, resolve));
  watcher.on('message', (topic, payload) => {
    received.push({ topic, payload: payload.toString('utf8') });
    // 模拟真实设备执行 reset 后上报回执
    setTimeout(() => {
      runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/dayu200-home-gateway/status',
        '--msg', JSON.stringify(statusLine({ deviceId: 'dayu200-home-gateway', room: '家庭网关' }))]).catch(() => {});
    }, 200);
  });

  // 重新让目标设备处于 ALARM（换一个 alarmId，避免被去重逻辑正确抑制）
  const gwDevice2 = statusLine({
    deviceId: 'dayu200-home-gateway',
    room: '家庭网关',
    state: 'ALARM',
    alarm: { id: 'a-local-2', type: 'MANUAL_SOS', countToday: 1 }
  });
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/dayu200-home-gateway/status', '--msg', JSON.stringify(gwDevice2)]);
  await sleep(300);
  const resetOk = await gateway.handleCommand({ command: 'RESET' }, { requestId: '9002' });
  await sleep(400);
  check('RESET command actually reached home/<id>/cmd as Bridge-parseable JSON',
    received.length >= 1 && received[0].payload === '{"cmd":"reset"}',
    JSON.stringify(received));
  check('RESET succeeded only after a real device receipt', resetOk.ok === true, JSON.stringify(resetOk));
  watcher.end(true);
  await sleep(200);

  // --- 8. 云端断线不影响本地聚合
  // 注意必须制造“签名变化”的新状态：同 alarmId 的重复报文会被正确去重，测不出上云失败路径。
  let stubCalls = 0;
  fakeOneNet.publishProperty = () => {
    stubCalls += 1;
    return Promise.reject(Object.assign(new Error('cloud down'), { code: 'NOT_READY' }));
  };
  const cloudErrors = [];
  gateway.on('cloudError', (info) => cloudErrors.push(info.code));
  await runTool(['pub', '--broker', `127.0.0.1:${PORT}`, '--topic', 'home/esp32-bath/status',
    '--msg', JSON.stringify(statusLine({ room: '卫生间', state: 'ACKED' }))]);
  await sleep(500);
  check('cloud outage did not break local aggregation',
    gateway.devices.get('esp32-bath').online === true && gateway.devices.get('esp32-bath').state === 'ACKED',
    `state=${gateway.devices.get('esp32-bath').state} stubCalls=${stubCalls}`);
  check('cloud outage surfaced a safe error code', cloudErrors.length >= 1, cloudErrors.join(','));

  await gateway.stop('INTEGRATION_DONE');
  broker.kill();

  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`RESULT: ${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log('FAILED: ' + results.filter((r) => !r.ok).map((r) => r.name).join(' | '));
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('INTEGRATION ERROR:', error && error.message);
  process.exit(1);
});
