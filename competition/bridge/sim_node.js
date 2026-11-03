#!/usr/bin/env node
/**
 * ESP32-S3 房间节点的软件替身。
 *
 * 该脚本复现 TCP JSON 行协议和告警状态机，用于硬件未到时验证路由与闭环。
 * 它不构成实体传感器、安装位置或真实告警准确率的验收证据。
 */
'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROOM_MAX_LENGTH = 32;
const EPOCH_MS_MIN = 1_000_000_000_000;
const EPOCH_MS_MAX = 9_999_999_999_999;
const ALARM_COMMANDS = Object.freeze({ gas: 'GAS', smoke: 'SMOKE', sos: 'MANUAL_SOS' });

const PROFILES = Object.freeze({
  generic: Object.freeze({
    deviceId: 'esp32-sim-bath',
    room: '卫生间',
    capabilities: Object.freeze(['motion', 'door', 'climate', 'gas', 'smoke', 'sos'])
  }),
  kitchen: Object.freeze({
    deviceId: 'esp32-kitchen',
    room: '厨房',
    capabilities: Object.freeze(['climate', 'gas', 'smoke', 'sos'])
  }),
  bedroom: Object.freeze({
    deviceId: 'esp32-bedroom',
    room: '卧室',
    capabilities: Object.freeze(['motion', 'door', 'climate', 'sos'])
  })
});

function fail(message) {
  throw new TypeError(message);
}

function parseGateway(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) {
    fail('--gw must be a non-empty host:port value');
  }

  let host;
  let portText;
  if (value.startsWith('[')) {
    const match = /^\[([^\]]+)]:(\d+)$/.exec(value);
    if (!match) fail('--gw IPv6 addresses must use [address]:port');
    [, host, portText] = match;
  } else {
    const separator = value.lastIndexOf(':');
    if (separator <= 0 || value.indexOf(':') !== separator) fail('--gw must use host:port');
    host = value.slice(0, separator);
    portText = value.slice(separator + 1);
  }

  if (!host || host.length > 253 || /[\s/\\?#@]/.test(host)) fail('--gw host is invalid');
  if (!/^\d+$/.test(portText)) fail('--gw port must be an integer');
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('--gw port must be in [1, 65535]');
  return Object.freeze({ host, port });
}

function parseArgs(argv) {
  if (!Array.isArray(argv)) fail('argv must be an array');
  const values = {};
  const allowed = new Set(['profile', 'gw', 'id', 'room', 'every']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--')) fail(`unexpected argument: ${String(flag)}`);
    const name = flag.slice(2);
    if (!allowed.has(name)) fail(`unknown option: ${flag}`);
    if (Object.hasOwn(values, name)) fail(`duplicate option: ${flag}`);
    if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) {
      fail(`missing value for ${flag}`);
    }
    values[name] = value;
  }

  const profileName = values.profile || 'generic';
  const profile = PROFILES[profileName];
  if (!profile) fail(`--profile must be one of ${Object.keys(PROFILES).join(', ')}`);

  const deviceId = values.id || profile.deviceId;
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
    fail('--id must start with an ASCII letter or digit and contain only [A-Za-z0-9._-] (1-64 characters)');
  }

  const room = values.room || profile.room;
  if (typeof room !== 'string' || room.trim() !== room || room.length < 1 || room.length > ROOM_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(room)) {
    fail(`--room must be 1-${ROOM_MAX_LENGTH} visible characters without surrounding spaces`);
  }

  const everyText = values.every || '3';
  if (!/^\d+$/.test(String(everyText))) fail('--every must be an integer in seconds');
  const everySec = Number(everyText);
  if (!Number.isSafeInteger(everySec) || everySec < 1 || everySec > 3600) {
    fail('--every must be in [1, 3600] seconds');
  }

  return Object.freeze({
    profile: profileName,
    deviceId,
    room,
    everySec,
    gateway: parseGateway(values.gw || '127.0.0.1:9100'),
    capabilities: profile.capabilities
  });
}

function requireNow(now) {
  if (!Number.isSafeInteger(now) || now < EPOCH_MS_MIN || now > EPOCH_MS_MAX) {
    fail('now must be a 13-digit UTC Unix timestamp in milliseconds');
  }
  return now;
}

class SimNodeState {
  constructor(config, options = {}) {
    if (!config || typeof config !== 'object') fail('config is required');
    if (!DEVICE_ID_RE.test(config.deviceId || '')) fail('config.deviceId is invalid');
    if (!Array.isArray(config.capabilities)) fail('config.capabilities must be an array');
    this.deviceId = config.deviceId;
    this.room = config.room;
    this.capabilities = new Set(config.capabilities);
    this.deviceKey = crypto.createHash('sha256').update(this.deviceId, 'utf8').digest('hex').slice(0, 8);
    this.now = options.now || (() => Date.now());
    if (typeof this.now !== 'function') fail('options.now must be a function');
    this.motionCount = 0;
    this.lastMotionTs = 0;
    this.doorOpen = false;
    this.lastOpenTs = 0;
    this.state = 'NORMAL';
    this.alarmId = '';
    this.alarmType = '';
    this.alarmCountToday = 0;
    this.sequence = 0;
  }

  snapshot(now = this.now()) {
    requireNow(now);
    const sensors = {};
    if (this.capabilities.has('motion')) {
      sensors.motion = { lastActiveTs: this.lastMotionTs, countToday: this.motionCount };
    }
    if (this.capabilities.has('door')) {
      sensors.door = { open: this.doorOpen, lastOpenTs: this.lastOpenTs };
    }
    if (this.capabilities.has('climate')) {
      sensors.climate = { tempC: 0, rh: 0, ok: true };
    }
    if (this.capabilities.has('gas')) sensors.gas = { raw: 0, ok: this.alarmType !== 'GAS' };
    if (this.capabilities.has('smoke')) sensors.smoke = { raw: 0, ok: this.alarmType !== 'SMOKE' };

    return {
      deviceId: this.deviceId,
      room: this.room,
      ts: now,
      state: this.state,
      sensors,
      history: [0, 0, 0, 0, 0, 0, this.motionCount],
      slots: [0, 0, 0, 0],
      alarm: {
        id: this.alarmId,
        type: this.alarmType,
        countToday: this.alarmCountToday
      }
    };
  }

