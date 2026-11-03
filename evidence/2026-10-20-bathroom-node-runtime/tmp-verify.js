'use strict';
const mqtt = require('D:/OpenHarmony/competition/cloud/onenet/node_modules/mqtt');
const got = { bath: [], kitchen: [] };
const c = mqtt.connect('mqtt://127.0.0.1:1883');
c.on('connect', () => c.subscribe('home/+/status', { qos: 0 }));
c.on('message', (t, b) => {
  try {
    const o = JSON.parse(b.toString('utf8'));
    const rec = { utc: new Date().toISOString(), topic: t, o: o };
    if (t.indexOf('esp32-bath') >= 0) got.bath.push(rec);
    else if (t.indexOf('esp32-kitchen') >= 0) got.kitchen.push(rec);
  } catch (e) {}
});
setTimeout(() => {
  console.log('bath_msgs=' + got.bath.length + ' kitchen_msgs=' + got.kitchen.length);
  if (got.bath.length) {
    const r = got.bath[got.bath.length - 1];
    const o = r.o;
    console.log('bath_utc=' + r.utc + ' topic=' + r.topic);
    console.log('deviceId=' + o.deviceId + ' room=' + o.room + ' ts=' + o.ts + ' state=' + o.state);
    console.log('climate=' + JSON.stringify(o.sensors.climate));
    console.log('motion=' + JSON.stringify(o.sensors.motion) + ' door=' + JSON.stringify(o.sensors.door));
    console.log('has_water=' + (o.sensors.water !== undefined) + ' gas=' + JSON.stringify(o.sensors.gas) + ' smoke=' + JSON.stringify(o.sensors.smoke));
    console.log('alarm=' + JSON.stringify(o.alarm));
  }
  try { c.end(true); } catch (e) {} process.exit(0);
}, 40000);
