#!/usr/bin/env node
'use strict';
/**
 * 真机 SOS → 公网 ACK → 设备回执 验证脚本（公共 Broker 版本，验证用）
 * 用法：node real-sos-ack-test.js [seconds]
 * 行为：订阅 up；收到 t:"sos" 后 5s 向 down 发匹配 alarm 的 ACK（cmd=test1）；
 *       记录设备回执 t:"ack"；同时记录 GPS 固定格式报文。全程写 real-sos-ack.log。
 */
const path = require('path');
const fs = require('fs');
const mqtt = require(path.join(__dirname, '..', '..', '..', 'cloud', 'onenet', 'node_modules', 'mqtt'));

const BROKER = 'mqtt://broker.emqx.io:1883';
const UP = 'eldercare/wearable/sos-001/up';
const DOWN = 'eldercare/wearable/sos-001/down';
const SECONDS = Number(process.argv[2] || 180);
const OUT = path.join(__dirname, '..', 'real-sos-ack.log');

const lines = [];
const log = (s) => { const x = `${new Date().toISOString()} ${s}`; lines.push(x); console.log(x); };
const seen = new Map();
let ackSent = 0;

const c = mqtt.connect(BROKER, { clientId: 'pc-sos-ack-' + Math.random().toString(16).slice(2, 10), clean: true, reconnectPeriod: 2000, connectTimeout: 8000 });
c.on('connect', () => {
  c.subscribe([UP, DOWN], { qos: 0 });
  log('MQTT connected; listening ' + SECONDS + 's');
});
c.on('error', (e) => log('MQTT error ' + e.message));
c.on('message', (topic, payload) => {
  const text = payload.toString('utf8').trim();
  log(`MQTT<< ${topic} ${JSON.stringify(text)}`);
  if (topic !== UP) return;
  let obj = null;
  try { obj = JSON.parse(text); } catch (_) { return; }
  if (!obj || obj.v !== 1) return;
  if (obj.t === 'sos' && obj.alarm) {
    const n = (seen.get(obj.alarm) || 0) + 1;
    seen.set(obj.alarm, n);
    log(`SOS detected alarm=${obj.alarm} attempt=${n}`);
    if (n === 1) {
      setTimeout(() => {
        const frame = JSON.stringify({ v: 1, t: 'ack', alarm: obj.alarm, cmd: 'test1' });
        c.publish(DOWN, frame, { qos: 1 }, (e) => log(`ACK publish ${e ? 'ERR ' + e.message : 'ok'} ${frame}`));
        ackSent++;
      }, 5000);
      setTimeout(() => {
        const frame = JSON.stringify({ v: 1, t: 'ack', alarm: obj.alarm, cmd: 'test1' });
        c.publish(DOWN, frame, { qos: 1 }, (e) => log(`ACK retry ${e ? 'ERR ' + e.message : 'ok'}`));
      }, 15000);
    }
  }
  if (obj.t === 'ack') log(`DEVICE ACK RECEIVED alarm=${obj.alarm} cmd=${obj.cmd || ''}`);
});

setTimeout(() => {
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  log(`END alarms=${[...seen.keys()].join(',') || 'none'} ackSent=${ackSent} log=${OUT}`);
  c.end(true, () => process.exit(0));
}, SECONDS * 1000);
