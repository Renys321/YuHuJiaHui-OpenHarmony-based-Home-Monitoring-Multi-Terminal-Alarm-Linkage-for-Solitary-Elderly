#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { HOUSEHOLD_ACTOR, createApiServer } = require('../backend/src/server');
const { createCommandSync } = require('./command-sync');

const TOKEN_SECRET = 'integration-token-secret-that-is-at-least-32-chars';
const INGEST_KEY = 'integration-ingest-key';
const DEVICE_ID = 'esp32-bedroom';
const ALARM_ID = 'alarm-bedroom-e2e-1';

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { status: response.status, body };
}

async function main() {
  let checks = 0;
  const pass = (condition, message) => {
    assert.ok(condition, message);
    checks += 1;
    console.log(`  PASS  ${message}`);
  };

  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === 'family-user-e2e',
    wechat: {
      appId: 'wx-integration',
      appSecret: 'server-only-test-secret',
      fetchImpl: async () => ({ ok: true, json: async () => ({ openid: 'family-user-e2e' }) })
    }
  });
  const server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('=== 小程序 ACK -> 后端队列 -> 边缘同步器 -> 模拟设备 -> 后端闭环 ===');

    const alarmStatus = {
      deviceId: DEVICE_ID,
      room: '卧室',
      online: true,
      state: 'ALARM',
      ts: 1791609400000,
      alarm: { id: ALARM_ID, type: 'NO_MOTION', countToday: 1 }
    };
    const ingest = await jsonRequest(`${baseUrl}/internal/v1/device-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
      body: JSON.stringify(alarmStatus)
    });
    pass(ingest.status === 202, '告警状态进入真实后端 HTTP 接口');

    const login = await jsonRequest(`${baseUrl}/api/v1/auth/wechat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'wx-single-use-code' })
    });
    pass(login.status === 200 && typeof login.body.sessionToken === 'string', '模拟小程序完成微信短会话登录');
    const auth = { authorization: `Bearer ${login.body.sessionToken}` };

    const ack = await jsonRequest(`${baseUrl}/api/v1/alerts/${ALARM_ID}/ack`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ note: '家属已电话确认老人安全' })
    });
    pass(ack.status === 202 && ack.body.status === 'PENDING', '小程序 ACK 只进入 PENDING 队列，不伪造设备成功');
    pass(typeof ack.body.commandId === 'string', '后端返回稳定命令编号');

    const published = [];
    let sync;
    sync = createCommandSync({
      backendUrl: baseUrl,
      ingestKey: INGEST_KEY,
      ackTimeoutMs: 500,
      maxAttempts: 1,
      publisher: async (topic, payload) => {
        published.push({ topic, payload });
        queueMicrotask(() => sync.observe({
          ...alarmStatus,
          state: 'ACKED',
          ts: 1791609401000
        }));
      }
    });

    const cycle = await sync.pollOnce();
    pass(cycle.ok === true && cycle.processed === 1, '边缘同步器拉取并结算一条命令');
    pass(published.length === 1, '同一命令只向设备发布一次');
    pass(published[0].topic === `home/${DEVICE_ID}/cmd`, '命令精确定向目标设备主题');
    pass(published[0].payload.cmd === 'ack' && published[0].payload.alarmId === ALARM_ID,
      '下行载荷精确绑定 ACK 与 alarmId');
    pass(published[0].payload.action === '家属已电话确认老人安全', '中文处置说明未被错误丢弃');

    const alerts = await jsonRequest(`${baseUrl}/api/v1/alerts`, { headers: auth });
    const closed = alerts.body.alerts.find((item) => item.id === ALARM_ID);
    pass(closed && closed.state === 'ACKED', '真实后端仅在模拟设备回执后关闭告警');
    pass(closed.ackPending === false, '闭环后清除 ackPending');
    pass(closed.acknowledgedBy === HOUSEHOLD_ACTOR, '闭环只保留家庭监护人角色，不持久化 openid');

    await sync.pollOnce();
    pass(published.length === 1, '重复轮询不重复下发已结算命令');

    console.log(`\nRESULT: ${checks}/${checks} checks passed`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
