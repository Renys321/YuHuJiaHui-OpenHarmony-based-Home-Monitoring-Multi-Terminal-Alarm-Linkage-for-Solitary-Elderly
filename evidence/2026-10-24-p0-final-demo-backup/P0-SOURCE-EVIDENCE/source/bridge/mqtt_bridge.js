#!/usr/bin/env node
/**
 * mqtt_bridge.js — 南向守护进程 homemon ↔ 物联网云平台(MQTT) ↔ 监护人 APP 的桥接
 *
 * 赛题依据：
 *   「基于物联网云平台进行设备管理，以开源鸿蒙 APP 为控制端」
 *   「创新拓展：预警信息同步推送至子女、社区网格员、物业值班人员等多台手机」
 *
 * 多节点支持（2026-10-09 新增）：
 *   --status-tcp 可传**多个**端点（逗号分隔），一个桥接进程同时接入多个房间节点；
 *   设备编号由**报文自身的 deviceId 字段**决定，自动发布到 home/<deviceId>/status，
 *   因此新增节点（ESP32-S3 / 另一块板子 / 同板多实例）**无需改动本文件**。
 *
 * 特点：**零第三方依赖**（手写 MQTT 3.1.1 客户端），Node.js 内置模块即可运行。
 *
 * 用法：
 *   # 单节点
 *   node mqtt_bridge.js --broker 127.0.0.1:1883 --status-tcp 127.0.0.1:9000
 *   # 多节点（客厅 / 卧室 / 卫生间）
 *   node mqtt_bridge.js --broker 127.0.0.1:1883 \
 *        --status-tcp 127.0.0.1:9000,127.0.0.1:9001,127.0.0.1:9002 --cmd-out control
 *
 * 主题：
 *   上行  home/<deviceId>/status     设备状态 JSON（competition/README.md §3.1）
 *   下行  home/<deviceId>/cmd        云端/APP 下发命令（3.2），按 deviceId 路由到对应节点
 */
'use strict';

const net = require('net');
const fs = require('fs');

/* ------------------------------------------------------------------ 参数 */
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

