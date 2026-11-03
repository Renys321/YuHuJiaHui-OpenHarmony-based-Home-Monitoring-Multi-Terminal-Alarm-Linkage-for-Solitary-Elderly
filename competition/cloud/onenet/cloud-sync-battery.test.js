'use strict';

/**
 * cloud-sync 电量透传测试（契约 BATTERY-CHAIN-CONTRACT.md §4）
 *
 * 目标：device.battery 存在时原样（深拷贝）进入 /internal/v1/device-status 载荷；
 *       缺失时不补默认值（后端因此得到“无电量”，而不是 0）。
 *
 * 运行：node cloud-sync-battery.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildIngestPayload } = require('./cloud-sync');

const NOW = 1791609077775;

function device(overrides = {}) {
  return Object.assign({
    deviceId: 'esp32-sos',
    room: '随身求助',
    online: true,
    state: 'NORMAL',
    alarm: { id: '', type: '', countToday: 0 }
  }, overrides);
}

const battery = () => ({
  source: 'battery', present: true, valid: true, mv: 3850,
  percent: 42, low: false, calibrated: true, reason: ''
});

test('device.battery 透传到后端摄取载荷', () => {
  const payload = buildIngestPayload(device({ battery: battery() }), NOW);
  assert.deepEqual(payload.battery, battery());
  assert.equal(payload.ts, NOW);
  assert.equal(payload.deviceId, 'esp32-sos');
});

test('device.battery 缺失 -> 载荷不含 battery 键（不补 0/默认值）', () => {
  const payload = buildIngestPayload(device(), NOW);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'battery'), false);
});

test('无效读数（valid=false/mv=null）也原样透传，供 APP 显示“电量未知”', () => {
  const invalid = {
    source: 'battery', present: false, valid: false, mv: null,
    percent: null, low: false, calibrated: false, reason: 'NO_ADC'
  };
  const payload = buildIngestPayload(device({ battery: invalid }), NOW);
  assert.deepEqual(payload.battery, invalid);
});

test('battery 与 sensors/gps/csq 并存时互不覆盖', () => {
  const payload = buildIngestPayload(device({
    battery: battery(),
    sensors: { motion: { lastActiveTs: 0, countToday: 1 } },
    gps: { valid: true, latitude: 31.2, longitude: 121.4, fixTime: NOW },
    csq: 23
  }), NOW);
  assert.deepEqual(payload.battery, battery());
  assert.equal(payload.csq, 23);
  assert.equal(payload.sensors.motion.countToday, 1);
  assert.equal(payload.gps.latitude, 31.2);
});

test('battery 是深拷贝：修改源对象不影响载荷', () => {
  const source = battery();
  const payload = buildIngestPayload(device({ battery: source }), NOW);
  source.mv = 9999;
  assert.equal(payload.battery.mv, 3850);
  assert.notEqual(payload.battery, source);
});

test('battery 不是对象 -> 抛错（由 publish 降级为 SYNC_INVALID_STATUS）', () => {
  assert.throws(() => buildIngestPayload(device({ battery: '3850' }), NOW), /device\.battery must be a plain object/);
});
