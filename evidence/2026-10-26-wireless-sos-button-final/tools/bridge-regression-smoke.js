#!/usr/bin/env node
/**
 * bridge-regression-smoke.js — 证明新增定向播报**不改变**旧行为
 *
 * 独立端口（broker 18831 / bridge 9112），不碰生产 1883/9101。
 * 判据：
 *   H1 不传 --sos-source/--sos-targets 时，旧下行命令（ack/reset/stop）照旧路由
 *   H2 不带参数时不会向任何设备发 notice（功能默认关闭）
 *   H3 notice 无法从 MQTT 命令主题注入到设备（只有桥接自身的受控编排能发）
 *   H4 即使设备自称 esp32-sos 并进入 MANUAL_SOS，未配置 target 时也不外发
 */
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BROKER_PORT = 18831;
const BRIDGE_PORT = 9112;
const BRIDGE_JS = 'D:\\OpenHarmony\\competition\\bridge\\mqtt_bridge.js';
const BROKER_JS = 'D:\\OpenHarmony\\competition\\bridge\\mqtt_broker.js';
const WORK = process.argv.indexOf('--work-dir') > 0
  ? process.argv[process.argv.indexOf('--work-dir') + 1]
  : fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-smoke-'));
fs.mkdirSync(WORK, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

class FakeNode {
  constructor() { this.lines = []; this.raw = ''; }
  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port: BRIDGE_PORT }, () => resolve());
      s.on('error', reject);
      s.on('data', (d) => {
        this.raw += d.toString('utf8');
        let i;
        while ((i = this.raw.indexOf('\n')) >= 0) {
          const line = this.raw.slice(0, i).trim();
          this.raw = this.raw.slice(i + 1);
          if (line) this.lines.push(line);
        }
      });
      this.sock = s;
    });
  }
  send(obj) { if (this.sock) this.sock.write(JSON.stringify(obj) + '\n'); }
  close() { if (this.sock) this.sock.destroy(); }
}

function status(deviceId, state, alarm) {
  return {
    deviceId, room: '测试', ts: Date.now(), state,
    sensors: {
      motion: { lastActiveTs: 0, countToday: 0 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 24, rh: 50, ok: true, valid: true },
      gas: { raw: 0, ok: true, valid: false },
      smoke: { raw: 0, ok: true, valid: false },
    },
    history: [0, 0, 0, 0, 0, 0, 0], slots: [0, 0, 0, 0],
    alarm: alarm || { id: '', type: '', countToday: 0 },
  };
}

function mqttPublish(topic, msg) {
  return new Promise((resolve, reject) => {
    const encLen = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; o.push(b); } while (n > 0); return Buffer.from(o); };
    const encStr = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length, 0); return Buffer.concat([l, b]); };
    const pkt = (t, f, p) => Buffer.concat([Buffer.from([(t << 4) | f]), encLen(p.length), p]);
    const sock = net.createConnection({ host: '127.0.0.1', port: BROKER_PORT }, () => {
      sock.write(pkt(1, 0, Buffer.concat([encStr('MQTT'), Buffer.from([4, 0x02, 0, 30]), encStr('smoke-' + Date.now())])));
    });
    let buf = Buffer.alloc(0); let sent = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!sent && buf.length >= 4 && (buf[0] >> 4) === 2) {
        sent = true;
        sock.write(pkt(3, 0, Buffer.concat([encStr(topic), Buffer.from(msg, 'utf8')])));
        setTimeout(() => { sock.end(); resolve(); }, 200);
      }
    });
    sock.on('error', reject);
    setTimeout(() => { if (!sent) { sock.destroy(); reject(new Error('timeout')); } }, 3000);
  });
}

(async () => {
  const brokerLog = fs.openSync(path.join(WORK, 'broker.log'), 'a');
  const broker = spawn(process.execPath, [BROKER_JS, String(BROKER_PORT)], { stdio: ['ignore', brokerLog, brokerLog] });
  await sleep(600);
  const bLog = fs.openSync(path.join(WORK, 'bridge.log'), 'a');
  const bridge = spawn(process.execPath, [
    BRIDGE_JS, '--broker', `127.0.0.1:${BROKER_PORT}`, '--listen', String(BRIDGE_PORT),
    '--status-file', path.join(WORK, 'status.json'),
  ], { stdio: ['ignore', bLog, bLog] });
  await sleep(900);

  const sos = new FakeNode();
  const other = new FakeNode();
  await sos.connect();
  await other.connect();
  sos.send(status('esp32-sos', 'NORMAL'));
  other.send(status('esp32-kitchen', 'NORMAL'));
  await sleep(500);
  sos.lines = []; other.lines = [];

  try {
    /* H1：旧命令照旧路由 */
    await mqttPublish('home/esp32-kitchen/cmd', JSON.stringify({ cmd: 'ack', alarmId: 'e-9-1', action: '已确认' }));
    await sleep(400);
    check('H1 ack 照旧路由', other.lines.some((l) => l.startsWith('ack e-9-1')), JSON.stringify(other.lines));
    await mqttPublish('home/esp32-kitchen/cmd', JSON.stringify({ cmd: 'reset' }));
    await sleep(300);
    check('H1b reset 照旧路由', other.lines.includes('reset'), JSON.stringify(other.lines));

    /* H3：notice 不能从 MQTT 注入 */
    other.lines = [];
    await mqttPublish('home/esp32-kitchen/cmd', JSON.stringify({ cmd: 'notice', alarmId: 'e-9-2', source: 'esp32-sos' }));
    await sleep(400);
    check('H3 MQTT 侧无法注入 notice', other.lines.length === 0, JSON.stringify(other.lines));

    /* H2/H4：来源真的进入 MANUAL_SOS，但未配置 target → 不外发 */
    sos.send(status('esp32-sos', 'ALARM', { id: 'e-9-3', type: 'MANUAL_SOS', countToday: 1 }));
    await sleep(600);
    check('H2/H4 未配置 target 时不外发 notice',
      other.lines.length === 0 && sos.lines.length === 0,
      `other=${JSON.stringify(other.lines)} sos=${JSON.stringify(sos.lines)}`);
  } finally {
    sos.close(); other.close();
    await sleep(200);
    bridge.kill();
    broker.kill();
    await sleep(200);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`BRIDGE_REGRESSION_SMOKE ${failed.length === 0 ? 'PASS' : 'FAIL'} ` +
    `${checks.length - failed.length}/${checks.length} checks, workDir=${WORK}`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
