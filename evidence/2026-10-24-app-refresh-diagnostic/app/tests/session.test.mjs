/**
 * 会话状态机测试（实际 core/session/SessionCore.ts 编译产物）。
 *
 * token 一律使用明显假的字符串（fake-token-000），不涉及任何真实凭据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './fake-transport.mjs';

const { SessionCore, SessionSnapshot } = loadCore('session/SessionCore.js');
const NOW = 1730000000000;

test('SessionCore: set 后保存 token/guardianId/expiresAt/storageMode', () => {
  const session = new SessionCore();
  session.set('fake-token-000', 'family-guardian', 7200, NOW, 'secure');
  assert.equal(session.token(), 'fake-token-000');
  assert.equal(session.guardianId(), 'family-guardian');
  assert.equal(session.storageMode(), 'secure');
  const snapshot = session.get();
  assert.ok(snapshot);
  assert.equal(snapshot.expiresAt, NOW + 7200 * 1000);
});

test('SessionCore: 新实例未登录，isActive=false 且 token 为空', () => {
  const session = new SessionCore();
  assert.equal(session.token(), '');
  assert.equal(session.guardianId(), '');
  assert.equal(session.isActive(NOW), false);
  assert.equal(session.get(), null);
});

test('SessionCore: 未过期 isActive=true；到期前 30s 安全余量内视为过期', () => {
  const session = new SessionCore();
  session.set('fake-token-000', 'family-guardian', 7200, NOW);
  const expiresAt = NOW + 7200 * 1000;
  assert.equal(session.isActive(NOW), true);
  assert.equal(session.isActive(expiresAt - 60 * 1000), true, '到期前 60s 仍有效');
  assert.equal(session.isActive(expiresAt - 30 * 1000), false, '到期前 30s 余量内应视为过期，避免临界请求');
  assert.equal(session.isActive(expiresAt), false);
  assert.equal(session.isActive(expiresAt + 1), false);
});

test('SessionCore: expiresIn 为 0 / 负数 / NaN 时立即过期，不产生假有效会话', () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    const session = new SessionCore();
    session.set('fake-token-000', 'family-guardian', bad, NOW);
    assert.equal(session.isActive(NOW), false, `expiresIn=${bad} 不得视为有效会话`);
  }
});

test('SessionCore: clear 清空 token/guardianId 并失效', () => {
  const session = new SessionCore();
  session.set('fake-token-000', 'family-guardian', 7200, NOW);
  assert.equal(session.isActive(NOW), true);
  session.clear();
  assert.equal(session.get(), null);
  assert.equal(session.token(), '');
  assert.equal(session.guardianId(), '');
  assert.equal(session.isActive(NOW), false);
  assert.equal(session.storageMode(), 'memory');
});

test('SessionCore: 覆盖 set 会替换旧会话（不残留旧 token）', () => {
  const session = new SessionCore();
  session.set('fake-token-000', 'family-guardian', 7200, NOW);
  session.set('fake-token-001', 'other-guardian', 60, NOW + 1000, 'memory');
  assert.equal(session.token(), 'fake-token-001');
  assert.equal(session.guardianId(), 'other-guardian');
  assert.equal(session.storageMode(), 'memory');
  assert.equal(session.get().expiresAt, NOW + 1000 + 60 * 1000);
});

test('SessionSnapshot: 默认值不包含任何凭据', () => {
  const snapshot = new SessionSnapshot();
  assert.equal(snapshot.token, '');
  assert.equal(snapshot.guardianId, '');
  assert.equal(snapshot.expiresAt, 0);
  assert.equal(snapshot.storageMode, 'memory');
});
