'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const homemonSource = fs.readFileSync(path.resolve(__dirname, 'src', 'homemon.c'), 'utf8');
const confSource = fs.readFileSync(path.resolve(__dirname, 'homemon.conf'), 'utf8');
const bridgeSource = fs.readFileSync(path.resolve(__dirname, '..', 'bridge', 'mqtt_bridge.js'), 'utf8');

test('homemon default device id matches the deployed canonical identity', () => {
  assert.match(homemonSource, /snprintf\(c->device_id, sizeof\(c->device_id\), "dayu200-living"\)/);
  assert.equal(/snprintf\(c->device_id, sizeof\(c->device_id\), "dayu200-01"\)/.test(homemonSource), false,
    '历史默认 dayu200-01 必须被移除，否则北向会出现两个同名"客厅"节点');
});

test('homemon config contract keeps device_id/room/tcp_port keys', () => {
  assert.match(homemonSource, /strcmp\(k, "device_id"\)/);
  assert.match(homemonSource, /strcmp\(k, "room"\)/);
  assert.match(homemonSource, /strcmp\(k, "tcp_port"\)/);
  assert.match(homemonSource, /c->tcp_port = 9000/);
  assert.match(confSource, /dir=\/data\/homemon/);
});

test('bridge file-mode fallback uses the canonical living-room identity', () => {
  assert.match(bridgeSource, /const DEVICE = args\.device \|\| 'dayu200-living'/);
  assert.equal(/const DEVICE = args\.device \|\| 'dayu200-01'/.test(bridgeSource), false);
});
