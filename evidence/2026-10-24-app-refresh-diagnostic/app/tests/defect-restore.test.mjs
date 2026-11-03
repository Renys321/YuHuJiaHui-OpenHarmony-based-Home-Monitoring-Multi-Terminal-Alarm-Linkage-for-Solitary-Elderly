/**
 * 会话恢复竞争回归测试（实际 core/session/SessionRecoveryCoordinator.ts 生产逻辑）。
 *
 * 使用假 Token 与可控延迟的安全存储 fake；不访问公网/真实 AssetStore。
 * 覆盖：401/登出后延迟清除期间 restore、旧 restore→B 登录、过期清理与 B 保存交错、
 * 存储异常后队列继续、提交前生命周期复核。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, wait } from './fake-transport.mjs';

const { SessionRecoveryCoordinator } = loadCore('session/SessionRecoveryCoordinator.js');

const NOW = 1730000000000;
const TTL = 7200;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sessionOf(token, expiresAt = NOW + TTL * 1000) {
  return { token, guardianId: `guardian-${token}`, expiresAt };
}

function createVault(initial = null) {
  const state = {
    stored: initial === null ? null : { ...initial },
    loads: 0,
    saves: 0,
    clears: 0,
    order: []
  };
  const gates = { load: null, save: null, clear: null };
  const vault = {
    async load() {
      state.loads += 1;
      state.order.push('load');
      if (gates.load !== null) await gates.load.promise;
      return state.stored === null ? null : { ...state.stored };
    },
    async save(session) {
      state.saves += 1;
      state.order.push('save');
      if (gates.save !== null) await gates.save.promise;
      state.stored = { ...session };
      return true;
    },
    async clear() {
      state.clears += 1;
      state.order.push('clear');
      if (gates.clear !== null) await gates.clear.promise;
      state.stored = null;
    }
  };
  return { vault, state, gates };
}

async function letQueueStart() {
  await wait(5);
}

test('401 后安全存储清除被延迟：restore 排在 clear 后，读不到旧会话且返回 blocked', async () => {
  const { vault, state, gates } = createVault(sessionOf('token-A'));
  const coordinator = new SessionRecoveryCoordinator(vault);
  let active = true; // A 当前内存会话
  coordinator.invalidate(); // 模拟 401：内存会话立即失效
  active = false;
  gates.clear = deferred();
  const clearTask = coordinator.clearSecure();
  const restoreTask = coordinator.restore(NOW, () => active);

  await letQueueStart();
  assert.equal(state.loads, 0, 'restore 不得越过已排队的 clear 先读安全存储');
  assert.equal(state.clears, 1);

  gates.clear.resolve();
  await clearTask;
  const ticket = await restoreTask;
  assert.equal(ticket.kind, 'blocked');
  let applied = false;
  assert.equal(coordinator.commitRestore(ticket, NOW, () => active, () => {
    applied = true;
  }), false);
  assert.equal(applied, false);
  assert.equal(active, false);
  assert.equal(state.stored, null);
});

test('logout 后安全存储清除被延迟：同样不得恢复已退出会话', async () => {
  const { vault, state, gates } = createVault(sessionOf('token-A'));
  const coordinator = new SessionRecoveryCoordinator(vault);
  coordinator.invalidate();
  gates.clear = deferred();
  const clearTask = coordinator.clearSecure();
  const restoreTask = coordinator.restore(NOW, () => false);

  await letQueueStart();
  assert.equal(state.loads, 0);
  gates.clear.resolve();
  await clearTask;
  const ticket = await restoreTask;
  assert.equal(ticket.kind, 'blocked');
  assert.equal(coordinator.commitRestore(ticket, NOW, () => false, () => {
    throw new Error('must not apply');
  }), false);
});

test('旧 restore 已开始 → 新登录 B 开始/成功 → 旧读取完成：结果 stale，B 最终保留', async () => {
  const { vault, state, gates } = createVault(sessionOf('token-A'));
  const coordinator = new SessionRecoveryCoordinator(vault);
  let active = false;
  gates.load = deferred();
  const restoreTask = coordinator.restore(NOW, () => active);
  await letQueueStart();
  assert.equal(state.loads, 1, '旧 restore 应已开始读取');

  // B 登录开始（epoch 变化、loginInProgress=true），B 的 save 排在旧 restore 之后
  const attemptB = coordinator.beginLoginAttempt();
  const saveB = coordinator.saveForLogin(sessionOf('token-B'), attemptB, true);

  gates.load.resolve();
  const ticket = await restoreTask;
  assert.equal(ticket.kind, 'stale', '旧读取结果必须因 epoch 变化被丢弃');
  let applied = false;
  assert.equal(coordinator.commitRestore(ticket, NOW, () => active, () => {
    applied = true;
  }), false);
  assert.equal(applied, false);
  assert.equal(active, false, '旧 restore 不得替代 B 的登录流程');

  // B 的保存随后执行并提交 B 会话
  assert.equal(await saveB, true);
  coordinator.markLoginCommitted();
  active = true;
  assert.equal(state.stored.token, 'token-B', 'B 的安全存储记录必须保留');
  assert.equal(active, true);
});

test('旧 restore 读到过期记录与 B 登录保存交错：不得执行旧清理，B 记录保留', async () => {
  const { vault, state, gates } = createVault(sessionOf('token-A-expired', NOW - 1000));
  const coordinator = new SessionRecoveryCoordinator(vault);
  gates.load = deferred();
  const restoreTask = coordinator.restore(NOW, () => false);
  await letQueueStart();
  assert.equal(state.loads, 1);

  // B 登录开始（epoch 变化），B 的 save 排在旧 restore 之后
  const attemptB = coordinator.beginLoginAttempt();
  const saveB = coordinator.saveForLogin(sessionOf('token-B'), attemptB, true);

  gates.load.resolve();
  const ticket = await restoreTask;
  assert.equal(ticket.kind, 'stale', 'epoch 变化后过期结果不得再触发清理');
  assert.equal(state.clears, 0, '旧 restore 不得清除 B 将/save 的记录');
  assert.equal(await saveB, true);
  coordinator.markLoginCommitted();
  assert.equal(state.stored.token, 'token-B');
});

test('登录进行中调用 restore：blocked，不读取旧安全存储', async () => {
  const { vault, state } = createVault(sessionOf('token-A'));
  const coordinator = new SessionRecoveryCoordinator(vault);
  coordinator.beginLoginAttempt();
  const ticket = await coordinator.restore(NOW, () => false);
  assert.equal(ticket.kind, 'blocked');
  assert.equal(state.loads, 0);
});

test('B 已保存后再 restore：返回 none，不删除 B 的安全存储记录', async () => {
  const { vault, state } = createVault(null);
  const coordinator = new SessionRecoveryCoordinator(vault);
  const attemptB = coordinator.beginLoginAttempt();
  assert.equal(await coordinator.saveForLogin(sessionOf('token-B'), attemptB, true), true);
  coordinator.markLoginCommitted();
  let active = true;
  const ticket = await coordinator.restore(NOW, () => active);
  assert.equal(ticket.kind, 'none');
  assert.equal(state.clears, 0);
  assert.equal(state.stored.token, 'token-B');
});

test('restore 读到有效 token：ticket restored，提交后写入会话', async () => {
  const { vault } = createVault(sessionOf('token-A'));
  const coordinator = new SessionRecoveryCoordinator(vault);
  let active = false;
  const ticket = await coordinator.restore(NOW, () => active);
  assert.equal(ticket.kind, 'restored');
  assert.equal(ticket.session.token, 'token-A');
  let appliedToken = '';
  assert.equal(coordinator.commitRestore(ticket, NOW, () => active, (session) => {
    appliedToken = session.token;
    active = true;
  }), true);
  assert.equal(appliedToken, 'token-A');
});

test('restore 读到过期记录（无 epoch 变化）：返回 expired 并在串行回合内清除', async () => {
  const { vault, state } = createVault(sessionOf('token-old', NOW - 1000));
  const coordinator = new SessionRecoveryCoordinator(vault);
  const ticket = await coordinator.restore(NOW, () => false);
  assert.equal(ticket.kind, 'expired');
  assert.equal(state.clears, 1);
  assert.equal(state.stored, null);
});

test('restore 读取失败：返回 error，队列与后续 save/clear 仍可执行', async () => {
  const { vault, state } = createVault(null);
  let failLoad = true;
  const originalLoad = vault.load;
  vault.load = async () => {
    if (failLoad) {
      state.loads += 1;
      throw new Error('asset store load failed');
    }
    return originalLoad();
  };
  const coordinator = new SessionRecoveryCoordinator(vault);
  const ticket = await coordinator.restore(NOW, () => false);
  assert.equal(ticket.kind, 'error');

  failLoad = false;
  const attempt = coordinator.beginLoginAttempt();
  assert.equal(await coordinator.saveForLogin(sessionOf('token-B'), attempt, true), true);
  assert.equal(state.stored.token, 'token-B');
  coordinator.invalidate();
  await coordinator.clearSecure(); // 不抛出
  assert.equal(state.stored, null);
});

test('安全存储清除失败：异常被吞掉、队列不阻塞，restore 保持 blocked', async () => {
  const { vault, state } = createVault(sessionOf('token-A'));
  let failClear = true;
  const originalClear = vault.clear;
  vault.clear = async () => {
    state.clears += 1;
    if (failClear) throw new Error('asset store clear failed');
    await originalClear();
  };
  const coordinator = new SessionRecoveryCoordinator(vault);
  coordinator.invalidate();
  await coordinator.clearSecure(); // 不抛出、队列继续
  const ticket = await coordinator.restore(NOW, () => false);
  assert.equal(ticket.kind, 'blocked');
  assert.equal(state.stored.token, 'token-A', '清除失败时旧记录仍在，但 restore 被 invalidated 阻止');

  failClear = false;
  const attempt = coordinator.beginLoginAttempt();
  assert.equal(await coordinator.saveForLogin(sessionOf('token-B'), attempt, true), true);
  coordinator.markLoginCommitted();
  assert.equal(state.stored.token, 'token-B');
});

test('提交前生命周期复核：ticket restored 后发生失效则不得应用', async () => {
  const { vault } = createVault(sessionOf('token-A'));
  const coordinator = new SessionRecoveryCoordinator(vault);
  let active = false;
  const ticket = await coordinator.restore(NOW, () => active);
  assert.equal(ticket.kind, 'restored');

  coordinator.invalidate();
  let applied = false;
  assert.equal(coordinator.commitRestore(ticket, NOW, () => active, () => {
    applied = true;
  }), false);
  assert.equal(applied, false);
});

test('restore 期间失效：load 完成也返回 stale，不应用且不清 B 记录', async () => {
  const { vault, state, gates } = createVault(sessionOf('token-A'));
  const coordinator = new SessionRecoveryCoordinator(vault);
  let active = false;
  gates.load = deferred();
  const restoreTask = coordinator.restore(NOW, () => active);
  await letQueueStart();

  coordinator.invalidate(); // 401/登出发生在读取完成前
  gates.load.resolve();
  const ticket = await restoreTask;
  assert.equal(ticket.kind, 'stale');
  assert.equal(coordinator.commitRestore(ticket, NOW, () => active, () => {
    throw new Error('must not apply');
  }), false);
  assert.equal(state.stored.token, 'token-A', '旧 restore 不得执行清理（清除由失效流程排队）');
});
