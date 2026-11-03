#!/usr/bin/env node
/**
 * 设备状态行与 MQTT 的双向桥接。
 *
 * 上行：节点 JSON 行        -> home/<deviceId>/status
 * 下行：home/<deviceId>/cmd  -> 按 deviceId 路由到对应节点
 * 多节点：--status-tcp 可传多个端点（逗号分隔），节点身份由报文里的 deviceId 决定。
 * 依赖：只用 Node 内置模块，MQTT 3.1.1 客户端为手写实现。
 */
'use strict';

const net = require('net');
const fs = require('fs');

// 日志统一加 ISO 前缀，正文不动：脚本和测试都按子串匹配 bridge 输出。
function isoNow() { return new Date().toISOString(); }
function log(...parts) { console.log(`[${isoNow()}]`, ...parts); }
function logErr(...parts) { console.error(`[${isoNow()}]`, ...parts); }

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    a[k] = argv[i + 1];
  }
  return a;
}
const args = parseArgs(process.argv);
const brokerSpec = (args.broker || 'broker.emqx.io:1883').split(':');
const BROKER_HOST = brokerSpec[0];
const BROKER_PORT = parseInt(brokerSpec[1] || '1883', 10);
const DEVICE = args.device || 'dayu200-living';
const STATUS_FILE = args['status-file'] || 'status.json';
const CMD_OUT = args['cmd-out'] || 'control';
const INTERVAL = parseInt(args.interval || '2000', 10);

/* 端点列表：--status-tcp 支持逗号分隔的多个 host:port */
const ENDPOINTS = (args['status-tcp'] || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/* 监听端口：--listen 让无线节点（ESP32-S3 等）主动连上来推 JSON 行
   —— 与 homemon 完全相同的协议，节点无需任何第三方库 */
const LISTEN_PORT = parseInt(args['listen'] || '0', 10);

/* 转发目标：--relay-to <host:port> 把收到的其他节点状态注入板的 homemon
   （homemon 用 relay 命令广播给板上 APP，从而 APP 能看到全部房间） */
const RELAY_TO = args['relay-to'] || '';

/* 单实例锁：--lock-file <path>（可选）。两个 Bridge 连同一个 broker/relay 会重复
   发布状态、重复注入 relay；不给该参数就不加锁。 */
const LOCK_FILE = args['lock-file'] || '';

/* ---- 定向求助播报 ----
 * 随身求助（esp32-sos）按下后，厨房/卫生间两块固定板要播同一个求助，但它们不能各自
 * 伪造本地 MANUAL_SOS，于是由桥接做唯一编排点：
 * - 只在 --sos-source 确实进入 MANUAL_SOS/ALARM 时，把同一 alarmId 用受控逐台路由
 *   （routeCommand）写给 --sos-targets 里的每个 deviceId；
 * - 不走 MQTT 通配/广播，也不写公共文件兜底（离线就记失败）；
 * - 同一 alarmId 只派发一次；来源 ACKED 后给当时送达的目标补一条 noticeack；
 * - 目标离线只记 failed，另一块照常播报；重连不补发，避免重复出声。
 * 两个参数都不给时功能完全关闭。 */
const SOS_SOURCE = (args['sos-source'] || '').trim();

/* --relay-ignore <deviceId,...>
 * 板端 status 端点连接（kind='endpoint'）会收到 homemon 广播的所有 relay 行。
 * 有些设备（如随身求助 esp32-sos）是板外 mirror 直接 `relay <json>` 注入 homemon，
 * 桥接并不持有它的连接；这类回灌会被当成"板端连接改名"，把板端连接退休，DAYU 侧
 * 就此永久失联。命中名单的 deviceId 一律 continue：
 * 不 isOwnRelayEcho、不 bindNode、不 publish、不 retire。 */
const RELAY_IGNORE = new Set(
  (args['relay-ignore'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
);
for (const ignored of RELAY_IGNORE) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ignored)) {
    logErr(`[bridge] --relay-ignore 含非法 deviceId，已忽略：${JSON.stringify(ignored)}`);
    RELAY_IGNORE.delete(ignored);
  }
}
const SOS_TARGETS = (args['sos-targets'] || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const SOS_LOG = args['sos-log'] || '';
const SOS_DISPATCH_MAX = 64;
const sosDispatched = new Map();      // alarmId -> { alarmId, source, targets:{id:status}, ackSent }

/* ---- MQTT 3.1.1 编解码 ---- */
function encodeLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}
function encodeStr(s) {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length, 0);
  return Buffer.concat([l, b]);
}
function packet(type, flags, payload) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLen(payload.length), payload]);
}

class MqttClient {
  constructor(host, port, clientId, onMessage, onConnect) {
    this.host = host; this.port = port; this.clientId = clientId;
    this.onMessage = onMessage;
    this.onConnect = onConnect || null;
    this.everConnected = false;
    this.buf = Buffer.alloc(0);
    this.connected = false;
    this.packetId = 1;
    this.sock = null;
  }

