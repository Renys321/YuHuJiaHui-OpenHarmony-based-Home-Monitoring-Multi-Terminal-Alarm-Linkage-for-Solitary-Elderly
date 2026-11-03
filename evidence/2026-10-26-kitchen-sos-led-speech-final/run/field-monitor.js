#!/usr/bin/env node
/**
 * field-monitor.js — 厨房/卫生间 SOS·LED·语音·ACK 验收的“只读现场监测器”
 *
 * 设计边界（本工具的安全承诺）：
 *   - 只对 127.0.0.1:1883 发送 CONNECT / SUBSCRIBE / PINGREQ 三种报文；
 *     **绝不 PUBLISH、绝不发 ACK/reset/任何下行命令、绝不重启任何服务。**
 *   - 订阅主题固定为 home/+/status（只收状态），并把原始 JSON 逐行落盘。
 *   - 周期快照 bridge/status.json、supervisor/status.json、public-sync 日志尾部、
 *     demo-autostart watcher-state.json，弥补本项目 broker **不支持 retain** 的缺陷
 *     （新订阅者连上后收不到“最后一条状态”，必须靠文件快照还原）。
 *   - 可选跟随串口采集目录，把关键标记（ACK 回执/PLAY clip/LED 模式/ALARM）抽到
 *     markers.log，便于和 events.csv 时间线对齐。
 *
 * 用法：
 *   node field-monitor.js --explain
 *   node field-monitor.js --selftest
 *   node field-monitor.js --seconds 600
 *   node field-monitor.js --seconds 0 --out-dir .\logs\monitor-manual --serial-dir .\logs\dual-20261026-2105
 *
 * 退出码：0=正常结束；2=参数错误或 MQTT 连接失败；1=运行时错误。
 */
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..'); // competition/
const COMPETITION_DIR = path.basename(DEFAULT_ROOT).toLowerCase() === 'competition'
  ? DEFAULT_ROOT
  : 'D:\\OpenHarmony\\competition';

const DEFAULT_DEVICES = ['esp32-kitchen', 'esp32-bath'];

/** APP ACK 实际下行链路（来自源码核对，2026-10-26）：
 *
 *  A) 手机 APP / 小程序（公网）路径：
 *     APP → POST https://api.luxunacc.xyz/api/v1/alerts/{alarmId}/ack
 *         → backend 命令队列（PENDING）
 *         → 本机 public-sync worker 轮询 GET /internal/v1/commands?after=<cursor>
 *            证据: public-sync-supervisor.log `[command-sync] POLL_OK path=/internal/v1/commands status=200`
 *         → 严格校验后 publish home/<deviceId>/cmd {"cmd":"ack","alarmId":"...","action":"..."}
 *            证据: `[command-sync] ACK_SENT id=<commandId> device=<deviceId>`
 *         → bridge 已订阅 home/+/cmd，转成串口行 `ack <alarmId> <action>\n` 写入节点活动连接
 *            证据: bridge 日志 `[bridge] 命令已写入节点 <deviceId> 的活动连接: ack <alarmId>`
 *         → 节点 handle_command：alarmId 精确匹配才 ACKED、静音、取消语音
 *            证据(串口): `ACK 回执已接受并生效（阶段③...）：id=<alarmId> type=<type> -> state=ACKED...`
 *            证据(串口): `LED 模式=ACKED_CONFIRM_PULSE ...` / `ACKED_RESOLVED_OFF`
 *         → 节点下一条状态上行 → MQTT home/<deviceId>/status state=ACKED, alarm.id=<alarmId>
 *            证据(bridge): `[bridge] → home/<deviceId>/status state=ACKED ...`
 *         → worker observe 到匹配 → POST /internal/v1/commands/<id>/result {status:"ACKED",deviceState}
 *            证据: `[command-sync] ACKED id=<commandId> device=<deviceId>`   ← 云端侧“设备真的 ACK 了”的铁证
 *         → 公网状态入库 202
 *            证据: `[cloud-sync] OK device=<deviceId> ts=... status=202`
 *
 *  B) DAYU 板载 APP 路径（不经过公网 backend）：
 *     DAYU APP 点“确认/ACK” → DAYU homemon（DAYU 9000，经 PC 9001 fport）
 *         → bridge relay 通道收到 `route <deviceId> <cmd>` 行
 *         → routeCommand() 同样把 `ack <alarmId> <action>` 写到节点活动连接
 *            证据: bridge 日志 `[bridge] 命令已写入节点 <deviceId> 的活动连接: ack ...`
 *
 *  证明“某 alarmId 已 ACK 闭环”的最小字段集：
 *    deviceId、alarmId（alarm.id）、alarm.type、state(ALARM→ACKED)、
 *    串口 ACK 回执行、串口 PLAY clip=N 与 LED 模式=...、bridge 命令已写入行、
 *    `[command-sync] ACK_SENT`、`[command-sync] ACKED`、`[cloud-sync] ... status=202`。
 *  注意：APP 的 /ack 接口需要监护人会话，本工具不登录、不带密钥，因此链路证明
 *  只能来自本机 worker/bridge 日志 + 节点串口回执，而不是“APP 截图”。
 */