  statusLine(now = this.now()) {
    return `${JSON.stringify(this.snapshot(now))}\n`;
  }

  _startAlarm(type, now) {
    this.sequence += 1;
    this.alarmCountToday += 1;
    this.alarmId = `sim-${this.deviceKey}-${now}-${this.sequence}`;
    this.alarmType = type;
    this.state = 'ALARM';
  }

  handleCommand(line, now = this.now()) {
    requireNow(now);
    const text = typeof line === 'string' ? line.trim() : '';
    if (!text) return Object.freeze({ accepted: false, code: 'EMPTY_COMMAND' });
    const [command, ...parts] = text.split(/\s+/);

    if (command === 'ack') {
      const receivedId = parts[0] || '';
      if (this.state !== 'ALARM' || !this.alarmId) {
        return Object.freeze({ accepted: false, code: 'NO_ACTIVE_ALARM' });
      }
      if (receivedId !== this.alarmId) {
        return Object.freeze({ accepted: false, code: 'ALARM_ID_MISMATCH' });
      }
      this.state = 'ACKED';
      return Object.freeze({ accepted: true, code: 'ACKED' });
    }

    if (command === 'reset') {
      this.state = 'NORMAL';
      this.alarmId = '';
      this.alarmType = '';
      return Object.freeze({ accepted: true, code: 'RESET' });
    }

    if (command === 'motion') {
      if (!this.capabilities.has('motion')) return Object.freeze({ accepted: false, code: 'UNSUPPORTED_CAPABILITY' });
      this.motionCount += 1;
      this.lastMotionTs = now;
      return Object.freeze({ accepted: true, code: 'MOTION' });
    }

    if (command === 'door') {
      if (!this.capabilities.has('door')) return Object.freeze({ accepted: false, code: 'UNSUPPORTED_CAPABILITY' });
      const action = parts[0] || 'open';
      if (!['open', 'close'].includes(action)) return Object.freeze({ accepted: false, code: 'INVALID_ARGUMENT' });
      this.doorOpen = action === 'open';
      if (this.doorOpen) this.lastOpenTs = now;
      return Object.freeze({ accepted: true, code: this.doorOpen ? 'DOOR_OPEN' : 'DOOR_CLOSED' });
    }

    const alarmType = ALARM_COMMANDS[command];
    if (alarmType) {
      if (!this.capabilities.has(command)) return Object.freeze({ accepted: false, code: 'UNSUPPORTED_CAPABILITY' });
      this._startAlarm(alarmType, now);
      return Object.freeze({ accepted: true, code: 'ALARM_STARTED', alarmId: this.alarmId });
    }

    return Object.freeze({ accepted: false, code: 'UNKNOWN_COMMAND' });
  }
}

function startClient(config, options = {}) {
  const logger = options.logger || console;
  const nodeState = options.nodeState || new SimNodeState(config);
  const reconnectDelayMs = options.reconnectDelayMs === undefined ? 3000 : options.reconnectDelayMs;
  const reportIntervalMs = options.reportIntervalMs === undefined ? config.everySec * 1000 : options.reportIntervalMs;
  if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 10 || reconnectDelayMs > 60000) {
    fail('options.reconnectDelayMs must be in [10, 60000]');
  }
  if (!Number.isSafeInteger(reportIntervalMs) || reportIntervalMs < 10 || reportIntervalMs > 3600000) {
    fail('options.reportIntervalMs must be in [10, 3600000]');
  }
  let socket = null;
  let receiveBuffer = '';
  let reconnectTimer = null;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    socket = net.createConnection(config.gateway, () => {
      logger.log(`[sim-node] 已连接网关 ${config.gateway.host}:${config.gateway.port}（${config.deviceId} / ${config.room} / ${config.profile}）`);
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      receiveBuffer += chunk;
      let newline;
      while ((newline = receiveBuffer.indexOf('\n')) >= 0) {
        const line = receiveBuffer.slice(0, newline);
        receiveBuffer = receiveBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        const result = nodeState.handleCommand(line);
        logger.log(`[sim-node] 命令 ${result.accepted ? '已接受' : '已拒绝'} code=${result.code}`);
      }
    });
    socket.on('close', () => {
      socket = null;
      if (stopped) return;
      logger.log(`[sim-node] 与网关断开，${reconnectDelayMs} 毫秒后重连`);
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
    });
    socket.on('error', (error) => logger.error(`[sim-node] 连接错误: ${error.message}`));
  };

  connect();
  const reportTimer = setInterval(() => {
    if (!socket || socket.destroyed) return;
    socket.write(nodeState.statusLine());
    logger.log(`[sim-node] → ${nodeState.state} 活动 ${nodeState.motionCount} 次`);
  }, reportIntervalMs);

  return Object.freeze({
    state: nodeState,
    close() {
      stopped = true;
      clearInterval(reportTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) socket.destroy();
    }
  });
}

function main(argv = process.argv.slice(2)) {
  try {
    return startClient(parseArgs(argv));
  } catch (error) {
    console.error(`[sim-node] 参数错误: ${error.message}`);
    process.exitCode = 2;
    return null;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  PROFILES,
  SimNodeState,
  parseArgs,
  parseGateway,
  startClient,
  main
});
