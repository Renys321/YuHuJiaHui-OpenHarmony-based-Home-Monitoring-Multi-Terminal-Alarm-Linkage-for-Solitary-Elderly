/**
 * 能力表测试（实际 core/capability/DeviceCapabilities.ts 编译产物）。
 *
 * 数据依据：REAL-API-INTEGRATION-SPEC.md §2 能力表。
 * 本测试只验证 APP 侧能力判定逻辑，不代表真实设备在线/告警（NOT TESTED）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './fake-transport.mjs';

const {
  MotionSource,
  PIR_UNCONFIGURED_TEXT,
  PIR_NO_DATA_TEXT,
  CAMERA_NO_VALID_DATA_TEXT,
  resolveCapability,
  capabilitySummaryOf,
  capabilityNoteOf,
  capabilityWarningFor,
  formatRawAdc,
  stateTextOf
} = loadCore('capability/DeviceCapabilities.js');

function kinds(profile) {
  return profile.entries.map((entry) => entry.kind);
}

function entryOf(profile, kind) {
  const found = profile.entries.find((entry) => entry.kind === kind);
  assert.ok(found, `能力表缺少 ${kind}`);
  return found;
}

test('kitchen: 已核实，具备温湿度 + PIR + 门磁 + MQ 原始 ADC，无摄像头/水漏', () => {
  const p = resolveCapability('esp32-kitchen');
  assert.equal(p.verified, true);
  assert.equal(p.deviceId, 'esp32-kitchen');
  assert.equal(entryOf(p, 'climate').installed, true);
  assert.equal(entryOf(p, 'gas').installed, true);
  assert.equal(entryOf(p, 'smoke').installed, true);
  assert.equal(entryOf(p, 'motion').installed, true, '厨房 PIR 已于 2026-10-27 在板，必须显示已安装');
  assert.equal(entryOf(p, 'door').installed, true, '厨房门磁已于 2026-10-27 在板，必须显示已安装');
  assert.equal(entryOf(p, 'water').installed, false, '厨房不得显示水漏已安装');
  assert.equal(entryOf(p, 'camera').installed, false);
});

test('kitchen: gas/smoke 是原始 ADC 且明确“报警禁用/未启用”，不得当作告警能力', () => {
  const p = resolveCapability('esp32-kitchen');
  for (const kind of ['gas', 'smoke']) {
    const entry = entryOf(p, kind);
    assert.equal(entry.alarmEnabled, false, `${kind} 不得声明云端报警已启用`);
    assert.match(entry.note, /原始 ADC/);
    assert.match(entry.note, /报警禁用|报警未启用/);
  }
});

test('kitchen: 温湿度 CLIMATE 告警已启用（能力表按 capability audit 更新）', () => {
  const p = resolveCapability('esp32-kitchen');
  assert.equal(entryOf(p, 'climate').alarmEnabled, true);
});

test('bath: 具备温湿度/PIR/SOS，无燃气/烟雾/门磁，水漏未启用', () => {
  const p = resolveCapability('esp32-bath');
  assert.equal(p.verified, true);
  assert.equal(entryOf(p, 'climate').installed, true);
  assert.equal(entryOf(p, 'motion').installed, true);
  assert.equal(entryOf(p, 'sos').installed, true);
  assert.equal(entryOf(p, 'sos').alarmEnabled, true);
  assert.equal(entryOf(p, 'gas').installed, false, '卫生间不得显示燃气已安装');
  assert.equal(entryOf(p, 'smoke').installed, false, '卫生间不得显示烟雾已安装');
  assert.equal(entryOf(p, 'door').installed, true, '卫生间门磁已于 2026-10-27 在板，必须显示已安装');
  assert.equal(entryOf(p, 'water').installed, false, '水漏本轮未启用，不得显示已安装/告警');
});

test('bath PIR：支持 NO_MOTION 告警（1800s 无活动触发；不因“有活动”报警）', () => {
  const p = resolveCapability('esp32-bath');
  const motion = entryOf(p, 'motion');
  // capability audit D1：PIR 本身不产生瞬时告警，但无活动 1800s 会触发 NO_MOTION。
  assert.equal(motion.installed, true);
  assert.equal(motion.enabled, true);
  assert.equal(motion.alarmEnabled, true, '审计 D1：PIR 启用后长时间无活动触发 NO_MOTION 告警');
  assert.match(motion.note, /NO_MOTION/);
  assert.doesNotMatch(motion.note, /PIR 告警|检测到人员移动即告警/);
  assert.match(p.note, /NO_MOTION/);

  // 厨房 PIR 已于 2026-10-27 在板：NO_MOTION 属于真实能力，不能再按“未安装”处理。
  const kitchen = resolveCapability('esp32-kitchen');
  const kitchenMotion = entryOf(kitchen, 'motion');
  assert.equal(kitchenMotion.installed, true);
  assert.equal(kitchenMotion.alarmEnabled, true);
  assert.match(kitchenMotion.note, /NO_MOTION/);
});

test('dayu200-living: 无 PIR，人员检测来自摄像头判定；APP 无实时视频接口', () => {
  const p = resolveCapability('dayu200-living');
  assert.equal(p.verified, true);
  assert.equal(p.motionSource, MotionSource.CAMERA, '客厅活动检测来源必须是摄像头判定，不是 PIR');
  const camera = entryOf(p, 'camera');
  assert.equal(camera.installed, true);
  assert.match(camera.name, /摄像头人体检测/);
  assert.match(camera.note, /非 PIR/);
  assert.match(camera.note, /无实时视频接口/);
  // 无 PIR：motion 能力未安装，且文案明确“未配置 PIR”
  const motion = entryOf(p, 'motion');
  assert.equal(motion.installed, false, '客厅没有 PIR，不得把摄像头判定当 PIR 能力');
  assert.match(motion.name + motion.note, /未配置 PIR/);
  assert.doesNotMatch(motion.note, /NO_MOTION 告警/);
  assert.match(p.note, /未配置 PIR/);
  assert.match(p.note, /摄像头/);
  const summary = capabilitySummaryOf('dayu200-living');
  assert.match(summary, /摄像头人体检测/);
  assert.match(summary, /跌倒判定/);
  assert.doesNotMatch(summary, /PIR 活动监测/);
  const note = capabilityNoteOf('dayu200-living');
  assert.match(note, /PIR 活动监测（未配置）/);
  assert.doesNotMatch(note, /待确认/);
});

test('活动检测来源（MotionSource）：厨房/卫生间=PIR，随身求助=无活动检测能力', () => {
  assert.equal(resolveCapability('esp32-kitchen').motionSource, MotionSource.PIR);
  assert.equal(resolveCapability('esp32-bath').motionSource, MotionSource.PIR);
  assert.equal(resolveCapability('esp32-sos').motionSource, MotionSource.NONE);
  assert.equal(resolveCapability('esp32-unknown-xyz').motionSource, MotionSource.NONE);
});

test('PIR/摄像头固定文案逐字固定（无 PIR 时不得显示“长时间无活动”）', () => {
  assert.equal(PIR_UNCONFIGURED_TEXT, '未配置 PIR，无活动监测');
  assert.equal(PIR_NO_DATA_TEXT, '暂无有效 PIR 数据');
  assert.equal(CAMERA_NO_VALID_DATA_TEXT, '暂无有效检测数据');
});


test('未知 deviceId: 能力待确认，且不默认拥有任何传感器', () => {
  for (const deviceId of ['esp32-new-node', 'unknown-device-xyz', '']) {
    const p = resolveCapability(deviceId);
    assert.equal(p.verified, false, `${deviceId} 不得标记为已核实`);
    assert.equal(capabilitySummaryOf(deviceId).includes('待确认'), true);
    for (const entry of p.entries) {
      assert.equal(entry.installed, false, `未知设备 ${deviceId} 的 ${entry.kind} 不得默认 installed`);
      assert.equal(entry.alarmEnabled, false, `未知设备 ${deviceId} 的 ${entry.kind} 不得默认 alarmEnabled`);
    }
  }
});

test('capabilitySummaryOf: kitchen 摘要只列已核实已启用能力', () => {
  const summary = capabilitySummaryOf('esp32-kitchen');
  assert.match(summary, /温湿度/);
  assert.match(summary, /燃气/);
  assert.match(summary, /烟雾/);
  assert.match(summary, /人体活动/);
  assert.match(summary, /门磁/);
  assert.doesNotMatch(summary, /水漏/);
  assert.doesNotMatch(summary, /摄像头/);
});

test('capabilityNoteOf: 明确列出未安装/未启用能力', () => {
  const note = capabilityNoteOf('esp32-kitchen');
  assert.match(note, /未安装/);
  assert.match(note, /水漏/);
  assert.match(note, /摄像头/);
});

test('formatRawAdc: 只输出原始 ADC，绝不冒充 ppm', () => {
  const text = formatRawAdc(780);
  assert.match(text, /原始 ADC/);
  assert.match(text, /780/);
  assert.doesNotMatch(text, /ppm/i);
  for (const bad of [null, undefined, NaN, Infinity]) {
    const fallback = formatRawAdc(bad);
    assert.doesNotMatch(fallback, /ppm/i);
    assert.notEqual(fallback, '');
  }
});

test('stateTextOf: 无效/等待/未启用/未安装/待确认 文案不冒充“正常”', () => {
  assert.equal(stateTextOf('invalid'), '无效');
  assert.equal(stateTextOf('waiting'), '等待数据');
  assert.equal(stateTextOf('disabled'), '报警未启用');
  assert.equal(stateTextOf('unsupported'), '未安装/未启用');
  assert.equal(stateTextOf('unknown'), '待确认');
  assert.notEqual(stateTextOf('offline'), '正常');
  assert.notEqual(stateTextOf('unknown'), '正常');
});

// ---------------------------------------------------------------- 随身求助节点

test('esp32-sos: 已核实 SOS 按键，不得默认拥有摄像头/环境传感器', () => {
  const p = resolveCapability('esp32-sos');
  assert.equal(p.verified, true);
  assert.equal(entryOf(p, 'sos').installed, true);
  assert.equal(entryOf(p, 'sos').alarmEnabled, true);
  for (const kind of ['camera', 'climate', 'motion', 'door', 'gas', 'smoke', 'water', 'fall']) {
    assert.equal(entryOf(p, kind).installed, false, `随身求助节点不得声明 ${kind} 已安装`);
  }
  const summary = capabilitySummaryOf('esp32-sos');
  assert.match(summary, /紧急求助按键/);
  assert.doesNotMatch(summary, /摄像头|燃气|烟雾/);
});

// ---------------------------------------------------------------- 告警能力核对

test('capabilityWarningFor: 厨房 NO_MOTION / 门磁已属真实能力，不得误报“历史/测试数据”', () => {
  assert.equal(capabilityWarningFor('esp32-kitchen', 'motion', '长时间无活动'), '');
  assert.equal(capabilityWarningFor('esp32-kitchen', 'door', '门窗状态变化'), '');
});

test('capabilityWarningFor: 设备确实未安装该能力时（厨房摄像头）必须提示核实', () => {
  const warning = capabilityWarningFor('esp32-kitchen', 'camera', '摄像头事件');
  assert.match(warning, /厨房节点/);
  assert.match(warning, /未安装/);
  assert.match(warning, /核实/);
});

test('capabilityWarningFor: 卫生间 NO_MOTION / 随身求助 SOS 属于真实能力，不误报', () => {
  assert.equal(capabilityWarningFor('esp32-bath', 'motion', '长时间无活动'), '');
  assert.equal(capabilityWarningFor('esp32-sos', 'sos', '紧急求助按键'), '');
});

test('capabilityWarningFor: 客厅无 PIR，NO_MOTION 不得按 PIR 判读（必须提示核实）', () => {
  const warning = capabilityWarningFor('dayu200-living', 'motion', '长时间无活动');
  assert.match(warning, /未配置 PIR/);
  assert.match(warning, /不能按 PIR/);
  assert.match(warning, /摄像头判定/);
  // 客厅 FALL 是已核实能力，不提示能力不符。
  assert.equal(capabilityWarningFor('dayu200-living', 'fall', '检测到跌倒'), '');
});


test('capabilityWarningFor: 未核实设备必须提示来源待确认', () => {
  const warning = capabilityWarningFor('esp32-test-lab', 'motion', '长时间无活动');
  assert.match(warning, /未核实/);
  assert.match(warning, /待确认/);
});
