/**
 * 恢复提交时的到期边界测试（实际生产 SessionRestorer + SessionRecoveryCoordinator + SessionCore）。
 *
 * 假 Token、可控时钟、受控 Promise 延迟；不访问真实安全存储/公网。
 * 目标：恢复期间到期（排队/读取耗时）绝不提交为“恢复成功”。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, wait } from './fake-transport.mjs';

const {
  SessionRecoveryCoordinator, isSessionExpiryUsable
} = loadCore('session/SessionRecoveryCoordinator.js');
const { SessionRestorer } = loadCore('session/SessionRestorer.js');
const { SessionCore } = loadCore('session/SessionCore.js');

const NOW = 1730000000000;
const SKEW = 30000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tokenSession(token, expiresAt) {
  return { token, guardianId: `guardian-${token}`, expiresAt };
}

function createVault(initial) {
  const state = {
    stored: initial === null ? null : { ...initial },
    loads: 0,
    saves: 0,
    clears: 0
  };
  const gates = { load: null };
  const vault = {
    async load() {
      state.loads += 1;
      if (gates.load !== null) await gates.load.promise;
      return state.stored === null ? null : { ...state.stored };
    },
    async save(session) {
      state.saves += 1;
      state.stored = { ...session };
      return true;
    },
    async clear() {
      state.clears += 1;
      state.stored = null;
    }
  };
  return { vault, state, gates };
}

/** 用实际 SessionCore 充当内存态；AppStorage 用简单对象观察是否被写入。 */
function createMemory(nowFn) {
  const core = new SessionCore();
  const appState = { guardianId: '', tokenStorage: 'memory', syncCount: 0 };
  const memory = {
    isActive(nowMs) {
      return core.isActive(nowMs);
    },
    applyRestored(token, guardianId, expiresAt, nowMs) {
      core.setWithExpiry(token, guardianId, expiresAt, nowMs, 'secure');
      appState.guardianId = guardianId;
      appState.tokenStorage = 'secure';
    },
    syncSessionState() {
      appState.guardianId = core.guardianId();
      appState.syncCount += 1;
    }
  };
  return { memory, core, appState };
}

async function letQueueStart() {
  await wait(5);
}

test('开始恢复时有效，排队/读取期间到期：提交失败，不 apply、不填账号状态', async () => {
  let now = NOW;
  const { vault, state, gates } = createVault(tokenSession('token-A', NOW + 120000));
  const coordinator = new SessionRecoveryCoordinator(vault);
  const { memory, core, appState } = createMemory(() => now);
  const restorer = new SessionRestorer(coordinator, memory, () => now);

  gates.load = deferred();
  const restoring = restorer.restore();
  await letQueueStart();
  assert.equal(state.loads, 1, '应已开始读取安全存储');

  now = NOW + 180000; // 读取耗时 180s，Token 已过期
  gates.load.resolve();
  const result = await restoring;

  assert.equal(result, false);
  assert.equal(core.isActive(now), false, '不得提交过期会话');
  assert.equal(appState.guardianId, '', '不得填入该记录的账号状态');
  assert.equal(appState.syncCount, 0, '拒绝时不得同步页面会话状态');
});

test('读取完成时仍有效，但提交前到期：按提交时间复验并拒绝', async () => {
  let now = NOW;
  const { vault } = createVault(tokenSession('token-A', NOW + 120000));
  const coordinator = new SessionRecoveryCoordinator(vault);
  const { memory, core, appState } = createMemory(() => now);
  const restorer = new SessionRestorer(coordinator, memory, () => now);

  // 读取完成瞬间把时钟推进到 Token 到期（调用时 now 已过时）
  const originalLoad = vault.load;
  vault.load = async () => {
    const stored = await originalLoad();
    now = NOW + 120000;
    return stored;
  };

  const result = await restorer.restore();
  assert.equal(result, false);
  assert.equal(core.isActive(now), false);
  assert.equal(appState.guardianId, '');
});

test('提交时剩余有效期不足 30 秒：拒绝恢复', async () => {
  const { vault } = createVault(null);
  const coordinator = new SessionRecoveryCoordinator(vault);
  const session = tokenSession('token-A', NOW + 29999);
  const ticket = { kind: 'restored', epoch: coordinator.lifecycle.epochId(), session };
  let applied = false;
  assert.equal(coordinator.commitRestore(ticket, NOW, () => false, () => {
    applied = true;
  }), false);
  assert.equal(applied, false);
});

test('提交时剩余有效期恰好 30 秒：边界拒绝', async () => {
  const { vault } = createVault(null);
  const coordinator = new SessionRecoveryCoordinator(vault);
  const ticket = {
    kind: 'restored',
    epoch: coordinator.lifecycle.epochId(),
    session: tokenSession('token-A', NOW + SKEW)
  };
  let applied = false;
  assert.equal(coordinator.commitRestore(ticket, NOW, () => false, () => {
    applied = true;
  }), false);
  assert.equal(applied, false);
});

