#!/usr/bin/env node
/*
 * bench-server.js — isolated NEWLINE-JSON TCP bench server for ESP32 bench nodes.
 *
 * Task: LOCAL-ALARM-VOICE-CLOSURE (bench tooling).
 * Node.js core modules only.  No outbound connections, no MQTT, no production ports.
 *
 * Behaviour
 *   - Listens on --host/--port (default 127.0.0.1:9102).  Use --host 0.0.0.0 for boards.
 *   - Accepts newline-delimited JSON status lines from one or more nodes.
 *     Each parsed line is appended to the status JSONL with RECEIVE wall-clock.
 *   - Commands are sent to a specific deviceId by writing "<cmd>\n" to that node's TCP
 *     socket.  Command sources (no interpretation, exact line forwarded):
 *       1) stdin JSON lines:      {"send":"esp32-bath","cmd":"inj climate 35.0 80"}
 *       2) control file JSONL:    same shape, file polled every --poll-ms (default 200)
 *     Control actions: {"shutdown":true} or {"action":"shutdown"}; {"status":true}.
 *     Omit "send" or use "*" to broadcast.  Commands for offline devices are queued
 *     (default max 64) and delivered on reconnect.
 *   - Every send attempt / delivery / queue / error is appended to the command JSONL
 *     with timestamps, plus node connect/disconnect lifecycle events.
 *   - Client disconnect/reconnect never stops the server; same deviceId on a new
 *     connection replaces the old one.
 *   - Refuses to bind production ports 1883 / 9101 / 9001.  SIGINT/SIGTERM clean stop.
 *
 * Usage
 *   D:\Node\node.exe bench-server.js --host 0.0.0.0 --port 9102
 *   D:\Node\node.exe bench-server.js --host 127.0.0.1 --port 19102 --status-log ... --command-log ...
 *
 * Self-test: selftest-bench-server.js (runs this file on 19102).
 */
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const TOOLS_DIR = __dirname;
const EVIDENCE_DIR = path.resolve(TOOLS_DIR, '..');
const PROD_PORTS = new Set([1883, 9101, 9001]); // production services are LIVE: never bind

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const opts = {
    host: '127.0.0.1',
    port: 9102,
    statusLog: path.join(EVIDENCE_DIR, 'verify', 'bench-status.jsonl'),
    commandLog: path.join(EVIDENCE_DIR, 'verify', 'bench-commands.jsonl'),
    controlFile: path.join(TOOLS_DIR, 'bench-control.jsonl'),
    pollMs: 200,
    maxQueue: 64,
    stdin: true,
    control: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--host': opts.host = next(); break;
      case '--port': opts.port = Number(next()); break;
      case '--status-log': opts.statusLog = next(); break;
      case '--command-log': opts.commandLog = next(); break;
      case '--control-file': opts.controlFile = next(); break;
      case '--poll-ms': opts.pollMs = Number(next()); break;
      case '--max-queue': opts.maxQueue = Number(next()); break;
      case '--no-stdin': opts.stdin = false; break;
      case '--no-control': opts.control = false; break;
      case '--help':
      case '-h': printHelp(); process.exit(0); break;
      default: fail(`unknown argument: ${a}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) fail(`invalid --port: ${opts.port}`);
  if (!Number.isInteger(opts.pollMs) || opts.pollMs < 20) fail(`invalid --poll-ms: ${opts.pollMs}`);
  if (PROD_PORTS.has(opts.port)) {
    fail(`refusing to bind production port ${opts.port}; use the isolated bench port 9102 (self-test 19102)`);
  }
  opts.statusLog = path.resolve(opts.statusLog);
  opts.commandLog = path.resolve(opts.commandLog);
  opts.controlFile = path.resolve(opts.controlFile);
  return opts;
}

function printHelp() {
  console.log(`bench-server.js [options]
  --host <addr>        bind address (default 127.0.0.1; use 0.0.0.0 so boards can reach it)
  --port <n>           port, never 1883/9101/9001 (default 9102)
  --status-log <f>     default <evidence>/verify/bench-status.jsonl
  --command-log <f>    default <evidence>/verify/bench-commands.jsonl
  --control-file <f>   default <tools>/bench-control.jsonl
  --poll-ms <n>        control-file poll interval (default 200)
  --max-queue <n>      queued commands per offline device (default 64)
  --no-stdin           disable stdin JSON control
  --no-control         disable control-file watching
stdin / control-file JSON lines:
  {"send":"esp32-bath","cmd":"inj climate 35.0 80"}
  {"send":"esp32-bath","cmd":"ack <alarmId>"}
  {"status":true}          print connected devices
  {"shutdown":true}        graceful stop`);
}

function fail(msg) {
  console.error(`BENCH_ERROR ${msg}`);
  process.exit(2);
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(line) {
  console.log(`[${stamp()}] ${line}`);
}

// ---------------------------------------------------------------- persistence
function appendJsonl(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  } catch (e) {
    console.error(`BENCH_ERROR append ${file}: ${e.message}`);
  }
}

// deviceId -> { socket, remote, connectedTs }
const devices = new Map();
// deviceId -> [ {cmd, source, queuedTs} ... ] for offline devices
const queues = new Map();

function queueCommand(deviceId, cmd, source, reason) {
  const q = queues.get(deviceId) || [];
  q.push({ cmd, source, queuedTs: new Date().toISOString() });
  while (q.length > opts.maxQueue) q.shift();
  queues.set(deviceId, q);
  appendJsonl(opts.commandLog, {
    event: 'queued',
    ts: new Date().toISOString(),
    epochMs: Date.now(),
    deviceId,
    cmd,
    source,
    reason,
    queueDepth: q.length,
  });
  log(`queue ${deviceId} "${cmd}" (${reason}, depth=${q.length})`);
}

function flushQueue(deviceId, entry) {
  const q = queues.get(deviceId);
  if (!q || q.length === 0) return;
  queues.delete(deviceId);
  for (const item of q) deliver(deviceId, entry, item.cmd, item.source, true);
}

function sendCommand(target, cmd, source) {
  cmd = String(cmd).replace(/[\r\n]+/g, ' ').trim();
  if (!cmd) return;
  appendJsonl(opts.commandLog, {
    event: 'sent',
    ts: new Date().toISOString(),
    epochMs: Date.now(),
    deviceId: target,
    cmd,
    source,
  });
  log(`cmd> ${target} ${cmd} (${source})`);

  if (target === '*' || target === '') {
    if (devices.size === 0) log(`broadcast: no connected devices`);
    else for (const [id, entry] of devices) deliver(id, entry, cmd, source, false);
    return;
  }
  const entry = devices.get(target);
  if (!entry) {
    queueCommand(target, cmd, source, 'device-offline');
    return;
  }
  deliver(target, entry, cmd, source, false);
}

function deliver(deviceId, entry, cmd, source, wasQueued) {
  const socket = entry.socket;
  const payload = cmd + '\n';
  const done = (err) => {
    if (err) {
      appendJsonl(opts.commandLog, {
        event: 'error',
        ts: new Date().toISOString(),
        epochMs: Date.now(),
        deviceId,
        remote: entry.remote,
        cmd,
        source,
        error: String(err && err.message ? err.message : err),
      });
      log(`error ${deviceId} "${cmd}": ${err}`);
      if (!wasQueued) queueCommand(deviceId, cmd, source, 'send-failed');
      return;
    }
    appendJsonl(opts.commandLog, {
      event: 'delivered',
      ts: new Date().toISOString(),
      epochMs: Date.now(),
      deviceId,
      remote: entry.remote,
      cmd,
      source,
      queued: wasQueued,
      bytes: Buffer.byteLength(payload, 'utf8'),
    });
    log(`delivered ${deviceId} "${cmd}" (${Buffer.byteLength(payload, 'utf8')}b${wasQueued ? ', queued' : ''})`);
  };
  try {
    socket.write(payload, 'utf8', done);
  } catch (e) {
    done(e);
  }
}

// ---------------------------------------------------------------- status parsing
function handleStatusLine(socket, line) {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  const recvTs = new Date().toISOString();
  const recvMs = Date.now();
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.trim()) return;

  let obj = null;
  try {
    obj = JSON.parse(trimmed);
  } catch (_) {
    appendJsonl(opts.statusLog, { kind: 'unparsed', recvTs, recvMs, remote, raw: trimmed });
    log(`warn ${remote} unparsed line (${trimmed.length}b)`);
    return;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    appendJsonl(opts.statusLog, { kind: 'unparsed', recvTs, recvMs, remote, raw: trimmed });
    log(`warn ${remote} non-object JSON`);
    return;
  }

  const deviceId = obj.deviceId || obj.id || obj.device || '(unknown)';
  const state = obj.state || obj.status || '';
  const alarm = obj.alarm && typeof obj.alarm === 'object'
    ? { id: obj.alarm.id || '', type: obj.alarm.type || '', countToday: obj.alarm.countToday }
    : (obj.alarmId ? { id: obj.alarmId, type: obj.alarmType || '' } : null);
  const record = {
    kind: 'status',
    recvTs,
    recvMs,
    remote,
    deviceId,
    room: obj.room,
    state,
    nodeTs: obj.ts !== undefined ? obj.ts : null,
    alarm,
    sensors: obj.sensors,
    raw: trimmed,
  };
  appendJsonl(opts.statusLog, record);
  statusCount++;
  log(`recv ${deviceId} state=${state || '-'} ts=${record.nodeTs} alarm=${alarm && alarm.id ? alarm.id + '/' + alarm.type : '-'}`);

  if (socket.deviceId && socket.deviceId !== deviceId) {
    removeDevice(socket.deviceId, socket, 'renamed');
  }
  socket.deviceId = deviceId;
  const existing = devices.get(deviceId);
  if (existing && existing.socket !== socket) {
    appendJsonl(opts.commandLog, {
      event: 'node_replaced',
      ts: new Date().toISOString(),
      epochMs: Date.now(),
      deviceId,
      oldRemote: existing.remote,
      newRemote: remote,
    });
    log(`node ${deviceId} replaced connection ${existing.remote} -> ${remote}`);
    try { existing.socket.destroy(); } catch (_) { /* ignore */ }
  }
  if (!existing || existing.socket !== socket) {
    const entry = { socket, remote, connectedTs: recvTs };
    devices.set(deviceId, entry);
    appendJsonl(opts.commandLog, {
      event: 'node_connected',
      ts: recvTs,
      epochMs: recvMs,
      deviceId,
      remote,
    });
    log(`node+ ${deviceId} ${remote}`);
    flushQueue(deviceId, entry);
  }
}

const linesPerSocket = new WeakMap();

// ---------------------------------------------------------------- server
let opts = null;
let server = null;
let shuttingDown = false;
const sockets = new Set();

function removeDevice(deviceId, socket, reason) {
  const entry = devices.get(deviceId);
  if (entry && entry.socket === socket) {
    devices.delete(deviceId);
    appendJsonl(opts.commandLog, {
      event: 'node_disconnected',
      ts: new Date().toISOString(),
      epochMs: Date.now(),
      deviceId,
      remote: entry.remote,
      reason,
    });
    log(`node- ${deviceId} ${entry.remote} (${reason})`);
  }
}

function attachSocket(socket) {
  sockets.add(socket);
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  let buf = '';
  socket.setEncoding('utf8');
  socket.setKeepAlive(true, 5000);
  socket.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 1 << 20) {
      log(`warn ${remote} rx buffer overflow, reset`);
      buf = '';
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      linesPerSocket.set(socket, (linesPerSocket.get(socket) || 0) + 1);
      handleStatusLine(socket, line);
    }
  });
  socket.on('error', (e) => log(`warn ${remote} socket error: ${e.message}`));
  socket.on('close', () => {
    sockets.delete(socket);
    if (socket.deviceId) removeDevice(socket.deviceId, socket, 'socket-closed');
  });
}

function bindAddresses(host) {
  if (host === '0.0.0.0' || host === '::') {
    const addrs = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
      }
    }
    return addrs;
  }
  return [];
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  appendJsonl(opts.commandLog, {
    event: 'server_stop',
    ts: new Date().toISOString(),
    epochMs: Date.now(),
    statusLines: statusCount,
    commandsReceived: commandCount,
  });
  for (const s of sockets) { try { s.destroy(); } catch (_) { /* ignore */ } }
  sockets.clear();
  if (server) {
    server.close(() => {
      finalLog('BENCH_STOPPED', code || 0);
    });
    setTimeout(() => { process.exit(code || 0); }, 1000).unref();
  } else {
    finalLog('BENCH_STOPPED', code || 0);
  }
}

// Write the final console line and exit only after the pipe has flushed it.
function finalLog(msg, code) {
  process.stdout.write(`[${stamp()}] ${msg}\n`, () => process.exit(code));
}

let statusCount = 0;
let commandCount = 0;

function handleControlObject(obj, source) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.shutdown === true || obj.action === 'shutdown') {
    log(`control(${source}) shutdown requested`);
    shutdown(0);
    return;
  }
  if (obj.status === true || obj.action === 'status') {
    log(`control(${source}) connected=${devices.size} [${[...devices.keys()].join(', ')}] queues=${queues.size}`);
    return;
  }
  const target = obj.send !== undefined ? obj.send : (obj.deviceId || obj.target || obj.to);
  const cmd = obj.cmd !== undefined ? obj.cmd : (obj.command !== undefined ? obj.command : obj.line);
  if (cmd === undefined) {
    log(`warn control(${source}) ignored: no "cmd" in ${JSON.stringify(obj).slice(0, 120)}`);
    return;
  }
  if (target === undefined) {
    log(`warn control(${source}) ignored: no "send" (deviceId)`);
    return;
  }
  commandCount++;
  sendCommand(String(target), String(cmd), source);
}

// ---------------------------------------------------------------- stdin control
function setupStdin() {
  if (!opts.stdin) return;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      handleControlObject(JSON.parse(t), 'stdin');
    } catch (e) {
      log(`warn stdin non-JSON line ignored (${t.length}b)`);
    }
  });
  rl.on('close', () => { /* keep serving after piped stdin ends */ });
  process.stdin.on('error', () => { /* ignore */ });
}

// ---------------------------------------------------------------- control file
function setupControlFile() {
  if (!opts.control) return;
  if (!fs.existsSync(opts.controlFile)) {
    log(`control-file=${opts.controlFile} (absent; will watch once created)`);
  } else {
    log(`control-file=${opts.controlFile} (watch ${opts.pollMs}ms)`);
  }
  let offset = 0;
  let pending = '';
  setInterval(() => {
    let st;
    try { st = fs.statSync(opts.controlFile); } catch (_) { return; }
    if (st.size < offset) {
      offset = 0;
      pending = '';
      log('warn control-file shrank; rereading from 0');
    }
    if (st.size === offset) return;
    let fd;
    try {
      fd = fs.openSync(opts.controlFile, 'r');
      const len = st.size - offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      offset = st.size;
      pending += buf.toString('utf8');
    } catch (e) {
      log(`warn control-file read error: ${e.message}`);
      return;
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        handleControlObject(JSON.parse(line), 'control-file');
      } catch (e) {
        log(`warn control-file invalid JSON ignored (${line.length}b): ${e.message}`);
      }
    }
  }, opts.pollMs).unref();
}

// ---------------------------------------------------------------- main
function main() {
  opts = parseArgs(process.argv);
  fs.mkdirSync(path.dirname(opts.statusLog), { recursive: true });
  fs.mkdirSync(path.dirname(opts.commandLog), { recursive: true });
  // touch both evidence logs so they exist even before the first node/command arrives
  fs.appendFileSync(opts.statusLog, '', 'utf8');
  fs.appendFileSync(opts.commandLog, '', 'utf8');

  server = net.createServer(attachSocket);
  server.on('error', (e) => {
    console.error(`BENCH_ERROR listen ${opts.host}:${opts.port}: ${e.message}`);
    process.exit(1);
  });
  server.listen(opts.port, opts.host, () => {
    const addr = server.address();
    appendJsonl(opts.commandLog, {
      event: 'server_start',
      ts: new Date().toISOString(),
      epochMs: Date.now(),
      host: opts.host,
      port: opts.port,
      statusLog: opts.statusLog,
      controlFile: opts.control,
    });
    log(`BENCH_READY host=${addr.address} port=${addr.port} pid=${process.pid}`);
    log(`status-log=${opts.statusLog}`);
    log(`command-log=${opts.commandLog}`);
    if (addr.address === '0.0.0.0' || addr.address === '::') {
      log(`lan-addrs=${bindAddresses(addr.address).map((a) => `${a}:${addr.port}`).join(', ') || '(none detected)'}`);
    }
    setupStdin();
    setupControlFile();
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', (e) => {
    console.error(`BENCH_ERROR uncaught: ${e && e.stack ? e.stack : e}`);
    shutdown(1);
  });
}

main();
