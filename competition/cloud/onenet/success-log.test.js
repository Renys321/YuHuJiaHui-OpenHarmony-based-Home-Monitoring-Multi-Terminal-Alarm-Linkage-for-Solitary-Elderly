'use strict';
/*
 * success-log.test.js — 公网 202/200 证据所需的"脱敏成功日志"测试
 *
 * 目标：证明 (1) 只有 2xx 才记录成功；(2) 日志只含 deviceId / 路径 / HTTP 状态码 / UTC 时间；
 *       (3) 绝不包含 ingest key、请求头或请求体；(4) 限频生效，不会刷屏。
 */
const assert = require('node:assert/strict');
const test = require('node:test');
const { createCloudSync } = require('./cloud-sync');
const { createCommandSync } = require('./command-sync');

const KEY = 'k'.repeat(48);          // 测试用假密钥：必须永远不出现在日志里
const NOW = 1792064000000;           // 2026-10-15T11:33:20.000Z
const NOW_ISO = '2026-10-15T11:33:20.000Z';

function collector() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines: lines,
    logger: {
      info: function (l) { lines.info.push(l); },
      warn: function (l) { lines.warn.push(l); },
      error: function (l) { lines.error.push(l); }
    }
  };
}

function device(id, room) {
  return {
    deviceId: id, room: room, state: 'NORMAL', monitorOnline: -1,
    alarm: { id: '', type: '', countToday: 0 }
  };
}

function noSecret(lines) {
  const all = lines.info.concat(lines.warn, lines.error).join('\n');
  assert.ok(all.indexOf(KEY) < 0, 'log must not contain the ingest key');
  assert.ok(all.toLowerCase().indexOf('x-ingest-key') < 0, 'log must not contain request headers');
  assert.ok(all.indexOf('authorization') < 0, 'log must not contain authorization');
  return true;
}

/* ------------------------------------------------------------------ cloud-sync */

test('2xx 记录一条脱敏 OK 日志（deviceId/路径/状态码/UTC 时间）', async () => {
  const c = collector();
  const sync = createCloudSync({
    backendUrl: 'https://api.example.test',
    ingestKey: KEY,
    now: function () { return NOW; },
    logger: c.logger,
    httpRequest: function (opts, body, cb) { cb(null, { statusCode: 202 }); }
  });
  const r = await sync.publish(device('dayu200-living', '客厅'), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.statusCode, 202);
  assert.equal(c.lines.info.length, 1, JSON.stringify(c.lines));
  const line = c.lines.info[0];
  assert.ok(line.indexOf('device=dayu200-living') >= 0, line);
  assert.ok(line.indexOf('path=/internal/v1/device-status') >= 0, line);
  assert.ok(line.indexOf('status=202') >= 0, line);
  assert.ok(line.indexOf('at=' + NOW_ISO) >= 0, line);
  assert.ok(noSecret(c.lines));
});

