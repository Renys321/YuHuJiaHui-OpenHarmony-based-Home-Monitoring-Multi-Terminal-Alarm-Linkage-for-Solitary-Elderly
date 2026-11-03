// 只读 MQTT 采集：订阅 home/+/status，记录到达时间、主题、deviceId、ts、state、countToday。
// 不发布任何消息，不修改任何状态。
const fs = require('fs');
const mqtt = require('D:/OpenHarmony/competition/cloud/onenet/node_modules/mqtt');

const durationMs = Number(process.argv[2] || 30000);
const outFile = process.argv[3] || null;
const lines = [];

function log(s) {
  const line = s;
  console.log(line);
  lines.push(line);
}

const t0 = Date.now();
const c = mqtt.connect('mqtt://127.0.0.1:1883', {
  clientId: 'esp32-net-readonly-' + Date.now(),
  clean: true,
});

c.on('connect', () => {
  log(`[connect] ${new Date().toISOString()} broker=127.0.0.1:1883`);
  c.subscribe('home/+/status', { qos: 0 }, (err) => {
    log(`[subscribe] home/+/status err=${err ? err.message : 'none'}`);
  });
});

const seen = {};
c.on('message', (topic, payload) => {
  let j = {};
  try { j = JSON.parse(payload.toString('utf8')); } catch (e) { /* 非 JSON */ }
  const now = Date.now();
  const rec = {
    recvAt: new Date(now).toISOString(),
    sinceStartMs: now - t0,
    topic,
    deviceId: j.deviceId,
    room: j.room,
    ts: j.ts,
    tsAgeMs: typeof j.ts === 'number' ? now - j.ts : null,
    state: j.state,
    countToday: j.sensors && j.sensors.motion ? j.sensors.motion.countToday : undefined,
    payloadBytes: payload.length,
  };
  seen[topic] = (seen[topic] || 0) + 1;
  // 前 3 条/主题 + 之后的摘要
  if (seen[topic] <= 3) {
    log('[msg] ' + JSON.stringify(rec));
  }
});

c.on('error', (e) => log('[error] ' + e.message));

setTimeout(() => {
  log('[summary] ' + JSON.stringify(seen));
  if (outFile) {
    fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  }
  c.end(true, () => process.exit(0));
}, durationMs);
