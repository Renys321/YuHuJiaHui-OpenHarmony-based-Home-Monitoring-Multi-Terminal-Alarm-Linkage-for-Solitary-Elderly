/**
 * 缺陷 3 回归测试：Poller stop/restart 与旧任务完成竞态。
 *
 * 使用实际 core/polling/Poller.ts 编译产物与真实 setTimeout；间隔 15–30ms，
 * 只验证调度/并发不变量，不代表真机 30s 轮询验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, wait } from './fake-transport.mjs';

const { Poller } = loadCore('polling/Poller.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('在途任务期间 stop()/start()：任何时刻最大并发为 1，旧任务完成后新轮询继续', async () => {
  const gate = deferred();
  let started = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const poller = new Poller(20, async () => {
    started += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (started === 1) {
      await gate.promise;
    }
    concurrent -= 1;
  }, true);

  poller.start();
  await wait(5);
  assert.equal(started, 1, 'immediate 模式首个 tick 应已启动');

  poller.stop();
  poller.start();
  await wait(15);
  assert.equal(started, 1, '旧 tick 未完成时，新代不得并发启动第二个 tick');
  assert.equal(poller.hasInFlight(), true);

  gate.resolve();
  await wait(30);
  assert.ok(started >= 2, `旧任务完成后新代应继续轮询，实际 started=${started}`);
  assert.equal(maxConcurrent, 1, `最大并发必须为 1，实际 ${maxConcurrent}`);
  poller.stop();
});

test('连续多次 stop()/start() 不累积调度、不叠加并发', async () => {
  const gate = deferred();
  let started = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const poller = new Poller(20, async () => {
    started += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await gate.promise;
    concurrent -= 1;
  }, true);

  poller.start();
  for (let i = 0; i < 5; i++) {
    poller.stop();
    poller.start();
  }
  await wait(20);
  assert.equal(started, 1, '旧任务未完成时多次 stop/start 不得启动多个 tick');
  assert.equal(maxConcurrent, 1);

  poller.stop();
  gate.resolve();
  await wait(40);
  assert.equal(started, 1, '最终处于 stop，旧任务完成后不得再 tick');
});

test('旧任务 reject 后，新代轮询仍能继续（不永久卡住）', async () => {
  let started = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const poller = new Poller(15, async () => {
    started += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    const n = started;
    await wait(5);
    concurrent -= 1;
    if (n === 1) {
      throw new Error('first tick failed');
    }
  }, true);

  poller.start();
  await wait(5);
  poller.stop();
  poller.start();
  await wait(60);
  assert.ok(started >= 2, `旧任务失败后新代应继续，实际 started=${started}`);
  assert.equal(maxConcurrent, 1);
  assert.equal(poller.isRunning(), true);
  poller.stop();
});

test('旧任务结束不破坏当前代状态；旧 generation 不重复排定时器', async () => {
  const gate = deferred();
  let started = 0;
  const poller = new Poller(20, async () => {
    started += 1;
    if (started === 1) {
      await gate.promise;
    }
  }, true);

  poller.start();
  await wait(5);
  poller.stop();
  poller.start();
  await wait(5);
  assert.equal(poller.isRunning(), true);
  gate.resolve();
  await wait(100);
  const afterFirstWave = started;
  assert.ok(afterFirstWave >= 2);
  assert.equal(poller.isRunning(), true, '旧代完成不得把新代状态改成停止');
  await wait(50);
  assert.ok(started >= afterFirstWave, '新代应持续轮询');
  poller.stop();
});

test('默认延迟模式：stop/start 期间旧 tick 未完成也不并发', async () => {
  const gate = deferred();
  let started = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const poller = new Poller(15, async () => {
    started += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (started === 1) {
      await gate.promise;
    }
    concurrent -= 1;
  }, false);

  poller.start();
  await wait(30);
  assert.equal(started, 1, '延迟模式应在 interval 后启动首个 tick');
  poller.stop();
  poller.start();
  await wait(10);
  gate.resolve();
  await wait(60);
  assert.ok(started >= 2, `旧任务完成后新代应继续，实际 started=${started}`);
  assert.equal(maxConcurrent, 1);
  poller.stop();
});

test('stop 后不再发起新 tick（在途任务可自然结束）', async () => {
  const gate = deferred();
  let started = 0;
  const poller = new Poller(15, async () => {
    started += 1;
    await gate.promise;
  }, true);

  poller.start();
  await wait(5);
  assert.equal(started, 1);
  poller.stop();
  gate.resolve();
  await wait(50);
  assert.equal(started, 1, 'stop 后不得再发起新 tick');
  assert.equal(poller.isRunning(), false);
});
