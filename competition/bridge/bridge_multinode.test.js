#!/usr/bin/env node
'use strict';
/*
 * bridge_multinode.test.js — mqtt_bridge 多节点生命周期 / 同 ID 抢占回归测试
 *
 * 覆盖 2026-10-15 事故（"节点 127.0.0.1:9001 已被同 ID 新连接替换，不再重连" -> 板端永久失联）：
 *   A. 单端点 + 入站无线节点共存
 *   B. 两个配置端点声明同一 deviceId（端点优先级 + 迟到 close 不得误删映射）
 *
 * 真实程度：真实 mqtt_broker.js + 真实 mqtt_bridge.js 子进程 + 真实 TCP 假节点 + 真实 MQTT 报文观察者。
 * 不访问公网、不需要任何密钥、不使用生产端口（全部随机本地端口）。
 * 说明：本机沙箱禁止 Node 以管道 stdio 启动子进程（EPERM），因此子进程输出重定向到文件描述符。
 */
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'elder-bridge-multinode-'));
const children = [];
const results = [];
const logFiles = {};

function check(name, ok, info) {
  results.push({ name: name, ok: Boolean(ok), info: String(info === undefined ? '' : info).slice(0, 300) });
  if (!ok) throw new Error('ASSERT FAIL: ' + name + (info ? ' :: ' + info : ''));
}

function waitFor(fn, label, timeoutMs) {
  const limit = timeoutMs || 8000;
  const deadline = Date.now() + limit;
  return new Promise(function (resolve, reject) {
    const poll = function () {
      let value = null;
      try { value = fn(); } catch (e) { return reject(e); }
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error('等待超时: ' + label));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function listen(server) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

async function reservePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise(function (r) { s.close(r); });
  return port;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function spawnLogged(tag, script, args) {
  const out = path.join(TMP, tag + '.log');
  logFiles[tag] = out;
  fs.writeFileSync(out, '');
  const fd = fs.openSync(out, 'a');
  const child = childProcess.spawn(process.execPath, [script].concat(args), {
    cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true
  });
  fs.closeSync(fd);
  children.push(child);
  return child;
}

function readLog(tag) {
  try { return fs.readFileSync(logFiles[tag], 'utf8'); } catch (e) { return ''; }
}

/* ------------------------------------------------ 最简 MQTT 观察者（只订阅，不发布） */
function mqttObserver(port) {
  const state = { messages: [], connected: false };
  const encStr = function (s) {
    const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length, 0);
    return Buffer.concat([l, b]);
  };
  const encLen = function (n) {
    const o = [];
    do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0);
    return Buffer.from(o);
  };
  const pkt = function (t, f, p) { return Buffer.concat([Buffer.from([(t << 4) | f]), encLen(p.length), p]); };
  const sock = net.createConnection({ host: '127.0.0.1', port: port });
  let buf = Buffer.alloc(0);
  state.socket = sock;
  sock.on('connect', function () {
    sock.write(pkt(1, 0, Buffer.concat([encStr('MQTT'), Buffer.from([4, 0x02, 0, 60]), encStr('test-observer-' + port)])));
  });
  sock.on('data', function (d) {
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
        state.messages.push({ topic: topic, payload: payload, obj: obj, at: Date.now() });
      }
    }
  });
  sock.on('error', function () {});
  state.count = function (topic) {
    return state.messages.filter(function (m) { return m.topic === topic; }).length;
  };
  state.rooms = function (topic) {
    return state.messages.filter(function (m) { return m.topic === topic; })
      .map(function (m) { return m.obj && m.obj.room; });
  };
  state.close = function () { try { sock.destroy(); } catch (e) {} };
  return state;
}