test('提交时有效期明确大于 30 秒：正常恢复且实际会话有效', async () => {
  const { vault } = createVault(null);
  const coordinator = new SessionRecoveryCoordinator(vault);
  const ticket = {
    kind: 'restored',
    epoch: coordinator.lifecycle.epochId(),
    session: tokenSession('token-A', NOW + SKEW + 1)
  };
  let appliedSession = null;
  assert.equal(coordinator.commitRestore(ticket, NOW, () => false, (session) => {
    appliedSession = session;
  }), true);
  assert.equal(appliedSession.token, 'token-A');

  const core = new SessionCore();
  core.setWithExpiry(appliedSession.token, appliedSession.guardianId,
    appliedSession.expiresAt, NOW, 'secure');
  assert.equal(core.isActive(NOW), true, '恢复后内存会话必须真实有效');
});

test('expiresAt 为 NaN / Infinity / 0 / 负数：拒绝恢复', () => {
  assert.equal(isSessionExpiryUsable(NaN, NOW), false);
  assert.equal(isSessionExpiryUsable(Infinity, NOW), false);
  assert.equal(isSessionExpiryUsable(-Infinity, NOW), false);
  assert.equal(isSessionExpiryUsable(0, NOW), false);
  assert.equal(isSessionExpiryUsable(-1, NOW), false);
  assert.equal(isSessionExpiryUsable(NOW + SKEW + 1, NOW), true);
  assert.equal(isSessionExpiryUsable(NOW + SKEW, NOW), false);
  assert.equal(isSessionExpiryUsable(NOW + SKEW - 1, NOW), false);

  const { vault } = createVault(null);
  const coordinator = new SessionRecoveryCoordinator(vault);
  for (const invalid of [NaN, Infinity, 0, -1]) {
    const ticket = {
      kind: 'restored',
      epoch: coordinator.lifecycle.epochId(),
      session: tokenSession('token-A', invalid)
    };
    let applied = false;
    assert.equal(coordinator.commitRestore(ticket, NOW, () => false, () => {
      applied = true;
    }), false, `expiresAt=${invalid} 必须拒绝`);
    assert.equal(applied, false);
  }
});

test('restore 读到 NaN/Infinity expiresAt：返回 expired，不提交', async () => {
  for (const invalid of [NaN, Infinity]) {
    const { vault, state } = createVault(tokenSession('token-A', invalid));
    const coordinator = new SessionRecoveryCoordinator(vault);
    const { memory, appState } = createMemory(() => NOW);
    const restorer = new SessionRestorer(coordinator, memory, () => NOW);
    const result = await restorer.restore();
    assert.equal(result, false);
    assert.equal(appState.guardianId, '');
    assert.equal(state.loads, 1);
  }
});

test('服务级：restorer 恢复有效记录返回 true 且 SessionCore 实际有效、账号状态写入', async () => {
  const now = NOW;
  const { vault } = createVault(tokenSession('token-A', NOW + 120000));
  const coordinator = new SessionRecoveryCoordinator(vault);
  const { memory, core, appState } = createMemory(() => now);
  const restorer = new SessionRestorer(coordinator, memory, () => now);

  const result = await restorer.restore();
  assert.equal(result, true);
  assert.equal(core.isActive(now), true, '返回 true 时必须确有当前有效会话');
  assert.equal(core.token(), 'token-A');
  assert.equal(appState.guardianId, 'guardian-token-A');
  assert.equal(appState.tokenStorage, 'secure');
});

test('旧恢复等待期间 B 登录成功：旧结果不覆盖 B，返回 true 依据 B 的真实状态', async () => {
  let now = NOW;
  const { vault, state, gates } = createVault(tokenSession('token-A', NOW + 120000));
  const coordinator = new SessionRecoveryCoordinator(vault);
  const { memory, core, appState } = createMemory(() => now);

  gates.load = deferred();
  const restoring = new SessionRestorer(coordinator, memory, () => now).restore();
  await letQueueStart();

  // B 登录成功：生命周期推进 + 内存会话 B + 页面状态同步
  coordinator.beginLoginAttempt();
  coordinator.markLoginCommitted();
  core.set('token-B', 'guardian-B', 7200, now, 'memory');
  memory.syncSessionState();
  assert.equal(appState.guardianId, 'guardian-B');

  now = NOW + 60000;
  gates.load.resolve();
  const result = await restoring;

  assert.equal(result, true, '已有 B 有效会话时按 B 的真实状态返回 true');
  assert.equal(core.token(), 'token-B', '旧恢复不得覆盖 B');
  assert.equal(appState.guardianId, 'guardian-B');
  assert.equal(state.clears, 0, '旧恢复不得清理 B 的安全存储记录');
});

test('SessionCore.setWithExpiry 保留绝对有效期且边界与 isActive 一致', () => {
  const core = new SessionCore();
  core.setWithExpiry('token-A', 'guardian-A', NOW + SKEW + 1, NOW, 'secure');
  assert.equal(core.isActive(NOW), true);

  const boundary = new SessionCore();
  boundary.setWithExpiry('token-A', 'guardian-A', NOW + SKEW, NOW, 'secure');
  assert.equal(boundary.isActive(NOW), false, '恰好 30s 边界应无效');

  const invalid = new SessionCore();
  invalid.setWithExpiry('token-A', 'guardian-A', NaN, NOW, 'secure');
  assert.equal(invalid.isActive(NOW), false);
  assert.equal(invalid.guardianId(), '');
});
