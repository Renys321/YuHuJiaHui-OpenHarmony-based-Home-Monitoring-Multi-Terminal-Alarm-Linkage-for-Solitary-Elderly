'use strict';

/**
 * door-events.test.js — 门磁开关事件台账合同测试（MemoryStore + PersistentStore）
 *
 * 覆盖任务判据：
 * - 首次摄入只建立基线，不凭空生成"刚开门/刚关门"；
 * - 稳定状态变化才生成事件；重复上传相同状态不重复记账；
 * - 固件补传缓存按 (deviceId, seq) 幂等去重（重试/重连/重复上传）；
 * - 时间语义：设备可信时间戳取设备时间，否则用服务器接收时间并明确标注 timeSource；
 * - 事件 ID 唯一且按写入顺序严格递增；台账有容量上限；
 * - 服务重启后历史保留，ID 继续单调不复用。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { DOOR_EVENT_CAP, MemoryStore } = require('../src/store');
const { PersistentStore } = require('../src/persistent-store');

function ingestBody(deviceId, room, door, ts = 0) {
  const sensors = {};
  if (door !== undefined) sensors.door = door;
  return { deviceId, room, state: 'NORMAL', sensors, ts };
}

function memoryStore() {
  return new MemoryStore();
}

function tempDbPath() {
  return path.join(os.tmpdir(), `door-events-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

/* ------------------------------------------------------------ 基线语义 */

test('first ingest only establishes the baseline: no event is created', () => {
  const store = memoryStore();
  const status = store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false, lastOpenTs: 0 }), 1000);
  assert.equal(status.deviceId, 'esp32-kitchen');
  assert.deepEqual(store.listDoorEvents(), []);
});

test('door absent in payload: no event, previous events are untouched', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);
  assert.equal(store.listDoorEvents('esp32-kitchen').length, 1);
  // 后续上报不带 door：不生成、不清理（该房间门磁数据缺失不等于门被关闭）。
  store.ingest(ingestBody('esp32-kitchen', '厨房', undefined), 3000);
  assert.equal(store.listDoorEvents('esp32-kitchen').length, 1);
});

test('device with no prior door data: first door reading is baseline, not an event', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', undefined), 1000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);
  assert.deepEqual(store.listDoorEvents('esp32-kitchen'), []);
});

/* ------------------------------------------------------------ 状态变化事件 */

test('confirmed state change generates exactly one event with server time semantics', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);
  const events = store.listDoorEvents('esp32-kitchen');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    eventId: 'dr-1',
    deviceId: 'esp32-kitchen',
    room: '厨房',
    open: true,
    occurredAt: 2000,
    timeSource: 'server',
    seq: 0,
    source: 'state-change'
  });
});

test('device-trusted timestamp is used and labelled as device source', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }, 1000), 1000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }, 456789), 2000);
  const events = store.listDoorEvents('esp32-kitchen');
  assert.equal(events[0].occurredAt, 456789);
  assert.equal(events[0].timeSource, 'device');
});

test('duplicate upload of the same state does not create another event', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);
  // 同状态重复上报（bridge QoS 重试 / 重连重复上传）
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2100);
  assert.equal(store.listDoorEvents('esp32-kitchen').length, 1);
});

test('multiple changes keep write order and strictly increasing ids', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 3000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 4000);
  const events = store.listDoorEvents('esp32-kitchen');
  assert.deepEqual(events.map((e) => e.open), [true, false, true]);
  assert.deepEqual(events.map((e) => e.eventId), ['dr-3', 'dr-2', 'dr-1']);
});

/* ------------------------------------------------------------ 设备补传缓存（幂等） */

test('device-cache events are appended and deduped by (deviceId, seq)', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', {
    open: true,
    events: [
      { open: true, ts: 500, seq: 1 },
      { open: false, ts: 900, seq: 2 }
    ]
  }), 2000);
  let events = store.listDoorEvents('esp32-kitchen');
  assert.equal(events.length, 2);
  assert.equal(events[0].seq, 2);
  assert.equal(events[0].source, 'device-cache');
  assert.equal(events[0].timeSource, 'device');
  assert.equal(events[0].occurredAt, 900);
  assert.equal(events[1].seq, 1);
  // 重复上传同一批补传：seq 幂等，不重复记账
  store.ingest(ingestBody('esp32-kitchen', '厨房', {
    open: true,
    events: [
      { open: true, ts: 500, seq: 1 },
      { open: false, ts: 900, seq: 2 }
    ]
  }), 2100);
  events = store.listDoorEvents('esp32-kitchen');
  assert.equal(events.length, 2);
});