const ACK_CHAIN_TEXT = `APP ACK 实际链路（只读核对结论）：
  手机 APP/小程序 → POST /api/v1/alerts/{alarmId}/ack → backend 入队 PENDING
   → public-sync worker: GET /internal/v1/commands?after=<cursor>  [command-sync] POLL_OK 200
   → publish home/<deviceId>/cmd {"cmd":"ack","alarmId":...,"action":...}  [command-sync] ACK_SENT
   → bridge(home/+/cmd) → 串口行 "ack <alarmId> <action>\\n"  [bridge] 命令已写入节点 <deviceId> 的活动连接
   → 节点精确匹配 alarmId → state=ACKED + LED ACKED_* + 语音取消  串口 "ACK 回执已接受并生效..."
   → 状态上行 home/<deviceId>/status state=ACKED  [bridge] → home/.../status state=ACKED
   → worker 观测匹配 → POST /internal/v1/commands/<id>/result  [command-sync] ACKED id=... device=...
   → 公网入库 202  [cloud-sync] OK device=... status=202
  DAYU 路径：DAYU APP ACK → homemon(9000，经 9001 fport) → bridge relay "route <deviceId> ack ..." → 同一串口写入。
 必须有：deviceId / alarm.id / alarm.type / state / 串口 ACK 回执 / PLAY clip= / LED 模式= / [command-sync] ACK_SENT 与 ACKED / status=202。`;

// ---------------------------------------------------------------- helpers
function iso() { return new Date().toISOString().replace('Z', '+00:00'); }
function localIso() {
  const d = new Date();
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function encLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
function encStr(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length, 0); return Buffer.concat([l, b]); }
function pkt(type, flags, payload) { return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(payload.length), payload]); }

function buildConnect(clientId, keepaliveSec) {
  const payload = Buffer.concat([encStr('MQTT'), Buffer.from([4, 0x02]), Buffer.from([(keepaliveSec >> 8) & 0xff, keepaliveSec & 0xff]), encStr(clientId)]);
  return pkt(1, 0, payload);
}
function buildSubscribe(packetId, filter) {
  return pkt(8, 0x02, Buffer.concat([Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]), encStr(filter), Buffer.from([0])]));
}
function buildPing() { return pkt(12, 0, Buffer.alloc(0)); }

/** 解析缓冲区里的完整 MQTT 报文；返回 {packets:[{type,flags,body}], rest} */
function parsePackets(buf) {
  const packets = [];
  let i = 0;
  while (i + 1 < buf.length) {
    let mult = 1, len = 0, j = i + 1, ok = false;
    while (j < buf.length) {
      const b = buf[j]; len += (b & 127) * mult; mult *= 128; j++;
      if ((b & 128) === 0) { ok = true; break; }
      if (j - i > 5) break;
    }
    if (!ok) break;
    const total = j + len;
    if (buf.length < total) break;
    packets.push({ type: buf[i] >> 4, flags: buf[i] & 0x0f, body: buf.slice(j, total) });
    i = total;
  }
  return { packets, rest: buf.slice(i) };
}

function parsePublish(body) {
  const tl = body.readUInt16BE(0);
  const topic = body.slice(2, 2 + tl).toString('utf8');
  let off = 2 + tl;
  const qos = 0; // broker 转发固定 QoS0
  let packetId = 0;
  if (qos > 0) { packetId = body.readUInt16BE(off); off += 2; }
  return { topic, payload: body.slice(off).toString('utf8'), packetId };
}

function readLastLines(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - (maxBytes || 65536));
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    return buf.toString('utf8').split('\n').filter((l) => l.length > 0);
  } catch (e) { return []; }
}

