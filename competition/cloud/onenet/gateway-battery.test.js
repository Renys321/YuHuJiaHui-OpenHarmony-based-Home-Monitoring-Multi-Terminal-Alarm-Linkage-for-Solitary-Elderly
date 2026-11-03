'use strict';

/**
 * 网关电量聚合测试（契约 BATTERY-CHAIN-CONTRACT.md §4）
 *
 * 目标：网关在 device.sensors / gps / csq 旁保留 battery；
 *       上云 property/post 与后端同步载荷都带上它；同设备新状态覆盖旧状态；
 *       没有 battery 的报文不产生该字段（不改变既有 47 项测试的字段集合）。
 *
 * 运行：node gateway-battery.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { HomeCloudGateway } = require('./gateway');

const NOW = 1791609077775;

function statusLine(overrides = {}) {
  const base = {
    deviceId: 'esp32-sos',
    room: '随身求助',
    ts: NOW,
    state: 'NORMAL',
    sensors: {
      motion: { lastActiveTs: NOW - 1000, countToday: 1 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 24.6, rh: 41.2, ok: true },
      gas: { raw: 123, ok: true },
      smoke: { raw: 45, ok: true }
    },
    alarm: { id: '', type: '', countToday: 0 }
  };
  return Object.assign(base, overrides);
}

const batteryFrame = (overrides = {}) => Object.assign({
  source: 'battery', present: true, valid: true, mv: 3850,
  percent: 42, low: false, calibrated: true, reason: ''
}, overrides);

function makeTransport() {
  const calls = { property: [], alarm: [] };
  return {
    calls,
    publishProperty(status, opts) {
      calls.property.push({ status: JSON.parse(JSON.stringify(status)), opts });
      return Promise.resolve({ id: opts.id, code: 200 });
    },
    publishAlarm(status, opts) {
      calls.alarm.push({ status: JSON.parse(JSON.stringify(status)), opts });
      return Promise.resolve({ id: opts.id, code: 200 });
    },
    on() {},
    off() {},
    emit() {}
  };
}

function makeStatusSource() {
  const subscribers = new Set();
  return {
    subscribe(handler) { subscribers.add(handler); return () => subscribers.delete(handler); },
    publish() { return Promise.resolve(true); },
    async emit(message) { for (const handler of Array.from(subscribers)) await handler(message); },
    close() { subscribers.clear(); return Promise.resolve(); }
  };
}

function makeGateway(overrides = {}) {
  const transport = overrides.transport || makeTransport();
  const statusSource = overrides.statusSource || makeStatusSource();
  const cloudSyncCalls = [];
  const cloudSync = overrides.cloudSync || {
    enabled: true,
    publish(status) { cloudSyncCalls.push(JSON.parse(JSON.stringify(status))); return Promise.resolve({ ok: true }); }
  };
  let clock = NOW;
  const gateway = new HomeCloudGateway(Object.assign({
    transport,
    statusSource,
    cloudSync,
    deviceName: 'dayu200-home-gateway',
    resetMode: 'self',
    now: () => clock,
    logger: { info() {}, warn() {}, error() {} }
  }, overrides.gateway));
  return {
    gateway, transport, statusSource, cloudSyncCalls,
    advance(ms) { clock += ms; }
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('上云 property/post 保留 battery', async () => {
  const { gateway, transport } = makeGateway();
  gateway.start();
  const result = await gateway.ingest(JSON.stringify(statusLine({ battery: batteryFrame() })));
  assert.equal(result.accepted, true);
  assert.equal(transport.calls.property.length, 1);
  assert.deepEqual(transport.calls.property[0].status.battery, batteryFrame());
});

test('后端同步载荷（cloud-sync device 对象）保留 battery', async () => {
  const { gateway, cloudSyncCalls } = makeGateway();
  gateway.start();
  await gateway.ingest(JSON.stringify(statusLine({ battery: batteryFrame() })));
  await settle();
  assert.ok(cloudSyncCalls.length >= 1, 'cloud sync must be called');
  assert.deepEqual(cloudSyncCalls[0].battery, batteryFrame());
});

test('没有 battery 的报文：上云状态不含该字段（既有字段集合不变）', async () => {
  const { gateway, transport, cloudSyncCalls } = makeGateway();
  gateway.start();
  await gateway.ingest(JSON.stringify(statusLine()));
  const status = transport.calls.property[0].status;
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'battery'), false);
  await settle();
  assert.equal(Object.prototype.hasOwnProperty.call(cloudSyncCalls[0], 'battery'), false);
});

test('同设备新状态覆盖旧 battery（不是合并旧值）', async () => {
  const { gateway, transport } = makeGateway();
  gateway.start();
  await gateway.ingest(JSON.stringify(statusLine({ battery: batteryFrame({ mv: 3850, percent: 42 }) })));
  /* 状态变化（ALARM）才会立即重新上云 */
  const alarmLine = statusLine({
    state: 'ALARM',
    alarm: { id: 'e-1791609077775-1', type: 'MANUAL_SOS', countToday: 1 },
    battery: batteryFrame({ mv: 3420, percent: 14, low: true })
  });
  await gateway.ingest(JSON.stringify(alarmLine));
  const last = transport.calls.property[transport.calls.property.length - 1].status;
  assert.deepEqual(last.battery, batteryFrame({ mv: 3420, percent: 14, low: true }));
});

test('非法 battery 报文被网关拒绝（accepted=false），不污染已聚合状态', async () => {
  const { gateway, transport } = makeGateway();
  gateway.start();
  await gateway.ingest(JSON.stringify(statusLine({ battery: batteryFrame() })));
  const bad = statusLine({ state: 'WARN', battery: batteryFrame({ mv: 0 }) });
  const result = await gateway.ingest(JSON.stringify(bad));
  assert.notEqual(result.accepted, true);
  const last = transport.calls.property[transport.calls.property.length - 1].status;
  assert.deepEqual(last.battery, batteryFrame(), 'rejected frame must not overwrite known-good battery');
});
