/**
 * Poller 测试（实际 core/polling/Poller.ts 编译产物）。
 *
 * 验证非重叠轮询 / stop 清理（REAL-API-INTEGRATION-SPEC §3、§5）。
 * 使用真实 setTimeout，间隔 20–40ms，属于单元测试计时，不是真机刷新验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, wait } from './fake-transport.mjs';

const { Poller } = loadCore('polling/Poller.js');

test('Poller: immediate=true 立即 tick 一次并进入运行态', async () => {
  let calls = 0;
  const poller = new Poller(40, async () => { calls += 1; }, true);
  assert.equal(poller.isRunning(), false, '构造后不应自动启动');
  poller.start();
  assert.equal(poller.isRunning(), true);
  await wait(5);
  assert.equal(calls, 1, 'immediate=true 应在启动后立即执行一次');
  poller.stop();
  assert.equal(poller.isRunning(), false);
  const afterStop = calls;
  await wait(60);
  assert.equal(calls, afterStop, 'stop 后不得再 tick');
});

test('Poller: immediate=false 首次 tick 在一个 interval 之后', async () => {
  let calls = 0;
  const poller = new Poller(30, async () => { calls += 1; }, false);
  poller.start();
  await wait(10);
  assert.equal(calls, 0, '未到 interval 不应 tick');
  await wait(40);
  assert.ok(calls >= 1, 'interval 后应至少 tick 一次');
  poller.stop();
});

test('Poller: tick 未完成时不重入（并发计数最多 1）', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let started = 0;
  const poller = new Poller(20, async () => {
    started += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await wait(70); // 故意比 interval 长，制造重入压力
    concurrent -= 1;
  }, true);
  poller.start();
  await wait(130); // 约 6 个 interval，但每个 tick 70ms
  poller.stop();
  assert.equal(maxConcurrent, 1, `并发 tick 最多为 1，实际 ${maxConcurrent}`);
  assert.ok(started >= 1);
  // 若允许重入，130ms 内会启动 3 个以上；非重叠应明显更少。
  assert.ok(started <= 3, `非重叠轮询不应堆积，实际启动 ${started} 次`);
});

test('Poller: start 幂等，不会叠加定时器', async () => {
  let calls = 0;
  const poller = new Poller(40, async () => { calls += 1; }, true);
  poller.start();
  poller.start();
  poller.start();
  await wait(10);
  assert.equal(calls, 1, '多次 start 应立即 tick 仅一次');
  await wait(55);
  assert.ok(calls <= 3, `3 次 start 不应产生叠加轮询，实际 ${calls} 次`);
  poller.stop();
});

test('Poller: stop 后不再 tick 且可重新 start', async () => {
  let calls = 0;
  const poller = new Poller(25, async () => { calls += 1; }, true);
  poller.start();
  await wait(10);
  const first = calls;
  poller.stop();
  await wait(60);
  assert.equal(calls, first, 'stop 后计数不得增长');
  assert.equal(poller.isRunning(), false);
  poller.start();
  assert.equal(poller.isRunning(), true);
  await wait(10);
  assert.equal(calls, first + 1, '重新 start 应再次立即 tick');
  poller.stop();
});
