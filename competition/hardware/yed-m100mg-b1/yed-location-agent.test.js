'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs, redactForOutput } = require('./yed-location-agent');

test('默认是安全夹具模式：不连串口、不发布', () => {
  const options = parseArgs([]);
  assert.equal(options.real, false);
  assert.equal(options.fixture, true);
  assert.equal(options.publish, false);
  assert.equal(options.port, null);
  assert.equal(options.deviceId, 'yed-home-gateway');
  assert.equal(options.room, '家庭网关');
  assert.equal(options.broker, '127.0.0.1:1883');
});

test('--real 必须显式给 --port（禁止写死端口）', () => {
  assert.throws(() => parseArgs(['--real']), /explicit --port/);
  const options = parseArgs(['--real', '--port', 'COM11']);
  assert.equal(options.real, true);
  assert.equal(options.port, 'COM11');
});

test('夹具模式禁止 --publish（假数据不得进入生产链路）', () => {
  assert.throws(() => parseArgs(['--publish']), /only allowed together with --real/);
  assert.throws(() => parseArgs(['--fixture', '--publish']), /only allowed together with --real/);
  assert.equal(parseArgs(['--real', '--port', 'COM11', '--publish']).publish, true);
});

test('拒绝未知参数与非法间隔', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['--interval-ms', '10']), /interval-ms/);
  assert.throws(() => parseArgs(['--interval-ms', 'abc']), /interval-ms/);
});

test('真机模式下输出脱敏：坐标不落日志/终端', () => {
  const payload = {
    deviceId: 'yed-home-gateway',
    gps: { valid: true, latitude: 34.7466, longitude: 113.6254, fixTime: 1792064000000 }
  };
  const redacted = redactForOutput(payload, false);
  assert.equal(redacted.gps.latitude, '<redacted>');
  assert.equal(redacted.gps.longitude, '<redacted>');
  assert.equal(redacted.gps.valid, true);
  assert.equal(redacted.gps.fixTime, 1792064000000);
  const asIs = redactForOutput(payload, true);
  assert.equal(asIs.gps.latitude, 34.7466);
});

test('无定位报文不含坐标字段，脱敏不改语义', () => {
  const payload = { deviceId: 'yed-home-gateway', gps: { valid: false, fixTime: 0 } };
  assert.deepEqual(redactForOutput(payload, false), payload);
});
