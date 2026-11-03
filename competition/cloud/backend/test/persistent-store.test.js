'use strict';

/**
 * persistent-store.test.js — PersistentStore 单元测试
 *
 * 全部使用系统临时目录，测试结束后递归清理；不依赖网络、真实账号或 PowerShell。
 * 通过 `atomicWriter` 注入点模拟磁盘写入失败，验证内存回滚与“无虚假持久状态”。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PersistentStore, SCHEMA_VERSION, SNAPSHOT_KEYS } = require('../src/persistent-store');

const EXPECTED_KEYS = [...SNAPSHOT_KEYS].sort();

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deviceRecord(deviceId, state = 'ALARM', alarmId = '') {
  return {
    deviceId,
    room: '客厅',
    online: true,
    state,
    ts: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    sensors: {},
    alarm: { id: alarmId, type: 'MANUAL_SOS', countToday: alarmId ? 1 : 0 },
    gps: { valid: false, latitude: null, longitude: null, fixTime: 0 },
    csq: null
  };
}

function alertRecord(alarmId, deviceId, action = '监护人已确认') {
  return {
    alarmId,
    deviceId,
    room: '客厅',
    type: 'MANUAL_SOS',
    createdAt: 1_700_000_000_000,
    status: 'ALARM',
    ackPending: true,
    acknowledgedAt: 0,
    acknowledgedBy: '',
    action
  };
}

function commandRecord(id, deviceId, alarmId) {
  return {
    id,
    createdAt: 1_700_000_000_000,
    requestedBy: 'wx-openid',
    deviceId,
    command: 'ACK',
    alarmId,
    action: '监护人已确认',
    status: 'PENDING'
  };
}

function validDocument(overrides = {}) {
  return Object.assign({
    schemaVersion: SCHEMA_VERSION,
    savedAt: 1_700_000_000_000,
    devices: [deviceRecord('dayu200-room-1', 'ALARM', 'alarm-1')],
    alerts: [alertRecord('alarm-1', 'dayu200-room-1')],
    commands: [commandRecord('1', 'dayu200-room-1', 'alarm-1')],
    contacts: [{ id: 'contact-1', name: '子女', relation: '子女', phone: '+86 13800000000', primary: true }]
  }, overrides);
}

/* ------------------------------------------------------------ 构造与首次落盘 */

test('rejects a missing or blank filePath', () => {
  assert.throws(() => new PersistentStore({}), /filePath/);
  assert.throws(() => new PersistentStore({ filePath: '   ' }), /filePath/);
  assert.throws(() => new PersistentStore({ filePath: 42 }), /filePath/);
});

test('starts without a file, creates it on the first successful change and leaves no temp files', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const store = new PersistentStore({
    filePath,
    contacts: [{ name: '子女', phone: '+86 13800000000', primary: true }]
  });

  assert.equal(fs.existsSync(filePath), false, '构造函数不得创建文件');

  assert.throws(() => store.ingest({ deviceId: 'dev-1', state: 'BROKEN' }), /state/);
  assert.equal(fs.existsSync(filePath), false, '校验失败不得落盘');

  store.ingest({ deviceId: 'dev-1', room: '客厅', state: 'NORMAL', ts: 1_700_000_000_000 });
  assert.equal(fs.existsSync(filePath), true, '第一次成功变更后必须落盘');

  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(Object.keys(document).sort(), EXPECTED_KEYS);
  assert.equal(document.devices.length, 1);
  assert.equal(document.contacts.length, 1);
  assert.equal(document.contacts[0].phone, '+86 13800000000');

  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false, '临时文件必须被清理');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, '快照文件权限应为 0600');
  }
});

