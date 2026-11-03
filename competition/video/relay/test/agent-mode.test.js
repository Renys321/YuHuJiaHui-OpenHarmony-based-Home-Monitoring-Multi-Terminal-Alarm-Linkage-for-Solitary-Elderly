'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withHarness, openViewer, waitFor, WebSocket } = require('./tools/harness');
const { AgentClient } = require('../src/agent-client');
const { isJpeg } = require('../src/frames');

const AGENT_KEY = 'test-agent-key-0123456789abcdef';

function agentUrl(harness) {
  return `${harness.wsBaseUrl}/video/agent?key=${encodeURIComponent(harness.agentKey)}`;
}

test('agent 模式：无 agent 时 viewer 收到 NO_AGENT；agent 注册后开始转发帧；空闲停止', async () => {
  await withHarness({
    env: {
      VIDEO_MODE: 'agent',
      VIDEO_AGENT_KEY: AGENT_KEY,
      VIDEO_DAYU_DOWN_GRACE_MS: '5000'
    }
  }, async (h) => {
    assert.equal(h.config.mode, 'agent');
    const session = await h.createSession(h.validToken);
    assert.equal(session.status, 200);

    const viewer = openViewer(h.baseUrl, session.body.ticket);
    await viewer.ready;
    await waitFor(() => viewer.texts.some((message) => message.type === 'error' && message.code === 'NO_AGENT'), {
      timeoutMs: 3000
    });
    assert.equal(h.dayu.connections, 0, '无 agent 时 relay 不应自己连 DAYU');

    const agent = new AgentClient({
      relayUrl: agentUrl(h),
      key: h.agentKey,
      dayuHost: '127.0.0.1',
      dayuPort: h.dayu.port,
      logger: h.logger
    });
    agent.start();
    try {
      await waitFor(() => viewer.frames.length >= 5, { timeoutMs: 8000, message: 'agent 模式没有转发帧' });
      for (const frame of viewer.frames) assert.equal(isJpeg(frame), true);

      const health = await h.health();
      assert.equal(health.body.mode, 'agent');
      assert.equal(health.body.dayuLink, 'connected');
      assert.ok(health.body.framesReceived >= 5);

      await viewer.close();
      // 最后一个 viewer 关闭 -> relay 向 agent 发 stop -> agent 向 DAYU 发 stop。
      await waitFor(() => h.dayu.stops >= 1, { timeoutMs: 5000, message: 'agent 模式空闲停止未到达 DAYU' });
      await waitFor(() => {
        const health = h.relay.hub.health();
        return health.dayuLink === 'down';
      }, { timeoutMs: 3000 });
    } finally {
      await agent.stop();
    }

    const logs = h.logLines.join('\n');
    assert.equal(logs.includes(AGENT_KEY), false, '日志出现了 agent key');
    assert.equal(logs.includes(h.validToken), false, '日志出现了 APP token');
  });
});

test('agent 注册 key 错误 -> WSS 握手 401', async () => {
  await withHarness({ env: { VIDEO_MODE: 'agent', VIDEO_AGENT_KEY: AGENT_KEY } }, async (h) => {
    const ws = new WebSocket(`${h.wsBaseUrl}/video/agent?key=wrong-key`);
    const outcome = await new Promise((resolve) => {
      ws.on('open', () => resolve({ opened: true }));
      ws.on('error', (error) => resolve({ opened: false, message: error.message }));
      ws.on('close', () => resolve({ opened: false, message: 'closed' }));
    });
    assert.equal(outcome.opened, false);
    assert.match(outcome.message, /401/);
  });
});

test('local 模式不接受 agent 注册（404），也不泄漏 key 校验细节', async () => {
  await withHarness({}, async (h) => {
    const ws = new WebSocket(`${h.wsBaseUrl}/video/agent?key=whatever`);
    const outcome = await new Promise((resolve) => {
      ws.on('open', () => resolve({ opened: true }));
      ws.on('error', (error) => resolve({ opened: false, message: error.message }));
      ws.on('close', () => resolve({ opened: false, message: 'closed' }));
    });
    assert.equal(outcome.opened, false);
    assert.match(outcome.message, /404/);
    const logs = h.logLines.join('\n');
    assert.equal(logs.includes('whatever'), false);
  });
});

test('agent 断线 -> viewer 保留并重连成功（resumed）', async () => {
  await withHarness({
    env: {
      VIDEO_MODE: 'agent',
      VIDEO_AGENT_KEY: AGENT_KEY,
      VIDEO_DAYU_DOWN_GRACE_MS: '5000'
    }
  }, async (h) => {
    const session = await h.createSession(h.validToken);
    const viewer = openViewer(h.baseUrl, session.body.ticket);
    await viewer.ready;

    const agent = new AgentClient({
      relayUrl: agentUrl(h),
      key: h.agentKey,
      dayuHost: '127.0.0.1',
      dayuPort: h.dayu.port,
      logger: h.logger,
      reconnectDelaysMs: [100]
    });
    agent.start();
    try {
      await waitFor(() => viewer.frames.length >= 3, { timeoutMs: 8000 });
      // 模拟 agent 侧网络抖动：强制断开 relay WS，agent 会自动重连。
      const relaySocket = agent._ws;
      assert.ok(relaySocket, 'agent 尚未连上 relay');
      relaySocket.terminate();
      await waitFor(() => viewer.texts.some((message) => message.type === 'resumed'), {
        timeoutMs: 8000,
        message: 'agent 重连后 viewer 未收到 resumed'
      });
      const framesBefore = viewer.frames.length;
      await waitFor(() => viewer.frames.length > framesBefore + 2, { timeoutMs: 8000 });
      assert.equal(viewer.closed, null);
    } finally {
      await agent.stop();
    }
  });
});
