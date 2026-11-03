#!/usr/bin/env node
'use strict';

/**
 * rollback-transaction.js — 卷内回滚事务（状态机 + 自动恢复）
 *
 * 目标：失败发生在任何阶段时，要么数据卷仍是升级后原状态，要么能依靠**明确、自动、
 * 经过校验**的恢复路径精确回到升级后原状态；不允许留下新旧混合状态，也不依赖
 * 未经验证的人工覆盖。
 *
 * 关键设计：
 *   1. copy-aside：先把当前 /data（升级后状态）整份复制到 `<data>/.de-rollback/<opId>/original/`
 *      并校验树哈希。原始文件从始至终都在，恢复不依赖“把搬走的东西搬回来”。
 *   2. 递归合并落位：staging 与 /data 在同一文件系统（staging 位于 /data/.de-rollback 内），
 *      每项 rename 都是同分区原子操作。**目录采用合并而不是整体替换**：
 *        - 两边都有的文件 → 用升级前版本替换（原文件先移入 aside 供撤销）；
 *        - 只在 staging 里有的文件 → 新增（撤销时移入 quarantine）；
 *        - 只在 /data 里有的文件（含嵌套的升级后新增证据/活动文件）→ **原样保留**。
 *   3. 精确撤销清单：journal.jsonl 记录 aside/placed/mkdir/preserve-extra 的相对路径；
 *      失败时按逆序撤销，最后用操作前的 inventory+treeHash 校验。
 *   4. 终态：COMPLETED / PREFLIGHT_OK / PREFLIGHT_ABORT / RECOVERED_TO_V6 /
 *      MANUAL_TAKEOVER_REQUIRED，不把“回滚失败”混成一种。
 *
 * 安全：只操作 --data-root；不删除原始数据；本次生成对象失败时移入 quarantine；
 *      不默认移动/删除 activity-state.json、evidence/；空间不足前置中止。
 *
 * 用法：
 *   node rollback-transaction.js --mode rollback --data-root /data \
 *     --pre-archive /backup/pre.tgz --post-archive /backup/post.tgz \
 *     --evidence-out /evidence/result.json --backend-stopped-asserted \
 *     [--expected-pre-tree-hash H] [--expected-post-tree-hash H] \
 *     [--op-id ID] [--volume-name NAME]
 *   node rollback-transaction.js --mode preflight ...      # 只校验，不改数据
 *   node rollback-transaction.js --mode recover --data-root /data \
 *     --expected-original-tree-hash H [--op-id ID]        # 进程被杀后按 journal 恢复
 *
 * 故障注入（仅测试）：--fail-point <name>（可重复）--fail-after <N|name=N>（可重复）
 *   可用点：after-inventory | post-archive-unreadable | partial-aside-copy |
 *           staging-missing-state | staging-tamper | partial-staging-extract |
 *           partial-landing-copy | partial-landing | final-verify |
 *           hard-exit | recovery-fail | recovery-fail-once
 *
 * 退出码：0 COMPLETED/PREFLIGHT_OK；10 PREFLIGHT_ABORT；20 RECOVERED_TO_V6；
 *        30 MANUAL_TAKEOVER_REQUIRED；40 INTERNAL_ERROR；2 硬中断（hard-exit）
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TX_DIRNAME = '.de-rollback';
const RESERVED_TOP_LEVEL = new Set([TX_DIRNAME]);

const STATE = Object.freeze({
  COMPLETED: 'COMPLETED',
  PREFLIGHT_OK: 'PREFLIGHT_OK',
  PREFLIGHT_ABORT: 'PREFLIGHT_ABORT',
  RECOVERED_TO_V6: 'RECOVERED_TO_V6',
  MANUAL_TAKEOVER_REQUIRED: 'MANUAL_TAKEOVER_REQUIRED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

const EXIT_CODE = Object.freeze({
  [STATE.COMPLETED]: 0,
  [STATE.PREFLIGHT_OK]: 0,
  [STATE.PREFLIGHT_ABORT]: 10,
  [STATE.RECOVERED_TO_V6]: 20,
  [STATE.MANUAL_TAKEOVER_REQUIRED]: 30,
  [STATE.INTERNAL_ERROR]: 40
});

/* ------------------------------------------------------------------ 基础工具 */

const nowIso = () => new Date().toISOString();
const sha256Buffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
const sha256File = (file) => sha256Buffer(fs.readFileSync(file));

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = 'ASSERT';
    throw error;
  }
}

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

