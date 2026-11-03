'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHarness } = require('./tools/harness');

test('缺少 Bearer token：/video/session 返回 401，不签发 ticket，也不连 DAYU', async () => {
  await withHarness({}, async (h) => {
    const result = await h.createSession('');
    assert.equal(result.status, 401);
    assert.equal(result.body && result.body.ticket, undefined);
    // 没有 viewer 就不应该触发 DAYU 取帧（契约“没人看就不取帧”）。
    assert.equal(h.dayu.connections, 0);
    // healthz 无鉴权，且字段齐全。
    const health = await h.health();
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.mode, 'local');
    assert.ok(['connected', 'connecting', 'down'].includes(health.body.dayuLink));
    assert.equal(health.body.viewers, 0);
    assert.equal(health.body.framesReceived, 0);
    assert.equal(health.body.lastFrameAgeMs, -1);
  });
});

test('伪造 token：后端 401 -> relay 401', async () => {
  await withHarness({}, async (h) => {
    const result = await h.createSession('forged-token-000000');
    assert.equal(result.status, 401);
    assert.equal(h.backend.lastStatus, 401);
    assert.equal(h.backend.overviewCalls, 1);
  });
});

test('后端故障：relay 拒绝签发 ticket（401），不把故障当授权', async () => {
  await withHarness({}, async (h) => {
    h.backend.setDown(true);
    const result = await h.createSession(h.validToken);
    assert.equal(result.status, 401);
    assert.equal(h.backend.lastStatus, 503);
  });
});

test('超频：同一 token 超过限流阈值返回 429', async () => {
  await withHarness({ env: { VIDEO_SESSION_RATE_LIMIT: '2', VIDEO_SESSION_RATE_WINDOW_MS: '60000' } }, async (h) => {
    assert.equal((await h.createSession(h.validToken)).status, 200);
    assert.equal((await h.createSession(h.validToken)).status, 200);
    const third = await h.createSession(h.validToken);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, 'too many requests');
  });
});

test('日志不含 APP token（只出现状态码/前缀）', async () => {
  await withHarness({}, async (h) => {
    const token = h.validToken;
    const result = await h.createSession(token);
    assert.equal(result.status, 200);
    const openLog = await h.endSession(token);
    assert.equal(openLog.status, 200);
    const logs = h.logLines.join('\n');
    assert.equal(logs.includes(token), false, '日志出现了完整 APP token');
    assert.equal(logs.includes('authorization'), false, '日志出现了 Authorization 头');
    assert.match(logs, /session ticket issued/);
  });
});

test('GET /video/session 返回 405；未知路径 404', async () => {
  await withHarness({}, async (h) => {
    const response = await fetch(`${h.baseUrl}/video/session`);
    assert.equal(response.status, 405);
    const missing = await fetch(`${h.baseUrl}/video/nope`);
    assert.equal(missing.status, 404);
  });
});
