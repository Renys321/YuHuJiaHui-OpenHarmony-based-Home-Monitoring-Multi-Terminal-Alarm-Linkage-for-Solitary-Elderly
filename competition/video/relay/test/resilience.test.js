'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHarness, openViewer, waitFor } = require('./tools/harness');

test('DAYU 短暂断开后自动恢复：重连成功发 resumed，画面继续且连接不关闭', async () => {
  await withHarness({
    env: {
      VIDEO_RECONNECT_DELAYS_MS: '100',
      VIDEO_DAYU_DOWN_GRACE_MS: '5000'
    }
  }, async (h) => {
    const session = await h.createSession(h.validToken);
    const viewer = openViewer(h.baseUrl, session.body.ticket);
    await viewer.ready;
    await waitFor(() => viewer.frames.length >= 3, { timeoutMs: 5000 });
    const framesBefore = viewer.frames.length;

    // 模拟 hdc 链路抖动：DAYU 侧断开 TCP（服务继续监听，relay 应自动重连）。
    h.dayu.kickClient();

    await waitFor(() => h.dayu.connections >= 2, { timeoutMs: 5000, message: 'relay 没有重连 fake DAYU' });
    await waitFor(() => viewer.texts.some((message) => message.type === 'resumed'), {
      timeoutMs: 5000,
      message: '恢复后没有收到 resumed'
    });
    await waitFor(() => viewer.frames.length > framesBefore + 2, {
      timeoutMs: 5000,
      message: '恢复后没有继续收到帧'
    });
    assert.equal(viewer.closed, null, `viewer 被错误关闭: ${JSON.stringify(viewer.closed)}`);
    assert.equal(h.dayu.starts >= 2, true);

    await viewer.close();
  });
});

test('超过宽限时间仍未恢复：发 error DAYU_DOWN 并以 1011 关闭', async () => {
  await withHarness({
    env: {
      VIDEO_RECONNECT_DELAYS_MS: '5000', // 宽限期内不会重连成功
      VIDEO_DAYU_DOWN_GRACE_MS: '400'
    }
  }, async (h) => {
    const session = await h.createSession(h.validToken);
    const viewer = openViewer(h.baseUrl, session.body.ticket);
    await viewer.ready;
    await waitFor(() => viewer.frames.length >= 1, { timeoutMs: 3000 });

    h.dayu.kickClient();

    await waitFor(() => viewer.texts.some((message) => message.type === 'error' && message.code === 'DAYU_DOWN'), {
      timeoutMs: 3000,
      message: '未收到 DAYU_DOWN 错误'
    });
    await waitFor(() => viewer.closed !== null, { timeoutMs: 3000 });
    assert.equal(viewer.closed.code, 1011);
  });
});
