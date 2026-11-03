// 只读探测生产 API（GET），用于核对 APP 展示的同一条随身 SOS 告警与当前设备快照。
// 凭据从 competition/.secrets/app_guardian.txt 读取，不打印、不写日志、不落盘。
// 严格只读：只 POST /auth/app 登录 + GET /alerts|/devices|/location；不 ACK、不处置、不改数据。
const fs = require('fs');
const path = require('path');

const SECRET = 'D:\\OpenHarmony\\competition\\.secrets\\app_guardian.txt';
const OUT_DIR = 'D:\\OpenHarmony\\competition\\evidence\\2026-10-27-reconnect-dayu-sos\\app-ui\\verify';
const BASE = 'https://api.luxunacc.xyz';

async function main() {
  const lines = fs.readFileSync(SECRET, 'utf8').split(/\r?\n/).filter((s) => s.trim().length > 0);
  const guardianId = lines[0].trim();
  const password = lines[1].trim();
  const login = await fetch(BASE + '/api/v1/auth/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guardianId, password })
  });
  if (login.status !== 200) {
    console.log('LOGIN_FAILED status=' + login.status);
    process.exit(1);
  }
  const body = await login.json();
  const token = body.sessionToken;
  const headers = { Authorization: 'Bearer ' + token };
  const get = async (p) => {
    const r = await fetch(BASE + p, { headers });
    const text = await r.text();
    return { status: r.status, text };
  };
  const alerts = await get('/api/v1/alerts');
  const devices = await get('/api/v1/devices');
  const locations = await get('/api/v1/location');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'alerts.json'), alerts.text);
  fs.writeFileSync(path.join(OUT_DIR, 'devices.json'), devices.text);
  fs.writeFileSync(path.join(OUT_DIR, 'locations.json'), locations.text);
  const alertList = JSON.parse(alerts.text).alerts || [];
  const sos = alertList.filter((a) => a.deviceId === 'esp32-sos');
  console.log('alerts_total=' + alertList.length + ' esp32sos_alerts=' + sos.length);
  for (const a of sos.slice(0, 5)) {
    console.log(JSON.stringify({
      alarmId: a.alarmId, type: a.type, state: a.state, ackPending: a.ackPending,
      createdAt: a.createdAt, acknowledgedAt: a.acknowledgedAt, acknowledgedBy: a.acknowledgedBy,
      roomName: a.roomName, message: a.message
    }));
  }
  const devList = JSON.parse(devices.text).devices || [];
  for (const d of devList) {
    if (['esp32-kitchen', 'esp32-bath', 'dayu200-living', 'esp32-sos'].indexOf(d.deviceId) < 0) continue;
    console.log(JSON.stringify({
      deviceId: d.deviceId, online: d.online, monitorOnline: d.monitorOnline,
      lastSeenTs: d.lastSeenTs, sensors: d.sensors, monitorReason: d.monitorReason
    }));
  }
  const locs = JSON.parse(locations.text).locations || [];
  const sosLocs = locs.filter((l) => l.deviceId === 'esp32-sos');
  console.log('sos_locations=' + sosLocs.length + ' latest=' + JSON.stringify(sosLocs[0] || null));
  console.log('now=' + Date.now());
}
main().catch((e) => { console.log('ERR ' + e.message); process.exit(1); });
