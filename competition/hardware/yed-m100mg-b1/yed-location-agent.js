#!/usr/bin/env node
'use strict';

/**
 * yed-location-agent.js — YED-M100MG-B1 定位代理 CLI
 *
 * 安全默认：
 *   - 什么都不加 = 夹具模式，只打印报文，**绝不连串口、绝不发 MQTT**；
 *   - 真机必须同时给出 --real 与显式 --port（端口必须来自实时枚举，绝不写死）；
 *   - --publish 只在 --real 下有效：夹具数据永远不允许进入生产 MQTT/公网链路。
 *
 * 用法示例：
 *   node yed-location-agent.js --fixture --profile no-fix
 *   node yed-location-agent.js --real --port COM11 --publish --interval-ms 30000
 *   node yed-location-agent.js --real --port COM11 --once --publish
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const { SerialTransport } = require('./lib/transport');
const { probeDevice, readonlyCommands } = require('./lib/device');
const { createLocationAgent, createInstanceLock } = require('./lib/location-agent-core');
const { DEFAULT_DEVICE_ID, DEFAULT_ROOM } = require('./lib/location-status');
const { safeJsonStringify } = require('./lib/privacy');

const PKG_DIR = __dirname;
const REPO_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_MQTT_TOOL = path.join(REPO_DIR, 'bridge', 'mqtt_tool.js');
const DEFAULT_BROKER = '127.0.0.1:1883';

function parseArgs(argv) {
  const options = {
    real: false,
    fixture: true,
    profile: 'no-fix',
    port: null,
    baudRate: 115200,
    timeoutMs: 3000,
    retries: 0,
    intervalMs: 30000,
    once: false,
    publish: false,
    deviceId: DEFAULT_DEVICE_ID,
    room: DEFAULT_ROOM,
    broker: DEFAULT_BROKER,
    mqttTool: DEFAULT_MQTT_TOOL,
    log: null,
    lock: path.join(require('node:os').tmpdir(), 'yed-location-agent.lock'),
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error('missing value for ' + arg);
      return argv[index];
    };
    switch (arg) {
      case '--real': options.real = true; options.fixture = false; break;
      case '--fixture': options.fixture = true; options.real = false; break;
      case '--profile': options.profile = next(); break;
      case '--port': options.port = next(); break;
      case '--baud-rate': options.baudRate = Number.parseInt(next(), 10); break;
      case '--timeout-ms': options.timeoutMs = Number.parseInt(next(), 10); break;
      case '--retries': options.retries = Number.parseInt(next(), 10); break;
      case '--interval-ms': options.intervalMs = Number.parseInt(next(), 10); break;
      case '--once': options.once = true; break;
      case '--publish': options.publish = true; break;
      case '--device-id': options.deviceId = next(); break;
      case '--room': options.room = next(); break;
      case '--broker': options.broker = next(); break;
      case '--mqtt-tool': options.mqttTool = next(); break;
      case '--log': options.log = next(); break;
      case '--lock': options.lock = next(); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error('unknown option: ' + arg);
    }
  }
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1000) {
    throw new Error('--interval-ms must be an integer >= 1000');
  }
  if (options.real && (typeof options.port !== 'string' || options.port.length === 0)) {
    throw new Error('--real requires an explicit --port from a live enumeration (never hard-code COMxx)');
  }
  if (options.publish && options.real !== true) {
    throw new Error('--publish is only allowed together with --real (fixture data must never reach the chain)');
  }
  return options;
}

/** 日志与终端输出绝不带坐标。 */
function redactForOutput(payload, allowCoordinates) {
  if (allowCoordinates) return payload;
  const clone = JSON.parse(JSON.stringify(payload));
  if (clone.gps && clone.gps.valid === true) {
    clone.gps = { valid: true, latitude: '<redacted>', longitude: '<redacted>', fixTime: clone.gps.fixTime };
  }
  return clone;
}

function makeLogger(logPath) {
  const fs = require('node:fs');
  const stamp = () => new Date().toISOString();
  let handle = null;
  if (logPath) {
    fs.mkdirSync(path.dirname(path.resolve(logPath)), { recursive: true });
    handle = fs.appendFileSync;
  }
  return (line) => {
    const text = stamp() + ' ' + line;
    process.stdout.write(text + '\n');
    if (handle) {
      try {
        handle(path.resolve(logPath), text + '\n', 'utf8');
      } catch (_) {
        /* 日志写失败不影响代理 */
      }
    }
  };
}

