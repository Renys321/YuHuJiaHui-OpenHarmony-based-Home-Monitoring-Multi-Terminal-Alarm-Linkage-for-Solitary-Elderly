#!/usr/bin/env node
/**
 * 只读抓取生产 APP-API 快照（不打印凭据）。
 * 用法: node prod-snapshot.js <outDir> [label]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://api.luxunacc.xyz';
const SECRETS = 'D:\\OpenHarmony\\competition\\.secrets\\app_guardian.txt';
const outDir = process.argv[2] || '.';
const label = process.argv[3] || 'snapshot';
fs.mkdirSync(outDir, { recursive: true });

const lines = fs.readFileSync(SECRETS, 'utf8').split(/\r?\n/).filter(Boolean);
const guardianId = lines[0].trim();
const password = lines[1].trim();
if (!guardianId || !password) { console.error('credential file incomplete'); process.exit(2); }

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'content-type': 'application/json' };
    if (data) headers['content-length'] = data.length;
    if (token) headers.authorization = 'Bearer ' + token;
    const r = https.request({ hostname: 'api.luxunacc.xyz', path, method, headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* keep null */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const at = new Date();
  const auth = await req('POST', '/api/v1/auth/app', { guardianId, password });
  if (auth.status !== 200 || !auth.json || !auth.json.sessionToken) {
    console.log(JSON.stringify({ at: at.toISOString(), authStatus: auth.status, ok: false }));
    process.exit(1);
  }
  const token = auth.json.sessionToken;
  const [devices, alerts, location, overview] = await Promise.all([
    req('GET', '/api/v1/devices', null, token),
    req('GET', '/api/v1/alerts', null, token),
    req('GET', '/api/v1/location', null, token),
    req('GET', '/api/v1/overview', null, token)
  ]);
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const snap = {
    at: at.toISOString(),
    epochMs: at.getTime(),
    devices: devices.json,
    alerts: alerts.json,
    location: location.json,
    overview: overview.json,
    statuses: { devices: devices.status, alerts: alerts.status, location: location.status, overview: overview.status }
  };
  const file = path.join(outDir, `${stamp}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  const devs = (devices.json && devices.json.devices) || [];
  const summary = devs.map((d) => ({
    deviceId: d.deviceId, online: d.online, state: d.state, lastSeenTs: d.lastSeenTs,
    lastSeen: d.lastSeenTs ? new Date(d.lastSeenTs).toISOString() : null
  }));
  const al = ((alerts.json && alerts.json.alerts) || []).slice(0, 6).map((a) => ({
    alarmId: a.alarmId || a.id, deviceId: a.deviceId, type: a.type, state: a.state,
    createdAt: a.createdAt, ackPending: a.ackPending
  }));
  console.log(JSON.stringify({ at: at.toISOString(), file, summary, alerts: al }, null, 2));
})().catch((e) => { console.error('ERR', e.message); process.exit(3); });
