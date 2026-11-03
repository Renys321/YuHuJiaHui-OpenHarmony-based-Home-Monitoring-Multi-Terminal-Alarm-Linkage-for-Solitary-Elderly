'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toPropertyPost } = require('./adapter');

function kitchen(overrides) {
  const msg = {
    deviceId: 'esp32-kitchen',
    room: '厨房',
    ts: 1792506627818,
    state: 'NORMAL',
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
  if (overrides) overrides(msg);
  return msg;
}

const meta = () => ({ id: '1', timestampMs: Date.now() });

test('新增 valid 字段被接受（这是此前 INVALID_STATUS 的唯一原因）', () => {
  const p = toPropertyPost(kitchen(), meta());
  assert.ok(p && p.params && p.params.gas && p.params.smoke);
});

test('valid 不透传到上云载荷（后端合同不变）', () => {
  const p = toPropertyPost(kitchen(), meta());
  assert.equal(Object.prototype.hasOwnProperty.call(p.params.gas.value, 'valid'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(p.params.smoke.value, 'valid'), false);
});

test('valid 类型不是布尔仍拒绝', () => {
  const bad = kitchen((m) => { m.sensors.gas.valid = 'yes'; });
  assert.throws(() => toPropertyPost(bad, meta()), /gas\.valid/);
});

test('其它未知字段仍严格拒绝', () => {
  const bad = kitchen((m) => { m.sensors.smoke.extra = 1; });
  assert.throws(() => toPropertyPost(bad, meta()), /unknown field/);
});

test('不含 valid 的旧报文不受影响', () => {
  const old = kitchen((m) => {
    delete m.sensors.climate.valid;
    delete m.sensors.gas.valid;
    delete m.sensors.smoke.valid;
  });
  const p = toPropertyPost(old, meta());
  assert.ok(p && p.params.gas);
});

test('climate.valid 非布尔被拒绝', () => {
  const bad = kitchen((m) => { m.sensors.climate.valid = 1; });
  assert.throws(() => toPropertyPost(bad, meta()), /climate\.valid/);
});