/* ------------------------------------------------- MQTT 3.1.1 协议编解码 */
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
  constructor(host, port, clientId, onMessage) {
    this.host = host; this.port = port; this.clientId = clientId;
    this.onMessage = onMessage;
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
      console.error('[MQTT] 连接错误:', e.message);
      this.connected = false;
      this.scheduleReconnect();          // 网络闪断后自动恢复，无需人工重启
    });
    this.sock.on('close', () => {
      this.connected = false;
      console.log('[MQTT] 连接关闭，3 秒后自动重连');
      this.scheduleReconnect();
    });
    return this;
  }

  /** 断线重连（带防抖，避免 error/close 双触发建两条连接） */
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log(`[MQTT] 正在重连 ${this.host}:${this.port} …`);
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
        this.connected = true;
        console.log(`[MQTT] 已连接 ${this.host}:${this.port}（clientId=${this.clientId}）`);
        this.subscribe('home/+/cmd');
      } else {
        console.error('[MQTT] CONNACK 失败 rc=', rc);
      }
    } else if (type === 3) {
      /* MQTT 3.1.1 PUBLISH variable header order:
         Topic Name Length (2) -> Topic Name -> [Packet Identifier (2) for QoS>0] -> Payload.
         Parse topic first, then the QoS1 Packet Identifier. */
      const qos = (flags >> 1) & 0x03;
      if (qos !== 0 && qos !== 1) {
        console.error(`[MQTT] PUBLISH 拒绝 code=UNSUPPORTED_QOS qos=${qos}`);
        return;
      }
      if (body.length < 2) {
        console.error('[MQTT] PUBLISH 拒绝 code=TRUNCATED_TOPIC_LENGTH');
        return;
      }
      const tlen = body.readUInt16BE(0);
      if (tlen === 0 || body.length < 2 + tlen) {
        console.error('[MQTT] PUBLISH 拒绝 code=INVALID_TOPIC_LENGTH');
        return;
      }
      const topic = body.slice(2, 2 + tlen).toString('utf8');
      let offset = 2 + tlen;
      let packetId = 0;
      if (qos === 1) {
        if (body.length < offset + 2) {
          console.error('[MQTT] PUBLISH 拒绝 code=MISSING_PACKET_ID');
          return;
        }
        packetId = body.readUInt16BE(offset);
        if (packetId === 0) {
          console.error('[MQTT] PUBLISH 拒绝 code=ZERO_PACKET_ID');
          return;
        }
        offset += 2;
      }
      const payload = body.slice(offset).toString('utf8');
      if (qos === 1) this._puback(packetId);
      console.log(`[MQTT] ← ${topic}: ${payload}`);
      if (this.onMessage) this.onMessage(topic, payload);
    } else if (type === 9) {
      console.log('[MQTT] 订阅成功: home/+/cmd');
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

/* --------------------------------------------------------- 节点连接管理 */
/* 两类节点，生命周期完全不同（2026-10-15 修复"同 ID 抢占导致板端永久失联"）：
 *   kind='endpoint' —— --status-tcp 配置的主动端点（HDC fport → 板端 homemon）。
 *       由连接管理器负责；断线后**永远**安排下一次重连。
 *       retired 只表示"这一条 socket 不可再用"，绝不终止端点重连管理器。
 *   kind='inbound'  —— --listen 接受的入站无线节点（ESP32-S3 等）。
 *       生命周期跟随 socket；同 ID 新连接接管旧连接（既有语义，保持兼容）。
 *
 * 同一 deviceId 的确定性优先级（配置端点优先）：
 *   当前属主 | 新申报者 | 结果
 *   端点     | 任意     | 拒绝新申报者；属主不变（端点不会被入站连接永久挤掉）
 *   入站     | 端点     | 端点接管，入站实例退休
 *   入站     | 入站     | 新连接接管旧连接（保持既有行为）
 * 任何时刻一个 deviceId 只有一个活动属主，因此不会出现两份重复状态。
 */
const nodes = [];      // { endpoint, kind, sock, deviceId, acc, retired, failures, reconnectTimer }
const activeNodes = new Map();
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_NODE_BUFFER_CHARS = 65536;
const ENDPOINT_RECONNECT_BASE_MS = 3000;
const ENDPOINT_RECONNECT_MAX_MS = 30000;

/** 端点重连延迟：连续失败指数退避（3s→6s→12s→24s，封顶 30s）。
 *  下限 3s 保证不存在零延迟忙循环；上限 30s 保证不会永久停止重试。 */
function endpointReconnectDelay(failures) {
  const n = Number.isFinite(failures) && failures > 1 ? Math.min(failures - 1, 4) : 0;
  return Math.min(ENDPOINT_RECONNECT_MAX_MS, ENDPOINT_RECONNECT_BASE_MS * Math.pow(2, n));
}

/** 让"这一条连接实例"退休。只影响该实例；配置端点的重连管理器不受影响。 */
function retireNode(node, reason) {
  node.retired = true;
  if (reason) console.error(`[bridge] 节点 ${node.deviceId || node.endpoint} 连接已退休：${reason}`);
  if (node.sock && !node.sock.destroyed) node.sock.destroy();
}

function appendNodeData(node, data) {
  node.acc += data.toString('utf8');
  if (node.acc.length <= MAX_NODE_BUFFER_CHARS) return true;
  console.error(`[bridge] 拒绝节点 ${node.deviceId || node.endpoint}：状态行超过 ${MAX_NODE_BUFFER_CHARS} 字符`);
  node.retired = true;
  node.acc = '';
  if (node.sock && !node.sock.destroyed) node.sock.destroy();
  return false;
}

function bindNode(node, deviceId) {
  if (node.retired) return false;
  if (!DEVICE_ID_RE.test(deviceId)) {
    console.error(`[bridge] 拒绝节点身份：非法 deviceId=${JSON.stringify(deviceId)}`);
    node.retired = true;
    if (node.sock && !node.sock.destroyed) node.sock.destroy();
    return false;
  }
  if (node.deviceId && node.deviceId !== deviceId) {
    console.error(`[bridge] 拒绝节点改名：${node.deviceId} -> ${deviceId}`);
    node.retired = true;
    if (node.sock && !node.sock.destroyed) node.sock.destroy();
    return false;
  }

  const previous = activeNodes.get(deviceId);
  if (previous && previous !== node) {
    /* 配置端点是该 deviceId 的权威来源：拒绝一切抢占。
       这正是 2026-10-15 事故的根因——入站连接可以退休配置端点，而"退休"是终态的。 */
    if (previous.kind === 'endpoint') {
      console.error(`[bridge] 拒绝节点抢占配置端点身份：${deviceId}（权威端点 ${previous.endpoint} 保持不变）`);
      node.failures = (node.failures || 0) + 1;   // 端点被拒时退避增长，避免 3 秒互抢
      retireNode(node, 'claim-rejected');
      return false;
    }
    /* 属主是入站节点：新连接接管（既有语义）。被替换实例退休，但不影响任何端点管理器。 */
    previous.retired = true;
    activeNodes.set(deviceId, node);
    console.log(`[bridge] 节点 ${deviceId} 新连接接管，关闭旧连接 ${previous.endpoint}`);
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
 *  因此旧连接的迟到 close 不可能误删新连接的映射。 */
function unbindNode(node, deviceId) {
  const id = deviceId || node.deviceId;
  if (id && activeNodes.get(id) === node) {
    activeNodes.delete(id);
  }
}

/** 统一处理一条节点状态行：按 deviceId 发布主题。
 *  主动拉取的板端节点已经能被本机 APP 直接看到，不能再 relay 回同一节点；
 *  只有从监听端口接入的无线节点才需要注入板端 APP。 */
function publishStatus(obj, line, shouldRelay) {
  const dev = obj.deviceId;
  if (!dev) return;
  mqtt.publish(`home/${dev}/status`, obj, true);
  const c = obj.sensors && obj.sensors.motion ? obj.sensors.motion.countToday : '-';
  console.log(`[bridge] → home/${dev}/status  state=${obj.state} room=${obj.room || '-'} countToday=${c}`);
  try { fs.writeFileSync(STATUS_FILE, line); } catch (e) { /* 忽略 */ }
  if (shouldRelay) relayLine(line);
}

/* ---- 转发通道：把其他节点的状态注入板的 homemon（用 relay 命令）----
   APP 在板子上、只能连本机端口；无线节点在 WiFi 侧、只能连到 PC。
   桥接作为中间人把两者接上，APP 里就能看到全部房间。 */
let relaySock = null;
function relayConnect() {
  if (!RELAY_TO) return;
  const [rh, rp] = RELAY_TO.split(':');
  const s = net.createConnection({ host: rh, port: parseInt(rp || '9000', 10) }, () => {
    console.log(`[bridge] 已连接转发目标 ${RELAY_TO}`);
  });
  relaySock = s;
  let acc = '';
  s.on('data', (d) => {
    /* homemon 会把板上状态（含我们注入的 relay 行）再广播回来 —— 一律忽略防回灌；
       只处理 APP 经 homemon 转发的目标路由： route <deviceId> <原命令> */
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
    console.log(`[bridge] 转发目标断开，3 秒后重连`);
    relaySock = null;
    setTimeout(relayConnect, 3000);
  });
  s.on('error', () => { /* 忽略，由 close 触发重连 */ });
}

/** 解析 homemon 转发来的 route 行；非 route 行（状态 JSON 等）静默忽略 */
function handleRouteLine(line) {
  const m = /^route(?:[ \t]+(\S*))?(?:[ \t]+(.*))?$/.exec(line.trim());
  if (!m) return false;
  const target = m[1] || '';
  const cmd = (m[2] || '').trim();
  if (!target || !cmd) {
    console.error(`[bridge] 拒绝路由：目标或命令为空: ${line.slice(0, 120)}`);
    return false;
  }
  if (/^(route|relay)(\s|$)/.test(cmd)) {
    console.error(`[bridge] 拒绝路由：禁止嵌套 route/relay: ${line.slice(0, 120)}`);
    return false;
  }
  if (!routeCommand(target, cmd + '\n')) {
    console.error(`[bridge] 拒绝路由：设备 ${target} 不在线或未知，命令已丢弃: ${cmd}`);
    return false;
  }
  return true;
}

/* ---- relay 回灌（relay echo）识别 ----------------------------------------
 * 根因（2026-10-15 事故）：桥接把 ESP32 状态用 `relay <json>` 注入板端 homemon，
 * homemon 会把这条 JSON **原样广播给所有客户端**（让板上 APP 看到其他房间）。
 * 于是桥接自己的"板端 status 连接"也会收到 `{"deviceId":"esp32-bath",...}`：
 *   - 旧代码：该连接已绑定 dayu200-living -> 判定为"改名" -> retired -> 永久不再重连（板端失联）；
 *   - 即使恢复重连：新连接第一条恰是这条回灌 -> 先绑定 esp32-bath（抢占并关闭真实 ESP32 连接、重复发布），
 *     随后又因 dayu200 行触发改名再次退休，形成 3 秒级抖动。
 * 处理：桥接必须忽略"自己刚注入过的 relay 行"以及"已被入站节点持有的 deviceId"，
 * 回灌只用于注入板端，绝不能在板端连接上再冒领身份。
 */
const RECENT_RELAY_TTL_MS = 10000;
const recentRelays = new Map();      // line -> injectedAt
let lastEchoLogAt = 0;

function relayLine(line) {
  if (relaySock && !relaySock.destroyed) {
    const now = Date.now();
    recentRelays.set(line, now);
    for (const [k, ts] of recentRelays) {
      if (now - ts > RECENT_RELAY_TTL_MS) recentRelays.delete(k);
    }
    relaySock.write(`relay ${line}\n`);
  }
}

/** 这条状态行是否本桥接自己注入后被 homemon 广播回来的回灌？
 *  两个判据：① 与最近注入的行逐字节相同；② 该 deviceId 当前由**入站节点**持有（板端连接不该冒领）。 */
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
  console.log(`[bridge] 忽略板端连接上的 relay 回灌：${deviceId}（该 ID 由入站节点持有/刚被本机注入，不在此重复发布）`);
}

function routeCommand(deviceId, cmd) {
  const node = activeNodes.get(deviceId);
  if (node && !node.retired && node.sock && !node.sock.destroyed && node.sock.writable) {
    node.sock.write(cmd);
    console.log(`[bridge] 命令已写入节点 ${deviceId} 的活动连接: ${cmd.trim()}`);
    return true;
  }
  return false;
}

let mqtt = null;
if (require.main === module) {
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
        /* evidenceId is an association key only; the gateway still creates the
           authoritative alarmId.  Never concatenate arbitrary MQTT text into
           the line protocol.  A legacy sender may omit evidenceId, but an
           explicitly supplied invalid value is rejected instead of silently
           creating an untraceable FALL alarm. */
        if (o.evidenceId === undefined || o.evidenceId === '') {
          cmd = 'fall\n';
        } else if (typeof o.evidenceId === 'string' &&
                   /^fall-[0-9]{1,16}-(?:na|[0-9]{1,12})$/.test(o.evidenceId)) {
          cmd = `fall ${o.evidenceId}\n`;
        } else {
          console.error('[bridge] 拒绝 fall 命令：evidenceId 非法:', payload);
        }
      }
      else if (o.cmd === 'monitor') {
        /* PC 侧监护失联/恢复通知：状态与原因都走白名单，
           绝不把 JSON 里的任意字符串拼进节点命令。 */
        const state = (o.state === 'online' || o.state === 'offline') ? o.state : '';
        if (!state) {
          console.error('[bridge] 拒绝 monitor 命令：state 非法:', payload);
        } else {
          const reason = (typeof o.reason === 'string' && /^[a-z_]{1,16}$/.test(o.reason))
            ? o.reason : 'unknown';
          cmd = `monitor ${state} ${reason}\n`;
        }
      }
    } catch (e) {
      console.error('[bridge] 无法解析下行命令:', payload);
    }
    if (!cmd) return;
    if (!routeCommand(deviceId, cmd)) {
      /* ⚠ 只要存在真实节点接入方式（TCP 端点或监听模式），命令就必须落到具体节点；
         找不到即丢弃并报警，绝不写公共兜底文件 —— 否则发给"离线卧室"的命令
         可能被别的节点（如客厅）执行。仅"纯文件模式"（无任何节点）才走文件通道。 */
      const fileModeOnly = (ENDPOINTS.length === 0 && LISTEN_PORT <= 0);
      if (fileModeOnly) {
        fs.appendFileSync(CMD_OUT, cmd);
        console.log(`[bridge] 文件模式：命令写入 ${CMD_OUT}: ${cmd.trim()}`);
      } else {
        console.error(`[bridge] 拒绝下发：设备 ${deviceId} 不在线（当前在线 ${activeNodes.size} 个），` +
                      `命令已丢弃以免发错设备: ${cmd.trim()}`);
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

  /* 端点连接管理器：实例被 retire、被拒绝、或 socket 迟到关闭，都只按退避安排下一次重连。
     retired 只针对"这一条 socket"，绝不终止端点自愈。 */
  const scheduleReconnect = () => {
    if (node.reconnectTimer) return;
    const delay = endpointReconnectDelay(node.failures);
    console.log(`[bridge] 节点 ${endpoint} ${delay} 毫秒后重连（连续失败 ${node.failures} 次）`);
    node.reconnectTimer = setTimeout(() => { node.reconnectTimer = null; connectTcp(); }, delay);
  };

  const connectTcp = () => {
    node.deviceId = '';
    node.acc = '';
    node.retired = false;
    const s = net.createConnection({ host: th, port: parseInt(tp || '9000', 10) }, () => {
      console.log(`[bridge] 已接入节点 ${endpoint}`);
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
          /* 板端连接只对"它自己的 deviceId"负责：忽略本机注入后被 homemon 广播回来的其他节点状态，
             否则会先被误判为改名而退休、重连后再冒领 ESP32 身份（2026-10-15 事故根因）。 */
          if (isOwnRelayEcho(line, deviceId)) { logRelayEcho(deviceId); continue; }
          if (bindNode(node, deviceId)) publishStatus(obj, line, false);
        } catch (e) {
          console.error('[bridge] 状态行解析失败:', line.slice(0, 80));
        }
      }
    });
    s.on('close', () => {
      if (node.sock !== s) {
        console.log(`[bridge] 节点 ${endpoint} 旧连接关闭（已被新连接取代），忽略`);
        return;                                 // 迟到 close：不解绑、不再排重连，避免误删新映射
      }
      node.sock = null;
      unbindNode(node, s._boundDeviceId);       // 只解绑这条 socket 真正绑过的 deviceId
      node.failures += 1;
      scheduleReconnect();                      // 配置端点永远自愈：retired 不再终止重连
    });
    s.on('error', (e) => console.error(`[bridge] 节点 ${node.endpoint} 错误:`, e.message));
  };
  connectTcp();
}

