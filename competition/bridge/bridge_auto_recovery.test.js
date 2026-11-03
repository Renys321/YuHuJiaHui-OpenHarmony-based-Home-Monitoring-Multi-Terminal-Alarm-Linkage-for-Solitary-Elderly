#!/usr/bin/env node
'use strict';
/*
 * bridge_auto_recovery.test.js — mqtt_bridge 自动恢复能力回归（2026-10-27）
 *
 * 覆盖 2026-10-27 现场事故里"断开再启动后不自动恢复"的代码级缺陷：
 *   1. relay 通道（homemon 注入）断开后有界退避重连，恢复后补发每台在线入站设备的
 *      **最后一条**状态（DAYU 不必等下一次上报），且不重复告警；
 *   2. 设备真的断开后清掉缓存 —— relay 恢复时绝不补发"假在线"的旧状态；
 *   3. --relay-ignore：板外 mirror 直接注入 homemon 的 deviceId（如 esp32-sos）回灌到
 *      板端 status 连接时，只有"忽略"，不 bindNode / 不 publish / 不 retire 板端连接；
 *   4. MQTT broker 重启后桥接自动重连并重放最后状态（phone APP/云端不至于永久停在旧值）；
 *   5. 端口健康探测（连上即断、不发状态行）不再被记为"无线节点接入"，只限频记一条；
 *   6. --lock-file 单实例锁：第二个实例拒绝启动；死 PID 的陈旧锁自动接管。
 *
 * 真实程度：真实 mqtt_broker.js + 真实 mqtt_bridge.js 子进程 + 真实 TCP 假节点/假 relay。
 * 假节点与假 relay 都是 **mock**：只能证明传输层协议与恢复逻辑，不代表真实 ESP32/DAYU 链路。
 * 不访问公网、不需要密钥、不占用生产端口（全部随机本地端口）。
 * 子进程输出重定向到文件描述符（与 bridge_multinode.test.js 相同，避开管道 stdio 限制）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'elder-bridge-recovery-'));
const children = [];
const openServers = [];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(fn, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('等待超时: ' + label);
    await sleep(25);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function reservePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

function spawnLogged(tag, script, args) {
  const out = path.join(TMP, tag + '.log');
  fs.writeFileSync(out, '');
  const fd = fs.openSync(out, 'a');
  const child = childProcess.spawn(process.execPath, [script].concat(args), {
    cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true
  });
  fs.closeSync(fd);
  children.push(child);
  child.logFile = out;
  child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return child;
}

function readLog(child) {
  try { return fs.readFileSync(child.logFile, 'utf8'); } catch (e) { return ''; }
}

function logHas(child, needle) { return readLog(child).indexOf(needle) >= 0; }

function statusLine(deviceId, room, extra = {}) {
  const now = Date.now();
  return Object.assign({
    deviceId, room, ts: now, state: 'NORMAL',
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
  }, extra);
}

/* ------------------------------ mock: 板端 homemon relay 通道（接收 relay 行） */
function relayServer() {
  const srv = net.createServer();
  openServers.push(srv);
  const state = { srv, sockets: [], data: '', accepted: 0 };
  srv.on('connection', (sock) => {
    state.accepted += 1;
    state.sockets.push(sock);
    sock.setEncoding('utf8');
    sock.on('data', (d) => { state.data += d; });
    sock.on('error', () => {});
  });
  state.close = async () => {
    state.sockets.forEach((s) => { try { s.destroy(); } catch (e) {} });
    state.sockets = [];
    await new Promise((r) => srv.close(r));
  };
  return state;
}

/* ------------------------------ mock: 配置端点（板端 status 连接的上游） */
function endpointServer() {
  const srv = net.createServer();
  openServers.push(srv);
  const state = { srv, sockets: [] };
  srv.on('connection', (sock) => {
    state.sockets.push(sock);
    sock.setEncoding('utf8');
    sock.on('data', () => {});
    sock.on('error', () => {});
  });
  state.last = () => state.sockets[state.sockets.length - 1] || null;
  state.write = (obj) => { const s = state.last(); if (!s) throw new Error('endpoint: no socket'); s.write(JSON.stringify(obj) + '\n'); };
  state.writeRaw = (line) => { const s = state.last(); if (!s) throw new Error('endpoint: no socket'); s.write(line + '\n'); };
  return state;
}

