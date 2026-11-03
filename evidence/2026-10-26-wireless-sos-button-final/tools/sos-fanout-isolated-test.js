#!/usr/bin/env node
/**
 * sos-fanout-isolated-test.js — 隔离验证「同一求助事件定向两板播报」
 *
 * 完全跑在**独立端口**上，不碰生产 broker(1883)/bridge(9101)/public-sync：
 *   broker 127.0.0.1:18830   bridge --listen 9111
 * 三个模拟节点用与真实 ESP32 完全相同的 JSON 行协议接入 bridge。
 *
 * 覆盖判据：
 *   A 同一 alarmId 只派发一次（重试/重复上报不产生第二条 notice）
 *   B 一块目标离线 → 另一块照常播报，逐目标记录 delivered/failed_offline
 *   C 来源 ACKED → 对**已送达**的目标发 noticeack；未送达的目标跳过（无声音可停）
 *   D 重连后不补发、不重复触发
 *   E 其他房间的环境告警不会跨房间广播
 *   F ACK 后再次求助产生新 alarmId（不复用旧 ID），两块重新播报
 *   G APP 侧 ACK 走 home/<deviceId>/cmd → bridge 仍能把 `ack` 路由回来源节点
 *
 * 用法：node sos-fanout-isolated-test.js [--work-dir <dir>]
 * 退出码 0 = 全部通过。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BROKER_PORT = 18830;
const BRIDGE_PORT = 9111;
const BRIDGE_JS = 'D:\\OpenHarmony\\competition\\bridge\\mqtt_bridge.js';
const BROKER_JS = 'D:\\OpenHarmony\\competition\\bridge\\mqtt_broker.js';
const NODE_BIN = process.execPath;

const argWork = process.argv.indexOf('--work-dir');
const WORK = argWork > 0 ? process.argv[argWork + 1]
  : fs.mkdtempSync(path.join(os.tmpdir(), 'sos-fanout-'));
fs.mkdirSync(WORK, { recursive: true });

const FANOUT_LOG = path.join(WORK, 'sos-fanout.jsonl');
const STATUS_FILE = path.join(WORK, 'status.json');
const BRIDGE_STDOUT = path.join(WORK, 'bridge.stdout.log');
const BRIDGE_STDERR = path.join(WORK, 'bridge.stderr.log');
const TEST_LOG = path.join(WORK, 'test.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`;
  console.log(line);
  fs.appendFileSync(TEST_LOG, line + '\n');
}

/* ------------------------------------------------------------ 模拟节点 */
class FakeNode {
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.lines = [];       // 收到的下行命令（按行）
    this.raw = '';
    this.sock = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: BRIDGE_PORT }, () => resolve());
      sock.on('error', reject);
      sock.on('data', (d) => {
        this.raw += d.toString('utf8');
        let i;
        while ((i = this.raw.indexOf('\n')) >= 0) {
          const line = this.raw.slice(0, i).replace(/\r$/, '');
          this.raw = this.raw.slice(i + 1);
          if (line.trim()) this.lines.push(line.trim());
        }
      });
      this.sock = sock;
    });
  }
  send(obj) {
    if (!this.sock || this.sock.destroyed) return;
    this.sock.write(JSON.stringify(obj) + '\n');
  }
  close() {
    if (this.sock && !this.sock.destroyed) this.sock.destroy();
    this.sock = null;
  }
  take() { const l = this.lines.slice(); this.lines = []; return l; }
  count(prefix) { return this.lines.filter((l) => l.startsWith(prefix)).length; }
}

function statusLine(deviceId, room, state, alarm, extraSensors) {
  return {
    deviceId,
    room,
    ts: Date.now(),
    state,
    sensors: Object.assign({
      motion: { lastActiveTs: 0, countToday: 0 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 24.5, rh: 55.0, ok: true, valid: true },
      gas: { raw: 0, ok: true, valid: false },
      smoke: { raw: 0, ok: true, valid: false },
    }, extraSensors || {}),
    history: [0, 0, 0, 0, 0, 0, 0],
    slots: [0, 0, 0, 0],
    alarm: alarm || { id: '', type: '', countToday: 0 },
  };
}

/* ------------------------------------------------------- 最小 MQTT 发布器 */
function mqttPublish(topic, msg) {
  return new Promise((resolve, reject) => {
    const encLen = (n) => {
      const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0);
      return Buffer.from(o);
    };
    const encStr = (s) => {
      const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2);
      l.writeUInt16BE(b.length, 0); return Buffer.concat([l, b]);
    };
    const pkt = (t, f, p) => Buffer.concat([Buffer.from([(t << 4) | f]), encLen(p.length), p]);
    const sock = net.createConnection({ host: '127.0.0.1', port: BROKER_PORT }, () => {
      sock.write(pkt(1, 0, Buffer.concat([
        encStr('MQTT'), Buffer.from([4, 0x02, 0, 30]),
        encStr('test-pub-' + Date.now()),
      ])));
    });
    let buf = Buffer.alloc(0);
    let sent = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!sent && buf.length >= 4 && (buf[0] >> 4) === 2) {
        sent = true;
        sock.write(pkt(3, 0, Buffer.concat([encStr(topic), Buffer.from(msg, 'utf8')])));
        setTimeout(() => { sock.end(); resolve(); }, 200);
      }
    });
    sock.on('error', reject);
    setTimeout(() => { if (!sent) { sock.destroy(); reject(new Error('mqtt connect timeout')); } }, 3000);
  });
}

