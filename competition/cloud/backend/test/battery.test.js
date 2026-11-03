'use strict';

/**
 * battery.test.js — 后端电量为可选字段（契约 BATTERY-CHAIN-CONTRACT.md §5）
 *
 * 覆盖：
 *   1) 合法 battery 写入 device.battery 并在设备序列化中透出；
 *   2) 缺失 battery -> device.battery = null，序列化**不出现**该字段（绝不默认 0）；
 *   3) 非法 battery（负值/超上限/非整数/mv=0 却 valid/未知 source/未知字段/
 *      未标定给百分比/valid=false 带 mv）-> **设备状态不丢弃**，只降级为“无电量”，
 *      并记录内部 batteryRejectCode（绝不把 code 当电量透出给 APP）；
 *   4) 持久化：schema 保持 v7；旧快照（无 battery）加载后 battery=null 且设备不丢；
 *      新快照（有 battery）重启后保留；快照里非法 battery 降级为 null。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MemoryStore, normalizeStatus } = require('../src/store');
const { PersistentStore, SCHEMA_VERSION } = require('../src/persistent-store');

const T = 1_700_000_000_000;

function batteryFrame(overrides = {}) {
  return Object.assign({
    source: 'battery',
    present: true,
    valid: true,
    mv: 3850,
    percent: 42,
    low: false,
    calibrated: true,
    reason: ''
  }, overrides);
}

function ingestInput(overrides = {}) {
  return Object.assign({
    deviceId: 'esp32-sos',
    room: '随身求助',
    state: 'NORMAL',
    ts: T,
    alarm: { id: '', type: '', countToday: 0 }
  }, overrides);
}

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-battery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ------------------------------------------------------------ 合法 / 缺失 */

test('合法 battery 写入 device.battery 并在设备序列化中透出', () => {
  const store = new MemoryStore();
  const status = store.ingest(ingestInput({ battery: batteryFrame() }));
  assert.deepEqual(status.battery, batteryFrame());
  assert.equal(status.batteryRejectCode, null);
  const device = store.listDevices()[0];
  assert.deepEqual(device.battery, batteryFrame());
  assert.deepEqual(store.toPublicDevice(device).battery, batteryFrame());
});

test('缺失 battery -> device.battery=null，序列化不出现该字段（不默认 0）', () => {
  const store = new MemoryStore();
  const status = store.ingest(ingestInput());
  assert.equal(status.battery, null);
  const publicDevice = store.toPublicDevice(store.listDevices()[0]);
  assert.equal(Object.prototype.hasOwnProperty.call(publicDevice, 'battery'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicDevice, 'batteryRejectCode'), false);
});

test('无效读数（未接电池）原样保存，供 APP 显示“电量未知”', () => {
  const store = new MemoryStore();
  const invalid = batteryFrame({ present: false, valid: false, mv: null, percent: null, calibrated: false, reason: 'OUT_OF_RANGE' });
  store.ingest(ingestInput({ battery: invalid }));
  const device = store.listDevices()[0];
  assert.deepEqual(device.battery, invalid);
  assert.deepEqual(store.toPublicDevice(device).battery, invalid);
});

/* ------------------------------------------------------------ 非法 battery 降级 */

const INVALID_CASES = [
  ['负电压', batteryFrame({ mv: -1 }), 'BATTERY_OUT_OF_RANGE'],
  ['超过上限', batteryFrame({ mv: 60001 }), 'BATTERY_OUT_OF_RANGE'],
  ['非整数电压', batteryFrame({ mv: 3850.5 }), 'BATTERY_OUT_OF_RANGE'],
  ['非整数百分比', batteryFrame({ percent: 42.5 }), 'BATTERY_OUT_OF_RANGE'],
  ['mv=0 却声称有效', batteryFrame({ mv: 0, percent: 0 }), 'BATTERY_INCONSISTENT'],
  ['未知 source', batteryFrame({ source: 'usb' }), 'BATTERY_INVALID_SHAPE'],
  ['未知字段', batteryFrame({ voltage: 3850 }), 'BATTERY_INVALID_SHAPE'],
  ['布尔字段类型错', batteryFrame({ valid: 1 }), 'BATTERY_INVALID_SHAPE'],
  ['reason 小写', batteryFrame({ reason: 'out_of_range' }), 'BATTERY_INVALID_SHAPE'],
  ['未标定却给百分比', batteryFrame({ calibrated: false }), 'BATTERY_INCONSISTENT'],
  ['valid=false 却带电压', batteryFrame({ valid: false, percent: null }), 'BATTERY_INCONSISTENT'],
  ['fixed 却带电压', batteryFrame({ source: 'fixed' }), 'BATTERY_INCONSISTENT'],
  ['battery 不是对象', '3850', 'BATTERY_INVALID_SHAPE'],
  ['battery 是数组', [1, 2, 3], 'BATTERY_INVALID_SHAPE']
];

for (const [name, badBattery, expectedCode] of INVALID_CASES) {
  test(`非法 battery 降级为“无电量”且不影响设备状态：${name}`, () => {
    const store = new MemoryStore();
    const status = store.ingest(ingestInput({ state: 'WARN', online: true, battery: badBattery }));
    assert.equal(status.battery, null, '非法电量不得写入任何电压/百分比');
    assert.equal(status.batteryRejectCode, expectedCode);
    /* 设备状态本身必须仍然被接受（契约 §5：不得整体丢弃） */
    const device = store.listDevices()[0];
    assert.equal(device.deviceId, 'esp32-sos');
    assert.equal(device.state, 'WARN');
    assert.equal(device.online, true);
    assert.equal(device.battery, null);
    assert.equal(Object.prototype.hasOwnProperty.call(store.toPublicDevice(device), 'battery'), false);
  });
}