function parseArgs(argv) {
  const a = {
    host: '127.0.0.1', port: 1883, seconds: 0, outDir: '',
    root: COMPETITION_DIR, devices: DEFAULT_DEVICES.slice(), snapshotMs: 5000,
    serialDir: '', clientId: 'field-monitor-' + process.pid, explain: false, selftest: false
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const take = () => { const v = argv[++i]; if (v === undefined) throw new Error(`参数 ${k} 缺少取值`); return v; };
    switch (k) {
      case '--host': a.host = take(); break;
      case '--port': a.port = Number(take()); break;
      case '--seconds': a.seconds = Number(take()); break;
      case '--out-dir': a.outDir = take(); break;
      case '--root': a.root = take(); break;
      case '--devices': a.devices = take().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--snapshot-ms': a.snapshotMs = Number(take()); break;
      case '--serial-dir': a.serialDir = take(); break;
      case '--client-id': a.clientId = take(); break;
      case '--explain': a.explain = true; break;
      case '--selftest': a.selftest = true; break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`未知参数 ${k}（用 --help 查看）`);
    }
  }
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) throw new Error('--port 必须是 1..65535 的整数');
  if (!Number.isFinite(a.seconds) || a.seconds < 0) throw new Error('--seconds 必须 >= 0（0=直到 Ctrl+C）');
  if (!Number.isInteger(a.snapshotMs) || a.snapshotMs < 500) throw new Error('--snapshot-ms 必须 >= 500 的整数');
  if (!a.devices.length) throw new Error('--devices 至少一个 deviceId');
  return a;
}

function resolvePaths(a) {
  const comp = a.root;
  const bridgeDir = path.join(comp, 'bridge');
  const supDir = path.join(bridgeDir, '_test', 'current-runtime', 'supervisor');
  return {
    bridgeStatus: path.join(bridgeDir, 'status.json'),
    supervisorStatus: path.join(supDir, 'status.json'),
    supervisorLog: path.join(supDir, 'public-sync-supervisor.log'),
    watcherState: path.join(comp, 'evidence', '2026-10-26-demo-autostart', 'runtime', 'watcher-state.json'),
    bridgeDir
  };
}

// ---------------------------------------------------------------- monitor core
class FieldMonitor {
  constructor(opts) {
    this.opts = opts;
    this.paths = resolvePaths(opts);
    this.writes = [];            // 记录本客户端发出的报文类型（用于自检/审计）
    this.stats = { mqtt: 0, acked: 0, snapshots: 0, markerLines: 0 };
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.files = {};
    this.tailOffsets = new Map();
    this.timers = [];
    this.closed = false;
    this.connected = false;
    this.lastStatus = new Map();
  }

  openLogs() {
    const d = this.opts.outDir;
    fs.mkdirSync(d, { recursive: true });
    const mk = (name) => fs.openSync(path.join(d, name), 'a');
    this.files.mqtt = mk('mqtt-status.log');
    this.files.snap = mk('snapshots.log');
    this.files.ack = mk('ack-events.log');
    this.files.marker = mk('markers.log');
    this.files.summary = mk('summary.txt');
    this.writeLine(this.files.mqtt, `# field-monitor start ${iso()} clientId=${this.opts.clientId} broker=${this.opts.host}:${this.opts.port} READ-ONLY(no publish)`);
    this.writeLine(this.files.summary, `# field-monitor start ${iso()}`);
  }

  writeLine(fd, line) {
    if (fd === undefined) return;
    try { fs.writeSync(fd, line + '\n'); } catch (e) { /* ignore */ }
  }

  start() {
    this.openLogs();
    console.log(`FIELD_MONITOR out=${this.opts.outDir}`);
    console.log(`FIELD_MONITOR broker=${this.opts.host}:${this.opts.port} devices=${this.opts.devices.join(',')} 只读(CONNECT/SUBSCRIBE/PINGREQ)`);
    console.log(ACK_CHAIN_TEXT);
    this.snapshotOnce();
    this.timers.push(setInterval(() => this.snapshotOnce(), this.opts.snapshotMs));
    if (this.opts.serialDir) {
      this.timers.push(setInterval(() => this.tailSerial(), 500));
    }
    if (this.opts.seconds > 0) {
      this.timers.push(setTimeout(() => this.stop('duration'), this.opts.seconds * 1000));
    }
    return this.connect();
  }