  connect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.buf = Buffer.alloc(0);
    this.sock = net.createConnection({ host: this.host, port: this.port }, () => {
      const payload = Buffer.concat([
        encodeStr('MQTT'),
        Buffer.from([4]),
        Buffer.from([0x02]),
        Buffer.from([0, 30]),
        encodeStr(this.clientId)
      ]);
      this.sock.write(packet(1, 0, payload));
    });
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('error', (e) => {
      logErr('[MQTT] 连接错误:', e.message);
      this.connected = false;
      this.scheduleReconnect();          // 网络闪断后自动恢复，无需人工重启
    });
    this.sock.on('close', () => {
      this.connected = false;
      log('[MQTT] 连接关闭，3 秒后自动重连');
      this.scheduleReconnect();
    });
    return this;
  }

  /** 断线重连（防抖：error/close 双触发时只建一条连接） */
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      log(`[MQTT] 正在重连 ${this.host}:${this.port} …`);
      this.connect();
    }, 3000);
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      let mult = 1, len = 0, i = 1;
      while (true) {
        if (i >= this.buf.length) return;
        const b = this.buf[i];
        len += (b & 127) * mult;
        mult *= 128;
        i++;
        if ((b & 128) === 0) break;
      }
      const total = i + len;
      if (this.buf.length < total) return;
      const type = this.buf[0] >> 4;
      const flags = this.buf[0] & 0x0f;
      const body = this.buf.slice(i, total);
      this.buf = this.buf.slice(total);
      this._handle(type, body, flags);
    }
  }

  _puback(packetId) {
    if (!this.sock || this.sock.destroyed || !this.sock.writable) return;
    const id = Buffer.alloc(2);
    id.writeUInt16BE(packetId, 0);
    this.sock.write(packet(4, 0, id));
  }

  _handle(type, body, flags) {
    if (type === 2) {
      const rc = body[1];
      if (rc === 0) {
        const reconnected = this.everConnected;
        this.connected = true;
        this.everConnected = true;
        log(`[MQTT] 已连接 ${this.host}:${this.port}（clientId=${this.clientId}）`);
        this.subscribe('home/+/cmd');
        if (this.onConnect) {
          try { this.onConnect({ reconnected }); }
          catch (e) { logErr('[MQTT] onConnect 回调异常:', e && e.message ? e.message : e); }
        }
      } else {
        logErr('[MQTT] CONNACK 失败 rc=', rc);
      }
    } else if (type === 3) {
      // PUBLISH 变长头顺序：topic 长度(2) → topic → [QoS>0 时的 packetId(2)] → payload。
      // 先读 topic 再读 packetId，顺序反了 QoS1 消息就会错位。
      const qos = (flags >> 1) & 0x03;
      if (qos !== 0 && qos !== 1) {
        logErr(`[MQTT] PUBLISH 拒绝 code=UNSUPPORTED_QOS qos=${qos}`);
        return;
      }
      if (body.length < 2) {
        logErr('[MQTT] PUBLISH 拒绝 code=TRUNCATED_TOPIC_LENGTH');
        return;
      }
      const tlen = body.readUInt16BE(0);
      if (tlen === 0 || body.length < 2 + tlen) {
        logErr('[MQTT] PUBLISH 拒绝 code=INVALID_TOPIC_LENGTH');
        return;
      }
      const topic = body.slice(2, 2 + tlen).toString('utf8');
      let offset = 2 + tlen;
      let packetId = 0;
      if (qos === 1) {
        if (body.length < offset + 2) {
          logErr('[MQTT] PUBLISH 拒绝 code=MISSING_PACKET_ID');
          return;
        }
        packetId = body.readUInt16BE(offset);
        if (packetId === 0) {
          logErr('[MQTT] PUBLISH 拒绝 code=ZERO_PACKET_ID');
          return;
        }
        offset += 2;
      }
      const payload = body.slice(offset).toString('utf8');
      if (qos === 1) this._puback(packetId);
      log(`[MQTT] ← ${topic}: ${payload}`);
      if (this.onMessage) this.onMessage(topic, payload);
    } else if (type === 9) {
      log('[MQTT] 订阅成功: home/+/cmd');
    }
  }

  subscribe(topic) {
    const payload = Buffer.concat([
      Buffer.from([(this.packetId >> 8) & 0xff, this.packetId & 0xff]),
      encodeStr(topic),
      Buffer.from([0])
    ]);
    this.packetId++;
    this.sock.write(packet(8, 2, payload));
  }

  publish(topic, obj, retain) {
    if (!this.connected) return false;
    const body = Buffer.concat([encodeStr(topic), Buffer.from(JSON.stringify(obj), 'utf8')]);
    this.sock.write(packet(3, retain ? 0x01 : 0x00, body));
    return true;
  }

  ping() {
    if (this.sock && this.connected) this.sock.write(packet(12, 0, Buffer.alloc(0)));
  }
}

/* ---- 节点连接管理 ----
 * 两类节点，生命周期完全不同：
 * kind='endpoint' —— --status-tcp 配置的主动端点（HDC fport -> 板端 homemon）。
 * 由连接管理器负责；断线后永远安排下一次重连。
 * retired 只表示"这一条 socket 不可再用"，不终止端点重连管理器。
 * kind='inbound' —— --listen 接受的入站无线节点（ESP32-S3 等）。
 * 生命周期跟随 socket；同 ID 新连接接管旧连接。
 *
 * 同一 deviceId 的确定性优先级（配置端点优先）：
 * 当前属主 | 新申报者 | 结果
 * 端点 | 任意 | 拒绝新申报者；属主不变（端点不会被入站连接永久挤掉）
 * 入站 | 端点 | 端点接管，入站实例退休
 * 入站 | 入站 | 新连接接管旧连接
 * 任何时刻一个 deviceId 只有一个活动属主，不会出现两份重复状态。
 */
