'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildConfig, describeConfig, readKeyValueFile, ConfigError } = require('../src/config');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wearable-mirror-config-'));
}

function write(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

test('env 文件支持注释/引号/空行，但不把值打印进 describeConfig', () => {
  const dir = tempDir();
  const envFile = path.join(dir, 'wearable-mqtt.env');
  write(envFile, [
    '# comment line',
    'MQTT_USER=mirror-user-xyz',
    'MQTT_PASS="mirror-pass-super-secret-123"',
    "UP_TOPIC='eldercare/wearable/sos-001/up'",
    '',
    'IGNORED LINE WITHOUT EQUALS'
  ].join('\n'));
  const guardianFile = path.join(dir, 'app_guardian.txt');
  write(guardianFile, 'guardian-id-abc\nguardian-password-super-secret-456\n');

  const parsed = readKeyValueFile(envFile);
  assert.equal(parsed.MQTT_USER, 'mirror-user-xyz');
  assert.equal(parsed.MQTT_PASS, 'mirror-pass-super-secret-123');
  assert.equal(parsed.UP_TOPIC, 'eldercare/wearable/sos-001/up');

  const config = buildConfig(['--env-file', envFile, '--guardian-file', guardianFile, '--source', 'api'], {});
  assert.equal(config.api.guardianId, 'guardian-id-abc');
  assert.equal(config.api.password, 'guardian-password-super-secret-456');
  assert.equal(config.mqtt.clientId, 'wearable-mirror-001');

  const described = JSON.stringify(describeConfig(config));
  for (const secret of ['mirror-pass-super-secret-123', 'guardian-password-super-secret-456', 'mirror-user-xyz']) {
    assert.equal(described.includes(secret), false, `describeConfig leaked ${secret}`);
  }
  assert.equal(described.includes('"hasMqttCredentials":true'), true);
});

test('缺凭据/非法 source/非法端口都 fail-fast', () => {
  const dir = tempDir();
  const envFile = path.join(dir, 'empty.env');
  write(envFile, '');
  const guardianFile = path.join(dir, 'guardian.txt');
  write(guardianFile, 'id\npass\n');

  assert.throws(() => buildConfig(['--env-file', envFile, '--guardian-file', guardianFile, '--source', 'mqtt'], {}), ConfigError);
  assert.throws(() => buildConfig(['--env-file', envFile, '--guardian-file', guardianFile, '--source', 'bogus'], {}), ConfigError);
  assert.throws(() => buildConfig(['--env-file', envFile, '--guardian-file', guardianFile, '--source', 'api', '--heartbeat-ms', 'x'], {}), ConfigError);
});

test('命令行覆盖：relay/端口/clientId/listen 端口', () => {
  const dir = tempDir();
  const envFile = path.join(dir, 'wearable.env');
  write(envFile, 'MQTT_USER=u\nMQTT_PASS=p\nUP_TOPIC=eldercare/wearable/sos-001/up\n');
  const guardianFile = path.join(dir, 'guardian.txt');
  write(guardianFile, 'id\npass\n');

  const config = buildConfig([
    '--env-file', envFile,
    '--guardian-file', guardianFile,
    '--source', 'api',
    '--transport', 'both',
    '--relay-to', '127.0.0.1:19001',
    '--listen-host', '127.0.0.1',
    '--listen-port', '19002',
    '--client-id', 'pc-mirror-test',
    '--heartbeat-ms', '5000',
    '--offline-after-ms', '30000',
    '--runtime-dir', path.join(dir, 'runtime')
  ], {});
  assert.equal(config.transport, 'both');
  assert.deepEqual(config.relay, { host: '127.0.0.1', port: 19001 });
  assert.deepEqual(config.tcp, { host: '127.0.0.1', port: 19002 });
  assert.equal(config.mqtt.clientId, 'pc-mirror-test');
  assert.equal(config.heartbeatMs, 5000);
  assert.equal(config.offlineAfterMs, 30000);
  assert.equal(config.lockFile, path.join(dir, 'runtime', 'mirror.lock'));
});

test('进程环境变量优先于 env 文件', () => {
  const dir = tempDir();
  const envFile = path.join(dir, 'wearable.env');
  write(envFile, 'MQTT_USER=file-user\nMQTT_PASS=file-pass\nUP_TOPIC=eldercare/wearable/sos-001/up\n');
  const guardianFile = path.join(dir, 'guardian.txt');
  write(guardianFile, 'id\npass\n');
  const config = buildConfig(['--env-file', envFile, '--guardian-file', guardianFile, '--source', 'mqtt'], {
    MQTT_USER: 'env-user',
    MQTT_PASS: 'env-pass'
  });
  assert.equal(config.mqtt.user, 'env-user');
  assert.equal(config.mqtt.pass, 'env-pass');
});
