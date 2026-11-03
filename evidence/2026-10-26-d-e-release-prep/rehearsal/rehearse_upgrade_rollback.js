'use strict';

/**
 * rehearse_upgrade_rollback.js — 本地隔离的「升级 / 回滚 / 失败保护」演练
 *
 * 目的：按 DEPLOY-RUNBOOK.md 的操作顺序，在**临时目录 + 回环地址 + 随机端口**上验证
 *   - v5 数据 → 冻结候选（v6）加载、写入后主快照升级为 v6；
 *   - D 的处置/安全日志、E 的活动记录在升级后持久化并可重新加载；
 *   - 完整保留升级后数据 → 恢复升级前状态 → 启动「旧版」边界代码能读回原数据；
 *   - 回滚后哪些升级后记录不再出现在运行数据中、它们仍保存在哪份留档；
 *   - 错误归档 / 校验失败 / 升级后数据保留失败时，恢复流程**中止**，原始数据不被删除或覆盖；
 *   - v5 边界代码**读不了 v6 快照**（这正是回滚必须换快照的原因）。
 *
 * 硬约束：
 *   - 只用 %TEMP% 下的临时目录；不读、不写任何生产/演示数据文件；
 *   - HTTP 只绑 127.0.0.1 随机端口；不连公网、不连设备、不部署；
 *   - 凭据用 crypto.randomBytes 进程内生成，不打印、不落盘；
 *   - 所有合成设备/告警显式带 `rehearsal-fixture-*` / `rehearsal-alarm-*` / `合成演练-*` 前缀，
 *     不会进入演示或生产链路。
 *
 * 旧版说明（重要）：本机不存在真实历史 v5 后端制品，`legacy-v5-emulation/` 是由冻结树
 * 机械派生的 v5 等价模拟；本脚本只验证回滚**流程**与 schema 版本边界，不构成旧版兼容验收。
 *
 * 运行：
 *   node rehearsal/rehearse_upgrade_rollback.js
 * 输出：
 *   rehearsal/rehearsal-result.json  +  控制台脱敏摘要
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORK = process.env.REHEARSAL_WORKSPACE || 'D:/OpenHarmony';
const DELIVERY = path.join(WORK, 'competition/evidence/2026-10-26-d-e-release-prep');
const NEW_SRC = path.join(WORK, 'competition/cloud/backend/src');
const LEGACY_SRC = path.join(DELIVERY, 'rehearsal/legacy-v5-emulation/src');
const RESULT_PATH = process.env.REHEARSAL_OUT || path.join(DELIVERY, 'rehearsal/rehearsal-result.json');

const TZ = 'Asia/Shanghai';
const BASE_TS = Date.UTC(2026, 9, 26, 2, 0, 0); // 2026-10-26 10:00 +08:00（合成时间）
const TOKEN_SECRET = crypto.randomBytes(48).toString('base64url');
const INGEST_KEY = crypto.randomBytes(48).toString('base64url');

const steps = [];
let failures = 0;

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function listTree(dir, prefix = '') {
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...listTree(abs, rel));
    else rows.push({ path: rel, bytes: fs.statSync(abs).size, sha256: sha256File(abs) });
  }
  return rows;
}

function treeHash(dir) {
  const rows = listTree(dir);
  return crypto.createHash('sha256')
    .update(rows.map((row) => `${row.sha256}  ${row.path}`).join('\n')).digest('hex').toUpperCase();
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function step(name, fn) {
  try {
    const detail = fn();
    steps.push({ step: name, ok: true, detail });
    console.log(`PASS  ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
    return true;
  } catch (error) {
    failures += 1;
    steps.push({ step: name, ok: false, detail: error && error.message });
    console.log(`FAIL  ${name} :: ${error && error.message}`);
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

/* ----------------------------------------------------------- 合成数据定义 */

