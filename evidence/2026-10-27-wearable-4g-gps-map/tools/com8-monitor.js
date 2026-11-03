#!/usr/bin/env node
'use strict';
/* 同时观察 ESP32 串口日志与公网 MQTT 上行，用于真机联调取证。 */
const path = require('path');
const fs = require('fs');
const { SerialPort } = require(path.join(__dirname, '..', '..', '..', 'hardware', 'yed-m100mg-b1', 'node_modules', 'serialport'));
const mqtt = require(path.join(__dirname, '..', '..', '..', 'cloud', 'onenet', 'node_modules', 'mqtt'));

const PORT = process.argv[2] || 'COM8';
const BAUD = Number(process.argv[3] || 115200);
const BROKER = process.argv[4] || 'mqtt://broker.emqx.io:1883';
const TOPIC = process.argv[5] || 'eldercare/wearable/sos-001/up';
const SECONDS = Number(process.argv[6] || 25);
const OUT = path.join(__dirname, '..', 'com8-monitor.log');

const lines = [];
function log(s) { const x = `${new Date().toISOString()} ${s}`; lines.push(x); console.log(x); }

async function main() {
  const client = mqtt.connect(BROKER, { clientId: 'pc-mon-' + Math.random().toString(16).slice(2, 10), clean: true, reconnectPeriod: 2000, connectTimeout: 8000 });
  client.on('connect', () => { client.subscribe(TOPIC, { qos: 0 }); log('MQTT connected & subscribed ' + TOPIC); });
  client.on('message', (t, p) => log(`MQTT<< ${t} ${JSON.stringify(p.toString())}`));
  client.on('error', (e) => log('MQTT err ' + e.message));

  const port = new SerialPort({ path: PORT, baudRate: BAUD, autoOpen: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  log('SERIAL opened ' + PORT);
  let buf = '';
  port.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) log('UART| ' + line.slice(0, 400));
    }
    if (buf.length > 1024) buf = buf.slice(-1024);
  });
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  log('END log=' + OUT);
  await new Promise((r) => port.close(() => r()));
  client.end(true, () => process.exit(0));
}
main().catch((e) => { log('FATAL ' + e.message); try { fs.writeFileSync(OUT, lines.join('\n') + '\n'); } catch (_) {} process.exit(1); });
