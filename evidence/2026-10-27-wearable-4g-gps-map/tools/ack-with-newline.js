#!/usr/bin/env node
'use strict';
/* 发送带换行的 ACK（M100 下行不追加换行，必须由服务端补 \n） */
const { SerialPort } = require('D:/OpenHarmony/competition/hardware/yed-m100mg-b1/node_modules/serialport');
const mqtt = require('D:/OpenHarmony/competition/cloud/onenet/node_modules/mqtt');

const ALARM = process.argv[2] || 'sos-1-95ce218c';
const COM = process.argv[3] || 'COM8';

(async () => {
  const c = mqtt.connect('mqtt://broker.emqx.io:1883', { clientId: 'pc-acknl-' + Math.random().toString(16).slice(2, 10), clean: true, connectTimeout: 8000 });
  await new Promise((res, rej) => { c.on('connect', res); c.on('error', rej); });
  c.subscribe('eldercare/wearable/sos-001/up', { qos: 0 });
  c.on('message', (t, p) => console.log('MQTT<< ' + p.toString().trim().slice(0, 240)));

  const port = new SerialPort({ path: COM, baudRate: 115200, autoOpen: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  console.log('SERIAL ok ' + COM);
  let buf = '';
  port.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) console.log('UART| ' + line.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 260));
    }
  });

  const frame = JSON.stringify({ v: 1, t: 'ack', alarm: ALARM, cmd: 'test1' }) + '\n';
  for (let k = 0; k < 2; k++) {
    c.publish('eldercare/wearable/sos-001/down', frame, { qos: 0 }, (e) => console.log('ACK(payload+NL) publish ' + (e ? 'ERR ' + e.message : 'ok')));
    await new Promise((r) => setTimeout(r, 5000));
  }
  await new Promise((r) => setTimeout(r, 10000));
  console.log('DONE');
  port.close(() => {});
  c.end(true, () => process.exit(0));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
