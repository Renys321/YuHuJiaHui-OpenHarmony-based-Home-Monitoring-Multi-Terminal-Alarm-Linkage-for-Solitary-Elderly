#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PersistentStore } = require('../backend/src/persistent-store');
const { HOUSEHOLD_ACTOR, createApiServer } = require('../backend/src/server');
const { createCommandSync } = require('./command-sync');

const TOKEN_SECRET = 'persistent-chain-token-secret-at-least-32-characters';
const INGEST_KEY = 'persistent-chain-ingest-key';
const DEVICE_ID = 'esp32-bedroom';
const ALARM_ID = 'alarm-persistent-chain-1';

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}

async function startBackend(filePath) {
  const store = new PersistentStore({ filePath });
  const created = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === 'family-persistent-chain',
    wechat: {
      appId: 'wx-persistent-chain',
      appSecret: 'persistent-chain-server-secret',
      fetchImpl: async () => ({ ok: true, json: async () => ({ openid: 'family-persistent-chain' }) })
    }
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${created.server.address().port}`,
    close: () => new Promise((resolve, reject) => created.server.close((error) => error ? reject(error) : resolve()))
  };
}

async function login(baseUrl) {
  return jsonRequest(`${baseUrl}/api/v1/auth/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'persistent_chain_login' })
  });
}

async function main() {
  let checks = 0;
  const pass = (condition, message) => {
    assert.ok(condition, message);
    checks += 1;
    console.log(`  PASS  ${message}`);
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-persistent-chain-'));
  const filePath = path.join(directory, 'backend-state.json');
  let backend = null;

  const alarmStatus = {
    deviceId: DEVICE_ID,
    room: '卧室',
    online: true,
    state: 'ALARM',
    ts: 1791609600000,
    alarm: { id: ALARM_ID, type: 'NO_MOTION', countToday: 1 }
  };

  try {
    console.log('=== 持久化后端重启 -> ACK 队列恢复 -> 边缘同步 -> 再重启查询 ===');

    backend = await startBackend(filePath);
    const ingested = await jsonRequest(`${backend.baseUrl}/internal/v1/device-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
      body: JSON.stringify(alarmStatus)
    });
    pass(ingested.status === 202, '第一进程持久化设备告警');
    const firstLogin = await login(backend.baseUrl);
    pass(firstLogin.status === 200, '第一进程完成小程序短会话登录');
    const queued = await jsonRequest(`${backend.baseUrl}/api/v1/alerts/${ALARM_ID}/ack`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${firstLogin.body.sessionToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ note: '重启后继续下发' })
    });
    pass(queued.status === 202 && queued.body.commandId === '1', '第一进程持久化 PENDING ACK 命令');
    await backend.close();
    backend = null;

    backend = await startBackend(filePath);
    const restoredCommands = await jsonRequest(`${backend.baseUrl}/internal/v1/commands?after=0`, {
      headers: { 'x-ingest-key': INGEST_KEY }
    });
    pass(restoredCommands.body.commands.length === 1, '第二进程恢复一条命令');
    pass(restoredCommands.body.commands[0].status === 'PENDING', '重启后命令仍为 PENDING');

    const published = [];
    let sync;
    sync = createCommandSync({
      backendUrl: backend.baseUrl,
      ingestKey: INGEST_KEY,
      ackTimeoutMs: 500,
      maxAttempts: 1,
      publisher: async (topic, payload) => {
        published.push({ topic, payload });
        queueMicrotask(() => sync.observe({ ...alarmStatus, state: 'ACKED', ts: 1791609601000 }));
      }
    });
    const cycle = await sync.pollOnce();
    pass(cycle.ok === true && cycle.processed === 1, '同步器处理恢复出来的命令');
    pass(published.length === 1, '恢复命令只下发一次');
    pass(published[0].topic === `home/${DEVICE_ID}/cmd`, '恢复命令仍精确定向原设备');
    pass(published[0].payload.alarmId === ALARM_ID, '恢复命令仍绑定原 alarmId');
    await backend.close();
    backend = null;

    backend = await startBackend(filePath);
    const finalLogin = await login(backend.baseUrl);
    const alerts = await jsonRequest(`${backend.baseUrl}/api/v1/alerts`, {
      headers: { authorization: `Bearer ${finalLogin.body.sessionToken}` }
    });
    const alert = alerts.body.alerts.find((item) => item.alarmId === ALARM_ID);
    pass(alert && alert.state === 'ACKED', '第三进程恢复 ACKED 告警');
    pass(alert.ackPending === false, '第三进程确认 pending 已清除');
    pass(alert.acknowledgedBy === HOUSEHOLD_ACTOR, '重启后只保留处置角色，不持久化 openid');

    const finalCommands = await jsonRequest(`${backend.baseUrl}/internal/v1/commands?after=0`, {
      headers: { 'x-ingest-key': INGEST_KEY }
    });
    pass(finalCommands.body.commands[0].status === 'ACKED', '第三进程恢复命令终态');
    const snapshot = fs.readFileSync(filePath, 'utf8');
    pass(!snapshot.includes(TOKEN_SECRET) && !snapshot.includes(INGEST_KEY), '持久化文件不包含运行时密钥');

    console.log(`\nRESULT: ${checks}/${checks} checks passed`);
  } finally {
    if (backend) await backend.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
