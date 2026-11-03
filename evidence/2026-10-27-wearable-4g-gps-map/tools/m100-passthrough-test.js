#!/usr/bin/env node
'use strict';
/**
 * M100 透传真机验证工具（只用于验证，不写模块配置）
 *
 * 用途：
 *   --uplink    向 COM 写 JSON 行，验证 UART → MQTT 上行（观察 broker 上的 up 主题）
 *   --downlink  向 down 主题发布 JSON，验证 MQTT → UART 下行（观察 COM 读到的字节）
 *   --gps N     被动监听 up 主题 N 秒，抓取 M100 GPS 主动上报的原始报文
 *   --cfgtest   在 MQTT 已连接状态下向 COM 发 config,get,csq，验证配置回包不会混入 MQTT 上行
 *
 * 依赖：serialport 用 hardware/yed-m100mg-b1/node_modules；mqtt 用 cloud/onenet/node_modules。
 */
const path = require('path');
const fs = require('fs');
const { SerialPort } = require(path.join(__dirname, '..', '..', '..', 'hardware', 'yed-m100mg-b1', 'node_modules', 'serialport'));
const mqtt = require(path.join(__dirname, '..', '..', '..', 'cloud', 'onenet', 'node_modules', 'mqtt'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const PORT = String(arg('port', 'COM5'));
const BAUD = Number(arg('baud', 115200));
const BROKER = String(arg('broker', 'mqtt://broker.emqx.io:1883'));
const UP = String(arg('up', 'eldercare/wearable/sos-001/up'));
const DOWN = String(arg('down', 'eldercare/wearable/sos-001/down'));
const OUT = String(arg('out', path.join(__dirname, '..', 'm100-passthrough.log')));
const MODE = process.argv.includes('--downlink') ? 'downlink'
  : process.argv.includes('--gps') ? 'gps'
  : process.argv.includes('--cfgtest') ? 'cfgtest'
  : 'uplink';

const lines = [];
function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  lines.push(stamped);
  console.log(stamped);
}
function save() {
  try { fs.writeFileSync(OUT, lines.join('\n') + '\n'); } catch (e) { console.error('write log failed', e.message); }
}

async function main() {
  log(`MODE=${MODE} port=${PORT}@${BAUD} broker=${BROKER} up=${UP} down=${DOWN}`);
  const client = mqtt.connect(BROKER, {
    clientId: `pc-verify-${Math.random().toString(16).slice(2, 10)}`,
    clean: true, reconnectPeriod: 2000, connectTimeout: 8000, keepalive: 30
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('MQTT connect timeout')), 10000);
    client.once('connect', () => { clearTimeout(t); resolve(); });
    client.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  log('MQTT connected');

  const port = new SerialPort({ path: PORT, baudRate: BAUD, autoOpen: false });
  await new Promise((resolve, reject) => port.open((e) => e ? reject(e) : resolve()));
  log('serial opened');

  const rx = [];
  port.on('data', (buf) => {
    const hex = buf.toString('hex');
    const text = buf.toString('utf8').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    rx.push({ at: Date.now(), hex, text });
    log(`UART<< hex=${hex} text=${JSON.stringify(text)}`);
  });

  if (MODE === 'uplink' || MODE === 'cfgtest') {
    client.subscribe(UP, { qos: 0 }, (err) => { if (err) log('subscribe err ' + err.message); else log('subscribed up'); });
    client.on('message', (topic, payload) => log(`MQTT<< topic=${topic} payload=${JSON.stringify(payload.toString('utf8'))} hex=${payload.toString('hex')}`));
  }
  if (MODE === 'downlink') {
    client.on('message', (topic, payload) => log(`MQTT<< topic=${topic} payload=${JSON.stringify(payload.toString('utf8'))}`));
  }
  if (MODE === 'gps') {
    client.subscribe(UP, { qos: 0 }, (err) => { if (err) log('subscribe err ' + err.message); else log('subscribed up (gps watch)'); });
    client.on('message', (topic, payload) => log(`MQTT<< topic=${topic} payload=${JSON.stringify(payload.toString('utf8'))} hex=${payload.toString('hex')}`));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (MODE === 'uplink') {
    const frames = [
      '{"v":1,"t":"boot","dev":"esp32-sos","uptimeMs":0,"fw":"passthrough-test"}',
      '{"v":1,"t":"hb","dev":"esp32-sos","state":"IDLE","alarm":"","uptimeMs":1000}',
      '{"v":1,"t":"sos","dev":"esp32-sos","alarm":"sos-1-deadbeef","uptimeMs":2000,"seq":1,"gps":null}'
    ];
    for (const frame of frames) {
      log(`UART>> ${frame}`);
      port.write(frame + '\n');
      await sleep(3000);
    }
    await sleep(4000);
  }

  if (MODE === 'downlink') {
    const frame = '{"v":1,"t":"ack","alarm":"sos-1-deadbeef","cmd":"1"}';
    log(`MQTT>> publish down ${frame}`);
    client.publish(DOWN, frame, { qos: 1 }, (err) => log('publish cb ' + (err ? err.message : 'ok')));
    await sleep(5000);
  }

  if (MODE === 'gps') {
    const secs = Number(arg('seconds', 90));
    log(`listening ${secs}s for GPS fixed-format reports`);
    await sleep(secs * 1000);
  }

  if (MODE === 'cfgtest') {
    for (const cmd of ['config,get,csq', 'config,get,ssta', 'config,get,gpsext']) {
      log(`UART>> ${cmd}`);
      port.write(cmd + '\r\n');
      await sleep(2500);
    }
    await sleep(3000);
  }

  save();
  log(`rx bytes total=${rx.length} frames`);
  log('RESULT_SUMMARY ' + JSON.stringify({
    mode: MODE,
    uartFrames: rx.length,
    log: OUT
  }));
  await new Promise((r) => port.close(() => r()));
  client.end(true, () => process.exit(0));
}

main().catch((e) => { log('FATAL ' + (e && e.message)); save(); process.exit(1); });
