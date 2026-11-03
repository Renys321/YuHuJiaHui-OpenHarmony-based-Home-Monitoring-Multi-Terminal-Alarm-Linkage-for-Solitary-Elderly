'use strict';

/*
 * Process-level lifecycle probe for the public-sync supervisor candidate.
 *
 * It uses the REAL supervisor and REAL worker against a local stub public-sync
 * entry. No network, no devices, no production key. It exercises:
 *   1. exactly one supervisor + one worker, HEALTHY state, key-free files;
 *   2. supervisor force-kill -> orphan worker exits by IPC disconnect;
 *   3. stale lock takeover on the next start, no second worker;
 *   4. worker force-kill -> automatic restart, no double worker, state recorded;
 *   5. worker/supervisor force-kill leaves no node.exe leftovers.
 *
 * Usage: node test/lifecycle-probe.js
 * Exit code 0 = all probes passed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HARNESS = path.join(__dirname, 'probe-harness.js');
const RESULTS = [];
let runtimeDir = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

async function waitFor(label, fn, timeoutMs = 15000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`${label} timeout after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

function readState() {
  const file = path.join(runtimeDir, 'state.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLock() {
  const file = path.join(runtimeDir, 'lock');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').trim();
}

function readLog() {
  const file = path.join(runtimeDir, 'supervisor.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function startHarness() {
  return spawn(process.execPath, [HARNESS, runtimeDir], {
    stdio: 'ignore',
    windowsHide: true,
    env: process.env
  });
}

function record(name, details = {}) {
  RESULTS.push({ name, pass: true, ...details });
  console.log(`PASS ${name} ${JSON.stringify(details)}`);
}

function countNodeProcesses() {
  const result = spawnSync('tasklist', ['/fo', 'csv', '/fi', 'imagename eq node.exe'], { encoding: 'utf8' });
  const text = `${result.stdout || ''}`;
  return text.split(/\r?\n/).filter((line) => /node\.exe/i.test(line)).length;
}

async function cleanup(children) {
  for (const child of children) {
    if (child && child.pid && pidAlive(child.pid)) {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
  }
  await sleep(300);
  const leftovers = [];
  const pending = [];
  if (fs.existsSync(runtimeDir)) {
    for (const name of fs.readdirSync(runtimeDir)) {
      if (name.endsWith('.pid')) pending.push(name);
    }
  }
  for (const name of pending) leftovers.push(name);
  if (leftovers.length > 0) console.log(`note: ${leftovers.join(', ')}`);
  try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

async function main() {
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-sync-supervisor-probe-'));
  const children = [];
  const baselineNodeProcesses = countNodeProcesses();
  console.log(`note: baseline node.exe count = ${baselineNodeProcesses} (includes this probe)`);
  let exitCode = 0;

  try {
    /* ---- 1. single supervisor + single worker, HEALTHY ---- */
    const first = startHarness();
    children.push(first);
    await waitFor('first HEALTHY', () => {
      const state = readState();
      return state && state.state === 'HEALTHY' && state.workerPid ? state : null;
    }, 20000);
    const state1 = readState();
    assert.equal(state1.supervisorPid, first.pid, 'state.supervisorPid must be the harness supervisor');
    assert.ok(pidAlive(state1.workerPid), 'worker must be alive');
    assert.equal(readLock(), String(first.pid), 'lock must point at supervisor');
    const worker1 = state1.workerPid;
    const keyFree = !readState().state.includes('INGEST_KEY');
    const log1 = readLog();
    assert.match(log1, /\[supervisor\] WORKER_START pid=\d+/);
    assert.match(log1, /\[supervisor\] HEALTHY pid=\d+/);
    assert.equal(log1.includes('PROBE_ONLY_KEY_NOT_A_SECRET'), false, 'log must not contain key');
    record('single supervisor + single worker HEALTHY, key-free state/lock/log', {
      supervisorPid: first.pid,
      workerPid: worker1,
      keyFree,
      heartbeatAt: state1.heartbeatAt
    });

    /* ---- 2. heartbeat refreshes runtime state ---- */
    const beat1 = readState().heartbeatAt;
    await waitFor('heartbeat advance', () => readState().heartbeatAt > beat1, 6000);
    record('runtime state heartbeat advances', { from: beat1, to: readState().heartbeatAt });

    /* ---- 3. force-kill supervisor: orphan worker must exit by IPC disconnect ---- */
    const killedAt = Date.now();
    try { first.kill('SIGKILL'); } catch (_) { /* ignore */ }
    await waitFor('orphan worker exit', () => !pidAlive(worker1), 10000);
    const orphanExitMs = Date.now() - killedAt;
    assert.equal(pidAlive(worker1), false, 'worker must not survive supervisor kill');
    assert.equal(readLock(), String(first.pid), 'dead supervisor leaves stale lock (expected)');
    record('supervisor force-kill -> worker exits by disconnect (no orphan)', {
      workerPid: worker1,
      exitAfterMs: orphanExitMs,
      staleLockPid: readLock()
    });

    /* ---- 4. next start takes over stale lock; no second worker ---- */
    const second = startHarness();
    children.push(second);
    await waitFor('second HEALTHY', () => {
      const state = readState();
      return state && state.state === 'HEALTHY' && state.supervisorPid === second.pid && state.workerPid;
    }, 20000);
    const state2 = readState();
    assert.equal(readLock(), String(second.pid), 'lock must be taken over by the new supervisor');
    assert.notEqual(state2.supervisorPid, state1.supervisorPid, 'new supervisor PID');
    assert.ok(pidAlive(state2.workerPid), 'new worker must be alive');
    assert.equal(state2.workerPid === worker1, false, 'new worker PID must differ');
    assert.equal(pidAlive(worker1), false, 'old worker must stay dead (no double instance)');
    const log2 = readLog();
    assert.match(log2, /STALE_LOCK_TAKEOVER dead_pid=/);
    record('stale lock takeover with a single new worker', {
      oldSupervisorPid: state1.supervisorPid,
      newSupervisorPid: state2.supervisorPid,
      oldWorkerPid: worker1,
      newWorkerPid: state2.workerPid
    });

    /* ---- 5. force-kill worker: automatic restart, no double instance ---- */
    const worker2 = state2.workerPid;
    try { process.kill(worker2, 'SIGKILL'); } catch (error) {
      throw new Error(`failed to kill worker ${worker2}: ${error.message}`);
    }
    await waitFor('worker restart', () => {
      const state = readState();
      return state && state.workerPid && state.workerPid !== worker2 && pidAlive(state.workerPid);
    }, 15000);
    const state3 = readState();
    assert.equal(state3.supervisorPid, second.pid, 'supervisor must keep running');
    assert.equal(pidAlive(worker2), false, 'killed worker must stay dead');
    assert.ok(pidAlive(state3.workerPid), 'replacement worker must be alive');
    const log3 = readLog();
    assert.match(log3, /WORKER_EXIT code=/);
    assert.match(log3, /RESTART_IN \d+ms/);
    assert.match(log3, /WORKER_START pid=/);
    record('worker force-kill -> supervisor auto-restarts a single worker', {
      killedWorkerPid: worker2,
      replacementWorkerPid: state3.workerPid,
      restartCount: state3.restartCount,
      supervisorPid: state3.supervisorPid
    });

    /* ---- 6. stop everything and check no probe-owned node leftovers ---- */
    try { second.kill('SIGKILL'); } catch (_) { /* ignore */ }
    await waitFor('replacement worker exit after supervisor kill', () => !pidAlive(state3.workerPid), 10000);
    await waitFor('node process count returns to baseline', () => countNodeProcesses() <= baselineNodeProcesses, 10000);
    const nodeCount = countNodeProcesses();
    assert.ok(
      nodeCount <= baselineNodeProcesses,
      `probe must not leave node.exe behind: baseline=${baselineNodeProcesses} final=${nodeCount}`
    );
    record('no orphan node.exe after supervisor kill', {
      baselineNodeProcesses,
      finalNodeProcesses: nodeCount
    });
  } catch (error) {
    exitCode = 1;
    console.error(`FAIL ${error && error.message}`);
    console.error(error && error.stack);
    const log = readLog();
    if (log) console.error(`--- supervisor.log ---\n${log}`);
  } finally {
    await cleanup(children);
  }

  console.log('');
  console.log(`PROBE SUMMARY: ${RESULTS.length} passed, ${exitCode === 0 ? 0 : 1} failed`);
  console.log(JSON.stringify({ results: RESULTS, pass: exitCode === 0 }, null, 2));
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