test('loads a v1 snapshot and writes the current schema with an empty evidence association on the next change', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  fs.writeFileSync(filePath, JSON.stringify(validDocument({ schemaVersion: 1 })), 'utf8');
  const store = new PersistentStore({ filePath });
  assert.equal(store.listAlerts()[0].evidenceId, '');
  assert.equal(store.listDevices()[0].monitorOnline, -1);
  store.ingest({ deviceId: 'dayu200-room-1', room: '客厅', state: 'ALARM',
    ts: 1_700_000_000_100, alarm: { id: 'alarm-1', type: 'MANUAL_SOS' } });
  const migrated = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.equal(migrated.alerts[0].evidenceId, '');
  assert.equal(migrated.devices[0].alarm.evidenceId, '');
});

/* ------------------------------------------------------------ 重启恢复 */

test('restores devices, ALARM alert and PENDING command after restart', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');

  const first = new PersistentStore({ filePath });
  first.ingest({
    deviceId: 'dayu200-room-1',
    room: '客厅',
    monitorOnline: 0,
    state: 'ALARM',
    ts: 1_700_000_000_000,
    alarm: { id: 'alarm-1', type: 'MANUAL_SOS', countToday: 1 }
  });
  const command = first.requestAck('alarm-1', '监护人已确认', 'wx-openid');
  assert.equal(command.id, '1');
  assert.equal(command.status, 'PENDING');

  const second = new PersistentStore({ filePath });
  const device = second.listDevices()[0];
  assert.equal(device.deviceId, 'dayu200-room-1');
  assert.equal(device.state, 'ALARM');
  assert.equal(device.monitorOnline, 0);
  assert.equal(device.alarm.id, 'alarm-1');

  const alert = second.listAlerts()[0];
  assert.equal(alert.state, 'ALARM');
  assert.equal(alert.ackPending, true);
  assert.equal(alert.deviceId, 'dayu200-room-1');

  const restored = second.listCommands(0);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, '1');
  assert.equal(restored[0].status, 'PENDING');
  assert.equal(restored[0].action, '监护人已确认');
  assert.equal(restored[0].requestedBy, 'wx-openid');

  // 已有 PENDING 命令：幂等复用，不新建、不产生新 ID。
  const again = second.requestAck('alarm-1', '换一条备注', 'wx-openid');
  assert.equal(again.id, '1');
  assert.equal(second.listCommands(0).length, 1);
});

test('restores an ACKED command result and keeps idempotent results stable', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');

  const first = new PersistentStore({ filePath });
  first.ingest({
    deviceId: 'dayu200-room-1',
    room: '客厅',
    monitorOnline: 0,
    state: 'ALARM',
    ts: 1_700_000_000_000,
    sensors: { motion: { countToday: 4 } },
    csq: 23,
    alarm: { id: 'alarm-1', type: 'MANUAL_SOS' }
  });
  first.requestAck('alarm-1', '确认', 'wx-openid');
  const completed = first.completeCommand('1', {
    status: 'ACKED',
    deviceState: {
      deviceId: 'dayu200-room-1',
      room: '客厅',
      online: true,
      state: 'ACKED',
      ts: 1_700_000_000_500,
      alarm: { id: 'alarm-1', type: 'MANUAL_SOS', countToday: 1 }
    }
  });
  assert.equal(completed.status, 'ACKED');

  const second = new PersistentStore({ filePath });
  const alert = second.listAlerts()[0];
  assert.equal(alert.state, 'ACKED');
  assert.equal(alert.ackPending, false);
  assert.equal(alert.acknowledgedBy, 'wx-openid');

  const command = second.listCommands(0)[0];
  assert.equal(command.status, 'ACKED');
  assert.equal(command.resultCode, '');
  assert.equal(second.listDevices()[0].state, 'ACKED');
  assert.equal(second.listDevices()[0].monitorOnline, 0, 'partial ACK receipt must preserve monitor status');
  assert.deepEqual(second.listDevices()[0].sensors, { motion: { countToday: 4 } });
  assert.equal(second.listDevices()[0].csq, 23);

  // 重复同状态回写幂等；冲突状态必须报错。
  const replay = second.completeCommand('1', {
    status: 'ACKED',
    deviceState: { deviceId: 'dayu200-room-1', state: 'ACKED', alarm: { id: 'alarm-1' } }
  });
  assert.equal(replay.status, 'ACKED');
  assert.throws(() => second.completeCommand('1', { status: 'FAILED', code: 'REPLAY_CONFLICT' }), /conflicts/);
});