const nodes = [];      // { endpoint, kind, sock, deviceId, acc, retired, failures, reconnectTimer }
const activeNodes = new Map();
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_NODE_BUFFER_CHARS = 65536;
const ENDPOINT_RECONNECT_BASE_MS = 3000;
const ENDPOINT_RECONNECT_MAX_MS = 30000;

/** 端点重连延迟：连续失败指数退避（3s->6s->12s->24s，封顶 30s）。
 * 下限 3s 保证不存在零延迟忙循环；上限 30s 保证不会永久停止重试。 */
function endpointReconnectDelay(failures) {
  const n = Number.isFinite(failures) && failures > 1 ? Math.min(failures - 1, 4) : 0;
  return Math.min(ENDPOINT_RECONNECT_MAX_MS, ENDPOINT_RECONNECT_BASE_MS * Math.pow(2, n));
}

/** 让"这一条连接实例"退休。只影响该实例；配置端点的重连管理器不受影响。 */
function retireNode(node, reason) {
  node.retired = true;
  if (reason) logErr(`[bridge] 节点 ${node.deviceId || node.endpoint} 连接已退休：${reason}`);
  if (node.sock && !node.sock.destroyed) node.sock.destroy();
}

function appendNodeData(node, data) {
  node.acc += data.toString('utf8');
  if (node.acc.length <= MAX_NODE_BUFFER_CHARS) return true;
  logErr(`[bridge] 拒绝节点 ${node.deviceId || node.endpoint}：状态行超过 ${MAX_NODE_BUFFER_CHARS} 字符`);
  node.retired = true;
  node.acc = '';
  if (node.sock && !node.sock.destroyed) node.sock.destroy();
  return false;
}

function bindNode(node, deviceId) {
  if (node.retired) return false;
  if (!DEVICE_ID_RE.test(deviceId)) {
    logErr(`[bridge] 拒绝节点身份：非法 deviceId=${JSON.stringify(deviceId)}`);
    node.retired = true;
    if (node.sock && !node.sock.destroyed) node.sock.destroy();
    return false;
  }
  if (node.deviceId && node.deviceId !== deviceId) {
    logErr(`[bridge] 拒绝节点改名：${node.deviceId} -> ${deviceId}`);
    node.retired = true;
    if (node.sock && !node.sock.destroyed) node.sock.destroy();
    return false;
  }

  const previous = activeNodes.get(deviceId);
  if (previous && previous !== node) {
    // 配置端点是该 deviceId 的权威来源，拒绝一切抢占：
    // 退休是终态，被入站连接挤掉就再也回不来。
    if (previous.kind === 'endpoint') {
      logErr(`[bridge] 拒绝节点抢占配置端点身份：${deviceId}（权威端点 ${previous.endpoint} 保持不变）`);
      node.failures = (node.failures || 0) + 1;   // 端点被拒时退避增长，避免 3 秒互抢
      retireNode(node, 'claim-rejected');
      return false;
    }
    // 属主是入站节点：新连接接管旧连接，被替换的实例退休，不影响任何端点管理器。
    previous.retired = true;
    activeNodes.set(deviceId, node);
    log(`[bridge] 节点 ${deviceId} 新连接接管，关闭旧连接 ${previous.endpoint}`);
    if (previous.sock && !previous.sock.destroyed) previous.sock.destroy();
  } else {
    activeNodes.set(deviceId, node);
  }
  node.deviceId = deviceId;
  node.failures = 0;                                   // 成功绑定才算一次成功会话
  if (node.sock) node.sock._boundDeviceId = deviceId;   // 逐 socket 记录绑定，供 close 精确解绑
  return activeNodes.get(deviceId) === node && !node.retired;
}

/** 只允许"当前活动实例"删除自己的映射；deviceId 由调用方按 socket 传入，
 * 因此旧连接的迟到 close 不可能误删新连接的映射。 */
function unbindNode(node, deviceId) {
  const id = deviceId || node.deviceId;
  if (id && activeNodes.get(id) === node) {
    activeNodes.delete(id);
  }
}

/** 统一处理一条节点状态行：按 deviceId 发布主题。
 * 主动拉取的板端节点已经能被本机 APP 直接看到，不能再 relay 回同一节点；
 * 只有从监听端口接入的无线节点才需要注入板端 APP。 */
const lastStatusByDevice = new Map();   // deviceId -> { obj, line }：MQTT 断线重放用
function publishStatus(obj, line, shouldRelay) {
  const dev = obj.deviceId;
  if (!dev) return;
  lastStatusByDevice.set(dev, { obj, line });
  mqtt.publish(`home/${dev}/status`, obj, true);
  const c = obj.sensors && obj.sensors.motion ? obj.sensors.motion.countToday : '-';
  log(`[bridge] → home/${dev}/status  state=${obj.state} room=${obj.room || '-'} countToday=${c}`);
  try { fs.writeFileSync(STATUS_FILE, line); } catch (e) { /* 忽略 */ }
  // 求助编排：只有来源设备进入 MANUAL_SOS 才逐台定向播报，见 sosFanoutObserve
  sosFanoutObserve(dev, obj);
  if (shouldRelay) relayLine(line, dev);
}