/* ---------------------------------------------------------------- 启动 */
console.log('=== mqtt_bridge 启动 ===');
console.log(`  Broker    : ${BROKER_HOST}:${BROKER_PORT}`);
console.log('  上行主题  : home/<deviceId>/status   （设备编号由报文决定）');
console.log('  下行主题  : home/<deviceId>/cmd      （按编号路由到对应节点）');
console.log(`  命令兜底  : ${CMD_OUT}`);

if (ENDPOINTS.length > 0) {
  console.log(`  节点数    : ${ENDPOINTS.length}（${ENDPOINTS.join(' , ')}）`);
  ENDPOINTS.forEach((ep) => attachNode(ep));
} else if (LISTEN_PORT <= 0) {
  console.log(`  状态来源  : ${STATUS_FILE}（文件模式，每 ${INTERVAL} ms 检查一次）`);
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
        console.log(`[bridge] → home/${dev}/status  state=${obj.state}（文件模式）`);
      }
    }
  }, INTERVAL);
}

/* 监听模式：无线节点（ESP32-S3 等）主动连上来推 JSON 行。
   节点说的是与 homemon 完全相同的协议，因此桥接/APP 零改动即可接住。 */
if (LISTEN_PORT > 0) {
  console.log(`  监听端口  : ${LISTEN_PORT}（等待无线节点接入）`);
}
if (RELAY_TO) {
  console.log(`  转发目标  : ${RELAY_TO}（其他节点状态注入板上应用）`);
  relayConnect();
}
if (LISTEN_PORT > 0) {
  const srv = net.createServer((sock) => {
    console.log(`[bridge] 无线节点接入 ${sock.remoteAddress}:${sock.remotePort}`);
    /* 入站节点：生命周期跟随 socket；同 ID 新连接接管旧连接（既有语义）。
       但入站节点**不能**抢占配置端点已持有的 deviceId（由 bindNode 拒绝并关闭本条连接）。 */
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
          if (bindNode(node, deviceId)) publishStatus(obj, line, true);
        } catch (e) {
          console.error('[bridge] 无线节点报文解析失败:', line.slice(0, 80));
        }
      }
    });
    sock.on('close', () => {
      unbindNode(node, sock._boundDeviceId);   // 只解绑这条 socket 真正绑过的 deviceId
      console.log(`[bridge] 无线节点 ${node.deviceId || node.endpoint} 断开`);
      const idx = nodes.indexOf(node);
      if (idx >= 0) nodes.splice(idx, 1);
    });
    sock.on('error', () => { /* 忽略 */ });
  });
  srv.listen(LISTEN_PORT, () => {
    console.log(`  监听端口  : ${LISTEN_PORT}（等待无线节点接入）`);
  });
}

setInterval(() => mqtt.ping(), 20000);
}
module.exports = { MqttClient };