test('keeps command ids monotonic across restart and around holes', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');

  // 手工播种合法快照：命令 id 为 1 和 3（历史空洞）。长度+1 会错误地复用 3。
  fs.writeFileSync(filePath, JSON.stringify(validDocument({
    devices: [deviceRecord('dev-a', 'ALARM', 'alarm-a'), deviceRecord('dev-b', 'ALARM', 'alarm-b')],
    alerts: [alertRecord('alarm-a', 'dev-a'), alertRecord('alarm-b', 'dev-b')],
    commands: [commandRecord('1', 'dev-a', 'alarm-a'), commandRecord('3', 'dev-b', 'alarm-b')]
  })), 'utf8');

  const store = new PersistentStore({ filePath });
  assert.deepEqual(store.listCommands(0).map((item) => item.id), ['1', '3']);

  store.ingest({
    deviceId: 'dev-c',
    room: '卧室',
    state: 'ALARM',
    ts: 1_700_000_000_100,
    alarm: { id: 'alarm-c', type: 'MANUAL_SOS' }
  });
  const command = store.requestAck('alarm-c', '确认', 'wx-openid');
  assert.equal(command.id, '4', '必须基于已持久化最大 ID 3 递增，而不是长度+1');

  const reloaded = new PersistentStore({ filePath });
  assert.deepEqual(reloaded.listCommands(0).map((item) => item.id), ['1', '3', '4']);
  assert.equal(reloaded.requestAck('alarm-c', '确认', 'wx-openid').id, '4');
});

/* ------------------------------------------------------------ 严格拒绝 */

test('rejects corrupt JSON, unknown schema, duplicate command ids and broken relations', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const writeState = (value) => fs.writeFileSync(
    filePath,
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8'
  );

  writeState('{ not json');
  assert.throws(() => new PersistentStore({ filePath }), /invalid JSON/);

  writeState(validDocument({ schemaVersion: SCHEMA_VERSION + 1 }));
  assert.throws(() => new PersistentStore({ filePath }), /schemaVersion/);

  writeState(validDocument({
    devices: [deviceRecord('dev-a', 'BROKEN', 'alarm-1')]
  }));
  assert.throws(() => new PersistentStore({ filePath }), /device/);

  writeState(validDocument({
    commands: [
      commandRecord('1', 'dayu200-room-1', 'alarm-1'),
      commandRecord('1', 'dayu200-room-1', 'alarm-1')
    ]
  }));
  assert.throws(() => new PersistentStore({ filePath }), /duplicate command id/);

  writeState(validDocument({
    devices: [deviceRecord('dev-a', 'ALARM', 'alarm-1'), deviceRecord('dev-b', 'ALARM', 'alarm-1')],
    alerts: [alertRecord('alarm-1', 'dev-a')],
    commands: [commandRecord('1', 'dev-b', 'alarm-1')]
  }));
  assert.throws(() => new PersistentStore({ filePath }), /binding mismatch/);

  writeState(validDocument({
    commands: [commandRecord('1', 'dayu200-room-1', 'alarm-missing')]
  }));
  assert.throws(() => new PersistentStore({ filePath }), /unknown alarm/);

  writeState(validDocument({
    alerts: [alertRecord('alarm-1', 'ghost-device')]
  }));
  assert.throws(() => new PersistentStore({ filePath }), /unknown device/);
});

/* ------------------------------------------------------------ 恢复边界 */

