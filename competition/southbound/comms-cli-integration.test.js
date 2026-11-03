'use strict';

/**
 * southbound/comms-cli-integration.test.js — CLI 级别端到端（真实后端 + 真实 CLI 代码路径）
 *
 * 回答的是"运维实际会怎么用"：
 *   启动真实后端 -> 监护人创建留言 -> 运行 `comms-run.js --dry-run --json`
 *   -> 校验退出码与 JSON 摘要 -> 后端状态变为 PLAYED -> 老人确认 -> ACKED。
 *
 * 说明（重要）：本测试**在进程内**调用 CLI 的 `main()`，并注入输出流，
 * 而不再 spawn 子进程。原因：本机沙箱下 `node --test` 的子进程无法访问父进程的
 * 回环 HTTP 服务（已用最小化诊断确认：父进程 fetch 成功，子进程 fetch 与裸 http.get
 * 都超时）。进程内调用覆盖的是同一套 CLI 参数解析、退出码与 runOnce 代码路径，
 * 因此仍然是真实的端到端，只是不经过进程边界。
 *
 * 不访问公网、不调用 `aa`、不操作串口；`--dry-run` 保证不触碰真实播放器。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main, EXIT } = require('./comms-run');

const INGEST_KEY = 'comms-cli-integration-ingest-key';
const TOKEN_SECRET = 'comms-cli-integration-secret-value-32-chars';
const GUARDIAN = 'comms-cli-guardian-openid-placeholder';
const DEVICE = 'dayu200-room-1';

/** 收集注入流的输出。 */
function createCapture() {
  const chunks = { out: [], err: [] };
  return {
    chunks,
    streams: {
      out: { write: (text) => { chunks.out.push(String(text)); } },
      err: { write: (text) => { chunks.err.push(String(text)); } }
    },
    out: () => chunks.out.join(''),
    err: () => chunks.err.join('')
  };
}

/** 启动真实后端（真实 PersistentStore + 真实 HTTP）。 */
async function startBackend(t) {
  const { createApiServer } = require('../cloud/backend/src/server');
  const { PersistentStore } = require('../cloud/backend/src/persistent-store');
  const { createSessionToken } = require('../cloud/backend/src/auth');
  const { ownerRefFor } = require('../cloud/backend/src/comms-core');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = new PersistentStore({ filePath: path.join(dir, 'state.json') });
  store.ingest({ deviceId: DEVICE, room: '客厅', state: 'NORMAL', ts: 1_700_000_000_000 });
  const { server } = createApiServer({
    store,
    tokenSecret: TOKEN_SECRET,
    ingestKey: INGEST_KEY,
    authorizeIdentity: (openid) => openid === GUARDIAN,
    ownerRefForIdentity: (openid) => ownerRefFor(TOKEN_SECRET, openid)
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return {
    dir,
    store,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: () => createSessionToken(GUARDIAN, TOKEN_SECRET)
  };
}

async function createMessage(backend, overrides = {}) {
  const response = await fetch(`${backend.baseUrl}/api/v1/communications/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${backend.token()}` },
    body: JSON.stringify({
      clientMessageId: 'cmsg-cli00001',
      deviceId: DEVICE,
      text: '妈妈，该吃药了',
      voiceId: 'MEDICINE_REMINDER',
      requestAck: true,
      ...overrides
    })
  });
  return { status: response.status, body: await response.json() };
}