test('非 2xx 只记 FAIL，绝不记 OK', async () => {
  const c = collector();
  const sync = createCloudSync({
    backendUrl: 'https://api.example.test',
    ingestKey: KEY,
    now: function () { return NOW; },
    logger: c.logger,
    httpRequest: function (opts, body, cb) { cb(null, { statusCode: 401 }); }
  });
  const r = await sync.publish(device('dayu200-living', '客厅'), NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SYNC_HTTP_ERROR');
  assert.equal(c.lines.info.length, 0);
  assert.equal(c.lines.warn.length, 1);
  assert.ok(c.lines.warn[0].indexOf('FAIL code=SYNC_HTTP_ERROR') >= 0, c.lines.warn[0]);
  assert.ok(noSecret(c.lines));
});

test('成功日志按设备限频（okLogIntervalMs）', async () => {
  let t = NOW;
  const c = collector();
  const sync = createCloudSync({
    backendUrl: 'https://api.example.test',
    ingestKey: KEY,
    okLogIntervalMs: 30000,
    now: function () { return t; },
    logger: c.logger,
    httpRequest: function (opts, body, cb) { cb(null, { statusCode: 202 }); }
  });
  await sync.publish(device('dayu200-living', '客厅'), t);
  t += 1000;
  await sync.publish(device('dayu200-living', '客厅'), t);
  assert.equal(c.lines.info.length, 1, '同一设备在限频窗口内只记一次');
  t += 30000;
  await sync.publish(device('dayu200-living', '客厅'), t);
  assert.equal(c.lines.info.length, 2, '超过窗口后重新记录');

  // 不同设备各自独立限频：同一次窗口内两台设备各一条
  const c2 = collector();
  const sync2 = createCloudSync({
    backendUrl: 'https://api.example.test',
    ingestKey: KEY,
    now: function () { return NOW; },
    logger: c2.logger,
    httpRequest: function (opts, body, cb) { cb(null, { statusCode: 202 }); }
  });
  await sync2.publish(device('dayu200-living', '客厅'), NOW);
  await sync2.publish(device('esp32-bath', '卫生间'), NOW);
  assert.equal(c2.lines.info.length, 2, JSON.stringify(c2.lines.info));
  assert.ok(c2.lines.info.some(function (l) { return l.indexOf('device=esp32-bath') >= 0; }));
});

test('okLogIntervalMs=0 时每次成功都记（用于验收抓取）', async () => {
  const c = collector();
  const sync = createCloudSync({
    backendUrl: 'https://api.example.test',
    ingestKey: KEY,
    okLogIntervalMs: 0,
    now: function () { return NOW; },
    logger: c.logger,
    httpRequest: function (opts, body, cb) { cb(null, { statusCode: 202 }); }
  });
  await sync.publish(device('dayu200-living', '客厅'), NOW);
  await sync.publish(device('dayu200-living', '客厅'), NOW);
  assert.equal(c.lines.info.length, 2);
});

test('okLogIntervalMs 越界被拒绝', () => {
  assert.throws(function () {
    createCloudSync({ backendUrl: 'https://api.example.test', ingestKey: KEY, okLogIntervalMs: -1 });
  }, TypeError);
  assert.throws(function () {
    createCloudSync({ backendUrl: 'https://api.example.test', ingestKey: KEY, okLogIntervalMs: 600001 });
  }, TypeError);
});

/* ------------------------------------------------------------------ command-sync */

function commandSyncWith(responder, extra) {
  const c = collector();
  const sync = createCommandSync(Object.assign({
    backendUrl: 'https://api.example.test',
    ingestKey: KEY,
    publishCommand: function () { return true; },
    now: function () { return NOW; },
    logger: c.logger,
    httpRequest: responder
  }, extra || {}));
  return { sync: sync, lines: c.lines };
}

test('GET /internal/v1/commands 成功时记录 POLL_OK 200', async () => {
  const c = commandSyncWith(function (opts, body, cb) {
    cb(null, { statusCode: 200, text: JSON.stringify({ commands: [] }) });
  });
  const r = await c.sync.pollOnce();
  assert.equal(r.ok, true);
  assert.equal(c.lines.info.filter(function (l) { return l.indexOf('POLL_OK') >= 0; }).length, 1,
    JSON.stringify(c.lines.info));
  const line = c.lines.info.find(function (l) { return l.indexOf('POLL_OK') >= 0; });
  assert.ok(line.indexOf('path=/internal/v1/commands') >= 0, line);
  assert.ok(line.indexOf('status=200') >= 0, line);
  assert.ok(line.indexOf('at=' + NOW_ISO) >= 0, line);
  assert.ok(noSecret(c.lines));
});

test('轮询失败只记 POLL_FAIL，不记 POLL_OK', async () => {
  const c = commandSyncWith(function (opts, body, cb) { cb(null, { statusCode: 500, text: 'boom' }); });
  const r = await c.sync.pollOnce();
  assert.equal(r.ok, false);
  assert.equal(c.lines.info.filter(function (l) { return l.indexOf('POLL_OK') >= 0; }).length, 0);
  assert.ok(c.lines.warn.some(function (l) { return l.indexOf('POLL_FAIL') >= 0; }), JSON.stringify(c.lines.warn));
  assert.ok(noSecret(c.lines));
});

test('POLL_OK 限频：默认窗口内只记一次，0 时每次记录', async () => {
  const responder = function (opts, body, cb) { cb(null, { statusCode: 200, text: JSON.stringify({ commands: [] }) }); };
  const a = commandSyncWith(responder, { pollOkLogIntervalMs: 60000 });
  await a.sync.pollOnce();
  await a.sync.pollOnce();
  assert.equal(a.lines.info.filter(function (l) { return l.indexOf('POLL_OK') >= 0; }).length, 1);

  const b = commandSyncWith(responder, { pollOkLogIntervalMs: 0 });
  await b.sync.pollOnce();
  await b.sync.pollOnce();
  assert.equal(b.lines.info.filter(function (l) { return l.indexOf('POLL_OK') >= 0; }).length, 2);
});

test('pollOkLogIntervalMs 越界被拒绝', () => {
  assert.throws(function () {
    createCommandSync({ backendUrl: 'https://api.example.test', ingestKey: KEY, pollOkLogIntervalMs: -5 });
  }, TypeError);
});