  connect() {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      this.sock = sock;
      let gotConnack = false;
      const connackTimer = setTimeout(() => {
        if (!gotConnack) {
          this.writeLine(this.files.snap, `[${localIso()}] MQTT-ERROR no CONNACK within 5s from ${this.opts.host}:${this.opts.port}`);
          this.stop('no-connack');
          resolve(2);
        }
      }, 5000);
      sock.on('connect', () => {
        const c = buildConnect(this.opts.clientId, 60);
        this.writes.push(1);
        sock.write(c);
        this.pingTimer = setInterval(() => { if (!this.closed && sock.writable) { this.writes.push(12); sock.write(buildPing()); } }, 20000);
      });
      sock.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        const { packets, rest } = parsePackets(this.buf);
        this.buf = rest;
        for (const p of packets) {
          if (p.type === 2) {
            gotConnack = true;
            clearTimeout(connackTimer);
            const rc = p.body.length >= 2 ? p.body[1] : 255;
            if (rc !== 0) {
              this.writeLine(this.files.snap, `[${localIso()}] MQTT-ERROR CONNACK rc=${rc}`);
              this.stop('connack-rejected');
              resolve(2);
              return;
            }
            this.connected = true;
            this.writes.push(8);
            sock.write(buildSubscribe(1, 'home/+/status'));
            this.writeLine(this.files.snap, `[${localIso()}] MQTT-CONNECTED broker=${this.opts.host}:${this.opts.port} subscribe=home/+/status`);
            resolve(0);
          } else if (p.type === 9) {
            this.writeLine(this.files.snap, `[${localIso()}] MQTT-SUBACK granted`);
          } else if (p.type === 3) {
            this.onPublish(p.body);
          }
        }
      });
      sock.on('error', (err) => {
        const msg = `[${localIso()}] MQTT-ERROR ${err.code || 'ERROR'} ${err.message}`;
        this.writeLine(this.files.snap, msg);
        console.error(`FIELD_MONITOR 连接失败：${err.code || ''} ${err.message}`);
        if (!gotConnack) {
          clearTimeout(connackTimer);
          console.error('FIELD_MONITOR 提示：本工具不会重启 broker；请检查 1883 是否监听（netstat -ano | findstr :1883）。');
          this.stop('connect-error');
          resolve(2);
        }
      });
      sock.on('close', () => {
        if (!this.closed) {
          this.writeLine(this.files.snap, `[${localIso()}] MQTT-CLOSED by peer`);
        }
      });
    });
  }

  onPublish(body) {
    let pub;
    try { pub = parsePublish(body); } catch (e) {
      this.writeLine(this.files.snap, `[${localIso()}] MQTT-BAD-PUBLISH ${e.message}`);
      return;
    }
    this.stats.mqtt += 1;
    const line = `[${localIso()}] ${pub.topic} ${pub.payload}`;
    this.writeLine(this.files.mqtt, line);
    const m = /^home\/([^/]+)\/status$/.exec(pub.topic);
    if (!m) return;
    const deviceId = m[1];
    if (!this.opts.devices.includes(deviceId)) return;
    let o = null;
    try { o = JSON.parse(pub.payload); } catch (e) { o = null; }
    if (!o) return;
    const prev = this.lastStatus.get(deviceId);
    this.lastStatus.set(deviceId, o);
    const alarmId = o.alarm && o.alarm.id ? o.alarm.id : '';
    const alarmType = o.alarm && o.alarm.type ? o.alarm.type : '';
    if (alarmId !== (prev && prev.alarm && prev.alarm.id ? prev.alarm.id : '')) {
      this.writeLine(this.files.ack, `[${localIso()}] ALARM-ID-OBSERVED deviceId=${deviceId} alarm.id=${alarmId || '(none)'} alarm.type=${alarmType || '(none)'} state=${o.state}`);
    }
    if (o.state === 'ACKED') {
      this.stats.acked += 1;
      this.writeLine(this.files.ack, `[${localIso()}] ACKED-OBSERVED deviceId=${deviceId} alarm.id=${alarmId} alarm.type=${alarmType} state=ACKED ts=${o.ts}`);
      console.log(`FIELD_MONITOR ACKED-OBSERVED deviceId=${deviceId} alarm.id=${alarmId}`);
    }
  }

  snapshotOnce() {
    this.stats.snapshots += 1;
    const ts = localIso();
    const specs = [
      { tag: 'bridge/status.json', file: this.paths.bridgeStatus },
      { tag: 'supervisor/status.json(esp32-bath 旧实例快照)', file: this.paths.supervisorStatus }
    ];
    for (const s of specs) {
      try {
        const st = fs.statSync(s.file);
        const raw = fs.readFileSync(s.file, 'utf8');
        const o = JSON.parse(raw);
        const alarm = o.alarm || {};
        this.writeLine(this.files.snap,
          `[${ts}] SNAP ${s.tag} mtime=${st.mtime.toISOString()} deviceId=${o.deviceId} room=${o.room || ''} state=${o.state} ` +
          `alarm.id=${alarm.id || ''} alarm.type=${alarm.type || ''} alarm.countToday=${alarm.countToday === undefined ? '' : alarm.countToday} device.ts=${o.ts}`);
      } catch (e) {
        this.writeLine(this.files.snap, `[${ts}] SNAP-ERROR ${s.tag} code=${e.code || 'ERROR'} msg=${e.message}`);
      }
    }
    // public-sync 日志尾部：最后一条 202 与最后一条 command-sync
    const lines = readLastLines(this.paths.supervisorLog, 131072);
    if (lines.length === 0) {
      this.writeLine(this.files.snap, `[${ts}] SNAP-ERROR supervisor-log missing/empty ${this.paths.supervisorLog}`);
    } else {
      const perDevice = new Map();
      let lastCmd = '';
      for (const l of lines) {
        const cm = l.match(/\[cloud-sync\] OK device=(\S+) .*status=202/) || l.match(/status=202 .*device=(\S+)/);
        if (l.includes('[cloud-sync] OK') && l.includes('status=202')) {
          const dm = /device=(\S+)/.exec(l);
          if (dm) perDevice.set(dm[1], l);
        }
        if (l.includes('[command-sync]')) lastCmd = l;
      }
      for (const [dev, l] of perDevice) {
        this.writeLine(this.files.snap, `[${ts}] SNAP public-sync-last-202 device=${dev} line=${l.slice(0, 400)}`);
      }
      if (perDevice.size === 0) this.writeLine(this.files.snap, `[${ts}] SNAP-INFO public-sync: no status=202 line in tail窗口`);
      if (lastCmd) this.writeLine(this.files.snap, `[${ts}] SNAP public-sync-last-command line=${lastCmd.slice(0, 400)}`);
    }
    // DAYU 看护状态（fport/相机/推理的旁证）
    try {
      const st = fs.statSync(this.paths.watcherState);
      const o = JSON.parse(fs.readFileSync(this.paths.watcherState, 'utf8'));
      this.writeLine(this.files.snap,
        `[${ts}] SNAP dayu-watcher mtime=${st.mtime.toISOString()} timestamp=${o.timestamp} targetConnected=${o.targetConnected} app=${o.app} inference=${o.inference} cameraFrames=${o.cameraFrames} nodes=${o.nodes} userPaused=${o.userPaused}`);
    } catch (e) { /* 可选文件 */ }
  }

  tailSerial() {
    const dir = this.opts.serialDir;
    if (!dir) return;
    const names = ['bath.log', 'kitchen.log', 'merged.log'];
    for (const name of names) {
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch (e) { continue; }
      const key = file;
      const offset = this.tailOffsets.get(key) || 0;
      if (st.size <= offset) { continue; }
      let buf;
      try {
        buf = Buffer.alloc(st.size - offset);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
      } catch (e) { continue; }
      this.tailOffsets.set(key, st.size);
      const text = buf.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (/已接受并生效|LED 模式=|PLAY clip=|-> ALARM|STOP |ACK 回执|ACK 被拒绝|SOS|state=ACKED/.test(line)) {
          this.stats.markerLines += 1;
          this.writeLine(this.files.marker, `[${localIso()}] [${path.basename(name)}] ${line}`);
        }
      }
    }
  }

  stop(reason) {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    if (this.pingTimer) clearInterval(this.pingTimer);
    try { if (this.sock && this.sock.writable) this.sock.end(); } catch (e) { }
    try { this.sock.destroy(); } catch (e) { }
    const sent = Array.from(new Set(this.writes)).sort((a, b) => a - b);
    const summary = `stop=${iso()} reason=${reason} mqttStatusMsgs=${this.stats.mqtt} ackedObserved=${this.stats.acked} snapshots=${this.stats.snapshots} markerLines=${this.stats.markerLines} packetsSentTypes=[${sent.join(',')}] (1=CONNECT,8=SUBSCRIBE,12=PINGREQ; 3=PUBLISH 绝不应出现) out=${this.opts.outDir}`;
    this.writeLine(this.files.summary, summary);
    this.writeLine(this.files.mqtt, '# ' + summary);
    console.log('FIELD_MONITOR ' + summary);
    for (const k of ['mqtt', 'snap', 'ack', 'marker', 'summary']) {
      if (this.files[k] !== undefined) { try { fs.closeSync(this.files[k]); } catch (e) { } this.files[k] = undefined; }
    }
  }
}

