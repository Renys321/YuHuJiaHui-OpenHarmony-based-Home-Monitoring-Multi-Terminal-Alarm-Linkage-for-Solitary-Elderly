'use strict';

/**
 * 适配器电量解析测试（契约 BATTERY-CHAIN-CONTRACT.md §2/§3）
 *
 * 目标：
 *   1) 缺失 battery 时完全不输出（固定供电设备的“无电量”语义）；
 *   2) 合法 battery 归一化后原样进入 property/post 载荷（OneNET 属性保持兼容）；
 *   3) 非法的字段/类型/范围/自相矛盾一律拒绝（未知字段、mv=0 valid、未标定给百分比等）。
 *
 * 运行：node adapter-battery.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { toPropertyPost } = require('./adapter');

const meta = () => ({ id: '1', timestampMs: Date.now() });

function status(overrides = {}) {
  const base = {
    deviceId: 'esp32-sos',
    room: '随身求助',
    ts: 1792506627818,
    state: 'NORMAL',
    sensors: {
      motion: { lastActiveTs: 0, countToday: 0 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 24.6, rh: 60.2, ok: true, valid: true },
      gas: { raw: 276, ok: true, valid: true },
      smoke: { raw: 79, ok: true, valid: true }
    },
    alarm: { id: '', type: '', countToday: 0 }
  };
  if (overrides.battery !== undefined) base.battery = overrides.battery;
  return base;
}

function battery(overrides = {}) {
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

/* ---------------------------------------------------------------- 缺失/固定供电 */

test('缺失 battery：不输出该字段（固定供电设备语义）', () => {
  const p = toPropertyPost(status(), meta());
  assert.equal(Object.prototype.hasOwnProperty.call(p.params, 'battery'), false);
});

test('battery 为 null 仍被拒绝（缺失才表示无电量，null 不是合法对象）', () => {
  assert.throws(() => toPropertyPost(status({ battery: null }), meta()), /status\.battery must be a plain object/);
});

test('source=fixed：present/valid/low=false + mv/percent=null 才接受，且不产生电量数值', () => {
  const fixed = battery({ source: 'fixed', present: false, valid: false, mv: null, percent: null, low: false, calibrated: false });
  const p = toPropertyPost(status({ battery: fixed }), meta());
  assert.deepEqual(p.params.battery.value, fixed);
});

test('source=fixed 却声称有电压/百分比/present -> 拒绝', () => {
  assert.throws(
    () => toPropertyPost(status({ battery: battery({ source: 'fixed' }) }), meta()),
    /fixed power supply must not report/
  );
});

/* ---------------------------------------------------------------- 合法值透传 */

test('合法 battery 原样进入 property/post（不改变既有属性）', () => {
  const p = toPropertyPost(status({ battery: battery() }), meta());
  assert.deepEqual(p.params.battery.value, battery());
  /* 既有属性不受影响 */
  assert.equal(p.params.deviceId.value, 'esp32-sos');
  assert.equal(p.params.gas.value.raw, 276);
  assert.equal(p.params.smoke.value.raw, 79);
});

test('有效的未标定读数：percent=null 允许（mV + 未标定）', () => {
  const uncal = battery({ calibrated: false, percent: null });
  const p = toPropertyPost(status({ battery: uncal }), meta());
  assert.deepEqual(p.params.battery.value, uncal);
  assert.equal(p.params.battery.value.percent, null);
});

test('无效读数（未接电池/浮空）：valid=false + mv/percent=null + reason 短码', () => {
  const invalid = battery({
    present: false, valid: false, mv: null, percent: null, low: false, calibrated: false, reason: 'OUT_OF_RANGE'
  });
  const p = toPropertyPost(status({ battery: invalid }), meta());
  assert.deepEqual(p.params.battery.value, invalid);
});

test('reason 缺失时归一化为空串（不是 undefined）', () => {
  const b = battery();
  delete b.reason;
  const p = toPropertyPost(status({ battery: b }), meta());
  assert.equal(p.params.battery.value.reason, '');
});