/* ------------------------------ mock: 入站无线节点（连 Bridge --listen） */
function inboundNode(port) {
  const state = { received: '', closed: false };
  const sock = net.createConnection({ host: '127.0.0.1', port });
  state.socket = sock;
  sock.setEncoding('utf8');
  sock.on('data', (d) => { state.received += d; });
  sock.on('close', () => { state.closed = true; });
  sock.on('error', () => {});
  state.send = (obj) => sock.write(JSON.stringify(obj) + '\n');
  state.end = () => { try { sock.destroy(); } catch (e) {} };
  state.ready = new Promise((resolve) => sock.on('connect', resolve));
  return state;
}

/* ------------------------------ mock MQTT 订阅者（只读，用于观察重放） */
function mqttObserver(port) {
  const state = { messages: [], connected: false };
  const encStr = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length, 0); return Buffer.concat([l, b]); };
  const encLen = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return Buffer.from(o); };
  const pkt = (t, f, p) => Buffer.concat([Buffer.from([(t << 4) | f]), encLen(p.length), p]);
  const sock = net.createConnection({ host: '127.0.0.1', port });
  let buf = Buffer.alloc(0);
  sock.on('connect', () => sock.write(pkt(1, 0, Buffer.concat([encStr('MQTT'), Buffer.from([4, 0x02, 0, 60]), encStr('recovery-observer-' + port)]))));
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      let mult = 1, len = 0, i = 1;
      for (;;) {
        if (i >= buf.length) return;
        const b = buf[i]; len += (b & 127) * mult; mult *= 128; i++;
        if ((b & 128) === 0) break;
      }
      if (buf.length < i + len) return;
      const type = buf[0] >> 4;
      const body = buf.slice(i, i + len);
      buf = buf.slice(i + len);
      if (type === 2) {
        state.connected = true;
        sock.write(pkt(8, 2, Buffer.concat([Buffer.from([0, 1]), encStr('home/#'), Buffer.from([0])])));
      } else if (type === 3) {
        const tl = body.readUInt16BE(0);
        const topic = body.slice(2, 2 + tl).toString('utf8');
        const payload = body.slice(2 + tl).toString('utf8');
        let obj = null;
        try { obj = JSON.parse(payload); } catch (e) { obj = null; }
        state.messages.push({ topic, payload, obj, at: Date.now() });
      }
    }
  });
  sock.on('error', () => {});
  state.count = (topic) => state.messages.filter((m) => m.topic === topic).length;
  state.close = () => { try { sock.destroy(); } catch (e) {} };
  return state;
}

async function startBroker(tag, port) {
  const child = spawnLogged(tag, path.join(ROOT, 'mqtt_broker.js'), [String(port)]);
  await waitFor(() => logHas(child, '0.0.0.0:' + port), 'broker ' + tag + ' 启动');
  return child;
}

async function startBridge(tag, args) {
  const child = spawnLogged(tag, path.join(ROOT, 'mqtt_bridge.js'), args);
  return child;
}

