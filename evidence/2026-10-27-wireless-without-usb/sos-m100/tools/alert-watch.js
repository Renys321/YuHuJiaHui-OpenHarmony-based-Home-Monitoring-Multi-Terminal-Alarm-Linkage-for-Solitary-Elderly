'use strict';
/*
 * 生产后端只读连续监视（验收窗口用）：每 10s 取一次 esp32-sos 状态与最新随身告警，
 * 追加写入 JSONL，用于固化"用户按键 → 新 MANUAL_SOS → APP ACK → ACKED"的精确时间线。
 * 只读 GET；不产生告警、不 ACK、不改数据；凭据只从 .secrets 读取，不落盘。
 * 用法：node alert-watch.js <输出jsonl> <总秒数> [间隔秒数]
 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.luxunacc.xyz';
const SECRET = 'D:/OpenHarmony/competition/.secrets/app_guardian.txt';
const outFile = process.argv[2] || path.join(__dirname, '..', 'logs', 'alert-watch.jsonl');
const totalSec = Number(process.argv[3] || 600);
const intervalSec = Number(process.argv[4] || 10);

function readGuardian() {
  const lines = fs.readFileSync(SECRET, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { guardianId: lines[0], password: lines[1] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const { guardianId, password } = readGuardian();
  const res = await fetch(BASE + '/api/v1/auth/app', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId, password }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await res.json().catch(() => ({}));
  if (!body.sessionToken) throw new Error('login failed status=' + res.status);
  return body.sessionToken;
}

async function get(pathname, token) {
  const res = await fetch(BASE + pathname, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(pathname + ' status=' + res.status);
  return body;
}

(async () => {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.appendFileSync(outFile, JSON.stringify({ event: 'watch-start', at: new Date().toISOString(), totalSec, intervalSec }) + '\n');
  const deadline = Date.now() + totalSec * 1000;
  let token = await login();
  let first = true;
  while (Date.now() < deadline) {
    const at = new Date().toISOString();
    try {
      const [devices, alerts] = await Promise.all([get('/api/v1/devices', token), get('/api/v1/alerts', token)]);
      const sosDev = (devices.devices || []).find((d) => d.deviceId === 'esp32-sos') || null;
      const sosAlerts = (alerts.alerts || []).filter((a) => a.deviceId === 'esp32-sos');
      const newest = sosAlerts[0] || null;
      const line = {
        at,
        online: sosDev ? sosDev.online : null,
        state: sosDev ? sosDev.state : null,
        lastSeenTs: sosDev ? sosDev.lastSeenTs : null,
        newest: newest ? {
          alarmId: newest.alarmId,
          type: newest.type,
          state: newest.state,
          ackPending: newest.ackPending,
          createdAt: newest.createdAt,
          acknowledgedAt: newest.acknowledgedAt,
          acknowledgedBy: newest.acknowledgedBy
        } : null,
        sosCount: sosAlerts.length
      };
      fs.appendFileSync(outFile, JSON.stringify(line) + '\n');
      if (first) { console.log('watch running ->', outFile); first = false; }
    } catch (e) {
      const msg = String(e && e.message || e);
      fs.appendFileSync(outFile, JSON.stringify({ at, error: msg }) + '\n');
      if (/status=401/.test(msg)) { try { token = await login(); } catch (_) {} }
    }
    await sleep(intervalSec * 1000);
  }
  fs.appendFileSync(outFile, JSON.stringify({ event: 'watch-end', at: new Date().toISOString() }) + '\n');
  console.log('watch ended ->', outFile);
})().catch((e) => { console.log(JSON.stringify({ event: 'watch-fatal', error: String(e && e.message || e) })); process.exit(1); });