// ---------------------------------------------------------------- selftest
function runSelftest() {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail || '' });
    console.log(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  };

  // 1) 参数解析与错误路径
  const a = parseArgs(['node', 'x', '--seconds', '30', '--devices', 'esp32-kitchen,esp32-bath', '--port', '1883']);
  check('parse-args', a.seconds === 30 && a.devices.length === 2 && a.port === 1883, JSON.stringify(a.devices));
  let bad = 0;
  for (const args of [['--seconds', '-1'], ['--port', '0'], ['--port', '99999'], ['--bogus', 'x'], ['--snapshot-ms', '100'], ['--devices', '']]) {
    try { parseArgs(['node', 'x'].concat(args)); } catch (e) { bad += 1; }
  }
  check('reject-invalid-args', bad === 6, `rejected ${bad}/6`);

  // 2) MQTT 报文编解码
  const c = buildConnect('t', 60);
  check('connect-packet', c[0] === 0x10 && c.slice(4, 8).toString() === 'MQTT', c.slice(0, 8).toString('hex'));
  const s = buildSubscribe(1, 'home/+/status');
  check('subscribe-packet', s[0] === 0x82, s.slice(0, 6).toString('hex'));
  const fake = Buffer.concat([c, s, buildPing()]);
  const { packets, rest } = parsePackets(fake);
  check('parse-packets', packets.length === 3 && rest.length === 0 && packets[0].type === 1 && packets[1].type === 8 && packets[2].type === 12, `n=${packets.length}`);

  // 3) 快照解析（临时目录 + 缺失文件）
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'field-monitor-'));
  try {
    const fakeRoot = path.join(tmp, 'competition');
    fs.mkdirSync(path.join(fakeRoot, 'bridge', '_test', 'current-runtime', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, 'bridge', 'status.json'), JSON.stringify({ deviceId: 'esp32-kitchen', room: '厨房', ts: 1793018980586, state: 'NORMAL', alarm: { id: '', type: '' } }));
    fs.writeFileSync(path.join(fakeRoot, 'bridge', '_test', 'current-runtime', 'supervisor', 'status.json'), JSON.stringify({ deviceId: 'esp32-bath', room: '卫生间', ts: 1793018979601, state: 'ACKED', alarm: { id: 'e-1793015347-1', type: 'MANUAL_SOS', countToday: 1 } }));
    const outDir = path.join(tmp, 'out');
    const mon = new FieldMonitor({ host: '127.0.0.1', port: 1, seconds: 0, outDir, root: fakeRoot, devices: ['esp32-kitchen', 'esp32-bath'], snapshotMs: 5000, serialDir: '', clientId: 'selftest', explain: false, selftest: true });
    mon.openLogs();
    mon.snapshotOnce();
    const snap = fs.readFileSync(path.join(outDir, 'snapshots.log'), 'utf8');
    check('snapshot-bridge', snap.includes('deviceId=esp32-kitchen') && snap.includes('state=NORMAL'), 'has kitchen');
    check('snapshot-bath-acked', snap.includes('deviceId=esp32-bath') && snap.includes('state=ACKED') && snap.includes('e-1793015347-1'), 'has bath ACKED');
    mdClose(mon);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  }

  // 4) 环回 broker：真实 socket 路径 + 只读审计（只允许 CONNECT/SUBSCRIBE/PINGREQ）
  const tmp2 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'field-monitor-loop-'));
  let serverRef = null;
  let receivedTypes = [];
  const done = new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const p = parsePackets(buf);
        buf = p.rest;
        for (const pk of p.packets) {
          receivedTypes.push(pk.type);
          if (pk.type === 1) sock.write(Buffer.from([0x20, 2, 0, 0]));
          else if (pk.type === 8) {
            const pid = pk.body.slice(0, 2);
            sock.write(Buffer.from([0x90, 3, pid[0], pid[1], 0]));
            const body = Buffer.concat([encStr('home/esp32-bath/status'), Buffer.from(JSON.stringify({ deviceId: 'esp32-bath', room: '卫生间', ts: 1793019000000, state: 'ACKED', alarm: { id: 'e-test-1', type: 'MANUAL_SOS' } }))]);
            sock.write(pkt(3, 0, body));
          }
        }
      });
    });
    serverRef = srv;
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      const outDir = path.join(tmp2, 'out');
      const mon = new FieldMonitor({ host: '127.0.0.1', port, seconds: 0, outDir, root: tmp2, devices: ['esp32-kitchen', 'esp32-bath'], snapshotMs: 1000, serialDir: '', clientId: 'selftest-loop', explain: false, selftest: true });
      const rc = await mon.start();
      await new Promise((r) => setTimeout(r, 700));
      mon.stop('selftest');
      srv.close();
      const mqttLog = fs.readFileSync(path.join(outDir, 'mqtt-status.log'), 'utf8');
      const ackLog = fs.readFileSync(path.join(outDir, 'ack-events.log'), 'utf8');
      check('loopback-connect-subscribe', rc === 0 && receivedTypes.includes(1) && receivedTypes.includes(8), `rc=${rc} types=${receivedTypes.join(',')}`);
      check('loopback-received-status', mqttLog.includes('home/esp32-bath/status') && mqttLog.includes('e-test-1'), 'status logged');
      check('loopback-acked-observed', ackLog.includes('ACKED-OBSERVED') && ackLog.includes('e-test-1'), 'ack logged');
      check('audit-no-publish', receivedTypes.every((t) => t === 1 || t === 8 || t === 12), `types=${receivedTypes.join(',')}`);
      resolve();
    });
  });

  return done.then(() => {
    try { if (serverRef) serverRef.close(); } catch (e) { }
    try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e) { }
    const failed = checks.filter((x) => !x.ok);
    console.log(`FIELD_MONITOR SELFTEST ${failed.length === 0 ? 'PASS' : 'FAIL'} ${checks.length - failed.length}/${checks.length} checks passed`);
    for (const f of failed) console.log(`  FAILED ${f.name} :: ${f.detail}`);
    return failed.length === 0 ? 0 : 1;
  });
}

