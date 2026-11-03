'use strict';
/* device-ts-chain.test.js —— 原始设备 ts 从 MQTT 到 public-sync 202 日志的严格关联 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { HomeCloudGateway } = require('./gateway');
const { createCloudSync } = require('./cloud-sync');

const DEVICE_TS = 1792506753858;   // 13 位原始设备 ts（MQTT JSON 的 ts）
const GATEWAY_TS = 1792506753811;  // 网关接收时间 ms（与设备 ts 不同）

function statusLine(extra) {
  const base = {
    deviceId: 'esp32-kitchen', room: '厨房', ts: DEVICE_TS, state: 'NORMAL',
    sensors: {
      motion: { lastActiveTs: 0, countToday: 0 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 24.6, rh: 60.2, ok: true, valid: true },
      gas: { raw: 276, ok: true, valid: true },
      smoke: { raw: 79, ok: true, valid: true },
    },
    history: [0, 0, 0, 0, 0, 0, 0],
    slots: [0, 0, 0, 0],
    alarm: { id: '', type: '', countToday: 0 },
  };
  return Object.assign(base, extra || {});
}

function makeGateway() {
  const captured = [];
  const transport = {
    publishProperty() { return Promise.resolve({ code: 200 }); },
    publishAlarm() { return Promise.resolve({ code: 200 }); },
    on() {}, off() {}, setCommandHandler() {},
  };
  const statusSource = {
    subscribe() { return () => {}; },
    publish() { return Promise.resolve(true); },
    close() { return Promise.resolve(); },
  };
  const gateway = new HomeCloudGateway({
    transport, statusSource,
    deviceName: 'test-gateway', resetMode: 'self',
    now: () => GATEWAY_TS,
    logger: { info() {}, warn() {}, error() {} },
    cloudSync: {
      enabled: true,
      publish(device, ms) { captured.push({ device, ms }); return Promise.resolve({ ok: true, statusCode: 202 }); },
    },
    commandSync: { enabled: false },
  });
  return { gateway, captured };
}

test('派生 _cloudStatus 保留原始 deviceTs，且与网关 ts 不同', async () => {
  const { gateway, captured } = makeGateway();
  gateway.start();
  const r = await gateway.ingest(JSON.stringify(statusLine()));
  assert.equal(r.accepted, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].device.deviceTs, DEVICE_TS, 'deviceTs 必须等于 MQTT JSON 的 ts');
  assert.equal(captured[0].ms, GATEWAY_TS, '网关时间单独传递');
  assert.notEqual(captured[0].device.deviceTs, captured[0].ms, '两者不得互相覆盖');
});

test('缺少设备 ts 时不伪造 deviceTs', async () => {
  const { gateway, captured } = makeGateway();
  gateway.start();
  const line = statusLine();
  delete line.ts;
  const r = await gateway.ingest(JSON.stringify(line));
  assert.equal(r.accepted, true);
  assert.equal(captured[0].device.deviceTs, undefined);
});

test('非法 ts（字符串/小数/null）被拒绝，不会冒充 deviceTs', async () => {
  const { gateway, captured } = makeGateway();
  gateway.start();
  const bads = ['1792506753858', 1792506753.858, null];
  for (const bad of bads) {
    const r = await gateway.ingest(JSON.stringify(statusLine({ ts: bad })));
    assert.equal(r.accepted, false, 'ts=' + String(bad));
  }
  assert.equal(captured.length, 0);
});

test('cloud-sync 202 日志打印原始 deviceTs 与网关 ts，且载荷不含 deviceTs', async () => {
  const lines = [];
  const KEY = 'k'.repeat(48);
  let lastBody = null;
  const sync = createCloudSync({
    backendUrl: 'https://api.example.test',
    ingestKey: KEY,
    now: () => 1792506753943,
    logger: { info: (l) => lines.push(l), warn: () => {}, error: () => {} },
    httpRequest(opts, body, cb) { lastBody = body; cb(null, { statusCode: 202 }); },
  });
  const device = {
    deviceId: 'esp32-kitchen', room: '厨房', state: 'NORMAL', deviceTs: DEVICE_TS,
    alarm: { id: '', type: '', countToday: 0 }, sensors: {},
  };
  const r = await sync.publish(device, GATEWAY_TS);
  assert.equal(r.ok, true);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line.indexOf('device=esp32-kitchen') >= 0, line);
  assert.ok(line.indexOf('ts=' + GATEWAY_TS) >= 0, line);
  assert.ok(line.indexOf('deviceTs=' + DEVICE_TS) >= 0, line);
  assert.ok(line.indexOf('status=202') >= 0, line);
  assert.equal(line.indexOf(KEY), -1, '日志不得包含密钥');
  const payload = JSON.parse(lastBody.toString('utf8'));
  assert.equal(payload.ts, GATEWAY_TS, '上云 ts 仍为网关接收时间');
  assert.equal(payload.deviceTs, undefined, '上云载荷不得新增 deviceTs');
});

test('缺少 deviceTs 时日志输出 -（不伪造）', async () => {
  const lines = [];
  const sync = createCloudSync({
    backendUrl: 'https://api.example.test',
    ingestKey: 'k'.repeat(48),
    now: () => 1792506753943,
    logger: { info: (l) => lines.push(l), warn: () => {}, error: () => {} },
    httpRequest(opts, body, cb) { cb(null, { statusCode: 202 }); },
  });
  await sync.publish({ deviceId: 'esp32-kitchen', room: '厨房', state: 'NORMAL', alarm: { id: '', type: '', countToday: 0 } }, GATEWAY_TS);
  assert.ok(lines[0].indexOf('deviceTs=-') >= 0, lines[0]);
});
