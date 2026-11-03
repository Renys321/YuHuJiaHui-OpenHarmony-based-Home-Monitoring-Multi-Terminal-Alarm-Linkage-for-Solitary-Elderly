#!/usr/bin/env node
/**
 * real-device-harness.js — 真机验收用的“网关进程”
 *
 * 与 gateway.js 的唯一区别是：把 OneNET 传输层换成**伪传输层**，这样真机验收不需要真实密钥，
 * 同时仍然走完整的真实本地链路（真实 Broker + 真实 MQTT 客户端 + 真实板端状态）。
 *
 * 所有事件写成 JSONL 到 --events 指定的文件，供 PowerShell 侧断言；stdout 留作辅助日志。
 * 本文件不是生产入口，生产入口是 `npm run gateway`（gateway.js）。
 *
 * 用法：
 *   node real-device-harness.js --events <file.jsonl> [--broker mqtt://127.0.0.1:1883]
 *                               [--seconds 180] [--device-name <id>] [--reset-mode self]
 *                               [--reset-trigger <topic>]
 *
 * --reset-trigger：订阅该主题，收到任意消息就调用 gateway.handleCommand({command:'RESET'})，
 * 并把结果写成 `resetResult` 事件。用于在真机上验证“网关自身 RESET”下行闭环，而不需要
 * 真实 OneNET 凭据（生产环境里这一步由 OneNET property/set 下行触发）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createGateway } = require('./gateway');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const EVENTS = arg('events', path.join(__dirname, 'gateway-events.jsonl'));
const BROKER = arg('broker', 'mqtt://127.0.0.1:1883');
const SECONDS = parseInt(arg('seconds', '180'), 10);
const DEVICE_NAME = arg('device-name', 'dayu200-home-gateway');
const RESET_MODE = arg('reset-mode', 'self');
const RESET_TRIGGER = arg('reset-trigger', '');

fs.mkdirSync(path.dirname(EVENTS), { recursive: true });
const stream = fs.createWriteStream(EVENTS, { flags: 'a' });

function emit(event) {
  stream.write(JSON.stringify(Object.assign({ at: new Date().toISOString() }, event)) + '\n');
}

const fakeOneNet = {
  publishProperty(status, opts) {
    emit({ kind: 'property', id: opts.id, timestampMs: opts.timestampMs, deviceId: status.deviceId, room: status.room, state: status.state, alarmId: (status.alarm && status.alarm.id) || '' });
    return Promise.resolve({ id: opts.id, code: 200 });
  },
  publishAlarm(status, opts) {
    emit({ kind: 'alarm', id: opts.id, timestampMs: opts.timestampMs, deviceId: status.deviceId, alarmId: opts.alarm.id, type: opts.alarm.type, countToday: opts.alarm.countToday });
    return Promise.resolve({ id: opts.id, code: 200 });
  },
  on() {},
  off() {}
};

const gateway = createGateway({
  env: { GATEWAY_BROKER_URL: BROKER, ONENET_DEVICE_NAME: DEVICE_NAME, GATEWAY_RESET_MODE: RESET_MODE },
  transport: fakeOneNet,
  logger: {
    info: (m) => { console.log(m); emit({ kind: 'log', level: 'info', message: m }); },
    warn: (m) => { console.warn(m); emit({ kind: 'log', level: 'warn', message: m }); },
    error: (m) => { console.error(m); emit({ kind: 'log', level: 'error', message: m }); }
  }
});

gateway.on('statusRejected', (i) => emit({ kind: 'rejected', code: i.code, deviceId: i.deviceId }));
gateway.on('cloudError', (i) => emit({ kind: 'cloudError', code: i.code, deviceId: i.deviceId }));
gateway.on('deviceStatus', (i) => emit({ kind: 'status', deviceId: i.deviceId, room: i.room, state: i.state, alarmId: i.alarmId, stateChanged: i.stateChanged }));

emit({ kind: 'start', broker: BROKER, node: process.version, deviceName: DEVICE_NAME, resetMode: RESET_MODE });
gateway.start();

console.log(`[harness] gateway started, broker=${BROKER}, events=${EVENTS}, lifetime=${SECONDS}s`);
console.log(`[harness] deviceName=${DEVICE_NAME} resetMode=${RESET_MODE}`);

// 下行触发：订阅触发主题，收到消息即走网关真实的 handleCommand 路径（等价于 OneNET property/set）。
if (RESET_TRIGGER) {
  const mqtt = require('mqtt');
  const trigger = mqtt.connect(BROKER, { clientId: `harness-trigger-${Date.now() % 100000}` });
  trigger.on('connect', () => {
    trigger.subscribe(RESET_TRIGGER, { qos: 0 }, (error) => {
      console.log(`[harness] reset trigger subscribed topic=${RESET_TRIGGER} err=${error ? 'yes' : 'no'}`);
      emit({ kind: 'triggerSubscribed', topic: RESET_TRIGGER, ok: !error });
    });
  });
  trigger.on('message', async () => {
    emit({ kind: 'triggerReceived' });
    try {
      const result = await gateway.handleCommand({ command: 'RESET' }, { requestId: 'real-device-trigger' });
      emit({ kind: 'resetResult', ok: Boolean(result && result.ok), message: result && result.message });
      console.log(`[harness] RESET result ok=${result && result.ok} message=${result && result.message}`);
    } catch (error) {
      emit({ kind: 'resetResult', ok: false, message: 'handler threw' });
    }
  });
  gateway.resetTrigger = trigger;
}

setTimeout(async () => {
  await gateway.stop('HARNESS_DONE');
  emit({ kind: 'stop' });
  stream.end(() => process.exit(0));
}, SECONDS * 1000).unref?.();

process.on('SIGTERM', async () => {
  await gateway.stop('SIGTERM');
  emit({ kind: 'stop', reason: 'SIGTERM' });
  stream.end(() => process.exit(0));
});