const FIXTURES = [
  {
    deviceId: 'rehearsal-fixture-bath', room: '合成演练-卫生间', state: 'ALARM',
    sensors: { motion: { lastActiveTs: BASE_TS, countToday: 3 }, climate: { tempC: 24.5, rh: 51, ok: true } },
    alarm: { id: 'rehearsal-alarm-1', type: 'MANUAL_SOS', countToday: 1 }
  },
  {
    deviceId: 'rehearsal-fixture-living', room: '合成演练-客厅', state: 'ALARM',
    sensors: { motion: { lastActiveTs: BASE_TS, countToday: 7 } },
    alarm: { id: 'rehearsal-alarm-2', type: 'NO_MOTION', countToday: 1 }
  },
  { deviceId: 'rehearsal-fixture-kitchen', room: '合成演练-厨房', state: 'NORMAL', sensors: {} }
];

function statusOf(fixture, ts) {
  return {
    deviceId: fixture.deviceId,
    room: fixture.room,
    online: true,
    monitorOnline: 1,
    state: fixture.state,
    ts,
    sensors: fixture.sensors,
    alarm: fixture.alarm || {}
  };
}

/* ----------------------------------------------------------- 回滚实现（演练对象） */

/**
 * 与 DEPLOY-RUNBOOK.md §5 对应的文件级实现。
 * 任何一步校验失败都必须在**触碰现有运行数据之前**中止；
 * 已经移动的数据必须能放回原位，绝不删除。
 */
function rollback({ liveDir, preBackupDir, postSnapshotDir, preTreeHash, postTreeHash }) {
  const journal = [];

  // 1) 升级后数据必须已完整留档（否则拒绝回滚）
  assert(fs.existsSync(postSnapshotDir), 'post-upgrade snapshot missing -> abort');
  const postHash = treeHash(postSnapshotDir);
  assert(postHash === postTreeHash, 'post-upgrade snapshot hash mismatch -> abort');
  journal.push({ guard: 'post-upgrade snapshot preserved', ok: true, treeHash: postHash });

  // 2) 升级前备份必须校验通过（否则拒绝回滚）
  assert(fs.existsSync(preBackupDir), 'pre-upgrade backup missing -> abort');
  const preHash = treeHash(preBackupDir);
  assert(preHash === preTreeHash, 'pre-upgrade backup hash mismatch -> abort');
  journal.push({ guard: 'pre-upgrade backup verified', ok: true, treeHash: preHash });

  // 3) 先恢复到 staging 并再次校验，**此时尚未动运行数据**
  const staging = `${liveDir}.staging-${crypto.randomBytes(4).toString('hex')}`;
  copyTree(preBackupDir, staging);
  const stagingHash = treeHash(staging);
  if (stagingHash !== preTreeHash) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('staged restore hash mismatch -> abort, live data untouched');
  }
  journal.push({ guard: 'staged restore verified', ok: true, treeHash: stagingHash });

  // 4) 把升级后运行数据整体移到旁边（保留，不删除）
  const aside = `${liveDir}.post-upgrade-aside-${crypto.randomBytes(4).toString('hex')}`;
  fs.renameSync(liveDir, aside);
  journal.push({ guard: 'upgraded data moved aside (retained)', ok: true, path: path.basename(aside) });

  // 5) staging -> live（失败则把 aside 放回）
  try {
    fs.renameSync(staging, liveDir);
  } catch (error) {
    fs.renameSync(aside, liveDir);
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`live swap failed and was rolled back: ${error.message}`);
  }

  // 6) 落位后校验；不一致则回滚到升级后状态
  const liveHash = treeHash(liveDir);
  if (liveHash !== preTreeHash) {
    fs.renameSync(liveDir, `${liveDir}.broken-${crypto.randomBytes(4).toString('hex')}`);
    fs.renameSync(aside, liveDir);
    throw new Error('restored live data failed verification -> reverted to upgraded data');
  }
  journal.push({ guard: 'restored live data verified', ok: true, treeHash: liveHash });
  return { aside, journal };
}

/* ----------------------------------------------------------- 主流程 */