/* ---- 转发通道：把其他节点的状态注入板的 homemon（relay 命令） ----
   APP 在板子上、只能连本机端口；无线节点在 WiFi 侧、只能连到 PC。
   桥接做中间人把两者接上，APP 里就能看到全部房间。 */
let relaySock = null;
let relayFailures = 0;
const RELAY_RECONNECT_BASE_MS = 3000;
const RELAY_RECONNECT_MAX_MS = 30000;
const relayLatestLines = new Map();   // deviceId -> 最近一次入站状态行（relay 恢复后补发）
let lastRelayDropLogAt = 0;

/** relay 重连退避：3s->6s->12s->24s，封顶 30s（与端点管理器同一口径，不永久停止重试）。 */
function relayReconnectDelay() {
  const n = Math.min(Math.max(relayFailures - 1, 0), 4);
  return Math.min(RELAY_RECONNECT_MAX_MS, RELAY_RECONNECT_BASE_MS * Math.pow(2, n));
}

/** 把一条 relay 行真正写进 homemon 通道，并登记"本机注入"用于回灌抑制。 */
function injectRelayLine(line) {
  if (!relaySock || relaySock.destroyed || !relaySock.writable) return false;
  const now = Date.now();
  recentRelays.set(line, now);
  for (const [k, ts] of recentRelays) {
    if (now - ts > RECENT_RELAY_TTL_MS) recentRelays.delete(k);
  }
  relaySock.write(`relay ${line}\n`);
  return true;
}

/** relay 通道恢复后补发每台在线入站设备的最后状态：
 * homemon/板端重启或 hdc fport 断开期间采集到的状态不会丢，DAYU 不必等下一次上报。
 * 已断开的设备在 close 时会被移出缓存，因此不会补发"假在线"的旧状态。 */
function flushRelayLatest() {
  if (!relaySock || relaySock.destroyed || !relaySock.writable) return 0;
  let sent = 0;
  for (const [, line] of relayLatestLines) {
    if (injectRelayLine(line)) sent += 1;
  }
  if (sent > 0) log(`[bridge] relay 通道已恢复：补发 ${sent} 台入站设备的最后状态（只补最新一条，不重复告警）`);
  return sent;
}

function relayConnect() {
  if (!RELAY_TO) return;
  const [rh, rp] = RELAY_TO.split(':');
  const s = net.createConnection({ host: rh, port: parseInt(rp || '9000', 10) }, () => {
    relayFailures = 0;
    log(`[bridge] 已连接转发目标 ${RELAY_TO}`);
    flushRelayLatest();
  });
  relaySock = s;
  // 半开 TCP 检测：板端 homemon 重启或 hdc fport 掉了，对端可能不发 FIN，
  // 没有 keepalive 就永远等不到 close，relay 会永久假死，DAYU 看不到无线房间。
  // 10s 空闲探测，配合有界退避重连。
  s.setKeepAlive(true, 10000);
  s.setNoDelay(true);
  let acc = '';
  s.on('data', (d) => {
    // homemon 会把板上状态（含我们注入的 relay 行）再广播回来，一律忽略防回灌；
    // 这里只处理 APP 经 homemon 转发的路由行： route <deviceId> <原命令>
    acc += d.toString('utf8');
    if (acc.length > 65536) acc = acc.slice(-4096);      // 异常超长无换行：防内存膨胀
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i).replace(/\r$/, '');
      acc = acc.slice(i + 1);
      handleRouteLine(line);
    }
  });
  s.on('close', () => {
    if (relaySock !== s) return;      // 迟到的旧 socket close：不得再排一次重连（避免重复连接）
    relaySock = null;
    relayFailures += 1;
    const delay = relayReconnectDelay();
    log(`[bridge] 转发目标断开（连续失败 ${relayFailures} 次），${delay} 毫秒后重连`);
    setTimeout(relayConnect, delay);
  });
  s.on('error', (e) => { logErr(`[bridge] 转发目标错误: ${e && e.message ? e.message : e}`); });
}

/** 解析 homemon 转发来的 route 行；非 route 行（状态 JSON 等）静默忽略 */
function handleRouteLine(line) {
  const m = /^route(?:[ \t]+(\S*))?(?:[ \t]+(.*))?$/.exec(line.trim());
  if (!m) return false;
  const target = m[1] || '';
  const cmd = (m[2] || '').trim();
  if (!target || !cmd) {
    logErr(`[bridge] 拒绝路由：目标或命令为空: ${line.slice(0, 120)}`);
    return false;
  }
  if (/^(route|relay)(\s|$)/.test(cmd)) {
    logErr(`[bridge] 拒绝路由：禁止嵌套 route/relay: ${line.slice(0, 120)}`);
    return false;
  }
  if (!routeCommand(target, cmd + '\n')) {
    logErr(`[bridge] 拒绝路由：设备 ${target} 不在线或未知，命令已丢弃: ${cmd}`);
    return false;
  }
  return true;
}

