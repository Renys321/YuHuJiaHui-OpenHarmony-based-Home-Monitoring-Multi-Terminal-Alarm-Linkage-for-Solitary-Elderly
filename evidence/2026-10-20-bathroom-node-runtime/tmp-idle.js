'use strict';
const mqtt = require('D:/OpenHarmony/competition/cloud/onenet/node_modules/mqtt');
const seen = [];
const c = mqtt.connect('mqtt://127.0.0.1:1883');
c.on('connect', () => c.subscribe('home/esp32-bath/status', { qos: 0 }));
c.on('message', (t, b) => { try { const o = JSON.parse(b.toString('utf8')); seen.push({ utc: new Date().toISOString(), state: o.state, alarm: o.alarm && o.alarm.type, ts: o.ts, temp: o.sensors.climate.tempC, motion: o.sensors.motion.countToday }); } catch (e) {} });
setTimeout(() => {
  console.log('msgs=' + seen.length);
  const last = seen[seen.length - 1];
  console.log('last=' + JSON.stringify(last));
  console.log('states=' + JSON.stringify(seen.reduce((m, s) => { m[s.state] = (m[s.state] || 0) + 1; return m; }, {})));
  console.log('alarms=' + JSON.stringify(seen.reduce((m, s) => { if (s.alarm) m[s.alarm] = (m[s.alarm] || 0) + 1; return m; }, {})));
  try { c.end(true); } catch (e) {} process.exit(0);
}, 20000);
