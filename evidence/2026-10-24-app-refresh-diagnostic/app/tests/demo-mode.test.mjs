/**
 * 独立演示模式测试（实际 core/demo/*.ts 编译产物 + 页面隔离静态扫描）。
 *
 * 覆盖：
 * - 演示快照有独立本地示例数据，无 Token/真实会话字段；
 * - Controller 进程内 enter/exit，不持久化、不自动恢复；
 * - 演示模块不依赖 GuardianService/ApiClient/传输层/TokenVault/Poller；
 * - 仅 LoginPage 有显式 DemoMode.enter()，错误路径不会自动进入演示；
 * - Index 在 demo 下不启动真实轮询/刷新；
 * - 演示模式 ACK 被禁用，不产生假“设备已确认”。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from './fake-transport.mjs';

const { buildDemoSnapshot } = loadCore('demo/DemoData.js');
const { DemoController } = loadCore('demo/DemoController.js');
const { RunMode } = loadCore('view/Models.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const ETS_ROOT = path.join(PROJECT_ROOT, 'entry', 'src', 'main', 'ets');

function read(rel) {
  return fs.readFileSync(path.join(ETS_ROOT, rel), 'utf8');
}

function readCore(rel) {
  return fs.readFileSync(path.join(ETS_ROOT, 'core', rel), 'utf8');
}

const NOW = 1792600000000;

test('demo: 快照包含独立示例设备/房间/告警/联系人，不含真实 Token 字段', () => {
  const snap = buildDemoSnapshot(NOW);
  assert.equal(snap.mode, RunMode.DEMO);
  assert.equal(snap.guardianId, '演示用户');
  assert.equal(snap.devices.length, 3);
  assert.equal(snap.rooms.length, 3);
  assert.equal(snap.alerts.length, 2);
  assert.equal(snap.contacts.length, 2);
  assert.equal(snap.overview.hasData, true);
  assert.equal(snap.overview.activeAlertCount, 2);
  assert.ok(snap.alerts.every((a) => a.statusKey === 'pending' || a.statusKey === 'waiting'));
  assert.ok(snap.alerts.every((a) => a.statusKey !== 'acked'), '演示告警不得伪造 ACKED 回执');
  assert.ok(snap.devices.every((d) => d.name.includes('演示')));
  const json = JSON.stringify(snap);
  assert.doesNotMatch(json, /sessionToken|mock-token|bearer|password|AssetStore/i);
  assert.equal(Object.prototype.hasOwnProperty.call(snap, 'token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snap, 'expiresAt'), false);
});

test('demo: Controller 仅进程内 enter/exit，退出后不残留快照、不自动恢复', () => {
  const controller = new DemoController();
  assert.equal(controller.mode(), RunMode.NONE);
  assert.equal(controller.isDemo(), false);
  assert.equal(controller.snapshot(), null);

  const first = controller.enter(NOW);
  assert.equal(controller.mode(), RunMode.DEMO);
  assert.equal(controller.isDemo(), true);
  assert.equal(controller.snapshot(), first);

  controller.exit();
  assert.equal(controller.mode(), RunMode.NONE);
  assert.equal(controller.isDemo(), false);
  assert.equal(controller.snapshot(), null);

  const second = controller.enter(NOW + 1000);
  assert.notEqual(second, first);
  assert.equal(second.generatedAt, NOW + 1000);
});

test('demo: 演示模块不依赖真实服务/API/传输层/TokenVault/Poller', () => {
  for (const rel of ['demo/DemoMode.ets', 'core/demo/DemoData.ts', 'core/demo/DemoController.ts']) {
    const src = fs.readFileSync(path.join(ETS_ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /from\s+['"][^'"]*(GuardianService|ApiClient|HttpTransport|TokenVault|Poller|NetworkKit)/,
      `${rel} 不得 import 真实服务/API/传输层/Poller`);
    assert.doesNotMatch(src, /mock[-_]token|sessionToken/i,
      `${rel} 不得写真实会话/Token`);
  }
  assert.doesNotMatch(read('demo/DemoMode.ets'), /'secure'|"secure"/,
    '演示状态不得伪装成安全存储模式');
});

test('demo: 仅 LoginPage 显式调用 DemoMode.enter，错误/失败路径不自动进入演示', () => {
  const login = read('pages/LoginPage.ets');
  const occurrences = login.match(/DemoMode\.enter\(\)/g) || [];
  assert.equal(occurrences.length, 1, 'DemoMode.enter 只允许出现在用户主动点击的 enterDemo() 中');
  assert.match(login, /private enterDemo\(\): void/, '必须有显式演示入口方法');
  assert.match(login, /onClick\(\(\) => \{ this\.enterDemo\(\); \}\)/, '演示入口必须是用户点击');
  assert.match(login, /GuardianService/, '真实登录入口保留');
});

test('demo: Index 在演示模式跳过真实会话/刷新/轮询，并保留真实分支', () => {
  const index = read('pages/Index.ets');
  const demoGuard = index.indexOf('if (this.mode === RunMode.DEMO)');
  const startAutoRefresh = index.indexOf('GuardianService.startAutoRefresh()');
  assert.ok(demoGuard >= 0, 'Index 必须有演示模式分支');
  assert.ok(startAutoRefresh > demoGuard, '演示分支必须在真实轮询之前返回');
  assert.match(index, /if \(this\.mode === RunMode\.DEMO\) \{\s*\n\s*return;/, '演示模式应提前 return');
  assert.match(index, /DemoMode\.exit\(\)/, '必须有退出演示清理');
  assert.match(index, /演示模式/, '演示模式必须有可见标识');
});

test('demo: AlertDetail 在演示模式禁用 ACK，不展示假成功', () => {
  const detail = read('pages/AlertDetailPage.ets');
  assert.match(detail, /演示模式：ACK 不可用/);
  assert.match(detail, /if \(this\.mode === RunMode\.DEMO\) \{\s*\n\s*this\.toast\('演示模式不提交真实 ACK/,
    'submit 必须先拦截演示模式');
  assert.match(detail, /不会产生设备回执/);
  assert.match(detail, /HTTP 202 只表示命令已入队；只有服务端返回 ACKED 才是设备已确认/,
    '真实 ACK 202 语义必须保留');
  assert.match(detail, /GuardianService\.ackAlert/, '真实 ACK 路径必须保留');
});

test('demo: 演示身份/数据在 Profile 明确标注且不冒充真实账号', () => {
  const profile = read('pages/ProfilePage.ets');
  assert.match(profile, /演示模式 · 本地示例数据/);
  assert.match(profile, /演示用户（示例数据）/);
  assert.match(profile, /不写系统安全存储/);
  assert.match(profile, /DemoMode\.exit\(\)/);
  assert.match(profile, /GuardianService\.logout\(\)/, '真实退出登录路径必须保留');
});
