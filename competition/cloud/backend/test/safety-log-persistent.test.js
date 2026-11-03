'use strict';

/**
 * safety-log-persistent.test.js — 安全日志（schema v6）持久化 / 迁移 / 回滚测试
 *
 * 覆盖：
 *   - v1..v5 快照加载后 safetyLogs 为空，下一次成功变更写 v6；
 *   - 处置记录跨重启可查、dispositionId 单调不复用（含历史空洞）；
 *   - 幂等重放不写盘、冲突 409 语义不覆盖既有记录；
 *   - 损坏快照（重复 ID / 乱序 / 未知告警 / 设备不匹配 / 未知字段 / OUTER 空说明）fail-fast；
 *   - 写盘失败回滚内存（含 ID 分配），不产生虚假持久状态；
 *   - 容量上限 2000，按写入顺序淘汰最旧；
 *   - 处置台账与 ACK 命令/告警状态完全独立。
 *
 * 全部使用系统临时目录；不访问网络、不操作设备、不 ACK 任何既有告警。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PersistentStore, SCHEMA_VERSION, SNAPSHOT_KEYS } = require('../src/persistent-store');
const { SAFETY_LOG_FIELDS, SAFETY_LOG_CAP, DISPOSITION_ACTOR } = require('../src/safety-log');

const DEVICE = 'dayu200-room-1';
const ALARM = 'alarm-1';

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-log-persistent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeDocument(filePath, document) {
  fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
}

function readDocument(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function deviceRecord(deviceId = DEVICE, state = 'ALARM', alarmId = ALARM) {
  return {
    deviceId,
    room: '厨房',
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

function alertRecord(alarmId = ALARM, deviceId = DEVICE) {
  return {
    alarmId,
    deviceId,
    room: '厨房',
    type: 'MANUAL_SOS',
    createdAt: 1_700_000_000_000,
    status: 'ALARM',
    ackPending: false,
    acknowledgedAt: 0,
    acknowledgedBy: '',
    action: '',
    evidenceId: ''
  };
}

function safetyLogRecord(dispositionId, overrides = {}) {
  const numeric = Number(String(dispositionId).replace(/^dsp-/, ''));
  return {
    dispositionId,
    clientDispositionId: `disp-seed-${String(numeric).padStart(8, '0')}`,
    alarmId: ALARM,
    deviceId: DEVICE,
    room: '厨房',
    type: 'MANUAL_SOS',
    outcome: 'CONTACTED_FAMILY',
    note: '已联系家属',
    actor: DISPOSITION_ACTOR,
    serverTime: 1_700_000_000_000 + numeric,
    ...overrides
  };
}

function baseDocument(schemaVersion = SCHEMA_VERSION, extra = {}) {
  return Object.assign({
    schemaVersion,
    savedAt: 1_700_000_000_000,
    devices: [deviceRecord()],
    alerts: [alertRecord()],
    commands: [],
    contacts: []
  }, extra);
}

function dispositionInput(overrides = {}) {
  return {
    alarmId: ALARM,
    clientDispositionId: 'disp-store-0001',
    outcome: 'CONTACTED_FAMILY',
    note: '已联系家属，老人安全',
    ...overrides
  };
}

/* ------------------------------------------------------------ v5 -> v6 迁移 */

test('a v5 snapshot loads with an empty safety ledger and writes schema v6 on the first disposition', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  writeDocument(filePath, baseDocument(5));

  const store = new PersistentStore({ filePath });
  assert.deepEqual(store.listSafetyLogs(), [], 'v5 没有 safetyLogs 键 -> 空台账');
  assert.deepEqual(store.listDispositions(ALARM), []);
  assert.equal(store.getDisposition('dsp-1'), null);

  const result = store.createDisposition(dispositionInput(), 1_700_000_100_000);
  assert.equal(result.created, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.conflict, false);
  assert.equal(result.disposition.dispositionId, 'dsp-1');

  const document = readDocument(filePath);
  assert.equal(document.schemaVersion, SCHEMA_VERSION, '必须升级到 v6');
  assert.deepEqual(Object.keys(document).sort(), [...SNAPSHOT_KEYS].sort());
  assert.equal(document.safetyLogs.length, 1);
  assert.deepEqual(Object.keys(document.safetyLogs[0]).sort(), [...SAFETY_LOG_FIELDS].sort());
  assert.deepEqual(document.safetyLogs[0], {
    dispositionId: 'dsp-1',
    clientDispositionId: 'disp-store-0001',
    alarmId: ALARM,
    deviceId: DEVICE,
    room: '厨房',
    type: 'MANUAL_SOS',
    outcome: 'CONTACTED_FAMILY',
    note: '已联系家属，老人安全',
    actor: 'household-guardian',
    serverTime: 1_700_000_100_000
  });
  // 快照仍不得出现身份/密钥字段。
  const text = fs.readFileSync(filePath, 'utf8');
  for (const banned of ['openid', 'unionid', 'sessionToken', 'access_token', 'appSecret']) {
    assert.equal(text.includes(banned), false, `快照不得出现 ${banned}`);
  }

  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.listSafetyLogs().length, 1);
  assert.deepEqual(reloaded.listSafetyLogs()[0], result.disposition);
});

