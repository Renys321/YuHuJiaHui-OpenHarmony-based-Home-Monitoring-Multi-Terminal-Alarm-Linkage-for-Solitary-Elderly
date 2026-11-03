'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WearableMirrorModel } = require('../src/model');

const T0 = 1_793_100_000_000;

function newModel(options = {}) {
  return new WearableMirrorModel(Object.assign({ offlineAfterMs: 45000 }, options));
}

function sos(model, now, alarmId, gps = null, extra = {}) {
  return model.onBusiness(Object.assign({ v: 1, t: 'sos', dev: 'esp32-sos', alarm: alarmId, gps, seq: 1 }, extra), now);
}

function ack(model, now, alarmId, cmd = '42') {
  return model.onBusiness({ v: 1, t: 'ack', dev: 'esp32-sos', alarm: alarmId, cmd }, now);
}

function hb(model, now, state = 'IDLE') {
  return model.onBusiness({ v: 1, t: 'hb', dev: 'esp32-sos', state, alarm: '', uptimeMs: now % 1000, csq: 26 }, now);
}

test('同一 alarmId 的重复 SOS 只形成一条事件，eventTs 保持在第一次', () => {
  const model = newModel();
  sos(model, T0, 'sos-1-ab12cd');
  assert.equal(model.event.alarmId, 'sos-1-ab12cd');
  assert.equal(model.phase(), 'ALARM');
  sos(model, T0 + 10000, 'sos-1-ab12cd');
  sos(model, T0 + 20000, 'sos-1-ab12cd');
  assert.equal(model.counters.sosRetransmit, 2);
  assert.equal(model.event.eventTs, T0);
  const status = model.buildStatus(T0 + 20000);
  assert.equal(status.alarm.id, 'sos-1-ab12cd');
  assert.equal(status.alarm.type, 'MANUAL_SOS');
  assert.equal(status.alarm.countToday, 1);
  assert.equal(status.state, 'ALARM');
  assert.equal(status.eventTs, T0);
});

test('ACK 只有 alarm 匹配当前事件才生效；不匹配/重复/无关一律不改状态', () => {
  const model = newModel();
  sos(model, T0, 'sos-1-ab12cd');
  ack(model, T0 + 1000, 'sos-9-ffff');
  assert.equal(model.phase(), 'ALARM');
  assert.equal(model.counters.ackStale, 1);
  ack(model, T0 + 2000, 'sos-1-ab12cd');
  assert.equal(model.phase(), 'ACKED');
  assert.equal(model.event.ackTs, T0 + 2000);
  assert.equal(model.event.ackedBy, 'device-ack');
  ack(model, T0 + 3000, 'sos-1-ab12cd');
  assert.equal(model.counters.ackDuplicate, 1);
  assert.equal(model.event.ackTs, T0 + 2000);
});

test('hb 的 IDLE 不能推断 ACKED：未确认事件保持 ALARM 且留诊断计数', () => {
  const model = newModel();
  sos(model, T0, 'sos-2-0001');
  hb(model, T0 + 1000, 'IDLE');
  assert.equal(model.phase(), 'ALARM');
  assert.equal(model.counters.hbIdleWhileAlarm, 1);
  const status = model.buildStatus(T0 + 1000);
  assert.equal(status.state, 'ALARM');
  assert.equal(status.alarm.id, 'sos-2-0001');
});

test('ACKED 后新 alarmId 才是新事件；旧 alarmId 迟到报文不重复建事件', () => {
  const model = newModel();
  sos(model, T0, 'sos-1-aaaa');
  ack(model, T0 + 1000, 'sos-1-aaaa');
  sos(model, T0 + 2000, 'sos-1-aaaa');
  assert.equal(model.event.alarmId, 'sos-1-aaaa');
  assert.equal(model.event.acked, true);
  assert.equal(model.counters.sosRetransmit, 1);
  sos(model, T0 + 3000, 'sos-2-bbbb');
  assert.equal(model.event.alarmId, 'sos-2-bbbb');
  assert.equal(model.phase(), 'ALARM');
  sos(model, T0 + 4000, 'sos-1-aaaa');
  assert.equal(model.counters.sosStale, 1);
  assert.equal(model.event.alarmId, 'sos-2-bbbb');
});

