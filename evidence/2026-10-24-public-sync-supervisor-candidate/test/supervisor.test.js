'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PublicSyncSupervisor, acquireLock, pidAlive, writeAtomic
} = require('../public-sync-supervisor');

const TEST_KEY = 'TEST_ONLY_INGEST_KEY_9f3a7d0e2b1c';
const FAKE = path.join(__dirname, 'fake-worker.js');
const activeSupervisors = [];

test.afterEach(async () => {
  while (activeSupervisors.length > 0) {
    const s = activeSupervisors.pop();
    await s.stop();
  }
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'public-sync-supervisor-test-'));
}

function makeSupervisor(dir, extra = {}) {
  const logs = [];
  return {
    logs,
    supervisor: new PublicSyncSupervisor({
      workerScript: FAKE,
      stateFile: path.join(dir, 'state.json'),
      lockFile: path.join(dir, 'lock'),
      readKey: async () => TEST_KEY,
      backoffMs: [10, 20, 40, 80],
      circuitWindowMs: 2000,
      maxCrashes: 3,
      log: (line) => logs.push(line),
      ...extra
    })
  };
}

async function waitFor(fn, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
}

test('stale lock takeover and live lock refusal', () => {
  const dir = tempDir();
  const lock = path.join(dir, 'lock');
  fs.writeFileSync(lock, '999999', 'utf8');
  assert.equal(pidAlive(999999), false);
  const stale = acquireLock(lock, process.pid);
  assert.equal(stale.ok, true);
  assert.equal(stale.stalePid, 999999);
  fs.unlinkSync(lock);

  fs.writeFileSync(lock, String(process.pid), 'utf8');
  const live = acquireLock(lock, process.pid + 1000);
  assert.equal(live.ok, false);
  fs.unlinkSync(lock);
});

test('runtime state is written atomically without key material', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  writeAtomic(file, '{"state":"HEALTHY"}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"state":"HEALTHY"}\n');
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('healthy worker receives key via IPC and no key leaks', async () => {
  const dir = tempDir();
  const result = path.join(dir, 'worker.jsonl');
  process.env.FAKE_WORKER_RESULT = result;
  process.env.FAKE_WORKER_MODE = 'stay';
  const { supervisor, logs } = makeSupervisor(dir);
  activeSupervisors.push(supervisor);
  assert.equal(await supervisor.start(), true);
  await waitFor(() => supervisor.state === 'HEALTHY');
  const stateText = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const lockText = fs.readFileSync(path.join(dir, 'lock'), 'utf8');
  const rows = fs.readFileSync(result, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].keyReceived, true);
  assert.ok(rows[0].keyLength > 0);
  assert.equal(rows[0].envIngestKey, false);
  assert.equal(stateText.includes(TEST_KEY), false);
  assert.equal(lockText.includes(TEST_KEY), false);
  assert.equal(logs.join('\n').includes(TEST_KEY), false);
  assert.equal(supervisor.child !== null, true);
  await supervisor.stop();
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
});

test('abnormal worker exit restarts once at a time', async () => {
  const dir = tempDir();
  const result = path.join(dir, 'worker.jsonl');
  process.env.FAKE_WORKER_RESULT = result;
  process.env.FAKE_WORKER_MODE = 'crash';
  const { supervisor } = makeSupervisor(dir);
  activeSupervisors.push(supervisor);
  assert.equal(await supervisor.start(), true);
  await waitFor(() => supervisor.restartCount >= 1);
  assert.equal(supervisor.lastScheduledDelayMs, 10);
  await waitFor(() => supervisor.restartCount >= 2);
  assert.equal(supervisor.lastScheduledDelayMs, 20);
  await waitFor(() => supervisor.child !== null);
  await supervisor.stop();
});

test('circuit opens after repeated abnormal exits', async () => {
  const dir = tempDir();
  const result = path.join(dir, 'worker.jsonl');
  process.env.FAKE_WORKER_RESULT = result;
  process.env.FAKE_WORKER_MODE = 'crash';
  const { supervisor } = makeSupervisor(dir, { maxCrashes: 2, backoffMs: [10, 10] });
  activeSupervisors.push(supervisor);
  assert.equal(await supervisor.start(), true);
  await waitFor(() => supervisor.state === 'CIRCUIT_OPEN');
  assert.equal(supervisor.child, null);
  await supervisor.stop();
});

