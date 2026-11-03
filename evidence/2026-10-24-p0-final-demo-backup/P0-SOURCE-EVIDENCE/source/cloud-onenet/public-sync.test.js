'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_PUBLIC_BACKEND_URL,
  validatePublicOrigin,
  describeBroker,
  createBackendOnlyTransport
} = require('./public-sync');

test('public sync defaults to the deployed HTTPS origin', () => {
  assert.equal(DEFAULT_PUBLIC_BACKEND_URL, 'https://api.luxunacc.xyz');
  assert.equal(validatePublicOrigin(`${DEFAULT_PUBLIC_BACKEND_URL}/`), DEFAULT_PUBLIC_BACKEND_URL);
});

test('public origin rejects insecure or ambiguous URLs', () => {
  for (const value of [
    'http://api.luxunacc.xyz',
    'https://user:pass@api.luxunacc.xyz',
    'https://api.luxunacc.xyz/internal',
    'https://api.luxunacc.xyz?key=value',
    'not-a-url'
  ]) {
    assert.throws(() => validatePublicOrigin(value), TypeError);
  }
});

test('broker description removes credentials and paths', () => {
  assert.equal(describeBroker('mqtt://user:secret@127.0.0.1:1883/private'), 'mqtt://127.0.0.1:1883');
  assert.equal(describeBroker('invalid broker value'), 'configured');
});

test('backend-only transport never attempts OneNET publication', async () => {
  const transport = createBackendOnlyTransport();
  assert.deepEqual(await transport.publishProperty({}), { skipped: true });
  assert.deepEqual(await transport.publishAlarm({}), { skipped: true });
});