test('v1..v4 snapshots still load with an empty safety ledger and upgrade to v6', (t) => {
  const dir = createTempDir(t);
  for (const version of [1, 2, 3, 4]) {
    const filePath = path.join(dir, `state-v${version}.json`);
    writeDocument(filePath, baseDocument(version));
    const store = new PersistentStore({ filePath });
    assert.deepEqual(store.listSafetyLogs(), [], `v${version} 必须能加载`);
    const result = store.createDisposition(
      dispositionInput({ clientDispositionId: `disp-v${version}-000001` }),
      1_700_000_200_000
    );
    assert.equal(result.created, true);
    const document = readDocument(filePath);
    assert.equal(document.schemaVersion, SCHEMA_VERSION, `v${version} 升级后必须写 v6`);
    assert.equal(document.safetyLogs.length, 1);
  }
});

/* ------------------------------------------------------------ 重启与 ID 单调 */

test('dispositions survive restart and disposition ids are never reused', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  writeDocument(filePath, baseDocument());

  const first = new PersistentStore({ filePath });
  assert.equal(first.createDisposition(dispositionInput(), 1000).disposition.dispositionId, 'dsp-1');
  assert.equal(first.createDisposition(dispositionInput({
    clientDispositionId: 'disp-store-0002', outcome: 'FALSE_ALARM', note: ''
  }), 2000).disposition.dispositionId, 'dsp-2');

  const second = new PersistentStore({ filePath });
  assert.deepEqual(second.listSafetyLogs().map((item) => item.dispositionId), ['dsp-2', 'dsp-1']);
  const third = second.createDisposition(dispositionInput({
    clientDispositionId: 'disp-store-0003', outcome: 'OTHER', note: '老人自行外出'
  }), 3000);
  assert.equal(third.disposition.dispositionId, 'dsp-3', '重启后必须基于已持久化最大 ID 递增');

  const reloaded = new PersistentStore({ filePath });
  assert.deepEqual(reloaded.listSafetyLogs().map((item) => item.dispositionId), ['dsp-3', 'dsp-2', 'dsp-1']);
  assert.equal(reloaded.getDisposition('dsp-1').note, '已联系家属，老人安全');
  // 重启后同一客户端 ID 重放仍然幂等。
  const replay = reloaded.createDisposition(dispositionInput(), 4000);
  assert.equal(replay.created, false);
  assert.equal(replay.duplicate, true);
  assert.equal(reloaded.listSafetyLogs().length, 3);
});

test('accepts strictly increasing ids with historical holes and continues above the max', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  writeDocument(filePath, baseDocument(SCHEMA_VERSION, {
    safetyLogs: [safetyLogRecord('dsp-1'), safetyLogRecord('dsp-3')]
  }));

  const store = new PersistentStore({ filePath });
  assert.deepEqual(store.listSafetyLogs().map((item) => item.dispositionId), ['dsp-3', 'dsp-1']);
  const next = store.createDisposition(dispositionInput({ clientDispositionId: 'disp-store-0009' }), 2_000_000_000_000);
  assert.equal(next.disposition.dispositionId, 'dsp-4', '必须基于已持久化最大 ID 3 递增，而不是条数+1');

  const reloaded = new PersistentStore({ filePath });
  assert.deepEqual(reloaded.listSafetyLogs().map((item) => item.dispositionId), ['dsp-4', 'dsp-3', 'dsp-1']);
});

/* ------------------------------------------------------------ 幂等写盘与冲突 */

