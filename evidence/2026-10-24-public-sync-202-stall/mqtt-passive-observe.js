'use strict';
const mqtt = require('D:/OpenHarmony/competition/cloud/onenet/node_modules/mqtt');
const started = Date.now();
const clientId = `diag-observe-${Date.now()}`;
const topics = ['home/esp32-kitchen/status', 'home/esp32-bath/status', 'home/dayu200-living/status'];
const client = mqtt.connect('mqtt://127.0.0.1:1883', {
  clientId,
  clean: true,
  reconnectPeriod: 0,
  connectTimeout: 5000
});
let count = 0;
function whitelist(topic, packet, text) {
  let obj = null;
  try { obj = JSON.parse(text); } catch (_) { return { topic, retained: !!packet.retain, parse: 'error' }; }
  const sensors = obj && obj.sensors ? obj.sensors : {};
  const out = {
    recvAt: new Date().toISOString(),
    topic,
    retained: !!packet.retain,
    deviceId: obj && obj.deviceId,
    deviceTs: obj && obj.ts,
    state: obj && obj.state,
    sensorKeys: Object.keys(sensors)
  };
  if (sensors.gas) out.gas = { raw: sensors.gas.raw, valid: sensors.gas.valid };
  if (sensors.smoke) out.smoke = { raw: sensors.smoke.raw, valid: sensors.smoke.valid };
  if (sensors.motion) out.motion = { lastActiveTs: sensors.motion.lastActiveTs, countToday: sensors.motion.countToday };
  return out;
}
client.on('connect', () => {
  console.log(`[observe] connected clientId=${clientId} at=${new Date().toISOString()}`);
  client.subscribe(topics, { qos: 0 }, (err) => {
    if (err) { console.error('[observe] subscribe_error'); process.exit(1); }
    console.log('[observe] subscribed status topics only; no publish');
  });
});
client.on('message', (topic, payload, packet) => {
  count++;
  const row = whitelist(topic, packet, payload.toString('utf8'));
  console.log('[observe] ' + JSON.stringify(row));
});
client.on('error', (err) => {
  console.log('[observe] error=' + (err && err.message ? err.message : 'unknown'));
});
setTimeout(() => {
  console.log(`[observe] done count=${count} elapsedMs=${Date.now() - started}`);
  client.end(true, () => process.exit(0));
}, 70000);
