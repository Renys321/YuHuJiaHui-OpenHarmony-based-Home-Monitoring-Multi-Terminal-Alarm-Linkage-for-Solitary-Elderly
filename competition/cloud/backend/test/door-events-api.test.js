'use strict';

/**
 * door-events-api.test.js — 门磁事件 HTTP 接口合同测试
 *
 * 覆盖：
 * - Bearer 鉴权（未授权 401；越权家庭 403）；
 * - GET /api/v1/door-events 返回持久化台账（按写入顺序最新在前）；
 * - deviceId 过滤与 limit 边界（非法值回退 20，超限截断 100）；
 * - 无事件时返回空数组（绝不补 0 / 伪造记录）；
 * - 当前状态仍由 /api/v1/devices 透传（sensors.door 原样可读）；
 * - 重复上报相同状态不新增事件。
 */

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createSessionToken, exchangeWechatCode } = require('../src/auth');
const { createApiServer } = require('../src/server');

const TOKEN_SECRET = 'test-token-secret-that-is-at-least-32-characters';
const INGEST_KEY = 'test-ingest-secret';
let baseUrl;
let server;
let authHeader;

before(async () => {
  const created = createApiServer({
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === 'openid-test',
    wechat: {
      appId: 'wx-test',
      appSecret: 'test-server-secret',
      fetchImpl: async () => ({ ok: true, json: async () => ({ openid: 'openid-test' }) })
    }
  });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  authHeader = { authorization: `Bearer ${createSessionToken('openid-test', TOKEN_SECRET)}` };
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function ingestDoor(deviceId, room, door, ts = 0) {
  const sensors = {};
  if (door !== undefined) sensors.door = door;
  return fetch(`${baseUrl}/internal/v1/device-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({ deviceId, room, state: 'NORMAL', sensors, ts })
  });
}

test('door-events endpoint requires bearer auth', async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/door-events`)).status, 401);
});

test('state-change ingests produce door events via the public API', async () => {
  await ingestDoor('esp32-kitchen', '厨房', { open: false }, 1000);   // 基线
  assert.equal((await ingestDoor('esp32-kitchen', '厨房', { open: true }, 2000)).status, 202); // dr-1
  assert.equal((await ingestDoor('esp32-kitchen', '厨房', { open: false }, 3000)).status, 202); // dr-2

  const response = await fetch(`${baseUrl}/api/v1/door-events`, { headers: authHeader });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.events.length, 2);
  assert.deepEqual(body.events.map((e) => e.open), [false, true]);
  assert.deepEqual(body.events.map((e) => e.eventId), ['dr-2', 'dr-1']);
  assert.equal(body.events[0].room, '厨房');
  // 设备上报 ts=3000 可信 -> 事件时间取设备时间并明确标注来源
  assert.equal(body.events[0].timeSource, 'device');
  assert.equal(body.events[0].occurredAt, 3000);
  assert.equal(body.events[0].source, 'state-change');
});

test('duplicate upload of the same state adds no events', async () => {
  // 接上一条测试的连续状态（当前 open=false）
  await ingestDoor('esp32-kitchen', '厨房', { open: false }, 3100);
  await ingestDoor('esp32-kitchen', '厨房', { open: false }, 3200);
  const response = await fetch(`${baseUrl}/api/v1/door-events?deviceId=esp32-kitchen`, { headers: authHeader });
  const body = await response.json();
  assert.equal(body.events.length, 2);
});

test('device-cache events are exposed and deduped through the API', async () => {
  await ingestDoor('esp32-bathroom', '卫生间', { open: true }, 1000);   // 基线
  // 当前 open 与 events 最后一条一致（固件补传时间线的真实形态），不触发状态变化兜底
  const withCache = { open: true, events: [{ open: false, ts: 0, seq: 1 }, { open: true, ts: 0, seq: 2 }] };
  await ingestDoor('esp32-bathroom', '卫生间', withCache, 2000);
  await ingestDoor('esp32-bathroom', '卫生间', withCache, 2100);        // 重复上传
  const response = await fetch(`${baseUrl}/api/v1/door-events?deviceId=esp32-bathroom`, { headers: authHeader });
  const body = await response.json();
  assert.equal(body.events.length, 2);
  assert.deepEqual(body.events.map((e) => e.seq), [2, 1]);
  assert.equal(body.events.every((e) => e.source === 'device-cache'), true);
});

test('deviceId filter and limit bounds are honored', async () => {
  // esp32-kitchen 有 2 条，esp32-bathroom 有 2 条，总计 4 条
  const kitchen = await fetch(`${baseUrl}/api/v1/door-events?deviceId=esp32-kitchen`, { headers: authHeader });
  const kitchenBody = await kitchen.json();
  assert.equal(kitchenBody.events.length, 2);
  const one = await fetch(`${baseUrl}/api/v1/door-events?deviceId=esp32-kitchen&limit=1`, { headers: authHeader });
  assert.equal((await one.json()).events.length, 1);
  const zeroLimit = await fetch(`${baseUrl}/api/v1/door-events?limit=0`, { headers: authHeader });
  assert.equal((await zeroLimit.json()).events.length, 4);              // 非法 0 -> 回退 20（返回全部 4 条）
  const hugeLimit = await fetch(`${baseUrl}/api/v1/door-events?limit=9999`, { headers: authHeader });
  assert.equal((await hugeLimit.json()).events.length, 4);              // 截断到全部（4 < 100）
  const badDevice = await fetch(`${baseUrl}/api/v1/door-events?deviceId=bad id!`, { headers: authHeader });
  assert.equal(badDevice.status, 400);
});

test('unknown device returns an empty array, never fake records', async () => {
  const response = await fetch(`${baseUrl}/api/v1/door-events?deviceId=esp32-ghost`, { headers: authHeader });
  const body = await response.json();
  assert.deepEqual(body.events, []);
});

test('current door state is still readable through /api/v1/devices sensors', async () => {
  const response = await fetch(`${baseUrl}/api/v1/devices`, { headers: authHeader });
  const body = await response.json();
  const kitchen = body.devices.find((device) => device.deviceId === 'esp32-kitchen');
  assert.equal(kitchen.sensors.door.open, false);
});