test('idempotent replay and conflict never rewrite the snapshot', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  writeDocument(filePath, baseDocument());
  let writes = 0;
  const store = new PersistentStore({
    filePath,
    atomicWriter: (target, text) => {
      writes += 1;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
    }
  });

  const first = store.createDisposition(dispositionInput(), 1000);
  assert.equal(first.created, true);
  assert.equal(writes, 1);
  const afterCreate = fs.readFileSync(filePath, 'utf8');

  const replay = store.createDisposition(dispositionInput(), 2000);
  assert.equal(replay.created, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.disposition.dispositionId, 'dsp-1');
  assert.equal(writes, 1, '幂等重放不得写盘');
  assert.equal(fs.readFileSync(filePath, 'utf8'), afterCreate);

  const conflict = store.createDisposition(dispositionInput({ outcome: 'FALSE_ALARM', note: '' }), 3000);
  assert.equal(conflict.created, false);
  assert.equal(conflict.duplicate, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.disposition.outcome, 'CONTACTED_FAMILY', '冲突不得覆盖既有记录');
  assert.equal(writes, 1, '冲突不得写盘');
  assert.equal(fs.readFileSync(filePath, 'utf8'), afterCreate);
  assert.equal(store.listSafetyLogs().length, 1);
});

/* ------------------------------------------------------------ 写盘失败回滚 */

test('rolls back the ledger and the id allocation when the atomic write fails', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  let failing = false;
  const store = new PersistentStore({
    filePath,
    atomicWriter: (target, text) => {
      if (failing) throw new Error('disk full');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
    }
  });
  store.ingest({ deviceId: DEVICE, room: '厨房', state: 'ALARM', ts: 1_700_000_000_000, alarm: { id: ALARM, type: 'MANUAL_SOS' } });
  const alertBefore = JSON.stringify(store.getAlert(ALARM));
  const fileBefore = fs.readFileSync(filePath, 'utf8');

  failing = true;
  assert.throws(() => store.createDisposition(dispositionInput(), 1000), /disk full/);
  assert.deepEqual(store.listSafetyLogs(), [], '写失败必须回滚台账');
  assert.equal(store.getDisposition('dsp-1'), null);
  assert.equal(store._maxDispositionId, 0, '写失败必须回滚 ID 分配');
  assert.equal(fs.readFileSync(filePath, 'utf8'), fileBefore, '写失败不得产生虚假持久状态');
  assert.equal(JSON.stringify(store.getAlert(ALARM)), alertBefore);

  failing = false;
  const recovered = store.createDisposition(dispositionInput(), 2000);
  assert.equal(recovered.disposition.dispositionId, 'dsp-1', '回滚后重新分配不得跳过或复用已持久化 ID');
  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.listSafetyLogs().length, 1);
});

/* ------------------------------------------------------------ 损坏快照 fail-fast */

test('rejects corrupt safetyLogs snapshots instead of silently dropping records', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  const reject = (safetyLogs, pattern, extra = {}) => {
    writeDocument(filePath, baseDocument(SCHEMA_VERSION, { safetyLogs, ...extra }));
    assert.throws(() => new PersistentStore({ filePath }), pattern);
  };

  reject([safetyLogRecord('dsp-1'), safetyLogRecord('dsp-1')], /duplicate disposition id/);
  reject([safetyLogRecord('dsp-2'), safetyLogRecord('dsp-1')], /strictly increasing/);
  reject([safetyLogRecord('dsp-1', { alarmId: 'alarm-missing' })], /unknown alarm/);
  reject([safetyLogRecord('dsp-1', { deviceId: 'other-device' })], /device binding mismatch/);
  reject([safetyLogRecord('dsp-1'), safetyLogRecord('dsp-2', { clientDispositionId: 'disp-seed-00000001' })],
    /duplicate safety log client key/);
  reject([safetyLogRecord('dsp-1', { openid: 'oLEAK1234567890' })], /unknown field openid/);
  reject([safetyLogRecord('dsp-1', { outcome: 'WHATEVER' })], /outcome/);
  reject([safetyLogRecord('dsp-1', { outcome: 'OTHER', note: '' })], /note must not be empty/);
  reject([safetyLogRecord('dsp-1', { note: ' 未归一化 ' })], /safetyLog\[0\]\.note/);
  reject([safetyLogRecord('dsp-1', { note: 'bad\u0000note' })], /safetyLog\[0\]\.note/);
  reject([safetyLogRecord('dsp-1', { note: 'a'.repeat(201) })], /safetyLog\[0\]\.note/);
  reject([safetyLogRecord('dsp-1', { clientDispositionId: 'short' })], /clientDispositionId/);
  reject([safetyLogRecord('dsp-1', { actor: 'wx-openid-holder' })], /actor/);
  reject([safetyLogRecord('dsp-1', { serverTime: -1 })], /serverTime/);
  reject([safetyLogRecord('dsp-1', { dispositionId: 'dsp-9999999999999999' })], /safe positive integer/);
  reject([safetyLogRecord('dsp-1', { room: 'x'.repeat(33) })], /room/);
  reject([safetyLogRecord('dsp-1', { type: 42 })], /type/);
  reject([safetyLogRecord('dsp-1', { serverTime: 'yesterday' })], /serverTime/);
  reject('not-an-array', /safetyLogs must be an array/);

  // 超过容量上限的快照同样拒绝加载（不静默丢历史）。
  const tooMany = [];
  for (let index = 1; index <= SAFETY_LOG_CAP + 1; index += 1) {
    tooMany.push(safetyLogRecord(`dsp-${index}`));
  }
  reject(tooMany, /exceeds capacity/);
});

