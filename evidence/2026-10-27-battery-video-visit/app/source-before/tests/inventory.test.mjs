/**
 * 家庭设备清单 / 电量能力 / 后端记录隔离测试（实际 core 编译产物）。
 *
 * 目的：证明"APP 只监护已核实设备"这一真实语义：
 * - 家庭设备清单固定为 4 台（厨房/卫生间/客厅/随身求助），不随生产后端测试记录扩张；
 * - 后端测试/历史设备（如“隔离测试节点”）被单独隔离，不生成传感器、不计入统计；
 * - 电量：没有任何板卡接入真实采样，所有设备只能得到“未接入电量检测”，绝不出现百分比；
 * - PIR 等能力文案与真实设备一致（厨房无 PIR）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './fake-transport.mjs';

const {
  householdInventory, inventoryEntryFor, isHouseholdDevice, verifiedNameFor,
  inventorySourceFor, batteryCapabilityFor, unrecognizedReasonFor, inventoryScopeText,
  BatteryState
} = loadCore('inventory/DeviceInventory.js');
const { parseDevices } = loadCore('api/Contracts.js');
const { mapDevices, splitDevices, householdRooms } = loadCore('view/ViewMapper.js');

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

function deviceOf(overrides) {
  const parsed = parseDevices(JSON.stringify({ devices: [deviceJson(overrides)] }));
  assert.ok(parsed);
  const views = mapDevices(parsed, NOW);
  assert.equal(views.length, 1);
  return views[0];
}

test('家庭设备清单：恰好 4 台已核实设备，来源可追溯', () => {
  const ids = householdInventory().map((entry) => entry.deviceId).sort();
  assert.deepEqual(ids, ['dayu200-living', 'esp32-bath', 'esp32-kitchen', 'esp32-sos']);
  for (const entry of householdInventory()) {
    assert.ok(entry.displayName.length > 0);
    assert.ok(entry.source.length > 0, `${entry.deviceId} 必须有真实来源说明`);
    assert.equal(isHouseholdDevice(entry.deviceId), true);
  }
  assert.equal(isHouseholdDevice('esp32-test-lab'), false);
  assert.equal(inventoryEntryFor('esp32-test-lab'), null);
  assert.match(inventoryScopeText(), /厨房/);
  assert.match(inventoryScopeText(), /随身求助/);
  assert.match(inventoryScopeText(), /不计入/);
});

test('已核实设备名以台账为准，不被后端房间名/测试名覆盖', () => {
  const kitchen = deviceOf({ name: '隔离测试节点', roomName: '隔离测试' });
  assert.equal(kitchen.name, '厨房节点');
  assert.equal(kitchen.deviceClass, 'household');
  assert.match(kitchen.inventorySource, /交接|固件/);
  assert.equal(verifiedNameFor('esp32-kitchen'), '厨房节点');
  assert.equal(inventorySourceFor('esp32-kitchen').length > 0, true);
});

test('后端测试/历史设备被隔离：不生成传感器、不进房间、不计入监护', () => {
  const testNode = deviceOf({
    deviceId: 'esp32-test-lab',
    name: '隔离测试节点',
    roomId: 'room-isolation',
    roomName: '隔离测试',
    sensors: { motion: { lastActiveTs: NOW - 1000, countToday: 3 }, climate: { tempC: 26, rh: 40 } }
  });
  assert.equal(testNode.deviceClass, 'unrecognized');
  assert.equal(testNode.sensors.length, 0, '未纳入监护的设备不得生成传感器瓦片');
  assert.match(testNode.capabilitySummary, /未纳入监护/);
  assert.match(testNode.capabilityNote, /不在家庭设备清单/);
  assert.equal(testNode.roomAssigned, true);

  const kitchen = deviceOf({});
  const split = splitDevices([kitchen, testNode]);
  assert.equal(split.household.length, 1);
  assert.equal(split.unrecognized.length, 1);

  const rooms = [
    { id: 'room-kitchen', name: '厨房', location: '', state: 'NORMAL', onlineDeviceCount: 1, deviceCount: 1, devices: [] },
    { id: 'room-isolation', name: '隔离测试', location: '', state: 'OFFLINE', onlineDeviceCount: 0, deviceCount: 1, devices: [] }
  ];
  const kept = householdRooms(rooms, split.household);
  assert.deepEqual(kept.map((room) => room.id), ['room-kitchen']);
});

test('电量：所有已核实设备都只能得到“未接入电量检测”，没有百分比', () => {
  for (const entry of householdInventory()) {
    const battery = batteryCapabilityFor(entry.deviceId);
    assert.equal(battery.supported, false, `${entry.deviceId} 不得声明支持电量`);
    assert.equal(battery.state, BatteryState.NOT_SUPPORTED);
    assert.match(battery.stateText, /未接入电量检测/);
    assert.doesNotMatch(battery.stateText, /%/);
    assert.doesNotMatch(battery.detail, /%/);
    assert.ok(battery.detail.length > 0, '必须说明为什么没有电量');
  }
  // 未登记设备同样不得出现电量百分比。
  const unknown = batteryCapabilityFor('esp32-test-lab');
  assert.equal(unknown.supported, false);
  assert.match(unknown.stateText, /未接入电量检测/);
});

test('设备视图携带电量真实语义，且不会出现百分比字段', () => {
  for (const deviceId of ['esp32-kitchen', 'esp32-bath', 'dayu200-living', 'esp32-sos']) {
    const view = deviceOf({ deviceId, roomName: '任意房间' });
    assert.equal(view.batterySupported, false);
    assert.equal(view.batteryState, 'not-supported');
    assert.match(view.batteryStateText, /未接入电量检测/);
    assert.doesNotMatch(view.batteryStateText, /%/);
    assert.equal(typeof view.batteryDetail, 'string');
  }
});

test('未识别原因：如实说明后端仍有记录、不计入统计，不伪造删除', () => {
  const text = unrecognizedReasonFor('esp32-test-lab', '隔离测试');
  assert.match(text, /后端仍有该设备/);
  assert.match(text, /隔离测试/);
  assert.match(text, /计入在线统计/);
  assert.match(text, /不作为告警判读依据/);
});

test('未分配房间：不伪造默认房间，roomAssigned=false', () => {
  const view = deviceOf({ deviceId: 'esp32-bath', roomId: '', roomName: '' });
  assert.equal(view.roomAssigned, false);
  assert.equal(view.roomName, '');
});

test('离线/无历史读数语义仍保留：离线不显示正常', () => {
  const offline = deviceOf({
    deviceId: 'esp32-bath', online: false, lastSeenTs: NOW - 10 * 60 * 1000,
    sensors: { motion: { lastActiveTs: NOW - 20 * 60 * 1000, countToday: 0 } }
  });
  assert.equal(offline.online, false);
  for (const sensor of offline.sensors) {
    assert.equal(sensor.state, 'offline');
    assert.match(sensor.stateText, /离线/);
  }
});
