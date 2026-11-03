'use strict';

const crypto = require('node:crypto');

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_VERSION = '2018-10-31';
const SIGN_METHOD = 'sha256';

function fail(message) {
  throw new TypeError(message);
}

function requireSegment(value, name) {
  if (typeof value !== 'string' || !SEGMENT_RE.test(value)) {
    fail(`${name} must match ${SEGMENT_RE}`);
  }
  return value;
}

function decodeDeviceKey(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 4096) {
    fail('deviceKey must be a non-empty base64 string');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    fail('deviceKey must be valid base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    fail('deviceKey must be valid base64');
  }
  return decoded;
}

function buildDeviceResource(productId, deviceName) {
  return `products/${requireSegment(productId, 'productId')}/devices/${requireSegment(deviceName, 'deviceName')}`;
}

function createDeviceToken(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('options must be an object');
  }
  const allowed = new Set(['productId', 'deviceName', 'deviceKey', 'expiresAtSec', 'method', 'version']);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail(`options contains unknown field: ${key}`);
  }

  const resource = buildDeviceResource(options.productId, options.deviceName);
  const expiresAtSec = options.expiresAtSec;
  if (!Number.isSafeInteger(expiresAtSec) || expiresAtSec <= 0) {
    fail('expiresAtSec must be a positive Unix timestamp in seconds');
  }
  const method = options.method === undefined ? SIGN_METHOD : options.method;
  const version = options.version === undefined ? TOKEN_VERSION : options.version;
  if (method !== SIGN_METHOD) fail(`method must be ${SIGN_METHOD}`);
  if (version !== TOKEN_VERSION) fail(`version must be ${TOKEN_VERSION}`);

  const key = decodeDeviceKey(options.deviceKey);
  const stringToSign = `${expiresAtSec}\n${method}\n${resource}\n${version}`;
  const sign = crypto.createHmac(method, key).update(stringToSign, 'utf8').digest('base64');

  return [
    `version=${version}`,
    `res=${encodeURIComponent(resource)}`,
    `et=${expiresAtSec}`,
    `method=${method}`,
    `sign=${encodeURIComponent(sign)}`
  ].join('&');
}

module.exports = Object.freeze({
  SIGN_METHOD,
  TOKEN_VERSION,
  buildDeviceResource,
  createDeviceToken
});