/* ------------------------------------------------------------ 容量上限 */

test('caps the ledger at 2000 entries and evicts the oldest by write order', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  const seeded = [];
  for (let index = 1; index <= SAFETY_LOG_CAP; index += 1) {
    seeded.push(safetyLogRecord(`dsp-${index}`));
  }
  writeDocument(filePath, baseDocument(SCHEMA_VERSION, { safetyLogs: seeded }));

  const store = new PersistentStore({ filePath });
  assert.equal(store.safetyLogs.length, SAFETY_LOG_CAP);
  const result = store.createDisposition(dispositionInput({ clientDispositionId: 'disp-cap-99999999' }), 1_700_009_999_999);
  assert.equal(result.created, true);
  assert.equal(result.disposition.dispositionId, `dsp-${SAFETY_LOG_CAP + 1}`);

  const document = readDocument(filePath);
  assert.equal(document.safetyLogs.length, SAFETY_LOG_CAP, '台账不得无限增长');
  assert.equal(document.safetyLogs[0].dispositionId, 'dsp-2', '必须按写入顺序淘汰最旧');
  assert.equal(document.safetyLogs[document.safetyLogs.length - 1].dispositionId, `dsp-${SAFETY_LOG_CAP + 1}`);
  assert.equal(store.getDisposition('dsp-1'), null, '最旧记录已被淘汰');
  assert.notEqual(store.getDisposition(`dsp-${SAFETY_LOG_CAP + 1}`), null);

  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.safetyLogs.length, SAFETY_LOG_CAP);
  assert.notEqual(reloaded.getDisposition(`dsp-${SAFETY_LOG_CAP + 1}`), null);
});

/* ------------------------------------------------------------ 与 ACK 解耦 */

test('dispositions never create ACK commands and survive restart without touching alert state', (t) => {
  const dir = createTempDir(t);
  const filePath = path.join(dir, 'state.json');
  const store = new PersistentStore({ filePath });
  store.ingest({ deviceId: DEVICE, room: '厨房', state: 'ALARM', ts: 1_700_000_000_000, alarm: { id: ALARM, type: 'MANUAL_SOS' } });
  const command = store.requestAck(ALARM, '家属确认中', 'household-guardian');
  assert.equal(command.status, 'PENDING');
  const commandsBefore = JSON.stringify(store.listCommands(0));
  const alertBefore = JSON.stringify(store.getAlert(ALARM));

  assert.equal(store.createDisposition(dispositionInput(), 1000).created, true);
  assert.equal(store.createDisposition(dispositionInput({
    clientDispositionId: 'disp-store-0002', outcome: 'CONTACTED_COMMUNITY', note: '社区已上门'
  }), 2000).created, true);

  assert.equal(JSON.stringify(store.listCommands(0)), commandsBefore, '处置绝不生成/修改 ACK 命令');
  assert.equal(JSON.stringify(store.getAlert(ALARM)), alertBefore, '处置绝不改变告警状态/ackPending');
  assert.equal(store.getAlert(ALARM).status, 'ALARM');
  assert.equal(store.getAlert(ALARM).ackPending, true);

  const reloaded = new PersistentStore({ filePath });
  assert.equal(reloaded.listCommands(0).length, 1);
  assert.equal(reloaded.listCommands(0)[0].status, 'PENDING');
  assert.equal(reloaded.getAlert(ALARM).status, 'ALARM');
  assert.equal(reloaded.getAlert(ALARM).ackPending, true);
  assert.equal(reloaded.listSafetyLogs().length, 2);
});