test('relay 通道断开→有界重连→补发最后状态；设备断开后不补发假在线', async () => {
  const brokerPort = await reservePort();
  const listenPort = await reservePort();
  const relay = relayServer();
  const relayPort = await listen(relay.srv);

  await startBroker('brokerRelay', brokerPort);
  const bridge = await startBridge('bridgeRelay', [
    '--broker', '127.0.0.1:' + brokerPort,
    '--listen', String(listenPort),
    '--relay-to', '127.0.0.1:' + relayPort,
    '--status-file', path.join(TMP, 'relay-status.json'),
    '--cmd-out', path.join(TMP, 'relay-control')
  ]);
  await waitFor(() => logHas(bridge, '监听端口  : ' + listenPort), 'bridge 监听');
  await waitFor(() => relay.accepted >= 1, 'relay 通道首次连接');

  const node = inboundNode(listenPort);
  await node.ready;
  const first = statusLine('esp32-bath', '卫生间', { state: 'NORMAL' });
  node.send(first);
  await waitFor(() => relay.data.indexOf('esp32-bath') >= 0, '首个状态注入 relay');
  assert.ok(logHas(bridge, '无线节点接入并完成身份绑定：esp32-bath'), '应记录身份绑定而不是裸连接');

  /* 断掉 relay（模拟 homemon 重启 / hdc fport 断开） */
  await relay.close();
  await waitFor(() => logHas(bridge, '转发目标断开'), 'relay 断开日志');
  const second = statusLine('esp32-bath', '卫生间', { state: 'ACKED', alarm: { id: 'e-1', type: '', countToday: 0 } });
  node.send(second);
  await waitFor(() => logHas(bridge, 'relay 通道未连接，状态已缓存待恢复后补发'), 'relay 断开期间缓存日志');

  /* relay 恢复：必须自动重连并补发"最后一条"（ACKED），且只补一条 */
  const relay2 = relayServer();
  await new Promise((resolve, reject) => {
    relay2.srv.once('error', reject);
    relay2.srv.listen(relayPort, '127.0.0.1', () => {
      relay2.srv.removeListener('error', reject);
      resolve();
    });
  });
  await waitFor(() => {
    const injected = relay2.data.split('\n').filter((l) => l.indexOf('relay ') === 0 && l.indexOf('esp32-bath') >= 0);
    return injected.length === 1 && injected[0].indexOf('ACKED') >= 0;
  }, 'relay 恢复后补发最后状态', 12000);
  assert.ok(logHas(bridge, 'relay 通道已恢复：补发'), '应有补发日志');

  /* 设备真的断开：清缓存，下一次 relay 恢复不得补发假在线 */
  node.end();
  await waitFor(() => logHas(bridge, '无线节点 esp32-bath 断开'), '设备断开日志');
  await relay2.close();
  await waitFor(() => logHas(bridge, '转发目标断开'), '第二次 relay 断开');
  const relay3 = relayServer();
  await new Promise((resolve, reject) => {
    relay3.srv.once('error', reject);
    relay3.srv.listen(relayPort, '127.0.0.1', () => { relay3.srv.removeListener('error', reject); resolve(); });
  });
  await sleep(1500);
  assert.equal(relay3.data.indexOf('esp32-bath'), -1, '设备已断开，不得补发旧状态（会显示假在线）');
  await relay3.close();
});

test('--relay-ignore：板端连接上的 esp32-sos 回灌只忽略，不退休板端连接', async () => {
  const brokerPort = await reservePort();
  const listenPort = await reservePort();
  const endpoint = endpointServer();
  const endpointPort = await listen(endpoint.srv);
  const relay = relayServer();
  const relayPort = await listen(relay.srv);

  await startBroker('brokerScope', brokerPort);
  const bridge = await startBridge('bridgeScope', [
    '--broker', '127.0.0.1:' + brokerPort,
    '--status-tcp', '127.0.0.1:' + endpointPort,
    '--listen', String(listenPort),
    '--relay-to', '127.0.0.1:' + relayPort,
    '--relay-ignore', 'esp32-sos',
    '--status-file', path.join(TMP, 'scope-status.json'),
    '--cmd-out', path.join(TMP, 'scope-control')
  ]);
  await waitFor(() => logHas(bridge, '监听端口  : ' + listenPort), 'bridge 监听');
  const observer = mqttObserver(brokerPort);
  await waitFor(() => observer.connected, 'observer 连接');
  await waitFor(() => endpoint.last(), '端点被接入');

  endpoint.write(statusLine('dayu200-living', '客厅'));
  await waitFor(() => observer.count('home/dayu200-living/status') >= 1, '板端状态进入 MQTT');
  const socketBefore = endpoint.last();

  /* 模拟板外 mirror 直接注入 homemon 后被广播回板端 status 连接 */
  endpoint.write(statusLine('esp32-sos', '随身求助', { state: 'ALARM', alarm: { id: 'e-sos-1', type: 'MANUAL_SOS', countToday: 1 } }));
  await waitFor(() => logHas(bridge, '--relay-ignore 设备回灌'), '忽略日志', 4000);
  await sleep(500);
  assert.ok(!socketBefore.destroyed, '板端 status 连接不得被退休/关闭');
  assert.equal(logHas(bridge, '拒绝节点改名'), false, '不得再出现改名拒绝（旧根因）');
  assert.equal(observer.count('home/esp32-sos/status'), 0, '被忽略的设备不得由桥接发布');
  assert.equal(relay.data.indexOf('esp32-sos'), -1, '被忽略的设备不得再注入 relay');

  /* 其他 deviceId 行为不变：板端状态继续发布 */
  endpoint.write(statusLine('dayu200-living', '客厅', { state: 'ACKED' }));
  await waitFor(() => observer.count('home/dayu200-living/status') >= 2, '忽略后板端状态继续发布');
  observer.close();
});