test('无 fix 时 gps.valid=false 且经纬度为 null，绝不用 0 冒充', () => {
  const model = newModel();
  sos(model, T0, 'sos-3-nogps');
  const status = model.buildStatus(T0 + 1000);
  assert.equal(status.gps.valid, false);
  assert.equal(status.gps.latitude, null);
  assert.equal(status.gps.longitude, null);
  assert.equal(status.gps.fixTime, 0);
});

test('M100 固定格式坏报文不写假坐标，并记录失败码', () => {
  const model = newModel();
  const rejects = [
    'config,set,paramsrc,1',
    '112.55326080300_32.966827393000_extra',
    'abc_def',
    '0_0',
    '200.0_32.9',
    '{"v":1,"t":"sos"'
  ];
  for (const payload of rejects) {
    const result = model.onPayload(payload, T0);
    assert.notEqual(result.changed, true, `payload should not change state: ${payload}`);
  }
  assert.equal(model.latestGps, null);
  assert.ok(model.counters.gpsReject >= 3);
  assert.ok(model.counters.malformed >= 1);
  const status = model.buildStatus(T0 + 1000);
  assert.equal(status.gps.valid, false);
  assert.equal(status.gps.latitude, null);
});

test('M100 固定格式真机样例解析为 WGS84 十进制，fixTime 用接收时间', () => {
  const model = newModel();
  const result = model.onPayload('112.55326080300_32.966827393000', T0);
  assert.equal(result.kind, 'gps');
  assert.equal(model.latestGps.valid, true);
  assert.equal(model.latestGps.latitude, 32.9668274);
  assert.equal(model.latestGps.longitude, 112.5532608);
  assert.equal(model.latestGps.fixTime, T0);

  sos(model, T0 + 5000, 'sos-4-gps1');
  assert.equal(model.event.gps.valid, true);
  assert.equal(model.event.gps.fixTime, T0);
  assert.equal(model.event.gpsSource, 'm100-latest');

  model.onPayload('112.6000000_32.9000000', T0 + 6000);
  let status = model.buildStatus(T0 + 6000);
  assert.equal(status.gps.longitude, 112.5532608);
  assert.equal(status.gps.fixTime, T0);

  ack(model, T0 + 7000, 'sos-4-gps1');
  status = model.buildStatus(T0 + 7000);
  assert.equal(status.gps.longitude, 112.6);
  assert.equal(status.gps.fixTime, T0 + 6000);
});

test('SOS 自带 gps 优先于最近 M100 位置；无效 gps 不覆盖', () => {
  const model = newModel();
  model.onPayload('112.55326080300_32.966827393000', T0);
  sos(model, T0 + 1000, 'sos-5-gps2', { lat: 32.1, lon: 112.2, fix: true, ageMs: 5000 });
  assert.equal(model.event.gps.valid, true);
  assert.equal(model.event.gps.latitude, 32.1);
  assert.equal(model.event.gpsSource, 'device-sos');
  assert.equal(model.event.gps.fixTime, T0 + 1000 - 5000);

  const model2 = newModel();
  model2.onPayload('112.55326080300_32.966827393000', T0);
  sos(model2, T0 + 1000, 'sos-6-gps3', { lat: 0, lon: 0, fix: true });
  assert.equal(model2.event.gpsSource, 'm100-latest');
  assert.equal(model2.event.gps.latitude, 32.9668274);
});