/* ---- relay 回灌识别 ----
 * 桥接把 ESP32 状态用 `relay <json>` 注入板端 homemon，homemon 会把这条 JSON 原样
 * 广播给所有客户端，于是桥自己的"板端 status 连接"也会收到一份。不识别就会出事：
 * 该连接先被当成"改名"而退休（板端失联），重连后又会冒领 esp32 的 deviceId、
 * 抢占真实连接并重复发布。所以凡"自己刚注入过的行"和"已被入站节点持有的 deviceId"
 * 都要忽略：回灌只供板端展示，不能在板端连接上再认一次身份。
 */
const RECENT_RELAY_TTL_MS = 10000;
const recentRelays = new Map();      // line -> injectedAt
let lastEchoLogAt = 0;

function relayLine(line, deviceId) {
  // 入站设备：缓存最后状态，relay 通道恢复后补发；配置端点（板端自己）不注入。
  if (deviceId) relayLatestLines.set(deviceId, line);
  if (injectRelayLine(line)) return;
  // relay 断开期间不静默丢状态，缓存最新一条，恢复后补发（见 flushRelayLatest）。
  const now = Date.now();
  if (now - lastRelayDropLogAt >= 5000) {
    lastRelayDropLogAt = now;
    logErr(`[bridge] relay 通道未连接，状态已缓存待恢复后补发（deviceId=${deviceId || '-'}）`);
  }
}

/** 这条状态行是否本桥接自己注入后被 homemon 广播回来的回灌？
 * 两个判据：① 与最近注入的行逐字节相同；② 该 deviceId 当前由入站节点持有（板端连接不该冒领）。 */
function isOwnRelayEcho(line, deviceId) {
  const injectedAt = recentRelays.get(line);
  if (injectedAt !== undefined && Date.now() - injectedAt <= RECENT_RELAY_TTL_MS) return true;
  const owner = activeNodes.get(deviceId);
  return Boolean(owner && owner.kind === 'inbound');
}

function logRelayEcho(deviceId) {
  const now = Date.now();
  if (now - lastEchoLogAt < 5000) return;   // 限频：回灌每 5 秒最多记一条
  lastEchoLogAt = now;
  log(`[bridge] 忽略板端连接上的 relay 回灌：${deviceId}（该 ID 由入站节点持有/刚被本机注入，不在此重复发布）`);
}

/* --relay-ignore 命中日志（限频，避免第三方注入每几秒一条刷屏） */
let lastRelayIgnoreLogAt = 0;
function logRelayIgnore(deviceId) {
  const now = Date.now();
  if (now - lastRelayIgnoreLogAt < 5000) return;
  lastRelayIgnoreLogAt = now;
  log(`[bridge] 忽略板端连接上的 --relay-ignore 设备回灌：${deviceId}（由板外链路直接注入 homemon，桥接不接管、不退休板端连接）`);
}

function routeCommand(deviceId, cmd) {
  const node = activeNodes.get(deviceId);
  if (node && !node.retired && node.sock && !node.sock.destroyed && node.sock.writable) {
    node.sock.write(cmd);
    log(`[bridge] 命令已写入节点 ${deviceId} 的活动连接: ${cmd.trim()}`);
    return true;
  }
  return false;
}

