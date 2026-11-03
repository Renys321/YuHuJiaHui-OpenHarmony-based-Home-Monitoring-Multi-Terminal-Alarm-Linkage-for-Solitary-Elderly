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
  resolveCapability,
  capabilitySummaryOf,
  capabilityNoteOf,
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

test('kitchen: 已核实，具备温湿度 + MQ 原始 ADC，无 PIR/门磁/水漏/摄像头', () => {
  const p = resolveCapability('esp32-kitchen');
  assert.equal(p.verified, true);
  assert.equal(p.deviceId, 'esp32-kitchen');
  assert.equal(entryOf(p, 'climate').installed, true);
  assert.equal(entryOf(p, 'gas').installed, true);
  assert.equal(entryOf(p, 'smoke').installed, true);
  assert.equal(entryOf(p, 'motion').installed, false, '厨房不得显示 PIR 已安装');
  assert.equal(entryOf(p, 'door').installed, false, '厨房不得显示门磁已安装');
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
  assert.equal(entryOf(p, 'door').installed, false, '卫生间不得显示门磁已安装');
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

  // 厨房无 PIR：不得默认拥有 motion 能力。
  const kitchen = resolveCapability('esp32-kitchen');
  assert.equal(entryOf(kitchen, 'motion').installed, false);
  assert.equal(entryOf(kitchen, 'motion').alarmEnabled, false);
});

test('dayu200-living: 摄像头为本地能力，APP 无实时视频接口', () => {
  const p = resolveCapability('dayu200-living');
  assert.equal(p.verified, true);
  const camera = entryOf(p, 'camera');
  assert.equal(camera.installed, true);
  assert.match(camera.note, /APP 无实时视频接口/);
  assert.match(p.note, /APP 无实时视频接口/);
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
  assert.doesNotMatch(summary, /人体红外|人体活动/);
  assert.doesNotMatch(summary, /门磁/);
});

test('capabilityNoteOf: 明确列出未安装/未启用能力', () => {
  const note = capabilityNoteOf('esp32-kitchen');
  assert.match(note, /未安装/);
  assert.match(note, /PIR|人体红外|门磁/);
  assert.match(note, /水漏/);
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