test('boot 不清除未确认事件；在线状态按离线阈值判定', () => {
  const model = newModel({ offlineAfterMs: 5000 });
  sos(model, T0, 'sos-7-boot');
  model.onBusiness({ v: 1, t: 'boot', dev: 'esp32-sos', uptimeMs: 0, fw: 'wearable-1.0.0' }, T0 + 100);
  assert.equal(model.event.alarmId, 'sos-7-boot');
  assert.equal(model.phase(), 'ALARM');
  assert.equal(model.firmware, 'wearable-1.0.0');
  assert.equal(model.buildStatus(T0 + 1000).online, true);
  assert.equal(model.buildStatus(T0 + 6000).online, false);
  assert.equal(model.buildStatus(T0 + 6000).state, 'ALARM');
});

test('输出契约：deviceId/room/sensors.motion 字段与 ts/lastSeen 语义', () => {
  const model = newModel();
  sos(model, T0, 'sos-8-contract');
  const status = model.buildStatus(T0 + 100);
  assert.equal(status.deviceId, 'esp32-sos');
  assert.equal(status.room, '随身求助');
  assert.equal(status.ts, T0 + 100);
  assert.equal(status.lastSeen, T0);
  assert.equal(status.alarm.id, 'sos-8-contract');
  assert.equal(status.alarm.type, 'MANUAL_SOS');
  assert.deepEqual(status.sensors.motion, {
    lastActiveTs: 0, countToday: 0, supported: false, reported: false, reason: 'not_configured'
  });
  assert.equal(status.sensors.door.supported, false);
  assert.equal(status.sensors.climate.supported, false);
  assert.deepEqual(status.history, [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(status.slots, [0, 0, 0, 0]);
});

test('API 快照：ALARM→ACKED 只在后端 ACKED 后，且同一 alarmId 不重复', () => {
  const model = newModel();
  const snapshotAlarm = (state, acknowledgedAt = 0) => ({
    state: state,
    lastSeenTs: T0,
    online: true,
    gps: { valid: true, latitude: 32.9668274, longitude: 112.5532608, fixTime: T0 - 2000 },
    alarm: {
      id: 'sos-9-api', type: 'MANUAL_SOS', state,
      createdAt: T0 - 1000, acknowledgedAt
    }
  });
  model.applyApiSnapshot(snapshotAlarm('ALARM'), T0);
  assert.equal(model.event.alarmId, 'sos-9-api');
  assert.equal(model.phase(), 'ALARM');
  assert.equal(model.event.eventTs, T0 - 1000);
  assert.equal(model.event.gps.valid, true);

  model.applyApiSnapshot(Object.assign(snapshotAlarm('ALARM'), {
    alarm: Object.assign(snapshotAlarm('ALARM').alarm, { ackPending: true })
  }), T0 + 1000);
  assert.equal(model.phase(), 'ALARM');

  model.applyApiSnapshot(snapshotAlarm('ACKED', T0 + 2500), T0 + 2000);
  assert.equal(model.phase(), 'ACKED');
  assert.equal(model.event.ackedBy, 'device-ack-via-backend');
  assert.equal(model.event.ackTs, T0 + 2500);
  assert.equal(model.counters.sos, 0);
});

test('API 快照：设备状态 NORMAL 不会静默丢弃未确认事件', () => {
  const model = newModel();
  model.applyApiSnapshot({
    state: 'NORMAL', lastSeenTs: T0, online: true, gps: null,
    alarm: { id: 'sos-10-api', type: 'MANUAL_SOS', state: 'ALARM', createdAt: T0 }
  }, T0);
  model.applyApiSnapshot({ state: 'NORMAL', lastSeenTs: T0, online: true, gps: null, alarm: null }, T0 + 1000);
  assert.equal(model.event.alarmId, 'sos-10-api');
  assert.equal(model.phase(), 'ALARM');
});

test('state 只映射真实告警：API 设备状态 ALARM 但告警尚未同步时不降级为 NORMAL', () => {
  const model = newModel();
  model.applyApiSnapshot({ state: 'ALARM', lastSeenTs: T0, online: true, gps: null, alarm: null }, T0);
  assert.equal(model.phase(), 'ALARM');
  const status = model.buildStatus(T0);
  assert.equal(status.state, 'ALARM');
  assert.equal(status.alarm.id, '');
});
