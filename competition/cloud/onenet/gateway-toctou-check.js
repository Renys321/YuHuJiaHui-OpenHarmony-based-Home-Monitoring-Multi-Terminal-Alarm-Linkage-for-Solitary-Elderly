'use strict';
// 独立复现脚本：不依赖 node:test 运行器（沙箱禁止其管道子进程），直接执行断言。
// 用途：证明 TOCTOU 回归测试确实能抓到“旧 NORMAL 冒充 RESET 回执”的缺陷。

const assert = require('node:assert/strict');
const { HomeCloudGateway } = require('./gateway');

const NOW = 1791609077775;

function statusLine(overrides = {}) {
  return Object.assign({
    deviceId: 'dayu200-home-gateway',
    room: '家庭网关',
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

function alarmLine(alarmId) {
  return statusLine({ state: 'ALARM', alarm: { id: alarmId, type: 'MANUAL_SOS', countToday: 1 } });
}

function makeGateway() {
  const published = [];
  const transport = {
    publishProperty: () => Promise.resolve({ id: '1', code: 200 }),
    publishAlarm: () => Promise.resolve({ id: '1', code: 200 }),
    on() {}, off() {}
  };
  const statusSource = {
    subscribe() { return () => {}; },
    publish(topic, message) { published.push({ topic, message }); },
    close() { return Promise.resolve(); }
  };
  let clock = NOW;
  const gateway = new HomeCloudGateway({
    transport,
    statusSource,
    deviceName: 'dayu200-home-gateway',
    resetMode: 'self',
    now: () => (clock += 1000),
    logger: { info() {}, warn() {}, error() {} }
  });
  return { gateway, published };
}

async function main() {
  const { gateway, published } = makeGateway();
  gateway.start();

  // 场景 A：目标当前不是 ALARM -> 必须直接拒绝，且不下发任何命令。
  // （真机实测：此时若下发，设备随后上报的“告警前”旧 NORMAL 会被误当成回执。）
  await gateway.ingest(JSON.stringify(statusLine()));
  const noAlarm = await gateway.handleCommand({ command: 'RESET' }, { requestId: '1' });
  console.log('scenario A (no active alarm) result :', JSON.stringify(noAlarm));
  assert.equal(noAlarm.ok, false, 'FAIL: RESET must be refused when there is no active alarm');
  assert.equal(noAlarm.message, 'target has no active alarm to reset');
  assert.equal(published.length, 0, 'FAIL: no command may be sent when there is no alarm to reset');

  // 场景 B：真实 ALARM，但设备对 reset **不回**任何新状态 -> 必须超时失败。
  await gateway.ingest(JSON.stringify(alarmLine('a-toctou-1')));
  assert.equal(gateway.devices.get('dayu200-home-gateway').state, 'ALARM');

  const timeoutMs = 300;
  const started = Date.now();
  const noReceipt = await gateway.handleCommand({ command: 'RESET' }, { requestId: '2' });
  console.log('scenario B (alarm, no receipt) result :', JSON.stringify(noReceipt),
    `elapsed=${Date.now() - started}ms`);
  assert.equal(noReceipt.ok, false, 'FAIL: a missing receipt must not be reported as success');
  assert.equal(noReceipt.message, 'device did not confirm reset');
  assert.equal(published.length, 1, 'exactly one reset command must have been published');
  // 必须是 JSON：Bridge 只认 {"cmd":"reset"}，裸字符串会被判为无法解析并丢弃
  assert.equal(published[0].message, '{"cmd":"reset"}', 'FAIL: downlink payload must be OneNET/Bridge JSON');

  // 场景 C：ALARM + 命令下发后到达的新 NORMAL -> 必须成功。
  await gateway.ingest(JSON.stringify(alarmLine('a-toctou-2')));
  const pending = gateway.handleCommand({ command: 'RESET' }, { requestId: '3' });
  await new Promise((r) => setImmediate(r));
  await gateway.ingest(JSON.stringify(statusLine()));
  const confirmed = await pending;
  console.log('scenario C (alarm + fresh receipt) result :', JSON.stringify(confirmed));
  assert.equal(confirmed.ok, true, 'FAIL: a genuine post-command receipt must confirm the reset');

  await gateway.stop('T');
  console.log('PASS: RESET requires an active alarm, a post-command receipt, and no stale state is accepted');
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
