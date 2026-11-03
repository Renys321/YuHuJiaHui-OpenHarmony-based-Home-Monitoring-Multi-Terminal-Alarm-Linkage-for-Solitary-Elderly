'use strict';

/**
 * 独立隔离集成验证（Lead 执行，不复用 backend-dev 的测试脚本）。
 *
 * 原则：
 *   - 只在临时目录写测试数据文件，127.0.0.1 随机端口；
 *   - 告警 fixture 仅存在于本进程写入的临时快照，明确是 TEST 数据，不是生产记录；
 *   - 不连接公网、不发布 MQTT/HTTP ingest、不 ACK 任何既有/生产告警；
 *   - 测试 token 与 appAuth 口令在进程内随机生成，不输出、不落盘。
 *
 * 运行：node competition/evidence/2026-10-26-alert-disposition-safety-log/isolated-verify.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BACKEND_SRC = path.resolve(__dirname, '../../cloud/backend/src');
const { createApiServer } = require(path.join(BACKEND_SRC, 'server.js'));
const { PersistentStore } = require(path.join(BACKEND_SRC, 'persistent-store.js'));
const { createSessionToken, parseAppGuardianConfig } = require(path.join(BACKEND_SRC, 'auth.js'));

const RESULTS = [];
const ALARM_ID = 'alarm-test-disp-1';
const DEVICE_ID = 'esp32-test-disp';
const BASE = '/api/v1';

function record(name, ok, detail) {
  RESULTS.push({ name, ok: ok === true, detail: detail === undefined ? '' : detail });
  const mark = ok === true ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` :: ${detail}` : ''}`);
}

function assert(name, condition, detail) {
  record(name, condition === true, condition === true ? detail : `unexpected: ${detail}`);
  if (condition !== true) {
    const error = new Error(`assertion failed: ${name}`);
    error.assertion = true;
    throw error;
  }
}

function request(server, method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      method,
      path: urlPath,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text.length > 0 ? JSON.parse(text) : null; } catch (_) { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function clientId(suffix) {
  return `disp-test-${Date.now()}-${suffix}`;
}

async function main() {
  const startedAt = Date.now();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-safety-log-'));
  const dataFile = path.join(tempDir, 'backend-state.json');

  // 进程内随机凭据：绝不打印、绝不写文件。
  const tokenSecret = crypto.randomBytes(32).toString('hex');
  const appPassword = crypto.randomBytes(32).toString('hex');
  const subject = 'app:test-guardian';
  const token = createSessionToken(subject, tokenSecret);
  const appAuth = parseAppGuardianConfig('test-guardian', appPassword);

  /** TEST fixture 告警：仅写入本次临时快照。 */
  function seedFixture(store) {
    store.ingest({
      deviceId: DEVICE_ID,
      room: '测试房间',
      state: 'ALARM',
      ts: Date.now() - 60 * 1000,
      sensors: { motion: { lastActiveTs: 0, countToday: 0 } },
      alarm: { id: ALARM_ID, type: 'SOS', countToday: 1 }
    });
    // 第二条告警用于验证 clientDispositionId 只按 alarm 隔离。
    store.ingest({
      deviceId: DEVICE_ID,
      room: '测试房间',
      state: 'ALARM',
      ts: Date.now() - 30 * 1000,
      sensors: {},
      alarm: { id: 'alarm-test-disp-2', type: 'NO_MOTION', countToday: 1 }
    });
  }

  let store = new PersistentStore({ filePath: dataFile, contacts: [] });
  seedFixture(store);
  let service = createApiServer({
    store,
    tokenSecret,
    appAuth,
    authorizeIdentity: () => true
  });
  await listen(service.server);

  try {
    // 0) 未认证
    const noAuth = await request(service.server, 'GET', `${BASE}/safety-logs`);
    assert('未认证 GET safety-logs -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    // 1) 初始为空，不伪造
    const empty = await request(service.server, 'GET', `${BASE}/safety-logs`, token);
    assert('初始安全日志为空且返回 200', empty.status === 200 && Array.isArray(empty.json.logs) && empty.json.logs.length === 0,
      `status=${empty.status} logs=${empty.json && empty.json.logs && empty.json.logs.length}`);

    // 2) 首次登记处置
    const cid1 = clientId('a1');
    const created = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: cid1, outcome: 'CONTACTED_FAMILY', note: '已联系家属，老人安全' });
    assert('首次登记处置 -> 201', created.status === 201, `status=${created.status} body=${created.text.slice(0, 120)}`);
    const first = created.json && created.json.disposition ? created.json.disposition : null;
    assert('公开处置字段完整（alarmId/deviceId/room/outcome/label/operator/serverTime）',
      Boolean(first) &&
      first.alarmId === ALARM_ID &&
      first.deviceId === DEVICE_ID &&
      first.roomName === '测试房间' &&
      first.alarmType === 'SOS' &&
      first.outcome === 'CONTACTED_FAMILY' &&
      first.outcomeLabel === '已联系家属' &&
      first.operator === '家庭监护人' &&
      first.operatorRole === 'household-guardian' &&
      Number.isSafeInteger(first.serverTime) && first.serverTime > 0,
      first ? JSON.stringify(first).slice(0, 200) : 'no disposition');
    assert('处置 ID 形如 dsp-N', typeof first.dispositionId === 'string' && /^dsp-[1-9][0-9]{0,15}$/.test(first.dispositionId),
      first && first.dispositionId);
    assert('公开响应不包含 token/openid/口令字段',
      !/sessionToken|openid|password|authorization/i.test(created.text),
      'clean response');

    // 3) 幂等重放
    const replay = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: cid1, outcome: 'CONTACTED_FAMILY', note: '已联系家属，老人安全' });
    assert('同 clientDispositionId 同内容重放 -> 200 duplicate',
      replay.status === 200 && replay.json && replay.json.duplicate === true &&
      replay.json.disposition && replay.json.disposition.dispositionId === first.dispositionId,
      `status=${replay.status} body=${replay.text.slice(0, 120)}`);

    // 4) 同 ID 改内容 -> 409
    const conflict = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: cid1, outcome: 'FALSE_ALARM', note: '已联系家属，老人安全' });
    assert('同 clientDispositionId 改内容 -> 409', conflict.status === 409, `status=${conflict.status}`);

    // 5) 输入校验
    const badOutcome = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: clientId('bad1'), outcome: 'GAS_SAFE', note: 'x' });
    assert('非法 outcome -> 400', badOutcome.status === 400, `status=${badOutcome.status}`);
    const longNote = 'a'.repeat(201);
    const badNote = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: clientId('bad2'), outcome: 'OTHER', note: longNote });
    assert('note 201 字符 -> 400', badNote.status === 400, `status=${badNote.status}`);
    const otherEmpty = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: clientId('bad3'), outcome: 'OTHER', note: '   ' });
    assert('OTHER 且空说明 -> 400', otherEmpty.status === 400, `status=${otherEmpty.status}`);
    const control = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: clientId('bad4'), outcome: 'OTHER', note: '现场确认\u0001正常' });
    assert('note 含控制字符 -> 400', control.status === 400, `status=${control.status}`);
    const forged = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: clientId('bad5'), outcome: 'OTHER', note: 'x', operator: 'attacker' });
    assert('请求体伪造 operator 字段 -> 400', forged.status === 400, `status=${forged.status}`);
    const shortCid = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: 'short', outcome: 'OTHER', note: 'x' });
    assert('clientDispositionId 过短 -> 400', shortCid.status === 400, `status=${shortCid.status}`);

    // 6) 未知告警
    const unknown = await request(service.server, 'POST', `${BASE}/alerts/alarm-not-exist-disp/dispositions`, token,
      { clientDispositionId: clientId('u1'), outcome: 'FALSE_ALARM', note: 'x' });
    assert('未知告警登记处置 -> 404', unknown.status === 404, `status=${unknown.status}`);

    // 7) 查询单条告警处置记录
    const byAlarm = await request(service.server, 'GET', `${BASE}/alerts/${ALARM_ID}/dispositions`, token);
    assert('GET 单告警处置记录 -> 1 条', byAlarm.status === 200 && byAlarm.json.dispositions.length === 1,
      `status=${byAlarm.status} count=${byAlarm.json && byAlarm.json.dispositions.length}`);

    // 8) 处置不改变 ACK 状态/不生成 ACK 命令
    const alertAfterDisposition = store.getAlert(ALARM_ID);
    assert('登记处置后告警仍为 ALARM 且 ackPending=false',
      alertAfterDisposition.status === 'ALARM' && alertAfterDisposition.ackPending === false,
      `state=${alertAfterDisposition.status} ackPending=${alertAfterDisposition.ackPending}`);
    assert('登记处置未生成任何 ACK 命令', store.listCommands(0).length === 0,
      `commands=${store.listCommands(0).length}`);

    // 9) 既有 ACK 接口回归（同一隔离 fixture）
    const ack = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/ack`, token, { note: '隔离测试确认' });
    assert('既有 ACK -> 202 PENDING', ack.status === 202 && ack.json && ack.json.status === 'PENDING',
      `status=${ack.status} body=${ack.text.slice(0, 100)}`);
    const commandsAfterAck = store.listCommands(0);
    assert('ACK 生成 1 条 PENDING 命令', commandsAfterAck.length === 1 && commandsAfterAck[0].status === 'PENDING',
      `commands=${commandsAfterAck.length}`);
    const alertsWhilePending = await request(service.server, 'GET', `${BASE}/alerts`, token);
    const pendingView = alertsWhilePending.json.alerts.find((item) => item.alarmId === ALARM_ID);
    assert('ACK 提交后告警仍非 ACKED（202 不冒充已确认）',
      Boolean(pendingView) && pendingView.state === 'ALARM' && pendingView.ackPending === true,
      pendingView ? `state=${pendingView.state} ackPending=${pendingView.ackPending}` : 'missing alert');

    // 10) 待回执期间仍可登记处置（独立）
    const duringPending = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: clientId('p1'), outcome: 'ON_SITE_CONFIRMED_NORMAL', note: '现场确认正常' });
    assert('ACK 等待设备回执期间仍可登记处置 -> 201', duringPending.status === 201, `status=${duringPending.status}`);

    // 11) 设备真实回执 ACKED 后仍可登记处置
    store.completeCommand(commandsAfterAck[0].id, {
      status: 'ACKED',
      deviceState: {
        deviceId: DEVICE_ID,
        state: 'ACKED',
        ts: Date.now(),
        alarm: { id: ALARM_ID, type: 'SOS' }
      }
    });
    const alertAcked = store.getAlert(ALARM_ID);
    assert('设备回执后告警 ACKED', alertAcked.status === 'ACKED', `state=${alertAcked.status}`);
    const afterAcked = await request(service.server, 'POST', `${BASE}/alerts/${ALARM_ID}/dispositions`, token,
      { clientDispositionId: clientId('a2'), outcome: 'CONTACTED_COMMUNITY', note: '已联系社区' });
    assert('ACKED 后仍可登记处置 -> 201', afterAcked.status === 201, `status=${afterAcked.status}`);

    // 12) 历史列表与排序
    const logs = await request(service.server, 'GET', `${BASE}/safety-logs?limit=50`, token);
    assert('GET safety-logs -> 3 条', logs.status === 200 && logs.json.logs.length === 3,
      `status=${logs.status} count=${logs.json && logs.json.logs.length}`);
    const sorted = logs.json.logs.every((item, index, arr) => index === 0 ||
      (arr[index - 1].serverTime > item.serverTime ||
        (arr[index - 1].serverTime === item.serverTime && Number(arr[index - 1].dispositionId.slice(4)) > Number(item.dispositionId.slice(4)))));
    assert('安全日志按 serverTime 降序（同刻按 ID 降序）', sorted, 'order ok');
    const filtered = await request(service.server, 'GET', `${BASE}/safety-logs?alarmId=alarm-test-disp-2`, token);
    assert('按 alarmId 过滤只返回该告警记录', filtered.status === 200 && filtered.json.logs.length === 0,
      `status=${filtered.status} count=${filtered.json && filtered.json.logs.length}`);
    const limitOne = await request(service.server, 'GET', `${BASE}/safety-logs?limit=1`, token);
    assert('limit=1 生效', limitOne.status === 200 && limitOne.json.logs.length === 1, `count=${limitOne.json && limitOne.json.logs.length}`);

    // 13) 重启（同一数据文件）后仍可查询
    await close(service.server);
    store = new PersistentStore({ filePath: dataFile, contacts: [] });
    service = createApiServer({
      store,
      tokenSecret,
      appAuth,
      authorizeIdentity: () => true
    });
    await listen(service.server);
    const afterRestart = await request(service.server, 'GET', `${BASE}/safety-logs`, token);
    assert('backend 重启后安全日志仍可查（3 条）',
      afterRestart.status === 200 && afterRestart.json.logs.length === 3,
      `status=${afterRestart.status} count=${afterRestart.json && afterRestart.json.logs.length}`);
    const dispositionsAfterRestart = await request(service.server, 'GET', `${BASE}/alerts/${ALARM_ID}/dispositions`, token);
    assert('重启后单告警处置记录仍为 3 条',
      dispositionsAfterRestart.status === 200 && dispositionsAfterRestart.json.dispositions.length === 3,
      `count=${dispositionsAfterRestart.json && dispositionsAfterRestart.json.dispositions.length}`);
    assert('重启后 ACK 命令仍为 1 条（处置未新增命令）', store.listCommands(0).length === 1,
      `commands=${store.listCommands(0).length}`);
    const alertAfterRestart = await request(service.server, 'GET', `${BASE}/alerts`, token);
    const ackAlert = alertAfterRestart.json.alerts.find((item) => item.alarmId === ALARM_ID);
    assert('重启后 ACKED 状态与 acknowledgedAt/By 保留',
      ackAlert && ackAlert.state === 'ACKED' && ackAlert.acknowledgedAt > 0 && ackAlert.acknowledgedBy === 'household-guardian',
      ackAlert ? `state=${ackAlert.state} at=${ackAlert.acknowledgedAt} by=${ackAlert.acknowledgedBy}` : 'missing');

    // 14) 落盘快照检查
    const snapshotText = fs.readFileSync(dataFile, 'utf8');
    const snapshot = JSON.parse(snapshotText);
    assert('快照 schemaVersion=6 且含 safetyLogs 3 条',
      snapshot.schemaVersion === 6 && Array.isArray(snapshot.safetyLogs) && snapshot.safetyLogs.length === 3,
      `schemaVersion=${snapshot.schemaVersion} safetyLogs=${snapshot.safetyLogs && snapshot.safetyLogs.length}`);
    assert('快照不含 token/口令/openid 字段或会话 token 值',
      !snapshotText.includes(token) && !snapshotText.includes(appPassword) &&
      !/"sessionToken"|"password"|"openid"/.test(snapshotText),
      'snapshot clean');
    const trustedKeys = new Set(['schemaVersion', 'savedAt', 'devices', 'alerts', 'commands', 'contacts',
      'notifications', 'subscriptions', 'communications', 'safetyLogs']);
    assert('快照顶层只含白名单键',
      Object.keys(snapshot).every((key) => trustedKeys.has(key)),
      Object.keys(snapshot).join(','));
    const logKeys = new Set(['dispositionId', 'clientDispositionId', 'alarmId', 'deviceId', 'room', 'type',
      'outcome', 'note', 'actor', 'serverTime']);
    assert('安全日志记录只含白名单字段',
      snapshot.safetyLogs.every((item) => Object.keys(item).every((key) => logKeys.has(key))),
      Object.keys(snapshot.safetyLogs[0] || {}).join(','));

    // 15) v5 旧快照可加载
    const legacyFile = path.join(tempDir, 'legacy-v5.json');
    fs.writeFileSync(legacyFile, JSON.stringify({
      schemaVersion: 5,
      savedAt: Date.now(),
      devices: [],
      alerts: [],
      commands: [],
      contacts: [],
      notifications: [],
      subscriptions: [],
      communications: []
    }, null, 2));
    const legacyStore = new PersistentStore({ filePath: legacyFile, contacts: [] });
    const legacyLogs = legacyStore.listSafetyLogs ? legacyStore.listSafetyLogs({ limit: 50 }) : null;
    assert('v5 快照可加载且 safetyLogs 视为空账本', Array.isArray(legacyLogs) && legacyLogs.length === 0,
      `logs=${Array.isArray(legacyLogs) ? legacyLogs.length : 'missing method'}`);
  } finally {
    await close(service.server);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }

  const failed = RESULTS.filter((item) => item.ok !== true);
  const summary = {
    date: '2026-10-26',
    kind: 'ISOLATED_LOCAL_VERIFICATION',
    scope: 'local backend source + temp data file + 127.0.0.1 ephemeral port',
    fixture: {
      note: 'TEST fixture only, written into a temp file by this script; not production data',
      deviceId: DEVICE_ID,
      alarmIds: [ALARM_ID, 'alarm-test-disp-2']
    },
    noProductionActions: {
      mqttPublish: false,
      httpIngestToProduction: false,
      deviceOperations: false,
      existingAlarmAck: false,
      productionDeploy: false
    },
    startedAt,
    finishedAt: Date.now(),
    total: RESULTS.length,
    passed: RESULTS.length - failed.length,
    failed: failed.length,
    results: RESULTS,
    result: failed.length === 0 ? 'ISOLATED_PASS' : 'ISOLATED_FAIL'
  };
  const outPath = path.join(__dirname, 'ISOLATED-VERIFY.json');
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${summary.result}: ${summary.passed}/${summary.total} checks passed`);
  console.log(`written: ${outPath}`);
  if (failed.length !== 0) process.exitCode = 1;
}

main().catch((error) => {
  const failed = RESULTS.filter((item) => item.ok !== true);
  const summary = {
    date: '2026-10-26',
    kind: 'ISOLATED_LOCAL_VERIFICATION',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    total: RESULTS.length,
    passed: RESULTS.length - failed.length,
    failed: failed.length,
    results: RESULTS,
    error: error && error.message ? error.message : String(error),
    result: 'ISOLATED_FAIL'
  };
  fs.writeFileSync(path.join(__dirname, 'ISOLATED-VERIFY.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
});
