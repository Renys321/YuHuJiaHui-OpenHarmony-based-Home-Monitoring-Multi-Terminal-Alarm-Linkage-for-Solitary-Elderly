/**
 * 合同解析测试（实际 core/api/Contracts.ts 编译产物）。
 *
 * 输入是手写的“模拟 API JSON”，不是真实公网响应；只验证解析健壮性与字段语义。
 * 合同：competition/docs/APP-API-v1.md；规则：忽略未知字段、缺失给默认值、类型错误不抛崩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './fake-transport.mjs';

const {
  parseLogin,
  parseOverview,
  parseRooms,
  parseDevices,
  parseAlerts,
  parseContacts,
  parseAck,
  parseErrorCode
} = loadCore('api/Contracts.js');

const SIMULATED_LOGIN = JSON.stringify({
  sessionToken: 'fake-token-000',
  tokenType: 'Bearer',
  expiresIn: 7200
});

test('parseLogin: 解析 sessionToken/tokenType/expiresIn（SIMULATED 响应）', () => {
  const dto = parseLogin(SIMULATED_LOGIN);
  assert.ok(dto);
  assert.equal(dto.sessionToken, 'fake-token-000');
  assert.equal(dto.tokenType, 'Bearer');
  assert.equal(dto.expiresIn, 7200);
});

test('parseLogin: 缺 token 或非法 JSON / 非对象 返回 null，不抛异常', () => {
  assert.equal(parseLogin(''), null);
  assert.equal(parseLogin('not-json'), null);
  assert.equal(parseLogin('[]'), null);
  assert.equal(parseLogin(JSON.stringify({ tokenType: 'Bearer' })), null);
});

test('parseLogin: 未知新增字段被忽略，缺失 tokenType/expiresIn 给安全默认值', () => {
  const dto = parseLogin(JSON.stringify({
    sessionToken: 'fake-token-000',
    tokenType: 'Bearer',
    expiresIn: 7200,
    futureField: { nested: true },
    scope: 'read'
  }));
  assert.ok(dto);
  assert.equal(dto.sessionToken, 'fake-token-000');
  assert.equal(dto.expiresIn, 7200);

  const minimal = parseLogin(JSON.stringify({ sessionToken: 'fake-token-000' }));
  assert.ok(minimal);
  assert.equal(minimal.tokenType, 'Bearer');
  assert.equal(minimal.expiresIn, 7200);
});

test('parseOverview: 解析统计字段与 latestAlert（SIMULATED 响应）', () => {
  const dto = parseOverview(JSON.stringify({
    generatedAt: 1730000000000,
    deviceCount: 3,
    onlineCount: 2,
    monitorOfflineCount: 1,
    activeAlertCount: 1,
    latestAlert: {
      alarmId: 'alarm-1',
      deviceId: 'esp32-kitchen',
      roomName: '厨房',
      type: 'GAS',
      message: '检测到异常',
      state: 'ALARM',
      ackPending: false,
      createdAt: 1730000000000,
      acknowledgedAt: 0,
      acknowledgedBy: '',
      evidence: { available: false }
    },
    location: { location: '客厅' },
    unknownMetric: 42
  }));
  assert.ok(dto);
  assert.equal(dto.deviceCount, 3);
  assert.equal(dto.onlineCount, 2);
  assert.equal(dto.monitorOfflineCount, 1);
  assert.equal(dto.activeAlertCount, 1);
  assert.equal(dto.locationText, '客厅');
  assert.ok(dto.latestAlert);
  assert.equal(dto.latestAlert.alarmId, 'alarm-1');
  assert.equal(dto.latestAlert.state, 'ALARM');
});

test('parseOverview: latestAlert 缺失/非法时保持 null（空首页不崩）', () => {
  const dto = parseOverview(JSON.stringify({ deviceCount: 0, unknown: 'x' }));
  assert.ok(dto);
  assert.equal(dto.latestAlert, null);
  assert.equal(dto.deviceCount, 0);
  assert.equal(parseOverview('broken'), null);
});

test('parseRooms / parseDevices / parseAlerts: 空列表返回空数组（空态，不 Mock）', () => {
  assert.deepEqual(parseRooms(JSON.stringify({ rooms: [] })), []);
  assert.deepEqual(parseDevices(JSON.stringify({ devices: [] })), []);
  assert.deepEqual(parseAlerts(JSON.stringify({ alerts: [] })), []);
});

test('parseRooms / parseDevices / parseAlerts: 缺列表字段或非法 JSON 返回 null', () => {
  assert.equal(parseRooms(JSON.stringify({})), null);
  assert.equal(parseDevices(JSON.stringify({ devices: 'nope' })), null);
  assert.equal(parseAlerts(JSON.stringify({ alerts: null })), null);
  assert.equal(parseAlerts('{'), null);
});

test('parseDevices: 未知 device 字段被忽略；缺失字段给默认值；类型错误不崩', () => {
  const devices = parseDevices(JSON.stringify({
    devices: [
      {
        id: 'd1',
        deviceId: 'esp32-kitchen',
        name: '厨房节点',
        roomId: 'r1',
        roomName: '厨房',
        location: '',
        online: true,
        monitorOnline: 1,
        state: 'NORMAL',
        lastSeenTs: 1730000000000,
        csq: 25,
        futureRssi: -50,
        sensors: {
          climate: { tempC: 24.5, rh: 55, ok: true },
          gas: { raw: 780, ok: true },
          co2: { value: 400 }
        }
      },
      {
        id: 'd2',
        deviceId: 'esp32-bath',
        // 故意缺 roomId/online/lastSeenTs，且 monitorOnline 类型错误
        monitorOnline: 'oops',
        sensors: 'not-an-object'
      }
    ]
  }));
  assert.ok(devices);
  assert.equal(devices.length, 2);
  const first = devices[0];
  assert.equal(first.deviceId, 'esp32-kitchen');
  assert.equal(first.csq, 25);
  assert.equal(first.sensors.climate.tempC, 24.5);
  assert.equal(first.sensors.gas.raw, 780);
  assert.deepEqual(first.sensors.unknownKeys, ['co2'], '未知 sensors 字段只记录不崩');

  const second = devices[1];
  assert.equal(second.roomId, '');
  assert.equal(second.online, false);
  assert.equal(second.monitorOnline, -1, '非法 monitorOnline 归为未知 -1');
  assert.equal(second.sensors.climate, null);
  assert.equal(second.csq, -1);
});

test('parseDevices: csq 99 / 越界 / 字符串 归为 -1 未知', () => {
  const devices = parseDevices(JSON.stringify({
    devices: [
      { deviceId: 'a', csq: 99 },
      { deviceId: 'b', csq: 32 },
      { deviceId: 'c', csq: '20' }
    ]
  }));
  assert.deepEqual(devices.map((d) => d.csq), [-1, -1, -1]);
});

test('parseAlerts: ACKED 状态、ackPending 与 evidence 元数据', () => {
  const alerts = parseAlerts(JSON.stringify({
    alerts: [
      {
        id: 'alarm-9',
        alarmId: 'alarm-9',
        deviceId: 'dayu200-living',
        roomName: '客厅',
        type: 'FALL',
        message: '检测到异常',
        state: 'ACKED',
        ackPending: false,
        createdAt: 1730000000000,
        acknowledgedAt: 1730000005000,
        acknowledgedBy: 'guardian',
        evidence: { available: true, evidenceId: 'ev-1', bytes: 12345, capturedAt: 1730000001000 },
        unknownState: 'future'
      },
      {
        alarmId: 'alarm-10',
        state: 'ALARM',
        ackPending: true,
        evidence: { available: false }
      }
    ]
  }));
  assert.ok(alerts);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].state, 'ACKED');
  assert.equal(alerts[0].ackPending, false);
  assert.equal(alerts[0].acknowledgedAt, 1730000005000);
  assert.equal(alerts[0].evidence.available, true);
  assert.equal(alerts[0].evidence.evidenceId, 'ev-1');
  assert.equal(alerts[0].evidence.bytes, 12345);

  assert.equal(alerts[1].alarmId, 'alarm-10');
  assert.equal(alerts[1].state, 'ALARM');
  assert.equal(alerts[1].ackPending, true);
  assert.equal(alerts[1].evidence.available, false);
});

test('parseAck: accepted=true 解析 status/commandId；false 或缺失返回 null', () => {
  const dto = parseAck(JSON.stringify({
    accepted: true,
    status: 'PENDING',
    commandId: 'cmd-1',
    extra: 'ignored'
  }));
  assert.ok(dto);
  assert.equal(dto.accepted, true);
  assert.equal(dto.status, 'PENDING');
  assert.equal(dto.commandId, 'cmd-1');

  assert.equal(parseAck(JSON.stringify({ accepted: false })), null);
  assert.equal(parseAck(JSON.stringify({})), null);
  assert.equal(parseAck('nope'), null);
});

test('parseRooms: Room.devices 内嵌设备解析，roomId 与 room.id 可校验一致', () => {
  const rooms = parseRooms(JSON.stringify({
    rooms: [{
      id: 'r-kitchen',
      name: '厨房',
      location: '1F',
      state: 'NORMAL',
      onlineDeviceCount: 1,
      deviceCount: 1,
      devices: [{
        id: 'esp32-kitchen',
        deviceId: 'esp32-kitchen',
        name: '厨房节点',
        roomId: 'r-kitchen',
        roomName: '厨房',
        online: true,
        monitorOnline: 1,
        sensors: { gas: { raw: 100 } }
      }]
    }]
  }));
  assert.ok(rooms);
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].id, 'r-kitchen');
  assert.equal(rooms[0].devices.length, 1);
  assert.equal(rooms[0].devices[0].roomId, rooms[0].id, 'Room.devices[].roomId 应与 Room.id 一致');
});

test('parseContacts: 列表解析与未知字段忽略', () => {
  const contacts = parseContacts(JSON.stringify({
    contacts: [
      { id: 'c1', name: '张三', relation: '女儿', phone: '10000000000', primary: true, extra: 1 }
    ]
  }));
  assert.ok(contacts);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].name, '张三');
  assert.equal(contacts[0].primary, true);
});

test('parseErrorCode: 只作为安全排障短码，不参与业务判断', () => {
  assert.equal(parseErrorCode(JSON.stringify({ error: 'invalid credentials' })), 'invalid credentials');
  assert.equal(parseErrorCode('bad'), '');
});