test('非法 battery 不影响同一报文的其它字段（sensors/alarm/online 照常写入）', () => {
  const store = new MemoryStore();
  const status = store.ingest(ingestInput({
    state: 'ALARM',
    sensors: { gas: { raw: 900, ok: true } },
    alarm: { id: 'e-1', type: 'MANUAL_SOS', countToday: 1 },
    battery: batteryFrame({ mv: -5 })
  }));
  assert.deepEqual(status.sensors, { gas: { raw: 900, ok: true } });
  assert.equal(status.alarm.id, 'e-1');
  assert.equal(store.getAlert('e-1').type, 'MANUAL_SOS');
  assert.equal(status.battery, null);
});

test('normalizeStatus 直接把非法 battery 降级且记录 code（server 摄取路径同源）', () => {
  const status = normalizeStatus(ingestInput({ battery: batteryFrame({ percent: 200 }) }));
  assert.equal(status.battery, null);
  assert.equal(status.batteryRejectCode, 'BATTERY_OUT_OF_RANGE');
});

/* ------------------------------------------------------------ ACK 部分回执保留电量 */

test('ACK 部分回执（不带 battery）保留上一次真实电量，不被覆盖成 null', () => {
  const store = new MemoryStore();
  store.ingest(ingestInput({
    state: 'ALARM',
    alarm: { id: 'e-ack-battery', type: 'MANUAL_SOS', countToday: 1 },
    battery: batteryFrame()
  }));
  const cmd = store.requestAck('e-ack-battery', '确认', 'wx-openid', T + 1000);
  assert.ok(cmd && cmd.id, 'ACK 命令必须创建成功');
  store.completeCommand(cmd.id, {
    status: 'ACKED',
    deviceState: {
      deviceId: 'esp32-sos',
      room: '随身求助',
      state: 'ACKED',
      ts: T + 2000,
      alarm: { id: 'e-ack-battery', type: 'MANUAL_SOS', countToday: 1 }
    }
  }, T + 2000);
  const device = store.listDevices()[0];
  assert.equal(device.state, 'ACKED');
  assert.deepEqual(device.battery, batteryFrame(), '部分回执不得把已聚合的真实电量清掉');
});

/* ------------------------------------------------------------ 持久化（不升 schema） */

test('schema 保持 v7：新增电量字段不需要升版（设备字段不是白名单校验）', () => {
  assert.equal(SCHEMA_VERSION, 7);
});

test('重启加载：有 battery 的新快照保留电量，设备/告警不丢', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const first = new PersistentStore({ filePath });
  first.ingest(ingestInput({
    state: 'ALARM',
    alarm: { id: 'e-batt-1', type: 'MANUAL_SOS', countToday: 1 },
    battery: batteryFrame()
  }));
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(saved.schemaVersion, 7, '写盘仍为 v7');
  assert.deepEqual(saved.devices[0].battery, batteryFrame(), '快照必须写入 battery');

  const second = new PersistentStore({ filePath });
  assert.deepEqual(second.listDevices()[0].battery, batteryFrame(), '重启后电量必须保留');
  assert.equal(second.listAlerts()[0].alarmId, 'e-batt-1');
  assert.deepEqual(second.toPublicDevice(second.listDevices()[0]).battery, batteryFrame());
});

test('重启加载：旧快照（v7 早期，无 battery 键）得到 battery=null 且设备不丢', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const first = new PersistentStore({ filePath });
  first.ingest(ingestInput({ state: 'NORMAL' }));
  /* 手工剥掉 battery 键，模拟“电量实现之前的旧快照” */
  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(document.devices[0], 'battery'), true);
  delete document.devices[0].battery;
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');

  const second = new PersistentStore({ filePath });
  assert.equal(second.listDevices().length, 1, '旧快照不得丢设备');
  assert.equal(second.listDevices()[0].deviceId, 'esp32-sos');
  assert.equal(second.listDevices()[0].battery, null, '缺失 = null，绝不是 0');
  assert.equal(Object.prototype.hasOwnProperty.call(second.toPublicDevice(second.listDevices()[0]), 'battery'), false);
});

test('重启加载：快照里非法 battery 降级为 null（不因遥测字段拒绝启动）', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const first = new PersistentStore({ filePath });
  first.ingest(ingestInput({ state: 'NORMAL' }));
  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  document.devices[0].battery = { source: 'battery', present: true, valid: true, mv: -1, percent: null, low: false, calibrated: false, reason: '' };
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');

  const second = new PersistentStore({ filePath });
  assert.equal(second.listDevices().length, 1);
  assert.equal(second.listDevices()[0].battery, null);
});

test('重启加载：v1 旧快照（远早于电量功能）仍可加载且 battery=null', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    savedAt: T,
    devices: [{
      deviceId: 'esp32-kitchen',
      room: '厨房',
      online: true,
      state: 'NORMAL',
      ts: T,
      receivedAt: T,
      sensors: {},
      alarm: { id: '', type: '', countToday: 0 },
      gps: { valid: false, latitude: null, longitude: null, fixTime: 0 },
      csq: null
    }],
    alerts: [],
    commands: [],
    contacts: []
  }), 'utf8');

  const store = new PersistentStore({ filePath });
  assert.equal(store.listDevices().length, 1);
  assert.equal(store.listDevices()[0].battery, null);
  /* 下一次成功变更仍写 v7，且新写入的 battery=null 不破坏旧数据 */
  store.ingest(ingestInput({ deviceId: 'esp32-kitchen', room: '厨房', state: 'NORMAL', battery: batteryFrame() }));
  const migrated = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(migrated.schemaVersion, 7);
  assert.deepEqual(migrated.devices[0].battery, batteryFrame());
});
