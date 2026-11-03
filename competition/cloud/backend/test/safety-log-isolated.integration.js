'use strict';

/**
 * safety-log-isolated.integration.js — 本地隔离集成（可重复）
 *
 * 隔离措施：
 *   - 数据文件在系统临时目录，测试结束递归删除；不读写生产数据；
 *   - HTTP 只绑定 `127.0.0.1` 的随机端口，不连接公网、不发布 MQTT/HTTP ingest；
 *   - 测试告警是进程内 fixture，通过内部 ingest 路由写入临时文件；
 *   - tokenSecret / ingestKey / 口令都在进程内用 `crypto.randomBytes` 随机生成，
 *     **绝不打印、绝不落盘**；输出只包含计数与布尔结论。
 *
 * 验收点（合同 §5）：
 *   1. 三个新接口真实 HTTP 可用：POST/GET dispositions、GET safety-logs；
 *   2. 用同一数据文件重启后 `GET /api/v1/safety-logs` 仍能查到处置记录；
 *   3. 处置接口不生成 ACK 命令、不改变告警状态；既有 POST ack 仍返回 202 PENDING；
 *   4. 幂等重放不新增记录；ACKED 告警仍可登记处置。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseAppGuardianConfig } = require('../src/auth');
const { PersistentStore } = require('../src/persistent-store');
const { createApiServer } = require('../src/server');

const TOKEN_SECRET = crypto.randomBytes(48).toString('base64url');
const INGEST_KEY = crypto.randomBytes(48).toString('base64url');
const PASSWORD = crypto.randomBytes(48).toString('base64url');
const GUARDIAN_ID = 'isolated-safety-guardian';
const APP_AUTH = parseAppGuardianConfig(GUARDIAN_ID, PASSWORD);

const FIXTURE = Object.freeze({
  deviceId: 'isolated-fixture-node',
  room: '隔离测试厨房',
  online: true,
  monitorOnline: 1,
  state: 'ALARM',
  ts: 1_792_949_000_000,
  sensors: { gas: { ok: true } },
  alarm: { id: 'isolated-alarm-1', type: 'MANUAL_SOS', countToday: 1 }
});

async function startServer(filePath) {
  const store = new PersistentStore({ filePath });
  const created = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    appAuth: APP_AUTH,
    authorizeIdentity: (identity) => identity === APP_AUTH.subject
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  return {
    store,
    url: `http://127.0.0.1:${created.server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      if (closed) return resolve();
      closed = true;
      created.server.close((error) => error ? reject(error) : resolve());
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
  assert.equal(typeof body.sessionToken, 'string');
  return body.sessionToken;
}

async function ingest(baseUrl, status) {
  return fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify(status)
  });
}

async function listCommands(baseUrl) {
  const response = await fetch(`${baseUrl}/internal/v1/commands?after=0`, {
    headers: { 'x-ingest-key': INGEST_KEY }
  });
  assert.equal(response.status, 200);
  return (await response.json()).commands;
}

function api(baseUrl, token) {
  return {
    async postDisposition(alarmId, body) {
      return fetch(`${baseUrl}/api/v1/alerts/${encodeURIComponent(alarmId)}/dispositions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    },
    async getDispositions(alarmId) {
      return fetch(`${baseUrl}/api/v1/alerts/${encodeURIComponent(alarmId)}/dispositions`, {
        headers: { authorization: `Bearer ${token}` }
      });
    },
    async getSafetyLogs(query = '') {
      return fetch(`${baseUrl}/api/v1/safety-logs${query}`, {
        headers: { authorization: `Bearer ${token}` }
      });
    },
    async getAlerts() {
      const response = await fetch(`${baseUrl}/api/v1/alerts`, {
        headers: { authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      return (await response.json()).alerts;
    },
    async postAck(alarmId, note) {
      return fetch(`${baseUrl}/api/v1/alerts/${encodeURIComponent(alarmId)}/ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ note })
      });
    }
  };
}

test('isolated backend: dispositions persist across restart and never produce ACK commands', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-log-isolated-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');

  /* ---------------- 第一次启动：fixture -> 处置 -> 既有 ACK ------------- */
  const first = await startServer(filePath);
  t.after(() => first.close());

  assert.equal((await ingest(first.url, FIXTURE)).status, 202);
  const token = await login(first.url);
  const client = api(first.url, token);

  assert.deepEqual(await (await client.getSafetyLogs()).json(), { logs: [] });
  assert.equal((await listCommands(first.url)).length, 0);

  const created = await client.postDisposition('isolated-alarm-1', {
    clientDispositionId: 'disp-isolated-0001',
    outcome: 'CONTACTED_FAMILY',
    note: '隔离测试：已联系家属'
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.created, true);
  assert.equal(createdBody.disposition.dispositionId, 'dsp-1');
  assert.equal(createdBody.disposition.outcomeLabel, '已联系家属');
  assert.equal(createdBody.disposition.operatorRole, 'household-guardian');
  assert.ok(createdBody.disposition.serverTime > 0);

  // 幂等重放：200 duplicate，台账仍只有 1 条。
  const replay = await client.postDisposition('isolated-alarm-1', {
    clientDispositionId: 'disp-isolated-0001',
    outcome: 'CONTACTED_FAMILY',
    note: '隔离测试：已联系家属'
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);

  // 处置接口绝不生成 ACK 命令。
  assert.equal((await listCommands(first.url)).length, 0, '处置不得生成 ACK 命令');
  const alertsAfterDisposition = await client.getAlerts();
  const alertAfterDisposition = alertsAfterDisposition.find((item) => item.alarmId === 'isolated-alarm-1');
  assert.equal(alertAfterDisposition.state, 'ALARM');
  assert.equal(alertAfterDisposition.ackPending, false);

  // 既有 ACK 接口行为保持不变（202 PENDING），并可与处置共存（处置≠ACK）。
  const ack = await client.postAck('isolated-alarm-1', '隔离测试：既有 ACK');
  assert.equal(ack.status, 202);
  assert.equal((await ack.json()).status, 'PENDING');
  const commandsAfterAck = await listCommands(first.url);
  assert.equal(commandsAfterAck.length, 1);
  assert.equal(commandsAfterAck[0].command, 'ACK');
  assert.equal(commandsAfterAck[0].status, 'PENDING');

  const second = await client.postDisposition('isolated-alarm-1', {
    clientDispositionId: 'disp-isolated-0002',
    outcome: 'ON_SITE_CONFIRMED_NORMAL',
    note: '隔离测试：现场确认正常'
  });
  assert.equal(second.status, 201, 'ACK 挂起期间仍可登记处置');
  assert.equal((await listCommands(first.url)).length, 1, '第二次处置也不得生成新 ACK 命令');

  const dispositionsBeforeRestart = await (await client.getDispositions('isolated-alarm-1')).json();
  assert.equal(dispositionsBeforeRestart.dispositions.length, 2);
  await first.close();

  /* ---------------- 第二次启动：同一数据文件 -> 仍可查询 ------------- */
  const restarted = await startServer(filePath);
  t.after(() => restarted.close());
  const restartedToken = await login(restarted.url);
  const restartedClient = api(restarted.url, restartedToken);

  const logs = await (await restartedClient.getSafetyLogs()).json();
  assert.equal(logs.logs.length, 2, '重启后安全日志必须仍然可查（来自持久化台账）');
  assert.deepEqual(logs.logs.map((item) => item.dispositionId), ['dsp-2', 'dsp-1']);
  assert.equal(logs.logs.some((item) => item.note === '隔离测试：已联系家属'), true);

  const dispositionsAfterRestart = await (await restartedClient.getDispositions('isolated-alarm-1')).json();
  assert.equal(dispositionsAfterRestart.dispositions.length, 2);

  const commandsAfterRestart = await listCommands(restarted.url);
  assert.equal(commandsAfterRestart.length, 1, '重启后仍只有既有 ACK 命令，处置不产生命令');
  assert.equal(commandsAfterRestart[0].status, 'PENDING');

  const alertsAfterRestart = await restartedClient.getAlerts();
  const alertAfterRestart = alertsAfterRestart.find((item) => item.alarmId === 'isolated-alarm-1');
  assert.equal(alertAfterRestart.state, 'ALARM', '处置不得把告警改成 ACKED');
  assert.equal(alertAfterRestart.ackPending, true, '处置不得清 ackPending');

  // 数据文件仍在临时目录内，且不含任何测试密钥/身份。
  const snapshot = fs.readFileSync(filePath, 'utf8');
  for (const secret of [TOKEN_SECRET, INGEST_KEY, PASSWORD, 'openid', 'access_token']) {
    assert.equal(snapshot.includes(secret), false, '快照不得包含测试密钥或身份字段');
  }
  assert.equal(JSON.parse(snapshot).schemaVersion, 7);
  assert.equal(JSON.parse(snapshot).safetyLogs.length, 2);

  console.log(
    `[isolated] endpoints=3 dispositions=${dispositionsAfterRestart.dispositions.length} `
    + `safetyLogs=${logs.logs.length} ackCommands=${commandsAfterRestart.length} schema=7 restart=ok`
  );
});