test('the CLI completes a real end-to-end loop against a real backend', async (t) => {
  const backend = await startBackend(t);
  const created = await createMessage(backend);
  assert.equal(created.status, 201);
  const messageId = created.body.message.messageId;

  // 真实 CLI 代码路径：--dry-run --json。
  const capture = createCapture();
  const code = await main(
    ['--base-url', backend.baseUrl, '--device-id', DEVICE, '--ingest-key', INGEST_KEY, '--dry-run', '--json'],
    {},
    capture.streams
  );

  assert.equal(code, EXIT.OK, `CLI 退出码应为 0，stderr=${capture.err()}`);
  const summary = JSON.parse(capture.out().trim());
  assert.equal(summary.claimed, 1, 'CLI 必须从真实后端领取到这条消息');
  assert.equal(summary.delivered, 1);
  assert.equal(summary.played, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.dryRun, true);

  // CLI 输出里绝不能出现 ingest key。
  assert.equal(capture.out().includes(INGEST_KEY), false, 'stdout 不得泄露 ingest key');
  assert.equal(capture.err().includes(INGEST_KEY), false, 'stderr 不得泄露 ingest key');

  // 后端状态已推进到 PLAYED。
  const afterClaim = backend.store.getCommunication(messageId);
  assert.equal(afterClaim.status, 'PLAYED');
  assert.equal(afterClaim.deliveredAt > 0, true);
  assert.equal(afterClaim.playedAt > 0, true);

  // 第二次运行：状态已是 PLAYED，不再出现在待处理里，因此不会重复播放。
  const secondCapture = createCapture();
  const secondCode = await main(
    ['--base-url', backend.baseUrl, '--device-id', DEVICE, '--ingest-key', INGEST_KEY, '--dry-run', '--json'],
    {},
    secondCapture.streams
  );
  assert.equal(secondCode, EXIT.OK);
  assert.equal(JSON.parse(secondCapture.out().trim()).claimed, 0, '已播放的消息不得再次被领取');

  // 老人确认（本机按钮路径调用同一个上报接口）。
  const { reportAcknowledged } = require('./comms-agent');
  assert.equal(
    await reportAcknowledged({ baseUrl: backend.baseUrl, deviceId: DEVICE, ingestKey: INGEST_KEY }, messageId),
    true
  );

  const fetched = await fetch(`${backend.baseUrl}/api/v1/communications/messages/${messageId}`, {
    headers: { authorization: `Bearer ${backend.token()}` }
  });
  assert.equal((await fetched.json()).message.status, 'ACKED');

  // 快照不含身份、密钥或播放资源名。
  const snapshot = fs.readFileSync(path.join(backend.dir, 'state.json'), 'utf8');
  assert.equal(snapshot.includes(GUARDIAN), false);
  assert.equal(snapshot.includes(INGEST_KEY), false);
  assert.equal(snapshot.includes('openid'), false);
});

test('the CLI reports a usage error (64) and leaks nothing', async () => {
  const missing = createCapture();
  assert.equal(await main(['--device-id', DEVICE], {}, missing.streams), EXIT.USAGE);
  assert.match(missing.err(), /--base-url is required/);

  const secret = 'SHOULD-NOT-APPEAR-INGEST-KEY';
  const bad = createCapture();
  const code = await main(
    ['--base-url', 'http://127.0.0.1:1', '--device-id', 'bad device', '--ingest-key', secret],
    {},
    bad.streams
  );
  assert.equal(code, EXIT.USAGE);
  assert.equal(bad.err().includes(secret), false, '用法错误不得回显密钥');

  const help = createCapture();
  assert.equal(await main(['--help'], {}, help.streams), EXIT.OK);
  assert.match(help.out(), /one-shot/);
});

test('the CLI reads the ingest key from the environment without echoing it', async (t) => {
  const backend = await startBackend(t);
  await createMessage(backend, { clientMessageId: 'cmsg-cli00002' });

  const capture = createCapture();
  const code = await main(
    ['--base-url', backend.baseUrl, '--device-id', DEVICE, '--dry-run', '--json'],
    { COMMS_INGEST_KEY: INGEST_KEY },
    capture.streams
  );
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(capture.out().trim()).claimed, 1);
  assert.equal(capture.out().includes(INGEST_KEY), false);
});

test('a claim failure returns exit 1 without leaking anything', async () => {
  const capture = createCapture();
  const code = await main(
    ['--base-url', 'http://127.0.0.1:1', '--device-id', DEVICE, '--ingest-key', INGEST_KEY, '--json'],
    {},
    capture.streams
  );
  assert.equal(code, EXIT.FAILED);
  const summary = JSON.parse(capture.out().trim());
  assert.equal(summary.claimed, 0);
  assert.equal(summary.failures[0].code, 'CLAIM_FAILED');
  assert.equal(capture.out().includes(INGEST_KEY), false);
});
