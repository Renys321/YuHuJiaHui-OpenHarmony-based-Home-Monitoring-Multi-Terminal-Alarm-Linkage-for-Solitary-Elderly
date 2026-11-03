'use strict';

/*
 * public-sync supervisor candidate.
 *
 * - Reads INGEST_KEY once from a real TTY (hidden).
 * - Holds the key only in this process memory.
 * - Sends it to exactly one worker via Node IPC.
 * - Never puts the key in argv, env, files, lock, runtime state or logs.
 * - Restarts the worker with bounded backoff; opens a circuit after repeated
 *   abnormal exits.
 * - Writes a persistent, key-free event log (supervisor + worker stdout/stderr)
 *   so a process-tree disappearance is no longer "no record".
 * - Refreshes runtime state with a heartbeat so a silent supervisor death is
 *   observable afterwards.
 *
 * This candidate does NOT deploy itself. It does NOT persist the key.
 */
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

const DEFAULT_PUBLIC_SYNC_ENTRY = 'D:\\OpenHarmony\\competition\\cloud\\onenet\\public-sync.js';
const DEFAULT_WORKER_SCRIPT = path.join(__dirname, 'public-sync-worker.js');
const DEFAULT_STATE_FILE = path.join(__dirname, 'runtime', 'public-sync-supervisor.state.json');
const DEFAULT_LOCK_FILE = path.join(__dirname, 'runtime', 'public-sync-supervisor.lock');
const DEFAULT_LOG_FILE = path.join(__dirname, 'runtime', 'public-sync-supervisor.log');
const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const DEFAULT_MAX_BACKOFF_MS = 30000;
const DEFAULT_CIRCUIT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CRASHES = 3;
const DEFAULT_HEARTBEAT_MS = 30 * 1000;
/* 熔断保持时间：旧实现是 setTimeout 1 小时空转、永不恢复 —— 一旦 worker 连续崩溃
 * 3 次（例如当时后端不可达/控制台事件），supervisor 就永久停在 CIRCUIT_OPEN，
 * 之后即使现场恢复也再也不会拉起 worker。改为有界熔断：保持一段时间后用完整退避
 * 重试；再次崩满才会重新熔断。 */
const DEFAULT_CIRCUIT_HOLD_MS = 60 * 1000;

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readPidFile(file) {
  try {
    const value = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (_) {
    return 0;
  }
}

function writeAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, value, 'utf8');
  fs.renameSync(temp, file);
}

function acquireLock(lockFile, ownerPid) {
  const dir = path.dirname(lockFile);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, String(ownerPid), 'utf8');
    fs.closeSync(fd);
    return { ok: true, stalePid: 0 };
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const oldPid = readPidFile(lockFile);
  if (pidAlive(oldPid)) {
    return { ok: false, stalePid: oldPid };
  }
  try { fs.unlinkSync(lockFile); } catch (_) { /* retry below */ }
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, String(ownerPid), 'utf8');
    fs.closeSync(fd);
    return { ok: true, stalePid: oldPid };
  } catch (error) {
    return { ok: false, stalePid: oldPid, error };
  }
}

class PublicSyncSupervisor {
  constructor(options = {}) {
    this.publicSyncEntry = options.publicSyncEntry || DEFAULT_PUBLIC_SYNC_ENTRY;
    this.workerScript = options.workerScript || DEFAULT_WORKER_SCRIPT;
    this.stateFile = options.stateFile || DEFAULT_STATE_FILE;
    this.lockFile = options.lockFile || DEFAULT_LOCK_FILE;
    this.logFile = typeof options.logFile === 'string' ? options.logFile : '';
    this.backoffMs = options.backoffMs || DEFAULT_BACKOFF_MS.slice();
    this.maxBackoffMs = options.maxBackoffMs || DEFAULT_MAX_BACKOFF_MS;
    this.circuitWindowMs = options.circuitWindowMs || DEFAULT_CIRCUIT_WINDOW_MS;
    this.maxCrashes = options.maxCrashes || DEFAULT_MAX_CRASHES;
    this.circuitHoldMs = Number.isSafeInteger(options.circuitHoldMs) && options.circuitHoldMs > 0
      ? options.circuitHoldMs
      : DEFAULT_CIRCUIT_HOLD_MS;
    this.heartbeatMs = Number.isSafeInteger(options.heartbeatMs) && options.heartbeatMs > 0
      ? options.heartbeatMs
      : DEFAULT_HEARTBEAT_MS;
    this.readKey = options.readKey || this.defaultReadKey.bind(this);
    // Injected sinks keep unit tests simple; the file sink is additive and must
    // never receive key material.
    this.logSink = options.log || ((line) => console.log(line));
    this.lineBuffers = { stdout: '', stderr: '' };
    this.logFileReady = false;

    this.key = '';
    this.child = null;
    this.stopping = false;
    this.restartTimer = null;
    this.circuitHold = null;
    this.heartbeatTimer = null;
    this.startedAt = Date.now();
    this.restartCount = 0;
    this.lastHealthyAt = 0;
    this.lastWorkerStartedAt = 0;
    this.lastWorkerExit = null;
    this.crashTimes = [];
    this.lastScheduledDelayMs = 0;
    this.state = 'NOT_RUNNING';
    this.acquired = false;
  }

