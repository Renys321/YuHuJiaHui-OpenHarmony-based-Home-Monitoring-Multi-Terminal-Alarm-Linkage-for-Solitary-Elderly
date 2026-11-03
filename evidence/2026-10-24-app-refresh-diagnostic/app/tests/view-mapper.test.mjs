/**
 * 视图映射测试（实际 core/view/ViewMapper.ts + Contracts 编译产物）。
 *
 * 输入是手写的 SIMULATED API JSON；验证：
 * - roomId 关联而非中文房间名；
 * - 能力表限制（厨房无 PIR/门磁/水漏、卫生间无燃气/烟雾、未知设备不默认）；
 * - 缺失/0 占位/valid=false/valid 缺失/离线/监测异常 不显示为正常；
 * - MQ 原始 ADC 不显示 ppm 且“报警未启用”可见；
 * - ACK 状态映射只认服务端 ACKED。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './fake-transport.mjs';

const { parseDevices, parseRooms, parseAlerts, parseOverview } = loadCore('api/Contracts.js');
const {
  mapDevices, mapRooms, mapAlerts, mapOverview, countNeedsAttention, findAlert
} = loadCore('view/ViewMapper.js');

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

// ---------------------------------------------------------------- 温湿度有效性

test('climate 字段缺失：显示“等待数据”，不显示正常', () => {
  const view = mapDeviceJson({ sensors: {} });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(climate.state, 'waiting');
  assert.equal(climate.stateText, '等待数据');
  assert.equal(climate.valueText, '--');
  assert.notEqual(climate.state, 'ok');
  assert.notEqual(climate.stateText, '正常');
});

test('climate tempC/rh 同时为 0（占位）：无效/待确认，不得显示正常', () => {
  const view = mapDeviceJson({ sensors: { climate: { tempC: 0, rh: 0, ok: true } } });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(climate.state, 'invalid');
  assert.equal(climate.stateText, '无效');
  assert.notEqual(climate.validity, 'valid');
});

test('climate valid=false：无效，不显示正常', () => {
  const view = mapDeviceJson({ sensors: { climate: { tempC: 24.5, rh: 55, valid: false } } });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(climate.state, 'invalid');
  assert.equal(climate.validity, 'invalid');
  assert.notEqual(climate.stateText, '正常');
});

test('climate valid 缺失：有效性未知，不得当成有效（云端当前剥离 valid）', () => {
  const view = mapDeviceJson({ sensors: { climate: { tempC: 24.5, rh: 55 } } });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.equal(climate.validity, 'unknown');
  assert.notEqual(climate.validity, 'valid');
});

test('climate 只有 tempC 或只有 rh：仍展示已有读数，缺失项不编造', () => {
  const view = mapDeviceJson({ sensors: { climate: { tempC: 26 } } });
  const climate = sensorOf(view, 'climate');
  assert.ok(climate);
  assert.match(climate.valueText, /26\.0°C/);
  assert.doesNotMatch(climate.valueText, /%RH/);
});

// ---------------------------------------------------------------- 在线 / 监测

test('online=false：设备状态为离线，不显示正常', () => {
  const view = mapDeviceJson({ online: false, monitorOnline: -1 });
  assert.equal(view.online, false);
  assert.equal(view.stateText, '离线');
  assert.notEqual(view.stateText, '正常');
});

test('monitorOnline=0：在线·监测异常；=1 正常；=-1 未知', () => {
  assert.equal(mapDeviceJson({ monitorOnline: 0 }).monitorText, '在线·监测异常');
  assert.equal(mapDeviceJson({ monitorOnline: 1 }).monitorText, '视觉监测正常');
  assert.equal(mapDeviceJson({ monitorOnline: -1 }).monitorText, '监测状态未知');
});

test('csq：0–31 保留；99 已在 DTO 归为未知 -1', () => {
  assert.equal(mapDeviceJson({ csq: 25 }).csq, 25);
  assert.equal(mapDeviceJson({ csq: 99 }).csq, -1);
  assert.equal(mapDeviceJson({ csq: -1 }).csq, -1);
});

// ---------------------------------------------------------------- MQ 原始 ADC

test('kitchen gas/smoke：valueText 只显示原始 ADC，不含 ppm；“报警未启用”可见', () => {
  const view = mapDeviceJson({
    deviceId: 'esp32-kitchen',
    sensors: {
      gas: { raw: 780, ok: true },
      smoke: { raw: 4095, ok: true }
    }
  });
  for (const kind of ['gas', 'smoke']) {
    const sensor = sensorOf(view, kind);
    assert.ok(sensor, `缺少 ${kind} 瓦片`);
    assert.match(sensor.valueText, /原始 ADC/);
    assert.match(sensor.valueText, /780|4095/);
    assert.doesNotMatch(sensor.valueText, /ppm/i, `${kind} valueText 不得显示 ppm`);
    assert.equal(sensor.state, 'disabled');
    assert.equal(sensor.stateText, '报警未启用');
    assert.match(sensor.detailText, /报警未启用/);
    assert.equal(sensor.alarmEnabled, false);
  }
});

test('kitchen 即使服务端下发 motion/door/water，也不展示未安装能力', () => {
  const view = mapDeviceJson({
    deviceId: 'esp32-kitchen',
    sensors: {
      motion: { lastActiveTs: NOW - 1000, countToday: 3 },
      door: { open: true, lastOpenTs: NOW - 1000 },
      water: { wet: true }
    }
  });
  assert.equal(sensorOf(view, 'motion'), null, '厨房无 PIR，不得展示 motion 瓦片');
  assert.equal(sensorOf(view, 'door'), null, '厨房无门磁，不得展示 door 瓦片');
  assert.equal(sensorOf(view, 'water'), null, '厨房无水漏，不得展示 water 瓦片');
});

test('bath 即使服务端下发 gas/smoke，也不展示未安装能力；水漏显示未启用而非正常', () => {
  const bath = mapDeviceJson({
    deviceId: 'esp32-bath',
    sensors: {
      gas: { raw: 100 },
      smoke: { raw: 100 },
      water: { wet: false }
    }
  });
  assert.equal(sensorOf(bath, 'gas'), null, '卫生间无燃气，不得展示 gas 瓦片');
  assert.equal(sensorOf(bath, 'smoke'), null, '卫生间无烟雾，不得展示 smoke 瓦片');
  assert.equal(sensorOf(bath, 'water'), null, '水漏本轮未启用，不得展示为可用能力');
  assert.notEqual(bath.capabilityNote.indexOf('水漏'), -1);
});

test('bath PIR：只显示活动时间/次数，并提示长时间无活动触发 NO_MOTION', () => {
  const bath = mapDeviceJson({
    deviceId: 'esp32-bath',
    sensors: { motion: { lastActiveTs: NOW - 60000, countToday: 4 } }
  });
  const motion = sensorOf(bath, 'motion');
  assert.ok(motion);
  assert.equal(motion.kind, 'motion');
  assert.equal(motion.state, 'ok');
  assert.match(motion.detailText, /NO_MOTION/);
  assert.doesNotMatch(motion.detailText, /ppm/i);
});

// ---------------------------------------------------------------- 未知设备

test('未知 deviceId：能力待确认，字段存在也不显示“正常”', () => {
  const view = mapDeviceJson({
    deviceId: 'esp32-new-node',
    name: '新节点',
    sensors: {
      climate: { tempC: 30, rh: 40 },
      gas: { raw: 500 },
      motion: { lastActiveTs: NOW - 1000, countToday: 1 }
    }
  });
  assert.equal(view.capabilityVerified, false);
  assert.match(view.capabilitySummary, /待确认/);
  assert.ok(view.sensors.length >= 1);
  for (const sensor of view.sensors) {
    assert.equal(sensor.state, 'unknown', `${sensor.kind} 未知设备不得显示 ok`);
    assert.equal(sensor.valueText, '待确认');
    assert.equal(sensor.installed, false);
  }
});

test('未知设备的新增 sensors 字段：只记录为未识别，不崩', () => {
  const view = mapDeviceJson({
    deviceId: 'esp32-new-node',
    sensors: { co2: { value: 400 }, pm25: { value: 10 } }
  });
  assert.equal(view.capabilityVerified, false);
  assert.match(view.capabilityNote, /未识别 sensors 字段/);
  assert.match(view.capabilityNote, /co2/);
});

// ---------------------------------------------------------------- 房间关联

test('rooms/devices 按 roomId 关联，中文房间名不一致也正确绑定', () => {
  const rooms = parseRooms(JSON.stringify({
    rooms: [
      { id: 'r-kitchen', name: '厨房', deviceCount: 1, onlineDeviceCount: 1 },
      { id: 'r-bath', name: '卫生间', deviceCount: 1, onlineDeviceCount: 1 }
    ]
  }));
  const devices = parseDevices(JSON.stringify({
    devices: [
      deviceJson({ deviceId: 'esp32-kitchen', roomId: 'r-kitchen', roomName: '厨房' }),
      deviceJson({ deviceId: 'esp32-bath', roomId: 'r-bath', roomName: '卫浴（服务端别名）' })
    ]
  }));
  assert.ok(rooms);
  assert.ok(devices);
  const deviceViews = mapDevices(devices, NOW);
  const roomViews = mapRooms(rooms, deviceViews);
  assert.equal(roomViews.length, 2);
  const kitchen = roomViews.find((room) => room.id === 'r-kitchen');
  const bath = roomViews.find((room) => room.id === 'r-bath');
  assert.ok(kitchen);
  assert.ok(bath);
  assert.deepEqual(kitchen.devices.map((d) => d.deviceId), ['esp32-kitchen']);
  assert.deepEqual(bath.devices.map((d) => d.deviceId), ['esp32-bath'], '中文名不同也必须按 roomId 绑定');
});

test('roomId 不匹配时不得按中文房间名误绑，设备进入“未分配房间”', () => {
  const rooms = parseRooms(JSON.stringify({
    rooms: [{ id: 'r-kitchen', name: '厨房' }]
  }));
  const devices = parseDevices(JSON.stringify({
    devices: [
      // 中文名完全相同，但 roomId 不是 r-kitchen
      deviceJson({ deviceId: 'esp32-kitchen', roomId: 'r-unknown', roomName: '厨房' })
    ]
  }));
  assert.ok(rooms);
  assert.ok(devices);
  const deviceViews = mapDevices(devices, NOW);
  const roomViews = mapRooms(rooms, deviceViews);
  const kitchen = roomViews.find((room) => room.id === 'r-kitchen');
  assert.ok(kitchen);
  assert.deepEqual(kitchen.devices, [], '中文房间名相同也不得误绑');
  const synthetic = roomViews.find((room) => room.isSynthetic === true);
  assert.ok(synthetic, '未匹配 roomId 的设备应进入合成的未分配分组');
  assert.deepEqual(synthetic.devices.map((d) => d.deviceId), ['esp32-kitchen']);
});

test('rooms 为空但 devices 非空：生成未分配分组，不伪造房间名', () => {
  const rooms = parseRooms(JSON.stringify({ rooms: [] }));
  const devices = parseDevices(JSON.stringify({
    devices: [deviceJson({ deviceId: 'esp32-kitchen', roomId: 'r-kitchen' })]
  }));
  assert.ok(rooms);
  assert.ok(devices);
  const roomViews = mapRooms(rooms, mapDevices(devices, NOW));
  assert.equal(roomViews.length, 1);
  assert.equal(roomViews[0].isSynthetic, true);
  assert.equal(roomViews[0].name, '未分配房间');
});

test('devices 为空：mapDevices/mapRooms 返回空数组（空态，不 Mock）', () => {
  const devices = parseDevices(JSON.stringify({ devices: [] }));
  const rooms = parseRooms(JSON.stringify({ rooms: [] }));
  assert.ok(devices);
  assert.ok(rooms);
  assert.deepEqual(mapDevices(devices, NOW), []);
  assert.deepEqual(mapRooms(rooms, []), []);
});

// ---------------------------------------------------------------- 告警状态（ACK 状态机核心）

test('alert 状态映射：ALARM 待确认 / ackPending 等待设备确认 / ACKED 设备已确认', () => {
  const alerts = parseAlerts(JSON.stringify({
    alerts: [
      {
        alarmId: 'a-pending', deviceId: 'esp32-kitchen', roomName: '厨房', type: 'GAS',
        message: '检测到异常', state: 'ALARM', ackPending: false, createdAt: NOW - 3000,
        evidence: { available: false }
      },
      {
        alarmId: 'a-waiting', deviceId: 'esp32-kitchen', roomName: '厨房', type: 'GAS',
        message: '检测到异常', state: 'ALARM', ackPending: true, createdAt: NOW - 2000,
        evidence: { available: false }
      },
      {
        alarmId: 'a-acked', deviceId: 'dayu200-living', roomName: '客厅', type: 'FALL',
        message: '检测到异常', state: 'ACKED', ackPending: false, createdAt: NOW - 1000,
        acknowledgedAt: NOW - 500, acknowledgedBy: 'guardian',
        evidence: { available: true, evidenceId: 'ev-1', bytes: 100, capturedAt: NOW - 900 }
      }
    ]
  }));
  assert.ok(alerts);
  const views = mapAlerts(alerts);
  const byId = new Map(views.map((view) => [view.alarmId, view]));
  assert.equal(byId.get('a-pending').statusKey, 'pending');
  assert.equal(byId.get('a-pending').statusText, '待确认');
  assert.equal(byId.get('a-waiting').statusKey, 'waiting');
  assert.equal(byId.get('a-waiting').statusText, '等待设备确认');
  assert.notEqual(byId.get('a-waiting').statusKey, 'acked');
  assert.equal(byId.get('a-acked').statusKey, 'acked');
  assert.equal(byId.get('a-acked').statusText, '设备已确认');
  assert.equal(byId.get('a-acked').evidenceAvailable, true);
  assert.equal(byId.get('a-acked').evidenceId, 'ev-1');
});

test('ACK 202 之后的本地映射：同一 ALARM+ackPending=true 仍是“等待设备确认”，绝不本地变 ACKED', () => {
  const alerts = parseAlerts(JSON.stringify({
    alerts: [{
      alarmId: 'a-1', deviceId: 'esp32-bath', roomName: '卫生间', type: 'MANUAL_SOS',
      message: '检测到异常', state: 'ALARM', ackPending: true, createdAt: NOW,
      evidence: { available: false }
    }]
  }));
  assert.ok(alerts);
  const [view] = mapAlerts(alerts);
  assert.equal(view.statusKey, 'waiting');
  assert.equal(view.ackPending, true);
  assert.notEqual(view.statusKey, 'acked');
  assert.notEqual(view.statusText, '设备已确认');
});

test('未知 state：状态未知，不默认显示已确认/正常', () => {
  const alerts = parseAlerts(JSON.stringify({
    alerts: [{ alarmId: 'a-x', state: 'FUTURE_STATE', ackPending: false, createdAt: NOW }]
  }));
  const [view] = mapAlerts(alerts);
  assert.equal(view.statusKey, 'unknown');
  assert.notEqual(view.statusKey, 'acked');
  assert.notEqual(view.statusText, '设备已确认');
});

test('countNeedsAttention：待确认 + 等待设备确认计入，ACKED 不计', () => {
  const alerts = parseAlerts(JSON.stringify({
    alerts: [
      { alarmId: 'a1', state: 'ALARM', ackPending: false, createdAt: 1 },
      { alarmId: 'a2', state: 'ALARM', ackPending: true, createdAt: 2 },
      { alarmId: 'a3', state: 'ACKED', ackPending: false, createdAt: 3 }
    ]
  }));
  assert.ok(alerts);
  assert.equal(countNeedsAttention(mapAlerts(alerts)), 2);
});

test('findAlert：找不到返回 null（页面显示不存在/已失效，禁止取第一条 Mock）', () => {
  const alerts = parseAlerts(JSON.stringify({
    alerts: [{ alarmId: 'a1', state: 'ALARM', createdAt: 1 }]
  }));
  assert.ok(alerts);
  const views = mapAlerts(alerts);
  assert.ok(findAlert(views, 'a1'));
  assert.equal(findAlert(views, 'missing-alarm'), null);
});

test('mapOverview：hasData=true，latestAlert 可为 null，不编造统计', () => {
  const dto = parseOverview(JSON.stringify({
    generatedAt: NOW,
    deviceCount: 0,
    onlineCount: 0,
    monitorOfflineCount: 0,
    activeAlertCount: 0,
    latestAlert: null,
    location: { location: '客厅' }
  }));
  assert.ok(dto);
  const view = mapOverview(dto);
  assert.equal(view.hasData, true);
  assert.equal(view.latestAlert, null);
  assert.equal(view.deviceCount, 0);
  assert.equal(view.locationText, '客厅');
});

test('dayu200-living：不产生实时视频/摄像头传感器瓦片，只保留监测状态', () => {
  const view = mapDeviceJson({ deviceId: 'dayu200-living', name: '客厅主控', roomId: 'r-living', roomName: '客厅' });
  assert.equal(view.capabilityVerified, true);
  assert.equal(view.sensors.find((s) => s.kind === 'camera') || null, null, 'APP 无实时视频接口，不得渲染摄像头瓦片');
  assert.equal(view.monitorText, '视觉监测正常');
});