/* 求助事件定向播报，规则见文件头的 --sos-source 说明 */
function sosLogRecord(record) {
  if (!SOS_LOG) return;
  try {
    fs.appendFileSync(SOS_LOG, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) { /* 证据日志失败不得影响监护链路 */ }
}

function sosAlarmId(obj) {
  const a = obj && obj.alarm;
  if (!a || typeof a.id !== 'string' || a.id.length === 0) return '';
  if (a.id.length > 32 || !/^[A-Za-z0-9._-]+$/.test(a.id)) return '';
  return a.id;
}

/** 观察一条已通过校验的来源状态：进入 MANUAL_SOS/ALARM 就派发一次，进入 ACKED 就收口一次。 */
function sosFanoutObserve(deviceId, obj) {
  if (SOS_SOURCE === '' || deviceId !== SOS_SOURCE) return;
  if (!obj || typeof obj !== 'object') return;
  const id = sosAlarmId(obj);
  if (!id) return;
  const type = obj.alarm.type;

  if (obj.state === 'ALARM' && type === 'MANUAL_SOS') {
    const existing = sosDispatched.get(id);
    if (existing) {
      log(`[bridge] 求助播报已派发过，本轮不重复发（alarmId=${id}，重试/重连/重复上报均不新建）`);
      return;
    }
    const record = { at: new Date().toISOString(), event: 'dispatch', alarmId: id, source: deviceId, targets: {} };
    for (const target of SOS_TARGETS) {
      if (target === deviceId) continue;                 // 绝不把来源设备再当目标
      const ok = routeCommand(target, `notice ${id} ${deviceId}\n`);
      record.targets[target] = ok ? 'delivered' : 'failed_offline';
      log(`[bridge] 求助定向播报 target=${target} alarmId=${id} source=${deviceId} → ${record.targets[target]}`);
    }
    sosDispatched.set(id, { alarmId: id, source: deviceId, targets: record.targets, ackSent: false });
    if (sosDispatched.size > SOS_DISPATCH_MAX) {
      const oldest = sosDispatched.keys().next().value;
      sosDispatched.delete(oldest);
    }
    sosLogRecord(record);
    return;
  }

  if (obj.state === 'ACKED') {
    const record = sosDispatched.get(id);
    if (!record || record.ackSent) return;
    record.ackSent = true;
    const out = { at: new Date().toISOString(), event: 'ack', alarmId: id, source: deviceId, targets: {} };
    for (const target of SOS_TARGETS) {
      if (!record.targets || record.targets[target] !== 'delivered') {
        out.targets[target] = 'skipped_not_playing';
        log(`[bridge] 求助播报收口 target=${target} alarmId=${id} → 派发时未送达，跳过（无声音可停）`);
        continue;
      }
      const ok = routeCommand(target, `noticeack ${id}\n`);
      out.targets[target] = ok ? 'delivered' : 'failed_offline';
      log(`[bridge] 求助播报收口 target=${target} alarmId=${id} → ${out.targets[target]}`);
    }
    sosLogRecord(out);
  }
}

/* ---- 单实例锁 ----
 * 锁文件内容只有 PID；陈旧锁（PID 已退出）自动接管，不用人工删。
 * 只清理自己持有的锁，别的活动实例不动。 */
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

function readPidFile(file) {
  try {
    const v = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isSafeInteger(v) && v > 0 ? v : 0;
  } catch (e) {
    return 0;
  }
}

function tryCreateLockFile(file, pid) {
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  fs.writeFileSync(fd, String(pid), 'utf8');
  fs.closeSync(fd);
}

function acquireInstanceLock(file, pid) {
  try {
    tryCreateLockFile(file, pid);
    return { ok: true, stalePid: 0, holderPid: pid };
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
  }
  const oldPid = readPidFile(file);
  if (oldPid > 0 && pidAlive(oldPid)) return { ok: false, stalePid: 0, holderPid: oldPid };
  try { fs.unlinkSync(file); } catch (e) { /* 继续尝试重建 */ }
  try {
    tryCreateLockFile(file, pid);
    return { ok: true, stalePid: oldPid, holderPid: pid };
  } catch (e) {
    const holder = readPidFile(file);
    return { ok: false, stalePid: oldPid, holderPid: holder || oldPid };
  }
}

function releaseInstanceLock(file) {
  try {
    if (readPidFile(file) === process.pid) fs.unlinkSync(file);
  } catch (e) { /* ignore */ }
}

let mqtt = null;
if (require.main === module) {
  if (LOCK_FILE) {
    const lock = acquireInstanceLock(LOCK_FILE, process.pid);
    if (!lock.ok) {
      logErr(`[bridge] 已有 Bridge 实例在运行（PID=${lock.holderPid}，锁文件 ${LOCK_FILE}），本实例退出以避免重复发布`);
      process.exit(3);
    }
    if (lock.stalePid > 0) log(`[bridge] 接管陈旧实例锁（原 PID=${lock.stalePid} 已退出）`);
    log(`[bridge] 单实例锁已获取：${LOCK_FILE}`);
    process.on('exit', () => releaseInstanceLock(LOCK_FILE));
  }
  mqtt = new MqttClient(BROKER_HOST, BROKER_PORT,
  `bridge-${DEVICE}-${Date.now() % 100000}`,
  (topic, payload) => {
    const m = /^home\/([^/]+)\/cmd$/.exec(topic);
    const deviceId = m ? m[1] : '';
    let cmd = null;
    try {
      const o = JSON.parse(payload);
      if (o.cmd === 'ack') cmd = `ack ${o.alarmId || ''} ${o.action || '已确认，老人一切正常'}\n`;
      else if (o.cmd === 'reset') cmd = 'reset\n';
      else if (o.cmd === 'motion') cmd = 'motion\n';
      else if (o.cmd === 'sos') cmd = 'sos\n';
      else if (o.cmd === 'gas') cmd = 'gas\n';
      else if (o.cmd === 'smoke') cmd = 'smoke\n';
      else if (o.cmd === 'fall') {
        // evidenceId 只是关联键，权威 alarmId 仍由网关生成。绝不把 MQTT 里的任意文本
        // 拼进行协议；老发送方可以不传，但传了非法值就拒绝，免得出现追不回的 FALL 告警。
        if (o.evidenceId === undefined || o.evidenceId === '') {
          cmd = 'fall\n';
        } else if (typeof o.evidenceId === 'string' &&
                   /^fall-[0-9]{1,16}-(?:na|[0-9]{1,12})$/.test(o.evidenceId)) {
          cmd = `fall ${o.evidenceId}\n`;
        } else {
          logErr('[bridge] 拒绝 fall 命令：evidenceId 非法:', payload);
        }
      }
      else if (o.cmd === 'monitor') {
        // PC 侧监护失联/恢复通知：state 和 reason 都走白名单，不把 JSON 文本拼进命令。
        const state = (o.state === 'online' || o.state === 'offline') ? o.state : '';
        if (!state) {
          logErr('[bridge] 拒绝 monitor 命令：state 非法:', payload);
        } else {
          const reason = (typeof o.reason === 'string' && /^[a-z_]{1,16}$/.test(o.reason))
            ? o.reason : 'unknown';
          cmd = `monitor ${state} ${reason}\n`;
        }
      }
    } catch (e) {
      logErr('[bridge] 无法解析下行命令:', payload);
    }
    if (!cmd) return;
    if (!routeCommand(deviceId, cmd)) {
      // 只要配了 TCP 端点或监听端口，命令就必须落到具体节点：找不到就丢弃并报警，
      // 不写公共兜底文件，否则发给"离线卧室"的命令可能被客厅执行。
      // 只有纯文件模式（一个节点都没配）才走 CMD_OUT。
      const fileModeOnly = (ENDPOINTS.length === 0 && LISTEN_PORT <= 0);
      if (fileModeOnly) {
        fs.appendFileSync(CMD_OUT, cmd);
        log(`[bridge] 文件模式：命令写入 ${CMD_OUT}: ${cmd.trim()}`);
      } else {
        logErr(`[bridge] 拒绝下发：设备 ${deviceId} 不在线（当前在线 ${activeNodes.size} 个），` +
                      `命令已丢弃以免发错设备: ${cmd.trim()}`);
      }
    }
  },
  // MQTT 重连后把每台设备最后状态重放一次。自包含 broker 不实现 retain，
  // 少了这一步，broker 重启/闪断后云端和 APP 会一直停在旧值。
  ({ reconnected }) => {
    if (!reconnected || lastStatusByDevice.size === 0) return;
    for (const [dev, entry] of lastStatusByDevice) {
      if (mqtt.publish(`home/${dev}/status`, entry.obj, true)) {
        log(`[bridge] MQTT 重连后重放最后状态：${dev}`);
      }
    }
  }).connect();

function attachNode(endpoint) {
  const [th, tp] = endpoint.split(':');
  const node = {
    endpoint, kind: 'endpoint', sock: null, deviceId: '', acc: '',
    retired: false, failures: 0, reconnectTimer: null
  };
  nodes.push(node);

  // 端点连接管理器：实例被 retire、被拒、socket 迟到关闭，都只按退避排下一次重连。
  // retired 只针对这一条 socket，不终止端点自愈。
  const scheduleReconnect = () => {
    if (node.reconnectTimer) return;
    const delay = endpointReconnectDelay(node.failures);
    log(`[bridge] 节点 ${endpoint} ${delay} 毫秒后重连（连续失败 ${node.failures} 次）`);
    node.reconnectTimer = setTimeout(() => { node.reconnectTimer = null; connectTcp(); }, delay);
  };

  const connectTcp = () => {
    node.deviceId = '';
    node.acc = '';
    node.retired = false;
    const s = net.createConnection({ host: th, port: parseInt(tp || '9000', 10) }, () => {
      log(`[bridge] 已接入节点 ${endpoint}`);
    });
    s.setKeepAlive(true, 10000);
    node.sock = s;
    s.on('data', (d) => {
      if (node.sock !== s || node.retired) return;
      if (!appendNodeData(node, d)) return;
      let i;
      while ((i = node.acc.indexOf('\n')) >= 0) {
        const line = node.acc.slice(0, i).trim();
        node.acc = node.acc.slice(i + 1);
        if (!line) continue;
        if (/^route\s/.test(line)) continue;   // homemon 广播的路由行只由 relay 通道处理，这里忽略防重复下发
        try {
          const obj = JSON.parse(line);
          const deviceId = obj.deviceId || endpoint;
          // 板端连接只对"它自己的 deviceId"负责：本机注入后被 homemon 广播回来的其他
          // 节点状态一律跳过，否则会先被当成改名退休，重连后再冒领 ESP32 身份。
          if (RELAY_IGNORE.has(deviceId)) { logRelayIgnore(deviceId); continue; }
          if (isOwnRelayEcho(line, deviceId)) { logRelayEcho(deviceId); continue; }
          if (bindNode(node, deviceId)) publishStatus(obj, line, false);
        } catch (e) {
          logErr('[bridge] 状态行解析失败:', line.slice(0, 80));
        }
      }
    });
    s.on('close', () => {
      if (node.sock !== s) {
        log(`[bridge] 节点 ${endpoint} 旧连接关闭（已被新连接取代），忽略`);
        return;                                 // 迟到 close：不解绑、不再排重连，避免误删新映射
      }
      node.sock = null;
      unbindNode(node, s._boundDeviceId);       // 只解绑这条 socket 真正绑过的 deviceId
      node.failures += 1;
      scheduleReconnect();                      // 配置端点永远自愈：retired 不再终止重连
    });
    s.on('error', (e) => logErr(`[bridge] 节点 ${node.endpoint} 错误:`, e.message));
  };
  connectTcp();
}

log('=== mqtt_bridge 启动 ===');
log('  自动恢复  : MQTT/relay 断线自动重连；恢复后补发最后状态；relay keepalive 10s；日志带 ISO 时间戳');
log(`  Broker    : ${BROKER_HOST}:${BROKER_PORT}`);
log('  上行主题  : home/<deviceId>/status   （设备编号由报文决定）');
log('  下行主题  : home/<deviceId>/cmd      （按编号路由到对应节点）');
log(`  命令兜底  : ${CMD_OUT}`);
if (SOS_SOURCE !== '' && SOS_TARGETS.length > 0) {
  log(`  求助播报  : source=${SOS_SOURCE} targets=${SOS_TARGETS.join(',')}` +
              `（受控逐台路由，同一 alarmId 只派发一次，无 MQTT 广播）`);
} else {
  log('  求助播报  : 关闭（未提供 --sos-source / --sos-targets）');
}
if (RELAY_IGNORE.size > 0) {
  log(`  relay忽略 : ${Array.from(RELAY_IGNORE).join(',')}（板端连接上该 deviceId 的回灌只忽略：不改名、不发布、不退休）`);
}

if (ENDPOINTS.length > 0) {
  log(`  节点数    : ${ENDPOINTS.length}（${ENDPOINTS.join(' , ')}）`);
  ENDPOINTS.forEach((ep) => attachNode(ep));
} else if (LISTEN_PORT <= 0) {
  log(`  状态来源  : ${STATUS_FILE}（文件模式，每 ${INTERVAL} ms 检查一次）`);
  let lastPublished = '';
  setInterval(() => {
    let raw = null;
    try { raw = fs.readFileSync(STATUS_FILE, 'utf8').trim(); } catch (e) { /* 文件还没生成 */ }
    if (raw && raw !== lastPublished) {
      lastPublished = raw;
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { return; }
      const dev = obj.deviceId || DEVICE;
      if (mqtt.publish(`home/${dev}/status`, obj, true)) {
        log(`[bridge] → home/${dev}/status  state=${obj.state}（文件模式）`);
      }
    }
  }, INTERVAL);
}

/* 监听模式：无线节点（ESP32-S3 等）主动连上来推 JSON 行。
   节点说的是与 homemon 完全相同的协议，因此桥接/APP 零改动即可接住。 */
if (LISTEN_PORT > 0) {
  log(`  监听端口  : ${LISTEN_PORT}（等待无线节点接入）`);
}
if (RELAY_TO) {
  log(`  转发目标  : ${RELAY_TO}（其他节点状态注入板上应用）`);
  relayConnect();
}
if (LISTEN_PORT > 0) {
  let lastProbeLogAt = 0;
  const srv = net.createServer((sock) => {
    // 收到 TCP 连接不等于无线节点接入：本机健康探针（demo-autostart 的 Test-Tcp、
    // supervisor 预检、任意 nc）连上 9101 就断。只有收到合法状态行并绑上 deviceId
    // 才记一次真正接入，否则日志里的故障时间轴全是噪声。
    // 入站节点生命周期跟随 socket，同 ID 新连接接管旧连接；但抢不走配置端点已持有
    // 的 deviceId（bindNode 会拒绝并关掉本条连接）。
    const node = {
      endpoint: `listen:${sock.remotePort}`, kind: 'inbound', sock, deviceId: '', acc: '',
      retired: false, failures: 0, reconnectTimer: null
    };
    nodes.push(node);
    sock.setKeepAlive(true, 10000);
    sock.on('data', (d) => {
      if (node.retired || node.sock !== sock) return;
      if (!appendNodeData(node, d)) return;
      let i;
      while ((i = node.acc.indexOf('\n')) >= 0) {
        const line = node.acc.slice(0, i).trim();
        node.acc = node.acc.slice(i + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const deviceId = obj.deviceId || node.deviceId;
          const firstBind = !node.deviceId;
          if (bindNode(node, deviceId)) {
            if (firstBind) {
              log(`[bridge] 无线节点接入并完成身份绑定：${deviceId}（来源 ${sock.remoteAddress}:${sock.remotePort}）`);
            }
            publishStatus(obj, line, true);
          }
        } catch (e) {
          logErr('[bridge] 无线节点报文解析失败:', line.slice(0, 80));
        }
      }
    });
    sock.on('close', () => {
      unbindNode(node, sock._boundDeviceId);   // 只解绑这条 socket 真正绑过的 deviceId
      if (sock._boundDeviceId) {
        // 设备真的断开就清掉它的 relay 缓存，否则 relay/homemon 恢复补发时会把断开前的
        // 旧状态注入板端，DAYU 会显示"仍然在线"的假证据。
        relayLatestLines.delete(sock._boundDeviceId);
        log(`[bridge] 无线节点 ${node.deviceId || node.endpoint} 断开`);
      } else {
        const nowMs = Date.now();
        if (nowMs - lastProbeLogAt >= 60000) {
          lastProbeLogAt = nowMs;
          log(`[bridge] 忽略未识别的探测连接（${sock.remoteAddress}:${sock.remotePort}，未发送状态行；不计为节点接入）`);
        }
      }
      const idx = nodes.indexOf(node);
      if (idx >= 0) nodes.splice(idx, 1);
    });
    sock.on('error', () => { /* 忽略 */ });
  });
  srv.listen(LISTEN_PORT, () => {
    log(`  监听端口  : ${LISTEN_PORT}（等待无线节点接入）`);
  });
}

setInterval(() => mqtt.ping(), 20000);
}
module.exports = {
  MqttClient,
  pidAlive,
  readPidFile,
  acquireInstanceLock,
  releaseInstanceLock,
  endpointReconnectDelay,
  relayReconnectDelay
};
