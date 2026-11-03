'use strict';

/**
 * 随身 SOS（ESP32-S3 + M100 + APP 地图 + ACK）后端契约集成测试。
 *
 * 依据：competition/docs/wearable-4g-map/DESIGN-CONTRACT.md
 *
 * 覆盖范围（全部走真实 HTTP + 真实 listener，临时端口、临时目录，不碰生产 /data）：
 *   1. POST /internal/v1/device-status 建告警、同一 alarmId 幂等、countToday 归一化；
 *   2. 无 GPS 也建告警；sosLocation 为 UNAVAILABLE 而不是 null 崩溃；
 *   3. POST /api/v1/alerts/<id>/ack -> 202 PENDING + ackPending，不立即 ACKED；
 *      设备真实回执（command-sync.js 实际上报体）后才 ACKED；
 *   4. GET /internal/v1/commands?after=N 的精确游标语义（含已完成命令、非法 after）；
 *   5. /api/v1/ingest/wearable/location 的 token、seq 单调/重复/冲突、落盘；
 *   6. /api/v1/alerts 的 sosLocation LOCATED/STALE/UNAVAILABLE 形态与 120s 阈值；
 *   7. /api/v1/location 的设备 GPS 事实；
 *   8. main.js 是否把 WEARABLE_LOCATION_TOKEN 从 env 装配到 server（真实 createRuntime）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createSessionToken } = require('../src/auth');
const { createRuntime } = require('../src/main');
const { PersistentStore } = require('../src/persistent-store');
const { createApiServer } = require('../src/server');
const { MemoryStore } = require('../src/store');

const TOKEN_SECRET = 'wearable-contract-token-secret-at-least-32-characters';
const INGEST_KEY = 'wearable-contract-ingest-key-at-least-32-characters';
const WEARABLE_TOKEN = 'wearable-contract-location-token-32chars-min';
const OPENID = 'openid-wearable-contract';

const DEVICE_ID = 'esp32-sos';
const ROOM = '随身求助';
const LOCATION_DEVICE_ID = 'wearable-sos-001';

const SOS_ALARM = 'sos-1-ab12cd';
const ACK_TS = 1791609901000;

/* ------------------------------------------------------------------ helpers */

function authHeader() {
  return { authorization: `Bearer ${createSessionToken(OPENID, TOKEN_SECRET)}` };
}

function makeStatus(overrides = {}) {
  return {
    deviceId: DEVICE_ID,
    room: ROOM,
    state: 'ALARM',
    online: true,
    monitorOnline: -1,
    ts: 1791609900000,
    alarm: { id: SOS_ALARM, type: 'MANUAL_SOS', countToday: 1 },
    gps: { valid: false, fixTime: 0 },
    csq: 26,
    ...overrides
  };
}

async function startServer(options = {}) {
  const store = options.store || new MemoryStore();
  const created = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    wearableLocationToken: options.wearableLocationToken === undefined
      ? WEARABLE_TOKEN
      : options.wearableLocationToken,
    authorizeIdentity: (openid) => openid === OPENID
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${created.server.address().port}`;
  return {
    store,
    baseUrl,
    close: () => new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve()))
  };
}

async function postStatus(baseUrl, body) {
  const response = await fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function locationUrl(baseUrl, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return `${baseUrl}/api/v1/ingest/wearable/location?${query.toString()}`;
}

async function sendLocation(baseUrl, params, token = WEARABLE_TOKEN, method = 'GET') {
  const url = new URL(locationUrl(baseUrl, params));
  if (token !== null) url.searchParams.set('token', token);
  const response = await fetch(url.toString(), { method });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

async function getAlerts(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/alerts`, { headers: authHeader() });
  assert.equal(response.status, 200);
  return (await response.json()).alerts;
}

async function findAlert(baseUrl, alarmId) {
  const alerts = await getAlerts(baseUrl);
  return alerts.find((item) => item.id === alarmId);
}

