'use strict';
/*
 * public-sync-supervisor.test.js — supervisor 自动恢复能力回归（2026-10-27）
 *
 * 覆盖 2026-10-27 事故暴露的代码级缺陷（全部是进程/文件层，不连接任何真实后端）：
 *   1. 陈旧 lock（PID 已退出）自动接管，不需要人工删文件；
 *   2. worker 异常退出后按退避自动重启；
 *   3. 熔断 CIRCUIT_OPEN 是**有界**的：保持一段时间后自动重试，不再永久停摆；
 *   4. worker 干净退出（code 0）→ STOPPED 并清理 lock；
 *   5. evaluateSupervisorHealth：只写 HEALTHY 但进程已死的陈旧状态必须判为不健康；
 *   6. --check 只读 CLI：healthy 退出码 0、不健康退出码 3。
 *
 * worker 使用 fixtures/public-sync-fake-worker.js（显式 MOCK），不访问网络。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PublicSyncSupervisor,
  evaluateSupervisorHealth,
  DEFAULT_CIRCUIT_HOLD_MS
} = require('./public-sync-supervisor');

const WORKER = path.join(__dirname, 'fixtures', 'public-sync-fake-worker.js');
const SUPERVISOR = path.join(__dirname, 'public-sync-supervisor.js');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'public-sync-supervisor-test-'));

function makePaths(tag) {
  const dir = path.join(tmpRoot, tag);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    stateFile: path.join(dir, 'supervisor.state.json'),
    lockFile: path.join(dir, 'supervisor.lock'),
    logFile: path.join(dir, 'supervisor.log')
  };
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function makeSupervisor(paths, extra = {}) {
  const lines = [];
  const supervisor = new PublicSyncSupervisor(Object.assign({
    publicSyncEntry: path.join(__dirname, 'public-sync.js'),
    workerScript: WORKER,
    stateFile: paths.stateFile,
    lockFile: paths.lockFile,
    logFile: paths.logFile,
    heartbeatMs: 60000,
    readKey: async () => 'unit-test-key-not-a-real-secret',
    log: (line) => { lines.push(line); }
  }, extra));
  supervisor.testLines = lines;
  return supervisor;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('等待超时: ' + label);
    await sleep(15);
  }
}

function setWorkerMode(mode) {
  if (mode === null) delete process.env.TEST_FAKE_WORKER_MODE;
  else process.env.TEST_FAKE_WORKER_MODE = mode;
}

test.after(() => {
  setWorkerMode(null);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
});

test('陈旧 lock（死 PID）自动接管并写入新状态', async () => {
  setWorkerMode('stay');
  const paths = makePaths('stale-lock');
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.lockFile, '999999', 'utf8');
  const supervisor = makeSupervisor(paths);
  try {
    const started = await supervisor.start();
    assert.equal(started, true, 'stale lock 应被接管');
    assert.ok(supervisor.testLines.some((l) => l.indexOf('STALE_LOCK_TAKEOVER') >= 0), '应记录陈旧锁接管');
    assert.equal(fs.readFileSync(paths.lockFile, 'utf8').trim(), String(process.pid));
    await waitFor(() => {
      const state = readState(paths.stateFile);
      return state && state.state === 'HEALTHY' && state.workerPid > 0;
    }, 'worker 正常后状态为 HEALTHY');
  } finally {
    await supervisor.stop();
  }
  const finalState = readState(paths.stateFile);
  assert.equal(finalState.state, 'STOPPED');
  assert.equal(fs.existsSync(paths.lockFile), false, '停止后必须清理自己的 lock');
});

test('worker 异常退出自动重启；熔断有界并在 hold 后重试', async () => {
  setWorkerMode('exit1');
  const paths = makePaths('circuit');
  const supervisor = makeSupervisor(paths, {
    backoffMs: [15],
    circuitWindowMs: 60000,
    maxCrashes: 2,
    circuitHoldMs: 150
  });
  try {
    const started = await supervisor.start();
    assert.equal(started, true);
    await waitFor(() => supervisor.testLines.some((l) => l.indexOf('CIRCUIT_OPEN') >= 0), '进入熔断');
    const circuitState = readState(paths.stateFile);
    assert.equal(circuitState.state, 'CIRCUIT_OPEN');
    assert.equal(circuitState.circuitHoldMs, 150);
    /* 旧实现会永远停在 CIRCUIT_OPEN；新实现必须在 hold 到期后自行重试。 */
    await waitFor(() => supervisor.testLines.some((l) => l.indexOf('CIRCUIT_CLOSED_RETRY') >= 0), '熔断到期重试', 4000);
    await waitFor(() => {
      const starts = supervisor.testLines.filter((l) => l.indexOf('WORKER_START') >= 0).length;
      return starts >= 4;
    }, '熔断后重新拉起 worker', 4000);
  } finally {
    await supervisor.stop();
  }
});

