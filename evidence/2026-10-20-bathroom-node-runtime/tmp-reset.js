'use strict';
const mqtt = require('D:/OpenHarmony/competition/cloud/onenet/node_modules/mqtt');
const c = mqtt.connect('mqtt://127.0.0.1:1883');
const seen = [];
c.on('connect', () => {
  c.subscribe('home/esp32-bath/status', { qos: 0 }, () => {
    setTimeout(() => {
      c.publish('home/esp32-bath/cmd', JSON.stringify({ cmd: 'reset' }), { qos: 0 });
      console.log('RESET_SENT ' + new Date().toISOString());
    }, 1500);
  });
});
c.on('message', (t, b) => {
  try {
    const o = JSON.parse(b.toString('utf8'));
    seen.push({ utc: new Date().toISOString(), state: o.state, alarm: o.alarm && o.alarm.type, id: o.alarm && o.alarm.id, ts: o.ts });
  } catch (e) {}
});
setTimeout(() => {
  console.log('samples=' + seen.length);
  const last = seen[seen.length - 1];
  console.log('last=' + JSON.stringify(last));
  console.log('states=' + JSON.stringify(seen.reduce((m, s) => { m[s.state] = (m[s.state] || 0) + 1; return m; }, {})));
  console.log('alarms=' + JSON.stringify(seen.reduce((m, s) => { if (s.alarm) m[s.alarm] = (m[s.alarm] || 0) + 1; return m; }, {})));
  try { c.end(true); } catch (e) {} process.exit(0);
}, 45000);