test('未配置 --relay-ignore 时 esp32-sos 回灌会触发改名拒绝（旧缺陷复现，说明该参数必需）', async () => {
  const brokerPort = await reservePort();
  const listenPort = await reservePort();
  const endpoint = endpointServer();
  const endpointPort = await listen(endpoint.srv);
  const relay = relayServer();
  const relayPort = await listen(relay.srv);

  await startBroker('brokerNoIgnore', brokerPort);
  const bridge = await startBridge('bridgeNoIgnore', [
    '--broker', '127.0.0.1:' + brokerPort,
    '--status-tcp', '127.0.0.1:' + endpointPort,
    '--listen', String(listenPort),
    '--relay-to', '127.0.0.1:' + relayPort,
    '--status-file', path.join(TMP, 'noignore-status.json'),
    '--cmd-out', path.join(TMP, 'noignore-control')
  ]);
  await waitFor(() => logHas(bridge, '监听端口  : ' + listenPort), 'bridge 监听');
  const observer = mqttObserver(brokerPort);
  await waitFor(() => observer.connected, 'observer 连接');
  await waitFor(() => endpoint.last(), '端点被接入');
  endpoint.write(statusLine('dayu200-living', '客厅'));
  await waitFor(() => observer.count('home/dayu200-living/status') >= 1, '板端状态进入 MQTT');

  const socketBefore = endpoint.last();
  endpoint.write(statusLine('esp32-sos', '随身求助', { state: 'ALARM', alarm: { id: 'e-sos-2', type: 'MANUAL_SOS', countToday: 1 } }));
  await waitFor(() => logHas(bridge, '拒绝节点改名'), '旧缺陷：改名拒绝', 5000);
  await sleep(300);
  assert.equal(socketBefore.destroyed, true, '这正是 2026-10-27 之前的行为：板端 status 连接被退休/关闭');
  observer.close();
});

test('MQTT broker 重启后桥接自动重连并重放最后状态', async () => {
  const brokerPort = await reservePort();
  const listenPort = await reservePort();
  const endpoint = endpointServer();
  const endpointPort = await listen(endpoint.srv);

  let broker = await startBroker('brokerMqtt1', brokerPort);
  const bridge = await startBridge('bridgeMqtt', [
    '--broker', '127.0.0.1:' + brokerPort,
    '--status-tcp', '127.0.0.1:' + endpointPort,
    '--listen', String(listenPort),
    '--status-file', path.join(TMP, 'mqtt-status.json'),
    '--cmd-out', path.join(TMP, 'mqtt-control')
  ]);
  await waitFor(() => logHas(bridge, '监听端口  : ' + listenPort), 'bridge 监听');
  const observer1 = mqttObserver(brokerPort);
  await waitFor(() => observer1.connected, 'observer1 连接');
  await waitFor(() => endpoint.last(), '端点接入');

  endpoint.write(statusLine('dayu200-living', '客厅', { state: 'ALARM', alarm: { id: 'a-mqtt-1', type: 'MANUAL_SOS', countToday: 1 } }));
  await waitFor(() => observer1.count('home/dayu200-living/status') >= 1, '首次发布');
  observer1.close();

  broker.kill();
  await broker.exited;
  await waitFor(() => logHas(bridge, '连接关闭'), '桥接感知 broker 断开', 6000);

  broker = await startBroker('brokerMqtt2', brokerPort);
  const observer2 = mqttObserver(brokerPort);
  await waitFor(() => observer2.connected, 'observer2 连接');
  await waitFor(() => observer2.count('home/dayu200-living/status') >= 1, 'broker 重启后重放最后状态', 15000);
  await waitFor(() => logHas(bridge, 'MQTT 重连后重放最后状态'), '重放日志');
  observer2.close();
});