function exists(target) {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

function isDir(target) {
  try { return fs.lstatSync(target).isDirectory(); } catch { return false; }
}

function fsyncPath(target) {
  let fd = null;
  try { fd = fs.openSync(target, 'r'); fs.fsyncSync(fd); } catch { /* best effort */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/** 清单 + 树哈希：路径/类型/大小/权限/uid:gid/内容哈希 全部纳入。 */
function inventory(root, options = {}) {
  const excludeTop = new Set(options.excludeTopLevel || []);
  const posix = process.platform !== 'win32';
  const rows = [];
  const walk = (current, prefix) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (prefix === '' && excludeTop.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const stat = fs.lstatSync(abs);
      const common = { path: rel, size: stat.size, mode: stat.mode & 0o777, uid: posix ? stat.uid : 0, gid: posix ? stat.gid : 0 };
      if (stat.isSymbolicLink()) {
        rows.push({ ...common, type: 'symlink', size: 0, sha256: sha256Buffer(Buffer.from(fs.readlinkSync(abs), 'utf8')) });
      } else if (stat.isDirectory()) {
        rows.push({ ...common, type: 'dir', size: 0, sha256: '' });
        walk(abs, rel);
      } else if (stat.isFile()) {
        rows.push({ ...common, type: 'file', sha256: sha256File(abs) });
      } else {
        rows.push({ ...common, type: 'other', sha256: '' });
      }
    }
  };
  assert(isDir(root), `inventory: not a directory: ${root}`);
  walk(root, '');
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const treeHash = sha256Buffer(Buffer.from(rows.map((row) => (
    `${row.path}\t${row.type}\t${row.size}\t${row.mode}\t${row.uid}:${row.gid}\t${row.sha256}`
  )).join('\n'), 'utf8'));
  return { rows, treeHash };
}

const toMap = (rows) => new Map(rows.map((row) => [row.path, row]));

function diffInventories(expectedRows, actualRows) {
  const expected = toMap(expectedRows);
  const actual = toMap(actualRows);
  const missing = [];
  const differing = [];
  const unexpected = [];
  for (const [rel, row] of expected) {
    const other = actual.get(rel);
    if (!other) { missing.push(rel); continue; }
    if (row.type !== other.type || row.sha256 !== other.sha256 || row.size !== other.size ||
        row.mode !== other.mode || row.uid !== other.uid || row.gid !== other.gid) {
      differing.push({
        path: rel,
        expected: { type: row.type, size: row.size, mode: row.mode, uid: row.uid, gid: row.gid, sha256: row.sha256 },
        actual: { type: other.type, size: other.size, mode: other.mode, uid: other.uid, gid: other.gid, sha256: other.sha256 }
      });
    }
  }
  for (const rel of actual.keys()) if (!expected.has(rel)) unexpected.push(rel);
  return { missing, differing, unexpected, equal: missing.length === 0 && differing.length === 0 && unexpected.length === 0 };
}

const copyTree = (src, dest) => fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true, force: true, errorOnExist: false });

function movePath(src, dest) {
  ensureDir(path.dirname(dest));
  fs.renameSync(src, dest);
}

const tarList = (archive) => execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);

