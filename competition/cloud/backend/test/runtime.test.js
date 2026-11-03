'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRuntime, parseContacts, parsePort, probeDataPath } = require('../src/main');
const { PersistentStore } = require('../src/persistent-store');
const { EvidenceStore } = require('../src/evidence-store');

test('runtime validates deployment configuration', () => {
  assert.equal(parsePort(undefined), 8080);
  assert.equal(parsePort('443'), 443);
  assert.throws(() => parsePort('0'), /PORT/);
  assert.throws(() => parsePort('8080x'), /PORT/);
  assert.deepEqual(parseContacts('[{"name":"家属","phone":"13800000000"}]')[0].name, '家属');
  assert.throws(() => parseContacts('{}'), /array/);
});

test('official runtime uses PersistentStore and the configured data path', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-runtime-'));
  const filePath = path.join(directory, 'state.json');
  const evidenceDirectory = path.join(directory, 'evidence');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const runtime = createRuntime({
    PORT: '18080',
    HOST: '127.0.0.1',
    BACKEND_DATA_FILE: filePath,
    BACKEND_EVIDENCE_DIR: evidenceDirectory,
    API_TOKEN_SECRET: 'runtime-test-token-secret-at-least-32-characters',
    INGEST_KEY: 'runtime-test-ingest-key-at-least-32-characters',
    WECHAT_APP_ID: 'wx-runtime-test',
    WECHAT_APP_SECRET: 'runtime-test-app-secret',
    WECHAT_ALLOWED_OPENIDS: '["runtime-allowed-openid"]'
  });

  assert.ok(runtime.store instanceof PersistentStore);
  assert.ok(runtime.evidenceStore instanceof EvidenceStore);
  assert.equal(runtime.dataFile, path.resolve(filePath));
  assert.equal(runtime.host, '127.0.0.1');
  assert.equal(runtime.port, 18080);
  assert.equal(fs.existsSync(filePath), false, 'empty startup must not create a false snapshot');
  assert.equal(probeDataPath(filePath), true);
  assert.deepEqual(fs.readdirSync(directory), ['evidence'], 'readiness probes must not leave files behind');
  assert.deepEqual(fs.readdirSync(evidenceDirectory), [], 'evidence readiness probe must not leave files behind');
});

test('official runtime fails fast when the persistent directory cannot be created', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-runtime-blocked-'));
  const blockingFile = path.join(directory, 'not-a-directory');
  fs.writeFileSync(blockingFile, 'x');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const env = {
    BACKEND_DATA_FILE: path.join(blockingFile, 'state.json'),
    API_TOKEN_SECRET: 'runtime-test-token-secret-at-least-32-characters',
    INGEST_KEY: 'runtime-test-ingest-key-at-least-32-characters',
    WECHAT_APP_ID: 'wx-runtime-test',
    WECHAT_APP_SECRET: 'runtime-test-app-secret',
    WECHAT_ALLOWED_OPENIDS: '["runtime-allowed-openid"]'
  };
  assert.throws(() => createRuntime(env), (error) => {
    assert.equal(error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(error.message, 'BACKEND_DATA_FILE storage unavailable');
    assert.ok(!error.message.includes(directory));
    return true;
  });
});

test('official runtime fails closed when a required secret is missing', () => {
  assert.throws(() => createRuntime({}), /API_TOKEN_SECRET/);
});

test('official runtime fails closed when the household allowlist is missing or invalid', () => {
  const base = {
    API_TOKEN_SECRET: 'runtime-test-token-secret-at-least-32-characters',
    INGEST_KEY: 'runtime-test-ingest-key-at-least-32-characters',
    WECHAT_APP_ID: 'wx-runtime-test',
    WECHAT_APP_SECRET: 'runtime-test-app-secret'
  };
  assert.throws(() => createRuntime(base), /WECHAT_ALLOWED_OPENIDS/);
  assert.throws(() => createRuntime({ ...base, WECHAT_ALLOWED_OPENIDS: '[]' }), /allowed openids/);
});

test('official runtime supports APP-only guardian authentication without WeChat credentials', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-runtime-app-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = createRuntime({
    BACKEND_DATA_FILE: path.join(directory, 'state.json'),
    BACKEND_EVIDENCE_DIR: path.join(directory, 'evidence'),
    API_TOKEN_SECRET: 'runtime-test-token-secret-at-least-32-characters',
    INGEST_KEY: 'runtime-test-ingest-key-at-least-32-characters',
    APP_GUARDIAN_ID: 'family-guardian',
    APP_GUARDIAN_PASSWORD: 'runtime-test-app-password-at-least-32-characters'
  });
  assert.equal(runtime.notificationDelivery, null);
  assert.ok(runtime.store instanceof PersistentStore);
});

test('runtime rejects partial or missing guardian authentication configuration', () => {
  const base = {
    API_TOKEN_SECRET: 'runtime-test-token-secret-at-least-32-characters',
    INGEST_KEY: 'runtime-test-ingest-key-at-least-32-characters'
  };
  assert.throws(() => createRuntime(base), /at least one guardian authentication/);
  assert.throws(() => createRuntime({ ...base, APP_GUARDIAN_ID: 'family-guardian' }), /configured together/);
  assert.throws(() => createRuntime({
    ...base,
    APP_GUARDIAN_ID: 'family-guardian',
    APP_GUARDIAN_PASSWORD: 'short'
  }), /8-256/);
});