  async defaultReadKey() {
    const { readHidden } = require(this.publicSyncEntry);
    if (typeof readHidden !== 'function') throw new Error('public-sync readHidden unavailable');
    return readHidden('Enter public backend INGEST_KEY for supervisor (hidden): ');
  }

  appendLogLine(line) {
    if (!this.logFile) return;
    try {
      if (!this.logFileReady) {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        this.logFileReady = true;
      }
      fs.appendFileSync(this.logFile, line + '\n', 'utf8');
    } catch (_) {
      /* The log file must never take the supervisor down. */
    }
  }

  log(line) {
    this.appendLogLine(`${new Date().toISOString()} ${line}`);
    try { this.logSink(line); } catch (_) { /* ignore sink failure */ }
  }

  appendWorkerChunk(name, chunk) {
    if (!this.logFile) return;
    const buffered = (this.lineBuffers[name] || '') + String(chunk);
    const parts = buffered.split('\n');
    this.lineBuffers[name] = parts.pop();
    const stamp = new Date().toISOString();
    for (const part of parts) {
      this.appendLogLine(`${stamp} [worker:${name}] ${part}`);
    }
  }

  flushWorkerBuffers() {
    if (!this.logFile) return;
    const stamp = new Date().toISOString();
    for (const name of Object.keys(this.lineBuffers)) {
      const rest = this.lineBuffers[name];
      this.lineBuffers[name] = '';
      if (rest) this.appendLogLine(`${stamp} [worker:${name}] ${rest}`);
    }
  }

  writeState(nextState, extra = {}) {
    this.state = nextState;
    const payload = {
      supervisorPid: process.pid,
      workerPid: this.child && this.child.pid ? this.child.pid : 0,
      state: nextState,
      startedAt: this.startedAt,
      heartbeatAt: Date.now(),
      restartCount: this.restartCount,
      lastWorkerStartedAt: this.lastWorkerStartedAt,
      lastWorkerExit: this.lastWorkerExit,
      lastHealthyAt: this.lastHealthyAt,
      ...extra
    };
    writeAtomic(this.stateFile, JSON.stringify(payload, null, 2) + '\n');
  }