/* ------------------------------------------------ 假 TCP 节点 */
function endpointNode(tag) {
  const srv = net.createServer();
  const state = { tag: tag, srv: srv, sockets: [], received: [], acceptedAt: [] };
  srv.on('connection', function (sock) {
    state.sockets.push(sock);
    state.acceptedAt.push(Date.now());
    sock.setEncoding('utf8');
    sock._recv = '';                       // 逐 socket 记录，验证命令发到了"新"连接
    let acc = '';
    sock.on('data', function (d) {
      acc += d;
      sock._recv += d;
      let i;
      while ((i = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, i).trim();
        acc = acc.slice(i + 1);
        if (line) state.received.push(line);
      }
    });
    sock.on('error', function () {});
  });
  state.last = function () { return state.sockets[state.sockets.length - 1] || null; };
  state.write = function (obj) {
    const s = state.last();
    if (!s) throw new Error(tag + ': no accepted socket');
    s.write(JSON.stringify(obj) + '\n');
  };
  state.dropAll = function () {
    state.sockets.forEach(function (s) { try { s.destroy(); } catch (e) {} });
  };
  return state;
}

function relayNode(tag) {
  const srv = net.createServer();
  const state = { tag: tag, srv: srv, sockets: [], data: '' };
  srv.on('connection', function (sock) {
    state.sockets.push(sock);
    sock.setEncoding('utf8');
    sock.on('data', function (d) { state.data += d; });
    sock.on('error', function () {});
  });
  state.write = function (line) {
    const s = state.sockets[state.sockets.length - 1];
    if (s) s.write(line);
  };
  return state;
}

function inboundNode(port) {
  const state = { received: '', closed: false };
  const sock = net.createConnection({ host: '127.0.0.1', port: port });
  state.socket = sock;
  sock.setEncoding('utf8');
  sock.on('data', function (d) { state.received += d; });
  sock.on('close', function () { state.closed = true; });
  sock.on('error', function () {});
  state.send = function (obj) { sock.write(JSON.stringify(obj) + '\n'); };
  state.end = function () { try { sock.destroy(); } catch (e) {} };
  state.ready = new Promise(function (resolve) { sock.on('connect', resolve); });
  return state;
}

function statusLine(deviceId, room, marker) {
  const now = Date.now();
  return {
    deviceId: deviceId, room: room, ts: now, state: 'NORMAL',
    sensors: {
      motion: { lastActiveTs: now - 1000, countToday: 0 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 0, rh: 0, ok: true },
      gas: { raw: 0, ok: true },
      smoke: { raw: 0, ok: true }
    },
    history: [0, 0, 0, 0, 0, 0, 0],
    slots: [0, 0, 0, 0],
    alarm: { id: marker || '', type: '', countToday: 0 }
  };
}

const DAYU_TOPIC = 'home/dayu200-living/status';
const ESP_TOPIC = 'home/esp32-bath/status';