test('same seq from different devices is not confused', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true, events: [{ open: true, ts: 500, seq: 7 }] }), 2000);
  store.ingest(ingestBody('esp32-bathroom', '卫生间', { open: false, events: [{ open: false, ts: 600, seq: 7 }] }), 2100);
  const kitchen = store.listDoorEvents('esp32-kitchen');
  const bathroom = store.listDoorEvents('esp32-bathroom');
  assert.equal(kitchen.length, 1);
  assert.equal(bathroom.length, 1);
  assert.equal(kitchen[0].deviceId, 'esp32-kitchen');
  assert.equal(bathroom[0].deviceId, 'esp32-bathroom');
});

test('device-cache events cover the state change: no duplicate state-change event', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);
  // 离线期间开关一次，重连补传 events + 当前状态 open=true
  store.ingest(ingestBody('esp32-kitchen', '厨房', {
    open: true,
    events: [{ open: true, ts: 0, seq: 1 }]
  }), 2000);
  const events = store.listDoorEvents('esp32-kitchen');
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'device-cache');
  assert.equal(events[0].timeSource, 'server'); // ts=0 不可信 -> 服务器接收时间
});

test('events array last state differs from current open: state-change fallback still fires', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 1000);
  // 异常场景：设备缓存只补传了"开"事件（seq1），但当前状态为关（缓存被截断丢失"关"事件）
  store.ingest(ingestBody('esp32-kitchen', '厨房', {
    open: false,
    events: [{ open: true, ts: 0, seq: 1 }]
  }), 2000);
  const events = store.listDoorEvents('esp32-kitchen');
  assert.equal(events.length, 2);
  assert.equal(events[0].source, 'state-change');
  assert.equal(events[0].open, false);
  assert.equal(events[1].source, 'device-cache');
  assert.equal(events[1].open, true);
});

test('events without a positive seq are discarded (cannot be deduped)', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true, events: [{ open: true, ts: 1, seq: 0 }] }), 1000);
  assert.deepEqual(store.listDoorEvents('esp32-kitchen'), []);
});

/* ------------------------------------------------------------ 查询与上限 */

test('list filters by device and honors limit', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 3000);
  store.ingest(ingestBody('esp32-bathroom', '卫生间', { open: false }), 3500); // 基线
  store.ingest(ingestBody('esp32-bathroom', '卫生间', { open: true }), 4000); // 1 条
  assert.equal(store.listDoorEvents('esp32-kitchen').length, 2);
  assert.equal(store.listDoorEvents('esp32-bathroom').length, 1);
  assert.equal(store.listDoorEvents('', 1).length, 1);
  assert.equal(store.listDoorEvents('esp32-nonexistent').length, 0);
  assert.equal(store.getDoorEvent('dr-2').eventId, 'dr-2');
  assert.equal(store.getDoorEvent('dr-99'), null);
  assert.equal(store.getDoorEvent('dr-0'), null);
});

test('ledger respects the capacity cap by dropping the oldest writes', () => {
  const store = memoryStore();
  store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);
  for (let index = 0; index < DOOR_EVENT_CAP; index += 1) {
    store.ingest(ingestBody('esp32-kitchen', '厨房', { open: index % 2 === 0 }), 2000 + index);
  }
  const events = store.listDoorEvents('esp32-kitchen', 100);
  assert.ok(events.length <= DOOR_EVENT_CAP);
  assert.equal(store.doorEvents.length, DOOR_EVENT_CAP);
  assert.equal(events[0].eventId, `dr-${DOOR_EVENT_CAP}`); // 最新保留
});

/* ------------------------------------------------------------ 持久化重启 */

