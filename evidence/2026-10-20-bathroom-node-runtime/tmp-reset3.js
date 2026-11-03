'use strict';
const mqtt = require('D:/OpenHarmony/competition/cloud/onenet/node_modules/mqtt');
const c = mqtt.connect('mqtt://127.0.0.1:1883');
let last = null, n = 0;
c.on('connect', () => {
  c.subscribe('home/esp32-bath/status', { qos: 0 });
  setTimeout(() => c.publish('home/esp32-bath/cmd', JSON.stringify({ cmd: 'reset' }), { qos: 0 }), 600);
  setTimeout(() => c.publish('home/esp32-bath/cmd', JSON.stringify({ cmd: 'reset' }), { qos: 0 }), 3000);
});
c.on('message', (t, b) => { n++; try { last = JSON.parse(b.toString('utf8')); } catch (e) {} });
setTimeout(() => {
  console.log('msgs=' + n + ' state=' + (last ? last.state : '?') + ' alarm=' + JSON.stringify(last ? last.alarm : null));
  try { c.end(true); } catch (e) {} process.exit(0);
}, 12000);
