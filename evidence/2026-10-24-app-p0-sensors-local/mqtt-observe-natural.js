'use strict';
/*
 * Read-only MQTT observer for natural P0 evidence.
 * Subscribes to home/+/status on the local broker; never publishes.
 * Prints deviceId, state, key sensor fields, retained flag and packet time.
 */
const mqtt = require('D:\\OpenHarmony\\competition\\cloud\\onenet\\node_modules\\mqtt');
const durationMs = Number(process.env.OBSERVE_MS || 90000);
const client = mqtt.connect('mqtt://127.0.0.1:1883', {
  clientId: `p0-observe-${process.pid}`,
  reconnectPeriod: 0
});

client.on('connect', () => {
  client.subscribe('home/+/status', { qos: 0 }, (error) => {
    if (error) {
      console.error(`subscribe_error=${error.message}`);
      process.exit(1);
    }
    console.log(`subscribed home/+/status at ${new Date().toISOString()} durationMs=${durationMs}`);
  });
});

client.on('message', (topic, payload, packet) => {
  try {
    const j = JSON.parse(payload.toString('utf8'));
    const s = j.sensors || {};
    const motion = s.motion ? `motion(last=${s.motion.lastActiveTs},count=${s.motion.countToday})` : 'motion(none)';
    const gas = s.gas ? `gas(raw=${s.gas.raw},valid=${s.gas.valid})` : 'gas(none)';
    const smoke = s.smoke ? `smoke(raw=${s.smoke.raw},valid=${s.smoke.valid})` : 'smoke(none)';
    console.log(`${new Date().toISOString()} topic=${topic} deviceId=${j.deviceId} state=${j.state} retain=${packet && packet.retain ? 1 : 0} ${motion} ${gas} ${smoke}`);
  } catch (error) {
    console.log(`${new Date().toISOString()} topic=${topic} parse_error=${error.message}`);
  }
});

client.on('error', (error) => {
  console.error(`mqtt_error=${error.message}`);
});

setTimeout(() => {
  client.end(true, () => process.exit(0));
}, durationMs);