test('PersistentStore keeps door events across restart and never reuses ids', () => {
  const dbPath = tempDbPath();
  try {
    const first = new PersistentStore({ filePath: dbPath });
    first.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);   // 基线
    first.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);    // dr-1
    first.ingest(ingestBody('esp32-kitchen', '厨房', { open: false, events: [{ open: false, ts: 0, seq: 5 }] }), 3000); // dr-2
    assert.equal(first.listDoorEvents('esp32-kitchen').length, 2);

    const second = new PersistentStore({ filePath: dbPath });
    const events = second.listDoorEvents('esp32-kitchen');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.eventId), ['dr-2', 'dr-1']);
    // 重启后新事件 ID 继续单调，不复用 dr-1..dr-2
    second.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 4000);
    const latest = second.listDoorEvents('esp32-kitchen', 1);
    assert.equal(latest[0].eventId, 'dr-3');
    // 重启加载后的补传 seq 幂等仍然有效
    second.ingest(ingestBody('esp32-kitchen', '厨房', { open: false, events: [{ open: false, ts: 0, seq: 5 }] }), 5000);
    assert.equal(second.listDoorEvents('esp32-kitchen').length, 3);
  } finally {
    try { fs.unlinkSync(dbPath); } catch { /* 测试清理 */ }
  }
});

test('PersistentStore refuses a snapshot with duplicate door event ids', () => {
  const dbPath = tempDbPath();
  try {
    const store = new PersistentStore({ filePath: dbPath });
    store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);  // 基线
    store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);   // dr-1
    // 手工构造重复事件 ID 的损坏快照
    const document = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    document.doorEvents.push({ ...document.doorEvents[0] });  // 复制 dr-1 → 重复 ID
    fs.writeFileSync(dbPath, JSON.stringify(document, null, 2));
    assert.throws(() => new PersistentStore({ filePath: dbPath }), /duplicate door event id/);
  } finally {
    try { fs.unlinkSync(dbPath); } catch { /* 测试清理 */ }
  }
});

test('PersistentStore refuses a snapshot whose door event references an unknown device', () => {
  const dbPath = tempDbPath();
  try {
    const store = new PersistentStore({ filePath: dbPath });
    store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);  // 基线
    store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);   // dr-1
    const document = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    document.doorEvents[0].deviceId = 'esp32-ghost';
    fs.writeFileSync(dbPath, JSON.stringify(document, null, 2));
    assert.throws(() => new PersistentStore({ filePath: dbPath }), /references unknown device/);
  } finally {
    try { fs.unlinkSync(dbPath); } catch { /* 测试清理 */ }
  }
});

test('PersistentStore refuses a snapshot with out-of-order door event ids', () => {
  const dbPath = tempDbPath();
  try {
    const store = new PersistentStore({ filePath: dbPath });
    store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);  // 基线
    store.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);   // dr-1
    store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 3000);  // dr-2
    const document = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    document.doorEvents.reverse();
    fs.writeFileSync(dbPath, JSON.stringify(document, null, 2));
    assert.throws(() => new PersistentStore({ filePath: dbPath }), /strictly increasing/);
  } finally {
    try { fs.unlinkSync(dbPath); } catch { /* 测试清理 */ }
  }
});

test('v6 snapshot without doorEvents key loads as an empty ledger (backward compatible)', () => {
  const dbPath = tempDbPath();
  try {
    const store = new PersistentStore({ filePath: dbPath });
    store.ingest(ingestBody('esp32-kitchen', '厨房', { open: false }), 1000);  // 基线
    const document = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    document.schemaVersion = 6;
    delete document.doorEvents;
    fs.writeFileSync(dbPath, JSON.stringify(document, null, 2));
    const loaded = new PersistentStore({ filePath: dbPath });
    assert.deepEqual(loaded.listDoorEvents(), []);
    // 下一次成功变更写回 v7
    loaded.ingest(ingestBody('esp32-kitchen', '厨房', { open: true }), 2000);
    const after = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert.equal(after.schemaVersion, 7);
    assert.equal(after.doorEvents.length, 1);
  } finally {
    try { fs.unlinkSync(dbPath); } catch { /* 测试清理 */ }
  }
});