/** 真实串口读：复用 lib/transport.js + lib/device.js 的既有接线与严格解析。 */
function createRealReader(options, log) {
  const { SerialPort } = require('serialport');
  const transport = new SerialTransport(
    {
      port: options.port,
      baudRate: options.baudRate,
      commandTimeoutMs: options.timeoutMs,
      retries: options.retries,
      quietMs: 250,
      autoReconnect: false
    },
    { createSerial: (serialOptions) => new SerialPort(Object.assign({}, serialOptions, { autoOpen: false })) }
  );
  let opened = false;

  async function ensureOpen() {
    if (!opened) {
      await transport.open();
      opened = true;
      log('[yed-location-agent] serial open port=' + options.port + ' baud=' + options.baudRate);
    }
  }

  return {
    transport,
    async read() {
      try {
        await ensureOpen();
        const summary = await probeDevice({
          transport,
          commands: [...readonlyCommands()],
          commandTimeoutMs: options.timeoutMs,
          retries: options.retries
        });
        const succeeded = summary && summary.stats ? summary.stats.succeeded : 0;
        return { ok: succeeded > 0, device: summary.device, errorCode: succeeded > 0 ? null : 'ALL_COMMANDS_FAILED' };
      } catch (error) {
        // 掉线后按有界退避重连：先彻底断开，下一轮再打开。
        try {
          await transport.disconnect();
        } catch (_) {
          /* 忽略 */
        }
        opened = false;
        return { ok: false, errorCode: (error && error.code) || 'SERIAL_READ_FAILED' };
      }
    },
    async close() {
      try {
        await transport.disconnect();
      } catch (_) {
        /* 忽略 */
      }
      opened = false;
    }
  };
}

/** 夹具 profile -> 夹具文件（与 lib/probe-device-core.js 的 FIXTURE_PROFILES 保持一致）。 */
const FIXTURE_PROFILES = Object.freeze({
  registered: 'device-registered.fixture',
  'gnss-fixed': 'device-gnss-fixed.fixture',
  'no-fix': 'device-no-fix.fixture',
  'csq-invalid': 'device-csq-invalid.fixture',
  'error-timeout-drop': 'device-error-timeout-drop.fixture'
});

/** 夹具读：复用 lib/fixture-transport.js，绝不打开真实串口。 */
function makeFixtureReader(options) {
  const { loadFixtureFile, FixtureTransport } = require('./lib/fixture-transport');
  const fileName = FIXTURE_PROFILES[options.profile];
  if (!fileName) {
    throw new Error('unknown --profile: ' + options.profile +
      ' (expected ' + Object.keys(FIXTURE_PROFILES).join('|') + ')');
  }
  const fixturePath = path.join(PKG_DIR, 'lib', 'fixtures', fileName);
  return async () => {
    const transport = new FixtureTransport(loadFixtureFile(fixturePath), { port: 'FIXTURE' });
    await transport.open();
    try {
      const summary = await probeDevice({ transport, commands: [...readonlyCommands()] });
      const succeeded = summary && summary.stats ? summary.stats.succeeded : 0;
      return { ok: succeeded > 0, device: summary.device, errorCode: succeeded > 0 ? null : 'FIXTURE_NO_RESPONSE' };
    } finally {
      await transport.disconnect();
    }
  };
}

function makeMqttPublisher(options, log) {
  return (topic, payload) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        options.mqttTool, 'pub',
        '--broker', options.broker,
        '--topic', topic,
        '--msg', JSON.stringify(payload)
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('mqtt publish failed code=' + code + ' ' + stderr.slice(0, 200)));
      });
    });
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write('argument error: ' + error.message + '\n');
    return 2;
  }
  if (options.help) {
    process.stdout.write('usage: node yed-location-agent.js [--fixture|--real --port COMx] [--once] [--publish]\n');
    return 0;
  }

  const log = makeLogger(options.log);
  const lock = createInstanceLock(options.lock);
  try {
    lock.acquire();
  } catch (error) {
    log('[yed-location-agent] refused to start: ' + error.message);
    return 2;
  }

  const reader = options.real
    ? createRealReader(options, log)
    : { read: makeFixtureReader(options), close: async () => {} };
  const publish = options.publish
    ? makeMqttPublisher(options, log)
    : async (topic, payload) => {
      log('[yed-location-agent] dry-run (not published) topic=' + topic);
    };

  const agent = createLocationAgent(
    {
      readDevice: () => reader.read(),
      publish,
      log
    },
    { intervalMs: options.intervalMs, deviceId: options.deviceId, room: options.room }
  );

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('[yed-location-agent] shutting down');
    await agent.stop();
    await reader.close();
    lock.release();
  };
  process.on('SIGINT', () => { shutdown().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)); });

  try {
    log('[yed-location-agent] start mode=' + (options.real ? 'real' : 'fixture') +
      ' publish=' + options.publish + ' deviceId=' + options.deviceId);
    if (options.once) {
      const result = await agent.pollOnce();
      process.stdout.write(safeJsonStringify(redactForOutput(result.payload, !options.real)) + '\n');
      return result.ok ? 0 : 1;
    }
    agent.start();
    await new Promise((resolve) => {
      process.on('SIGINT', resolve);
      process.on('SIGTERM', resolve);
    });
    return 0;
  } finally {
    await shutdown();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write('fatal: ' + (error && error.message ? error.message : String(error)) + '\n');
      process.exitCode = 1;
    }
  );
}

module.exports = { parseArgs, redactForOutput };
