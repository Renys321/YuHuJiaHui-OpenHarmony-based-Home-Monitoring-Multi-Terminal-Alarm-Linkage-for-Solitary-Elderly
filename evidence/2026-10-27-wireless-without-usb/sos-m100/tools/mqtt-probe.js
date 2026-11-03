'use strict';
/*
 * ECS 公网 MQTT 只读探针（不发布、不订阅、不顶设备）。
 *  1) TCP 可达性 + 握手耗时（47.76.70.118:1883）
 *  2) 一次 MQTT 3.1.1 CONNECT：唯一 clientId 后缀 + 正确用户名/密码
 *     - 该 Broker 有 Client ID 白名单（MQTT_CLIENT_ID，仅设备 ID），
 *       因此预期返回 CONNACK 0x05 = CLIENT_ID_NOT_ALLOWED；
 *       能收到 CONNACK 本身即证明 Broker 在线、协议栈与鉴权都在工作。
 *     - 绝不使用设备 Client ID，避免把在线设备顶下线。
 *  3) 正常 DISCONNECT 后关闭。
 * 凭据仅从 competition/.secrets/wearable-mqtt.env 读取，不打印、不落盘。
 * 用法：node mqtt-probe.js <logs目录> <标签>
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const HOST = '47.76.70.118';
const PORT = 1883;
const ENV = 'D:/OpenHarmony/competition/.secrets/wearable-mqtt.env';

function readEnv() {
  const out = {};
  for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function encStr(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function varint(n) {
  const out = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return Buffer.from(out);
}

function buildConnect({ clientId, username, password, keepAlive = 60 }) {
  const vh = Buffer.concat([
    encStr('MQTT'),
    Buffer.from([0x04, 0xc2]), // 3.1.1 + cleanSession + username + password
    Buffer.from([(keepAlive >> 8) & 0xff, keepAlive & 0xff])
  ]);
  const payload = Buffer.concat([encStr(clientId), encStr(username), encStr(password)]);
  const body = Buffer.concat([vh, payload]);
  return Buffer.concat([Buffer.from([0x10]), varint(body.length), body]);
}

function tcpProbe() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host: HOST, port: PORT });
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      sock.destroy();
      resolve({ ok, ms: Math.round(ms * 10) / 10, detail });
    };
    sock.setTimeout(8000, () => finish(false, 'TIMEOUT'));
    sock.once('connect', () => finish(true, 'TCP_ESTABLISHED'));
    sock.once('error', (e) => finish(false, e.code || e.message));
  });
}

function mqttProbe(env) {
  return new Promise((resolve) => {
    const clientId = `${env.MQTT_CLIENT_ID || 'wearable-sos-001'}-probe-${Date.now().toString(36)}`;
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host: HOST, port: PORT });
    const chunks = [];
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ clientIdHasUniqueSuffix: true, ...result });
    };
    const ms = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;
    sock.setTimeout(10000, () => done({ result: 'TIMEOUT', ms: ms() }));
    sock.once('error', (e) => done({ result: 'SOCKET_ERROR', code: e.code || e.message, ms: ms() }));
    sock.once('connect', () => {
      sock.write(buildConnect({ clientId, username: env.MQTT_USER, password: env.MQTT_PASS }));
    });
    sock.on('data', (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      if (buf.length >= 4 && buf[0] === 0x20) {
        const rc = buf[3];
        const names = { 0: 'ACCEPTED', 1: 'BAD_PROTOCOL', 2: 'ID_REJECTED', 3: 'SERVER_UNAVAILABLE', 4: 'BAD_CREDENTIALS', 5: 'NOT_AUTHORIZED' };
        // 收到 CONNACK 后发 DISCONNECT（0xE0 0x00）再关闭，保持"正常断开"。
        try { sock.write(Buffer.from([0xe0, 0x00])); } catch (_) {}
        setTimeout(() => done({
          result: 'CONNACK',
          returnCode: rc,
          returnCodeHex: '0x0' + rc.toString(16),
          meaning: names[rc] || 'UNKNOWN',
          ms: ms()
        }), 120);
        sock.removeAllListeners('data');
      }
    });
  });
}

(async () => {
  const env = readEnv();
  const outDir = process.argv[2] || path.join(__dirname, '..', 'logs');
  const label = process.argv[3] || 'mqtt-probe';
  const tcpRuns = [];
  for (let i = 0; i < 3; i++) tcpRuns.push(await tcpProbe());
  const mqtt = await mqttProbe(env);
  const record = {
    label,
    probedAt: new Date().toISOString(),
    probedAtLocal: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00',
    endpoint: 'mqtt://' + HOST + ':' + PORT,
    tcp: tcpRuns,
    mqttConnect: {
      ...mqtt,
      usedDeviceClientId: false,
      note: 'clientId 使用唯一后缀；不应与在线设备相同。CONNACK 0x05 表示白名单拒绝唯一 ID，属 Broker 正常防护。'
    }
  };
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `${stamp}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ file, ...record }, null, 2));
})().catch((e) => { console.error('PROBE_FAILED', e && e.message); process.exit(1); });