async function main() {
  // 固定 Date.now()：快照里的 savedAt / serverTime 会进入文件树哈希。
  // 用确定的假时钟让「升级前 / 升级后 / 恢复后」树哈希可跨运行复现，
  // 否则每次运行都会得到不同哈希，无法用于“恢复前后逐字节一致”的对照。
  const realDateNow = Date.now;
  let fakeClock = BASE_TS + 500_000;
  Date.now = () => {
    fakeClock += 1;
    return fakeClock;
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'de-release-rehearsal-'));
  const liveDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backup');
  const preBackup = path.join(backupDir, 'pre-upgrade');
  const postSnapshot = path.join(backupDir, 'post-upgrade');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const dataFile = path.join(liveDir, 'backend-state.json');
  const activityFile = path.join(liveDir, 'activity-state.json');
  const report = {
    kind: 'ISOLATED_REHEARSAL',
    generatedAt: new Date().toISOString(),
    timezone: TZ,
    workspace: WORK,
    tempRoot: root,
    legacyEmulation: {
      path: LEGACY_SRC,
      type: 'DERIVED_EMULATION_NOT_HISTORICAL',
      note: 'no authentic schema-v5 backend artifact exists in the workspace; see rehearsal/legacy-v5-emulation/LEGACY-EMULATION.md'
    },
    fixtures: FIXTURES.map((item) => ({ deviceId: item.deviceId, room: item.room, alarmId: item.alarm ? item.alarm.id : null })),
    steps
  };

  let legacyStoreModule;
  let newStoreModule;

  try {
    /* 1. 用 v5 边界代码建立旧 schema 合成状态 */
    step('seed schema-v5 synthetic state with legacy boundary code', () => {
      legacyStoreModule = requireFresh(path.join(LEGACY_SRC, 'persistent-store.js'));
      const store = new legacyStoreModule.PersistentStore({ filePath: dataFile });
      FIXTURES.forEach((fixture, index) => store.ingest(statusOf(fixture, BASE_TS + index * 1000), BASE_TS + index * 1000));
      const document = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      assert(document.schemaVersion === 5, `expected schemaVersion 5, got ${document.schemaVersion}`);
      assert(!Object.prototype.hasOwnProperty.call(document, 'safetyLogs'), 'v5 snapshot must not carry safetyLogs');
      assert(document.devices.length === 3, `expected 3 devices, got ${document.devices.length}`);
      assert(document.alerts.length === 2, `expected 2 alerts, got ${document.alerts.length}`);
      assert(!fs.existsSync(activityFile), 'v5 era has no activity file');
      return { schemaVersion: document.schemaVersion, devices: document.devices.length, alerts: document.alerts.length, activityFileExists: fs.existsSync(activityFile) };
    });

    /* 2. 制作升级前备份并记录哈希 */
    let preTreeHash = '';
    step('take pre-upgrade backup (main snapshot + absence of activity file)', () => {
      copyTree(liveDir, preBackup);
      preTreeHash = treeHash(preBackup);
      const files = listTree(preBackup);
      assert(files.length === 1 && files[0].path === 'backend-state.json', `unexpected backup content: ${JSON.stringify(files.map((f) => f.path))}`);
      return { treeHash: preTreeHash, files: files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })), activityFileInBackup: false };
    });

    /* 3. 冻结候选加载 v5 数据并做一次有效写入 -> 主快照升级为 v6 */
    step('frozen candidate loads v5 state and upgrades it to v6 on first write', () => {
      newStoreModule = requireFresh(path.join(NEW_SRC, 'persistent-store.js'));
      const store = new newStoreModule.PersistentStore({ filePath: dataFile });
      assert(store.listAlerts().length === 2, 'new code must read the 2 v5 alerts');
      assert(store.listSafetyLogs({ limit: 50 }).length === 0, 'v5 snapshot yields empty safety ledger');
      store.ingest(statusOf(FIXTURES[2], BASE_TS + 10_000), BASE_TS + 10_000);
      const document = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      assert(document.schemaVersion === 6, `expected schemaVersion 6 after write, got ${document.schemaVersion}`);
      assert(Array.isArray(document.safetyLogs), 'v6 snapshot must carry the safetyLogs ledger');
      return { schemaVersion: document.schemaVersion, safetyLogs: document.safetyLogs.length };
    });

    /* 4. 加入 D 的处置/安全日志记录并验证持久化 + 重新加载 */
    step('add D dispositions / safety logs and reload them', () => {
      const store = new newStoreModule.PersistentStore({ filePath: dataFile });
      const first = store.createDisposition({ alarmId: 'rehearsal-alarm-1', clientDispositionId: 'rehearsal-disp-0001', outcome: 'CONTACTED_FAMILY', note: '合成演练：已联系家属' });
      assert(first && first.created === true, 'first disposition must be created');
      const second = store.createDisposition({ alarmId: 'rehearsal-alarm-1', clientDispositionId: 'rehearsal-disp-0002', outcome: 'ON_SITE_CONFIRMED_NORMAL', note: '合成演练：现场确认正常' });
      assert(second && second.created === true, 'second disposition must be created');
      const third = store.createDisposition({ alarmId: 'rehearsal-alarm-2', clientDispositionId: 'rehearsal-disp-0003', outcome: 'FALSE_ALARM' });
      assert(third && third.created === true, 'third disposition must be created');
      const reloaded = new newStoreModule.PersistentStore({ filePath: dataFile });
      const logs = reloaded.listSafetyLogs({ limit: 50 });
      assert(logs.length === 3, `expected 3 safety logs after reload, got ${logs.length}`);
      assert(logs.every((log) => log.actor === 'household-guardian'), 'operator role must be server-side');
      return { created: 3, reloaded: logs.length, dispositionIds: logs.map((log) => log.dispositionId).sort() };
    });

    /* 5. 加入 E 的活动记录并验证持久化 + 重新加载 */
    step('add E activity records and reload them', () => {
      const { ActivityStore } = requireFresh(path.join(NEW_SRC, 'activity-store.js'));
      const activityStore = new ActivityStore({ filePath: activityFile, timezone: TZ, now: () => BASE_TS + 60_000 });
      const bath = statusOf(FIXTURES[0], BASE_TS + 20_000);
      activityStore.recordStatus(bath, BASE_TS + 20_000);
      activityStore.recordStatus({ ...bath, sensors: { motion: { lastActiveTs: BASE_TS, countToday: 6 } } }, BASE_TS + 80_000);
      activityStore.recordStatus({ ...bath, sensors: { motion: { lastActiveTs: BASE_TS, countToday: 8 } } }, BASE_TS + 140_000);
      const reloaded = new ActivityStore({ filePath: activityFile, timezone: TZ, now: () => BASE_TS + 200_000 });
      const document = JSON.parse(fs.readFileSync(activityFile, 'utf8'));
      assert(document.version === 1, 'activity file must use its own version=1');
      const reportBody = reloaded.getActivityReport({ scope: 'day', date: '2026-10-26' }, []);
      assert(reportBody.selected.count === 5, `expected 5 activity triggers, got ${reportBody.selected.count}`);
      return { activityFileVersion: document.version, dayCount: reportBody.selected.count, dataSinceIsNumber: typeof reportBody.dataSince === 'number' };
    });

    /* 6. 完整保留升级后数据（回滚前必须先做） */
    let postTreeHash = '';
    step('snapshot the complete post-upgrade data before rollback', () => {
      copyTree(liveDir, postSnapshot);
      postTreeHash = treeHash(postSnapshot);
      const files = listTree(postSnapshot).map((file) => file.path).sort();
      assert(files.includes('backend-state.json') && files.includes('activity-state.json'), `unexpected post-upgrade files: ${files}`);
      return { treeHash: postTreeHash, files };
    });

    /* 7. 按操作单回滚：恢复升级前状态 */
    let asideDir = '';
    step('rollback per runbook: verify -> stage -> swap -> verify', () => {
      const result = rollback({ liveDir, preBackupDir: preBackup, postSnapshotDir: postSnapshot, preTreeHash, postTreeHash });
      asideDir = result.aside;
      assert(fs.existsSync(asideDir), 'upgraded data must be retained aside, never deleted');
      return { journal: result.journal, asideRetained: path.basename(asideDir) };
    });

    /* 8. 启动「旧版」边界代码，验证能读回升级前数据 */
    let legacyReadback = {};
    {
      const store = new legacyStoreModule.PersistentStore({ filePath: dataFile });
      const document = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      legacyReadback = {
        schemaVersion: document.schemaVersion,
        devices: store.listAlerts === undefined ? null : document.devices.length,
        alerts: store.listAlerts().length,
        safetyLogsSupportedByLegacy: typeof store.listSafetyLogs === 'function' && store.listSafetyLogs({ limit: 50 }).length
      };
      step('legacy boundary code reads restored v5 state', () => {
        assert(document.schemaVersion === 5, `restored snapshot must be v5, got ${document.schemaVersion}`);
        assert(store.listAlerts().length === 2, 'restored alerts must be visible to legacy code');
        assert(store.listAlerts().every((alert) => alert.alarmId.startsWith('rehearsal-alarm-')), 'only synthetic alarms present');
        return { schemaVersion: document.schemaVersion, alerts: store.listAlerts().length };
      });

      // 真正启动一个 HTTP 服务，证明「旧版能起来并对外提供既有查询」
      const legacyServer = requireFresh(path.join(LEGACY_SRC, 'server.js'));
      const legacyAuth = requireFresh(path.join(LEGACY_SRC, 'auth.js'));
      const created = legacyServer.createApiServer({
        store,
        tokenSecret: TOKEN_SECRET,
        ingestKey: INGEST_KEY,
        authorizeIdentity: (identity) => identity === 'rehearsal-guardian'
      });
      const server = created.server;
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      const token = legacyAuth.createSessionToken('rehearsal-guardian', TOKEN_SECRET);
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/alerts`, {
        headers: { authorization: `Bearer ${token}` }
      });
      const body = await response.json();
      await new Promise((resolve) => server.close(resolve));
      step('legacy boundary code serves existing API on restored data (127.0.0.1)', () => {
        assert(response.status === 200, `expected 200 from legacy /api/v1/alerts, got ${response.status}`);
        assert(Array.isArray(body.alerts) && body.alerts.length === 2, 'legacy API must return the 2 synthetic alerts');
        return { status: response.status, alerts: body.alerts.length, bindsLoopbackOnly: true };
      });
    }

    /* 9. 明确哪些升级后记录不再出现在回滚后的运行数据中 */
    step('account for post-upgrade records that leave the runtime after rollback', () => {
      const liveFiles = listTree(liveDir).map((file) => file.path).sort();
      const asideFiles = listTree(asideDir).map((file) => file.path).sort();
      assert(!liveFiles.includes('activity-state.json'), 'activity file must not reappear in the restored runtime');
      assert(asideFiles.includes('activity-state.json'), 'activity file must be retained in the aside archive');
      const asideDocument = JSON.parse(fs.readFileSync(path.join(asideDir, 'backend-state.json'), 'utf8'));
      assert(asideDocument.schemaVersion === 6, 'aside archive must keep the v6 snapshot');
      assert(asideDocument.safetyLogs.length === 3, 'aside archive must keep the 3 dispositions');
      return {
        restoredRuntimeFiles: liveFiles,
        retainedAsideFiles: asideFiles,
        lostFromRuntime: ['3 dispositions / safety logs (kept in aside v6 snapshot)', 'activity statistics (kept in aside activity-state.json)'],
        retainedIn: path.basename(asideDir)
      };
    });

    /* 10. 失败保护：错误归档 / 校验失败 / 升级后数据保留失败都必须中止 */
    const guards = [];
    function runGuard(name, mutate) {
      const guardDir = path.join(root, `guard-${crypto.randomBytes(3).toString('hex')}`);
      copyTree(postSnapshot, guardDir); // 每次从升级后数据的一份副本开始
      const beforeHash = treeHash(guardDir);
      const { preBackupDir, postSnapshotDir, expectedPre, expectedPost } = mutate(guardDir, guardDir);
      let aborted = false;
      let message = '';
      try {
        rollback({
          liveDir: guardDir,
          preBackupDir,
          postSnapshotDir,
          preTreeHash: expectedPre,
          postTreeHash: expectedPost
        });
      } catch (error) {
        aborted = true;
        message = error && error.message;
      }
      const afterHash = treeHash(guardDir);
      const untouched = afterHash === beforeHash;
      const asideLeaked = fs.readdirSync(root).some((entry) => entry.startsWith(path.basename(guardDir) + '.post-upgrade-aside'));
      const ok = aborted && untouched;
      if (!ok) failures += 1;
      guards.push({ guard: name, aborted, liveDataUntouched: untouched, asideCreated: asideLeaked, message });
      console.log(`${ok ? 'PASS' : 'FAIL'}  guard: ${name} :: ${JSON.stringify({ aborted, untouched, asideLeaked, message })}`);
      if (path.basename(guardDir).indexOf('guard-') === 0) fs.rmSync(guardDir, { recursive: true, force: true });
    }

    runGuard('corrupted pre-upgrade backup archive', (guardDir) => {
      const badBackup = path.join(root, `bad-backup-${crypto.randomBytes(3).toString('hex')}`);
      copyTree(preBackup, badBackup);
      const target = path.join(badBackup, 'backend-state.json');
      const bytes = fs.readFileSync(target);
      bytes[bytes.length - 5] = bytes[bytes.length - 5] ^ 0xFF;
      fs.writeFileSync(target, bytes);
      return { preBackupDir: badBackup, postSnapshotDir: postSnapshot, expectedPre: preTreeHash, expectedPost: postTreeHash };
    });
    runGuard('pre-upgrade checksum mismatch (metadata vs archive)', () => ({
      preBackupDir: preBackup, postSnapshotDir: postSnapshot,
      expectedPre: 'DEADBEEF'.repeat(8), expectedPost: postTreeHash
    }));
    runGuard('post-upgrade data preservation failed (snapshot missing)', () => ({
      preBackupDir: preBackup, postSnapshotDir: path.join(root, 'does-not-exist-snapshot'),
      expectedPre: preTreeHash, expectedPost: postTreeHash
    }));

    /* 11. v5 边界代码必须读不了 v6 快照 */
    step('legacy boundary code refuses the v6 snapshot (why rollback needs the snapshot swap)', () => {
      const v6File = path.join(asideDir, 'backend-state.json');
      assert(fs.existsSync(v6File), 'aside v6 snapshot must exist');
      let threw = null;
      try {
        new legacyStoreModule.PersistentStore({ filePath: v6File });
      } catch (error) {
        threw = error;
      }
      assert(threw !== null, 'legacy code MUST refuse a schemaVersion 6 snapshot');
      assert(/unsupported schemaVersion:\s*6/.test(String(threw.message)), `unexpected error: ${threw && threw.message}`);
      return { refused: true, message: String(threw.message) };
    });

    /* 12. 恢复后的运行数据可以再次被候选版本加载 */
    step('restored v5 data can be loaded by the frozen candidate again', () => {
      const store = new newStoreModule.PersistentStore({ filePath: dataFile });
      assert(store.listAlerts().length === 2, 'frozen candidate must read the restored v5 data');
      assert(store.listSafetyLogs({ limit: 50 }).length === 0, 'restored v5 data has no dispositions');
      return { alerts: store.listAlerts().length, schemaVersion: JSON.parse(fs.readFileSync(dataFile, 'utf8')).schemaVersion };
    });

    report.guards = guards;
    report.legacyReadback = legacyReadback;
    report.finalTreeHashes = {
      preUpgrade: preTreeHash,
      postUpgrade: postTreeHash,
      restoredLive: treeHash(liveDir)
    };
    report.result = failures === 0 ? 'REHEARSAL_PASS' : 'REHEARSAL_FAILED';
  } catch (error) {
    failures += 1;
    report.fatal = { message: error && error.message, stack: error && error.stack };
    report.result = 'REHEARSAL_FATAL';
  } finally {
    Date.now = realDateNow;
    report.failures = failures;
    report.stepsCount = steps.length;
    report.clock = 'Date.now frozen during run for reproducible tree hashes';
    report.baseTs = BASE_TS;
    fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
    fs.writeFileSync(RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }

  const passed = steps.filter((item) => item.ok).length;
  console.log('');
  console.log(`[rehearsal] steps=${steps.length} passed=${passed} failures=${failures}`);
  console.log(`[rehearsal] preUpgrade=${report.finalTreeHashes ? report.finalTreeHashes.preUpgrade : '-'}`);
  console.log(`[rehearsal] postUpgrade=${report.finalTreeHashes ? report.finalTreeHashes.postUpgrade : '-'}`);
  console.log(`[rehearsal] restoredLive=${report.finalTreeHashes ? report.finalTreeHashes.restoredLive : '-'}`);
  console.log(`[rehearsal] guards=${JSON.stringify((report.guards || []).map((guard) => ({ guard: guard.guard, aborted: guard.aborted, untouched: guard.liveDataUntouched })))}`);
  console.log(`[rehearsal] ${report.result}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[rehearsal] FATAL', error);
  process.exitCode = 1;
});
