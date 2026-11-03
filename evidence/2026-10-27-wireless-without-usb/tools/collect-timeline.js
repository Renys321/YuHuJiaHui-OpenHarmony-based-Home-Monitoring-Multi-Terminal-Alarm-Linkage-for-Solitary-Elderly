#!/usr/bin/env node
/**
 * 无线化（拔 USB）验收时间线采集器（Node 版，只读）。
 * 每 5 秒记录：后端四台设备的新鲜度/状态、bridge 入站连接、DAYU Wi-Fi 可达性、
 * hdc targets/fport、PC 串口列表。凭据从 .secrets/app_guardian.txt 读取且不打印。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execSync } = require('node:child_process');

const root = 'D:\\OpenHarmony\\competition\\evidence\\2026-10-27-wireless-without-usb';
const outDir = path.join(root, 'timeline');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'wireless-unplug-timeline.jsonl');
const hdc = 'D:\\OpenHarmony\\tools\\hdc\\hdc.exe';
const secret = fs.readFileSync('D:\\OpenHarmony\\competition\\.secrets\\app_guardian.txt', 'utf8')
  .split(/\r?\n/).filter((s) => s.trim().length > 0);
const loginBody = JSON.stringify({ guardianId: secret[0].trim(), password: secret[1].trim() });
let token = null;

async function getToken() {
  try {
    const res = await fetch('https://api.luxunacc.xyz/api/v1/auth/app', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: loginBody,
      signal: AbortSignal.timeout(15000)
    });
    const j = await res.json();
    return typeof j.sessionToken === 'string' ? j.sessionToken : null;
  } catch { return null; }
}

function run(cmd, args, timeout = 8000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true }).trim();
  } catch { return ''; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  while (true) {
    const ts = Date.now();
    const rec = { ts, iso: new Date().toLocaleString('zh-CN', { hour12: false }) };
    // 后端四台设备
    try {
      if (!token) token = await getToken();
      const res = await fetch('https://api.luxunacc.xyz/api/v1/devices', {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000)
      });
      if (res.status === 401) { token = await getToken(); }
      const j = await res.json();
      const backend = {};
      for (const d of (j.devices || [])) {
        if (!['esp32-kitchen', 'esp32-bath', 'dayu200-living', 'esp32-sos'].includes(d.deviceId)) continue;
        backend[d.deviceId] = {
          online: d.online, state: d.state, lastSeenTs: d.lastSeenTs,
          ageSec: d.lastSeenTs ? Math.round((ts - d.lastSeenTs) / 100) / 10 : -1
        };
      }
      rec.backend = backend;
    } catch (e) { rec.backend = { error: 'fetch_failed' }; }
    // bridge 入站
    try {
      const out = execSync('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 9101 -ErrorAction SilentlyContinue | Where-Object {$_.State -eq \'Established\'} | ForEach-Object { $_.RemoteAddress + \':\' + $_.RemotePort }"',
        { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
      rec.bridgeInbound = out ? out.split(/\r?\n/).filter(Boolean) : [];
    } catch { rec.bridgeInbound = []; }
    // DAYU Wi-Fi 可达性
    try {
      execFileSync('ping.exe', ['-n', '1', '-w', '1500', '10.127.130.131'], { timeout: 4000, windowsHide: true });
      rec.dayuPing = true;
    } catch { rec.dayuPing = false; }
    // hdc / fport / 串口
    rec.hdcTargets = run(hdc, ['list', 'targets']).split(/\r?\n/).filter(Boolean);
    rec.fports = run(hdc, ['-t', '450100445634303332012847942eca00', 'fport', 'ls'])
      .split(/\r?\n/).filter((l) => l.includes('tcp:'));
    try {
      const ps = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue | Where-Object {$_.DeviceID -match \'^COM\\d+$\'} | ForEach-Object { $_.DeviceID + \'=\' + $_.Description }"',
        { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
      rec.comPorts = ps ? ps.split(/\r?\n/).filter(Boolean) : [];
    } catch { rec.comPorts = []; }
    fs.appendFileSync(outFile, JSON.stringify(rec) + '\n', 'utf8');
    await sleep(5000);
  }
})();
