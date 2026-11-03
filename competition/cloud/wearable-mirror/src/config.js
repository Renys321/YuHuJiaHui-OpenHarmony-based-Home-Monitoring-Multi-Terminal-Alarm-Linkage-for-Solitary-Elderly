'use strict';

/**
 * config.js — 命令行参数 + 环境变量/凭据文件解析（**绝不记录密钥值**）。
 *
 * 凭据来源优先级：显式 --key 参数 > 进程环境变量 > 凭据文件。
 *
 *   MQTT 凭据文件默认：competition/.secrets/wearable-mqtt.env
 *     MQTT_USER / MQTT_PASS / MQTT_CLIENT_ID / UP_TOPIC / DOWN_TOPIC
 *   API 数据源凭据默认：competition/.secrets/app_guardian.txt（两行：账号 / 口令）
 *
 * 本模块只做解析与校验，输出对象中凭据字段存在，但 describeConfig() 只输出
 * “是否具备”布尔值，供日志与状态文件使用。
 */

const fs = require('node:fs');
const path = require('node:path');

const MIRROR_DIR = path.resolve(__dirname, '..');
const COMPETITION_DIR = path.resolve(MIRROR_DIR, '..', '..');
const REPO_DIR = path.resolve(COMPETITION_DIR, '..');

const DEFAULT_ENV_FILE = path.join(COMPETITION_DIR, '.secrets', 'wearable-mqtt.env');
const DEFAULT_GUARDIAN_FILE = path.join(COMPETITION_DIR, '.secrets', 'app_guardian.txt');

const DEVICE_ID = 'esp32-sos';
const ROOM = '随身求助';
const ALARM_TYPE = 'MANUAL_SOS';

const SOURCES = ['auto', 'mqtt', 'api'];
const TRANSPORTS = ['relay', 'tcp', 'both'];

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readKeyValueFile(file) {
  const values = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read env file ${path.basename(file)}: ${err.code || 'error'}`);
  }
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = KEY_RE.exec(trimmed);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[m[1]] = value;
  }
  return values;
}

function readGuardianFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read guardian file ${path.basename(file)}: ${err.code || 'error'}`);
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length < 2) throw new ConfigError('guardian file must contain two lines: guardianId and password');
  return { guardianId: lines[0], password: lines[1] };
}