const tarExtract = (archive, destDir) => {
  ensureDir(destDir);
  execFileSync('tar', ['-xzf', archive, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
};

/* ------------------------------------------------------------------ 事务 */

class RollbackTransaction {
  constructor(options) {
    this.opId = options.opId;
    this.mode = options.mode;
    this.dataRoot = path.resolve(options.dataRoot);
    this.preArchive = options.preArchive ? path.resolve(options.preArchive) : '';
    this.postArchive = options.postArchive ? path.resolve(options.postArchive) : '';
    this.expectedPreTreeHash = options.expectedPreTreeHash || '';
    this.expectedPostTreeHash = options.expectedPostTreeHash || '';
    this.expectedOriginalTreeHash = options.expectedOriginalTreeHash || '';
    this.evidenceOut = options.evidenceOut || '';
    this.volumeName = options.volumeName || '';
    this.backendStoppedAsserted = options.backendStoppedAsserted === true;
    this.failPoints = Array.isArray(options.failPoints) ? options.failPoints.slice() : [];
    this.failAfterGlobal = Number.isInteger(options.failAfter) ? options.failAfter : 0;
    this.failAfterByPoint = options.failAfterByPoint || {};

    this.txRoot = path.join(this.dataRoot, TX_DIRNAME, this.opId);
    this.originalDir = path.join(this.txRoot, 'original');
    this.stagingDir = path.join(this.txRoot, 'staging');
    this.incomingDir = path.join(this.txRoot, 'incoming');
    this.asideDir = path.join(this.txRoot, 'aside');
    this.quarantineDir = path.join(this.txRoot, 'quarantine');
    this.journalPath = path.join(this.txRoot, 'journal.jsonl');
    this.statePath = path.join(this.txRoot, 'state.json');

    this.seq = 0;
    this.stage = 'S0_PREFLIGHT';
    this.landingOps = [];
    this.createdDirs = [];
    this.result = {
      opId: this.opId,
      mode: this.mode,
      state: 'IN_PROGRESS',
      exitCode: null,
      startedAt: nowIso(),
      finishedAt: '',
      dataRoot: this.dataRoot,
      volumeName: this.volumeName,
      backendStoppedAsserted: this.backendStoppedAsserted,
      failPoints: this.failPoints,
      failAfterGlobal: this.failAfterGlobal,
      failAfterByPoint: this.failAfterByPoint,
      expectedPreTreeHash: this.expectedPreTreeHash,
      expectedPostTreeHash: this.expectedPostTreeHash,
      expectedOriginalTreeHash: this.expectedOriginalTreeHash,
      preArchive: null,
      postArchive: null,
      original: null,
      staging: null,
      final: null,
      recovery: null,
      mixedState: null,
      manualTakeover: false,
      serviceMustStayStopped: true,
      stages: [],
      landingOpCount: 0,
      preservedExtras: [],
      error: null,
      journalPath: this.journalPath
    };
  }

  journal(op, extra = {}) {
    this.seq += 1;
    const row = { seq: this.seq, ts: nowIso(), stage: this.stage, op, ...extra };
    ensureDir(this.txRoot);
    const fd = fs.openSync(this.journalPath, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(row)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return row;
  }

  setStage(next) {
    this.stage = next;
    this.result.stages.push({ stage: next, at: nowIso() });
    this.journal('stage', { to: next });
    try {
      ensureDir(this.txRoot);
      const temp = `${this.statePath}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({
        opId: this.opId, stage: this.stage, updatedAt: nowIso(),
        state: this.result.state, dataRoot: this.dataRoot
      }, null, 2)}\n`, 'utf8');
      fsyncPath(temp);
      fs.renameSync(temp, this.statePath);
    } catch { /* 状态文件是辅助证据 */ }
  }

  thresholdFor(name) {
    if (Object.prototype.hasOwnProperty.call(this.failAfterByPoint, name)) return this.failAfterByPoint[name];
    return this.failAfterGlobal;
  }

  failPointHit(name) {
    if (!this.failPoints.includes(name)) return;
    if (this.thresholdFor(name) > 0) return;
    this.journal('failpoint', { name });
    const error = new Error(`fail-point injected: ${name}`);
    error.code = 'FAIL_POINT';
    throw error;
  }

  failPointHitAfter(name, count) {
    if (!this.failPoints.includes(name)) return;
    const threshold = this.thresholdFor(name);
    if (threshold > 0 && count < threshold) return;
    if (threshold === 0 && count < 1) return;
    this.journal('failpoint', { name, after: count });
    const error = new Error(`fail-point injected: ${name} after ${count}`);
    error.code = 'FAIL_POINT';
    throw error;
  }

  hardExitAfter(name, count) {
    if (!this.failPoints.includes(name)) return;
    const threshold = this.thresholdFor(name);
    if (threshold > 0 && count < threshold) return;
    if (threshold === 0 && count < 1) return;
    this.journal('hard-exit', { name, after: count });
    process.exit(2);
  }

  run() {
    try {
      this.prepare();
      if (this.mode === 'recover') this.runRecoverMode();
      else this.runRollbackMode();
    } catch (error) {
      this.handleFailure(error);
    } finally {
      this.finish();
    }
    return this.result;
  }

  prepare() {
    this.setStage('S0_PREFLIGHT');
    assert(isDir(this.dataRoot), `data root not found: ${this.dataRoot}`);
    assert(this.backendStoppedAsserted,
      'backend-stop assertion missing (all modes require --backend-stopped-asserted)');
    ensureDir(path.join(this.dataRoot, TX_DIRNAME));
    ensureDir(this.txRoot);
    const rel = path.relative(this.dataRoot, this.txRoot);
    assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'transaction dir escaped data root');
    this.journal('begin', { mode: this.mode, dataRoot: this.dataRoot, volumeName: this.volumeName });
  }

  runRollbackMode() {
    /* ---------- S1 前置校验 ---------- */
    this.setStage('S1_PREFLIGHT_CHECKS');
    assert(this.backendStoppedAsserted,
      'backend-stop assertion missing (driver must verify the backend is stopped and pass --backend-stopped-asserted)');
    assert(this.preArchive && exists(this.preArchive), `pre-upgrade archive missing: ${this.preArchive}`);
    assert(this.postArchive && exists(this.postArchive), `post-upgrade archive missing: ${this.postArchive}`);
    const preSize = fs.statSync(this.preArchive).size;
    const postSize = fs.statSync(this.postArchive).size;
    assert(preSize > 0, 'pre-upgrade archive is empty');
    assert(postSize > 0, 'post-upgrade archive is empty');
    this.result.preArchive = { path: this.preArchive, bytes: preSize, sha256: sha256File(this.preArchive) };
    this.result.postArchive = { path: this.postArchive, bytes: postSize, sha256: sha256File(this.postArchive) };

    const original = this.inventoryOriginal();
    this.originalSnapshot = {
      rows: original.rows,
      treeHash: original.treeHash,
      topLevelEntries: original.topLevelEntries.slice()
    };
    this.result.original = {
      treeHash: original.treeHash,
      entryCount: original.rows.length,
      topLevelEntries: original.topLevelEntries.slice()
    };

    const dataBytes = original.rows.filter((row) => row.type === 'file').reduce((sum, row) => sum + row.size, 0);
    const statfs = fs.statfsSync(this.dataRoot);
    const freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
    const needBytes = dataBytes + 64 * 1024 * 1024;
    assert(freeBytes >= needBytes, `insufficient free space: free=${freeBytes} need=${needBytes}`);
    this.result.spaceCheck = { dataBytes, freeBytes, needBytes };
    this.journal('inventory-original', { treeHash: original.treeHash, entries: original.rows.length, dataBytes, freeBytes });

    // 关键安全闸门：把**当前卷内容**与调用方记录的“升级后 treeHash”比对。
    // 没有这一步，在错误/空卷上执行回滚会“成功”返回 COMPLETED（等于把空卷当成升级后状态）。
    if (this.expectedPostTreeHash) {
      assert(original.treeHash === this.expectedPostTreeHash,
        `live volume does not match expected post-upgrade state: expected ${this.expectedPostTreeHash}, got ${original.treeHash} (wrong/empty/stale volume? refuse to roll back)`);
      this.journal('live-volume-identity-verified', { treeHash: original.treeHash });
    }
    this.failPointHit('after-inventory');

    /* ---------- S2 校验升级后留档 ---------- */
    this.setStage('S2_VERIFY_POST_ARCHIVE');
    this.failPointHit('post-archive-unreadable');
    let postEntries;
    try { postEntries = tarList(this.postArchive); }
    catch (error) { throw new Error(`post-upgrade archive unreadable: ${error.message}`); }
    assert(postEntries.length > 0, 'post-upgrade archive lists no entries');
    if (this.expectedPostTreeHash) {
      const tmp = path.join(this.txRoot, 'post-check');
      fs.rmSync(tmp, { recursive: true, force: true });
      tarExtract(this.postArchive, tmp);
      const postInv = inventory(tmp, { excludeTopLevel: RESERVED_TOP_LEVEL });
      this.result.postArchive.extractedTreeHash = postInv.treeHash;
      assert(postInv.treeHash === this.expectedPostTreeHash,
        `post-upgrade archive content mismatch: expected ${this.expectedPostTreeHash}, got ${postInv.treeHash}`);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    this.journal('post-archive-verified', { sha256: this.result.postArchive.sha256, entries: postEntries.length });

    /* ---------- S3 copy-aside（preflight 跳过） ---------- */
    if (this.mode !== 'preflight') {
      this.setStage('S3_COPY_ASIDE');
      ensureDir(this.originalDir);
      let copied = 0;
      for (const name of original.topLevelEntries) {
        copyTree(path.join(this.dataRoot, name), path.join(this.originalDir, name));
        copied += 1;
        this.journal('copy-aside', { name, index: copied });
        this.failPointHitAfter('partial-aside-copy', copied);
      }
      const asideInv = inventory(this.originalDir);
      this.result.original.asideTreeHash = asideInv.treeHash;
      assert(asideInv.treeHash === original.treeHash,
        `copy-aside verification failed: expected ${original.treeHash}, got ${asideInv.treeHash}`);
      this.journal('copy-aside-verified', { treeHash: asideInv.treeHash });
    }

    /* ---------- S4 校验升级前归档并解到 staging ---------- */
    this.setStage('S4_VERIFY_PRE_ARCHIVE');
    let preEntries;
    try { preEntries = tarList(this.preArchive); }
    catch (error) { throw new Error(`pre-upgrade archive unreadable: ${error.message}`); }
    assert(preEntries.length > 0, 'pre-upgrade archive lists no entries');
    assert(preEntries.some((entry) => entry.replace(/^\.\//, '') === 'backend-state.json'),
      'pre-upgrade archive does not contain backend-state.json');

    fs.rmSync(this.stagingDir, { recursive: true, force: true });
    ensureDir(this.stagingDir);
    if (this.failPoints.includes('partial-staging-extract')) {
      const partialTmp = path.join(this.txRoot, 'pre-check-partial');
      fs.rmSync(partialTmp, { recursive: true, force: true });
      tarExtract(this.preArchive, partialTmp);
      const names = fs.readdirSync(partialTmp).sort();
      const take = Math.max(1, Math.floor(names.length / 2));
      for (const name of names.slice(0, take)) copyTree(path.join(partialTmp, name), path.join(this.stagingDir, name));
      fs.rmSync(partialTmp, { recursive: true, force: true });
      this.journal('partial-staging-extract', { took: take, of: names.length });
      this.failPointHit('partial-staging-extract');
    } else {
      tarExtract(this.preArchive, this.stagingDir);
    }
    if (this.failPoints.includes('staging-missing-state')) {
      const target = path.join(this.stagingDir, 'backend-state.json');
      if (exists(target)) fs.rmSync(target, { recursive: true, force: true });
      this.journal('staging-missing-state', { removed: 'backend-state.json' });
    }
    if (this.failPoints.includes('staging-tamper')) {
      const target = path.join(this.stagingDir, 'backend-state.json');
      const data = fs.readFileSync(target);
      data[data.length - 2] ^= 0xFF;
      fs.writeFileSync(target, data);
      this.journal('staging-tamper', { target: 'backend-state.json' });
    }
    // 若升级前归档里带了事务目录（例如在失败回滚后重新归档了 /data），必须剔除：
    // 否则会与本事务自己的 .de-rollback/<opId> 合并，覆盖 journal。属于防御性处理。
    const reservedInStaging = path.join(this.stagingDir, TX_DIRNAME);
    if (exists(reservedInStaging)) {
      fs.rmSync(reservedInStaging, { recursive: true, force: true });
      this.journal('staging-reserved-dropped', { name: TX_DIRNAME });
    }
    assert(exists(path.join(this.stagingDir, 'backend-state.json')), 'staging is missing backend-state.json');
    const stagingInv = inventory(this.stagingDir);
    this.result.staging = { treeHash: stagingInv.treeHash, entryCount: stagingInv.rows.length };
    if (this.expectedPreTreeHash) {
      assert(stagingInv.treeHash === this.expectedPreTreeHash,
        `staging content mismatch: expected ${this.expectedPreTreeHash}, got ${stagingInv.treeHash}`);
    }
    this.journal('staging-verified', { treeHash: stagingInv.treeHash, entries: stagingInv.rows.length });

    if (this.mode === 'preflight') {
      this.setStage('S4P_PREFLIGHT_OK');
      this.result.final = { treeHash: this.inventoryOriginal().treeHash, state: 'v6_unchanged' };
      this.result.state = STATE.PREFLIGHT_OK;
      this.journal('preflight-ok', { dataUntouched: true });
      return;
    }

    /* ---------- S5 递归合并落位 ---------- */
    this.setStage('S5_LANDING');
    ensureDir(this.incomingDir);
    ensureDir(this.asideDir);
    ensureDir(this.quarantineDir);
    // 测试注入：破坏 S3 校验过的 original/ 副本，用于验证“journal 撤销与 original 兜底都失败”
    // 时必须判 MANUAL_TAKEOVER_REQUIRED，而不是谎报成功或报“数据未动”。
    if (this.failPoints.includes('corrupt-original-copy')) {
      const target = path.join(this.originalDir, 'backend-state.json');
      assert(exists(target), 'corrupt-original-copy: original copy missing');
      const data = fs.readFileSync(target);
      data[data.length - 2] ^= 0xFF;
      fs.writeFileSync(target, data);
      this.journal('corrupt-original-copy', { target: 'original/backend-state.json' });
    }
    let opCounter = 0;
    const stagedPaths = [];
    const land = (relPath) => {
      const staged = path.join(this.stagingDir, relPath);
      const dest = path.join(this.dataRoot, relPath);
      const stat = fs.lstatSync(staged);
      if (stat.isDirectory()) {
        stagedPaths.push(relPath);
        if (!exists(dest)) {
          fs.mkdirSync(dest);
          this.createdDirs.push(relPath);
          this.journal('mkdir', { rel: relPath });
        } else {
          assert(isDir(dest), `type conflict at ${relPath}: data root has a file, staging has a directory`);
        }
        for (const child of fs.readdirSync(staged).sort()) land(`${relPath}/${child}`);
        return;
      }
      assert(stat.isFile(), `unsupported staged entry type at ${relPath}`);
      stagedPaths.push(relPath);
      opCounter += 1;
      const incoming = path.join(this.incomingDir, relPath);
      fs.rmSync(incoming, { recursive: true, force: true });
      ensureDir(path.dirname(incoming));
      copyTree(staged, incoming);
      this.journal('incoming-copied', { rel: relPath, index: opCounter });
      this.failPointHitAfter('partial-landing-copy', opCounter);

      let hadAside = false;
      if (exists(dest)) {
        movePath(dest, path.join(this.asideDir, relPath));
        hadAside = true;
        this.journal('aside', { rel: relPath });
      }
      movePath(incoming, dest);
      this.landingOps.push({ rel: relPath, hadAside });
      this.journal('placed', { rel: relPath, hadAside });
      this.hardExitAfter('hard-exit', this.landingOps.length);
      this.failPointHitAfter('partial-landing', this.landingOps.length);
    };
    for (const name of fs.readdirSync(this.stagingDir).sort()) land(name);

    // 升级后多出来、但升级前归档里没有的条目：原样保留（不移动、不删除）
    const stagedSet = new Set(stagedPaths);
    for (const row of this.originalSnapshot.rows) {
      if (stagedSet.has(row.path)) continue;
      this.result.preservedExtras.push(row.path);
      this.journal('preserve-extra', { rel: row.path, type: row.type });
    }
    this.result.landingOpCount = this.landingOps.length;

    /* ---------- S6 最终校验 ---------- */
    this.setStage('S6_FINAL_VERIFY');
    if (this.failPoints.includes('final-verify')) {
      const damage = path.join(this.dataRoot, 'backend-state.json');
      const data = fs.readFileSync(damage);
      data[data.length - 2] ^= 0xFF;
      fs.writeFileSync(damage, data);
      this.journal('final-verify-damage', { target: 'backend-state.json' });
    }
    this.verifyFinalState(stagingInv);
    this.result.final = {
      treeHash: this.inventoryOriginal().treeHash,
      state: 'v5_restored_with_preserved_extras',
      preservedExtras: this.result.preservedExtras
    };
    this.journal('final-verified', { treeHash: this.result.final.treeHash, preservedExtras: this.result.preservedExtras.length });

    this.setStage('S7_DONE');
    this.result.state = STATE.COMPLETED;
  }

  /**
   * 最终校验：
   *  (a) staging 的每一项都必须在 /data 里逐字节、逐权限一致；
   *  (b) 原快照里、但不属于 staging 的每一项，必须仍然存在且未变（没有因为目录合并被删）；
   *  (c) 不允许出现既不在 staging、也不在原快照里的条目（防混合残留）。
   */
  verifyFinalState(stagingInv) {
    const current = this.inventoryOriginal();
    const currentMap = toMap(current.rows);
    const stagedMap = toMap(stagingInv.rows);
    const originalMap = toMap(this.originalSnapshot.rows);

    const missing = [];
    const differing = [];
    for (const [rel, staged] of stagedMap) {
      const actual = currentMap.get(rel);
      if (!actual) { missing.push(rel); continue; }
      if (actual.type !== staged.type || actual.sha256 !== staged.sha256 || actual.size !== staged.size ||
          actual.mode !== staged.mode || actual.uid !== staged.uid || actual.gid !== staged.gid) {
        differing.push({
          path: rel,
          expected: { type: staged.type, size: staged.size, mode: staged.mode, sha256: staged.sha256 },
          actual: { type: actual.type, size: actual.size, mode: actual.mode, sha256: actual.sha256 }
        });
      }
    }
    assert(missing.length === 0 && differing.length === 0,
      `restored entries mismatch: ${JSON.stringify({ missing: missing.slice(0, 10), differing: differing.slice(0, 5) })}`);

    const preservedMissing = [];
    const preservedChanged = [];
    for (const [rel, originalRow] of originalMap) {
      if (stagedMap.has(rel)) continue;
      const actual = currentMap.get(rel);
      if (!actual) { preservedMissing.push(rel); continue; }
      if (actual.type !== originalRow.type || actual.sha256 !== originalRow.sha256 ||
          actual.size !== originalRow.size || actual.mode !== originalRow.mode ||
          actual.uid !== originalRow.uid || actual.gid !== originalRow.gid) {
        preservedChanged.push(rel);
      }
    }
    assert(preservedMissing.length === 0 && preservedChanged.length === 0,
      `preserved entries damaged: ${JSON.stringify({ missing: preservedMissing.slice(0, 10), changed: preservedChanged.slice(0, 10) })}`);

    const unplanned = current.rows
      .filter((row) => !stagedMap.has(row.path) && !originalMap.has(row.path))
      .map((row) => row.path);
    assert(unplanned.length === 0, `unplanned entries present after landing: ${JSON.stringify(unplanned.slice(0, 10))}`);
    this.journal('final-verify-ok', {
      stagedEntries: stagedMap.size,
      preservedEntries: [...originalMap.keys()].filter((rel) => !stagedMap.has(rel)).length,
      currentEntries: current.rows.length
    });
  }

  /* ------------------------------ resume 恢复 ------------------------------ */

  runRecoverMode() {
    this.setStage('R1_LOAD_JOURNAL');
    const journal = this.readJournal();
    assert(journal.length > 0, 'journal is empty: nothing to recover');
    const before = this.inventoryOriginal();
    this.result.recoveryBefore = { treeHash: before.treeHash, entryCount: before.rows.length };
    this.setStage('R2_RECOVER');
    this.recoverToOriginal();
    this.setStage('R3_VERIFY');
    const after = this.inventoryOriginal();
    this.result.final = { treeHash: after.treeHash, entryCount: after.rows.length, state: 'recovered_v6' };
    if (this.expectedOriginalTreeHash) {
      assert(after.treeHash === this.expectedOriginalTreeHash,
        `recover verification failed: expected ${this.expectedOriginalTreeHash}, got ${after.treeHash}`);
      this.result.recovery = { attempted: true, recovered: true, mode: 'resume', verifiedAgainst: this.expectedOriginalTreeHash };
      this.result.mixedState = false;
      this.result.state = STATE.RECOVERED_TO_V6;
    } else {
      this.result.recovery = { attempted: true, recovered: null, mode: 'resume', verifiedAgainst: null };
      this.result.mixedState = 'UNVERIFIED';
      this.result.manualTakeover = true;
      this.result.state = STATE.MANUAL_TAKEOVER_REQUIRED;
      this.result.evidence = this.buildManualEvidence(new Error('resume-recovery needs --expected-original-tree-hash to verify'));
      this.journal('recover-unverified', { treeHash: after.treeHash });
    }
  }

  /* ------------------------------ 失败处理 ------------------------------ */

  /** journal 写失败不得让失败处理本身崩掉（否则会以 INTERNAL_ERROR 退出且没有人工证据）。 */
  safeJournal(op, extra) {
    try {
      this.journal(op, extra);
    } catch (journalError) {
      this.result.journalWriteFailed = `${op}: ${journalError && journalError.message}`;
      try { console.error(`[rollback] WARN journal write failed: ${journalError && journalError.message}`); } catch { /* ignore */ }
    }
  }

  handleFailure(error) {
    // 会修改数据卷的阶段：落位/最终校验/恢复执行/恢复校验
    const dataTouching = ['S5_LANDING', 'S6_FINAL_VERIFY', 'S7_DONE', 'S6R_RECOVERY_DONE', 'R1_LOAD_JOURNAL', 'R2_RECOVER', 'R3_VERIFY'];
    const resumeStages = ['R1_LOAD_JOURNAL', 'R2_RECOVER', 'R3_VERIFY'];
    this.result.error = { message: error && error.message, code: error && error.code, stage: this.stage };
    this.safeJournal('failure', { stage: this.stage, message: error && error.message, code: error && error.code });

    // --mode recover 本身失败：数据可能已被部分改动，绝不能报“数据未被触碰”
    if (resumeStages.includes(this.stage)) {
      this.result.state = STATE.MANUAL_TAKEOVER_REQUIRED;
      this.result.manualTakeover = true;
      this.result.mixedState = 'UNKNOWN';
      this.result.evidence = this.buildManualEvidence(error);
      this.safeJournal('recover-failed-manual', { message: error && error.message });
      return;
    }

    if (!dataTouching.includes(this.stage)) {
      this.result.state = STATE.PREFLIGHT_ABORT;
      this.result.serviceMustStayStopped = false;
      this.result.mixedState = false;
      this.safeJournal('preflight-abort', { dataUntouched: true });
      return;
    }

    this.result.recovery = { attempted: true, recovered: false, error: null, via: null };
    const snapshot = this.originalSnapshot;
    try {
      assert(snapshot && Array.isArray(snapshot.rows), 'original inventory snapshot missing: cannot verify recovery');
      this.recoverToOriginal();
      this.setStage('S6R_RECOVERY_DONE');
      this.verifyAgainstSnapshot(snapshot);
      this.result.recovery.recovered = true;
      this.result.recovery.via = 'journal-undo';
      this.result.state = STATE.RECOVERED_TO_V6;
      this.safeJournal('recovered-to-v6', { treeHash: this.result.final.treeHash, via: 'journal-undo' });
      return;
    } catch (primaryError) {
      this.result.recovery.error = primaryError && primaryError.message;
      this.result.recovery.via = 'journal-undo-failed';
      this.safeJournal('primary-recovery-failed', { message: primaryError && primaryError.message });
    }

    // 兜底恢复：用 S3 校验过的 original/ 整份副本重建（这就是文档里说的“恢复依据”）
    try {
      this.recoverFromOriginalCopy(snapshot);
      this.setStage('S6R_RECOVERY_FALLBACK_DONE');
      this.verifyAgainstSnapshot(snapshot);
      this.result.recovery.recovered = true;
      this.result.recovery.via = 'original-copy';
      this.result.state = STATE.RECOVERED_TO_V6;
      this.safeJournal('recovered-to-v6', { treeHash: this.result.final.treeHash, via: 'original-copy' });
      return;
    } catch (fallbackError) {
      this.result.recovery.error = `${this.result.recovery.error} | fallback: ${fallbackError && fallbackError.message}`;
      this.result.state = STATE.MANUAL_TAKEOVER_REQUIRED;
      this.result.manualTakeover = true;
      this.result.mixedState = 'UNKNOWN';
      this.result.evidence = this.buildManualEvidence(fallbackError);
      this.safeJournal('manual-takeover-required', {
        message: fallbackError && fallbackError.message,
        currentTreeHash: this.result.evidence.currentTreeHash
      });
    }
  }

  /** 校验当前卷是否与快照完全一致；一致则写入 result.final。 */
  verifyAgainstSnapshot(snapshot) {
    const after = this.inventoryOriginal();
    const diff = diffInventories(snapshot.rows, after.rows);
    if (!diff.equal) {
      throw new Error(`recovery verification failed: ${JSON.stringify({
        missing: diff.missing.slice(0, 10),
        differing: diff.differing.slice(0, 10),
        unexpected: diff.unexpected.slice(0, 10)
      })}`);
    }
    this.result.final = { treeHash: after.treeHash, state: 'v6_recovered' };
    this.result.mixedState = false;
  }

  /**
   * 兜底恢复：用 `<tx>/original/`（S3 copy-aside 并校验过 treeHash 的完整副本）重建 /data。
   * 适用于 journal/aside 不可用（例如 aside 被误删、journal 记录缺失、恢复中途再次失败）。
   */
  recoverFromOriginalCopy(snapshot) {
    assert(snapshot && Array.isArray(snapshot.rows), 'original snapshot rows required for fallback recovery');
    assert(exists(this.originalDir), `fallback recovery impossible: original copy missing at ${this.originalDir}`);
    const copyInv = inventory(this.originalDir);
    assert(copyInv.treeHash === snapshot.treeHash,
      `fallback recovery refused: original copy treeHash mismatch (copy=${copyInv.treeHash}, expected=${snapshot.treeHash})`);
    ensureDir(this.quarantineDir);
    this.safeJournal('fallback-recovery-start', { copyTreeHash: copyInv.treeHash });

    // 把当前 /data 顶层项整体移入 quarantine（保留，不删除）
    for (const name of fs.readdirSync(this.dataRoot)) {
      if (RESERVED_TOP_LEVEL.has(name)) continue;
      movePath(path.join(this.dataRoot, name), path.join(this.quarantineDir, `fallback-${name.replace(/[\\/]/g, '_')}`));
    }
    // 用校验过的 original/ 重建
    for (const name of fs.readdirSync(this.originalDir)) {
      copyTree(path.join(this.originalDir, name), path.join(this.dataRoot, name));
    }
    this.safeJournal('fallback-recovery-done');
  }

  /**
   * 按撤销清单**逆序**恢复。覆盖三种在途状态：
   *   - 已落位（aside + placed 完成）→ 当前值移入 quarantine，aside 移回原位；
   *   - 在途（aside 完成、placed 未完成，目标名暂时缺失）→ 直接把 aside 移回原位；
   *   - 新建（无 aside）→ 当前值移入 quarantine；
   *   - 本次新建的目录 → 移入 quarantine（恢复后不应残留）。
   */
  recoverToOriginal() {
    ensureDir(this.incomingDir);
    ensureDir(this.asideDir);
    ensureDir(this.quarantineDir);
    const journal = this.readJournal();
    // 测试注入点：在**任何撤销动作之前**失败，用来验证“数据会停在部分落位的混合状态，
    // 且必须分类为 MANUAL_TAKEOVER_REQUIRED”这一情形。
    this.failPointHit('recovery-before-undo');

    const asideByRel = new Map();
    const placedByRel = new Map();
    const placedOrder = [];
    const mkdirs = [];
    for (const row of journal) {
      if (row.op === 'aside' && row.rel) asideByRel.set(row.rel, path.join(this.asideDir, row.rel));
      if (row.op === 'placed' && row.rel) {
        placedByRel.set(row.rel, { hadAside: row.hadAside === true });
        placedOrder.push(row.rel);
      }
      if (row.op === 'mkdir' && row.rel) mkdirs.push(row.rel);
    }

    let undone = 0;
    for (const rel of placedOrder.slice().reverse()) {
      undone += 1;
      const info = placedByRel.get(rel);
      const dest = path.join(this.dataRoot, rel);
      if (exists(dest)) movePath(dest, path.join(this.quarantineDir, `${undone}-${rel.replace(/[\\/]/g, '_')}`));
      if (info.hadAside) {
        const asidePath = asideByRel.get(rel);
        assert(asidePath && exists(asidePath), `cannot restore "${rel}": aside copy missing at ${asidePath}`);
        movePath(asidePath, dest);
        this.journal('recovery-restore-aside', { rel });
      } else {
        this.journal('recovery-remove-created-file', { rel });
      }
      this.journal('recovery-undone', { rel, index: undone });
      this.failPointHitAfter('recovery-fail', undone);
      this.failPointHitAfter('recovery-fail-once', undone);
    }

    // 在途：aside 有、placed 没有 → 目标名缺失，把 aside 放回
    for (const [rel, asidePath] of asideByRel) {
      if (placedByRel.has(rel)) continue;
      const dest = path.join(this.dataRoot, rel);
      if (exists(dest)) movePath(dest, path.join(this.quarantineDir, `inflight-${rel.replace(/[\\/]/g, '_')}`));
      assert(exists(asidePath), `cannot restore in-flight "${rel}": aside missing`);
      movePath(asidePath, dest);
      this.journal('recovery-restore-inflight', { rel });
    }

    // 本次新建的目录：逆序移入 quarantine（此时应已空）
    for (const rel of mkdirs.slice().reverse()) {
      const dir = path.join(this.dataRoot, rel);
      if (!exists(dir)) continue;
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
        this.journal('recovery-remove-created-dir', { rel });
      } else {
        movePath(dir, path.join(this.quarantineDir, `mkdir-${rel.replace(/[\\/]/g, '_')}`));
        this.journal('recovery-quarantine-created-dir', { rel, remaining: remaining.length });
      }
    }

    // 本次生成的 incoming 残留：移入 quarantine（不删除）
    if (exists(this.incomingDir)) {
      for (const name of fs.readdirSync(this.incomingDir)) {
        movePath(path.join(this.incomingDir, name), path.join(this.quarantineDir, `incoming-${name}`));
      }
      this.journal('recovery-incoming-quarantined');
    }
    if (exists(this.stagingDir)) {
      movePath(this.stagingDir, path.join(this.quarantineDir, 'staging'));
      this.journal('recovery-staging-quarantined');
    }
  }

  buildManualEvidence(recoveryError) {
    let currentRows = [];
    let currentHash = '';
    try {
      const current = this.inventoryOriginal();
      currentRows = current.rows;
      currentHash = current.treeHash;
    } catch (error) {
      currentHash = `UNREADABLE: ${error.message}`;
    }
    return {
      message: '数据卷处于无法自动判定的状态，必须人工接管；不要启动后端。',
      dataRoot: this.dataRoot,
      operationId: this.opId,
      transactionDir: this.txRoot,
      journal: this.journalPath,
      currentTreeHash: currentHash,
      originalTreeHash: this.originalSnapshot ? this.originalSnapshot.treeHash : null,
      originalCopyIsIntact: exists(this.originalDir),
      originalCopyDir: this.originalDir,
      externalPostUpgradeArchive: this.postArchive,
      recoveryError: recoveryError ? recoveryError.message : null,
      currentFiles: currentRows.map((row) => `${row.type}:${row.path}:${row.sha256 || '-'}`).slice(0, 200),
      instructions: [
        '1) 保持后端停止（不要 docker compose up）。',
        '2) 用 originalTreeHash 与 <transactionDir>/original/ 比对，确认哪一态是完整的。',
        '3) 若 original/ 完整：可执行 --mode recover --op-id <id> --expected-original-tree-hash <hash> 重试自动恢复。',
        '4) 若仍失败：从 externalPostUpgradeArchive 解开到新卷，或从升级前归档做一次性恢复；全程保留 /data/.de-rollback 证据。',
        '5) 恢复成功后先只读校验，再启动服务。'
      ]
    };
  }

  finish() {
    this.result.finishedAt = nowIso();
    if (this.result.state === 'IN_PROGRESS') this.result.state = STATE.INTERNAL_ERROR;
    // “服务必须保持停止”只对需要人工/诊断介入的终态成立；
    // COMPLETED/PREFLIGHT_OK 数据已是可用状态，PREFLIGHT_ABORT 数据未变，均可按对应镜像启动。
    this.result.serviceMustStayStopped = [STATE.RECOVERED_TO_V6, STATE.MANUAL_TAKEOVER_REQUIRED, STATE.INTERNAL_ERROR]
      .includes(this.result.state);
    this.result.exitCode = EXIT_CODE[this.result.state] === undefined ? EXIT_CODE[STATE.INTERNAL_ERROR] : EXIT_CODE[this.result.state];
    try { this.journal('finish', { state: this.result.state, exitCode: this.result.exitCode }); } catch { /* ignore */ }
    if (this.evidenceOut) {
      try {
        ensureDir(path.dirname(this.evidenceOut));
        fs.writeFileSync(this.evidenceOut, `${JSON.stringify(this.result, null, 2)}\n`, 'utf8');
      } catch (error) {
        console.error(`[rollback] WARN cannot write evidence file: ${error.message}`);
      }
    }
    console.log(`[rollback] op=${this.opId} state=${this.result.state} exit=${this.result.exitCode}`);
    if (this.result.error) console.log(`[rollback] error=${this.result.error.message}`);
    if (this.result.recovery) console.log(`[rollback] recovery=${JSON.stringify(this.result.recovery)}`);
    if (this.result.manualTakeover) console.log('[rollback] MANUAL_TAKEOVER_REQUIRED — 保持后端停止，见 evidence');
  }

  readJournal() {
    if (!exists(this.journalPath)) return [];
    return fs.readFileSync(this.journalPath, 'utf8').split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  }

  inventoryOriginal() {
    const inv = inventory(this.dataRoot, { excludeTopLevel: RESERVED_TOP_LEVEL });
    inv.topLevelEntries = fs.readdirSync(this.dataRoot).filter((name) => !RESERVED_TOP_LEVEL.has(name)).sort();
    return inv;
  }
}

/* ------------------------------------------------------------------ CLI */

const FAIL_POINTS = new Set([
  'after-inventory', 'post-archive-unreadable', 'partial-aside-copy',
  'staging-missing-state', 'staging-tamper', 'partial-staging-extract',
  'partial-landing-copy', 'partial-landing', 'final-verify',
  'hard-exit', 'recovery-fail', 'recovery-fail-once', 'recovery-before-undo',
  'corrupt-original-copy'
]);

function parseArgs(argv) {
  const args = { mode: 'rollback', backendStoppedAsserted: false, failAfter: 0, failPoints: [], failAfterByPoint: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) throw new Error(`missing value for ${token}`);
      return value;
    };
    switch (token) {
      case '--mode': args.mode = next(); break;
      case '--data-root': args.dataRoot = next(); break;
      case '--pre-archive': args.preArchive = next(); break;
      case '--post-archive': args.postArchive = next(); break;
      case '--evidence-out': args.evidenceOut = next(); break;
      case '--expected-pre-tree-hash': args.expectedPreTreeHash = String(next()).toUpperCase(); break;
      case '--expected-post-tree-hash': args.expectedPostTreeHash = String(next()).toUpperCase(); break;
      case '--expected-original-tree-hash': args.expectedOriginalTreeHash = String(next()).toUpperCase(); break;
      case '--op-id': args.opId = next(); break;
      case '--volume-name': args.volumeName = next(); break;
      case '--backend-stopped-asserted': args.backendStoppedAsserted = true; break;
      case '--fail-point': {
        const name = next();
        if (!FAIL_POINTS.has(name)) throw new Error(`unknown fail-point: ${name}`);
        args.failPoints.push(name);
        break;
      }
      case '--fail-after': {
        const raw = next();
        const match = /^([a-z0-9-]+)=(\d+)$/.exec(raw);
        if (match) args.failAfterByPoint[match[1]] = Number.parseInt(match[2], 10);
        else args.failAfter = Number.parseInt(raw, 10);
        break;
      }
      default: throw new Error(`unknown argument: ${token}`);
    }
  }
  if (!args.opId) {
    args.opId = `rollback-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[rollback] ARG ERROR: ${error.message}`);
    process.exit(EXIT_CODE[STATE.INTERNAL_ERROR]);
  }
  if (!args.dataRoot) {
    console.error('[rollback] ARG ERROR: --data-root is required');
    process.exit(EXIT_CODE[STATE.INTERNAL_ERROR]);
  }
  const result = new RollbackTransaction(args).run();
  console.log(`[rollback] summary: ${JSON.stringify({
    opId: result.opId,
    state: result.state,
    serviceMustStayStopped: result.serviceMustStayStopped,
    mixedState: result.mixedState,
    manualTakeover: result.manualTakeover,
    originalTreeHash: result.original ? result.original.treeHash : null,
    stagingTreeHash: result.staging ? result.staging.treeHash : null,
    finalTreeHash: result.final ? result.final.treeHash : null,
    preservedExtras: result.preservedExtras
  })}`);
  process.exit(result.exitCode);
}

process.on('uncaughtException', (error) => {
  console.error(`[rollback] UNCAUGHT: ${error && error.stack ? error.stack : error}`);
  process.exit(EXIT_CODE[STATE.INTERNAL_ERROR]);
});

if (require.main === module) main();

module.exports = { RollbackTransaction, inventory, diffInventories, sha256File, STATE, EXIT_CODE, TX_DIRNAME };
