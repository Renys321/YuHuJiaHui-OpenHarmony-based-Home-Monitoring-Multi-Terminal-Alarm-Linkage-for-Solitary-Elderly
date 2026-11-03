/**
 * 缺陷修复的静态接线守卫（补充行为测试，不替代行为测试）。
 *
 * 行为测试覆盖 core 纯逻辑；本文件确认 .ets 平台层/组件确实使用这些生产逻辑：
 * - GuardianService 使用 RequestGuard/SessionTicket/ScopedSingleFlight，并在提交前校验 ticket；
 * - 旧刷新去重/清理逻辑已移除，安全存储操作串行化；
 * - SensorCard 按 ViewMapper 写入的 colorToken 选色，而不是看到读数就绿色；
 * - AlertDetailPage 在页面销毁后忽略 ACK 迟到回调。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const ETS = path.join(PROJECT_ROOT, 'entry', 'src', 'main', 'ets');

function read(rel) {
  return fs.readFileSync(path.join(ETS, rel), 'utf8');
}

test('GuardianService 使用会话恢复编排器与恢复结果器，load/save/clear 同队列且无过期兜底', () => {
  const src = read('service/GuardianService.ets');
  assert.match(src, /SessionRecoveryCoordinator/);
  assert.match(src, /SessionRestorer/);
  assert.match(src, /recoveryCoordinator\(\)/);
  assert.match(src, /sessionRestorer\(\)\.restore\(\)/);
  assert.match(src, /setWithExpiry\(/, '恢复必须保留绝对有效期，不能用 Math.max(1, ...) 兜底');
  assert.doesNotMatch(src, /Math\.max\(1,/);
  assert.match(src, /\.invalidate\(\)/);
  assert.match(src, /\.clearSecure\(\)/);
  assert.match(src, /saveForLogin\(/);
  assert.doesNotMatch(src, /loginSeq/, '旧 loginSeq 检查已由生命周期 epoch 取代');
  assert.doesNotMatch(src, /vaultQueue/, '旧队列字段已由 SessionRecoveryCoordinator 管理');
  assert.doesNotMatch(src, /enqueueVault/, '旧队列辅助函数应移除');
  // TokenVault 直接调用只允许出现在 adapter 边界内，restore 不得绕过编排器
  const directLoads = (src.match(/TokenVault\.loadSecure\(\)/g) || []).length;
  assert.equal(directLoads, 1, `TokenVault.loadSecure 只允许 adapter 使用一次，实际 ${directLoads}`);
});

test('GuardianService 保留请求会话隔离与按代际单飞（上一轮修复不回退）', () => {
  const src = read('service/GuardianService.ets');
  assert.match(src, /RequestGuard/);
  assert.match(src, /SessionTicket/);
  assert.match(src, /SessionCommit/);
  assert.match(src, /ScopedSingleFlight/);
  assert.match(src, /refreshLock\.run\(/);
  assert.match(src, /alertsLock\.run\(/);
  assert.match(src, /isCurrent\(ticket/, '请求返回后必须校验 ticket');
  assert.doesNotMatch(src, /refreshInFlight/, '旧共享去重状态必须移除');
  assert.doesNotMatch(src, /alertsInFlight/, '旧共享去重状态必须移除');
});

test('GuardianService 旧响应提交前校验：数据/网络/401 都受 ticket 保护', () => {
  const src = read('service/GuardianService.ets');
  // 至少每个 fetch 在写 AppStorage 前校验 ticket
  const fetchCount = (src.match(/requestGuard\(\)\.isCurrent\(ticket, GuardianService\.now\(\)\)/g) || []).length;
  assert.ok(fetchCount >= 5, `fetch 校验次数不足：${fetchCount}`);
  // ACK 返回后先校验再产生副作用
  assert.match(src, /const result: ApiResult<AckDto> = await api\.ack\(ticket\.token/);
  assert.match(src, /outcome\.kind = 'stale'/);
  // 旧 401 必须被 stale 拦截，不能无条件 setUnauthorized
  assert.match(src, /stale/);
});

test('SensorCard 使用 colorToken 语义选色，unknown/offline 不得落到绿色分支', () => {
  const src = read('components/SensorCard.ets');
  assert.match(src, /this\.sensor\.colorToken/);
  assert.match(src, /colorTokenForSensorState/);
  assert.match(src, /token === 'success'/, '成功色只能来自 success token');
  assert.doesNotMatch(src, /state === 'ok'\) return Color\.successDark/,
    '不得再用 state==="ok" 直接返回绿色');
});

test('AlertDetailPage：页面销毁后 ACK 迟到回调不得更新页面/重启定时器', () => {
  const src = read('pages/AlertDetailPage.ets');
  assert.match(src, /private disposed: boolean = false/);
  assert.match(src, /this\.disposed = true/);
  assert.match(src, /if \(this\.disposed\) \{\s*\n\s*\/\/ 页面已离开/, 'ACK 回调必须先检查 disposed');
  assert.match(src, /private startWaitTimer\(\): void \{\s*\n\s*if \(this\.disposed\) return/);
});

test('Poller：stop 不得清 inFlight；旧代完成须接续新代', () => {
  const src = read('core/polling/Poller.ts');
  const stopBlock = src.slice(src.indexOf('stop(): void {'), src.indexOf('private schedule'));
  assert.doesNotMatch(stopBlock, /this\.inFlight = false/,
    'stop() 不得把未完成任务当作已完成');
  assert.match(src, /gen === this\.generation/, '旧代 finally 必须区分代际');
  assert.match(src, /this\.fire\(this\.generation\)/, '旧任务完成后新代应继续');
});