function parseIntArg(raw, name, min, max, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) throw new ConfigError(`${name} must be a non-negative integer`);
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be in [${min}, ${max}]`);
  }
  return value;
}

function parseHostPort(raw, fallbackHost, fallbackPort, name) {
  const text = raw === undefined || raw === null || raw === '' ? '' : String(raw);
  if (text === '') return { host: fallbackHost, port: fallbackPort };
  const idx = text.lastIndexOf(':');
  if (idx <= 0) throw new ConfigError(`${name} must be host:port`);
  const host = text.slice(0, idx);
  const port = parseIntArg(text.slice(idx + 1), `${name}.port`, 1, 65535, fallbackPort);
  return { host, port };
}

/** 解析 argv（支持 --key value 与 --key=value，布尔开关为 --flag） */
function parseArgv(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq > 0) {
      args[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[body] = next;
      i += 1;
    } else {
      args[body] = 'true';
    }
  }
  return args;
}

function buildConfig(argv = [], processEnv = process.env) {
  const args = parseArgv(argv);

  const envFile = args['env-file'] || processEnv.MIRROR_ENV_FILE || DEFAULT_ENV_FILE;
  const guardianFile = args['guardian-file'] || processEnv.MIRROR_GUARDIAN_FILE || DEFAULT_GUARDIAN_FILE;

  const mqttFile = readKeyValueFile(envFile);
  const pick = (key) => {
    const fromEnv = typeof processEnv[key] === 'string' ? processEnv[key].trim() : '';
    if (fromEnv !== '') return fromEnv;
    return typeof mqttFile[key] === 'string' ? mqttFile[key].trim() : '';
  };

  const source = String(args.source || processEnv.MIRROR_SOURCE || 'auto').toLowerCase();
  if (!SOURCES.includes(source)) throw new ConfigError(`source must be one of ${SOURCES.join('|')}`);

  const transport = String(args.transport || processEnv.MIRROR_TRANSPORT || 'relay').toLowerCase();
  if (!TRANSPORTS.includes(transport)) throw new ConfigError(`transport must be one of ${TRANSPORTS.join('|')}`);

  const mqttUser = pick('MQTT_USER');
  const mqttPass = pick('MQTT_PASS');
  const mqttClientId = String(args['client-id'] || processEnv.MIRROR_MQTT_CLIENT_ID || 'wearable-mirror-001');
  const upTopic = pick('UP_TOPIC') || 'eldercare/wearable/sos-001/up';
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(mqttClientId)) throw new ConfigError('client id is invalid');
  if (upTopic.length === 0 || upTopic.length > 1024 || /[#+\u0000]/.test(upTopic)) {
    throw new ConfigError('UP_TOPIC is invalid');
  }

  let guardianId = String(processEnv.MIRROR_GUARDIAN_ID || '').trim();
  let guardianPassword = String(processEnv.MIRROR_GUARDIAN_PASSWORD || '').trim();
  let guardianSource = guardianId !== '' && guardianPassword !== '' ? 'env' : '';
  if (guardianSource === '') {
    try {
      const guardian = readGuardianFile(guardianFile);
      guardianId = guardian.guardianId;
      guardianPassword = guardian.password;
      guardianSource = 'file';
    } catch (err) {
      guardianSource = '';
      guardianId = '';
      guardianPassword = '';
    }
  }

  const hasMqttCredentials = mqttUser !== '' && mqttPass !== '';
  const hasGuardianCredentials = guardianId !== '' && guardianPassword !== '';
  if (source === 'mqtt' && !hasMqttCredentials) {
    throw new ConfigError('source=mqtt requires MQTT_USER/MQTT_PASS in env file');
  }
  if (source === 'api' && !hasGuardianCredentials) {
    throw new ConfigError('source=api requires guardian credentials (env MIRROR_GUARDIAN_ID/PASSWORD or .secrets/app_guardian.txt)');
  }
  if (source === 'auto' && !hasMqttCredentials && !hasGuardianCredentials) {
    throw new ConfigError('source=auto needs either MQTT credentials or guardian credentials');
  }

  const mqttHostPort = parseHostPort(
    args['mqtt-broker'] || processEnv.MIRROR_MQTT_BROKER || '',
    pick('MQTT_HOST') || '47.76.70.118',
    parseIntArg(pick('MQTT_PORT'), 'MQTT_PORT', 1, 65535, 1883),
    '--mqtt-broker'
  );
  const relayHostPort = parseHostPort(
    args['relay-to'] || processEnv.MIRROR_RELAY_TO || '',
    '127.0.0.1', 9001, '--relay-to'
  );

  const apiBaseRaw = String(args['api-base'] || processEnv.MIRROR_API_BASE || 'https://api.luxunacc.xyz').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(apiBaseRaw)) throw new ConfigError('api base must be an absolute http(s) URL');

  const runtimeDir = path.resolve(String(args['runtime-dir'] || processEnv.MIRROR_RUNTIME_DIR || path.join(MIRROR_DIR, 'runtime')));

  return Object.freeze(deepFreeze({
    source,
    transport,
    mqtt: {
      host: mqttHostPort.host,
      port: mqttHostPort.port,
      user: mqttUser,
      pass: mqttPass,
      clientId: mqttClientId,
      upTopic
    },
    api: {
      base: apiBaseRaw,
      guardianId,
      password: guardianPassword,
      guardianSource,
      pollMs: parseIntArg(args['poll-ms'] || processEnv.MIRROR_API_POLL_MS, 'poll-ms', 20, 60000, 3000),
      requestTimeoutMs: parseIntArg(args['http-timeout-ms'] || processEnv.MIRROR_HTTP_TIMEOUT_MS, 'http-timeout-ms', 500, 60000, 8000)
    },
    relay: { host: relayHostPort.host, port: relayHostPort.port },
    tcp: {
      host: String(args['listen-host'] || processEnv.MIRROR_TCP_HOST || '127.0.0.1'),
      port: parseIntArg(args['listen-port'] || processEnv.MIRROR_TCP_PORT, 'listen-port', 1, 65535, 9002)
    },
    deviceId: DEVICE_ID,
    room: ROOM,
    alarmType: ALARM_TYPE,
    heartbeatMs: parseIntArg(args['heartbeat-ms'] || processEnv.MIRROR_HEARTBEAT_MS, 'heartbeat-ms', 100, 300000, 5000),
    offlineAfterMs: parseIntArg(args['offline-after-ms'] || processEnv.MIRROR_OFFLINE_AFTER_MS, 'offline-after-ms', 5000, 3600000, 45000),
    emitDebounceMs: parseIntArg(args['emit-debounce-ms'] || processEnv.MIRROR_EMIT_DEBOUNCE_MS, 'emit-debounce-ms', 0, 5000, 120),
    runtimeDir,
    lockFile: path.join(runtimeDir, 'mirror.lock'),
    statusFile: path.join(runtimeDir, 'mirror-status.json'),
    logLevel: String(args['log-level'] || processEnv.MIRROR_LOG_LEVEL || 'info').toLowerCase(),
    envFileExists: fs.existsSync(envFile),
    guardianFileExists: fs.existsSync(guardianFile)
  }));
}

function describeConfig(config) {
  return {
    source: config.source,
    transport: config.transport,
    mqttHost: `${config.mqtt.host}:${config.mqtt.port}`,
    mqttClientId: config.mqtt.clientId,
    upTopic: config.mqtt.upTopic,
    hasMqttCredentials: config.mqtt.user !== '' && config.mqtt.pass !== '',
    apiBase: config.api.base,
    hasGuardianCredentials: config.api.guardianId !== '' && config.api.password !== '',
    guardianSource: config.api.guardianSource,
    apiPollMs: config.api.pollMs,
    relay: `${config.relay.host}:${config.relay.port}`,
    tcpListen: `${config.tcp.host}:${config.tcp.port}`,
    deviceId: config.deviceId,
    room: config.room,
    heartbeatMs: config.heartbeatMs,
    offlineAfterMs: config.offlineAfterMs,
    runtimeDir: config.runtimeDir
  };
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

module.exports = Object.freeze({
  buildConfig,
  describeConfig,
  parseArgv,
  readKeyValueFile,
  ConfigError,
  DEVICE_ID,
  ROOM,
  ALARM_TYPE,
  SOURCES,
  TRANSPORTS,
  MIRROR_DIR,
  COMPETITION_DIR,
  REPO_DIR,
  DEFAULT_ENV_FILE,
  DEFAULT_GUARDIAN_FILE
});
