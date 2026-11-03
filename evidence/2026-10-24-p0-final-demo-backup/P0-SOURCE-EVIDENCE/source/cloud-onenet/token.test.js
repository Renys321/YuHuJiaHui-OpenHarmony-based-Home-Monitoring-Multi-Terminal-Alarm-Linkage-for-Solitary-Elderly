'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { buildDeviceResource, createDeviceToken } = require('./token');

const KEY_BYTES = Buffer.from('unit-test-device-key-not-a-secret', 'utf8');
const KEY = KEY_BYTES.toString('base64');

test('creates the documented OneNET device-level token', () => {
  const expiresAtSec = 1_900_000_000;
  const resource = 'products/product-1/devices/dayu200-home-gateway';
  const expectedSign = crypto.createHmac('sha256', KEY_BYTES)
    .update(`${expiresAtSec}\nsha256\n${resource}\n2018-10-31`, 'utf8')
    .digest('base64');
  const token = createDeviceToken({
    productId: 'product-1',
    deviceName: 'dayu200-home-gateway',
    deviceKey: KEY,
    expiresAtSec
  });
  assert.equal(token, [
    'version=2018-10-31',
    `res=${encodeURIComponent(resource)}`,
    `et=${expiresAtSec}`,
    'method=sha256',
    `sign=${encodeURIComponent(expectedSign)}`
  ].join('&'));
  assert.equal(token.includes(KEY), false);
});

test('builds only a device-level resource with safe topic segments', () => {
  assert.equal(
    buildDeviceResource('I19NBBq4xe', 'dayu200-home-gateway'),
    'products/I19NBBq4xe/devices/dayu200-home-gateway'
  );
  for (const bad of ['', '../x', 'a/b', '$sys', 'a b', '中文']) {
    assert.throws(() => buildDeviceResource(bad, 'device-1'), TypeError);
    assert.throws(() => buildDeviceResource('product-1', bad), TypeError);
  }
});

test('rejects malformed keys, weak methods, bad expiry and unknown fields', () => {
  const base = {
    productId: 'product-1', deviceName: 'device-1', deviceKey: KEY, expiresAtSec: 1_900_000_000
  };
  assert.throws(() => createDeviceToken({ ...base, deviceKey: 'not base64!' }), /base64/);
  assert.throws(() => createDeviceToken({ ...base, method: 'sha1' }), /sha256/);
  assert.throws(() => createDeviceToken({ ...base, expiresAtSec: 0 }), /positive/);
  assert.throws(() => createDeviceToken({ ...base, extra: true }), /unknown field/);
});
