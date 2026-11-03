/**
 * 缺陷 2 回归测试：会话切换与在途请求竞态。
 *
 * 使用实际 core/session/SessionCore.ts、RequestGuard.ts、ScopedSingleFlight.ts 编译产物。
 * 延迟响应由测试内 deferred 手动控制（SIMULATED 时序），不访问公网。
 * 说明：GuardianService.ets 的平台层不进入 Node 编译，服务通过这些核心原语实现；
 * 平台层接线由 defect-static.test.mjs 做静态守卫，真机行为仍标 NOT TESTED。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './fake-transport.mjs';

const { SessionCore } = loadCore('session/SessionCore.js');
const { RequestGuard, SessionCommit } = loadCore('session/RequestGuard.js');
const { ScopedSingleFlight } = loadCore('session/ScopedSingleFlight.js');
const { SerialQueue } = loadCore('session/SerialQueue.js');

const NOW = 1730000000000;
const TTL = 7200;

function makeSession(token, guardianId) {
  const session = new SessionCore();
  session.set(token, guardianId, TTL, NOW);
  return session;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('SessionCore：set/clear 递增会话代际，旧 ticket 立即失效', () => {
  const session = makeSession('token-A', 'guardian-A');
  const guard = new RequestGuard(session);
  const ticketA = guard.capture();
  assert.equal(guard.isCurrent(ticketA, NOW), true);
  const versionBefore = session.generationId();
  session.clear();
  assert.notEqual(session.generationId(), versionBefore);
  assert.equal(guard.isCurrent(ticketA, NOW), false);
});

test('顺序：A 请求发出 → 登出 → A 成功返回，A 不得回填页面缓存', async () => {
  const session = makeSession('token-A', 'guardian-A');
  const guard = new RequestGuard(session);
  const commit = new SessionCommit(guard);
  const ticketA = guard.capture();
  const response = deferred();
  let pageCache = null;
  const task = response.promise.then((payload) => {
    const committed = commit.commitIfCurrent(ticketA, NOW, () => {
      pageCache = payload;
    });
    return { committed, payload };
  });

  // 登出（真实服务里 logout 会 session.clear + 清缓存）
  session.clear();
  pageCache = null;
  response.resolve('A-data');
  const result = await task;
  assert.equal(result.committed, false, '登出后旧响应不得提交');
  assert.equal(pageCache, null, '页面缓存保持为空');
});

test('顺序：A 请求发出 → 登录 B → B 成功 → A 成功返回，页面保持 B 数据', async () => {
  const session = makeSession('token-A', 'guardian-A');
  const guard = new RequestGuard(session);
  const commit = new SessionCommit(guard);
  const ticketA = guard.capture();
  const responseA = deferred();
  let pageCache = null;
  const taskA = responseA.promise.then((payload) => {
    const committed = commit.commitIfCurrent(ticketA, NOW, () => {
      pageCache = payload;
    });
    return committed;
  });

  // 切换到 B 会话
  session.set('token-B', 'guardian-B', TTL, NOW);
  const ticketB = guard.capture();
  assert.equal(commit.commitIfCurrent(ticketB, NOW, () => {
    pageCache = 'B-data';
  }), true);
  assert.equal(pageCache, 'B-data');

  responseA.resolve('A-data');
  const aCommitted = await taskA;
  assert.equal(aCommitted, false, 'A 的迟到响应不得覆盖 B');
  assert.equal(pageCache, 'B-data');
  assert.equal(session.token(), 'token-B');
});

test('顺序：A 请求发出 → 登录 B → A 返回 401/403，B 会话仍有效', () => {
  const session = makeSession('token-A', 'guardian-A');
  const guard = new RequestGuard(session);
  const ticketA = guard.capture();
  session.set('token-B', 'guardian-B', TTL, NOW);
  const ticketB = guard.capture();

  assert.equal(guard.shouldInvalidate(ticketA, NOW), false,
    '旧会话的 401/403 不得清除新会话');
  assert.equal(session.token(), 'token-B');
  assert.equal(session.isActive(NOW), true);
  assert.equal(guard.shouldInvalidate(ticketB, NOW), true,
    '当前会话的 401/403 才允许失效');
});

test('顺序：A 刷新未结束 → 切换 B 并刷新，B 不重用 A 任务；A 结束不释放 B 锁', async () => {
  const session = makeSession('token-A', 'guardian-A');
  const guard = new RequestGuard(session);
  const lock = new ScopedSingleFlight();

  const responseA = deferred();
  const responseB = deferred();
  let startedA = 0;
  let startedB = 0;
  const scopeA = guard.currentVersion();
  const taskA = lock.run(scopeA, () => {
    startedA += 1;
    return responseA.promise;
  });

  // 切 B：版本变化，新的 refresh 必须使用新 scope，不能复用 A 的 Promise
  session.set('token-B', 'guardian-B', TTL, NOW);
  const scopeB = guard.currentVersion();
  const taskB = lock.run(scopeB, () => {
    startedB += 1;
    return responseB.promise;
  });
  assert.notEqual(taskA, taskB, 'B 不得复用 A 的在途任务');
  assert.equal(startedA, 1);
  assert.equal(startedB, 1);

  responseA.resolve('A-result');
  await taskA;
  assert.equal(lock.hasInFlight(), true, 'A 完成不得释放 B 的锁');
  assert.equal(lock.scopeOfInFlight(), scopeB);

  responseB.resolve('B-result');
  await taskB;
  assert.equal(lock.hasInFlight(), false);
});

test('同一 scope 复用单飞任务；不同 scope 互不复用', async () => {
  const lock = new ScopedSingleFlight();
  const d1 = deferred();
  let calls = 0;
  const p1 = lock.run(1, () => {
    calls += 1;
    return d1.promise;
  });
  const p2 = lock.run(1, () => {
    calls += 1;
    return Promise.resolve('dup');
  });
  assert.equal(p1, p2, '同一会话代际应复用进行中的刷新');
  assert.equal(calls, 1);
  const d2 = deferred();
  const p3 = lock.run(2, () => {
    calls += 1;
    return d2.promise;
  });
  assert.notEqual(p1, p3);
  assert.equal(calls, 2);
  d1.resolve('one');
  await p1;
  assert.equal(lock.hasInFlight(), true, '旧 scope 结束不得清除新 scope 锁');
  d2.resolve('two');
  await p3;
  assert.equal(lock.hasInFlight(), false);
});

test('旧任务 resolve/reject 后，新 scope 仍能启动并被正确释放', async () => {
  const lock = new ScopedSingleFlight();
  const oldTask = deferred();
  const p1 = lock.run(10, () => oldTask.promise);
  const newTask = deferred();
  const p2 = lock.run(11, () => newTask.promise);
  oldTask.reject(new Error('old failed'));
  await assert.rejects(p1);
  assert.equal(lock.hasInFlight(), true, '旧任务失败不得释放新锁');
  newTask.resolve('new ok');
  await p2;
  assert.equal(lock.hasInFlight(), false);

  // 失败后同一 scope 也能重新开始（不永久卡住）
  const p3 = lock.run(11, () => Promise.resolve('retry ok'));
  assert.equal(await p3, 'retry ok');
});

test('Token 安全存储串行队列：慢的旧 save 不会越过 logout clear / 新 login save', async () => {
  const queue = new SerialQueue();
  const gate = deferred();
  const order = [];
  const saveA = queue.enqueue(async () => {
    order.push('A-start');
    await gate.promise;
    order.push('A-end');
    return 'A';
  });
  const logoutClear = queue.enqueue(async () => {
    order.push('clear');
    return 'clear';
  });
  const saveB = queue.enqueue(async () => {
    order.push('B-save');
    return 'B';
  });
  gate.resolve();
  const results = await Promise.all([saveA, logoutClear, saveB]);
  assert.deepEqual(results, ['A', 'clear', 'B']);
  assert.deepEqual(order, ['A-start', 'A-end', 'clear', 'B-save'],
    '安全存储必须按调用顺序执行，旧 save 不得覆盖后续 clear/new-login');
});

test('Token 存储串行队列：前一个操作失败不阻塞后续操作', async () => {
  const queue = new SerialQueue();
  const first = queue.enqueue(async () => {
    throw new Error('save failed');
  });
  await assert.rejects(first);
  const second = queue.enqueue(async () => 'clear-ok');
  assert.equal(await second, 'clear-ok');
});
