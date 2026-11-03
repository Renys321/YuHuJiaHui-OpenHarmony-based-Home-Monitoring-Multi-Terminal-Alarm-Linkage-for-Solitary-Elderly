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
  mapDevices, mapRooms, mapAlerts, mapOverview, countNeedsAttention, findAlert, mapDoorEvents,
  splitDevices
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

test('kitchen 的 PIR/门磁已装：下发 motion/door 展示真实瓦片；水漏仍未安装不展示', () => {
  const view = mapDeviceJson({
    deviceId: 'esp32-kitchen',
    sensors: {
      motion: { lastActiveTs: NOW - 1000, countToday: 3 },
      door: { open: true, lastOpenTs: NOW - 1000 },
      water: { wet: true }
    }
  });
  assert.ok(sensorOf(view, 'motion'), '厨房 PIR 已于 2026-10-27 在板，应展示 motion 瓦片');
  assert.ok(sensorOf(view, 'door'), '厨房门磁已于 2026-10-27 在板，应展示 door 瓦片');
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

test('未知 deviceId：不纳入家庭监护，字段存在也不生成传感器/不显示“正常”', () => {
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
  assert.equal(view.deviceClass, 'unrecognized');
  assert.match(view.capabilitySummary, /未纳入监护/);
  assert.match(view.capabilityNote, /不在家庭设备清单/);
  // 未纳入监护的后端记录不生成传感器瓦片，避免把测试/历史数据伪装成家庭传感器。
  assert.equal(view.sensors.length, 0);
  // 拆分后未识别设备不进入受监护清单。
  const split = splitDevices([view]);
  assert.equal(split.household.length, 0);
  assert.equal(split.unrecognized.length, 1);
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

test('dayu200-living：无 PIR，不生成 PIR 活动语义；摄像头判定独立展示且无实时画面', () => {
  const view = mapDeviceJson({ deviceId: 'dayu200-living', name: '客厅主控', roomId: 'r-living', roomName: '客厅' });
  assert.equal(view.capabilityVerified, true);
  const pir = view.sensors.find((s) => s.kind === 'motion') || null;
  assert.ok(pir, '客厅必须明确展示“未配置 PIR”瓦片');
  assert.equal(pir.state, 'unsupported');
  assert.equal(pir.valueText, '未配置 PIR，无活动监测');
  assert.match(pir.detailText, /摄像头判定/);
  assert.doesNotMatch(pir.valueText + pir.detailText, /NO_MOTION|长时间无活动/,
    '客厅无 PIR，不得出现 PIR 活动/NO_MOTION 语义');
  const camera = view.sensors.find((s) => s.kind === 'camera') || null;
  assert.ok(camera, '摄像头人体判定必须独立展示');
  assert.equal(camera.installed, true);
  assert.doesNotMatch(camera.detailText, /正在直播|实时画面 ·|可观看/);
  assert.match(camera.detailText, /非 PIR/);
  assert.equal(view.monitorText, '视觉监测正常');
});

test('dayu200-living：摄像头判定只有视觉监测正常且收到检测字段时才描述检测结果', () => {
  const detected = mapDeviceJson({
    deviceId: 'dayu200-living', name: '客厅主控', roomId: 'r-living', roomName: '客厅',
    monitorOnline: 1,
    sensors: { motion: { lastActiveTs: NOW - 30 * 1000, countToday: 3 } }
  });
  const cameraDetected = detected.sensors.find((s) => s.kind === 'camera');
  assert.ok(cameraDetected);
  assert.match(cameraDetected.valueText, /最近检测到人体/);
  assert.match(cameraDetected.detailText, /今日检测 3 次/);
  assert.match(cameraDetected.detailText, /非 PIR/);

  const noneToday = mapDeviceJson({
    deviceId: 'dayu200-living', name: '客厅主控', roomId: 'r-living', roomName: '客厅',
    monitorOnline: 1,
    sensors: { motion: { lastActiveTs: 0, countToday: 0 } }
  });
  const cameraNone = noneToday.sensors.find((s) => s.kind === 'camera');
  assert.ok(cameraNone);
  assert.equal(cameraNone.valueText, '今日未检测到人体', '视觉监测正常 + 0 次 = 有效推理下的未检测到人体');
  assert.doesNotMatch(cameraNone.valueText + cameraNone.detailText, /长时间无活动|NO_MOTION/);

  const monitorDown = mapDeviceJson({
    deviceId: 'dayu200-living', name: '客厅主控', roomId: 'r-living', roomName: '客厅',
    monitorOnline: 0, monitorReason: 'camera_stale',
    sensors: { motion: { lastActiveTs: NOW - 30 * 1000, countToday: 3 } }
  });
  const cameraDown = monitorDown.sensors.find((s) => s.kind === 'camera');
  assert.ok(cameraDown);
  assert.equal(cameraDown.valueText, '暂无有效检测数据', '监测异常时不得把历史检测当当前结果');
  assert.match(cameraDown.detailText, /监测异常/);
  assert.match(cameraDown.detailText, /检测结果过期/);

  const monitorUnknown = mapDeviceJson({
    deviceId: 'dayu200-living', name: '客厅主控', roomId: 'r-living', roomName: '客厅',
    monitorOnline: -1, sensors: { motion: { lastActiveTs: NOW - 30 * 1000, countToday: 3 } }
  });
  const cameraUnknown = monitorUnknown.sensors.find((s) => s.kind === 'camera');
  assert.ok(cameraUnknown);
  assert.equal(cameraUnknown.valueText, '暂无有效检测数据', '监测状态未知时不得描述检测到/未检测到人体');
});


test('mapDoorEvents：打开/关闭/时间来源/未知语义（occurredAt=0 不得显示为有效时间）', () => {
  const views = mapDoorEvents([
    {
      eventId: 'dr-3', deviceId: 'esp32-door', roomName: '入户门', open: true, openPresent: true,
      occurredAt: NOW - 1000, timeSource: 'device', seq: 3
    },
    {
      eventId: 'dr-2', deviceId: 'esp32-door', roomName: '入户门', open: false, openPresent: true,
      occurredAt: NOW - 2000, timeSource: 'server', seq: 2
    },
    {
      eventId: 'dr-1', deviceId: 'esp32-door', roomName: '入户门', open: true, openPresent: false,
      occurredAt: 0, timeSource: 'server', seq: 1
    }
  ], NOW);
  assert.equal(views.length, 3);
  assert.equal(views[0].actionText, '打开', 'open=true → 打开');
  assert.equal(views[0].timeSourceText, '设备时间');
  assert.match(views[0].timeText, /设备时间/);
  assert.equal(views[0].hasValidOccurredAt, true);
  assert.equal(views[1].actionText, '关闭', 'open=false → 关闭');
  assert.equal(views[1].timeSourceText, '服务器时间');
  assert.equal(views[1].hasValidOccurredAt, true);
  assert.equal(views[2].actionText, '状态未知', 'openPresent=false → 状态未知，不显示为打开/关闭');
  assert.equal(views[2].timeText, '时间未知', 'occurredAt=0 不得当作有效时间');
  assert.equal(views[2].hasValidOccurredAt, false);
});

test('mapDoorEvents：空事件列表返回空数组（页面显示"暂无开关记录"，不伪造）', () => {
  assert.equal(mapDoorEvents([], NOW).length, 0);
});

test('dayu200-living 未接线的占位传感器不再生成“待确认”瓦片，且无 PIR 文案明确', () => {
  const view = mapDeviceJson({
    deviceId: 'dayu200-living', name: '客厅主控', roomId: 'r-living', roomName: '客厅',
    sensors: {
      climate: { tempC: 0, rh: 0, ok: true },
      door: { open: false, lastOpenTs: 0 },
      gas: { raw: 0, ok: true },
      smoke: { raw: 0, ok: true },
      motion: { lastActiveTs: NOW - 1000, countToday: 0 }
    }
  });
  assert.equal(view.capabilityVerified, true);
  for (const kind of ['climate', 'door', 'gas', 'smoke', 'water']) {
    assert.equal(view.sensors.find((s) => s.kind === kind) || null, null,
      `${kind} 物理未接线，不得把兼容占位字段显示成待确认瓦片`);
  }
  const pir = view.sensors.find((s) => s.kind === 'motion');
  assert.ok(pir, '客厅必须明确“未配置 PIR”');
  assert.equal(pir.state, 'unsupported');
  assert.equal(pir.valueText, '未配置 PIR，无活动监测');
  const camera = view.sensors.find((s) => s.kind === 'camera');
  assert.ok(camera, '客厅人员检测来自摄像头判定，应独立保留检测瓦片');
  assert.match(camera.valueText, /最近检测到人体|今日检测/);
  assert.match(view.capabilityNote, /未安装\/未启用/);
  assert.match(view.capabilityNote, /PIR/);
  assert.match(view.capabilityNote, /未配置/);
  assert.doesNotMatch(view.capabilityNote, /待确认/);
});

test('状态声明 supported=false（homemon 契约）：PIR 瓦片显示“未配置 PIR，无活动监测”', () => {
  const kitchen = mapDeviceJson({
    deviceId: 'esp32-kitchen',
    sensors: { motion: { lastActiveTs: NOW - 1000, countToday: 3, supported: false, reported: false, reason: 'PIR_DISABLED' } }
  });
  const motion = sensorOf(kitchen, 'motion');
  assert.ok(motion);
  assert.equal(motion.state, 'unsupported');
  assert.equal(motion.valueText, '未配置 PIR，无活动监测');
  assert.match(motion.detailText, /PIR_DISABLED/);
  assert.doesNotMatch(motion.detailText, /NO_MOTION/);
});

test('状态声明 reported=false（homemon 契约）：PIR 显示“暂无有效 PIR 数据”，不当 0 次活动', () => {
  const bath = mapDeviceJson({
    deviceId: 'esp32-bath',
    sensors: { motion: { lastActiveTs: 0, countToday: 0, supported: true, reported: false, reason: 'NO_PIR_SAMPLE' } }
  });
  const motion = sensorOf(bath, 'motion');
  assert.ok(motion);
  assert.equal(motion.stateText, '暂无数据');
  assert.equal(motion.valueText, '暂无有效 PIR 数据');
  assert.match(motion.detailText, /NO_PIR_SAMPLE/);
  assert.doesNotMatch(motion.valueText, /0 次/);
});

test('旧数据没有 supported/reported 字段：保持原有 PIR 行为（不因缺字段改变语义）', () => {
  const bath = mapDeviceJson({
    deviceId: 'esp32-bath',
    sensors: { motion: { lastActiveTs: NOW - 60000, countToday: 4 } }
  });
  const motion = sensorOf(bath, 'motion');
  assert.ok(motion);
  assert.equal(motion.state, 'ok');
  assert.match(motion.valueText, /最近活动/);
  assert.match(motion.detailText, /NO_MOTION/);
});

test('PIR lastActiveTs=0 表示从未检测到活动；不再显示含糊的“今日暂无活动时间”', () => {
  const bath = mapDeviceJson({
    deviceId: 'esp32-bath',
    sensors: { motion: { lastActiveTs: 0, countToday: 0, supported: true } }
  });
  const motion = sensorOf(bath, 'motion');
  assert.ok(motion);
  assert.equal(motion.valueText, '从未检测到活动');
});

test('PIR 数据自相矛盾（lastActiveTs=0 但今日计数>0）：不得显示“从未检测到活动”', () => {
  const bath = mapDeviceJson({
    deviceId: 'esp32-bath',
    sensors: { motion: { lastActiveTs: 0, countToday: 2, supported: true } }
  });
  const motion = sensorOf(bath, 'motion');
  assert.ok(motion);
  assert.doesNotMatch(motion.valueText, /从未检测到活动/);
  assert.match(motion.valueText, /今日 2 次/);
  assert.match(motion.detailText, /未收到最近活动时间|最近活动时间未知/);
});


test('离线时“未配置 PIR”瓦片保持明确文案，不被改写为“离线·暂无数据”', () => {
  const viewing = mapDeviceJson({
    deviceId: 'dayu200-living', name: '客厅主控', roomId: 'r-living', roomName: '客厅',
    online: true, lastSeenTs: NOW - 6 * 60 * 60 * 1000, monitorOnline: 1,
    sensors: { motion: { lastActiveTs: NOW - 6 * 60 * 60 * 1000, countToday: 3 } }
  });
  assert.equal(viewing.online, false, '超过 90s 无新数据即判离线');
  const pir = viewing.sensors.find((s) => s.kind === 'motion');
  assert.ok(pir);
  assert.equal(pir.state, 'unsupported');
  assert.equal(pir.valueText, '未配置 PIR，无活动监测');
  const camera = viewing.sensors.find((s) => s.kind === 'camera');
  assert.ok(camera);
  assert.equal(camera.state, 'offline');
  assert.match(camera.valueText, /上次读数/);
  assert.match(camera.detailText, /设备离线/);
});

// ------------------------------------------------ NO_MOTION / 摄像头告警语义

function alertOf(overrides) {
  const alerts = parseAlerts(JSON.stringify({
    alerts: [{
      alarmId: 'a-1', deviceId: 'esp32-bath', roomName: '卫生间', type: 'NO_MOTION',
      message: '长时间无活动', state: 'ALARM', ackPending: false, createdAt: NOW - 60000,
      ...overrides
    }]
  }));
  assert.ok(alerts);
  const views = mapAlerts(alerts);
  assert.equal(views.length, 1);
  return views[0];
}

test('客厅 dayu200-living 的 NO_MOTION 告警：不得直接显示“长时间无活动”，必须标来源需核实', () => {
  const alert = alertOf({
    deviceId: 'dayu200-living', roomName: '客厅', alarmId: 'a-living-nomotion'
  });
  assert.equal(alert.title, '无活动告警（未配置 PIR，来源需核实）');
  assert.doesNotMatch(alert.title, /检测到跌倒|疑似跌倒/);
  assert.match(alert.capabilityWarning, /未配置 PIR/);
  assert.match(alert.capabilityWarning, /摄像头判定/);
});

test('厨房/卫生间 PIR 的 NO_MOTION 告警保持原语义（真实能力，不误报能力不符）', () => {
  for (const deviceId of ['esp32-bath', 'esp32-kitchen']) {
    const alert = alertOf({ deviceId });
    assert.equal(alert.title, '长时间无活动', `${deviceId} 的 PIR 无活动是真实能力`);
    assert.equal(alert.capabilityWarning, '');
  }
});

test('FALL 告警按跌倒能力核对（客厅已核实），不因 NO_MOTION 的 PIR 语义误报', () => {
  const alert = alertOf({ type: 'FALL', deviceId: 'dayu200-living', roomName: '客厅' });
  assert.equal(alert.title, '检测到跌倒');
  assert.equal(alert.capabilityWarning, '', '客厅摄像头跌倒判定已核实，不应提示能力不符');
});


