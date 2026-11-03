'use strict';
/*
 * 验收窗口自动取证（只读）：每 5s 轮询生产后端，自动识别"新的随身 MANUAL_SOS"，
 * 记录 按键后告警出现 → APP ACK → ACKED 的时间线，最后生成 JSON + Markdown 摘要。
 *
 * 前提：启动时后端已有基线告警；之后出现的新 alarmId 即视为本次验收事件。
 * 安全：只 GET；不发布 MQTT、不 ACK、不改后端、不打印凭据。
 * 用法：node acceptance-capture.js <输出目录> [总秒数] [间隔秒数]
 *   例：node acceptance-capture.js capture 1200 5
 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.luxunacc.xyz';
const SECRET = 'D:/OpenHarmony/competition/.secrets/app_guardian.txt';
const outDir = process.argv[2] || path.join(__dirname, '..', 'capture');
const totalSec = Number(process.argv[3] || 1200);
const intervalSec = Number(process.argv[4] || 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const nowLocal = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00';

function readGuardian() {
  const lines = fs.readFileSync(SECRET, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('guardian secret malformed');
  return { guardianId: lines[0], password: lines[1] };
}

async function login() {
  const { guardianId, password } = readGuardian();
  const res = await fetch(BASE + '/api/v1/auth/app', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId, password }), signal: AbortSignal.timeout(15000)
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

function sosDevice(devices) {
  return (devices.devices || []).find((d) => d.deviceId === 'esp32-sos') || null;
}
function sosAlerts(alerts) {
  return (alerts.alerts || []).filter((a) => a.deviceId === 'esp32-sos');
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPath = path.join(outDir, `${stamp}-acceptance-capture.jsonl`);
  const jsonPath = path.join(outDir, `${stamp}-acceptance-capture.json`);
  const mdPath = path.join(outDir, `${stamp}-acceptance-capture.md`);
  const log = (obj) => fs.appendFileSync(jsonlPath, JSON.stringify(obj) + '\n');

  let token = await login();
  let dev = null; let alerts = null;
  try {
    [dev, alerts] = await Promise.all([get('/api/v1/devices', token), get('/api/v1/alerts', token)]);
  } catch (e) { token = await login(); [dev, alerts] = await Promise.all([get('/api/v1/devices', token), get('/api/v1/alerts', token)]); }
  const baselineIds = new Set(sosAlerts(alerts).map((a) => a.alarmId));
  const baselineTop = sosAlerts(alerts)[0] ? sosAlerts(alerts)[0].alarmId : null;
  const start = {
    event: 'capture-start', at: nowIso(), atLocal: nowLocal(),
    totalSec, intervalSec,
    baselineNewestAlarmId: baselineTop,
    baselineSosAlertCount: baselineIds.size,
    device: sosDevice(dev) ? { online: sosDevice(dev).online, state: sosDevice(dev).state, lastSeenTs: sosDevice(dev).lastSeenTs } : null
  };
  log(start);
  console.log(JSON.stringify({ jsonlPath, mdPath, ...start }));

  const deadline = Date.now() + totalSec * 1000;
  let target = null;          // 本次新告警对象
  let firstSeenAt = 0;        // 本地首次看到该告警的时刻
  let ackedAt = 0;            // 本地首次看到 ACKED 的时刻
  let lastSeenTs = start.device ? start.device.lastSeenTs : 0;
  let lastSeenAt = Date.now();
  let maxSeenGapMs = 0;
  let samples = 0;

  while (Date.now() < deadline) {
    const at = Date.now();
    try {
      const [d, a] = await Promise.all([get('/api/v1/devices', token), get('/api/v1/alerts', token)]);
      samples += 1;
      const sdev = sosDevice(d);
      const list = sosAlerts(a);
      if (sdev && sdev.lastSeenTs !== lastSeenTs) {
        maxSeenGapMs = Math.max(maxSeenGapMs, at - lastSeenAt);
        lastSeenTs = sdev.lastSeenTs; lastSeenAt = at;
      }
      if (!target) {
        const fresh = list.filter((x) => !baselineIds.has(x.alarmId)).sort((x, y) => x.createdAt - y.createdAt)[0];
        if (fresh) {
          target = fresh; firstSeenAt = at;
          log({ at: nowIso(), atLocal: nowLocal(), event: 'new-alarm-first-seen', alarm: fresh, device: { online: sdev.online, state: sdev.state, lastSeenTs: sdev.lastSeenTs } });
          console.log(JSON.stringify({ event: 'NEW_ALARM', alarmId: fresh.alarmId, createdAt: fresh.createdAt, createdAtLocal: new Date(fresh.createdAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }), firstSeenLocal: nowLocal() }));
        }
      } else {
        const cur = list.find((x) => x.alarmId === target.alarmId);
        if (cur) {
          target = cur;
          if (cur.state === 'ACKED' && !ackedAt) {
            ackedAt = at;
            log({ at: nowIso(), atLocal: nowLocal(), event: 'acked-first-seen', alarm: cur, device: sdev ? { state: sdev.state, lastSeenTs: sdev.lastSeenTs } : null });
            console.log(JSON.stringify({ event: 'ACKED', alarmId: cur.alarmId, acknowledgedAt: cur.acknowledgedAt, ackLatencyMs: cur.acknowledgedAt - cur.createdAt, ackedSeenLocal: nowLocal() }));
          }
        }
      }
      log({ at: nowIso(), samples, online: sdev ? sdev.online : null, state: sdev ? sdev.state : null, lastSeenTs: sdev ? sdev.lastSeenTs : null, target: target ? { alarmId: target.alarmId, state: (list.find((x) => x.alarmId === target.alarmId) || {}).state || target.state } : null });
    } catch (e) {
      const msg = String(e && e.message || e);
      log({ at: nowIso(), event: 'poll-error', error: msg });
      if (/status=401/.test(msg)) { try { token = await login(); } catch (_) {} }
    }
    if (target && ackedAt) break;
    await sleep(intervalSec * 1000);
  }

  const summary = {
    jsonlPath, startedAtLocal: start.atLocal,
    baselineNewestAlarmId: baselineTop,
    captureDurationSec: totalSec, samples,
    targetAlarm: target ? {
      alarmId: target.alarmId, type: target.type, createdAt: target.createdAt,
      createdAtLocal: new Date(target.createdAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00',
      firstSeenAt: firstSeenAt ? new Date(firstSeenAt).toISOString() : null,
      acknowledgedAt: target.acknowledgedAt,
      acknowledgedAtLocal: target.acknowledgedAt ? new Date(target.acknowledgedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00' : null,
      ackSeenAt: ackedAt ? new Date(ackedAt).toISOString() : null,
      createToAckMs: target.acknowledgedAt ? target.acknowledgedAt - target.createdAt : null,
      state: target.state
    } : null,
    deviceLastSeenMaxGapMs: maxSeenGapMs,
    verdict: target ? (ackedAt ? 'PASS_ALARM_AND_ACKED_SEEN' : 'ALARM_SEEN_ACK_NOT_SEEN') : 'NO_NEW_ALARM_SEEN'
  };
  fs.writeFileSync(jsonPath, JSON.stringify({ start, summary }, null, 2));
  const md = [
    '# 验收自动取证摘要（只读）', '',
    `- 开始：${start.atLocal}`,
    `- 基线最新告警：\`${baselineTop}\`（SOS 告警数 ${baselineIds.size}）`,
    `- 采样：${samples} 次（间隔 ${intervalSec}s）`,
    `- 结论：**${summary.verdict}**`, '',
    target ? [
      '## 本次捕获事件', '',
      `- alarmId：\`${target.alarmId}\`（${target.type}）`,
      `- createdAt：${summary.targetAlarm.createdAtLocal}`,
      `- 首次在后端看到：${summary.targetAlarm.firstSeenAt}`,
      `- acknowledgedAt：${summary.targetAlarm.acknowledgedAtLocal || '未确认'}`,
      `- 创建→ACK 时延：${summary.targetAlarm.createToAckMs === null ? 'n/a' : summary.targetAlarm.createToAckMs + ' ms'}`,
      `- 最终状态：${summary.targetAlarm.state}`,
      '',
      '> 云侧 ACKED 只能在设备真实回执后由适配器回写（适配器绝不代报），但"用户是否在 APP 点确认 / 蜂鸣是否停"仍需现场口述佐证。'
    ].join('\n') : '## 未捕获到新的随身告警\n\n窗口内没有出现新的 `esp32-sos` MANUAL_SOS 告警（用户可能未按键）。',
    '', `原始采样：\`${path.basename(jsonlPath)}\``
  ].join('\n');
  fs.writeFileSync(mdPath, md + '\n');
  console.log(JSON.stringify({ summary, mdPath }, null, 2));
})().catch((e) => { console.error(JSON.stringify({ event: 'capture-fatal', error: String(e && e.message || e) })); process.exit(1); });