test('rejects unsafe command ids, out-of-order ids, unknown top-level fields and bad savedAt', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const writeState = (value) => fs.writeFileSync(
    filePath,
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8'
  );

  // 通过 1-16 位正则但不是安全整数的 ID：否则 _maxCommandId 会失效并复用 id=1。
  writeState(validDocument({
    commands: [commandRecord('9999999999999999', 'dayu200-room-1', 'alarm-1')]
  }));
  assert.throws(() => new PersistentStore({ filePath }), /safe positive integer/);

  // 乱序 ID 会破坏 listCommands 的单调契约（允许空洞 1、3，但拒绝 3、1）。
  writeState(validDocument({
    devices: [deviceRecord('dev-a', 'ALARM', 'alarm-a'), deviceRecord('dev-b', 'ALARM', 'alarm-b')],
    alerts: [alertRecord('alarm-a', 'dev-a'), alertRecord('alarm-b', 'dev-b')],
    commands: [commandRecord('3', 'dev-a', 'alarm-a'), commandRecord('1', 'dev-b', 'alarm-b')]
  }));
  assert.throws(() => new PersistentStore({ filePath }), /strictly increasing/);

  // 未知顶层字段（尤其 token/secret）不得被静默忽略。
  writeState(validDocument({ sessionToken: 'SESSION_TOKEN_MARKER' }));
  assert.throws(() => new PersistentStore({ filePath }), /unknown top-level field/);

  // savedAt 必须是非负安全整数。
  writeState(validDocument({ savedAt: -1 }));
  assert.throws(() => new PersistentStore({ filePath }), /savedAt/);
  writeState(validDocument({ savedAt: 'yesterday' }));
  assert.throws(() => new PersistentStore({ filePath }), /savedAt/);
});

test('fails fast and leaves memory and file unchanged when the command id space is exhausted', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const store = new PersistentStore({ filePath });
  store.ingest({
    deviceId: 'dev-1',
    room: '客厅',
    state: 'ALARM',
    ts: 1_700_000_000_000,
    alarm: { id: 'alarm-1', type: 'MANUAL_SOS' }
  });
  const before = fs.readFileSync(filePath, 'utf8');

  // 模拟已到最大安全整数：下一次分配必须 fail-fast，不能产生非法 ID。
  store._maxCommandId = Number.MAX_SAFE_INTEGER;
  assert.throws(() => store.requestAck('alarm-1', '确认', 'wx-openid'), /id space exhausted/);

  assert.equal(store.listCommands(0).length, 0, '不得留下半成品命令');
  assert.equal(store.listAlerts()[0].ackPending, false, 'ackPending 不得被改动');
  assert.equal(fs.readFileSync(filePath, 'utf8'), before, '文件必须保持不变');
});

/* ------------------------------------------------------------ 写失败回滚 */

