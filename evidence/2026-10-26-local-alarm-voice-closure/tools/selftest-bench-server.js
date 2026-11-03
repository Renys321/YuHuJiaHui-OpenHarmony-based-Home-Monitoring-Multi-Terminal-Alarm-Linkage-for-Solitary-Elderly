#!/usr/bin/env node
/*
 * selftest-bench-server.js — end-to-end self-test for the LOCAL-ALARM-VOICE-CLOSURE
 * bench tooling.  Runs the real bench-server.js on the isolated port 19102, drives it
 * with a fake ESP32 node, asserts JSONL evidence + command delivery, then exercises the
 * serial-capture.ps1 and hash-evidence.ps1 CLIs.
 *
 * Writes a full transcript to tools/selftest-output.txt and prints it.
 * Exit 0 = every check PASS, exit 1 = at least one FAIL.
 *
 * Run: D:\Node\node.exe tools\selftest-bench-server.js
 */
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');

const TOOLS = __dirname;
const ROOT = path.resolve(TOOLS, '..');
const VERIFY = path.join(ROOT, 'verify');
const STATUS_LOG = path.join(VERIFY, 'bench-status.jsonl');
const CMD_LOG = path.join(VERIFY, 'bench-commands.jsonl');
const CONTROL_FILE = path.join(TOOLS, 'selftest-control.jsonl');
const OUT_FILE = path.join(TOOLS, 'selftest-output.txt');

const NODE = process.execPath;
const SERVER = path.join(TOOLS, 'bench-server.js');
const PORT = 19102;
const PWSh = process.env.PWSH_EXE || 'pwsh';
const PYTHON = process.env.BENCH_PYTHON || 'D:\\Espressif-5.1.6\\python_env\\idf5.1_py3.11_env\\Scripts\\python.exe';

const transcript = [];
const checks = [];
const children = [];

