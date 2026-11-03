'use strict';
const mqtt = require('D:/OpenHarmony/competition/cloud/onenet/node_modules/mqtt');
const seen = [];
const c = mqtt.connect('mqtt://127.0.0.1:1883');
c.on('connect', () => c.subscribe('home/+/status', { qos: 0 }));
c.on('message', (t, b) => {
  try { const o = JSON.parse(b.toString('utf8')); seen.push({ utc: new Date().toISOString(), topic: t, o: o }); } catch (e) {}
});
setTimeout(() => {
  const bath = seen.filter(x => x.topic.indexOf('esp32-bath') >= 0);
  const other = seen.filter(x => x.topic.indexOf('esp32-bath') < 0).map(x => x.topic);
  console.log('bath_msgs=' + bath.length + ' other_topics=' + JSON.stringify([...new Set(other)]));
  if (bath.length) {
    const r = bath[bath.length - 1]; const o = r.o;
    console.log('utc=' + r.utc + ' deviceId=' + o.deviceId + ' room=' + o.room + ' ts=' + o.ts + ' state=' + o.state);
    console.log('climate=' + JSON.stringify(o.sensors.climate) + ' motion=' + JSON.stringify(o.sensors.motion));
    console.log('water_present=' + (o.sensors.water !== undefined) + ' gas=' + JSON.stringify(o.sensors.gas) + ' smoke=' + JSON.stringify(o.sensors.smoke));
    console.log('alarm=' + JSON.stringify(o.alarm));
    console.log('states=' + JSON.stringify(bath.reduce((m, x) => { m[x.o.state] = (m[x.o.state] || 0) + 1; return m; }, {})));
    console.log('alarm_types=' + JSON.stringify(bath.reduce((m, x) => { const t = x.o.alarm && x.o.alarm.type; if (t) m[t] = (m[t] || 0) + 1; return m; }, {})));
  }
  try { c.end(true); } catch (e) {} process.exit(0);
}, 35000);
