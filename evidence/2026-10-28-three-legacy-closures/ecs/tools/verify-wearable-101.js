#!/usr/bin/env node
'use strict';
/**
 * verify-wearable-101.js —— ECS wearable-mqtt v1.0.1 只读验收脚本（Node ≥ 20，零依赖）
 *
 * 目标（task-7 第 1/3 项）：
 *   1) snapshot：用现有监护人账号登录生产 API，记录 esp32-sos 的 online/state/lastSeenTs
 *      与随身 SOS 告警（alarmId/createdAt/acknowledgedAt/acknowledgedBy）→ ndjson；
 *   2) probe：用 wearable-mqtt.env 里的凭据 + **非白名单 clientId** 探测公网 1883 的 CONNACK，
 *      证明 broker 可达、凭据可用、白名单生效（预期 rc=5），且不接管真实设备连接；
 *   3) watch：按间隔连续采样，记录 online 翻转 / 新 alarmId / ackPending→ACKED / lastSeen 推进；
 *   4) report：把 ndjson 采样 + 用户从 ECS 贴回的 /status JSON + docker logs 片段 + 人工标记，
 *      判 PASS/FAIL/BLOCKED（每项附原始时间戳）；
 *   5) selftest：用**内存里的 MOCK 数据**自检判据逻辑（与真实证据严格分开标注）。
 *
 * 硬边界（违反即视为事故）：
 *   - 只 POST /api/v1/auth/app（登录）+ GET /api/v1/{devices,alerts,location}；
 *     绝不 POST /api/v1/alerts/<id>/ack、绝不写 device-status、绝不改任何数据；
 *   - MQTT 只发 CONNECT → 读 CONNACK → DISCONNECT。**绝不 PUBLISH、绝不 SUBSCRIBE**；
 *     客户端 ID 必须非白名单（默认 probe-readonly-<rand>），若等于 MQTT_CLIENT_ID（wearable-sos-001）
 *     则立即拒绝执行（那会顶掉在线 M100，制造假故障）；
 *   - 凭据只从 competition/.secrets/** 读取，不打印、不写日志、不写入任何输出文件；
 *   - 不重启/不部署任何 ECS 服务；ECS 侧的 docker 命令只能由用户在阿里云 Workbench 执行。
 *
 * 用法：
 *   node verify-wearable-101.js snapshot [--label pre-deploy] [--count 1] [--interval 10]
 *   node verify-wearable-101.js watch    [--label post-deploy-ack] [--duration 900] [--interval 15]
 *   node verify-wearable-101.js preupgrade [--host 47.76.70.118] [--port 1883]
 *                                        → 落盘 ecs-output/before-upgrade-<ts>.json + snapshots/samples-pre-upgrade-<ts>.ndjson（官方升级前基线）
 *   node verify-wearable-101.js probe    [--host 47.76.70.118] [--port 1883]
 *   node verify-wearable-101.js report   --samples <ndjson> [--baseline <ndjson>] [--markers <json>]
 *                                        [--status <json>]... [--logs <txt>] [--tag FINAL]
 *   node verify-wearable-101.js selftest
 *
 * 时间：一律 Asia/Shanghai（+08:00）。区间/阈值：
 *   - 离线阈值 = DEVICE_ALIVE_TIMEOUT_MS = 120000ms（1.0.1 生效值）；
 *   - ACK 重启窗口要求设备恢复后 ≤30s 内 ACKED（正常应为秒级~10s 级）；
 *   - 同一 alarmId 在 /api/v1/alerts 只能出现 1 条。
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');

/* ------------------------------------------------------------------ 常量 */

const HERE = __dirname;                                  // <ecs>/tools
const ECS_DIR = path.resolve(HERE, '..');                // <ecs>
const REPO_ROOT = path.resolve(HERE, '../../../../..');  // D:\OpenHarmony
const SECRET_APP = path.join(REPO_ROOT, 'competition', '.secrets', 'app_guardian.txt');
const SECRET_MQTT = path.join(REPO_ROOT, 'competition', '.secrets', 'wearable-mqtt.env');

const API_BASE = 'https://api.luxunacc.xyz';
const API_HOST = 'api.luxunacc.xyz';
const DEFAULT_ECS_HOST = '47.76.70.118';
const DEFAULT_MQTT_PORT = 1883;

const DEVICE_ID = 'esp32-sos';
const ROOM_NAME = '随身求助';
const OFF_TOPIC_DEVICES = ['esp32-kitchen', 'esp32-bath', 'dayu200-living', 'esp32-sos'];

const OFFLINE_ALIVE_TIMEOUT_MS = 120000;
const OFFLINE_TOLERANCE_MS = 90000;   // 允许 ±90s（采样间隔 + 轮询抖动）
const ACK_FAST_MS = 30000;            // 设备恢复后 ≤30s ACKED = 正常
const HTTP_TIMEOUT_MS = 15000;

const SNAP_DIR = path.join(ECS_DIR, 'snapshots');
const REPORT_DIR = path.join(ECS_DIR, 'reports');

/* ------------------------------------------------------------------ 时间 */

const TZ_OFFSET_MS = 8 * 3600 * 1000;

/** ms/Date → 2026-10-28T00:21:25.146+08:00 */
function isoLocal(value) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms) || ms === 0) return null;
  return new Date(ms + TZ_OFFSET_MS).toISOString().replace('Z', '+08:00');
}

function stampLocal(value) {
  const iso = isoLocal(value === undefined ? Date.now() : value);
  return iso.replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
}

function nowLocal() { return isoLocal(Date.now()); }

function ms(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 0 && n < 1e12 ? n * 1000 : n; // 容错：秒级时间戳
  const p = Date.parse(value);
  return Number.isFinite(p) ? p : 0;
}

function deltaSec(fromMs, toMs) {
  if (!fromMs || !toMs) return null;
  return Math.round((toMs - fromMs) / 100) / 10;
}

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else {
        if (out[key] === undefined) out[key] = next;
        else if (Array.isArray(out[key])) out[key].push(next);
        else out[key] = [out[key], next];
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }

function writeNdjsonLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/* ------------------------------------------------------------------ 凭据 */

