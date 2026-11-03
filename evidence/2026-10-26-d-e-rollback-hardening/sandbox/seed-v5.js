'use strict';

/**
 * seed-v5.js — 在**沙箱容器内**用 v5 边界代码写入合成 v5 状态（不接触任何真实数据）
 *
 * 由 sandbox/docker-validation.js 以 `--user node` 在 old 镜像里执行：
 *   node /opt/sandbox/seed-v5.js /data
 *
 * 合成标记：设备 rehearsal-fixture-*、房间 合成演练-*、告警 rehearsal-alarm-*。
 * 证据目录里同时写 index.json（v5 内容）与一张合成 JPEG，用于验证“回滚时目录合并、
 * 不丢升级后新增的嵌套文件”。
 */

const fs = require('node:fs');
const path = require('node:path');

const dataRoot = process.argv[2] || '/data';
const BASE = Date.UTC(2026, 9, 26, 2, 0, 0); // 2026-10-26 10:00 +08:00

// eslint-disable-next-line import/no-dynamic-require
const { PersistentStore } = require('/app/src/persistent-store.js');

const FIXTURES = [
  {
    deviceId: 'rehearsal-fixture-bath', room: '合成演练-卫生间', state: 'ALARM',
    sensors: { motion: { lastActiveTs: BASE, countToday: 5 }, climate: { tempC: 24.5, rh: 51, ok: true } },
    alarm: { id: 'rehearsal-alarm-1', type: 'MANUAL_SOS', countToday: 1 }
  },
  {
    deviceId: 'rehearsal-fixture-living', room: '合成演练-客厅', state: 'ALARM',
    sensors: { motion: { lastActiveTs: BASE, countToday: 7 } },
    alarm: { id: 'rehearsal-alarm-2', type: 'NO_MOTION', countToday: 1 }
  },
  { deviceId: 'rehearsal-fixture-kitchen', room: '合成演练-厨房', state: 'NORMAL', sensors: {} }
];

const store = new PersistentStore({ filePath: path.join(dataRoot, 'backend-state.json') });
FIXTURES.forEach((fixture, index) => {
  store.ingest({
    deviceId: fixture.deviceId,
    room: fixture.room,
    online: true,
    monitorOnline: 1,
    state: fixture.state,
    ts: BASE + index * 1000,
    sensors: fixture.sensors,
    alarm: fixture.alarm || {}
  }, BASE + index * 1000);
});

// 证据必须用真实 EvidenceStore 写入：index.json 有严格 schema 校验，不能手写
const { EvidenceStore } = require('/app/src/evidence-store.js');
const evidenceDir = path.join(dataRoot, 'evidence');
const evidenceStore = new EvidenceStore({ directory: evidenceDir });
// 最小合法 JPEG：FF D8 FF ... FF D9（validateJpeg 只要求 SOI/EOI 与长度）
const JPEG_V5 = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0xFF, 0xD9]);
evidenceStore.upload('fall-1-na', 'rehearsal-fixture-bath', JPEG_V5);

const document = JSON.parse(fs.readFileSync(path.join(dataRoot, 'backend-state.json'), 'utf8'));
process.stdout.write(`${JSON.stringify({
  seeded: true,
  schemaVersion: document.schemaVersion,
  devices: document.devices.length,
  alerts: document.alerts.length,
  hasSafetyLogs: Object.prototype.hasOwnProperty.call(document, 'safetyLogs'),
  activityFileExists: fs.existsSync(path.join(dataRoot, 'activity-state.json'))
})}\n`);