function nowIso() {
  return new Date().toISOString();
}
function line(msg) {
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  transcript.push(text);
  console.log(text);
}
function check(name, ok, detail) {
  const result = { name, ok: !!ok, detail: detail === undefined ? '' : String(detail) };
  checks.push(result);
  line(`${ok ? 'CHECK PASS' : 'CHECK FAIL'} ${name}${result.detail ? ' :: ' + result.detail : ''}`);
  return !!ok;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------- process helpers
function startServer(args) {
  const child = spawn(NODE, [SERVER, '--port', String(PORT)].concat(args), {
    cwd: TOOLS,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  child.stdin.on('error', () => { /* ignore EPIPE after shutdown */ });
  child.lines = [];
  child.errLines = [];
  const rl = require('readline').createInterface({ input: child.stdout });
  rl.on('line', (l) => {
    child.lines.push(l);
    line(`  srv| ${l}`);
  });
  const rle = require('readline').createInterface({ input: child.stderr });
  rle.on('line', (l) => {
    child.errLines.push(l);
    line(`  srv! ${l}`);
  });
  child.exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  return child;
}
function serverLine(child, re, timeoutMs = 8000) {
  return waitFor(() => child.lines.find((l) => re.test(l)), `server line ${re}`, timeoutMs);
}
function waitFor(fn, what, timeoutMs = 8000, interval = 50) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { v = undefined; }
      if (v !== undefined && v !== null && v !== false) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout ${timeoutMs}ms waiting for ${what}`));
      setTimeout(tick, interval);
    };
    tick();
  });
}

class LineClient {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
    this.lines = [];
    this.waiters = [];
    this.errors = [];
    socket.setEncoding('utf8');
    socket.on('data', (d) => this._onData(d));
    socket.on('error', (e) => this.errors.push(e));
  }
  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const l = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(l);
      this._pump();
    }
  }
  _pump() {
    while (this.waiters.length && this.lines.length) {
      const w = this.waiters.shift();
      clearTimeout(w.timer);
      w.resolve(this.lines.shift());
    }
  }
  nextLine(timeoutMs = 6000) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('timeout waiting for a line from bench server'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
  sendLine(text) {
    this.socket.write(text + '\n', 'utf8');
  }
  end() {
    try { this.socket.destroy(); } catch (_) { /* ignore */ }
  }
}

function connectClient(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout connecting to ${host}:${port}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(new LineClient(socket));
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`connect ${host}:${port} failed: ${e.message}`));
    });
  });
}

function readJsonl(file) {
  const out = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const [i, l] of text.split('\n').entries()) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch (e) {
      throw new Error(`${file}:${i + 1} invalid JSON: ${e.message}`);
    }
  }
  return out;
}

function statusLine(deviceId, state, alarmId, alarmType, ts) {
  return JSON.stringify({
    deviceId,
    room: 'selftest-bench',
    ts: ts !== undefined ? ts : 1770000000000,
    state,
    sensors: {
      motion: { lastActiveTs: 0, countToday: 0 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 22.5, rh: 55.0, ok: true, valid: true },
      gas: { raw: 100, ok: true, valid: true },
      smoke: { raw: 80, ok: true, valid: true },
    },
    history: [0, 0, 0, 0, 0, 0, 0],
    slots: [0, 0, 0, 0],
    alarm: { id: alarmId || '', type: alarmType || '', countToday: alarmId ? 1 : 0 },
  });
}

function runCli(cmd, args, timeoutMs = 60000) {
  const r = spawnSync(cmd, args, { cwd: TOOLS, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error };
}

async function runPwsh(args, timeoutMs = 60000) {
  // Windows PowerShell 5.1 default policy here is RemoteSigned -> .ps1 files need -ExecutionPolicy Bypass
  const baseArgs = ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File'];
  let r = runCli(PWSh, baseArgs.concat(args), timeoutMs);
  if (r.error && r.error.code === 'ENOENT') {
    line(`WARN "pwsh" not found; falling back to "powershell" (5.1)`);
    r = runCli('powershell', baseArgs.concat(args), timeoutMs);
  }
  return r;
}

// ---------------------------------------------------------------- phase 1
async function phase1() {
  line('');
  line('=== PHASE 1: bench-server.js on 127.0.0.1:19102 + fake ESP32 node ===');
  for (const p of [STATUS_LOG, CMD_LOG, CONTROL_FILE]) unlinkQuiet(p);
  fs.writeFileSync(CONTROL_FILE, '', 'utf8');

  const server = startServer([
    '--host', '127.0.0.1',
    '--status-log', STATUS_LOG,
    '--command-log', CMD_LOG,
    '--control-file', CONTROL_FILE,
    '--poll-ms', '200',
  ]);
  const ready = await serverLine(server, /BENCH_READY/);
  check('P1.ready-line', /host=127\.0\.0\.1 port=19102/.test(ready), ready);
  check('P1.status-log-created', fs.existsSync(STATUS_LOG), STATUS_LOG);
  check('P1.command-log-created', fs.existsSync(CMD_LOG), CMD_LOG);

  const c1 = await connectClient('127.0.0.1', PORT);
  c1.sendLine(statusLine('esp32-selftest', 'NORMAL'));
  const recv1 = await serverLine(server, /recv esp32-selftest state=NORMAL/);
  check('P1.status-received', !!recv1, recv1);

  const st1 = await waitFor(() => {
    const rows = readJsonl(STATUS_LOG);
    return rows.find((r) => r.deviceId === 'esp32-selftest');
  }, 'status JSONL record');
  check('P1.status-jsonl-parsed', st1.kind === 'status' && st1.state === 'NORMAL' && st1.room === 'selftest-bench',
    `kind=${st1.kind} state=${st1.state} room=${st1.room}`);
  check('P1.status-jsonl-receive-wallclock', typeof st1.recvTs === 'string' && !Number.isNaN(Date.parse(st1.recvTs)) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(st1.recvTs), st1.recvTs);
  check('P1.status-jsonl-raw-kept', typeof st1.raw === 'string' && st1.raw.includes('esp32-selftest'), `${String(st1.raw).length}b`);

  // control-file command injection
  const t0 = Date.now();
  fs.appendFileSync(CONTROL_FILE, JSON.stringify({ send: 'esp32-selftest', cmd: 'inj climate 35.0 80' }) + '\n', 'utf8');
  const cmd1 = await c1.nextLine();
  check('P1.control-file-delivered', cmd1 === 'inj climate 35.0 80', JSON.stringify(cmd1));
  check('P1.control-file-latency-under-3s', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);

  // stdin command injection
  server.stdin.write(JSON.stringify({ send: 'esp32-selftest', cmd: 'ack alarm-selftest-1' }) + '\n');
  const cmd2 = await c1.nextLine();
  check('P1.stdin-delivered', cmd2 === 'ack alarm-selftest-1', JSON.stringify(cmd2));

  // second status (ALARM)
  c1.sendLine(statusLine('esp32-selftest', 'ALARM', 'alarm-selftest-1', 'CLIMATE', 1770000005000));
  await serverLine(server, /recv esp32-selftest state=ALARM/);
  const alarmRow = await waitFor(() => readJsonl(STATUS_LOG).find((r) => r.state === 'ALARM'), 'ALARM status record');
  check('P1.alarm-fields-parsed', alarmRow.alarm && alarmRow.alarm.id === 'alarm-selftest-1' && alarmRow.alarm.type === 'CLIMATE',
    JSON.stringify(alarmRow.alarm));

  // garbage line must not kill the server
  c1.sendLine('this is not json');
  const bad = await waitFor(() => readJsonl(STATUS_LOG).find((r) => r.kind === 'unparsed'), 'unparsed record');
  check('P1.non-json-line-quarantined', !!bad && typeof bad.raw === 'string', bad.raw);
  c1.sendLine(statusLine('esp32-selftest', 'ALARM', 'alarm-selftest-1', 'CLIMATE'));
  await waitFor(() => readJsonl(STATUS_LOG).filter((r) => r.kind === 'status').length >= 3, '3 status records');

  // offline queue + reconnect
  c1.end();
  await waitFor(() => readJsonl(CMD_LOG).find((e) => e.event === 'node_disconnected' && e.deviceId === 'esp32-selftest'),
    'node_disconnected event');
  server.stdin.write(JSON.stringify({ send: 'esp32-selftest', cmd: 'reset' }) + '\n');
  await waitFor(() => readJsonl(CMD_LOG).find((e) => e.event === 'queued' && e.cmd === 'reset'), 'queued command event');
  check('P1.offline-command-queued', true, 'reset queued while node offline');

  const c2 = await connectClient('127.0.0.1', PORT);
  c2.sendLine(statusLine('esp32-selftest', 'ACKED', 'alarm-selftest-1', 'CLIMATE', 1770000010000));
  const queuedCmd = await c2.nextLine();
  check('P1.queued-command-delivered-on-reconnect', queuedCmd === 'reset', JSON.stringify(queuedCmd));
  const queuedDelivered = await waitFor(() => readJsonl(CMD_LOG).find((e) => e.event === 'delivered' && e.cmd === 'reset'),
    'queued delivery event');
  check('P1.queued-delivery-logged', queuedDelivered.queued === true, JSON.stringify({ queued: queuedDelivered.queued }));

  fs.appendFileSync(CONTROL_FILE, JSON.stringify({ send: 'esp32-selftest', cmd: 'stop' }) + '\n', 'utf8');
  const stopCmd = await c2.nextLine();
  check('P1.reconnect-delivery', stopCmd === 'stop', JSON.stringify(stopCmd));

  // exact command set forwarded untouched (delivery log row is written from the socket
  // write callback, so poll briefly instead of racing the client's read)
  const delivered = await waitFor(() => {
    const rows = readJsonl(CMD_LOG).filter((e) => e.event === 'delivered');
    return rows.length >= 4 ? rows : undefined;
  }, '4 delivered command-log rows', 6000);
  const deliveredCmds = delivered.map((e) => e.cmd);
  check('P1.four-commands-delivered', deliveredCmds.length === 4, JSON.stringify(deliveredCmds));
  check('P1.commands-exact-lines', ['inj climate 35.0 80', 'ack alarm-selftest-1', 'reset', 'stop'].every((c) => deliveredCmds.includes(c)),
    JSON.stringify(deliveredCmds));
  const sources = new Set(delivered.map((e) => e.source));
  check('P1.both-control-sources', sources.has('control-file') && sources.has('stdin'), [...sources].join(','));

  // graceful shutdown
  server.stdin.write(JSON.stringify({ shutdown: true }) + '\n');
  const exit = await server.exited;
  check('P1.graceful-shutdown-exit0', exit.code === 0, JSON.stringify(exit));
  check('P1.bench-stopped-line', server.lines.some((l) => l.includes('BENCH_STOPPED')), 'BENCH_STOPPED');
  const cmdRows = readJsonl(CMD_LOG);
  check('P1.command-log-events', cmdRows.some((e) => e.event === 'server_start') &&
    cmdRows.filter((e) => e.event === 'sent').length >= 4 && cmdRows.some((e) => e.event === 'server_stop'),
    `rows=${cmdRows.length}`);
  check('P1.all-status-records-valid-json', readJsonl(STATUS_LOG).length >= 4, `rows=${readJsonl(STATUS_LOG).length}`);
  check('P1.narrow-bind-not-0.0.0.0', !/host=0\.0\.0\.0/.test(ready), ready);
  return server;
}

// ---------------------------------------------------------------- phase 2
async function phase2() {
  line('');
  line('=== PHASE 2: --host 0.0.0.0 bench bind, board-reachable address ===');
  const server = startServer(['--host', '0.0.0.0', '--status-log', STATUS_LOG, '--command-log', CMD_LOG, '--no-control']);
  const ready = await serverLine(server, /BENCH_READY/);
  check('P2.binds-0.0.0.0', /host=0\.0\.0\.0 port=19102/.test(ready), ready);
  await serverLine(server, /lan-addrs=/, 3000);
  const lanMatch = /lan-addrs=([^\s]+)/.exec(server.lines.join('\n'));
  check('P2.lan-addr-logged', !!lanMatch && /:19102/.test(lanMatch[1]), lanMatch ? lanMatch[1] : '(none)');

  let host = '127.0.0.1';
  let targetNote = 'loopback fallback';
  const ifaces = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal);
  if (ifaces.length) { host = ifaces[0].address; targetNote = 'LAN IP'; }
  let c = null;
  try {
    c = await connectClient(host, PORT, 4000);
  } catch (e) {
    line(`WARN connect via ${host} failed (${e.message}); retrying loopback`);
    host = '127.0.0.1';
    targetNote = 'loopback after LAN failure';
    c = await connectClient(host, PORT, 4000);
  }
  check('P2.connection-accepted', !!c, `${targetNote} ${host}:${PORT}`);
  c.sendLine(statusLine('esp32-selftest', 'NORMAL'));
  const recv = await serverLine(server, /recv esp32-selftest state=NORMAL/, 6000);
  check('P2.status-through-lan-bind', !!recv, host);

  // prove the OS actually lists a 0.0.0.0 listener (spawnSync netstat; server stays up)
  const netstat = runCli('netstat', ['-ano'], 15000);
  const listenLine = (netstat.out || '').split(/\r?\n/).find((l) => /:19102\b/.test(l) && /LISTEN/i.test(l));
  check('P2.os-listener-0.0.0.0', !!listenLine && /0\.0\.0\.0:19102/.test(listenLine), listenLine ? listenLine.trim() : 'no netstat line');

  server.stdin.write(JSON.stringify({ shutdown: true }) + '\n');
  const exit = await server.exited;
  check('P2.graceful-shutdown-exit0', exit.code === 0, JSON.stringify(exit));
  c.end();
  return server;
}

// ---------------------------------------------------------------- phase 3
async function phase3() {
  line('');
  line('=== PHASE 3: serial-capture.ps1 (list ports / clean failure; no DTR-RTS toggle) ===');
  const list = await runPwsh([path.join(TOOLS, 'serial-capture.ps1'), '-ListPorts'], 60000);
  check('P3.ps1-parses-and-listports-exit0', list.code === 0, `code=${list.code}`);
  check('P3.listports-output', /SERIAL_CAPTURE list-ports/.test(list.out) && /OK \(no port opened/.test(list.out),
    firstLine(list.out));
  check('P3.listports-no-port-opened', !/SERIAL_CAPTURE start/.test(list.out), 'no capture started');

  const bad = await runPwsh([path.join(TOOLS, 'serial-capture.ps1'), '-Com', 'COM99', '-Seconds', '1'], 60000);
  check('P3.invalid-port-clean-exit2', bad.code === 2, `code=${bad.code} err=${firstLine(bad.err || bad.out)}`);

  const pyList = runCli('D:\\Espressif-5.1.6\\python_env\\idf5.1_py3.11_env\\Scripts\\python.exe',
    [path.join(TOOLS, 'serial-capture.py'), '--list'], 30000);
  check('P3.pyserial-variant-importable', pyList.code === 0 && /pyserial/.test(pyList.out),
    firstLine(pyList.out) || firstLine(pyList.err) || `code=${pyList.code}`);
  return list;
}

function firstLine(s) {
  if (!s) return '';
  return String(s).split(/\r?\n/).filter((x) => x.trim()).slice(0, 2).join(' | ').slice(0, 200);
}

// ---------------------------------------------------------------- phase 4
async function phase4() {
  line('');
  line('=== PHASE 4: hash-evidence.ps1 (format, ordinal sort, recompute, verify) ===');
  // Private sandbox, not the whole evidence dir: other bench/build jobs are writing there
  // concurrently right now, and this phase must be deterministic.
  const sandbox = path.join(TOOLS, '.selftest-hash-sandbox');
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(sandbox, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'alpha.txt'), 'alpha\n', 'utf8');
  fs.writeFileSync(path.join(sandbox, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.16)\n', 'utf8');
  fs.writeFileSync(path.join(sandbox, 'b.bin'), Buffer.from([0x00, 0xff, 0x01, 0x02]));
  fs.writeFileSync(path.join(sandbox, 'nested', 'c.txt'), '中文 content 中文\n', 'utf8');
  const tmp = path.join(sandbox, 'SHA256SUMS.txt');
  const run = await runPwsh([path.join(TOOLS, 'hash-evidence.ps1'), '-Root', sandbox, '-OutFile', tmp], 120000);
  check('P4.hash-script-exit0', run.code === 0, `code=${run.code} ${firstLine(run.out)}`);
  check('P4.sums-file-created', fs.existsSync(tmp), tmp);
  const text = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
  const lines = text.split('\n').filter((l) => l.length);
  check('P4.sums-format', lines.length === 4 && lines.every((l) => /^[0-9a-f]{64}  \S.*$/.test(l)),
    `${lines.length} lines, first=${lines[0] || '-'}`);
  const rels = lines.map((l) => l.slice(66));
  check('P4.sums-ordinal-sorted', JSON.stringify(rels) === JSON.stringify([...rels].sort()),
    JSON.stringify(rels));
  check('P4.sums-no-bom-no-crlf', !text.startsWith('\ufeff') && !text.includes('\r'), 'utf8 without BOM, LF endings');
  const crypto = require('crypto');
  let hashOk = true;
  for (const l of lines) {
    const want = l.slice(0, 64);
    const rel = l.slice(66);
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(sandbox, rel))).digest('hex');
    if (got !== want) { hashOk = false; line(`  hash mismatch ${rel}: got=${got} want=${want}`); }
  }
  check('P4.sums-hashes-recomputed-match', hashOk, `${lines.length} files`);
  const verify = await runPwsh([path.join(TOOLS, 'hash-evidence.ps1'), '-Verify', '-Root', sandbox, '-OutFile', tmp], 120000);
  check('P4.verify-mode-exit0', verify.code === 0 && /HASH_VERIFY OK/.test(verify.out), firstLine(verify.out));
  fs.rmSync(sandbox, { recursive: true, force: true });
  return run;
}

// ---------------------------------------------------------------- phase 5
async function phase5() {
  line('');
  line('=== PHASE 5: bench-serial.py (serial harness, offline paths) ===');
  const script = path.join(TOOLS, 'bench-serial.py');
  const list = runCli(PYTHON, [script, '--list-ports'], 60000);
  line('  py| ' + firstLine(list.out || list.err));
  check('P5.list-ports-exit0', list.code === 0 && /BENCH_SERIAL list-ports OK/.test(list.out), `code=${list.code}`);

  const st = runCli(PYTHON, [script, '--selftest'], 180000);
  for (const l of (st.out || '').split(/\r?\n/)) if (l.trim()) line('  py| ' + l);
  const passChecks = (st.out || '').split(/\r?\n/).filter((l) => /^CHECK PASS /.test(l.trim())).length;
  check('P5.selftest-exit0', st.code === 0, `code=${st.code}`);
  check('P5.selftest-all-checks-pass', /BENCH_SERIAL SELFTEST PASS/.test(st.out) && passChecks >= 20,
    `checks=${passChecks}`);

  const bad = runCli(PYTHON, [script, '--com', 'COM99', '--seconds', '1'], 60000);
  check('P5.bad-com-clean-error-exit2', bad.code === 2 && /ERROR: failed to open COM99/.test(bad.err || bad.out),
    `code=${bad.code} ${firstLine(bad.err || bad.out)}`);

  const plan = runCli(PYTHON, [script, '--scenario', path.join(TOOLS, 'bench-scenario.example.json'), '--print-plan'], 60000);
  line('  py| ' + firstLine(plan.out || plan.err));
  const planSteps = (plan.out || '').split(/\r?\n/).filter((l) => /atSec=/.test(l)).length;
  check('P5.example-scenario-plan-valid', plan.code === 0 && /BENCH_SERIAL plan OK/.test(plan.out) && planSteps === 8,
    `code=${plan.code} steps=${planSteps}`);
  return st;
}

// ---------------------------------------------------------------- main
(async () => {
  const started = Date.now();
  line('SELFTEST LOCAL-ALARM-VOICE-CLOSURE bench tooling');
  line(`node=${NODE} version=${process.version}`);
  line(`workspace=${ROOT}`);
  line(`port=${PORT} evidence-status=${STATUS_LOG}`);
  line(`started=${nowIso()}`);
  line('command=' + [NODE, path.join(TOOLS, 'selftest-bench-server.js')].join(' '));

  try { await phase1(); } catch (e) { check('P1.phase-completed', false, e.message); }
  try { await phase2(); } catch (e) { check('P2.phase-completed', false, e.message); }
  try { await phase3(); } catch (e) { check('P3.phase-completed', false, e.message); }
  try { await phase4(); } catch (e) { check('P4.phase-completed', false, e.message); }
  try { await phase5(); } catch (e) { check('P5.phase-completed', false, e.message); }

  // ensure no stray bench children
  for (const c of children) {
    if (c.exitCode === null) {
      try { c.kill(); } catch (_) { /* ignore */ }
    }
  }
  unlinkQuiet(CONTROL_FILE);

  const failed = checks.filter((c) => !c.ok);
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
  line('');
  line(`SELFTEST SUMMARY ${verdict}: ${checks.length - failed.length}/${checks.length} checks passed, ${failed.length} failed, elapsed=${((Date.now() - started) / 1000).toFixed(2)}s`);
  if (failed.length) {
    for (const f of failed) line(`  FAILED ${f.name} :: ${f.detail}`);
  }
  line(`finished=${nowIso()}`);
  line(`transcript=${OUT_FILE}`);
  fs.writeFileSync(OUT_FILE, transcript.join('\n') + '\n', 'utf8');
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SELFTEST CRASH', e && e.stack ? e.stack : e);
  try { fs.writeFileSync(OUT_FILE, transcript.join('\n') + `\nSELFTEST CRASH ${e && e.message}\n`, 'utf8'); } catch (_) { /* ignore */ }
  process.exit(1);
});