  startHeartbeat() {
    if (this.heartbeatTimer || !(this.heartbeatMs > 0)) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.stopping) return;
      if (this.state === 'HEALTHY' || this.state === 'STARTING' || this.state === 'RESTARTING') {
        try { this.writeState(this.state); } catch (_) { /* ignore */ }
      }
    }, this.heartbeatMs);
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  cleanupLock() {
    try {
      const owner = readPidFile(this.lockFile);
      if (owner === process.pid) fs.unlinkSync(this.lockFile);
    } catch (_) { /* absent or owned by another */ }
  }

  async start() {
    const lock = acquireLock(this.lockFile, process.pid);
    if (!lock.ok) {
      this.log(`[supervisor] BUSY live_pid=${lock.stalePid}`);
      return false;
    }
    this.acquired = true;
    this.log(`[supervisor] LOCK_ACQUIRED pid=${process.pid}`);
    if (lock.stalePid > 0) this.log(`[supervisor] STALE_LOCK_TAKEOVER dead_pid=${lock.stalePid}`);
    this.writeState('WAITING_FOR_KEY');
    this.log('[supervisor] WAITING_FOR_KEY');

    try {
      this.key = await this.readKey();
    } catch (error) {
      this.log(`[supervisor] KEY_INPUT_FAILED code=${error && error.code ? error.code : 'KEY_REQUIRED'}`);
      this.cleanupLock();
      return false;
    }
    this.log('[supervisor] KEY_READ ok=set');
    this.writeState('STARTING');
    this.startHeartbeat();
    this.spawnWorker();
    return true;
  }

  workerEnv() {
    const env = { ...process.env };
    // Never allow a key to be inherited by the worker through the environment.
    delete env.INGEST_KEY;
    delete env.BACKEND_INGEST_KEY;
    env.PUBLIC_SYNC_ENTRY = this.publicSyncEntry;
    return env;
  }

  spawnWorker() {
    if (this.stopping || this.child) return;
    this.writeState('STARTING');
    let child;
    try {
      child = fork(this.workerScript, [], {
        cwd: path.dirname(this.workerScript),
        env: this.workerEnv(),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: false
      });
    } catch (error) {
      const code = error && error.code ? error.code : 'FORK_FAILED';
      this.log(`[supervisor] WORKER_FORK_FAILED code=${code}`);
      this.lastWorkerExit = { code: null, signal: null, at: Date.now(), durationMs: 0, error: code };
      this.handleAbnormalExit();
      return;
    }
    this.child = child;
    const started = Date.now();
    this.lastWorkerStartedAt = started;
    this.log(`[supervisor] WORKER_START pid=${child.pid || 0}`);

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        process.stdout.write(data);
        this.appendWorkerChunk('stdout', data);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => {
        process.stderr.write(data);
        this.appendWorkerChunk('stderr', data);
      });
    }

    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      try { fn(); } catch (error) {
        this.log(`[supervisor] SETTLE_ERROR code=${error && error.code ? error.code : 'SETTLE_FAILED'}`);
      }
    };

    const onAbnormalSettlement = (exitInfo) => {
      this.lastWorkerExit = exitInfo;
      this.flushWorkerBuffers();
      if (this.stopping) {
        this.finishStop('STOPPED');
        return;
      }
      this.handleAbnormalExit();
    };

    child.on('message', (message) => {
      if (message && message.type === 'ready') {
        this.lastHealthyAt = Date.now();
        this.writeState('HEALTHY');
        this.log(`[supervisor] HEALTHY pid=${child.pid || 0}`);
      }
    });

    /*
     * A fork/spawn failure emits 'error' and may never emit 'exit'. Without this
     * branch the supervisor would keep a dead child reference forever and the
     * worker would never be restarted.
     */
    child.on('error', (error) => {
      const code = error && error.code ? error.code : 'SPAWN_ERROR';
      this.log(`[supervisor] WORKER_SPAWN_ERROR code=${code}`);
      settle(() => {
        if (this.child === child) this.child = null;
        onAbnormalSettlement({
          code: null,
          signal: null,
          at: Date.now(),
          durationMs: Date.now() - started,
          error: code
        });
      });
    });

    child.on('exit', (code, signal) => {
      const durationMs = Date.now() - started;
      settle(() => {
        if (this.child === child) this.child = null;
        if (this.stopping) {
          this.lastWorkerExit = { code, signal, at: Date.now(), durationMs };
          this.finishStop('STOPPED');
          return;
        }
        this.log(`[supervisor] WORKER_EXIT code=${code} signal=${signal} durationMs=${durationMs}`);
        if (code === 0 && !signal) {
          this.lastWorkerExit = { code, signal, at: Date.now(), durationMs };
          this.writeState('STOPPED');
          this.log('[supervisor] WORKER_EXITED_CLEANLY stopping=1');
          this.cleanup();
          return;
        }
        onAbnormalSettlement({ code, signal, at: Date.now(), durationMs });
      });
    });

    if (child.connected) {
      try {
        child.send({ type: 'ingest-key', value: this.key });
      } catch (error) {
        this.log(`[supervisor] KEY_DELIVERY_FAILED code=${error && error.code ? error.code : 'IPC_SEND_FAILED'}`);
        try { child.kill('SIGTERM'); } catch (_) { /* exit handler settles */ }
      }
    }
  }

  handleAbnormalExit() {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t <= this.circuitWindowMs);
    this.crashTimes.push(now);
    this.restartCount += 1;
    if (this.crashTimes.length >= this.maxCrashes) {
      /* 有界熔断：先把状态写成 CIRCUIT_OPEN（可观测），保持 circuitHoldMs 后
         清空窗口并重新拉起 worker。绝不永久停摆 —— 现场恢复后必须能自愈。 */
      this.writeState('CIRCUIT_OPEN', {
        circuitOpen: true,
        circuitOpenSince: now,
        circuitHoldMs: this.circuitHoldMs,
        crashesInWindow: this.crashTimes.length
      });
      this.log(`[supervisor] CIRCUIT_OPEN crashes=${this.crashTimes.length}/${this.circuitWindowMs}ms holdMs=${this.circuitHoldMs}`);
      if (this.circuitHold) clearTimeout(this.circuitHold);
      this.circuitHold = setTimeout(() => {
        this.circuitHold = null;
        if (this.stopping) return;
        this.crashTimes = [];
        this.writeState('RESTARTING', { circuitClosedAt: Date.now() });
        this.log('[supervisor] CIRCUIT_CLOSED_RETRY（熔断保持到期，重新拉起 worker）');
        this.spawnWorker();
      }, this.circuitHoldMs);
      return;
    }
    const index = Math.min(this.restartCount - 1, this.backoffMs.length - 1);
    const delay = Math.min(this.backoffMs[index], this.maxBackoffMs);
    this.lastScheduledDelayMs = delay;
    this.writeState('RESTARTING', { nextRestartMs: delay });
    this.log(`[supervisor] RESTART_IN ${delay}ms restartCount=${this.restartCount}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnWorker();
    }, delay);
  }

  finishStop(finalState) {
    this.writeState(finalState);
    this.log(`[supervisor] ${finalState}`);
    this.cleanup();
  }

  cleanup() {
    this.stopHeartbeat();
    this.flushWorkerBuffers();
    if (this.circuitHold) {
      clearTimeout(this.circuitHold);
      this.circuitHold = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch (_) { /* ignore */ }
      this.child = null;
    }
    this.cleanupLock();
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.circuitHold) {
      clearTimeout(this.circuitHold);
      this.circuitHold = null;
    }
    if (!this.child) {
      this.finishStop('STOPPED');
      return;
    }
    const child = this.child;
    await new Promise((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once('exit', settle);
      try { child.send({ type: 'shutdown' }); } catch (_) { /* ignore */ }
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
      setTimeout(() => {
        if (!done) {
          try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
          settle();
        }
      }, 3000);
    });
    if (this.child) this.child = null;
    this.finishStop('STOPPED');
  }
}

/* ---- 只读健康判定（2026-10-27）------------------------------------------
 * 只看状态文件里写了什么是不够的：2026-10-27 16:25 事故里 state.json 一直写着
 * HEALTHY、lock 文件也还在，但 supervisor 与 worker 都已退出。只看文件会让监视器
 * 永远误报健康、永远不拉起。这里同时校验 PID 存活与 heartbeat 新鲜度。
 * 返回值是纯数据，便于 PowerShell 监视器、验收脚本与单测共用同一套口径。
 */
function evaluateSupervisorHealth(input = {}) {
  const nowMs = Number.isSafeInteger(input.nowMs) ? input.nowMs : Date.now();
  const heartbeatMs = Number.isSafeInteger(input.heartbeatMs) && input.heartbeatMs > 0
    ? input.heartbeatMs : DEFAULT_HEARTBEAT_MS;
  const maxHeartbeatAgeMs = Number.isSafeInteger(input.maxHeartbeatAgeMs) && input.maxHeartbeatAgeMs > 0
    ? input.maxHeartbeatAgeMs
    : Math.max(heartbeatMs * 3, 90 * 1000);
  const aliveFn = typeof input.pidAlive === 'function' ? input.pidAlive : pidAlive;
  const state = input.state && typeof input.state === 'object' ? input.state : null;
  const lockPid = Number.isSafeInteger(input.lockPid) && input.lockPid > 0 ? input.lockPid : 0;
  const statePid = state && Number.isSafeInteger(state.supervisorPid) ? state.supervisorPid : 0;
  const supervisorPid = lockPid > 0 ? lockPid : statePid;
  const workerPid = state && Number.isSafeInteger(state.workerPid) ? state.workerPid : 0;
  let supervisorAlive = false;
  let workerAlive = false;
  try { supervisorAlive = supervisorPid > 0 ? Boolean(aliveFn(supervisorPid)) : false; } catch (_) { supervisorAlive = false; }
  try { workerAlive = workerPid > 0 ? Boolean(aliveFn(workerPid)) : false; } catch (_) { workerAlive = false; }
  const heartbeatAt = state && Number.isSafeInteger(state.heartbeatAt) ? state.heartbeatAt : 0;
  const heartbeatAgeMs = heartbeatAt > 0 ? Math.max(0, nowMs - heartbeatAt) : null;
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= maxHeartbeatAgeMs;
  const base = {
    supervisorPid,
    supervisorAlive,
    workerPid,
    workerAlive,
    heartbeatAgeMs,
    maxHeartbeatAgeMs,
    state: state && state.state ? String(state.state).slice(0, 40) : 'UNKNOWN',
    lockPid
  };
  if (!state && lockPid <= 0) return Object.assign(base, { healthy: false, reason: 'NO_SUPERVISOR' });
  if (!supervisorAlive) {
    return Object.assign(base, { healthy: false, reason: lockPid > 0 ? 'STALE_LOCK' : 'SUPERVISOR_DEAD' });
  }
  if (!state) return Object.assign(base, { healthy: false, reason: 'STATE_MISSING' });
  if (state.state === 'CIRCUIT_OPEN') return Object.assign(base, { healthy: false, reason: 'CIRCUIT_OPEN' });
  if (state.state !== 'HEALTHY') return Object.assign(base, { healthy: false, reason: 'STATE_NOT_HEALTHY' });
  if (!heartbeatFresh) return Object.assign(base, { healthy: false, reason: 'STALE_HEARTBEAT' });
  if (workerPid <= 0) return Object.assign(base, { healthy: false, reason: 'NO_WORKER' });
  if (!workerAlive) return Object.assign(base, { healthy: false, reason: 'WORKER_DEAD' });
  return Object.assign(base, { healthy: true, reason: 'HEALTHY' });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = value;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  /* 只读健康检查：不启动任何进程、不读密钥，供监视器/验收脚本使用。
     退出码 0=healthy，3=不健康（JSON 里有 reason）。 */
  if (args.check) {
    const stateFile = typeof args['state-file'] === 'string' ? args['state-file'] : DEFAULT_STATE_FILE;
    const lockFile = typeof args['lock-file'] === 'string' ? args['lock-file'] : DEFAULT_LOCK_FILE;
    let state = null;
    try {
      /* 容忍 UTF-8 BOM：Windows PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
         人工拷出来的状态快照也可能带 BOM；不能因此把健康判定退化成 UNKNOWN。 */
      const raw = fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '');
      state = JSON.parse(raw);
    } catch (_) { state = null; }
    const lockPid = readPidFile(lockFile);
    const heartbeatMs = args['heartbeat-ms'] === undefined ? DEFAULT_HEARTBEAT_MS : Number.parseInt(args['heartbeat-ms'], 10);
    const health = evaluateSupervisorHealth({ state, lockPid, heartbeatMs });
    process.stdout.write(JSON.stringify(health, null, 2) + '\n');
    process.exit(health.healthy ? 0 : 3);
  }
  const logFile = typeof args['log-file'] === 'string' ? args['log-file'] : DEFAULT_LOG_FILE;
  const supervisor = new PublicSyncSupervisor({
    publicSyncEntry: args['public-sync-entry'] || DEFAULT_PUBLIC_SYNC_ENTRY,
    workerScript: args['worker-script'] || DEFAULT_WORKER_SCRIPT,
    stateFile: args['state-file'] || DEFAULT_STATE_FILE,
    lockFile: args['lock-file'] || DEFAULT_LOCK_FILE,
    logFile
  });
  const started = await supervisor.start();
  if (!started) process.exit(2);
  const shutdown = async (signal) => {
    supervisor.log(`[supervisor] SIGNAL ${signal}`);
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGBREAK', () => { void shutdown('SIGBREAK'); });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[supervisor] FATAL code=${error && error.code ? error.code : 'START_FAILED'}`);
    process.exit(1);
  });
}

module.exports = Object.freeze({
  PublicSyncSupervisor,
  acquireLock,
  pidAlive,
  readPidFile,
  writeAtomic,
  evaluateSupervisorHealth,
  DEFAULT_BACKOFF_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_CIRCUIT_HOLD_MS
});
