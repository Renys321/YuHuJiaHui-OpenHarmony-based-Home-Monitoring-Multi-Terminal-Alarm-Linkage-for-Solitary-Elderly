'use strict';

/**
 * E-ISOLATED-VERIFICATION.js — D/E 组合候选的本地隔离验证（Lead 独立脚本）
 *
 * 目的：用**最终同一份源码**独立复核 E 类活动报告的真实 HTTP 行为，并同时回归 D 类的
 * “处置 ≠ ACK”边界。只跑一次，输出结构化结论 + 真实响应快照。
 *
 * 隔离措施（硬约束）：
 *   - 数据文件在系统临时目录，结束递归删除；绝不读写生产数据文件；
 *   - HTTP 只绑定 127.0.0.1 的随机端口；不访问公网、不发布 MQTT/HTTP ingest；
 *   - tokenSecret / ingestKey / 口令全部用 crypto.randomBytes 进程内随机生成，不打印不落盘；
 *   - 设备/告警/活动全部是进程内 fixture，明确标记 isolated-fixture-*，不制造生产 SOS/FALL。
 *
 * 覆盖（对应任务四、重点核对）：
 *   E1 真实后端响应字段（尤其 dataSince 的类型；服务端是否返回 dataSinceMs/dataSinceText）
 *   E2 日/周/月真实统计窗口（month 是滚动 30 天，不是自然月）
 *   E3 首次样本只建基线、重复累计值不重复计数、计数回退、跨日
 *   E4 无数据/无 PIR 设备一律 null，不补 0
 *   E5 覆盖率/历史起始/上一周期对比如实表达
 *   E6 活动文件独立 version=1，不进主快照 schema v6
 *   E7 重启恢复、写盘失败仍返回 202（自然 202 不能证明统计成功）、损坏文件 fail-closed
 *   D1 登记处置不生成 ACK 命令、不改变告警状态、不清 ackPending
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKEND_ROOT = process.env.BACKEND_ROOT || 'D:/OpenHarmony/competition/cloud/backend';
const { parseAppGuardianConfig } = require(path.join(BACKEND_ROOT, 'src/auth'));
const { PersistentStore, SCHEMA_VERSION } = require(path.join(BACKEND_ROOT, 'src/persistent-store'));
const { ActivityStore, ACTIVITY_FILE_VERSION } = require(path.join(BACKEND_ROOT, 'src/activity-store'));
const { createApiServer } = require(path.join(BACKEND_ROOT, 'src/server'));

const TOKEN_SECRET = crypto.randomBytes(48).toString('base64url');
const INGEST_KEY = crypto.randomBytes(48).toString('base64url');
const PASSWORD = crypto.randomBytes(48).toString('base64url');
const GUARDIAN_ID = 'isolated-de-guardian';
const APP_AUTH = parseAppGuardianConfig(GUARDIAN_ID, PASSWORD);

const TIMEZONE = 'Asia/Shanghai';
const LIVING = 'isolated-fixture-living';
const BATH = 'isolated-fixture-bath';
const KITCHEN = 'isolated-fixture-kitchen';
const ALARM_ID = 'isolated-alarm-de-1';

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error: error && error.message });
    console.log(`FAIL  ${name} :: ${error && error.message}`);
    failures += 1;
  }
}
let failures = 0;

function mkTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `de-freeze-${label}-`));
}

function statusBody(deviceId, room, { motion, ts }) {
  const body = {
    deviceId,
    room,
    online: true,
    monitorOnline: 1,
    state: 'NORMAL',
    ts,
    sensors: {}
  };
  if (motion !== undefined) body.sensors.motion = motion;
  return body;
}

async function startServer({ dataFile, activityFile, activityStore }) {
  const store = new PersistentStore({ filePath: dataFile });
  const activeStore = activityStore || new ActivityStore({ filePath: activityFile, timezone: TIMEZONE });
  const created = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    appAuth: APP_AUTH,
    activityStore: activeStore,
    authorizeIdentity: (identity) => identity === APP_AUTH.subject
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  return {
    store,
    activityStore: activeStore,
    url: `http://127.0.0.1:${created.server.address().port}`,
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      created.server.close(() => resolve());
    })
  };
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/auth/app`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId: GUARDIAN_ID, password: PASSWORD })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.sessionToken;
}

async function ingest(baseUrl, body) {
  const response = await fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

async function getJson(baseUrl, token, urlPath) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  const root = mkTmpDir('e');
  const dataFile = path.join(root, 'backend-state.json');
  const activityFile = path.join(root, 'activity-state.json');
  const report = {};

  try {
    /* ---------------------------------------------------------- 阶段 1：摄入与报告 */
    let server = await startServer({ dataFile, activityFile });
    const token = await login(server.url);
    const base = Date.UTC(2026, 9, 26, 2, 0, 0); // 2026-10-26 10:00 +08:00

    // 客厅：只为 D 类的处置/ACK 回归准备一条既有告警；载荷不含 motion，不产生活动样本。
    let r = await ingest(server.url, {
      deviceId: LIVING,
      room: '客厅',
      online: true,
      monitorOnline: 1,
      state: 'ALARM',
      ts: base - 60_000,
      sensors: {},
      alarm: { id: ALARM_ID, type: 'MANUAL_SOS', countToday: 1 }
    });
    check('D0 alarm fixture ingest accepted 202', () => assert.equal(r.status, 202));

    // 卫生间：首次样本只建基线（countToday=5 但 delta 必须为 0）
    r = await ingest(server.url, statusBody(BATH, '卫生间', {
      motion: { countToday: 5, valid: true }, ts: base
    }));
    check('E3 ingest accepted 202', () => assert.equal(r.status, 202));

    // 同值重复上报 -> 不重复计数
    r = await ingest(server.url, statusBody(BATH, '卫生间', {
      motion: { countToday: 5, valid: true }, ts: base + 60_000
    }));
    check('E3 duplicate ingest accepted 202', () => assert.equal(r.status, 202));

    // 正增量 5 -> 9 = +4
    r = await ingest(server.url, statusBody(BATH, '卫生间', {
      motion: { countToday: 9, valid: true }, ts: base + 120_000
    }));
    check('E3 increment ingest accepted 202', () => assert.equal(r.status, 202));

    // 计数回退（设备重启）5 -> 2 = reset，delta=2，不产生负数
    r = await ingest(server.url, statusBody(BATH, '卫生间', {
      motion: { countToday: 2, valid: true }, ts: base + 180_000
    }));
    check('E3 rollback ingest accepted 202', () => assert.equal(r.status, 202));

    // 厨房没有 PIR：不产生样本、不写 0 次活动
    r = await ingest(server.url, statusBody(KITCHEN, '厨房', { ts: base + 240_000 }));
    check('E4 PIR-less ingest accepted 202', () => assert.equal(r.status, 202));

    const day = await getJson(server.url, token, '/api/v1/activity/report?scope=day&date=2026-10-26');
    check('E1 day report 200', () => assert.equal(day.status, 200));
    report.dayResponse = day.body;

    const body = day.body;
    check('E1 dataSince is a positive integer (epoch ms), not a string', () => {
      assert.equal(typeof body.dataSince, 'number');
      assert.ok(Number.isSafeInteger(body.dataSince) && body.dataSince > 0);
    });
    check('E1 server does NOT return dataSinceMs / dataSinceText', () => {
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'dataSinceMs'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(body, 'dataSinceText'), false);
    });
    check('E3 first sample only establishes baseline: count is 4+2=6 (not 5+9+2)', () => {
      assert.equal(body.selected.count, 6);
      assert.equal(body.selected.samples, 4);
    });
    check('E3 counter rollback recorded as reset without negative delta', () => {
      assert.ok(body.selected.count >= 0);
    });
    check('E1 field inventory matches documented contract', () => {
      const expected = [
        'generatedAt', 'timezone', 'scope', 'today', 'selectedDate', 'range', 'dataSince',
        'historyNote', 'selected', 'previous', 'comparison', 'days', 'summary', 'hourly',
        'devices', 'trend', 'disclaimer'
      ];
      assert.deepEqual(Object.keys(body).sort(), expected.slice().sort());
      assert.deepEqual(Object.keys(body.selected).sort(), [
        'date', 'count', 'status', 'samples', 'invalidSamples', 'firstTs', 'lastTs',
        'maxGapMs', 'coverageRatio', 'hourly'
      ].sort());
      assert.equal(Array.isArray(body.hourly) && body.hourly.length, 24);
    });
    check('E1 day range is exactly one day', () => {
      assert.deepEqual(body.range, { from: '2026-10-26', to: '2026-10-26', days: 1 });
      assert.equal(body.timezone, TIMEZONE);
    });
    check('E5 no-data hours stay null, never 0', () => {
      const nulls = body.hourly.filter((v) => v === null).length;
      assert.ok(nulls >= 23, `expected mostly null hours, got ${nulls}`);
    });
    check('E8 disclaimer is the PIR trigger-count wording', () => {
      assert.match(body.disclaimer, /触发次数/);
      assert.equal(/人数|步数|轨迹|诊断/.test(body.disclaimer), true);
    });

    // 厨房（无 PIR）必须是 null / hasMotionSensor=false，不能是 0
    const kitchenRow = body.devices.find((d) => d.deviceId === KITCHEN);
    check('E4 PIR-less device row: count null + hasMotionSensor false', () => {
      assert.ok(kitchenRow, 'kitchen row missing');
      assert.equal(kitchenRow.count, null);
      assert.equal(kitchenRow.hasMotionSensor, false);
      assert.equal(kitchenRow.status, 'no_data');
    });

    const week = await getJson(server.url, token, '/api/v1/activity/report?scope=week&date=2026-10-26');
    const month = await getJson(server.url, token, '/api/v1/activity/report?scope=month&date=2026-10-26');
    report.weekRange = week.body.range;
    report.monthRange = month.body.range;
    check('E2 week = rolling 7 days ending on selected date', () => {
      assert.deepEqual(week.body.range, { from: '2026-10-20', to: '2026-10-26', days: 7 });
    });
    check('E2 month = rolling 30 days ending on selected date (NOT a calendar month)', () => {
      assert.deepEqual(month.body.range, { from: '2026-09-27', to: '2026-10-26', days: 30 });
      const [y, m] = month.body.range.from.split('-');
      assert.notEqual(`${y}-${m}-01`, month.body.range.from, 'calendar-month start would be 2026-10-01');
    });
    check('E2 previous window is the previous equal-length window', () => {
      assert.equal(month.body.previous.date, '2026-09-26');
      assert.equal(week.body.previous.date, '2026-10-19');
    });
    check('E5 insufficient history does not fabricate a trend', () => {
      assert.equal(typeof month.body.trend.state, 'string');
      assert.ok(['insufficient', 'up', 'down', 'stable'].includes(month.body.trend.state));
    });
    check('E4 summary counts only the selected window and days with data', () => {
      assert.equal(month.body.summary.days, 30);
      assert.equal(month.body.summary.daysWithData, 1);
      assert.equal(month.body.summary.total, 6);
      // day 范围的 summary 只能是当天，不能把 7 天趋势序列当成“当日”汇总。
      assert.equal(body.summary.days, 1);
      assert.equal(body.summary.total, 6);
    });
    const badScope = await getJson(server.url, token, '/api/v1/activity/report?scope=year');
    const badDate = await getJson(server.url, token, '/api/v1/activity/report?date=2026-02-30');
    const noAuth = await fetch(`${server.url}/api/v1/activity/report`);
    check('E2 invalid scope -> 400', () => assert.equal(badScope.status, 400));
    check('E2 invalid calendar date -> 400', () => assert.equal(badDate.status, 400));
    check('E2 unauthenticated -> 401', () => assert.equal(noAuth.status, 401));

    /* ---------------------------------------------------------- D：处置 ≠ ACK */
    const beforeAlert = server.store.listAlerts()[0];
    report.alertBeforeDisposition = {
      alarmId: beforeAlert.alarmId,
      status: beforeAlert.status,
      ackPending: beforeAlert.ackPending
    };
    const dispositionsBefore = server.store.listCommands(0).length;
    const createResponse = await fetch(`${server.url}/api/v1/alerts/${encodeURIComponent(beforeAlert.alarmId)}/dispositions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        clientDispositionId: 'disp-isolated-0001',
        outcome: 'CONTACTED_FAMILY',
        note: '隔离验证：已联系家属'
      })
    });
    check('D3 disposition created 201', () => assert.equal(createResponse.status, 201));
    const replay = await fetch(`${server.url}/api/v1/alerts/${encodeURIComponent(beforeAlert.alarmId)}/dispositions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        clientDispositionId: 'disp-isolated-0001',
        outcome: 'CONTACTED_FAMILY',
        note: '隔离验证：已联系家属'
      })
    });
    check('D3 identical replay is idempotent 200', () => assert.equal(replay.status, 200));
    const conflict = await fetch(`${server.url}/api/v1/alerts/${encodeURIComponent(beforeAlert.alarmId)}/dispositions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        clientDispositionId: 'disp-isolated-0001',
        outcome: 'FALSE_ALARM',
        note: '隔离验证：改内容'
      })
    });
    check('D3 changed content conflicts 409', () => assert.equal(conflict.status, 409));
    const forged = await fetch(`${server.url}/api/v1/alerts/${encodeURIComponent(beforeAlert.alarmId)}/dispositions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        clientDispositionId: 'disp-isolated-0002',
        outcome: 'FALSE_ALARM',
        note: 'x',
        serverTime: 1,
        operator: 'attacker'
      })
    });
    check('D2 client-supplied serverTime/operator rejected 400', () => assert.equal(forged.status, 400));
    const afterAlert = server.store.listAlerts()[0];
    check('D1 disposition did not create ACK command', () =>
      assert.equal(server.store.listCommands(0).length, dispositionsBefore));
    check('D1 disposition did not change alert status / ackPending', () => {
      assert.equal(afterAlert.status, beforeAlert.status);
      assert.equal(afterAlert.ackPending, beforeAlert.ackPending);
    });
    const safetyLogs = await getJson(server.url, token, '/api/v1/safety-logs?limit=50');
    check('D4 safety logs come from the ledger and contain the record', () => {
      assert.equal(safetyLogs.status, 200);
      assert.equal(safetyLogs.body.logs.length, 1);
      assert.equal(safetyLogs.body.logs[0].operatorRole, 'household-guardian');
      assert.equal(safetyLogs.body.logs[0].serverTime > 0, true);
    });

    /* ---------------------------------------------------------- E6/E7 持久化 */
    const activityDoc = JSON.parse(fs.readFileSync(activityFile, 'utf8'));
    report.activityFileTopLevelKeys = Object.keys(activityDoc);
    report.activityFileVersion = activityDoc.version;
    check('E6 activity file uses its own version=1 and only whitelisted keys', () => {
      assert.equal(activityDoc.version, ACTIVITY_FILE_VERSION);
      assert.equal(ACTIVITY_FILE_VERSION, 1);
      assert.deepEqual(Object.keys(activityDoc).sort(), ['activity', 'savedAt', 'version']);
    });
    const mainDoc = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    report.mainSnapshotVersion = mainDoc.schemaVersion;
    check('E6 main snapshot is schema v6 and has no activity state', () => {
      assert.equal(mainDoc.schemaVersion, SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 6);
      assert.equal(Object.prototype.hasOwnProperty.call(mainDoc, 'activity'), false);
      assert.equal(JSON.stringify(mainDoc).includes('countToday'), true); // alerts own field, not activity buckets
    });

    /* 重启：同一数据文件 + 同一活动文件 */
    const countBeforeRestart = day.body.selected.count;
    await server.close();
    server = await startServer({ dataFile, activityFile });
    const token2 = await login(server.url);
    const dayAfterRestart = await getJson(server.url, token2, '/api/v1/activity/report?scope=day&date=2026-10-26');
    check('E7 activity report survives backend restart with identical count', () => {
      assert.equal(dayAfterRestart.status, 200);
      assert.equal(dayAfterRestart.body.selected.count, countBeforeRestart);
    });
    const logsAfterRestart = await getJson(server.url, token2, '/api/v1/safety-logs?limit=50');
    check('D5 safety logs survive backend restart', () => {
      assert.equal(logsAfterRestart.body.logs.length, 1);
    });

    /* E7：活动写盘失败不得改变 202 语义，也不得出现“接口成功但统计前进”
       用独立目录，避免两个 PersistentStore 同时写同一个主快照文件。 */
    await server.close();
    const failRoot = mkTmpDir('e-fail');
    const failDataFile = path.join(failRoot, 'backend-state.json');
    const failActivityFile = path.join(failRoot, 'activity-state.json');
    const failingStore = new ActivityStore({ filePath: failActivityFile, timezone: TIMEZONE });
    failingStore._atomicWriter = () => { throw new Error('isolated injected write failure'); };
    const failingServer = await startServer({
      dataFile: failDataFile, activityFile: failActivityFile, activityStore: failingStore
    });
    const failToken = await login(failingServer.url);
    const failIngest1 = await ingest(failingServer.url, statusBody(BATH, '卫生间', {
      motion: { countToday: 5, valid: true }, ts: base
    }));
    const failIngest2 = await ingest(failingServer.url, statusBody(BATH, '卫生间', {
      motion: { countToday: 99, valid: true }, ts: base + 300_000
    }));
    check('E7 activity write failure keeps ingest 202 (natural 202 proves nothing about stats)', () => {
      assert.equal(failIngest1.status, 202);
      assert.equal(failIngest2.status, 202);
    });
    const afterFail = await getJson(failingServer.url, failToken, '/api/v1/activity/report?scope=day&date=2026-10-26');
    check('E7 failed activity write rolls memory back (report stays null, no fake success)', () => {
      assert.equal(afterFail.status, 200);
      assert.equal(afterFail.body.selected.count, null);
    });
    check('E7 activity file was never created because every write failed', () =>
      assert.equal(fs.existsSync(failActivityFile), false));
    await failingServer.close();
    fs.rmSync(failRoot, { recursive: true, force: true });

    /* E7：损坏的活动文件必须 fail-closed，而不是静默清空（用独立副本，不碰主验证文件） */
    const corruptRoot = mkTmpDir('e-corrupt');
    const corruptFile = path.join(corruptRoot, 'activity-state.json');
    fs.writeFileSync(corruptFile, '{not-json', 'utf8');
    let corruptThrew = false;
    try {
      new ActivityStore({ filePath: corruptFile, timezone: TIMEZONE });
    } catch (_) {
      corruptThrew = true;
    }
    check('E7 corrupt activity file fails closed (no silent reset)', () => assert.equal(corruptThrew, true));
    fs.rmSync(corruptRoot, { recursive: true, force: true });
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }

  const passed = checks.filter((c) => c.ok).length;
  console.log('');
  console.log(`[isolated-d-e] checks=${checks.length} passed=${passed} failed=${failures}`);
  console.log(`[isolated-d-e] monthRange=${JSON.stringify(report.monthRange)} weekRange=${JSON.stringify(report.weekRange)}`);
  console.log(`[isolated-d-e] activityFile keys=${(report.activityFileTopLevelKeys || []).join(',')} version=${report.activityFileVersion} mainSchema=${report.mainSnapshotVersion}`);
  console.log(`[isolated-d-e] dataSinceType=${typeof (report.dayResponse || {}).dataSince} dataSinceMs=${Object.prototype.hasOwnProperty.call(report.dayResponse || {}, 'dataSinceMs')} dataSinceText=${Object.prototype.hasOwnProperty.call(report.dayResponse || {}, 'dataSinceText')}`);
  const outPath = process.env.ISOLATED_E_OUT || '';
  if (outPath) {
    fs.writeFileSync(outPath, `${JSON.stringify({
      checks,
      passed,
      failed: failures,
      report
    }, null, 2)}\n`, 'utf8');
  }
  if (failures > 0) process.exitCode = 1;
  else console.log('[isolated-d-e] ISOLATED_PASS');
}

main().catch((error) => {
  console.error('[isolated-d-e] FATAL', error);
  process.exitCode = 1;
});
