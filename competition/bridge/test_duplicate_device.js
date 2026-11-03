#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'elder-bridge-dedup-'));
const STATUS_FILE = path.join(TMP, 'status.json');
const children = [];
const results = [];
let brokerLog = '';
let bridgeLog = '';

function assert(name, ok, info = '') {
  results.push({ name, ok: Boolean(ok), info });
  if (!ok) throw new Error(`${name}${info ? `: ${info}` : ''}`);
}

function waitFor(test, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = test();
        if (value) return resolve(value);
      } catch (e) {
        return reject(e);
      }
      if (Date.now() >= deadline) return reject(new Error(`等待超时: ${label}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function spawnNode(script, args, onOutput) {
  const child = childProcess.spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  children.push(child);
  child.stdout.on('data', (d) => onOutput(d.toString('utf8')));
  child.stderr.on('data', (d) => onOutput(d.toString('utf8')));
  return child;
}

function connectNode(port) {
  return new Promise((resolve, reject) => {
    const node = { socket: null, received: '', closed: false };
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => resolve(node));
    node.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (d) => { node.received += d; });
    socket.on('close', () => { node.closed = true; });
    socket.once('error', reject);
  });
}

function status(deviceId, room) {
  const now = Date.now();
  return JSON.stringify({
    deviceId,
    room,
    ts: now,
    state: 'NORMAL',
    sensors: {
      motion: { lastActiveTs: now - 1000, countToday: 0 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 0, rh: 0, ok: true },
      gas: { raw: 0, ok: true },
      smoke: { raw: 0, ok: true }
    },
    history: [0, 0, 0, 0, 0, 0, 0],
    slots: [0, 0, 0, 0],
    alarm: { id: '', type: '', countToday: 0 }
  }) + '\n';
}

function currentStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); }
  catch (e) { return null; }
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  const statusServer = net.createServer();
  const statusPort = await listen(statusServer);
  let statusSocket = null;
  statusServer.on('connection', (socket) => {
    statusSocket = socket;
    socket.setEncoding('utf8');
  });
  const relayServer = net.createServer();
  const relayPort = await listen(relayServer);
  const brokerPort = await reservePort();
  const bridgePort = await reservePort();
  let relaySocket = null;
  let relayData = '';
  relayServer.on('connection', (socket) => {
    relaySocket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (d) => { relayData += d; });
  });

  spawnNode(path.join(ROOT, 'mqtt_broker.js'), [String(brokerPort)], (s) => { brokerLog += s; });
  await waitFor(() => brokerLog.includes(`0.0.0.0:${brokerPort}`), 'Broker 启动');
  spawnNode(path.join(ROOT, 'mqtt_bridge.js'), [
    '--broker', `127.0.0.1:${brokerPort}`,
    '--status-tcp', `127.0.0.1:${statusPort}`,
    '--listen', String(bridgePort),
    '--relay-to', `127.0.0.1:${relayPort}`,
    '--status-file', STATUS_FILE,
    '--cmd-out', path.join(TMP, 'control')
  ], (s) => { bridgeLog += s; });
  await waitFor(() => statusSocket && relaySocket && bridgeLog.includes(`监听端口  : ${bridgePort}`), 'Bridge 启动');

  statusSocket.write(status('dayu200-living', '客厅'));
  await waitFor(() => currentStatus()?.deviceId === 'dayu200-living', '板端状态进入 Bridge');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert('status-tcp 状态进入状态文件', currentStatus()?.room === '客厅', currentStatus()?.room || '(none)');
  assert('status-tcp 状态不回灌 relay', !relayData.includes('dayu200-living'), relayData);

  const first = await connectNode(bridgePort);
  first.socket.write(status('esp32-bath', '旧连接'));
  await waitFor(() => currentStatus()?.room === '旧连接', '旧连接首报');
  await waitFor(() => relayData.includes('esp32-bath'), '无线节点状态转发 relay');
  assert('listen 无线节点状态仍转发 relay', relayData.includes('relay {'));
  relaySocket.write('route esp32-bath motion\n');
  await waitFor(() => first.received.includes('motion\n'), '旧连接收到首次命令');
  assert('首个同 ID 节点可接收定向命令', true);

  const second = await connectNode(bridgePort);
  second.socket.write(status('esp32-bath', '新连接'));
  await waitFor(() => currentStatus()?.room === '新连接', '新连接接管状态');
  await waitFor(() => first.closed, '旧连接被关闭');
  const firstBytes = first.received.length;
  relaySocket.write('route esp32-bath gas\n');
  await waitFor(() => second.received.includes('gas\n'), '新连接收到命令');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert('同 ID 新连接关闭旧连接', first.closed, `first.closed=${first.closed}`);
  assert('替换后的命令只发往新连接', first.received.length === firstBytes,
    `old=${first.received.length}, expected=${firstBytes}`);
  assert('旧连接关闭不会清除新映射', second.received.includes('gas\n'));
  assert('状态文件保持新连接状态', currentStatus()?.room === '新连接', currentStatus()?.room || '(none)');

  const beforeFall = second.received.length;
  childProcess.execFileSync(process.execPath, [
    path.join(ROOT, 'mqtt_tool.js'), 'pub',
    '--broker', `127.0.0.1:${brokerPort}`,
    '--topic', 'home/esp32-bath/cmd',
    '--msg', JSON.stringify({ cmd: 'fall', score: 0.8, source: 'test' })
  ], { cwd: ROOT, windowsHide: true });
  await waitFor(() => second.received.slice(beforeFall).includes('fall\n'), 'MQTT FALL 命令');
  const fallChunk = second.received.slice(beforeFall);
  assert('MQTT FALL 映射为目标节点 fall 命令', fallChunk === 'fall\n', JSON.stringify(fallChunk));

  const beforeEvidenceFall = second.received.length;
  childProcess.execFileSync(process.execPath, [
    path.join(ROOT, 'mqtt_tool.js'), 'pub',
    '--broker', `127.0.0.1:${brokerPort}`,
    '--topic', 'home/esp32-bath/cmd',
    '--msg', JSON.stringify({ cmd: 'fall', evidenceId: 'fall-1791609077775-7', source: 'test' })
  ], { cwd: ROOT, windowsHide: true });
  await waitFor(() => second.received.slice(beforeEvidenceFall).includes('fall-1791609077775-7'),
    'MQTT FALL 证据关联命令');
  assert('合法 evidenceId 原样进入受限节点命令',
    second.received.slice(beforeEvidenceFall) === 'fall fall-1791609077775-7\n',
    JSON.stringify(second.received.slice(beforeEvidenceFall)));

  const beforeBadEvidence = second.received.length;
  childProcess.execFileSync(process.execPath, [
    path.join(ROOT, 'mqtt_tool.js'), 'pub',
    '--broker', `127.0.0.1:${brokerPort}`,
    '--topic', 'home/esp32-bath/cmd',
    '--msg', JSON.stringify({ cmd: 'fall', evidenceId: '../../reset', source: 'test' })
  ], { cwd: ROOT, windowsHide: true });
  await waitFor(() => bridgeLog.includes('evidenceId 非法'), '非法 FALL evidenceId 被拒绝');
  assert('非法 evidenceId 不下发任何节点命令', second.received.length === beforeBadEvidence,
    JSON.stringify(second.received.slice(beforeBadEvidence)));

  const beforeMonitor = second.received.length;
  childProcess.execFileSync(process.execPath, [
    path.join(ROOT, 'mqtt_tool.js'), 'pub',
    '--broker', `127.0.0.1:${brokerPort}`,
    '--topic', 'home/esp32-bath/cmd',
    '--msg', JSON.stringify({ cmd: 'monitor', state: 'offline', reason: 'no_frame' })
  ], { cwd: ROOT, windowsHide: true });
  await waitFor(() => second.received.slice(beforeMonitor).includes('monitor offline no_frame\n'), 'MQTT monitor 命令');
  const monitorChunk = second.received.slice(beforeMonitor);
  assert('MQTT monitor 映射为失联命令', monitorChunk === 'monitor offline no_frame\n', JSON.stringify(monitorChunk));

  const beforeBadMonitor = second.received.length;
  childProcess.execFileSync(process.execPath, [
    path.join(ROOT, 'mqtt_tool.js'), 'pub',
    '--broker', `127.0.0.1:${brokerPort}`,
    '--topic', 'home/esp32-bath/cmd',
    '--msg', JSON.stringify({ cmd: 'monitor', state: 'bogus', reason: 'no_frame' })
  ], { cwd: ROOT, windowsHide: true });
  await waitFor(() => bridgeLog.includes('拒绝 monitor 命令'), '非法 monitor 状态被拒绝');
  assert('非法 monitor 状态不下发到节点', second.received.length === beforeBadMonitor,
    JSON.stringify(second.received.slice(beforeBadMonitor)));

  const other = await connectNode(bridgePort);
  other.socket.write(status('bedroom-node', '卧室'));
  await waitFor(() => currentStatus()?.deviceId === 'bedroom-node', '第二设备首报');
  relaySocket.write('route esp32-bath smoke\n');
  relaySocket.write('route bedroom-node motion\n');
  await waitFor(() => second.received.includes('smoke\n'), '主节点收到独立命令');
  await waitFor(() => other.received.includes('motion\n'), '第二设备收到独立命令');
  assert('不同 deviceId 仍能独立路由', true);

  other.socket.write(status('renamed-node', '卧室'));
  await waitFor(() => other.closed, '同 socket 改名被关闭');
  assert('同一连接不可中途更换 deviceId', bridgeLog.includes('拒绝节点改名：bedroom-node -> renamed-node'));

  const illegal = await connectNode(bridgePort);
  illegal.socket.write(status('bad/id', '非法'));
  await waitFor(() => illegal.closed, '非法 ID 被关闭');
  assert('非法 deviceId 被拒绝', bridgeLog.includes('拒绝节点身份：非法 deviceId'));
  assert('非法 deviceId 不覆盖状态文件', currentStatus()?.deviceId === 'bedroom-node',
    currentStatus()?.deviceId || '(none)');

  second.socket.end();
  await waitFor(() => second.closed, '活动连接关闭');
  const beforeReject = bridgeLog.length;
  relaySocket.write('route esp32-bath reset\n');
  await waitFor(() => bridgeLog.slice(beforeReject).includes('拒绝路由：设备 esp32-bath 不在线或未知'),
    '离线设备命令被拒绝');
  assert('活动连接关闭后不向旧连接回退', true);

  console.log(JSON.stringify({ ok: true, results }, null, 2));
  if (relaySocket && !relaySocket.destroyed) relaySocket.destroy();
  if (statusSocket && !statusSocket.destroyed) statusSocket.destroy();
  await closeServer(statusServer);
  await closeServer(relayServer);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message, results, bridgeLog }, null, 2));
  process.exitCode = 1;
}).finally(() => {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});