/* ============================================================ 场景 A */
async function scenarioA() {
  const brokerPort = await reservePort();
  const listenPort = await reservePort();
  const endpoint = endpointNode('endpointA');
  const endpointPort = await listen(endpoint.srv);
  const relay = relayNode('relayA');
  const relayPort = await listen(relay.srv);

  spawnLogged('brokerA', path.join(ROOT, 'mqtt_broker.js'), [String(brokerPort)]);
  await waitFor(function () { return readLog('brokerA').indexOf('0.0.0.0:' + brokerPort) >= 0; }, 'brokerA 启动');

  spawnLogged('bridgeA', path.join(ROOT, 'mqtt_bridge.js'), [
    '--broker', '127.0.0.1:' + brokerPort,
    '--status-tcp', '127.0.0.1:' + endpointPort,
    '--listen', String(listenPort),
    '--relay-to', '127.0.0.1:' + relayPort,
    '--status-file', path.join(TMP, 'statusA.json'),
    '--cmd-out', path.join(TMP, 'controlA')
  ]);
  await waitFor(function () { return readLog('bridgeA').indexOf('监听端口  : ' + listenPort) >= 0; }, 'bridgeA 启动');

  const observer = mqttObserver(brokerPort);
  await waitFor(function () { return observer.connected; }, '观察者连接 Broker');

  /* 1) 配置端点首次连接并发布 dayu200-living */
  await waitFor(function () { return endpoint.last(); }, '端点被 Bridge 接入');
  endpoint.write(statusLine('dayu200-living', '客厅', 'a1'));
  await waitFor(function () { return observer.count(DAYU_TOPIC) >= 1; }, '端点状态进入 MQTT');
  check('1 配置端点首次连接并发布 dayu200-living', observer.count(DAYU_TOPIC) >= 1);
  check('1b endpoint 状态不回灌 relay', relay.data.indexOf('dayu200-living') < 0, JSON.stringify(relay.data.slice(0, 120)));

  /* 7) 入站 esp32-bath 正常发布 */
  const esp1 = inboundNode(listenPort);
  await esp1.ready;
  esp1.send(statusLine('esp32-bath', '卫生间', 'e1'));
  await waitFor(function () { return observer.count(ESP_TOPIC) >= 1; }, 'esp32-bath 进入 MQTT');
  check('7 9101 入站 esp32-bath 正常发布', observer.count(ESP_TOPIC) >= 1);
  check('7b 入站状态仍注入 relay（板上 APP 可见）', relay.data.indexOf('esp32-bath') >= 0);

  /* 7c/核心根因回归）homemon 会把 relay 注入的 JSON 原样广播回"板端 status 连接"。
     这条回灌既不能让板端连接改名退休，也不能冒领 esp32-bath 身份造成重复发布。 */
  const relayedLine = relay.data.split('\n').filter(function (l) { return l.indexOf('esp32-bath') >= 0; })[0];
  check('7c relay 通道确实注入了 esp32-bath', !!relayedLine && relayedLine.indexOf('relay ') === 0, relayedLine);
  const echoJson = relayedLine.replace(/^relay /, '');
  const endpointSockBefore = endpoint.last();
  const espBeforeEcho = observer.count(ESP_TOPIC);
  const dayuBeforeEcho = observer.count(DAYU_TOPIC);
  endpointSockBefore.write(echoJson + '\n');            // 模拟 homemon 把注入行广播回板端连接
  await sleep(400);
  check('7d 回灌不会让板端连接改名退休',
    endpoint.last() === endpointSockBefore && !endpointSockBefore.destroyed &&
      readLog('bridgeA').indexOf('拒绝节点改名') < 0,
    'log_has_rename=' + (readLog('bridgeA').indexOf('拒绝节点改名') >= 0));
  check('7e 回灌不会重复发布 esp32-bath',
    observer.count(ESP_TOPIC) === espBeforeEcho,
    'before=' + espBeforeEcho + ' after=' + observer.count(ESP_TOPIC));
  check('7f 回灌不会抢占/关闭真实 ESP32 入站连接', !esp1.closed);
  check('7g 回灌被显式识别并记录', readLog('bridgeA').indexOf('忽略板端连接上的 relay 回灌') >= 0);
  endpoint.write(statusLine('dayu200-living', '客厅', 'a-echo'));
  await waitFor(function () { return observer.count(DAYU_TOPIC) > dayuBeforeEcho; }, '回灌后板端状态继续发布');
  check('7h 回灌后板端状态继续正常发布', observer.count(DAYU_TOPIC) > dayuBeforeEcho);

  /* 8) 两个设备同时在线 + 下行按 ID 路由 */
  relay.write('route dayu200-living reset\n');
  relay.write('route esp32-bath motion\n');
  await waitFor(function () { return endpoint.received.indexOf('reset') >= 0; }, '端点收到 reset');
  await waitFor(function () { return esp1.received.indexOf('motion') >= 0; }, 'ESP32 收到 motion');
  check('8 dayu200-living 与 esp32-bath 同时在线且按 ID 路由', true);
  check('8b 端点未收到 ESP32 的命令', endpoint.received.indexOf('motion') < 0);
  check('8c ESP32 未收到端点的命令', esp1.received.indexOf('reset') < 0);

  /* 核心回归）入站连接冒充 dayu200-living 必须被拒绝，且不得挤掉配置端点 */
  const impostor = inboundNode(listenPort);
  await impostor.ready;
  const beforeImpostor = observer.count(DAYU_TOPIC);
  const beforeEndpointSocks = endpoint.sockets.length;
  impostor.send(statusLine('dayu200-living', 'IMPOSTOR', 'IMPOSTOR'));
  await waitFor(function () { return readLog('bridgeA').indexOf('拒绝节点抢占配置端点身份') >= 0; }, '抢占被拒绝日志');
  await sleep(300);
  check('5 入站连接不能抢占配置端点身份', readLog('bridgeA').indexOf('拒绝节点抢占配置端点身份') >= 0);
  check('5b 冒充者连接被关闭', impostor.closed);
  check('5c 配置端点 socket 未被关闭',
    endpoint.sockets.length === beforeEndpointSocks && endpoint.last() && !endpoint.last().destroyed);
  check('5d 冒充者没有产生任何 dayu200 发布',
    observer.count(DAYU_TOPIC) === beforeImpostor,
    'before=' + beforeImpostor + ' after=' + observer.count(DAYU_TOPIC));
  check('5e 事故日志"不再重连"不再出现', readLog('bridgeA').indexOf('不再重连') < 0);
  relay.write('route dayu200-living reset\n');
  await waitFor(function () {
    return endpoint.received.filter(function (l) { return l === 'reset'; }).length >= 2;
  }, '抢占被拒后端点仍可路由');
  check('5f 抢占被拒后端点映射仍有效（命令仍可达）', true);

  /* 2/9/12）端点断线自动重连 + 退避下限 */
  const acceptedBefore = endpoint.acceptedAt.length;
  const dropAt = Date.now();
  endpoint.dropAll();
  await waitFor(function () { return endpoint.acceptedAt.length > acceptedBefore; }, '端点自动重连', 15000);
  const gap = endpoint.acceptedAt[endpoint.acceptedAt.length - 1] - dropAt;
  check('2 端点断线后自动重连', endpoint.acceptedAt.length > acceptedBefore, 'gap=' + gap + 'ms');
  check('12 重连不是零延迟忙循环（>=2000ms）', gap >= 2000, 'gap=' + gap + 'ms');
  check('2b 重连日志包含退避毫秒数', /毫秒后重连/.test(readLog('bridgeA')));
  check('2c 事故日志"已被同 ID 新连接替换"不再出现', readLog('bridgeA').indexOf('已被同 ID 新连接替换') < 0);

  /* 重连后：板端重新自报身份 -> 映射重建 -> 命令必须落到"新" socket（旧 close 不得误删） */
  const oldSocket = endpoint.sockets[endpoint.acceptedAt.length - 2] || null;
  const afterReconnect = observer.count(DAYU_TOPIC);
  endpoint.write(statusLine('dayu200-living', '客厅', 'a2'));
  await waitFor(function () { return observer.count(DAYU_TOPIC) > afterReconnect; }, '重连后继续发布');
  check('3 HDC/fport 类重建后仍持续发布', true);
  const resetBefore = endpoint.received.filter(function (l) { return l === 'reset'; }).length;
  const oldLenBefore = oldSocket ? oldSocket._recv.length : 0;
  relay.write('route dayu200-living reset\n');
  await waitFor(function () {
    return endpoint.received.filter(function (l) { return l === 'reset'; }).length > resetBefore;
  }, '重连后命令仍可达');
  const newSocket = endpoint.last();
  check('4 重连后的命令只落到新连接（映射未被旧 close 误删）',
    !!newSocket && newSocket !== oldSocket && newSocket._recv.indexOf('reset') >= 0 &&
      (!oldSocket || oldSocket._recv.length === oldLenBefore),
    'new=' + JSON.stringify(newSocket && newSocket._recv) +
    ' old_delta=' + (oldSocket ? (oldSocket._recv.length - oldLenBefore) : 'n/a'));

  /* 10) ESP32 不受端点重连影响 */
  check('10a 端点重连不影响 ESP32 连接', !esp1.closed);
  const espBefore = observer.count(ESP_TOPIC);
  esp1.send(statusLine('esp32-bath', '卫生间', 'e2'));
  await waitFor(function () { return observer.count(ESP_TOPIC) > espBefore; }, 'ESP32 仍能发布');
  relay.write('route esp32-bath gas\n');
  await waitFor(function () { return esp1.received.indexOf('gas') >= 0; }, 'ESP32 仍能收命令');
  check('10 端点重连不影响 ESP32 上报与下行', true);

  /* 6) 同 ID 入站接管不产生重复发布 */
  const esp2 = inboundNode(listenPort);
  await esp2.ready;
  esp2.send(statusLine('esp32-bath', '卫生间2', 'e3'));
  await waitFor(function () { return esp1.closed; }, '旧 ESP32 连接被接管关闭');
  const dupBefore = observer.count(ESP_TOPIC);
  esp2.send(statusLine('esp32-bath', '卫生间2', 'e4'));
  await waitFor(function () { return observer.count(ESP_TOPIC) > dupBefore; }, '新 ESP32 发布');
  const dupAfter = observer.count(ESP_TOPIC);
  check('6 同 ID 接管后无重复发布（1 条输入 = 1 条输出）', dupAfter - dupBefore === 1, 'delta=' + (dupAfter - dupBefore));
  relay.write('route esp32-bath smoke\n');
  await waitFor(function () { return esp2.received.indexOf('smoke') >= 0; }, '接管后命令发给新连接');
  check('6b 接管后命令只发给新连接', esp1.received.indexOf('smoke') < 0);

  /* 11) 安全限制未被破坏 */
  const illegal = inboundNode(listenPort);
  await illegal.ready;
  illegal.send(statusLine('bad/id', '非法', 'x'));
  await waitFor(function () { return readLog('bridgeA').indexOf('拒绝节点身份') >= 0; }, '非法 ID 被拒绝');
  await waitFor(function () { return illegal.closed; }, '非法 ID 连接被关闭');
  check('11a 非法 deviceId 仍被拒绝并关闭连接', illegal.closed && readLog('bridgeA').indexOf('拒绝节点身份') >= 0);

  const renameMe = inboundNode(listenPort);
  await renameMe.ready;
  renameMe.send(statusLine('rename-a', '甲', 'r1'));
  await waitFor(function () { return observer.count('home/rename-a/status') >= 1; }, '改名前置发布');
  renameMe.send(statusLine('rename-b', '乙', 'r2'));
  await waitFor(function () { return readLog('bridgeA').indexOf('拒绝节点改名') >= 0; }, '改名被拒绝');
  check('11b 同一连接改名仍被拒绝', readLog('bridgeA').indexOf('拒绝节点改名') >= 0);

  const flood = inboundNode(listenPort);
  await flood.ready;
  flood.socket.write('{"deviceId":"flood-node","room":"超长"');
  const chunk = 'x'.repeat(4096);
  for (let i = 0; i < 20; i++) flood.socket.write(chunk);
  await waitFor(function () { return readLog('bridgeA').indexOf('状态行超过') >= 0; }, '超长无换行被拒绝');
  check('11c 超长无换行报文仍被拒绝', readLog('bridgeA').indexOf('状态行超过') >= 0);
  flood.end();

  observer.close();
  endpoint.dropAll();
  relay.sockets.forEach(function (s) { try { s.destroy(); } catch (e) {} });
}