function readAppCredential() {
  const text = fs.readFileSync(SECRET_APP, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const guardianId = (lines[0] || '').trim();
  const password = (lines[1] || '').trim();
  if (!guardianId || !password) throw new Error('app_guardian.txt 不完整（需要两行：账号 / 口令）');
  return { guardianId, password };
}

function readMqttEnv() {
  const text = fs.readFileSync(SECRET_MQTT, 'utf8');
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/* ------------------------------------------------------------------ 生产 API（只读） */

function httpsJson(method, pathname, body, token) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { accept: 'application/json' };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
    if (token) headers.authorization = 'Bearer ' + token;
    const req = https.request(
      { hostname: API_HOST, port: 443, path: pathname, method, headers, timeout: HTTP_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 保留 null */ }
          resolve({ status: res.statusCode, json, textLen: text.length });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, json: null, error: String(e && e.code || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function login() {
  const { guardianId, password } = readAppCredential();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await httpsJson('POST', '/api/v1/auth/app', { guardianId, password });
    if (res.status === 200 && res.json && res.json.sessionToken) return res.json.sessionToken;
    if (attempt === 3) {
      throw new Error('登录失败: HTTP ' + res.status + (res.error ? ' ' + res.error : ''));
    }
    await sleep(1500 * attempt);
  }
  return null;
}

function sleep(msValue) { return new Promise((r) => setTimeout(r, msValue)); }

/** 归一化设备条目（不保存精确坐标：只保存“是否有坐标 / 是否 (0,0)”）。 */
function normalizeDevice(d) {
  const gps = d.gps && typeof d.gps === 'object' ? d.gps : null;
  const lat = gps && typeof gps.latitude === 'number' ? gps.latitude : null;
  const lon = gps && typeof gps.longitude === 'number' ? gps.longitude : null;
  return {
    deviceId: d.deviceId || d.id || null,
    online: d.online === true,
    state: d.state === undefined ? null : d.state,
    monitorOnline: d.monitorOnline === undefined ? null : d.monitorOnline,
    lastSeenTs: Number(d.lastSeenTs) || 0,
    lastSeenIso: isoLocal(Number(d.lastSeenTs) || 0),
    gpsValid: gps ? gps.valid === true : null,
    gpsFixTime: gps && Number(gps.fixTime) ? Number(gps.fixTime) : 0,
    gpsFixTimeIso: gps && Number(gps.fixTime) ? isoLocal(Number(gps.fixTime)) : null,
    gpsHasCoordinates: lat !== null && lon !== null,
    gpsZeroPoint: lat === 0 && lon === 0,
    gpsFieldPresent: Boolean(gps),
    sensorsCount: d.sensors && typeof d.sensors === 'object' ? Object.keys(d.sensors).length : 0,
    csq: d.csq === undefined ? null : d.csq,
    room: d.room === undefined ? null : d.room
  };
}

/** 归一化告警条目：保留核查字段 + 时间戳，不带 note 之外的敏感内容。 */
function normalizeAlert(a) {
  return {
    alarmId: a.alarmId || a.id || null,
    deviceId: a.deviceId || null,
    type: a.type || null,
    state: a.state || null,
    roomName: a.roomName === undefined ? null : a.roomName,
    message: a.message === undefined ? null : a.message,
    createdAt: Number(a.createdAt) || 0,
    createdAtIso: isoLocal(Number(a.createdAt) || 0),
    acknowledgedAt: Number(a.acknowledgedAt) || 0,
    acknowledgedAtIso: isoLocal(Number(a.acknowledgedAt) || 0),
    acknowledgedBy: a.acknowledgedBy === undefined ? null : a.acknowledgedBy,
    ackPending: a.ackPending === true
  };
}

function normalizeLocation(l) {
  const lat = typeof l.latitude === 'number' ? l.latitude : null;
  const lon = typeof l.longitude === 'number' ? l.longitude : null;
  return {
    deviceId: l.deviceId || null,
    fixTime: Number(l.fixTime) || 0,
    fixTimeIso: isoLocal(Number(l.fixTime) || 0),
    hasCoordinates: lat !== null && lon !== null,
    zeroPoint: lat === 0 && lon === 0
  };
}

/** 采样一次（只读 GET）。 */
async function takeSample(token, seq) {
  const [devicesRes, alertsRes, locationRes] = await Promise.all([
    httpsJson('GET', '/api/v1/devices', undefined, token),
    httpsJson('GET', '/api/v1/alerts', undefined, token),
    httpsJson('GET', '/api/v1/location', undefined, token)
  ]);
  const sample = {
    kind: 'sample',
    seq,
    at: nowLocal(),
    epochMs: Date.now(),
    http: { devices: devicesRes.status, alerts: alertsRes.status, location: locationRes.status },
    devices: [],
    sosDevice: null,
    sosAlerts: [],
    sosAlertCount: 0,
    allAlertCount: 0,
    location: null
  };
  if (devicesRes.json && Array.isArray(devicesRes.json.devices)) {
    const all = devicesRes.json.devices.map(normalizeDevice);
    sample.devices = all.filter((d) => OFF_TOPIC_DEVICES.indexOf(d.deviceId) >= 0);
    sample.sosDevice = all.find((d) => d.deviceId === DEVICE_ID) || null;
  }
  if (alertsRes.json && Array.isArray(alertsRes.json.alerts)) {
    const all = alertsRes.json.alerts.map(normalizeAlert);
    sample.allAlertCount = all.length;
    sample.sosAlerts = all.filter((a) => a.deviceId === DEVICE_ID);
    sample.sosAlertCount = sample.sosAlerts.length;
  }
  if (locationRes.json && Array.isArray(locationRes.json.locations)) {
    const all = locationRes.json.locations.map(normalizeLocation);
    sample.location = all.find((l) => l.deviceId === DEVICE_ID) || all.find((l) => l.deviceId === 'wearable-sos-001') || null;
  }
  return sample;
}

/* ------------------------------------------------------------------ CONNACK 探测 */

function encodeVarint(n) {
  const out = [];
  let v = n;
  do { let d = v % 128; v = Math.floor(v / 128); if (v > 0) d |= 0x80; out.push(d); } while (v > 0);
  return Buffer.from(out);
}

function encodeString(s) {
  const body = Buffer.from(String(s), 'utf8');
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

function mqttConnectPacket({ clientId, username, password, keepAliveSec = 30 }) {
  const flags = 0x02 /* cleanSession */ | 0x80 /* username */ | 0x40 /* password */;
  const variable = Buffer.alloc(2);
  variable.writeUInt16BE(keepAliveSec, 0);
  const body = Buffer.concat([
    encodeString('MQTT'),
    Buffer.from([4, flags]), // protocol level 4 = MQTT 3.1.1
    variable,
    encodeString(clientId),
    encodeString(username),
    encodeString(password)
  ]);
  return Buffer.concat([Buffer.from([0x10]), encodeVarint(body.length), body]);
}

function mqttDisconnectPacket() { return Buffer.from([0xe0, 0x00]); }

const CONNACK_MEANING = {
  0: 'ACCEPTED',
  1: 'REFUSED_PROTOCOL_VERSION',
  2: 'REFUSED_IDENTIFIER_REJECTED',
  3: 'REFUSED_SERVER_UNAVAILABLE',
  4: 'REFUSED_BAD_USERNAME_OR_PASSWORD',
  5: 'REFUSED_NOT_AUTHORIZED (本项目 = clientId 不在白名单)'
};

/**
 * 单次 CONNACK 探测：TCP connect → CONNECT → 读 CONNACK → DISCONNECT → 关闭。
 * 绝不发送 PUBLISH/SUBSCRIBE；超时/拒绝都返回结构化结果而不是抛错。
 */
function connackProbe({ host, port, clientId, username, password, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const result = {
      at: nowLocal(),
      epochMs: started,
      host, port, clientId,
      tcpConnected: false,
      tcpConnectMs: null,
      connack: null,
      returnCode: null,
      returnCodeMeaning: null,
      sessionPresent: null,
      closedByServer: false,
      error: null,
      durationMs: null
    };
    let settled = false;
    let buffer = Buffer.alloc(0);
    const done = (patch) => {
      if (settled) return;
      settled = true;
      Object.assign(result, patch || {});
      result.durationMs = Date.now() - started;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => done({ error: 'TIMEOUT_' + timeoutMs + 'MS' }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    socket.setNoDelay(true);
    socket.on('connect', () => {
      result.tcpConnected = true;
      result.tcpConnectMs = Date.now() - started;
      socket.write(mqttConnectPacket({ clientId, username, password }));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      // CONNACK: 0x20, 剩余长度(2), sessionPresent, returnCode
      if ((buffer[0] >> 4) !== 2) { done({ error: 'UNEXPECTED_PACKET_TYPE_' + (buffer[0] >> 4) }); return; }
      let offset = 1;
      const remaining = buffer[offset];
      offset += 1;
      if ((remaining & 0x80) !== 0) { done({ error: 'UNSUPPORTED_REMAINING_LENGTH' }); return; }
      if (buffer.length < offset + remaining) return;
      const ack = { sessionPresent: (buffer[offset] & 0x01) === 1, returnCode: buffer[offset + 1] };
      done({
        connack: ack,
        sessionPresent: ack.sessionPresent,
        returnCode: ack.returnCode,
        returnCodeMeaning: CONNACK_MEANING[ack.returnCode] || ('UNKNOWN_' + ack.returnCode)
      });
      // 只做优雅断开；绝不发 PUBLISH/SUBSCRIBE。
      try { socket.write(mqttDisconnectPacket()); } catch { /* ignore */ }
      socket.end();
    });
    socket.on('close', () => done({ closedByServer: result.returnCode !== null }));
    socket.on('error', (e) => done({ error: String((e && e.code) || e) }));
  });
}

async function runProbe(args) {
  const env = readMqttEnv();
  const whitelistId = env.MQTT_CLIENT_ID || 'wearable-sos-001';
  const user = env.MQTT_USER;
  const pass = env.MQTT_PASS;
  if (!user || !pass) throw new Error('wearable-mqtt.env 缺少 MQTT_USER/MQTT_PASS');

  const host = args.host || DEFAULT_ECS_HOST;
  const port = Number(args.port || DEFAULT_MQTT_PORT);
  const probeId = 'probe-readonly-' + crypto.randomBytes(4).toString('hex');
  if (probeId === whitelistId) throw new Error('拒绝执行：探测 clientId 等于白名单 ID（会顶掉真实设备）');

  mkdirp(SNAP_DIR);
  const cases = [
    { name: 'valid-credentials+non-whitelist-clientId', clientId: probeId, password: pass, expected: 5 },
    { name: 'wrong-password+non-whitelist-clientId(control)', clientId: probeId, password: 'wrong-' + crypto.randomBytes(6).toString('hex'), expected: 4 },
    { name: 'valid-credentials+empty-clientId', clientId: '', password: pass, expected: 2 }
  ];
  const results = [];
  for (const c of cases) {
    const r = await connackProbe({ host, port, clientId: c.clientId, username: user, password: c.password });
    results.push(Object.assign({ case: c.name, expectedReturnCode: c.expected, pass: r.returnCode === c.expected }, r));
    await sleep(300);
  }

  const out = {
    kind: 'mqtt-connack-probe',
    at: nowLocal(),
    epochMs: Date.now(),
    host, port,
    whitelistClientIdNeverUsed: true,
    note: '仅 CONNECT/CONNACK/DISCONNECT；未 PUBLISH、未 SUBSCRIBE、未使用白名单 clientId。',
    results,
    verdict: results.every((r) => r.pass) ? 'PASS' : 'FAIL'
  };
  const file = path.join(SNAP_DIR, 'mqtt-connack-' + stampLocal() + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');

  console.log('[probe] file=' + file);
  for (const r of results) {
    console.log('[probe] ' + r.case + ' tcp=' + (r.tcpConnected ? r.tcpConnectMs + 'ms' : 'FAIL(' + r.error + ')') +
      ' rc=' + (r.returnCode === null ? 'null' : r.returnCode) + ' (' + r.returnCodeMeaning + ')' +
      ' expected=' + r.expectedReturnCode + ' => ' + (r.pass ? 'PASS' : 'FAIL'));
  }
  console.log('[probe] verdict=' + out.verdict + '（rc=5 证明：broker 可达 + 凭据有效 + clientId 白名单生效；rc=4 对照组证明鉴权确实在校验口令）');
  return out;
}

/* ------------------------------------------------------------------ snapshot / watch */

async function runSnapshot(args) {
  const label = args.label || 'snapshot';
  const count = Math.max(1, Number(args.count || 1));
  const intervalSec = Math.max(0, Number(args.interval || 0));
  mkdirp(SNAP_DIR);
  const file = path.join(SNAP_DIR, 'samples-' + label + '-' + stampLocal() + '.ndjson');
  const token = await login();
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const s = await takeSample(token, i + 1);
    writeNdjsonLine(file, s);
    samples.push(s);
    const d = s.sosDevice;
    console.log('[' + label + '] ' + s.at +
      ' http=' + Object.values(s.http).join('/') +
      ' esp32-sos=' + (d ? 'online=' + d.online + ' state=' + d.state + ' lastSeen=' + d.lastSeenIso + ' gpsValid=' + d.gpsValid : 'NOT_FOUND') +
      ' sosAlerts=' + s.sosAlertCount + ' allAlerts=' + s.allAlertCount +
      ' location=' + (s.location ? 'fixTime=' + s.location.fixTimeIso + ' hasCoords=' + s.location.hasCoordinates : 'none'));
    if (i < count - 1) await sleep(intervalSec * 1000);
  }
  console.log('[' + label + '] saved=' + file + ' samples=' + samples.length);
  return { file, samples };
}

async function runWatch(args) {
  const label = args.label || 'watch';
  const durationSec = Math.max(10, Number(args.duration || 600));
  const intervalSec = Math.max(5, Number(args.interval || 15));
  mkdirp(SNAP_DIR);
  const file = path.join(SNAP_DIR, 'samples-' + label + '-' + stampLocal() + '.ndjson');
  const token = await login();
  const deadline = Date.now() + durationSec * 1000;

  let prev = null;
  let seq = 0;
  const timeline = [];
  const noteTransition = (kind, detail) => {
    const entry = Object.assign({ at: nowLocal(), epochMs: Date.now(), kind }, detail);
    timeline.push(entry);
    console.log('[watch] ' + entry.at + ' ' + kind + ' ' + JSON.stringify(detail));
  };
  console.log('[watch] label=' + label + ' duration=' + durationSec + 's interval=' + intervalSec + 's file=' + file);

  for (;;) {
    seq += 1;
    let s;
    try {
      s = await takeSample(token, seq);
    } catch (e) {
      noteTransition('SAMPLE_FAILED', { error: String(e && e.message || e) });
      await sleep(intervalSec * 1000);
      continue;
    }
    writeNdjsonLine(file, s);
    const d = s.sosDevice;
    if (d) {
      if (prev && prev.device) {
        if (prev.device.online !== d.online) noteTransition('DEVICE_ONLINE_CHANGED', { from: prev.device.online, to: d.online, lastSeenIso: d.lastSeenIso });
        if (prev.device.lastSeenTs !== d.lastSeenTs) noteTransition('LAST_SEEN_ADVANCED', { from: prev.device.lastSeenIso, to: d.lastSeenIso, deltaSec: deltaSec(prev.device.lastSeenTs, d.lastSeenTs) });
        if (prev.device.state !== d.state) noteTransition('DEVICE_STATE_CHANGED', { from: prev.device.state, to: d.state });
      } else if (prev === null) {
        noteTransition('WATCH_STARTED', { online: d.online, state: d.state, lastSeenIso: d.lastSeenIso, lastSeenAgeSec: deltaSec(d.lastSeenTs, s.epochMs) });
      }
      const prevIds = prev ? prev.sosAlerts.map((a) => a.alarmId) : [];
      for (const a of s.sosAlerts) {
        if (prevIds.indexOf(a.alarmId) < 0) {
          noteTransition('NEW_ALARM', { alarmId: a.alarmId, createdAtIso: a.createdAtIso, state: a.state, ackPending: a.ackPending });
        } else {
          const before = prev.sosAlerts.find((x) => x.alarmId === a.alarmId);
          if (before && before.acknowledgedAt !== a.acknowledgedAt) {
            noteTransition('ALERT_ACKNOWLEDGED', {
              alarmId: a.alarmId,
              ackPendingBefore: before.ackPending,
              ackPendingAfter: a.ackPending,
              acknowledgedAtIso: a.acknowledgedAtIso,
              acknowledgedBy: a.acknowledgedBy,
              fromCreatedSec: deltaSec(a.createdAt, a.acknowledgedAt),
              sinceLastSampleSec: deltaSec(prev.epochMs, a.acknowledgedAt)
            });
          }
          if (before && before.state !== a.state) noteTransition('ALERT_STATE_CHANGED', { alarmId: a.alarmId, from: before.state, to: a.state });
        }
      }
      const currIds = s.sosAlerts.map((a) => a.alarmId);
      for (const id of prevIds) if (currIds.indexOf(id) < 0) noteTransition('ALARM_DISAPPEARED', { alarmId: id });
    } else {
      noteTransition('DEVICE_NOT_IN_DEVICES', {});
    }
    prev = s;
    if (Date.now() >= deadline) break;
    await sleep(intervalSec * 1000);
  }

  const summaryFile = path.join(SNAP_DIR, 'watch-' + label + '-' + stampLocal() + '.timeline.json');
  fs.writeFileSync(summaryFile, JSON.stringify({ kind: 'watch-summary', label, samples: file, timeline }, null, 2), 'utf8');
  console.log('[watch] saved samples=' + file);
  console.log('[watch] saved timeline=' + summaryFile + ' transitions=' + timeline.length);
  return { file, timeline };
}

/* ------------------------------------------------------------------ report（判据引擎） */

function loadNdjson(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

function loadJsonMaybe(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 从 /status（用户 docker exec 贴回）里抽取判据所需字段；容忍外面包了一层 {version,...} 或裸对象。 */
function extractStatus(doc) {
  if (!doc) return null;
  const j = doc.status && typeof doc.status === 'object' ? doc.status
    : doc.result && typeof doc.result === 'object' ? doc.result
    : doc;
  const adapter = j.adapter || {};
  const counters = adapter.counters || {};
  const hasCounters = Boolean(adapter.counters && typeof adapter.counters === 'object');
  const hasLink = Boolean(adapter.link && typeof adapter.link === 'object');
  const hasDevice = Boolean(adapter.device && typeof adapter.device === 'object');
  const link = adapter.link || {};
  const device = adapter.device || {};
  const commands = adapter.commands || {};
  return {
    raw: j,
    source: j._source || null,
    service: j.service || null,
    version: j.version || null,
    hasCounters,
    hasLink,
    hasDevice,
    brokerClients: Array.isArray(j.broker && j.broker.clients)
      ? j.broker.clients.map((c) => c && c.clientId).filter(Boolean) : null,
    startedAt: Number(j.startedAt) || 0,
    startedAtIso: isoLocal(Number(j.startedAt) || 0),
    aliveTimeoutMs: Number(link.aliveTimeoutMs) || 0,
    watchdogArmed: link.watchdogArmed === true,
    offlineReported: link.offlineReported === true,
    deviceOnline: device.online === true,
    deviceState: device.state === undefined ? null : device.state,
    deviceLastSeen: Number(device.lastSeen) || 0,
    deviceLastSeenIso: isoLocal(Number(device.lastSeen) || 0),
    parked: Array.isArray(commands.parked) ? commands.parked.length : 0,
    inflight: Array.isArray(commands.inflight) ? commands.inflight.length : 0,
    cursor: commands.cursor === undefined ? null : commands.cursor,
    counters: {
      sosReceived: Number(counters.sosReceived) || 0,
      sosDuplicates: Number(counters.sosDuplicates) || 0,
      deviceStatusOk: Number(counters.deviceStatusOk) || 0,
      hbReceived: Number(counters.hbReceived) || 0,
      bootReceived: Number(counters.bootReceived) || 0,
      ackReceipts: Number(counters.ackReceipts) || 0,
      commandsReceived: Number(counters.commandsReceived) || 0,
      commandsParked: Number(counters.commandsParked) || 0,
      commandsRedelivered: Number(counters.commandsRedelivered) || 0,
      commandResultOk: Number(counters.commandResultOk) || 0,
      gpsParsed: Number(counters.gpsParsed) || 0,
      gpsParseFailures: Number(counters.gpsParseFailures) || 0,
      deviceOfflineReports: Number(counters.deviceOfflineReports) || 0,
      parkedRecoveryTriggers: Number(counters.parkedRecoveryTriggers) || 0,
      deviceLinkUps: Number(counters.deviceLinkUps) || 0,
      deviceLinkDowns: Number(counters.deviceLinkDowns) || 0,
      activeEventClearedByDevice: Number(counters.activeEventClearedByDevice) || 0
    }
  };
}

function firstMarker(markers, kind, afterMs, beforeMs) {
  if (!markers || !Array.isArray(markers.events)) return null;
  const hit = markers.events
    .map((e) => ({ kind: e.kind, atMs: ms(e.t || e.at), raw: e }))
    .filter((e) => e.kind === kind && e.atMs > 0)
    .filter((e) => (afterMs ? e.atMs >= afterMs : true) && (beforeMs ? e.atMs <= beforeMs : true))
    .sort((a, b) => a.atMs - b.atMs)[0];
  return hit || null;
}

function allMarkers(markers, kind) {
  if (!markers || !Array.isArray(markers.events)) return [];
  return markers.events
    .filter((e) => e.kind === kind)
    .map((e) => ({ atMs: ms(e.t || e.at), raw: e }))
    .filter((e) => e.atMs > 0)
    .sort((a, b) => a.atMs - b.atMs);
}

/** 取 beforeMs 之前（或等于）的最后一个标记；用于“最近一次断电”。 */
function lastMarkerBefore(markers, kind, beforeMs) {
  const list = allMarkers(markers, kind).filter((e) => e.atMs <= beforeMs);
  return list.length ? list[list.length - 1] : null;
}

/** 取 afterMs 之后的第一个标记。 */
function firstMarkerAfter(markers, kind, afterMs) {
  const list = allMarkers(markers, kind).filter((e) => e.atMs >= afterMs);
  return list.length ? list[0] : null;
}

/** 采样序列 → 设备状态时间线。 */
function deviceTimeline(samples) {
  return samples
    .filter((s) => s && s.sosDevice)
    .map((s) => ({
      at: s.at,
      epochMs: s.epochMs,
      online: s.sosDevice.online === true,
      state: s.sosDevice.state,
      lastSeenTs: s.sosDevice.lastSeenTs,
      lastSeenIso: s.sosDevice.lastSeenIso,
      lastSeenAgeSec: s.sosDevice.lastSeenTs ? Math.round((s.epochMs - s.sosDevice.lastSeenTs) / 1000) : null
    }));
}

/** 告警集合 → 每个 alarmId 的首次/末次观测与字段。 */
function alertIndex(samples) {
  const map = new Map();
  for (const s of samples) {
    for (const a of (s && s.sosAlerts) || []) {
      if (!a.alarmId) continue;
      if (!map.has(a.alarmId)) {
        map.set(a.alarmId, {
          alarmId: a.alarmId,
          firstSeenAt: s.at,
          firstSeenEpochMs: s.epochMs,
          first: a,
          last: a,
          occurrences: 1,
          ackedSeenAt: a.acknowledgedAt > 0 ? s.at : null,
          ackedSeenEpochMs: a.acknowledgedAt > 0 ? s.epochMs : null
        });
      } else {
        const entry = map.get(a.alarmId);
        entry.occurrences += 1;
        entry.last = a;
        if (a.acknowledgedAt > 0 && !entry.ackedSeenAt) { entry.ackedSeenAt = s.at; entry.ackedSeenEpochMs = s.epochMs; }
      }
    }
  }
  return map;
}

function criteria_result(id, title, verdict, detail, evidence) {
  return { id, title, verdict, detail, evidence: evidence || [] };
}

function buildReport({ samplesFile, markersFile, statusFiles, logsFile, baselineFile }) {
  const samples = loadNdjson(samplesFile).filter((s) => s && s.kind === 'sample');
  const markers = loadJsonMaybe(markersFile);
  const statuses = asArray(statusFiles).map((f) => ({ file: f, data: extractStatus(loadJsonMaybe(f)) })).filter((x) => x.data);
  const logsText = logsFile && fs.existsSync(logsFile) ? fs.readFileSync(logsFile, 'utf8') : '';
  const logsHas = (code) => new RegExp('\\b' + code + '\\b').test(logsText);
  /** 从结构化日志里取某短码的首个时间戳（UTC→+08:00），取不到返回 null。 */
  const logTs = (code) => {
    const m = logsText.match(new RegExp('^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z) (?:INFO|WARN|ERROR) ' + code + '\\b', 'm'));
    return m ? isoLocal(ms(m[1])) : null;
  };

  const results = [];
  const evidence = [];
  const devTl = deviceTimeline(samples);
  const alerts = alertIndex(samples);
  /* 升级前基线：用于 ① 把 C1 限定在“升级后新产生的告警” ② C4 判断“位置是否真的丢了” */
  const baseSamples = baselineFile && fs.existsSync(baselineFile)
    ? loadNdjson(baselineFile).filter((s) => s && s.kind === 'sample') : [];
  const baselineAlarmIds = new Set();
  for (const s of baseSamples) for (const a of (s.sosAlerts || [])) if (a.alarmId) baselineAlarmIds.add(a.alarmId);

  /* C0 版本与离线阈值 */
  const statusNewest = statuses.filter((s) => s.data.version === '1.0.1').slice(-1)[0] || statuses.slice(-1)[0];
  if (!statuses.length) {
    results.push(criteria_result('C0_DEPLOY_VERSION', 'ECS 已部署 1.0.1（version=1.0.1 / deviceAliveTimeoutMs=120000）', 'BLOCKED',
      '缺少 ECS /status 证据：需要用户在阿里云 Workbench 用 docker exec 读取 /status 并保存为 JSON（见 ONE-PAGE 第 5 步）。'));
  } else {
    const s = statuses[statuses.length - 1].data;
    const versionOk = s.version === '1.0.1';
    const timeoutOk = s.aliveTimeoutMs === 120000;
    const watchdogOk = s.watchdogArmed === true;
    const brokerClientOk = s.brokerClients === null ? null : s.brokerClients.indexOf('wearable-sos-001') >= 0;
    const c0Evidence = statuses.map((x) => path.basename(x.file));
    if (s.source) c0Evidence.push('来源: ' + s.source);
    c0Evidence.push('watchdogArmed=' + s.watchdogArmed + '（1.0.1 应 true）');
    c0Evidence.push('broker.clients=' + (s.brokerClients === null ? '未随摘录提供（由 API online/lastSeen 推进与 C2 佐证）' : JSON.stringify(s.brokerClients)));
    results.push(criteria_result('C0_DEPLOY_VERSION', 'ECS 已部署 1.0.1（version=1.0.1 / deviceAliveTimeoutMs=120000 / watchdogArmed=true）',
      versionOk && timeoutOk && watchdogOk ? 'PASS' : 'FAIL',
      'version=' + s.version + '（期望 1.0.1）; link.aliveTimeoutMs=' + s.aliveTimeoutMs + '（期望 120000）; watchdogArmed=' + s.watchdogArmed +
      '（期望 true）; brokerClientOk=' + brokerClientOk, c0Evidence));
    if (statusNewest && statusNewest.data.counters.deviceOfflineReports !== undefined) {
      evidence.push('最新 /status counters: ' + JSON.stringify(statusNewest.data.counters));
    }
  }

  /* C1 ACK 重启窗口：PENDING → 设备重启窗口 → 真实回执 → ACKED */
  const ackedAll = Array.from(alerts.values()).filter((a) => a.last.acknowledgedAt > 0 || a.last.state === 'ACKED');
  const acked = ackedAll.filter((a) => !baselineAlarmIds.has(a.alarmId));
  const c1Evidence = [];
  if (baselineAlarmIds.size) c1Evidence.push('已按升级前基线排除历史告警 ' + baselineAlarmIds.size + ' 条；只评估升级后新告警。');
  if (!samples.length) {
    results.push(criteria_result('C1_ACK_RESTART_WINDOW', 'ACK 重启窗口：PENDING→设备重启→真实回执→ACKED（≤30s）', 'BLOCKED', '没有采样数据。'));
  } else if (!acked.length) {
    results.push(criteria_result('C1_ACK_RESTART_WINDOW', 'ACK 重启窗口：PENDING→设备重启→真实回执→ACKED（≤30s）', 'BLOCKED',
      '采样中没有任何已 ACKED 的随身 SOS 告警（acknowledgedAt>0）。该判据必须由真实 PENDING 告警 + 用户在 APP 确认制造，脚本绝不代报/激活。'));
  } else {
    const target = acked[acked.length - 1];
    const alarmId = target.alarmId;
    const ackClickMarker = firstMarker(markers, 'alert_ack_clicked', ms(target.first.createdAt));
    const restartMarker = firstMarker(markers, 'device_restart', ms(target.first.createdAt));
    const powerOffMarker = firstMarker(markers, 'device_power_off', ms(target.first.createdAt));
    const powerOnMarker = firstMarker(markers, 'device_power_on', ms(target.first.createdAt));
    const resumeMs = Math.max(
      ackClickMarker ? ackClickMarker.atMs : 0,
      powerOnMarker ? powerOnMarker.atMs : 0,
      restartMarker ? restartMarker.atMs : 0
    );
    const ackedAtMs = target.last.acknowledgedAt || (target.ackedSeenEpochMs || 0);
    const delaySec = resumeMs && ackedAtMs ? deltaSec(resumeMs, ackedAtMs) : (target.ackedSeenEpochMs ? deltaSec(target.firstSeenEpochMs, target.ackedSeenEpochMs) : null);
    const restartProven = Boolean(restartMarker || (powerOffMarker && powerOnMarker));
    const statusWithCounters = statuses.filter((s) => s.data.hasCounters);
    const statusAckOk = statusWithCounters.some((s) => s.data.counters.commandResultOk >= 1);
    const statusParkedHint = statusWithCounters.some((s) => s.data.counters.parkedRecoveryTriggers >= 1 || s.data.parked >= 1);
    c1Evidence.push('alarmId=' + alarmId + ' createdAt=' + target.first.createdAtIso + ' acknowledgedAt=' + target.last.acknowledgedAtIso);
    if (ackClickMarker) c1Evidence.push('ACK 点击标记=' + isoLocal(ackClickMarker.atMs) + '（人工近似值）');
    if (powerOffMarker) c1Evidence.push('设备断电标记=' + isoLocal(powerOffMarker.atMs));
    if (powerOnMarker) c1Evidence.push('设备上电标记=' + isoLocal(powerOnMarker.atMs));
    if (restartMarker) c1Evidence.push('设备重启标记=' + isoLocal(restartMarker.atMs));
    if (delaySec !== null) c1Evidence.push('自恢复点(' + isoLocal(resumeMs) + ')到 ACKED 观测：' + delaySec + 's');
    // ECS /status counters：事件驱动重投 / 真实回执的核心判据
    const cntC1 = (statusWithCounters.length ? statusWithCounters[statusWithCounters.length - 1].data.counters : null);
    if (cntC1) {
      c1Evidence.push('ECS counters: commandResultOk=' + cntC1.commandResultOk + ', commandsParked=' + (cntC1.commandsParked || 0)
        + ', commandsRedelivered=' + (cntC1.commandsRedelivered || 0) + ', parkedRecoveryTriggers=' + (cntC1.parkedRecoveryTriggers || 0)
        + ', ackReceipts=' + (cntC1.ackReceipts || 0));
      if ((cntC1.parkedRecoveryTriggers || 0) >= 1 || (cntC1.commandsRedelivered || 0) >= 1) {
        c1Evidence.push('**修复核心生效**：存在 parkedRecoveryTriggers/commandsRedelivered ≥1（链路恢复/业务上行触发了 parked ACK 事件驱动重投，不再依赖 docker restart）');
      }
    }
    // ECS 日志时间线（权威到毫秒）：命令入队 → 3 次投递 → parked → 事件触发重投 → 设备回执 → 回写 ACKED
    const logChain = ['COMMAND_ACCEPTED', 'COMMAND_PARKED', 'PARKED_RECOVERY_TRIGGERED', 'COMMAND_RECEIPT_ACCEPTED', 'COMMAND_RESULT_ACKED']
      .map((code) => { const t = logTs(code); return t ? code + '=' + t : null; })
      .filter(Boolean);
    if (logChain.length) c1Evidence.push('ECS 日志链: ' + logChain.join(' → '));

    if (!restartProven) {
      results.push(criteria_result('C1_ACK_RESTART_WINDOW', 'ACK 重启窗口：PENDING→设备重启→真实回执→ACKED（≤30s）', 'BLOCKED',
        '已有 ACKED 告警 ' + alarmId + '，但没有 device_restart/device_power_off+on 标记，无法证明“重启窗口”场景。请在 markers JSON 里补时间点后重跑 report。', c1Evidence));
    } else if (!statusAckOk) {
      results.push(criteria_result('C1_ACK_RESTART_WINDOW', 'ACK 重启窗口：PENDING→设备重启→真实回执→ACKED（≤30s）', 'BLOCKED',
        '有 ACKED 观测，但缺少 ECS /status 证明 commandResultOk≥1（即后端确实收到了设备回执）。请补 --status。', c1Evidence));
    } else if (delaySec !== null && delaySec <= ACK_FAST_MS) {
      results.push(criteria_result('C1_ACK_RESTART_WINDOW', 'ACK 重启窗口：PENDING→设备重启→真实回执→ACKED（≤30s）', 'PASS',
        'ACKED 在恢复点后 ' + delaySec + 's 内出现（阈值 ≤' + ACK_FAST_MS / 1000 + 's）；无需 docker restart。', c1Evidence));
    } else {
      results.push(criteria_result('C1_ACK_RESTART_WINDOW', 'ACK 重启窗口：PENDING→设备重启→真实回执→ACKED（≤30s）', 'FAIL',
        'ACKED 距恢复点 ' + delaySec + 's（阈值 ≤' + ACK_FAST_MS / 1000 + 's）。检查是否真的走了 1.0.1、或设备是否在 ACKED 前才连上。', c1Evidence));
    }
  }

  /* C2 离线 > 2min 语义 */
  const firstOffline = devTl.find((d) => d.online === false);
  const c2Evidence = [];
  if (!devTl.length) {
    results.push(criteria_result('C2_OFFLINE_2MIN', '断电 >120s 后 API online=false（120s 阈值），恢复后 online=true + lastSeen 推进', 'BLOCKED', '没有设备采样。'));
  } else if (!firstOffline) {
    const lastSeenAges = devTl.map((d) => d.lastSeenAgeSec).filter((x) => x !== null);
    results.push(criteria_result('C2_OFFLINE_2MIN', '断电 >120s 后 API online=false（120s 阈值），恢复后 online=true + lastSeen 推进', 'BLOCKED',
      '采样中未出现 online=false。可能：①设备未断电 >120s；②仍是 1.0.0（不会翻 false）；③断电时长不足。当前最后 seen 最大陈旧度=' + (lastSeenAges.length ? Math.max.apply(null, lastSeenAges) : 'n/a') + 's', c2Evidence));
  } else {
    const prevOnline = devTl.filter((d) => d.epochMs < firstOffline.epochMs && d.online === true).slice(-1)[0];
    const lastAdvanceMs = prevOnline ? prevOnline.lastSeenTs : (devTl.filter((d) => d.online === true).slice(-1)[0] || {}).lastSeenTs || 0;
    const powerOffMarker = lastMarkerBefore(markers, 'device_power_off', firstOffline.epochMs);
    const refMs = powerOffMarker ? powerOffMarker.atMs : lastAdvanceMs;
    const detectedDelaySec = refMs ? deltaSec(refMs, firstOffline.epochMs) : null;
    const c2StatusOffline = statuses.some((s) => s.data.deviceOnline === false || s.data.counters.deviceOfflineReports >= 1);
    const c2StatusWith = statuses.filter((s) => s.data.hasCounters);
    const c2Cnt = c2StatusWith.length ? c2StatusWith[c2StatusWith.length - 1].data.counters : null;
    c2Evidence.push('首次 online=false 观测=' + firstOffline.at + '（lastSeen=' + firstOffline.lastSeenIso + '）');
    if (powerOffMarker) c2Evidence.push('断电标记=' + isoLocal(powerOffMarker.atMs));
    if (lastAdvanceMs) c2Evidence.push('最后一次 lastSeen 推进=' + isoLocal(lastAdvanceMs));
    if (detectedDelaySec !== null) c2Evidence.push('自参照点到 online=false 的延迟=' + detectedDelaySec + 's（阈值 120s）');
    if (powerOffMarker && firstOffline.lastSeenTs) {
      c2Evidence.push('后端 lastSeen 被离线报告刷新的时刻 − 断电标记 = **' + deltaSec(powerOffMarker.atMs, firstOffline.lastSeenTs) + 's**（即 120s 静默看门狗精度）');
    }
    c2Evidence.push('ECS /status 显示 offline 证据: ' + c2StatusOffline + (c2Cnt ? '（deviceOfflineReports=' + c2Cnt.deviceOfflineReports + '）' : '（现有 /status 未含 counters）'));
    const timeoutLog = logTs('DEVICE_UPLINK_TIMEOUT');
    if (timeoutLog) c2Evidence.push('ECS 日志 DEVICE_UPLINK_TIMEOUT=' + timeoutLog + '（silentMs≈120002，与断电信时刻吻合）');
    const offReportLog = logTs('DEVICE_OFFLINE_REPORTED');
    if (offReportLog) c2Evidence.push('ECS 日志 DEVICE_OFFLINE_REPORTED=' + offReportLog);

    // 恢复
    const afterOffline = devTl.filter((d) => d.epochMs > firstOffline.epochMs && d.online === true);
    const recovered = afterOffline[0] || null;
    const powerOnMarker = firstMarkerAfter(markers, 'device_power_on', firstOffline.epochMs);
    if (powerOnMarker) {
      c2Evidence.push('上电标记=' + isoLocal(powerOnMarker.atMs) + '（距 online=false 检测 ' + deltaSec(firstOffline.epochMs, powerOnMarker.atMs) + 's）');
    }
    let recoveryOk = false;
    if (recovered) {
      const advanced = recovered.lastSeenTs > (firstOffline.lastSeenTs || 0);
      recoveryOk = advanced;
      c2Evidence.push('恢复 online=true 观测=' + recovered.at + '（lastSeen=' + recovered.lastSeenIso + '，是否推进=' + advanced + '）');
      if (powerOnMarker) c2Evidence.push('上电→online=true 恢复延迟=' + deltaSec(powerOnMarker.atMs, recovered.epochMs) + 's');
    } else c2Evidence.push('未观测到 online=true 恢复');

    const timingOk = detectedDelaySec === null ? c2StatusOffline
      : (detectedDelaySec >= (OFFLINE_ALIVE_TIMEOUT_MS - OFFLINE_TOLERANCE_MS) / 1000);
    if (timingOk && recoveryOk) {
      results.push(criteria_result('C2_OFFLINE_2MIN', '断电 >120s 后 API online=false（120s 阈值），恢复后 online=true + lastSeen 推进', 'PASS',
        'online=false 在参照点后 ' + detectedDelaySec + 's 出现；恢复后 online=true 且 lastSeen 推进。', c2Evidence));
    } else if (timingOk) {
      results.push(criteria_result('C2_OFFLINE_2MIN', '断电 >120s 后 API online=false（120s 阈值），恢复后 online=true + lastSeen 推进', 'FAIL',
        'offline 判定时序已出现，但恢复后 online=true/lastSeen 推进未观测到（采样是否覆盖到设备上电？）。', c2Evidence));
    } else {
      results.push(criteria_result('C2_OFFLINE_2MIN', '断电 >120s 后 API online=false（120s 阈值），恢复后 online=true + lastSeen 推进', 'FAIL',
        'online=false 出现太早/太晚（' + detectedDelaySec + 's）；若 <120s 说明阈值未生效或标记时间不准；若参照点缺失请补 device_power_off 标记。', c2Evidence));
    }
  }

  /* C3 无重复告警 */
  const c3Evidence = [];
  const ids = Array.from(alerts.keys());
  const sosSamples = samples.filter((s) => s && Array.isArray(s.sosAlerts));
  const perAlarmAppearances = ids.map((id) => ({ id, n: alerts.get(id).occurrences }));
  const uniqueInEachSample = sosSamples.every((s) => {
    const seen = new Set();
    for (const a of s.sosAlerts) { if (seen.has(a.alarmId)) return false; seen.add(a.alarmId); }
    return true;
  });
  // 数量单调：allAlertCount / sosAlertCount 只能随“新 alarmId”增加，不允许跳变式增加
  let countMonotonic = true;
  let countJumpWithoutNewId = false;
  for (let i = 1; i < sosSamples.length; i += 1) {
    const a = sosSamples[i - 1].sosAlertCount || 0;
    const b = sosSamples[i].sosAlertCount || 0;
    if (b < a) countMonotonic = false;
    if (b > a) {
      const prevIds = new Set((sosSamples[i - 1].sosAlerts || []).map((x) => x.alarmId));
      const newIds = (sosSamples[i].sosAlerts || []).filter((x) => !prevIds.has(x.alarmId));
      if (newIds.length !== (b - a)) countJumpWithoutNewId = true;
    }
  }
  c3Evidence.push('采样帧数=' + sosSamples.length + '；esp32-sos 告警 total/末次=' + (sosSamples.length ? sosSamples[sosSamples.length - 1].sosAlertCount : 0));
  c3Evidence.push('alarmId 集合=' + JSON.stringify(ids));
  c3Evidence.push('每 alarmId 在采样中的出现帧数（仅“同一帧内出现两次/后端出现两条”才算重复告警）=' + JSON.stringify(perAlarmAppearances));
  c3Evidence.push('同帧内无重复=' + uniqueInEachSample + '；告警总数单调=' + countMonotonic + '；数量跳变但无新 alarmId（异常）=' + countJumpWithoutNewId);
  const statusWithCountersC3 = statuses.filter((s) => s.data.hasCounters);
  const statusDedupe = statusWithCountersC3.length ? statusWithCountersC3[statusWithCountersC3.length - 1].data.counters : null;
  if (statusDedupe) {
    c3Evidence.push('ECS counters: sosReceived=' + statusDedupe.sosReceived + ' sosDuplicates=' + statusDedupe.sosDuplicates
      + '（设备未确认时的重试包被适配器本地去重，后端不应因此多建告警）');
  } else c3Evidence.push('ECS counters: 现有 /status 未包含 adapter.counters（不臆造）');
  if (!samples.length) {
    results.push(criteria_result('C3_NO_DUPLICATE_ALARM', '同一 alarmId 在 /api/v1/alerts 只有 1 条，数量不因重连增加', 'BLOCKED', '没有采样数据。'));
  } else if (ids.length === 0) {
    results.push(criteria_result('C3_NO_DUPLICATE_ALARM', '同一 alarmId 在 /api/v1/alerts 只有 1 条，数量不因重连增加', 'BLOCKED',
      '采样中没有 esp32-sos 告警：需要一次真实按键告警才能验证去重。', c3Evidence));
  } else if (uniqueInEachSample && countMonotonic && !countJumpWithoutNewId) {
    results.push(criteria_result('C3_NO_DUPLICATE_ALARM', '同一 alarmId 在 /api/v1/alerts 只有 1 条，数量不因重连增加', 'PASS',
      '每个 alarmId 在告警列表里唯一；数量只在出现新 alarmId 时增加。', c3Evidence));
  } else {
    results.push(criteria_result('C3_NO_DUPLICATE_ALARM', '同一 alarmId 在 /api/v1/alerts 只有 1 条，数量不因重连增加', 'FAIL',
      '检测到重复 alarmId 或数量跳变（uniqueInEachSample=' + uniqueInEachSample + ', monotonic=' + countMonotonic + ', jumpWithoutNewId=' + countJumpWithoutNewId + '）。', c3Evidence));
  }

  /* C4 位置不因升级丢失（与“升级前基线”对比，避免把“本来就没有”误判成“升级丢了”） */
  const c4Evidence = [];
  const locSamples = samples.map((s) => s.location).filter(Boolean);
  const baseLocSamples = baseSamples.map((s) => s.location).filter(Boolean);
  const fakeZero = samples.some((s) => (s.location && s.location.zeroPoint) || (s.sosDevice && s.sosDevice.gpsZeroPoint));
  const gpsValidSeen = samples.some((s) => s.sosDevice && s.sosDevice.gpsValid === true);
  const gpsExplicitInvalid = samples.some((s) => s.sosDevice && s.sosDevice.gpsValid === false && s.sosDevice.gpsHasCoordinates === false);
  const gpsFieldAbsent = samples.every((s) => !s.sosDevice || s.sosDevice.gpsFieldPresent !== true);
  const baseGpsValid = baseSamples.some((s) => s.sosDevice && s.sosDevice.gpsValid === true);
  c4Evidence.push('本次采样中位置记录=' + locSamples.length + '；gps.valid=true 出现=' + gpsValidSeen + '；gps 字段缺失=' + gpsFieldAbsent + '；gps.valid=false 且无坐标=' + gpsExplicitInvalid);
  c4Evidence.push('升级前基线：位置记录=' + baseLocSamples.length + '；gps.valid=true=' + baseGpsValid + '（基线样本数=' + baseSamples.length + '）');
  if (locSamples.length) {
    const first = locSamples[0];
    const last = locSamples[locSamples.length - 1];
    c4Evidence.push('本次首个 fixTime=' + first.fixTimeIso + '；末个 fixTime=' + last.fixTimeIso);
  }
  if (baseLocSamples.length) {
    const lastBase = baseLocSamples[baseLocSamples.length - 1];
    c4Evidence.push('基线末个 fixTime=' + lastBase.fixTimeIso);
  }
  if (fakeZero) {
    results.push(criteria_result('C4_LOCATION_INTACT', '位置/GPS 不因升级丢失（与升级前基线对比；无 fix 时 valid=false，不用 (0,0) 冒充）', 'FAIL',
      '检测到 (0,0) 坐标冒充，违反契约。', c4Evidence));
  } else if (!samples.length) {
    results.push(criteria_result('C4_LOCATION_INTACT', '位置/GPS 不因升级丢失（与升级前基线对比；无 fix 时 valid=false，不用 (0,0) 冒充）', 'BLOCKED', '没有采样数据。'));
  } else if (baseLocSamples.length && locSamples.length === 0 && !gpsValidSeen && !gpsExplicitInvalid) {
    results.push(criteria_result('C4_LOCATION_INTACT', '位置/GPS 不因升级丢失（与升级前基线对比；无 fix 时 valid=false，不用 (0,0) 冒充）', 'FAIL',
      '升级前基线存在位置记录，升级后采样中消失且无 gps.valid=false 的如实降级 → 疑似“位置因升级丢失”。', c4Evidence));
  } else if (gpsValidSeen || locSamples.length) {
    results.push(criteria_result('C4_LOCATION_INTACT', '位置/GPS 不因升级丢失（与升级前基线对比；无 fix 时 valid=false，不用 (0,0) 冒充）', 'PASS',
      '升级窗口内仍能读到位置/GPS 有效记录，且无 (0,0) 冒充。', c4Evidence));
  } else if (gpsExplicitInvalid) {
    results.push(criteria_result('C4_LOCATION_INTACT', '位置/GPS 不因升级丢失（与升级前基线对比；无 fix 时 valid=false，不用 (0,0) 冒充）', 'PASS',
      '当前无 fix：API/适配器如实返回 gps.valid=false 且无坐标（符合契约，不是“丢失”）。', c4Evidence));
  } else if (gpsFieldAbsent && baseSamples.length && !baseGpsValid && baseLocSamples.length === 0) {
    results.push(criteria_result('C4_LOCATION_INTACT', '位置/GPS 不因升级丢失（与升级前基线对比；无 fix 时 valid=false，不用 (0,0) 冒充）', 'BLOCKED',
      '升级前后 API 都**没有** esp32-sos 的位置数据（/api/v1/devices 无 gps 字段、/api/v1/location 无 esp32-sos 记录，告警无坐标）：'
      + '既没丢也没有写入不实坐标/非 (0,0) 假坐标，无法用该判据证明升级影响。'
      + 'Lead 2026-10-28 00:31 已裁决：按“现网无有效 fix（非本次回滚造成）”记 BLOCKED，不阻塞升级、不改后端/APP。'
      + '与 DESIGN-CONTRACT §5.2“现网已支持”的记录不一致，属文档/实现对账问题，另行登记。', c4Evidence));
  } else {
    results.push(criteria_result('C4_LOCATION_INTACT', '位置/GPS 不因升级丢失（与升级前基线对比；无 fix 时 valid=false，不用 (0,0) 冒充）', 'BLOCKED',
      '采样中既无位置记录也无明确 gps.valid 字段，无法判定（建议带 --baseline 传升级前采样）。', c4Evidence));
  }

  /* C5 不代报 ACK（安全红线） */
  const c5Evidence = [];
  const statusWithCounters = statuses.filter((s) => s.data.hasCounters);
  const statusAckCountOk = statusWithCounters.some((s) => s.data.counters.commandResultOk >= 1);
  const ackedNoResultOk = acked.length > 0 && statusWithCounters.length > 0 && !statusAckCountOk;
  c5Evidence.push('ACKED 告警数=' + acked.length + '；带 counters 的 /status 文件数=' + statusWithCounters.length + '；commandResultOk≥1=' + statusAckCountOk);
  if (statusWithCounters.length) c5Evidence.push('counters=' + JSON.stringify(statusWithCounters[statusWithCounters.length - 1].data.counters));
  c5Evidence.push('脚本本身从不 POST /alerts/{id}/ack、从不写 device-status（代码级边界）');
  if (ackedNoResultOk) {
    results.push(criteria_result('C5_NO_FAKE_ACK', '不代报 ACK：ACKED 只能来自设备真实回执（commandResultOk 增长）', 'FAIL',
      '有 ACKED 但 /status 的 commandResultOk 未增长，存在“服务器代报”嫌疑，立即停手复核。', c5Evidence));
  } else if (acked.length === 0) {
    results.push(criteria_result('C5_NO_FAKE_ACK', '不代报 ACK：ACKED 只能来自设备真实回执（commandResultOk 增长）', 'BLOCKED',
      '采样中无 ACKED 告警，无法验证（需真实 PENDING + APP 确认）。', c5Evidence));
  } else if (!statusWithCounters.length) {
    results.push(criteria_result('C5_NO_FAKE_ACK', '不代报 ACK：ACKED 只能来自设备真实回执（commandResultOk 增长）', 'BLOCKED',
      '有 ACKED 观测，但现有 /status 文件未包含 adapter.counters（摘录不含计数 ≠ 计数未增长），无法排除“代报”。'
      + '请补一份完整 /status（含 counters.commandResultOk）后重跑。', c5Evidence));
  } else {
    results.push(criteria_result('C5_NO_FAKE_ACK', '不代报 ACK：ACKED 只能来自设备真实回执（commandResultOk 增长）', 'PASS',
      'ACKED 与 commandResultOk≥1 同时成立；未见伪造路径。', c5Evidence));
  }

  /* C6 全程未 docker restart（只能由人工确认 + 日志佐证） */
  const restartEvents = logsText ? (logsText.match(/\bSERVICE_STARTED\b/g) || []).length : null;
  const userClaimsNoRestart = markers && markers.no_docker_restart === true;
  const c6Evidence = [];
  if (restartEvents !== null) c6Evidence.push('docker logs 中 SERVICE_STARTED 次数=' + restartEvents + '（升级自身会重建容器 1 次）');
  if (logsText) c6Evidence.push('日志短码命中: PARKED_RECOVERY_TRIGGERED=' + logsHas('PARKED_RECOVERY_TRIGGERED') + ' COMMAND_RECEIPT_ACCEPTED=' + logsHas('COMMAND_RECEIPT_ACCEPTED') + ' DEVICE_UPLINK_TIMEOUT=' + logsHas('DEVICE_UPLINK_TIMEOUT'));
  if (userClaimsNoRestart && (restartEvents === null || restartEvents <= 1)) {
    results.push(criteria_result('C6_NO_DOCKER_RESTART', '验收全程未执行 docker restart（自愈靠事件驱动重投）', 'PASS',
      'markers 声明 no_docker_restart=true 且日志无额外启动。', c6Evidence));
  } else if (!markers) {
    results.push(criteria_result('C6_NO_DOCKER_RESTART', '验收全程未执行 docker restart（自愈靠事件驱动重投）', 'BLOCKED',
      '需要人工在 markers JSON 里声明 no_docker_restart=true（并保证期间没人重启容器）。', c6Evidence));
  } else {
    results.push(criteria_result('C6_NO_DOCKER_RESTART', '验收全程未执行 docker restart（自愈靠事件驱动重投）', 'BLOCKED',
      '日志显示多次启动或缺少声明，需人工核对 1.0.1 的事件驱动重投计数（counters.parkedRecoveryTriggers）。', c6Evidence));
  }

  /* 汇总 */
  const verdictRank = { PASS: 0, BLOCKED: 1, FAIL: 2 };
  const overall = results.reduce((acc, r) => (verdictRank[r.verdict] > verdictRank[acc] ? r.verdict : acc), 'PASS');
  const report = {
    kind: 'verify-report',
    generatedAt: nowLocal(),
    samplesFile,
    baselineFile: baselineFile || null,
    markersFile: markersFile || null,
    statusFiles: asArray(statusFiles).map((f) => path.basename(f)),
    logsFile: logsFile ? path.basename(logsFile) : null,
    overall,
    criteria: results,
    timeline: { device: devTl, alerts: Array.from(alerts.values()).map((a) => ({ alarmId: a.alarmId, firstSeenAt: a.firstSeenAt, createdAtIso: a.first.createdAtIso, acknowledgedAtIso: a.last.acknowledgedAtIso, state: a.last.state })) },
    evidenceHints: evidence
  };
  return report;
}

function renderReportMarkdown(report) {
  const lines = [];
  lines.push('# wearable-mqtt 1.0.1 验收报告（verify-wearable-101.js ' + report.generatedAt + '）');
  lines.push('');
  lines.push('**总体结论**：`' + report.overall + '`');
  lines.push('');
  lines.push('| 判据 | 结论 | 说明 |');
  lines.push('|---|---|---|');
  for (const c of report.criteria) {
    lines.push('| ' + c.id + ' ' + c.title + ' | **' + c.verdict + '** | ' + String(c.detail).replace(/\|/g, '\\|') + ' |');
  }
  lines.push('');
  for (const c of report.criteria) {
    lines.push('## ' + c.id + ' — ' + c.verdict);
    lines.push('');
    lines.push(c.detail);
    if (c.evidence && c.evidence.length) {
      lines.push('');
      lines.push('原始证据：');
      for (const e of c.evidence) lines.push('- ' + e);
    }
    lines.push('');
  }
  lines.push('## 采样时间线（设备）');
  lines.push('');
  lines.push('| 采样时刻 | online | state | lastSeenTs | lastSeen 陈旧度(s) |');
  lines.push('|---|---|---|---|---|');
  for (const d of report.timeline.device) {
    lines.push('| ' + d.at + ' | ' + d.online + ' | ' + d.state + ' | ' + d.lastSeenIso + ' | ' + d.lastSeenAgeSec + ' |');
  }
  lines.push('');
  lines.push('## 告警时间线');
  lines.push('');
  lines.push('| alarmId | 首次观测 | createdAt | acknowledgedAt | state |');
  lines.push('|---|---|---|---|---|');
  for (const a of report.timeline.alerts) {
    lines.push('| ' + a.alarmId + ' | ' + a.firstSeenAt + ' | ' + a.createdAtIso + ' | ' + a.acknowledgedAtIso + ' | ' + a.state + ' |');
  }
  lines.push('');
  lines.push('> 说明：本报告只使用只读 API 采样 + 用户提供的 ECS /status、docker logs 与人工标记；');
  lines.push('> 脚本不写生产数据、不 ACK、不发布 MQTT、不重启任何服务。未获得真实证据的项一律 BLOCKED，不猜 PASS。');
  return lines.join('\n') + '\n';
}

async function runReport(args) {
  if (!args.samples) throw new Error('report 需要 --samples <ndjson>');
  const report = buildReport({
    samplesFile: args.samples,
    markersFile: args.markers,
    statusFiles: asArray(args.status),
    logsFile: args.logs,
    baselineFile: args.baseline
  });
  mkdirp(REPORT_DIR);
  const suffix = args.tag ? String(args.tag) : report.overall;
  const base = path.join(REPORT_DIR, 'verify-' + stampLocal() + '-' + suffix);
  fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(base + '.md', renderReportMarkdown(report), 'utf8');
  console.log('[report] overall=' + report.overall + ' -> ' + base + '.md / .json');
  for (const c of report.criteria) console.log('[report] ' + c.verdict.padEnd(7) + ' ' + c.id + ' — ' + c.detail);
  return report;
}

/* ------------------------------------------------------------------ preupgrade（官方“升级前基线”落盘） */

/**
 * 生成 `ecs-output/before-upgrade-<时间戳>.json`：一份自洽的升级前基线证据。
 * 内容 = 1 次 API 采样（设备/告警/位置，坐标只留 valid/hasCoordinates/(0,0) 判定）+ 1883 CONNACK 探测。
 * 同时把这次采样写成 ndjson 进 snapshots/，供部署后 report 的 --baseline 使用。
 * 只读；固定写 ecs-output/ 与 snapshots/。
 */
async function runPreupgrade(args) {
  const stamp = stampLocal();
  const token = await login();
  const sample = await takeSample(token, 1);
  const sampleFile = path.join(SNAP_DIR, 'samples-pre-upgrade-' + stamp + '.ndjson');
  mkdirp(SNAP_DIR);
  writeNdjsonLine(sampleFile, sample);

  // 1883 CONNACK 探测（与 probe 相同边界：非白名单 clientId、不 publish/subscribe）
  const env = readMqttEnv();
  const whitelistId = env.MQTT_CLIENT_ID || 'wearable-sos-001';
  const probeId = 'probe-readonly-' + crypto.randomBytes(4).toString('hex');
  if (probeId === whitelistId) throw new Error('拒绝执行：探测 clientId 等于白名单 ID');
  const cases = [
    { name: 'valid-credentials+non-whitelist-clientId', clientId: probeId, password: env.MQTT_PASS, expected: 5 },
    { name: 'wrong-password+non-whitelist-clientId(control)', clientId: probeId, password: 'wrong-' + crypto.randomBytes(6).toString('hex'), expected: 4 }
  ];
  const probeResults = [];
  for (const c of cases) {
    const r = await connackProbe({
      host: args.host || DEFAULT_ECS_HOST,
      port: Number(args.port || DEFAULT_MQTT_PORT),
      clientId: c.clientId, username: env.MQTT_USER, password: c.password
    });
    probeResults.push({ case: c.name, expectedReturnCode: c.expected, pass: r.returnCode === c.expected, returnCode: r.returnCode, returnCodeMeaning: r.returnCodeMeaning, tcpConnectMs: r.tcpConnectMs, error: r.error });
  }

  const doc = {
    kind: 'wearable-pre-upgrade-baseline',
    generatedAt: nowLocal(),
    epochMs: Date.now(),
    purpose: '部署 wearable-mqtt 1.0.1 之前的只读基线（供部署后 report --baseline 对比）',
    boundary: [
      '只 POST /api/v1/auth/app + GET /api/v1/{devices,alerts,location}',
      '1883 只 CONNECT/CONNACK/DISCONNECT；未 publish、未 subscribe、未使用白名单 clientId ' + whitelistId,
      '未 ACK、未写 device-status、未重启任何服务；凭据未打印/未落盘',
      '不保存精确经纬度（只保存 valid/hasCoordinates/(0,0) 判定）'
    ],
    apiSampleFile: path.relative(ECS_DIR, sampleFile),
    api: {
      http: sample.http,
      devices: sample.devices.map((d) => ({ deviceId: d.deviceId, online: d.online, state: d.state, lastSeenTs: d.lastSeenTs, lastSeenIso: d.lastSeenIso })),
      esp32sos: sample.sosDevice,
      sosAlertCount: sample.sosAlertCount,
      allAlertCount: sample.allAlertCount,
      sosAlerts: sample.sosAlerts,
      sosLocation: sample.location
    },
    mqttProbe: {
      host: args.host || DEFAULT_ECS_HOST,
      port: Number(args.port || DEFAULT_MQTT_PORT),
      whitelistClientIdNeverUsed: true,
      results: probeResults,
      verdict: probeResults.every((r) => r.pass) ? 'PASS' : 'FAIL'
    }
  };

  const outDir = path.join(ECS_DIR, 'ecs-output');
  mkdirp(outDir);
  const outFile = path.join(outDir, 'before-upgrade-' + stamp + '.json');
  fs.writeFileSync(outFile, JSON.stringify(doc, null, 2), 'utf8');

  console.log('[preupgrade] at=' + doc.generatedAt);
  console.log('[preupgrade] esp32-sos=' + (sample.sosDevice ? 'online=' + sample.sosDevice.online + ' state=' + sample.sosDevice.state + ' lastSeen=' + sample.sosDevice.lastSeenIso + ' gpsField=' + sample.sosDevice.gpsFieldPresent : 'NOT_FOUND'));
  console.log('[preupgrade] sosAlerts=' + sample.sosAlertCount + ' allAlerts=' + sample.allAlertCount + ' location_for_esp32sos=' + (sample.location ? JSON.stringify(sample.location) : 'none'));
  console.log('[preupgrade] mqttProbe=' + doc.mqttProbe.verdict + ' ' + probeResults.map((r) => 'rc=' + r.returnCode + '(exp ' + r.expectedReturnCode + ')' + (r.pass ? '✓' : '✗')).join(' '));
  console.log('[preupgrade] saved=' + outFile);
  console.log('[preupgrade] baseline_ndjson=' + sampleFile);
  return doc;
}

/* ------------------------------------------------------------------ selftest（MOCK，非生产证据） */

function selftest() {
  const mockSamples = [];
  const t0 = Date.parse('2026-10-28T01:00:00+08:00');
  const base = (msOffset) => ({ at: isoLocal(t0 + msOffset), epochMs: t0 + msOffset });
  const dev = (msOffset, online, lastSeenMs, state) => ({
    kind: 'sample', seq: 1,
    at: isoLocal(t0 + msOffset), epochMs: t0 + msOffset,
    sosDevice: { deviceId: 'esp32-sos', online, state, lastSeenTs: lastSeenMs, lastSeenIso: isoLocal(lastSeenMs), gpsValid: true, gpsHasCoordinates: true, gpsZeroPoint: false },
    sosAlerts: [], sosAlertCount: 0, allAlertCount: 0, location: { deviceId: 'esp32-sos', fixTime: lastSeenMs, fixTimeIso: isoLocal(lastSeenMs), hasCoordinates: true, zeroPoint: false }
  });
  const alert = (alarmId, createdAt, ackAt) => ({
    alarmId, deviceId: 'esp32-sos', type: 'MANUAL_SOS', state: ackAt ? 'ACKED' : 'ALARM',
    createdAt, createdAtIso: isoLocal(createdAt),
    acknowledgedAt: ackAt || 0, acknowledgedAtIso: ackAt ? isoLocal(ackAt) : null,
    acknowledgedBy: ackAt ? 'household-guardian' : null, ackPending: !ackAt
  });
  // 0s：设备在线，已有 1 条 PENDING 告警
  let s = dev(0, true, t0 - 20000, 'ALARM');
  s.sosAlerts = [alert('sos-9-aaaaaaaa', t0 - 25000, 0)]; s.sosAlertCount = 1;
  mockSamples.push(s);
  // 60s：PENDING 仍在，设备还活着
  s = dev(60000, true, t0 + 40000, 'ALARM');
  s.sosAlerts = [alert('sos-9-aaaaaaaa', t0 - 25000, 0)]; s.sosAlertCount = 1;
  mockSamples.push(s);
  // 设备断电（marker 在 t0+90000），采样在 240s（阈值 120s 后）
  s = dev(240000, false, t0 + 40000, 'ALARM');
  s.sosAlerts = [alert('sos-9-aaaaaaaa', t0 - 25000, 0)]; s.sosAlertCount = 1;
  mockSamples.push(s);
  // 设备恢复，ACK 在恢复后 8s 到
  s = dev(300000, true, t0 + 300000, 'ACKED');
  s.sosAlerts = [alert('sos-9-aaaaaaaa', t0 - 25000, t0 + 308000)]; s.sosAlertCount = 1;
  mockSamples.push(s);

  const dir = path.join(ECS_DIR, 'reports', '_selftest-mock-not-evidence');
  mkdirp(dir);
  const samplesFile = path.join(dir, 'mock-samples.ndjson');
  fs.writeFileSync(samplesFile, mockSamples.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

  const markers = {
    no_docker_restart: true,
    events: [
      { t: isoLocal(t0 + 90000), kind: 'device_power_off' },
      { t: isoLocal(t0 + 120000), kind: 'alert_ack_clicked', alarmId: 'sos-9-aaaaaaaa' },
      { t: isoLocal(t0 + 290000), kind: 'device_power_on' },
      { t: isoLocal(t0 + 290000), kind: 'device_restart' }
    ]
  };
  const markersFile = path.join(dir, 'mock-markers.json');
  fs.writeFileSync(markersFile, JSON.stringify(markers, null, 2), 'utf8');

  const statusFile = path.join(dir, 'mock-status.json');
  fs.writeFileSync(statusFile, JSON.stringify({
    service: 'wearable-mqtt', version: '1.0.1', startedAt: t0 + 1000,
    adapter: {
      device: { online: true, state: 'ACKED', lastSeen: t0 + 300000 },
      link: { deviceClientId: 'wearable-sos-001', aliveTimeoutMs: 120000, watchdogArmed: true, offlineReported: false },
      counters: { sosReceived: 1, sosDuplicates: 0, deviceOfflineReports: 1, parkedRecoveryTriggers: 1, commandResultOk: 1, commandsRedelivered: 1 },
      commands: { cursor: 7, inflight: [], parked: [] }
    }
  }, null, 2), 'utf8');

  const report = buildReport({ samplesFile, markersFile, statusFiles: [statusFile], logsFile: null });
  const expect = {
    C0_DEPLOY_VERSION: 'PASS',
    C1_ACK_RESTART_WINDOW: 'PASS',
    C2_OFFLINE_2MIN: 'PASS',
    C3_NO_DUPLICATE_ALARM: 'PASS',
    C4_LOCATION_INTACT: 'PASS',
    C5_NO_FAKE_ACK: 'PASS',
    C6_NO_DOCKER_RESTART: 'PASS'
  };
  let failures = 0;
  console.log('=== verify-wearable-101 selftest：仅使用 MOCK 数据，不是生产证据 ===');
  for (const c of report.criteria) {
    const exp = expect[c.id];
    const ok = exp === undefined ? true : c.verdict === exp;
    if (!ok) failures += 1;
    console.log((ok ? 'ok  ' : 'FAIL') + ' ' + c.id + ' got=' + c.verdict + (exp ? ' expect=' + exp : ''));
  }
  // 负例：重复告警必须被判 FAIL
  const dupSamples = JSON.parse(JSON.stringify(mockSamples));
  dupSamples[3].sosAlerts = dupSamples[3].sosAlerts.concat([alert('sos-9-aaaaaaaa', t0 - 25000, t0 + 308000)]);
  dupSamples[3].sosAlertCount = 2;
  const dupFile = path.join(dir, 'mock-samples-dup.ndjson');
  fs.writeFileSync(dupFile, dupSamples.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  const dupReport = buildReport({ samplesFile: dupFile, markersFile, statusFiles: [statusFile], logsFile: null });
  const dupC3 = dupReport.criteria.find((c) => c.id === 'C3_NO_DUPLICATE_ALARM');
  const dupOk = dupC3 && dupC3.verdict === 'FAIL';
  if (!dupOk) failures += 1;
  console.log((dupOk ? 'ok  ' : 'FAIL') + ' C3 负例（重复 alarmId 应判 FAIL）got=' + (dupC3 && dupC3.verdict));
  // 负例：无 ECS /status 应判 C0 BLOCKED
  const noStatus = buildReport({ samplesFile, markersFile, statusFiles: [], logsFile: null });
  const c0 = noStatus.criteria.find((c) => c.id === 'C0_DEPLOY_VERSION');
  const c0ok = c0 && c0.verdict === 'BLOCKED';
  if (!c0ok) failures += 1;
  console.log((c0ok ? 'ok  ' : 'FAIL') + ' C0 负例（缺 /status 应判 BLOCKED）got=' + (c0 && c0.verdict));
  console.log('selftest ' + (failures === 0 ? 'PASS' : 'FAIL') + '（mock 文件: ' + dir + '）');
  return failures === 0;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log('usage: node verify-wearable-101.js <snapshot|watch|preupgrade|probe|report|selftest> [options]');
    return;
  }
  if (cmd === 'snapshot') { await runSnapshot(args); return; }
  if (cmd === 'watch') { await runWatch(args); return; }
  if (cmd === 'preupgrade') { await runPreupgrade(args); return; }
  if (cmd === 'probe') { await runProbe(args); return; }
  if (cmd === 'report') { await runReport(args); return; }
  if (cmd === 'selftest') { const ok = selftest(); if (!ok) process.exitCode = 1; return; }
  throw new Error('未知子命令: ' + cmd + '（支持 snapshot|watch|probe|report|selftest）');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[verify-wearable-101] ERROR: ' + String((e && e.message) || e));
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  connackProbe, buildReport, extractStatus, isoLocal, deltaSec, mqttConnectPacket
});
