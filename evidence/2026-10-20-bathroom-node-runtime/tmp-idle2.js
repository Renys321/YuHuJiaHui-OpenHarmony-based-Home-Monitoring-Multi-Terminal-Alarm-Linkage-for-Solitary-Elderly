'use strict';
const mqtt = require('D:/OpenHarmony/competition/cloud/onenet/node_modules/mqtt');
const seen = [];
const c = mqtt.connect('mqtt://127.0.0.1:1883');
c.on('connect', () => c.subscribe('home/esp32-bath/status', { qos: 0 }));
c.on('message', (t, b) => { try { const o = JSON.parse(b.toString('utf8')); seen.push({ utc: new Date().toISOString(), state: o.state, alarm: o.alarm && o.alarm.type, temp: o.sensors.climate.tempC }); } catch (e) {} });
setTimeout(() => {
  console.log('msgs=' + seen.length);
  console.log('last=' + JSON.stringify(seen[seen.length - 1] || null));
  console.log('states=' + JSON.stringify(seen.reduce((m, s) => { m[s.state] = (m[s.state] || 0) + 1; return m; }, {})));
  try { c.end(true); } catch (e) {} process.exit(0);
}, 22000);