async function ack(baseUrl, alarmId, note = '监护人已确认') {
  const response = await fetch(`${baseUrl}/api/v1/alerts/${encodeURIComponent(alarmId)}/ack`, {
    method: 'POST',
    headers: { ...authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify(note === undefined ? {} : { note })
  });
  return { status: response.status, body: await response.json() };
}

async function listCommands(baseUrl, afterParam) {
  const suffix = afterParam === undefined ? '' : `?after=${encodeURIComponent(String(afterParam))}`;
  const response = await fetch(`${baseUrl}/internal/v1/commands${suffix}`, {
    headers: { 'x-ingest-key': INGEST_KEY }
  });
  assert.equal(response.status, 200);
  return (await response.json()).commands;
}

/** command-sync.js settleWithResult({status:'ACKED', deviceState}) 的实际上报体。 */
function ackedResultBody(alarmId = SOS_ALARM, overrides = {}) {
  return {
    status: 'ACKED',
    deviceState: {
      deviceId: DEVICE_ID,
      room: ROOM,
      online: true,
      state: 'ACKED',
      ts: ACK_TS,
      alarm: { id: alarmId, type: 'MANUAL_SOS', countToday: 1 },
      ...overrides
    }
  };
}

async function postResult(baseUrl, commandId, body) {
  const response = await fetch(`${baseUrl}/internal/v1/commands/${encodeURIComponent(commandId)}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

/* =================================================================== 1. 建告警 */

test('device-status MANUAL_SOS creates exactly one APP-visible alert without GPS', async (t) => {
  const server = await startServer();
  t.after(server.close);

  const created = await postStatus(server.baseUrl, makeStatus());
  assert.equal(created.status, 202);
  assert.deepEqual(created.body, { accepted: true, deviceId: DEVICE_ID });

  const alerts = await getAlerts(server.baseUrl);
  assert.equal(alerts.length, 1);
  const alert = alerts[0];
  assert.equal(alert.id, SOS_ALARM);
  assert.equal(alert.alarmId, SOS_ALARM);
  assert.equal(alert.deviceId, DEVICE_ID);
  assert.equal(alert.roomName, ROOM);
  assert.equal(alert.type, 'MANUAL_SOS');
  assert.equal(alert.state, 'ALARM');
  assert.equal(alert.ackPending, false);
  assert.equal(alert.createdAt, 1791609900000);
  assert.equal(alert.evidence.available, false);
  // 无任何 M100 位置记录时：sosLocation 必须是显式 UNAVAILABLE 对象（不是 null、不是缺字段）。
  assert.deepEqual(alert.sosLocation, {
    status: 'UNAVAILABLE',
    latitude: null,
    longitude: null,
    positionTime: 0,
    receivedAt: 0,
    ageSeconds: null
  });
  assert.equal(Object.prototype.hasOwnProperty.call(alert, 'evidenceId'), false);
});

test('repeating the same alarmId keeps one alert while countToday/ts may change', async (t) => {
  const server = await startServer();
  t.after(server.close);

  assert.equal((await postStatus(server.baseUrl, makeStatus())).status, 202);
  // 同一事件的 MQTT 重试：alarm/type 不变，uptime/seq/countToday/gps/ts 允许变化。
  const retry = await postStatus(server.baseUrl, makeStatus({
    ts: 1791609905000,
    alarm: { id: SOS_ALARM, type: 'MANUAL_SOS', countToday: 3 },
    gps: { valid: true, latitude: 32.9671, longitude: 112.5532, fixTime: 1791609904000 }
  }));
  assert.equal(retry.status, 202);

  const alerts = await getAlerts(server.baseUrl);
  assert.equal(alerts.length, 1, 'same alarmId must never create a second alert');
  assert.equal(alerts[0].createdAt, 1791609900000, 'first createdAt must not be rewritten by retries');
  assert.equal(alerts[0].state, 'ALARM');
  // 设备遥测（含 countToday）按最新上报更新，但告警实体不重复。
  assert.equal(server.store.devices.get(DEVICE_ID).alarm.countToday, 3);
});

test('countToday is normalized to a non-negative safe integer', async (t) => {
  const server = await startServer();
  t.after(server.close);

  const cases = [
    ['sos-count-ok', { id: 'sos-count-ok', type: 'MANUAL_SOS', countToday: 7 }, 7],
    ['sos-count-missing', { id: 'sos-count-missing', type: 'MANUAL_SOS' }, 0],
    ['sos-count-string', { id: 'sos-count-string', type: 'MANUAL_SOS', countToday: '5' }, 0],
    ['sos-count-neg', { id: 'sos-count-neg', type: 'MANUAL_SOS', countToday: -1 }, 0],
    ['sos-count-frac', { id: 'sos-count-frac', type: 'MANUAL_SOS', countToday: 1.5 }, 0]
  ];
  for (const [alarmId, alarm, expected] of cases) {
    assert.equal((await postStatus(server.baseUrl, makeStatus({ alarm }))).status, 202);
    assert.equal(server.store.devices.get(DEVICE_ID).alarm.countToday, expected, alarmId);
  }
  // countToday 变化不产生额外告警：仍是 5 条唯一 alarmId。
  assert.equal((await getAlerts(server.baseUrl)).length, cases.length);
});

/* ============================================================== 2. 位置记录 */

test('wearable location ingest requires its own token and monotonic seq', async (t) => {
  const server = await startServer();
  t.after(server.close);

  const params = {
    deviceId: LOCATION_DEVICE_ID,
    fixValid: 1,
    latitude: 32.9671,
    longitude: 112.5532,
    positionTime: 1791609902000,
    seq: 1
  };
  assert.equal((await sendLocation(server.baseUrl, params, null)).status, 401);
  assert.equal((await sendLocation(server.baseUrl, params, 'wrong-token')).status, 401);

  const accepted = await sendLocation(server.baseUrl, params);
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.body, {
    accepted: true,
    duplicate: false,
    stale: false,
    deviceId: LOCATION_DEVICE_ID,
    seq: 1
  });
  // deviceId 可省略（默认 wearable-sos-001），但显式传错必须拒绝。
  const noDevice = await sendLocation(server.baseUrl, { ...params, deviceId: undefined, seq: 2 });
  assert.equal(noDevice.status, 202);
  assert.equal(noDevice.body.deviceId, LOCATION_DEVICE_ID);
  assert.equal((await sendLocation(server.baseUrl, { ...params, deviceId: 'esp32-sos', seq: 3 })).status, 400);

  // seq 必须是正整数安全整数。
  for (const seq of [undefined, 0, -1, 1.5, 'x']) {
    const response = await sendLocation(server.baseUrl, { ...params, seq });
    assert.equal(response.status, 400, `seq=${seq} must be rejected`);
  }
  // 有效定位必须有真实坐标：缺纬度不得被 Number(null)=0 伪造成赤道坐标。
  assert.equal((await sendLocation(server.baseUrl, { ...params, latitude: undefined, seq: 4 })).status, 400);
  assert.equal((await sendLocation(server.baseUrl, { ...params, latitude: 0, longitude: 0, seq: 4 })).status, 400);
  assert.equal((await sendLocation(server.baseUrl, { ...params, latitude: 91, seq: 4 })).status, 400);
  assert.equal((await sendLocation(server.baseUrl, { ...params, longitude: 181, seq: 4 })).status, 400);
});

test('seq duplicate/stale/conflict semantics and last-good record retention', async (t) => {
  const server = await startServer();
  t.after(server.close);
  assert.equal((await postStatus(server.baseUrl, makeStatus())).status, 202);

  const base = {
    deviceId: LOCATION_DEVICE_ID,
    fixValid: 1,
    latitude: 32.9671,
    longitude: 112.5532,
    positionTime: 1791609902000,
    seq: 10
  };
  assert.equal((await sendLocation(server.baseUrl, base)).status, 202);

  // 同一 seq 同一内容 -> duplicate（幂等成功）。
  const repeat = await sendLocation(server.baseUrl, base);
  assert.equal(repeat.status, 202);
  assert.equal(repeat.body.duplicate, true);
  assert.equal(repeat.body.stale, false);

  // 同一 seq 不同内容 -> 400 冲突，绝不静默覆盖。
  const conflict = await sendLocation(server.baseUrl, { ...base, latitude: 31.1 });
  assert.equal(conflict.status, 400);
  assert.equal(conflict.body.error, 'location seq conflict');

  // 回退 seq -> 202 stale（不覆盖最后一条好记录），告警仍显示 seq=10 的坐标。
  const stale = await sendLocation(server.baseUrl, { ...base, seq: 9, latitude: 30.0, longitude: 110.0 });
  assert.equal(stale.status, 202);
  assert.equal(stale.body.duplicate, true);
  assert.equal(stale.body.stale, true);
  assert.equal(server.store.getWearableLocation().seq, 10);
  const alert = await findAlert(server.baseUrl, SOS_ALARM);
  assert.equal(alert.sosLocation.status, 'LOCATED');
  assert.equal(alert.sosLocation.latitude, 32.9671);
  assert.equal(alert.sosLocation.longitude, 112.5532);

  // 合同 §5.2 写明 POST/GET 均可：POST 与 GET 语义完全一致（参数仍在 query）。
  assert.equal((await sendLocation(server.baseUrl, { ...base, seq: 12 }, WEARABLE_TOKEN, 'POST')).status, 202);
  assert.equal(server.store.getWearableLocation().seq, 12);

  // 更大 seq -> 覆盖为最新位置。
  const newer = await sendLocation(server.baseUrl, { ...base, seq: 13, latitude: 32.97, longitude: 112.56 });
  assert.equal(newer.status, 202);
  assert.equal(newer.body.duplicate, false);
  assert.equal((await findAlert(server.baseUrl, SOS_ALARM)).sosLocation.latitude, 32.97);
});

test('sosLocation is LOCATED/STALE/UNAVAILABLE with exact field shapes', async (t) => {
  const server = await startServer();
  t.after(server.close);
  assert.equal((await postStatus(server.baseUrl, makeStatus())).status, 202);

  // 1) fixValid=0（无定位）记录存在：UNAVAILABLE，坐标 null，但 receivedAt/ageSeconds 有值。
  assert.equal((await sendLocation(server.baseUrl, {
    deviceId: LOCATION_DEVICE_ID, fixValid: 0, positionTime: 1791609902500, seq: 1
  }, WEARABLE_TOKEN)).status, 202);
  let sos = (await findAlert(server.baseUrl, SOS_ALARM)).sosLocation;
  assert.equal(sos.status, 'UNAVAILABLE');
  assert.equal(sos.latitude, null);
  assert.equal(sos.longitude, null);
  assert.equal(sos.positionTime, 1791609902500);
  assert.equal(typeof sos.receivedAt, 'number');
  assert.ok(sos.receivedAt > 0);
  assert.equal(typeof sos.ageSeconds, 'number');
  assert.ok(sos.ageSeconds >= 0);

  // 2) 有效定位 -> LOCATED，坐标原样（WGS84，不做坐标系转换）。
  assert.equal((await sendLocation(server.baseUrl, {
    deviceId: LOCATION_DEVICE_ID, fixValid: 1,
    latitude: 32.9671, longitude: 112.5532, positionTime: 1791609903000, seq: 2
  })).status, 202);
  sos = (await findAlert(server.baseUrl, SOS_ALARM)).sosLocation;
  assert.equal(sos.status, 'LOCATED');
  assert.equal(sos.latitude, 32.9671);
  assert.equal(sos.longitude, 112.5532);
  assert.equal(sos.positionTime, 1791609903000);
  assert.ok(sos.ageSeconds <= 120);

  // 3) 超过 120s -> STALE；阈值边界精确到 ageSeconds。
  const record = server.store.getWearableLocation();
  const alert = server.store.getAlert(SOS_ALARM);
  assert.equal(server.store.getWearableAlertLocation(alert, record.receivedAt + 120000).status, 'LOCATED');
  assert.equal(server.store.getWearableAlertLocation(alert, record.receivedAt + 120999).status, 'LOCATED');
  assert.equal(server.store.getWearableAlertLocation(alert, record.receivedAt + 121000).status, 'STALE');
  const staleSos = server.store.getWearableAlertLocation(alert, record.receivedAt + 121000);
  assert.equal(staleSos.latitude, 32.9671, 'STALE still returns last known coordinates');
  assert.equal(staleSos.longitude, 112.5532);
  assert.equal(staleSos.ageSeconds, 121);

  // 真实 HTTP 时效：把 receivedAt 挪到 130s 前，接口返回 STALE（非 UNAVAILABLE）。
  server.store.wearableLocations.set(LOCATION_DEVICE_ID, {
    ...record, receivedAt: Date.now() - 130000
  });
  sos = (await findAlert(server.baseUrl, SOS_ALARM)).sosLocation;
  assert.equal(sos.status, 'STALE');
  assert.ok(sos.ageSeconds >= 130);
  assert.equal(sos.latitude, 32.9671);
});

test('positionTime is taken from the request and missing values fall back to receive time', async (t) => {
  const server = await startServer();
  t.after(server.close);

  assert.equal((await sendLocation(server.baseUrl, {
    deviceId: LOCATION_DEVICE_ID, fixValid: 1,
    latitude: 32.9, longitude: 112.5, positionTime: 1791609902000, seq: 1
  })).status, 202);
  const record = server.store.getWearableLocation();
  assert.equal(record.positionTime, 1791609902000);

  // 缺省 positionTime 不得被 Number(null)=0 伪装成“定位时间为 0”。
  assert.equal((await sendLocation(server.baseUrl, {
    deviceId: LOCATION_DEVICE_ID, fixValid: 1, latitude: 32.9, longitude: 112.5, seq: 2
  })).status, 202);
  const updated = server.store.getWearableLocation();
  assert.equal(updated.seq, 2);
  assert.ok(updated.positionTime > 0, `positionTime must fall back to receivedAt, got ${updated.positionTime}`);
  assert.equal(updated.positionTime, updated.receivedAt);
});

/* ================================================================ 3. ACK 流程 */

test('ACK click is PENDING first and only a real device receipt makes the alert ACKED', async (t) => {
  const server = await startServer();
  t.after(server.close);
  assert.equal((await postStatus(server.baseUrl, makeStatus())).status, 202);

  const first = await ack(server.baseUrl, SOS_ALARM, '已电话确认\n老人安全');
  assert.equal(first.status, 202);
  assert.deepEqual(first.body, { accepted: true, status: 'PENDING', commandId: '1' });

  // 告警不立即变 ACKED：状态仍 ALARM，ackPending=true。
  let alert = await findAlert(server.baseUrl, SOS_ALARM);
  assert.equal(alert.state, 'ALARM');
  assert.equal(alert.ackPending, true);
  assert.equal(alert.acknowledgedAt, 0);

  // 重复点击（同一告警）幂等复用同一条 PENDING 命令，不产生第二条。
  const second = await ack(server.baseUrl, SOS_ALARM, '再次点击');
  assert.equal(second.status, 202);
  assert.equal(second.body.commandId, '1');
  const commands = await listCommands(server.baseUrl, 0);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].deviceId, DEVICE_ID);
  assert.equal(commands[0].command, 'ACK');
  assert.equal(commands[0].alarmId, SOS_ALARM);
  assert.equal(commands[0].status, 'PENDING');
  assert.equal(commands[0].action, '已电话确认 老人安全');
  assert.equal(commands[0].requestedBy, 'household-guardian');

  // 设备真实回执（command-sync.js 实际上报字段）后才 ACKED。
  const receipt = await postResult(server.baseUrl, '1', ackedResultBody());
  assert.equal(receipt.status, 200);
  assert.deepEqual(receipt.body, { accepted: true, commandId: '1', status: 'ACKED' });

  alert = await findAlert(server.baseUrl, SOS_ALARM);
  assert.equal(alert.state, 'ACKED');
  assert.equal(alert.ackPending, false);
  assert.equal(alert.acknowledgedAt, ACK_TS);
  assert.equal(alert.acknowledgedBy, 'household-guardian');

  // command-sync 的 deviceState 是“部分回执”（无 sensors/gps/csq/monitorOnline）：
  // 后端必须保留原有遥测，不能把随身设备的 csq/monitorOnline 冲成 null/-1 默认值。
  const devices = await (await fetch(`${server.baseUrl}/api/v1/devices`, { headers: authHeader() })).json();
  const device = devices.devices.find((item) => item.id === DEVICE_ID);
  assert.equal(device.state, 'ACKED');
  assert.equal(device.monitorOnline, -1);
  assert.equal(device.csq, 26);

  // 幂等重放回执：200 且状态不变。
  const replay = await postResult(server.baseUrl, '1', ackedResultBody());
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, 'ACKED');

  // 已 ACKED 的告警再次点击 -> 400，不会生成新命令。
  const third = await ack(server.baseUrl, SOS_ALARM);
  assert.equal(third.status, 400);
  assert.equal(third.body.error, 'alarm already acknowledged');
});

test('device receipt must match command binding; mismatches fail closed', async (t) => {
  const server = await startServer();
  t.after(server.close);
  assert.equal((await postStatus(server.baseUrl, makeStatus())).status, 202);
  assert.equal((await ack(server.baseUrl, SOS_ALARM)).status, 202);

  // deviceState 缺失 / 设备不符 / alarm 不符 / 状态不是 ACKED / 非法 FAILED code
  // -> 400，且告警保持 PENDING。
  const badBodies = [
    { status: 'ACKED' },
    ackedResultBody(SOS_ALARM, { deviceId: 'esp32-other' }),
    ackedResultBody('sos-other-alarm'),
    { ...ackedResultBody(), deviceState: { ...ackedResultBody().deviceState, state: 'ALARM' } },
    { status: 'FAILED', code: 'lower_case' }
  ];
  for (const body of badBodies) {
    const response = await postResult(server.baseUrl, '1', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const alert = await findAlert(server.baseUrl, SOS_ALARM);
  assert.equal(alert.state, 'ALARM');
  assert.equal(alert.ackPending, true);

  // FAILED 回执：ackPending 清除但告警仍 ALARM，可再次发起新 ACK 命令（新 commandId）。
  const failed = await postResult(server.baseUrl, '1', { status: 'FAILED', code: 'DEVICE_TIMEOUT' });
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.body, { accepted: true, commandId: '1', status: 'FAILED' });
  assert.equal((await findAlert(server.baseUrl, SOS_ALARM)).state, 'ALARM');
  assert.equal((await findAlert(server.baseUrl, SOS_ALARM)).ackPending, false);

  const reAck = await ack(server.baseUrl, SOS_ALARM, '用户重新点击');
  assert.equal(reAck.status, 202);
  assert.equal(reAck.body.commandId, '2');
  assert.equal((await findAlert(server.baseUrl, SOS_ALARM)).ackPending, true);
  assert.equal((await postResult(server.baseUrl, '2', ackedResultBody())).status, 200);
  assert.equal((await findAlert(server.baseUrl, SOS_ALARM)).state, 'ACKED');

  // 非法 FAILED code 在任何状态变更之前被拒绝。
  assert.equal((await postStatus(server.baseUrl, makeStatus({
    alarm: { id: 'sos-bad-code', type: 'MANUAL_SOS', countToday: 1 }
  }))).status, 202);
  const badAck = await ack(server.baseUrl, 'sos-bad-code');
  assert.equal(badAck.body.status, 'PENDING');
  const badCode = await postResult(server.baseUrl, badAck.body.commandId, { status: 'FAILED', code: 'lower_case' });
  assert.equal(badCode.status, 400);
  assert.equal((await findAlert(server.baseUrl, 'sos-bad-code')).ackPending, true);
});

test('late duplicate SOS after ACK does not reopen or duplicate the alert', async (t) => {
  const server = await startServer();
  t.after(server.close);
  assert.equal((await postStatus(server.baseUrl, makeStatus())).status, 202);
  assert.equal((await ack(server.baseUrl, SOS_ALARM)).body.commandId, '1');
  assert.equal((await postResult(server.baseUrl, '1', ackedResultBody())).status, 200);

  // 设备还没收到 ACK、仍在 10s 重试同一包：后台已确认的告警不得被重新打开。
  assert.equal((await postStatus(server.baseUrl, makeStatus({ ts: 1791609909000 }))).status, 202);
  const alerts = await getAlerts(server.baseUrl);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].state, 'ACKED');
  assert.equal(alerts[0].ackPending, false);
});

/* ========================================================== 4. commands 游标 */

test('GET /internal/v1/commands?after=N is an exclusive numeric cursor over ALL commands', async (t) => {
  const server = await startServer();
  t.after(server.close);

  // 内部命令接口必须带 x-ingest-key。
  assert.equal((await fetch(`${server.baseUrl}/internal/v1/commands?after=0`)).status, 401);
  // 无命令时：任何 after 都返回空数组。
  assert.deepEqual(await listCommands(server.baseUrl, 0), []);
  assert.deepEqual(await listCommands(server.baseUrl, undefined), []);

  assert.equal((await postStatus(server.baseUrl, makeStatus({
    alarm: { id: 'sos-cmd-1', type: 'MANUAL_SOS', countToday: 1 }
  }))).status, 202);
  assert.equal((await postStatus(server.baseUrl, makeStatus({
    alarm: { id: 'sos-cmd-2', type: 'MANUAL_SOS', countToday: 2 }
  }))).status, 202);
  await ack(server.baseUrl, 'sos-cmd-1');
  const acked = await ack(server.baseUrl, 'sos-cmd-2');
  assert.equal(acked.body.commandId, '2');
  assert.equal((await postResult(server.baseUrl, '2', ackedResultBody('sos-cmd-2'))).status, 200);

  // after=0 / 负数 / 非法值（回退 0）都返回全部命令，按 id 升序。
  for (const afterParam of [0, -1, 'abc', '0.9', undefined]) {
    const commands = await listCommands(server.baseUrl, afterParam);
    assert.deepEqual(commands.map((item) => item.id), ['1', '2'], `after=${afterParam}`);
  }
  // after 是“严格大于”的游标：after=1 只剩 id=2（已完成的命令也仍会返回）。
  const afterOne = await listCommands(server.baseUrl, 1);
  assert.deepEqual(afterOne.map((item) => item.id), ['2']);
  assert.equal(afterOne[0].status, 'ACKED', 'adapter must filter status==="PENDING" itself');
  assert.deepEqual(await listCommands(server.baseUrl, 2), []);
  assert.deepEqual(await listCommands(server.baseUrl, 99), []);
});

/* ================================================ 5. 持久化与重启（真实目录） */

test('location record, alert, command and ACKED state survive a real restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wearable-contract-restart-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'backend-state.json');

  const startPersistent = async () => {
    const store = new PersistentStore({ filePath: stateFile });
    return startServer({ store });
  };

  const first = await startPersistent();
  assert.equal((await postStatus(first.baseUrl, makeStatus())).status, 202);
  assert.equal((await sendLocation(first.baseUrl, {
    deviceId: LOCATION_DEVICE_ID, fixValid: 1,
    latitude: 32.9671, longitude: 112.5532, positionTime: 1791609902000, seq: 1
  })).status, 202);
  assert.equal((await ack(first.baseUrl, SOS_ALARM)).body.commandId, '1');

  // 位置记录独立落盘：不能只存在内存里。
  const locationFile = path.join(directory, 'wearable-locations.json');
  assert.equal(fs.existsSync(locationFile), true, 'wearable-locations.json must be written');
  const locationDocument = JSON.parse(fs.readFileSync(locationFile, 'utf8'));
  assert.equal(locationDocument.version, 1);
  assert.equal(locationDocument.locations.length, 1);
  assert.equal(locationDocument.locations[0].deviceId, LOCATION_DEVICE_ID);
  assert.equal(locationDocument.locations[0].seq, 1);
  await first.close();

  const second = await startPersistent();
  try {
    const restored = await findAlert(second.baseUrl, SOS_ALARM);
    assert.equal(restored.state, 'ALARM');
    assert.equal(restored.ackPending, true);
    // sosLocation 在重启后依然来自持久化的位置记录。
    assert.equal(restored.sosLocation.status, 'LOCATED');
    assert.equal(restored.sosLocation.latitude, 32.9671);
    const commands = await listCommands(second.baseUrl, 0);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].status, 'PENDING');

    // 重启后再上报同一 alarmId 仍只有一条告警。
    assert.equal((await postStatus(second.baseUrl, makeStatus({ ts: 1791609910000 }))).status, 202);
    assert.equal((await getAlerts(second.baseUrl)).length, 1);

    assert.equal((await postResult(second.baseUrl, '1', ackedResultBody())).status, 200);
    // 快照与位置文件里不得出现任何 token/密钥。
    const snapshot = fs.readFileSync(stateFile, 'utf8');
    for (const secret of [TOKEN_SECRET, INGEST_KEY, WEARABLE_TOKEN]) {
      assert.equal(snapshot.includes(secret), false);
      assert.equal(fs.readFileSync(locationFile, 'utf8').includes(secret), false);
    }
  } finally {
    await second.close();
  }

  // 第二次重启：ACKED 与位置都在。
  const third = await startPersistent();
  try {
    const restored = await findAlert(third.baseUrl, SOS_ALARM);
    assert.equal(restored.state, 'ACKED');
    assert.equal(restored.ackPending, false);
    assert.equal(restored.sosLocation.status, 'LOCATED');
    assert.equal((await listCommands(third.baseUrl, 0))[0].status, 'ACKED');
  } finally {
    await third.close();
  }
});

/* ================================================== 6. 设备 GPS / location 事实 */

test('/api/v1/location exposes esp32-sos device-status GPS but not the M100 location record', async (t) => {
  const server = await startServer();
  t.after(server.close);

  // 1) device-status.gps（ESP32 自报）会进入 /api/v1/location。
  assert.equal((await postStatus(server.baseUrl, makeStatus({
    gps: { valid: true, latitude: 32.9671, longitude: 112.5532, fixTime: 1791609900000 }
  }))).status, 202);
  let locations = await (await fetch(`${server.baseUrl}/api/v1/location`, { headers: authHeader() })).json();
  assert.equal(locations.locations.length, 1);
  assert.equal(locations.locations[0].deviceId, DEVICE_ID);
  assert.equal(locations.locations[0].latitude, 32.9671);

  // 2) M100 的独立位置记录（wearable-sos-001）只通过告警 sosLocation 暴露，
  //    不会混进 /api/v1/location —— APP 不能在设备列表里重复显示两个随身节点。
  assert.equal((await sendLocation(server.baseUrl, {
    deviceId: LOCATION_DEVICE_ID, fixValid: 1,
    latitude: 30.111, longitude: 110.222, positionTime: 1791609902000, seq: 1
  })).status, 202);
  locations = await (await fetch(`${server.baseUrl}/api/v1/location`, { headers: authHeader() })).json();
  assert.equal(locations.locations.length, 1);
  assert.deepEqual(locations.locations.map((item) => item.deviceId), [DEVICE_ID]);
  // 告警 sosLocation 用的是 M100 位置（不是 ESP32 的 device-status.gps）。
  const alert = await findAlert(server.baseUrl, SOS_ALARM);
  assert.equal(alert.sosLocation.latitude, 30.111);
  assert.equal(alert.sosLocation.longitude, 110.222);
});

test('sosLocation is bound to MANUAL_SOS from esp32-sos only', async (t) => {
  const server = await startServer();
  t.after(server.close);

  assert.equal((await sendLocation(server.baseUrl, {
    deviceId: LOCATION_DEVICE_ID, fixValid: 1,
    latitude: 32.9671, longitude: 112.5532, positionTime: 1791609902000, seq: 1
  })).status, 202);
  // esp32-sos 的 MANUAL_SOS（合同身份）才挂 sosLocation。
  assert.equal((await postStatus(server.baseUrl, makeStatus())).status, 202);

  // 其他设备的 MANUAL_SOS：不得挂随身 sosLocation。
  assert.equal((await postStatus(server.baseUrl, {
    deviceId: 'esp32-bath', room: '卫生间', state: 'ALARM', ts: 1791609900000,
    alarm: { id: 'sos-bath-1', type: 'MANUAL_SOS', countToday: 1 }
  })).status, 202);
  // esp32-sos 的非 MANUAL_SOS 告警：同样不得挂 sosLocation。
  assert.equal((await postStatus(server.baseUrl, makeStatus({
    alarm: { id: 'sos-no-motion', type: 'NO_MOTION', countToday: 1 }
  }))).status, 202);

  const alerts = await getAlerts(server.baseUrl);
  const bath = alerts.find((item) => item.id === 'sos-bath-1');
  const noMotion = alerts.find((item) => item.id === 'sos-no-motion');
  assert.equal(Object.prototype.hasOwnProperty.call(bath, 'sosLocation'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(noMotion, 'sosLocation'), false);
  const wearable = alerts.find((item) => item.id === SOS_ALARM);
  assert.equal(wearable.sosLocation.status, 'LOCATED');
});

/* ================================== 7. main.js 的 env 装配（真实 createRuntime） */

function runtimeEnv(directory) {
  return {
    PORT: '8080',
    HOST: '127.0.0.1',
    BACKEND_DATA_FILE: path.join(directory, 'state.json'),
    BACKEND_EVIDENCE_DIR: path.join(directory, 'evidence'),
    BACKEND_ACTIVITY_FILE: path.join(directory, 'activity-state.json'),
    HEALTH_DATA_FILE: path.join(directory, 'health-state.json'),
    API_TOKEN_SECRET: TOKEN_SECRET,
    INGEST_KEY: INGEST_KEY,
    APP_GUARDIAN_ID: 'family-guardian',
    APP_GUARDIAN_PASSWORD: 'wearable-contract-app-password-at-least-32chars'
  };
}

test('main.js wires WEARABLE_LOCATION_TOKEN from env into the server', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wearable-contract-runtime-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const runtime = createRuntime({ ...runtimeEnv(directory), WEARABLE_LOCATION_TOKEN: WEARABLE_TOKEN });
  assert.equal(runtime.wearableLocationConfigured, true);
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    const params = {
      deviceId: LOCATION_DEVICE_ID, fixValid: 1,
      latitude: 32.9, longitude: 112.5, positionTime: 1791609902000, seq: 1
    };
    // 未装配时旧行为是 503；装配后必须是 401（错/缺 token）/ 202（正确 token）。
    assert.equal((await sendLocation(baseUrl, params, null)).status, 401);
    assert.equal((await sendLocation(baseUrl, params)).status, 202);
  } finally {
    await new Promise((resolve, reject) => runtime.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('without WEARABLE_LOCATION_TOKEN the endpoint stays explicitly unavailable (fail closed)', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wearable-contract-runtime-off-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const runtime = createRuntime(runtimeEnv(directory));
  assert.equal(runtime.wearableLocationConfigured, false);
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    const response = await sendLocation(baseUrl, { seq: 1, fixValid: 0, positionTime: 1 });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'wearable location unavailable' });
  } finally {
    await new Promise((resolve, reject) => runtime.server.close((error) => error ? reject(error) : resolve()));
  }
});