function mdClose(mon) {
  for (const k of ['mqtt', 'snap', 'ack', 'marker', 'summary']) {
    if (mon.files[k] !== undefined) { try { fs.closeSync(mon.files[k]); } catch (e) { } mon.files[k] = undefined; }
  }
}

// ---------------------------------------------------------------- main
async function main() {
  let args;
  try { args = parseArgs(process.argv); } catch (e) {
    console.error('ERROR: ' + e.message);
    return 2;
  }
  if (args.help) {
    console.log('用法: node field-monitor.js [--seconds N] [--out-dir DIR] [--serial-dir DIR] [--root DIR] [--devices a,b] [--snapshot-ms N] [--host H] [--port P] [--explain] [--selftest]');
    console.log(ACK_CHAIN_TEXT);
    return 0;
  }
  if (args.explain) { console.log(ACK_CHAIN_TEXT); return 0; }
  if (args.selftest) { return runSelftest(); }
  if (!args.outDir) args.outDir = path.join(SCRIPT_DIR, 'logs', 'monitor-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/\./g, ''));
  const mon = new FieldMonitor(args);
  const rc = await mon.start();
  if (rc !== 0) { mon.stop('start-failed'); return rc; }
  const stopBy = (sig) => { mon.stop(sig); setTimeout(() => process.exit(0), 100); };
  process.on('SIGINT', () => stopBy('SIGINT'));
  process.on('SIGTERM', () => stopBy('SIGINT'));
  if (args.seconds > 0) {
    // start() 内已设置定时器；等待结束
    await new Promise((resolve) => {
      const t = setInterval(() => { if (mon.closed) { clearInterval(t); resolve(); } }, 200);
      mon.timers.push(t);
    });
  } else {
    await new Promise(() => { }); // 直到 Ctrl+C
  }
  return 0;
}

if (require.main === module) {
  main().then((rc) => process.exit(rc)).catch((e) => { console.error('ERROR: ' + (e && e.message ? e.message : e)); process.exit(1); });
}

module.exports = { parseArgs, buildConnect, buildSubscribe, buildPing, parsePackets, parsePublish, FieldMonitor, ACK_CHAIN_TEXT };