/* ------------------------------------------------------------------ 主流程 */
(async () => {
  const brokerOut = fs.openSync(path.join(WORK, 'broker.log'), 'a');
  const broker = spawn(NODE_BIN, [BROKER_JS, String(BROKER_PORT)], { stdio: ['ignore', brokerOut, brokerOut] });
  await sleep(600);

  const bOut = fs.openSync(BRIDGE_STDOUT, 'a');
  const bErr = fs.openSync(BRIDGE_STDERR, 'a');
  const bridge = spawn(NODE_BIN, [
    BRIDGE_JS,
    '--broker', `127.0.0.1:${BROKER_PORT}`,
    '--listen', String(BRIDGE_PORT),
    '--status-file', STATUS_FILE,
    '--sos-source', 'esp32-sos',
    '--sos-targets', 'esp32-kitchen,esp32-bath',
    '--sos-log', FANOUT_LOG,
  ], { stdio: ['ignore', bOut, bErr] });
  await sleep(900);

  const sos = new FakeNode('esp32-sos');
  const kitchen = new FakeNode('esp32-kitchen');
  const bath = new FakeNode('esp32-bath');
  await sos.connect();
  await kitchen.connect();
  await bath.connect();

  // 三块板先各报一条 NORMAL，让桥接绑定 deviceId
  sos.send(statusLine('esp32-sos', '随身求助', 'NORMAL'));
  kitchen.send(statusLine('esp32-kitchen', '厨房', 'NORMAL'));
  bath.send(statusLine('esp32-bath', '卫生间', 'NORMAL'));
  await sleep(500);
  sos.take(); kitchen.take(); bath.take();

  try {
    /* ---- A：同一求助事件 → 两板各收到一次同一 alarmId 的 notice ---- */
    const id1 = 'e-1-' + Date.now();
    const alarm1 = { id: id1, type: 'MANUAL_SOS', countToday: 1 };
    sos.send(statusLine('esp32-sos', '随身求助', 'ALARM', alarm1));
    await sleep(500);
    check('A1 kitchen 收到 notice',
      kitchen.lines.length === 1 && kitchen.lines[0] === `notice ${id1} esp32-sos`, JSON.stringify(kitchen.lines));
    check('A2 bath 收到 notice',
      bath.lines.length === 1 && bath.lines[0] === `notice ${id1} esp32-sos`, JSON.stringify(bath.lines));
    check('A3 两板 alarmId 完全一致', kitchen.lines[0] === bath.lines[0], `${kitchen.lines[0]} / ${bath.lines[0]}`);
    kitchen.take(); bath.take();

    /* ---- A'：重试 / 重复上报 / 抖动 → 不产生第二条 notice ---- */
    for (let i = 0; i < 3; i++) {
      sos.send(statusLine('esp32-sos', '随身求助', 'ALARM', alarm1));
      await sleep(200);
    }
    await sleep(300);
    check('A4 重复上报不重复派发', kitchen.lines.length === 0 && bath.lines.length === 0,
      `kitchen=${JSON.stringify(kitchen.lines)} bath=${JSON.stringify(bath.lines)}`);

    /* ---- C：ACK → 已送达的目标收到 noticeack；来源设备的 ack 由 bridge 常规路由 ---- */
    sos.send(statusLine('esp32-sos', '随身求助', 'ACKED', alarm1));
    await sleep(400);
    check('C1 kitchen 收到 noticeack',
      kitchen.lines.length === 1 && kitchen.lines[0] === `noticeack ${id1}`, JSON.stringify(kitchen.lines));
    check('C2 bath 收到 noticeack',
      bath.lines.length === 1 && bath.lines[0] === `noticeack ${id1}`, JSON.stringify(bath.lines));
    kitchen.take(); bath.take();

    // G：APP -> 后端 -> command-sync 的 MQTT 下行仍能路由回来源节点
    await mqttPublish('home/esp32-sos/cmd', JSON.stringify({ cmd: 'ack', alarmId: id1, action: '已确认' }));
    await sleep(400);
    check('G1 ack 路由回来源节点',
      sos.lines.some((l) => l.startsWith(`ack ${id1}`)), JSON.stringify(sos.lines));
    sos.take();

    /* ---- A''：ACK 后再次重复上报同一 id → 仍然不重发 ---- */
    sos.send(statusLine('esp32-sos', '随身求助', 'ALARM', alarm1));
    await sleep(400);
    check('A5 ACK 后同一 id 重放不再派发', kitchen.lines.length === 0 && bath.lines.length === 0,
      `kitchen=${JSON.stringify(kitchen.lines)} bath=${JSON.stringify(bath.lines)}`);
    sos.send(statusLine('esp32-sos', '随身求助', 'ACKED', alarm1));
    await sleep(200);
    kitchen.take(); bath.take(); sos.take();

    /* ---- B：一块目标离线 → 另一块照常播报，逐目标记录 ---- */
    kitchen.close();
    await sleep(400);
    const id2 = 'e-2-' + Date.now();
    const alarm2 = { id: id2, type: 'MANUAL_SOS', countToday: 1 };
    sos.send(statusLine('esp32-sos', '随身求助', 'ALARM', alarm2));
    await sleep(500);
    check('B1 在线板仍播报', bath.lines.length === 1 && bath.lines[0] === `notice ${id2} esp32-sos`,
      JSON.stringify(bath.lines));
    const rec2 = fs.readFileSync(FANOUT_LOG, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).find((r) => r.event === 'dispatch' && r.alarmId === id2);
    check('B2 逐目标记录送达/失败',
      !!rec2 && rec2.targets['esp32-kitchen'] === 'failed_offline' && rec2.targets['esp32-bath'] === 'delivered',
      JSON.stringify(rec2 && rec2.targets));
    bath.take();

    /* ---- D：目标重连后不补发 ---- */
    await kitchen.connect();
    kitchen.send(statusLine('esp32-kitchen', '厨房', 'NORMAL'));
    await sleep(600);
    check('D1 重连不补发旧求助', kitchen.lines.length === 0, JSON.stringify(kitchen.lines));
    kitchen.take();

    /* ---- C'：ACK 对未送达目标跳过 ---- */
    sos.send(statusLine('esp32-sos', '随身求助', 'ACKED', alarm2));
    await sleep(400);
    const ackRec = fs.readFileSync(FANOUT_LOG, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).find((r) => r.event === 'ack' && r.alarmId === id2);
    check('C3 未送达目标跳过收口',
      !!ackRec && ackRec.targets['esp32-kitchen'] === 'skipped_not_playing' &&
      ackRec.targets['esp32-bath'] === 'delivered', JSON.stringify(ackRec && ackRec.targets));
    check('C4 bath 收到 noticeack 且 kitchen 没有',
      bath.lines.length === 1 && bath.lines[0] === `noticeack ${id2}` && kitchen.lines.length === 0,
      `bath=${JSON.stringify(bath.lines)} kitchen=${JSON.stringify(kitchen.lines)}`);
    bath.take(); kitchen.take(); sos.take();

    /* ---- E：其他房间的环境告警不跨房间广播 ---- */
    kitchen.send(statusLine('esp32-kitchen', '厨房', 'ALARM',
      { id: 'e-k-' + Date.now(), type: 'CLIMATE', countToday: 1 }));
    await sleep(500);
    check('E1 普通环境告警不跨房间广播', bath.lines.length === 0 && sos.lines.length === 0,
      `bath=${JSON.stringify(bath.lines)} sos=${JSON.stringify(sos.lines)}`);
    kitchen.send(statusLine('esp32-kitchen', '厨房', 'NORMAL'));
    await sleep(200);
    kitchen.take(); bath.take(); sos.take();

    /* ---- F：ACK 后再次求助 → 新 alarmId，两块重新播报且不复用旧 ID ---- */
    const id3 = 'e-3-' + Date.now();
    sos.send(statusLine('esp32-sos', '随身求助', 'ALARM',
      { id: id3, type: 'MANUAL_SOS', countToday: 1 }));
    await sleep(500);
    check('F1 新求助产生新 alarmId', id3 !== id1 && id3 !== id2, `${id1} / ${id2} / ${id3}`);
    check('F2 两块重新播报新事件',
      kitchen.lines.length === 1 && kitchen.lines[0] === `notice ${id3} esp32-sos` &&
      bath.lines.length === 1 && bath.lines[0] === `notice ${id3} esp32-sos`,
      `kitchen=${JSON.stringify(kitchen.lines)} bath=${JSON.stringify(bath.lines)}`);
  } catch (e) {
    check('EXCEPTION', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
  } finally {
    sos.close(); kitchen.close(); bath.close();
    await sleep(200);
    bridge.kill();
    broker.kill();
    await sleep(200);
  }

  const failed = checks.filter((c) => !c.ok);
  const summary = `SOS_FANOUT_ISOLATED_TEST ${failed.length === 0 ? 'PASS' : 'FAIL'} ` +
    `${checks.length - failed.length}/${checks.length} checks, workDir=${WORK}`;
  console.log(summary);
  fs.appendFileSync(TEST_LOG, summary + '\n');
  process.exit(failed.length === 0 ? 0 : 1);
})();
