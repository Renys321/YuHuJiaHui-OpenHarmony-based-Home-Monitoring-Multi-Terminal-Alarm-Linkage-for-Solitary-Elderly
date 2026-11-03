/**
 * 缺陷 1 回归测试：传感器“有读数 / 读取有效 / 环境正常”三分，以及离线和颜色语义。
 *
 * 使用实际 core/view/ViewMapper.ts + core/capability/DeviceCapabilities.ts 编译产物。
 * 输入是 SIMULATED API JSON；不访问公网、不代表真机 UI PASS。
 * 颜色通过生产映射器写入 SensorView.colorToken 断言（真实组件 SensorCard 使用该字段选色）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './fake-transport.mjs';

const { parseDevices, parseAlerts } = loadCore('api/Contracts.js');
const { mapDevices, mapAlerts, countNeedsAttention } = loadCore('view/ViewMapper.js');
const { colorTokenForSensorState } = loadCore('capability/DeviceCapabilities.js');

const NOW = 1730000000000;

function deviceJson(overrides = {}) {
  return {
    id: overrides.deviceId || 'd1',
    deviceId: 'esp32-kitchen',
    name: '厨房节点',
    roomId: 'r-kitchen',
    roomName: '厨房',
    location: '',
    online: true,
    monitorOnline: 1,
    state: 'NORMAL',
    lastSeenTs: NOW - 5000,
    csq: 20,
    sensors: {},
    ...overrides
  };
}

function mapDeviceJson(overrides = {}) {
  const parsed = parseDevices(JSON.stringify({ devices: [deviceJson(overrides)] }));
  assert.ok(parsed);
  const views = mapDevices(parsed, NOW);
  assert.equal(views.length, 1);
  return views[0];
}

function sensorOf(view, kind) {
  return view.sensors.find((sensor) => sensor.kind === kind) || null;
}

// ------------------------------------------------------------ 在线 / 有效性

test('在线、有读数、valid 缺失：有效性未知，中性色，不显示“正常”', () => {
  const view = mapDeviceJson({ sensors: { climate: { tempC: 24.5, rh: 55 } } });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(climate.state, 'unknown', '缺 valid 不得推断 ok');
  assert.equal(climate.stateText, '有效性未知');
  assert.equal(climate.validity, 'unknown');
  assert.notEqual(climate.stateText, '正常');
  assert.equal(climate.colorToken, 'neutral', '有效性未知必须中性色');
  assert.notEqual(climate.colorToken, 'success');
  assert.match(climate.valueText, /24\.5°C/);
  assert.match(climate.valueText, /55%RH/);
  assert.match(climate.detailText, /有效性未知|不代表环境正常/);
});

test('在线、明确 valid=false：读数无效，保留上次读数，warning 色而非绿色', () => {
  const view = mapDeviceJson({
    sensors: { climate: { tempC: 24.5, rh: 55, valid: false } }
  });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(climate.state, 'invalid');
  assert.equal(climate.stateText, '读数无效');
  assert.equal(climate.validity, 'invalid');
  assert.equal(climate.colorToken, 'warning');
  assert.notEqual(climate.colorToken, 'success');
  assert.match(climate.valueText, /上次读数/);
  assert.match(climate.valueText, /24\.5°C/);
  assert.match(climate.detailText, /读取失败|读数无效/);
});

test('在线、读取失败 ok=false：读数无效且说明上次读数，不显示正常', () => {
  const view = mapDeviceJson({
    sensors: { climate: { tempC: 24.5, rh: 55, ok: false } }
  });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(climate.state, 'invalid');
  assert.equal(climate.stateText, '读数无效');
  assert.equal(climate.validity, 'invalid');
  assert.notEqual(climate.colorToken, 'success');
  assert.match(climate.valueText, /上次读数/);
});

test('在线、valid=true：只声明“读数有效”，不把读取有效当成环境正常', () => {
  const view = mapDeviceJson({
    sensors: { climate: { tempC: 24.5, rh: 55, valid: true } }
  });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(climate.state, 'ok');
  assert.equal(climate.stateText, '读数有效');
  assert.equal(climate.validity, 'valid');
  assert.equal(climate.colorToken, 'success');
  assert.notEqual(climate.stateText, '正常');
  assert.match(climate.detailText, /读取有效/);
});

test('温度合法为 0（湿度非零）且 valid 缺失：不判为读取失败，不显示绿色正常', () => {
  const view = mapDeviceJson({ sensors: { climate: { tempC: 0, rh: 55 } } });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.notEqual(climate.state, 'invalid', '0℃ 不得单独视为读取失败');
  assert.equal(climate.state, 'unknown');
  assert.equal(climate.stateText, '有效性未知');
  assert.match(climate.valueText, /0\.0°C/);
  assert.match(climate.valueText, /55%RH/);
  assert.equal(climate.colorToken, 'neutral');
});

// ------------------------------------------------------------ 离线 / 历史读数

test('离线、有历史读数：显示“离线·上次读数”，中性色，不再显示实时正常', () => {
  const view = mapDeviceJson({
    online: false,
    monitorOnline: -1,
    sensors: { climate: { tempC: 24.5, rh: 55 } }
  });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(view.stateText, '离线');
  assert.equal(climate.state, 'offline');
  assert.equal(climate.stateText, '离线·上次读数');
  assert.equal(climate.colorToken, 'neutral');
  assert.notEqual(climate.colorToken, 'success');
  assert.match(climate.valueText, /上次读数/);
  assert.match(climate.valueText, /24\.5°C/);
  assert.match(climate.detailText, /设备离线/);
});

test('离线、无读数：显示“离线·暂无数据”，不得补 0 或显示正常', () => {
  const view = mapDeviceJson({ online: false, monitorOnline: -1, sensors: {} });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(climate.state, 'offline');
  assert.equal(climate.stateText, '离线·暂无数据');
  assert.equal(climate.valueText, '--');
  assert.equal(climate.colorToken, 'neutral');
  assert.doesNotMatch(climate.valueText, /0\.0°C/);
});

test('离线但存在真实告警：告警事实保留，设备可达性与告警分开表达', () => {
  const view = mapDeviceJson({ online: false, monitorOnline: -1, sensors: {} });
  const parsed = parseAlerts(JSON.stringify({
    alerts: [{
      alarmId: 'a-offline-1', deviceId: 'esp32-kitchen', roomName: '厨房',
      type: 'NO_MOTION', message: '检测到异常', state: 'ALARM', ackPending: false,
      createdAt: NOW - 60000
    }]
  }));
  assert.ok(parsed);
  const alerts = mapAlerts(parsed);
  assert.equal(alerts.length, 1, '设备离线不得抹掉真实告警');
  assert.equal(alerts[0].statusKey, 'pending');
  assert.equal(countNeedsAttention(alerts), 1);
  assert.equal(view.online, false);
  assert.equal(view.stateText, '离线');
});

test('离线 MQ 历史值：保留原始 ADC 语义与“报警未启用”，但显示离线·上次读数', () => {
  const view = mapDeviceJson({
    online: false,
    monitorOnline: -1,
    sensors: { gas: { raw: 780, ok: true }, smoke: { raw: 4095, ok: true } }
  });
  for (const kind of ['gas', 'smoke']) {
    const sensor = sensorOf(view, kind);
    assert.ok(sensor);
    assert.equal(sensor.state, 'offline');
    assert.equal(sensor.stateText, '离线·上次读数');
    assert.match(sensor.valueText, /上次读数/);
    assert.match(sensor.valueText, /原始 ADC/);
    assert.doesNotMatch(sensor.valueText, /ppm/i);
    assert.match(sensor.detailText, /报警未启用/);
    assert.equal(sensor.alarmEnabled, false);
    assert.equal(sensor.colorToken, 'neutral');
  }
});

// ------------------------------------------------------------ 颜色语义 / 能力门控回归

test('颜色 token：仅 ok 为 success；unknown/offline/disabled 中性；invalid warning', () => {
  assert.equal(colorTokenForSensorState('ok'), 'success');
  assert.equal(colorTokenForSensorState('unknown'), 'neutral');
  assert.equal(colorTokenForSensorState('offline'), 'neutral');
  assert.equal(colorTokenForSensorState('disabled'), 'neutral');
  assert.equal(colorTokenForSensorState('unsupported'), 'neutral');
  assert.equal(colorTokenForSensorState('invalid'), 'warning');
  assert.equal(colorTokenForSensorState('attention'), 'warning');
  assert.equal(colorTokenForSensorState('critical'), 'critical');
  assert.equal(colorTokenForSensorState('waiting'), 'info');
});

test('能力门控无回归：厨房无 PIR/门磁/水漏，卫生间无燃气/烟雾，未知不默认', () => {
  const kitchen = mapDeviceJson({
    deviceId: 'esp32-kitchen',
    sensors: {
      motion: { lastActiveTs: NOW - 1000, countToday: 1 },
      door: { open: true, lastOpenTs: NOW - 1000 },
      water: { wet: true }
    }
  });
  assert.equal(sensorOf(kitchen, 'motion'), null);
  assert.equal(sensorOf(kitchen, 'door'), null);
  assert.equal(sensorOf(kitchen, 'water'), null);

  const bath = mapDeviceJson({
    deviceId: 'esp32-bath',
    roomId: 'r-bath',
    sensors: { gas: { raw: 100 }, smoke: { raw: 100 }, water: { wet: false } }
  });
  assert.equal(sensorOf(bath, 'gas'), null);
  assert.equal(sensorOf(bath, 'smoke'), null);
  assert.equal(sensorOf(bath, 'water'), null);

  const unknown = mapDeviceJson({
    deviceId: 'esp32-new-node',
    sensors: { climate: { tempC: 30, rh: 40 }, gas: { raw: 500 } }
  });
  assert.equal(unknown.capabilityVerified, false);
  for (const sensor of unknown.sensors) {
    assert.equal(sensor.installed, false);
    assert.equal(sensor.state, 'unknown');
    assert.equal(sensor.colorToken, 'neutral');
    assert.equal(sensor.valueText, '待确认');
  }
});

test('MQ 在线回归：原始 ADC、无 ppm、报警未启用、中性色', () => {
  const view = mapDeviceJson({
    sensors: { gas: { raw: 780, ok: true }, smoke: { raw: 4095, ok: true } }
  });
  for (const kind of ['gas', 'smoke']) {
    const sensor = sensorOf(view, kind);
    assert.ok(sensor);
    assert.equal(sensor.state, 'disabled');
    assert.equal(sensor.stateText, '报警未启用');
    assert.equal(sensor.alarmEnabled, false);
    assert.equal(sensor.colorToken, 'neutral');
    assert.match(sensor.valueText, /原始 ADC/);
    assert.doesNotMatch(sensor.valueText, /ppm/i);
  }
});