test('worker 干净退出（code 0）→ STOPPED 且不重启', async () => {
  setWorkerMode('exit0');
  const paths = makePaths('clean-exit');
  const supervisor = makeSupervisor(paths);
  await supervisor.start();
  await waitFor(() => supervisor.testLines.some((l) => l.indexOf('WORKER_EXITED_CLEANLY') >= 0), '干净退出生效', 4000);
  await sleep(150);
  assert.equal(readState(paths.stateFile).state, 'STOPPED');
  assert.equal(fs.existsSync(paths.lockFile), false);
  assert.equal(supervisor.testLines.filter((l) => l.indexOf('WORKER_START') >= 0).length, 1, '干净退出后不得重启');
});

test('evaluateSupervisorHealth：陈旧 HEALTHY 状态必须判为不健康', () => {
  const now = 1_800_000_000_000;
  const aliveSet = new Set([1001, 2002]);
  const pidAlive = (pid) => aliveSet.has(pid);

  const healthy = evaluateSupervisorHealth({
    nowMs: now,
    pidAlive,
    lockPid: 1001,
    state: { supervisorPid: 1001, workerPid: 2002, state: 'HEALTHY', heartbeatAt: now - 10_000 }
  });
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.reason, 'HEALTHY');

  /* 2026-10-27 现场形态：state 写着 HEALTHY，但 PID 29048/30608 都已不存在。 */
  const stalePids = evaluateSupervisorHealth({
    nowMs: now,
    pidAlive,
    lockPid: 29048,
    state: { supervisorPid: 29048, workerPid: 30608, state: 'HEALTHY', heartbeatAt: now - 7 * 3600 * 1000 }
  });
  assert.equal(stalePids.healthy, false);
  assert.equal(stalePids.reason, 'STALE_LOCK');

  const staleHeartbeat = evaluateSupervisorHealth({
    nowMs: now,
    pidAlive,
    lockPid: 1001,
    state: { supervisorPid: 1001, workerPid: 2002, state: 'HEALTHY', heartbeatAt: now - 10 * 60 * 1000 }
  });
  assert.equal(staleHeartbeat.healthy, false);
  assert.equal(staleHeartbeat.reason, 'STALE_HEARTBEAT');

  const deadWorker = evaluateSupervisorHealth({
    nowMs: now,
    pidAlive,
    lockPid: 1001,
    state: { supervisorPid: 1001, workerPid: 9999, state: 'HEALTHY', heartbeatAt: now - 1000 }
  });
  assert.equal(deadWorker.healthy, false);
  assert.equal(deadWorker.reason, 'WORKER_DEAD');

  const circuit = evaluateSupervisorHealth({
    nowMs: now,
    pidAlive,
    lockPid: 1001,
    state: { supervisorPid: 1001, workerPid: 0, state: 'CIRCUIT_OPEN', heartbeatAt: now - 1000 }
  });
  assert.equal(circuit.healthy, false);
  assert.equal(circuit.reason, 'CIRCUIT_OPEN');

  const nothing = evaluateSupervisorHealth({ nowMs: now, pidAlive, state: null, lockPid: 0 });
  assert.equal(nothing.healthy, false);
  assert.equal(nothing.reason, 'NO_SUPERVISOR');
  assert.ok(DEFAULT_CIRCUIT_HOLD_MS > 0);
});

test('--check 只读 CLI：陈旧状态退出码 3，健康状态退出码 0', () => {
  const paths = makePaths('check-cli');
  fs.writeFileSync(paths.lockFile, '999999', 'utf8');
  fs.writeFileSync(paths.stateFile, JSON.stringify({
    supervisorPid: 999999,
    workerPid: 0,
    state: 'HEALTHY',
    heartbeatAt: Date.now() - 60_000
  }), 'utf8');
  const stale = runCheck(paths);
  assert.equal(stale.code, 3, '陈旧状态必须退出码 3');
  const staleJson = JSON.parse(stale.stdout);
  assert.equal(staleJson.healthy, false);
  assert.equal(staleJson.reason, 'STALE_LOCK');

  /* 用当前测试进程 PID 冒充存活 supervisor/worker，heartbeat 新鲜 → healthy */
  fs.writeFileSync(paths.lockFile, String(process.pid), 'utf8');
  fs.writeFileSync(paths.stateFile, JSON.stringify({
    supervisorPid: process.pid,
    workerPid: process.pid,
    state: 'HEALTHY',
    heartbeatAt: Date.now()
  }), 'utf8');
  const healthy = runCheck(paths);
  assert.equal(healthy.code, 0, '健康状态必须退出码 0: ' + healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).healthy, true);
});

function runCheck(paths) {
  const out = path.join(paths.dir, 'check.out.json');
  const err = path.join(paths.dir, 'check.err.txt');
  const fdOut = fs.openSync(out, 'w');
  const fdErr = fs.openSync(err, 'w');
  const executed = childProcess.spawnSync(process.execPath, [
    SUPERVISOR, '--check',
    '--state-file', paths.stateFile,
    '--lock-file', paths.lockFile
  ], { stdio: ['ignore', fdOut, fdErr], windowsHide: true });
  fs.closeSync(fdOut);
  fs.closeSync(fdErr);
  return {
    code: executed.status,
    stdout: fs.readFileSync(out, 'utf8'),
    stderr: fs.readFileSync(err, 'utf8')
  };
}
