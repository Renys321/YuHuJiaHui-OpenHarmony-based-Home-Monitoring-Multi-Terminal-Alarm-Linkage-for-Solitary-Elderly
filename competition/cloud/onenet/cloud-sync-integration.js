#!/usr/bin/env node
/**
 * cloud-sync-integration.js — 网关 -> 可信后端 的真实端到端验收
 *
 * 验证的是产业链里此前缺失的一环：
 *   网关聚合状态 -> POST /internal/v1/device-status -> 后端内存存储 -> 小程序用的查询接口
 *
 * 全部使用真实实现（真实后端 HTTP 服务 + 真实 cloud-sync HTTP 客户端），只是在本进程内
 * 同时充当“后端”和“客户端”，因此不需要公网、不需要凭据。密钥只在进程内生成/传递，不落盘。
 *
 * 用法：node cloud-sync-integration.js
 */
'use strict';

const path = require('node:path');

const { createApiServer } = require(path.join(__dirname, '..', 'backend', 'src', 'server'));
const { createSessionToken } = require(path.join(__dirname, '..', 'backend', 'src', 'auth'));
const { createCloudSync } = require('./cloud-sync');

const INGEST_KEY = 'integration-ingest-key-not-a-real-secret';
const TOKEN_SECRET = 'integration-token-secret-not-a-real-secret';
const NPC_APP_ID = 'integration-app-id';
const NPC_APP_SECRET = 'integration-app-secret';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log('='.repeat(66));
  console.log('网关 -> 可信后端 端到端验收（真实后端 + 真实 cloud-sync）');
  console.log('='.repeat(66));

  const { server, store } = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === 'openid-integration',
    contacts: [],
    wechat: { appId: NPC_APP_ID, appSecret: NPC_APP_SECRET }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`backend : ${baseUrl} (真实 HTTP 服务)`);
  console.log('');

  const sync = createCloudSync({ backendUrl: baseUrl, ingestKey: INGEST_KEY });
  check('sync client is enabled with the ingest key', sync.enabled === true);

  // ---- 1. 网关侧正常状态上云
  const normal = {
    deviceId: 'dayu200-living', room: '客厅', online: true, state: 'NORMAL',
    alarm: { id: '', type: '', countToday: 0 }
  };
  const r1 = await sync.publish(normal, 1791609077775);
  check('normal device status accepted by the backend', r1.ok && r1.statusCode === 202, JSON.stringify(r1));

  // ---- 2. 告警状态上云 -> 后端应生成一条待处理告警
  const alarm = {
    deviceId: 'dayu200-living', room: '客厅', online: true, state: 'ALARM',
    alarm: { id: 'a-1609503903-8', type: 'MANUAL_SOS', countToday: 1 }
  };
  const r2 = await sync.publish(alarm, 1791609078775);
  check('alarm device status accepted by the backend', r2.ok && r2.statusCode === 202, JSON.stringify(r2));

  // ---- 3. 错误的 ingest key 必须被拒（安全边界）
  const wrongKey = createCloudSync({ backendUrl: baseUrl, ingestKey: 'wrong-key' });
  const r3 = await wrongKey.publish(alarm, 1791609079775);
  check('a wrong ingest key is rejected (401), not silently accepted',
    r3.ok === false && r3.statusCode === 401, JSON.stringify(r3));

  // ---- 4. 小程序视角：用会话令牌读查询接口
  const token = createSessionToken('openid-integration', TOKEN_SECRET);
  const authHeaders = { authorization: `Bearer ${token}` };

  const overviewRes = await fetch(`${baseUrl}/api/v1/overview`, { headers: authHeaders });
  const overview = await overviewRes.json();
  check('the mini-program can authenticate to the backend', overviewRes.status === 200, `status=${overviewRes.status}`);

  const devicesRes = await fetch(`${baseUrl}/api/v1/devices`, { headers: authHeaders });
  const devices = await devicesRes.json();
  const device = (devices.devices || []).find((d) => d.deviceId === 'dayu200-living');
  check('the device synced by the gateway is visible to the mini-program', Boolean(device),
    JSON.stringify(devices.devices || []).slice(0, 200));
  if (device) {
    // 后端返回的公开设备结构用 roomName/state（不是 room/status）
    check('the mini-program sees the correct room', device.roomName === '客厅', `roomName=${device.roomName}`);
    check('the mini-program sees the correct state', device.state === 'ALARM', `state=${device.state}`);
  }

  const alertsRes = await fetch(`${baseUrl}/api/v1/alerts`, { headers: authHeaders });
  const alerts = await alertsRes.json();
  const alert = (alerts.alerts || []).find((a) => a.alarmId === 'a-1609503903-8');
  check('the alarm raised by the gateway became a visible alert', Boolean(alert),
    JSON.stringify(alerts.alerts || []).slice(0, 200));

  // ---- 5. 告警闭环：ACKED 状态应更新同一条告警
  const acked = {
    deviceId: 'dayu200-living', room: '客厅', online: true, state: 'ACKED',
    alarm: { id: 'a-1609503903-8', type: 'MANUAL_SOS', countToday: 1 }
  };
  await sync.publish(acked, 1791609079775);
  const afterRes = await fetch(`${baseUrl}/api/v1/alerts`, { headers: authHeaders });
  const after = await afterRes.json();
  const ackedAlert = (after.alerts || []).find((a) => a.alarmId === 'a-1609503903-8');
  // 告警对象用 state 表示状态（后端对外字段名），不是 status
  check('an ACKED sync settles the same alert instead of duplicating it',
    Boolean(ackedAlert) && ackedAlert.state === 'ACKED' && (after.alerts || []).length === (alerts.alerts || []).length,
    `state=${ackedAlert && ackedAlert.state} alerts=${(after.alerts || []).length}`);

  // ---- 6. 后端不可达时不得影响网关（旁路语义）
  const deadSync = createCloudSync({ backendUrl: 'http://127.0.0.1:1', ingestKey: INGEST_KEY, timeoutMs: 2000 });
  const r6 = await deadSync.publish(normal, 1791609080775);
  check('an unreachable backend degrades to a safe failure (no throw)', r6.ok === false && typeof r6.code === 'string',
    JSON.stringify(r6));

  // ---- 7. 后端中途关闭后仍不得抛出
  await new Promise((resolve) => server.close(resolve));
  const r7 = await sync.publish(normal, 1791609081775);
  check('after the backend stops, sync fails safely', r7.ok === false && typeof r7.code === 'string', JSON.stringify(r7));

  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`RESULT: ${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log('FAILED: ' + results.filter((r) => !r.ok).map((r) => r.name).join(' | '));
  }
  // 让 socket 收尾，避免 Windows 上 libuv 在仍有活动句柄时立刻退出
  await sleep(300);
  process.exitCode = passed === results.length ? 0 : 1;
  server.closeAllConnections?.();
}

main().catch((error) => {
  console.error('INTEGRATION ERROR:', error && error.message);
  process.exit(1);
});