test('低电量：low=true 的合法读数被接受', () => {
  const low = battery({ mv: 3450, percent: 15, low: true });
  const p = toPropertyPost(status({ battery: low }), meta());
  assert.equal(p.params.battery.value.low, true);
  assert.equal(p.params.battery.value.mv, 3450);
});

/* ---------------------------------------------------------------- 非法字段/类型 */

test('未知字段 -> 拒绝', () => {
  assert.throws(
    () => toPropertyPost(status({ battery: battery({ voltage: 3850 }) }), meta()),
    /unknown field/
  );
});

test('缺必填字段 -> 拒绝', () => {
  const b = battery();
  delete b.valid;
  assert.throws(() => toPropertyPost(status({ battery: b }), meta()), /battery\.valid is required/);
});

test('source 未知 -> 拒绝', () => {
  assert.throws(
    () => toPropertyPost(status({ battery: battery({ source: 'usb' }) }), meta()),
    /battery\.source/
  );
});

test('布尔字段类型错误 -> 拒绝', () => {
  for (const key of ['present', 'valid', 'low', 'calibrated']) {
    assert.throws(
      () => toPropertyPost(status({ battery: battery({ [key]: 1 }) }), meta()),
      new RegExp(`battery\\.${key}`),
      `${key} 必须严格布尔`
    );
  }
});

test('reason 字集合/长度 -> 拒绝', () => {
  assert.throws(() => toPropertyPost(status({ battery: battery({ reason: 'out_of_range' }) }), meta()), /battery\.reason/);
  assert.throws(() => toPropertyPost(status({ battery: battery({ reason: 'UNSTABLE_LONG_CODE' }) }), meta()), /battery\.reason/);
  assert.throws(() => toPropertyPost(status({ battery: battery({ reason: 'has space' }) }), meta()), /battery\.reason/);
});

/* ---------------------------------------------------------------- 范围/交叉校验 */

test('mv 非法范围/非整数 -> 拒绝', () => {
  assert.throws(() => toPropertyPost(status({ battery: battery({ mv: -1 }) }), meta()), /battery\.mv/);
  assert.throws(() => toPropertyPost(status({ battery: battery({ mv: 60001 }) }), meta()), /battery\.mv/);
  assert.throws(() => toPropertyPost(status({ battery: battery({ mv: 3850.5 }) }), meta()), /battery\.mv/);
  assert.throws(() => toPropertyPost(status({ battery: battery({ mv: '3850' }) }), meta()), /battery\.mv/);
});

test('mv=0 且 valid=true -> 拒绝（0 raw 永远不是有效电池电压）', () => {
  assert.throws(
    () => toPropertyPost(status({ battery: battery({ mv: 0, percent: 0 }) }), meta()),
    /valid battery requires a positive mv/
  );
});

test('percent 非法范围/非整数 -> 拒绝', () => {
  assert.throws(() => toPropertyPost(status({ battery: battery({ percent: 101 }) }), meta()), /battery\.percent/);
  assert.throws(() => toPropertyPost(status({ battery: battery({ percent: -1 }) }), meta()), /battery\.percent/);
  assert.throws(() => toPropertyPost(status({ battery: battery({ percent: 42.5 }) }), meta()), /battery\.percent/);
});

test('未标定却给 percent -> 拒绝（禁止把未校准电压冒充精确电量）', () => {
  assert.throws(
    () => toPropertyPost(status({ battery: battery({ calibrated: false, percent: 42 }) }), meta()),
    /percent requires calibrated=true and valid=true/
  );
});

test('valid=false 却带 mv/percent/low -> 拒绝（自相矛盾）', () => {
  assert.throws(
    () => toPropertyPost(status({ battery: battery({ valid: false, mv: 3850 }) }), meta()),
    /invalid battery must not carry mv\/percent\/low/
  );
  assert.throws(
    () => toPropertyPost(status({ battery: battery({ valid: false, percent: null, low: true, mv: null }) }), meta()),
    /invalid battery must not carry mv\/percent\/low/
  );
});

test('battery 是数组/字符串 -> 拒绝', () => {
  assert.throws(() => toPropertyPost(status({ battery: [] }), meta()), /status\.battery must be a plain object/);
  assert.throws(() => toPropertyPost(status({ battery: '3850' }), meta()), /status\.battery must be a plain object/);
});