/* ============================================================ 场景 B */
async function scenarioB() {
  const brokerPort = await reservePort();
  const listenPort = await reservePort();
  const epNode = endpointNode('endpointB');
  const epPort = await listen(epNode.srv);
  const relay = relayNode('relayB');
  const relayPort = await listen(relay.srv);

  spawnLogged('brokerB', path.join(ROOT, 'mqtt_broker.js'), [String(brokerPort)]);
  await waitFor(function () { return readLog('brokerB').indexOf('0.0.0.0:' + brokerPort) >= 0; }, 'brokerB 启动');
  spawnLogged('bridgeB', path.join(ROOT, 'mqtt_bridge.js'), [
    '--broker', '127.0.0.1:' + brokerPort,
    '--status-tcp', '127.0.0.1:' + epPort + ',127.0.0.1:' + epPort,
    '--listen', String(listenPort),
    '--relay-to', '127.0.0.1:' + relayPort,
    '--status-file', path.join(TMP, 'statusB.json'),
    '--cmd-out', path.join(TMP, 'controlB')
  ]);
  await waitFor(function () { return readLog('bridgeB').indexOf('节点数    : 2') >= 0; }, 'bridgeB 以两个端点启动');
  const observer = mqttObserver(brokerPort);
  await waitFor(function () { return observer.connected; }, '观察者B 连接 Broker');
  await waitFor(function () { return epNode.sockets.length >= 2; }, '两个端点都已接入假节点');

  const send = function (idx, room, marker) {
    epNode.sockets[idx].write(JSON.stringify(statusLine('dayu200-living', room, marker)) + '\n');
  };
  send(0, '端点甲', 'B1');
  await waitFor(function () { return observer.count(DAYU_TOPIC) >= 1; }, '端点B 首个发布');
  check('B1 两个端点声明同一 deviceId 时仍可发布', observer.count(DAYU_TOPIC) >= 1);

  const countBefore = observer.count(DAYU_TOPIC);
  send(1, '端点乙', 'B2');
  await sleep(600);
  const countAfter = observer.count(DAYU_TOPIC);
  const logB = readLog('bridgeB');
  check('B2 第二个端点被确定性拒绝（配置端点优先）',
    logB.indexOf('拒绝节点抢占配置端点身份') >= 0, logB.slice(-300));
  check('B3 拒绝不产生额外发布（无重复状态）', countAfter === countBefore,
    'before=' + countBefore + ' after=' + countAfter);

  /* 被拒端点的 close 不得删除胜出端点的映射：命令必须仍能到达 */
  const winner = epNode.sockets.find(function (s) { return !s.destroyed; });
  await sleep(400);                       // 让被拒端点的退避重连/关闭发生
  relay.write('route dayu200-living reset\n');
  await waitFor(function () {
    return epNode.sockets.some(function (s) { return s._recv && s._recv.indexOf('reset') >= 0; });
  }, '被拒端点 close 后命令仍可达', 4000);
  check('B4 被拒端点的 close 未删除胜出端点映射（命令仍可达）',
    !!winner && winner._recv.indexOf('reset') >= 0,
    'winner_recv=' + JSON.stringify(winner && winner._recv));

  const gaps = [];
  const re = /(\d+) 毫秒后重连/g;
  let m;
  while ((m = re.exec(logB)) !== null) gaps.push(Number(m[1]));
  check('B5 被拒端点按退避重连而非零延迟忙循环',
    gaps.length > 0 && Math.min.apply(null, gaps) >= 3000, JSON.stringify(gaps.slice(0, 6)));

  observer.close();
  epNode.dropAll();
  relay.sockets.forEach(function (s) { try { s.destroy(); } catch (e) {} });
}

(async function () {
  let ok = false;
  try {
    await scenarioA();
    await scenarioB();
    ok = true;
    console.log(JSON.stringify({ ok: true, checks: results.length, results: results }, null, 1));
  } catch (e) {
    console.log(JSON.stringify({
      ok: false, error: e.message, checks: results.length, results: results,
      bridgeA: readLog('bridgeA').slice(-1200), bridgeB: readLog('bridgeB').slice(-800)
    }, null, 1));
  } finally {
    children.forEach(function (c) { try { if (!c.killed) c.kill(); } catch (e) {} });
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(ok ? 0 : 1);
  }
})();