test('normal worker exit stops supervisor and cleans lock', async () => {
  const dir = tempDir();
  const result = path.join(dir, 'worker.jsonl');
  process.env.FAKE_WORKER_RESULT = result;
  process.env.FAKE_WORKER_MODE = 'normal';
  const { supervisor } = makeSupervisor(dir);
  activeSupervisors.push(supervisor);
  assert.equal(await supervisor.start(), true);
  await waitFor(() => supervisor.state === 'STOPPED');
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
});

test('signal exit is recorded and restarted', async () => {
  const dir = tempDir();
  const result = path.join(dir, 'worker.jsonl');
  process.env.FAKE_WORKER_RESULT = result;
  process.env.FAKE_WORKER_MODE = 'signal';
  const { supervisor } = makeSupervisor(dir);
  activeSupervisors.push(supervisor);
  assert.equal(await supervisor.start(), true);
  await waitFor(() => supervisor.restartCount >= 1);
  assert.ok(supervisor.lastWorkerExit !== null);
  // Windows Node may report code=1/signal=null for a self-kill; either is abnormal.
  assert.ok(supervisor.lastWorkerExit.code !== 0 || supervisor.lastWorkerExit.signal !== null);
  await supervisor.stop();
});

test('persistent log and state expose pids without key material', async () => {
  const dir = tempDir();
  const result = path.join(dir, 'worker.jsonl');
  process.env.FAKE_WORKER_RESULT = result;
  process.env.FAKE_WORKER_MODE = 'stay';
  const logFile = path.join(dir, 'supervisor.log');
  const { supervisor } = makeSupervisor(dir, { logFile });
  activeSupervisors.push(supervisor);
  assert.equal(await supervisor.start(), true);
  await waitFor(() => supervisor.state === 'HEALTHY');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.supervisorPid, process.pid);
  assert.equal(state.workerPid, supervisor.child.pid);
  assert.equal(typeof state.heartbeatAt, 'number');
  await supervisor.stop();
  const text = fs.readFileSync(logFile, 'utf8');
  assert.match(text, /\[supervisor\] LOCK_ACQUIRED pid=/);
  assert.match(text, /\[supervisor\] WORKER_START pid=\d+/);
  assert.match(text, /\[supervisor\] HEALTHY pid=\d+/);
  assert.match(text, /\[supervisor\] STOPPED/);
  assert.equal(text.includes(TEST_KEY), false);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes('.tmp-')),
    []
  );
});

test('heartbeat keeps refreshing runtime state while healthy', async () => {
  const dir = tempDir();
  process.env.FAKE_WORKER_RESULT = path.join(dir, 'worker.jsonl');
  process.env.FAKE_WORKER_MODE = 'stay';
  const { supervisor } = makeSupervisor(dir, { heartbeatMs: 60 });
  activeSupervisors.push(supervisor);
  assert.equal(await supervisor.start(), true);
  await waitFor(() => supervisor.state === 'HEALTHY');
  const stateFile = path.join(dir, 'state.json');
  const first = JSON.parse(fs.readFileSync(stateFile, 'utf8')).heartbeatAt;
  await new Promise((resolve) => setTimeout(resolve, 220));
  const second = JSON.parse(fs.readFileSync(stateFile, 'utf8')).heartbeatAt;
  assert.ok(second > first, 'heartbeatAt must advance');
  await supervisor.stop();
});

test('second supervisor refuses a live lock', async () => {
  const dir = tempDir();
  process.env.FAKE_WORKER_MODE = 'stay';
  process.env.FAKE_WORKER_RESULT = path.join(dir, 'worker.jsonl');
  const first = makeSupervisor(dir).supervisor;
  const second = new PublicSyncSupervisor({
    workerScript: FAKE,
    stateFile: path.join(dir, 'state2.json'),
    lockFile: path.join(dir, 'lock'),
    readKey: async () => TEST_KEY,
    log: () => {}
  });
  activeSupervisors.push(first);
  assert.equal(await first.start(), true);
  assert.equal(await second.start(), false);
  await first.stop();
});
