'use strict';
/*
 * 生产后端只读探针（每轮一个快照）。
 * 用途：观察 esp32-sos 的 online/lastSeenTs/state 是否在推进，并记录近期告警。
 * 约束：
 *  - 凭据只从 competition/.secrets/app_guardian.txt 读取，不落盘、不打印；
 *  - 只调用 GET /api/v1/devices 与 GET /api/v1/alerts；
 *  - 快照不包含 token。
 * 用法：node prod-probe.js <输出目录> <标签>
 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.luxunacc.xyz';
const SECRET = 'D:/OpenHarmony/competition/.secrets/app_guardian.txt';
const outDir = process.argv[2] || path.join(__dirname, '..', 'snapshots');
const label = process.argv[3] || 'probe';

function readGuardian() {
  const lines = fs.readFileSync(SECRET, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('guardian secret file malformed');
  return { guardianId: lines[0], password: lines[1] };
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = { rawLength: text.length }; }
  return { status: res.status, body };
}

function tsText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'n/a';
  return new Date(ms).toISOString() + ' / ' + new Date(ms + 8 * 3600e3).toISOString().replace('Z', '+08:00');
}

(async () => {
  const t0 = Date.now();
  const { guardianId, password } = readGuardian();
  const loginRes = await fetch(BASE + '/api/v1/auth/app', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId, password }),
    signal: AbortSignal.timeout(15000)
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  const token = loginBody.sessionToken || '';
  if (!token) {
    console.log(JSON.stringify({ label, loginStatus: loginRes.status, error: 'login failed' }));
    process.exit(2);
  }
  const auth = { authorization: 'Bearer ' + token };
  const [devices, alerts, health] = await Promise.all([
    getJson(BASE + '/api/v1/devices', auth),
    getJson(BASE + '/api/v1/alerts', auth),
    getJson(BASE + '/healthz', {})
  ]);
  const devList = devices.body && Array.isArray(devices.body.devices) ? devices.body.devices : [];
  const sos = devList.find((d) => d.deviceId === 'esp32-sos') || null;
  const alertList = alerts.body && Array.isArray(alerts.body.alerts) ? alerts.body.alerts : [];
  const near = alertList.filter((a) => a.deviceId === 'esp32-sos').slice(0, 6);
  const elapsedMs = Date.now() - t0;
  const snapshot = {
    label,
    probedAt: new Date().toISOString(),
    probedAtLocal: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00',
    healthz: { status: health.status, body: health.body },
    devices: { status: devices.status, count: devList.length, esp32Sos: sos },
    alerts: { status: alerts.status, count: alertList.length, esp32SosRecent: near },
    recentAlertKeys: alertList[0] ? Object.keys(alertList[0]) : []
  };
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `${stamp}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({
    label,
    file,
    elapsedMs,
    healthz: health.status,
    devicesStatus: devices.status,
    deviceCount: devList.length,
    esp32Sos: sos ? {
      online: sos.online,
      state: sos.state,
      lastSeenTs: sos.lastSeenTs,
      lastSeenText: tsText(sos.lastSeenTs),
      ageSeconds: sos.lastSeenTs ? Math.round((Date.now() - sos.lastSeenTs) / 1000) : null,
      sensorsKeys: sos.sensors ? Object.keys(sos.sensors) : [],
      csq: sos.csq === undefined ? 'absent' : sos.csq
    } : null,
    alertsStatus: alerts.status,
    alertCount: alertList.length,
    esp32SosRecent: near.map((a) => ({ ...a })),
    recentAlertKeys: snapshot.recentAlertKeys
  }, null, 2));
})().catch((e) => {
  console.log(JSON.stringify({ label, error: String(e && e.message || e) }));
  process.exit(1);
});
