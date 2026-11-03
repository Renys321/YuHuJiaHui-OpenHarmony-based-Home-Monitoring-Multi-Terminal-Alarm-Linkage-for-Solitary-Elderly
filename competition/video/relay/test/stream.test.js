'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { withHarness, openViewer, waitFor, delay } = require('./tools/harness');
const { isJpeg } = require('../src/frames');

function hashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('正常观看：ready 文本 + 连续 JPEG 帧，且每帧字节不同（非静态图）', async () => {
  await withHarness({}, async (h) => {
    const session = await h.createSession(h.validToken);
    assert.equal(session.status, 200);
    assert.match(session.body.ticket, /^[0-9a-f]{64}$/);
    assert.equal(session.body.expiresInMs, h.config.ticketTtlMs);
    assert.equal(session.body.wsPath, `/video/stream?ticket=${session.body.ticket}`);

    const viewer = openViewer(h.baseUrl, session.body.ticket);
    await viewer.ready;

    // 第一条必须是 ready 控制文本。
    await waitFor(() => viewer.texts.length >= 1, { timeoutMs: 2000 });
    assert.deepEqual(viewer.texts[0], { type: 'ready', proto: 1, camera: '640x480' });

    await waitFor(() => viewer.frames.length >= 8, { timeoutMs: 5000 });
    for (const frame of viewer.frames) {
      assert.equal(isJpeg(frame), true, '帧不是 FF D8 ... FF D9');
      assert.ok(frame.length >= 4096 && frame.length <= 1048576, `帧长度越界: ${frame.length}`);
    }
    const unique = new Set(viewer.frames.map(hashOf));
    assert.equal(unique.size, viewer.frames.length, '出现重复帧（疑似静态图冒充）');

    const health = await h.health();
    assert.equal(health.body.viewers, 1);
    assert.ok(health.body.framesReceived >= 8);
    assert.ok(health.body.fps > 0);
    assert.equal(health.body.dayuLink, 'connected');

    await viewer.close();
    // 最后一个 viewer 关闭后 <=5s，fake DAYU 必须收到 stop（契约 §2.2 空闲停止）。
    await waitFor(() => h.dayu.stops >= 1, { timeoutMs: 5000, message: 'fake DAYU 未收到 stop' });
    await waitFor(async () => (await h.health()).body.viewers === 0, { timeoutMs: 2000 });
    const after = await h.health();
    assert.equal(after.body.dayuLink, 'down');
  });
});

test('ticket 一次性：同一 ticket 第二次 WS 升级被拒（401）', async () => {
  await withHarness({}, async (h) => {
    const session = await h.createSession(h.validToken);
    const first = openViewer(h.baseUrl, session.body.ticket);
    await first.ready;
    await waitFor(() => first.frames.length >= 1, { timeoutMs: 3000 });

    const second = openViewer(h.baseUrl, session.body.ticket);
    await waitFor(() => second.errors.length > 0 || second.closed !== null, {
      timeoutMs: 3000,
      message: '重复 ticket 未被拒绝'
    });
    assert.ok(
      second.errors.some((error) => /401/.test(error.message)) || (second.closed && second.closed.code !== 1000),
      `重复 ticket 未得到 401: ${JSON.stringify(second.closed)} ${second.errors.map((e) => e.message)}`
    );
    assert.equal((await h.health()).body.viewers, 1);
    await first.close();
  });
});

test('ticket 过期后不可用（TTL 150ms）', async () => {
  await withHarness({ env: { VIDEO_TICKET_TTL_MS: '150' } }, async (h) => {
    const session = await h.createSession(h.validToken);
    await delay(300);
    const viewer = openViewer(h.baseUrl, session.body.ticket);
    await waitFor(() => viewer.errors.length > 0 || viewer.closed !== null, { timeoutMs: 3000 });
    assert.equal((await h.health()).body.viewers, 0);
  });
});

test('并发上限：第 3 个 viewer 被 1013 关闭并收到 BUSY', async () => {
  await withHarness({ env: { VIDEO_MAX_VIEWERS: '2' } }, async (h) => {
    const viewers = [];
    for (let i = 0; i < 2; i += 1) {
      const session = await h.createSession(h.validToken);
      const viewer = openViewer(h.baseUrl, session.body.ticket);
      await viewer.ready;
      await waitFor(() => viewer.frames.length >= 1, { timeoutMs: 3000 });
      viewers.push(viewer);
    }
    const thirdSession = await h.createSession(h.validToken);
    const third = openViewer(h.baseUrl, thirdSession.body.ticket);
    await waitFor(() => third.closed !== null, { timeoutMs: 3000 });
    assert.equal(third.closed.code, 1013);
    assert.ok(third.texts.some((message) => message.type === 'error' && message.code === 'BUSY'));
    assert.equal((await h.health()).body.viewers, 2);

    for (const viewer of viewers) await viewer.close();
  });
});

test('POST /video/session/end 关闭该 token 的 viewer（1000 session-ended）', async () => {
  await withHarness({}, async (h) => {
    const session = await h.createSession(h.validToken);
    const viewer = openViewer(h.baseUrl, session.body.ticket);
    await viewer.ready;
    await waitFor(() => viewer.frames.length >= 1, { timeoutMs: 3000 });

    const ended = await h.endSession(h.validToken);
    assert.equal(ended.status, 200);
    assert.equal(ended.body.ok, true);
    assert.equal(ended.body.closed, 1);

    await waitFor(() => viewer.closed !== null, { timeoutMs: 3000 });
    assert.equal(viewer.closed.code, 1000);
    assert.match(viewer.closed.reason, /session-ended/);
  });
});

test('心跳文本包含 ts 与 fps', async () => {
  await withHarness({ env: { VIDEO_HEARTBEAT_MS: '100' } }, async (h) => {
    const session = await h.createSession(h.validToken);
    const viewer = openViewer(h.baseUrl, session.body.ticket);
    await viewer.ready;
    await waitFor(() => viewer.texts.some((message) => message.type === 'heartbeat'), { timeoutMs: 3000 });
    const heartbeat = viewer.texts.find((message) => message.type === 'heartbeat');
    assert.equal(typeof heartbeat.ts, 'number');
    assert.equal(typeof heartbeat.fps, 'number');
    assert.ok(heartbeat.fps > 0);
    await viewer.close();
  });
});