test('未识别探测连接不再被记为无线节点接入', async () => {
  const brokerPort = await reservePort();
  const listenPort = await reservePort();
  await startBroker('brokerProbe', brokerPort);
  const bridge = await startBridge('bridgeProbe', [
    '--broker', '127.0.0.1:' + brokerPort,
    '--listen', String(listenPort),
    '--status-file', path.join(TMP, 'probe-status.json'),
    '--cmd-out', path.join(TMP, 'probe-control')
  ]);
  await waitFor(() => logHas(bridge, '监听端口  : ' + listenPort), 'bridge 监听');

  const probe = net.createConnection({ host: '127.0.0.1', port: listenPort });
  await new Promise((resolve) => probe.on('connect', resolve));
  probe.destroy();
  await waitFor(() => logHas(bridge, '忽略未识别的探测连接'), '探测连接日志', 4000);
  assert.equal(logHas(bridge, '无线节点接入 ::ffff:127.0.0.1'), false, '不得把裸探测记成无线节点接入');
  assert.equal(logHas(bridge, '无线节点 listen:'), false, '不得把裸探测记成节点断开');
});

test('--lock-file 单实例锁：第二实例拒绝启动，陈旧锁自动接管', async () => {
  const brokerPort = await reservePort();
  const listenPort = await reservePort();
  await startBroker('brokerLock', brokerPort);
  const lockFile = path.join(TMP, 'bridge.lock');
  const args1 = [
    '--broker', '127.0.0.1:' + brokerPort,
    '--listen', String(listenPort),
    '--lock-file', lockFile,
    '--status-file', path.join(TMP, 'lock1-status.json'),
    '--cmd-out', path.join(TMP, 'lock1-control')
  ];
  const first = await startBridge('bridgeLock1', args1);
  await waitFor(() => logHas(first, '单实例锁已获取'), '首实例获取锁');

  const listenPort2 = await reservePort();
  const second = spawnLogged('bridgeLock2', path.join(ROOT, 'mqtt_bridge.js'), [
    '--broker', '127.0.0.1:' + brokerPort,
    '--listen', String(listenPort2),
    '--lock-file', lockFile,
    '--status-file', path.join(TMP, 'lock2-status.json'),
    '--cmd-out', path.join(TMP, 'lock2-control')
  ]);
  const secondExit = await second.exited;
  assert.equal(secondExit.code, 3, '第二个实例必须以退出码 3 拒绝启动');
  assert.ok(logHas(second, '已有 Bridge 实例在运行'), '第二实例应说明占用者 PID');

  /* 陈旧锁：写一个已退出的 PID，新实例应自动接管而不是永久卡住 */
  await first.kill();
  await first.exited;
  await sleep(200);
  fs.writeFileSync(lockFile, '999999', 'utf8');
  const listenPort3 = await reservePort();
  const third = await startBridge('bridgeLock3', [
    '--broker', '127.0.0.1:' + brokerPort,
    '--listen', String(listenPort3),
    '--lock-file', lockFile,
    '--status-file', path.join(TMP, 'lock3-status.json'),
    '--cmd-out', path.join(TMP, 'lock3-control')
  ]);
  await waitFor(() => logHas(third, '接管陈旧实例锁'), '陈旧锁接管');
  await waitFor(() => logHas(third, '单实例锁已获取'), '新实例获取锁');
});

test.after(() => {
  children.forEach((c) => { try { if (!c.killed) c.kill(); } catch (e) {} });
  openServers.forEach((srv) => { try { srv.close(); } catch (e) {} });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});