test('rolls back memory and leaves no false persisted state when the atomic write fails', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  let failing = false;
  const store = new PersistentStore({
    filePath,
    atomicWriter: (target, text) => {
      if (failing) throw new Error('disk full');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
    }
  });

  store.ingest({
    deviceId: 'dev-1',
    room: '客厅',
    state: 'ALARM',
    ts: 1_700_000_000_000,
    alarm: { id: 'alarm-1', type: 'MANUAL_SOS' }
  });
  const afterIngest = fs.readFileSync(filePath, 'utf8');
  assert.equal(store.listDevices().length, 1);

  // ingest 写失败：内存回滚，文件保持原样。
  failing = true;
  assert.throws(
    () => store.ingest({ deviceId: 'dev-2', room: '卧室', state: 'NORMAL', ts: 1_700_000_000_100 }),
    /disk full/
  );
  assert.equal(store.listDevices().length, 1);
  assert.equal(store.listDevices().some((item) => item.deviceId === 'dev-2'), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), afterIngest, '写失败不得产生虚假持久状态');

  // requestAck 写失败：命令与 ackPending 都必须回滚。
  assert.throws(() => store.requestAck('alarm-1', '确认', 'wx-openid'), /disk full/);
  assert.equal(store.listCommands(0).length, 0);
  assert.equal(store.listAlerts()[0].ackPending, false, 'ackPending 必须回滚');
  assert.equal(fs.readFileSync(filePath, 'utf8'), afterIngest);

  failing = false;
  const command = store.requestAck('alarm-1', '确认', 'wx-openid');
  assert.equal(command.id, '1', '回滚后重新分配不得跳过或复用已持久化 ID');
  const afterAck = fs.readFileSync(filePath, 'utf8');

  // completeCommand 写失败：命令与告警都必须保持在 PENDING/ALARM。
  failing = true;
  assert.throws(() => store.completeCommand('1', {
    status: 'ACKED',
    deviceState: {
      deviceId: 'dev-1',
      room: '客厅',
      online: true,
      state: 'ACKED',
      ts: 1_700_000_000_200,
      alarm: { id: 'alarm-1', type: 'MANUAL_SOS', countToday: 1 }
    }
  }), /disk full/);
  assert.equal(store.listCommands(0)[0].status, 'PENDING', '完成结果失败必须回滚命令');
  assert.equal(store.listAlerts()[0].state, 'ALARM', '完成结果失败必须回滚告警');
  assert.equal(fs.readFileSync(filePath, 'utf8'), afterAck);

  // 恢复写入后可以正常完成，并能在下一次启动中读回。
  failing = false;
  const completed = store.completeCommand('1', {
    status: 'ACKED',
    deviceState: {
      deviceId: 'dev-1',
      room: '客厅',
      online: true,
      state: 'ACKED',
      ts: 1_700_000_000_200,
      alarm: { id: 'alarm-1', type: 'MANUAL_SOS', countToday: 1 }
    }
  });
  assert.equal(completed.status, 'ACKED');

  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.listCommands(0)[0].status, 'ACKED');
  assert.equal(reloaded.listAlerts()[0].state, 'ACKED');
  assert.equal(reloaded.listDevices()[0].state, 'ACKED');
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
});

/* ------------------------------------------------------------ 密钥防泄漏 */

test('never writes injected secret markers into the snapshot', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'store.json');
  const SECRETS = [
    'API_TOKEN_SECRET_MARKER_9f3a',
    'INGEST_KEY_MARKER_9f3a',
    'WECHAT_SECRET_MARKER_9f3a',
    'ONENET_KEY_MARKER_9f3a',
    'SESSION_TOKEN_MARKER_9f3a'
  ];

  const store = new PersistentStore({
    filePath,
    // 额外字段与配置对象都不得进入快照。
    contacts: [{ name: '子女', relation: '子女', phone: '+86 13800000000', primary: true, note: SECRETS[2] }],
    apiTokenSecret: SECRETS[0],
    ingestKey: SECRETS[1],
    wechat: { appId: 'wx-app-id', appSecret: SECRETS[2] },
    onenet: { apiKey: SECRETS[3] },
    sessionToken: SECRETS[4]
  });

  store.ingest({
    deviceId: 'dev-1',
    room: '客厅',
    state: 'ALARM',
    ts: 1_700_000_000_000,
    alarm: { id: 'alarm-1', type: 'MANUAL_SOS' }
  });
  store.requestAck('alarm-1', '确认', 'wx-openid');

  const text = fs.readFileSync(filePath, 'utf8');
  for (const marker of SECRETS) {
    assert.equal(text.includes(marker), false, `快照不得包含密钥标记 ${marker}`);
  }

  const document = JSON.parse(text);
  assert.deepEqual(Object.keys(document).sort(), EXPECTED_KEYS);
  assert.equal(Object.prototype.hasOwnProperty.call(document, 'sessionToken'), false);
  assert.equal(document.contacts.length, 1);
  assert.deepEqual(Object.keys(document.contacts[0]).sort(), ['id', 'name', 'phone', 'primary', 'relation']);
});
