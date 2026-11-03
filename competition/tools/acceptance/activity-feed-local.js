#!/usr/bin/env node
/**
 * activity-feed-local.js — 活动报告本地真实验收数据源（只读订阅真实 MQTT，转发到本机候选后端）。
 *
 * 边界（务必遵守）：
 *   - 只订阅本机 Broker (默认 127.0.0.1:1883) 上的 home/<deviceId>/status，绝不发布/不写指令。
 *   - 只向本机候选后端 (默认 http://127.0.0.1:18080) 的 /internal/v1/device-status 转发，
 *     不访问公网后端、不改 P0/Bridge/Broker、不触发告警/ACK/reset。
 *   - ingest key 从 --ingest-key-file 读取一次性本地测试密钥；绝不打印、绝不写入输出。
 *   - 复用生产同一份 `buildIngestPayload`（cloud/onenet/cloud-sync.js）做载荷转换，
 *     保证与 public-sync 上传的字段语义一致（sensors.motion.countToday 等）。
 *
 * 用途：
 *   1) 给本机候选后端灌入真实设备状态，验证活动聚合与持久化；
 *   2) 独立按同一规则（countToday 正增量；计数回退视为 reset）统计“期望活动次数”，
 *      与后端 /api/v1/activity/report 返回的 selected.count 做一致性核对。
 *
 * 用法：
 *   node activity-feed-local.js --ingest-key-file <本机临时文件> \
 *     [--broker 127.0.0.1:1883] [--backend http://127.0.0.1:18080] \
 *     [--seconds 90] [--out expected.json] [--topic home/+/status]
 *
 * 输出 JSON（无密钥、无 token）：
 *   {startedAt,endedAt,broker,backend,messages,forwarded,errors,devices:{deviceId:{...}}}
 *   devices[id] = {samples, firstTs, lastTs, baselineCount, lastCount, totalDelta, resets, invalid}
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');

function parseArgs(argv) {
  const args = { _: argv[2] };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

function encLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
function encStr(s) {
  const b = Buffer.from(String(s), 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length, 0);
  return Buffer.concat([l, b]);
}
function packet(type, flags, payload) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encLen(payload.length), payload]);
}

function postJson(urlString, body, extraHeaders) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlString); } catch { resolve({ ok: false, error: 'BAD_URL' }); return; }
    const http = url.protocol === 'https:' ? require('node:https') : require('node:http');
    const payload = Buffer.from(body, 'utf8');
    const headers = Object.assign({
      'content-type': 'application/json',
      'content-length': String(payload.length)
    }, extraHeaders || {});
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      timeout: 5000
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
    req.on('error', () => resolve({ ok: false, error: 'NETWORK' }));
    req.end(payload);
  });
}

/** 与后端一致的增量口径：只计正增量；回退视为 reset 并只计观测到的新值。 */
class DeviceDeltaCounter {
  constructor() {
    this.devices = new Map();
  }
  observe(raw) {
    const id = raw && typeof raw.deviceId === 'string' ? raw.deviceId : '';
    if (!id) return;
    const motion = raw.sensors && raw.sensors.motion ? raw.sensors.motion : null;
    const count = motion && typeof motion.countToday === 'number' && Number.isFinite(motion.countToday) &&
      Number.isSafeInteger(motion.countToday) && motion.countToday >= 0 ? motion.countToday : null;
    let entry = this.devices.get(id);
    if (!entry) {
      entry = {
        samples: 0, firstTs: 0, lastTs: 0, baselineCount: null, lastCount: null,
        totalDelta: 0, resets: 0, invalid: 0
      };
      this.devices.set(id, entry);
    }
    entry.samples++;
    const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : 0;
    if (entry.firstTs === 0) entry.firstTs = ts;
    entry.lastTs = ts;
    if (count === null) { entry.invalid++; return; }
    if (entry.baselineCount === null) {
      // 首次观测：只建立基线，不猜测历史。
      entry.baselineCount = count;
      entry.lastCount = count;
      return;
    }
    if (count >= entry.lastCount) {
      entry.totalDelta += count - entry.lastCount;
    } else {
      // 计数回退（设备重启 / 跨日归零）：只计观测到的新值。
      entry.totalDelta += count;
      entry.resets++;
    }
    entry.lastCount = count;
  }
  snapshot() {
    const out = {};
    for (const [id, entry] of this.devices.entries()) {
      out[id] = {
        samples: entry.samples,
        firstTs: entry.firstTs,
        lastTs: entry.lastTs,
        baselineCount: entry.baselineCount,
        lastCount: entry.lastCount,
        totalDelta: entry.totalDelta,
        resets: entry.resets,
        invalid: entry.invalid
      };
    }
    return out;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const broker = (args.broker || '127.0.0.1:1883').split(':');
  const host = broker[0];
  const port = Number.parseInt(broker[1] || '1883', 10);
  const backend = args.backend || 'http://127.0.0.1:18080';
  const seconds = Number.parseInt(args.seconds || '90', 10);
  const topic = args.topic || 'home/+/status';
  const keyFile = args['ingest-key-file'];
  const outPath = args.out;
  if (!keyFile) {
    console.error('[feed] FATAL code=INGEST_KEY_FILE_REQUIRED');
    process.exit(2);
  }
  let ingestKey;
  try {
    ingestKey = fs.readFileSync(keyFile, 'utf8').trim();
  } catch {
    console.error('[feed] FATAL code=INGEST_KEY_FILE_UNREADABLE');
    process.exit(2);
  }
  if (ingestKey.length < 32) {
    console.error('[feed] FATAL code=INGEST_KEY_TOO_SHORT');
    process.exit(2);
  }

  let buildIngestPayload;
  try {
    ({ buildIngestPayload } = require('../../cloud/onenet/cloud-sync.js'));
  } catch {
    console.error('[feed] FATAL code=CLOUD_SYNC_UNAVAILABLE');
    process.exit(2);
  }

  const startedAt = Date.now();
  const counters = new DeviceDeltaCounter();
  const stats = {
    startedAt,
    endedAt: 0,
    broker: `${host}:${port}`,
    backend,
    messages: 0,
    forwarded: 0,
    rejected: 0,
    errors: 0,
    byDevice: {}
  };

  const socket = net.createConnection({ host, port }, () => {
    const connectPayload = Buffer.concat([
      encStr('MQTT'), Buffer.from([4, 0x02, 0, 30]),
      encStr(`activity-feed-${process.pid}`)
    ]);
    socket.write(packet(1, 0, connectPayload));
  });
  socket.setNoDelay(true);

  let buffer = Buffer.alloc(0);
  let pid = 1;
  let subscribed = false;
  let stopping = false;

  function finish() {
    if (stopping) return;
    stopping = true;
    stats.endedAt = Date.now();
    stats.byDevice = counters.snapshot();
    const text = JSON.stringify(stats, null, 2);
    if (outPath) {
      try { fs.writeFileSync(outPath, text + '\n'); } catch { /* 输出文件失败不伪装成功 */ }
    }
    console.log(JSON.stringify({
      ok: true,
      messages: stats.messages,
      forwarded: stats.forwarded,
      errors: stats.errors,
      devices: Object.keys(stats.byDevice).length
    }));
    try { socket.end(); } catch { /* ignore */ }
    process.exit(0);
  }

  const timeout = setTimeout(finish, Math.max(1000, seconds) * 1000);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      let multiplier = 1;
      let length = 0;
      let index = 1;
      for (;;) {
        if (index >= buffer.length) return;
        const byte = buffer[index];
        length += (byte & 127) * multiplier;
        multiplier *= 128;
        index++;
        if ((byte & 128) === 0) break;
      }
      const total = index + length;
      if (buffer.length < total) return;
      const type = buffer[0] >> 4;
      const body = buffer.slice(index, total);
      buffer = buffer.slice(total);

      if (type === 2) {
        if (body[1] !== 0) {
          console.error('[feed] FATAL code=MQTT_CONNACK_REJECTED');
          process.exit(3);
        }
        if (!subscribed) {
          subscribed = true;
          const subPayload = Buffer.concat([Buffer.from([0, pid]), encStr(topic), Buffer.from([0])]);
          pid++;
          socket.write(packet(8, 2, subPayload));
        }
        continue;
      }
      if (type !== 3) continue; // 只处理 PUBLISH
      const topicLength = body.readUInt16BE(0);
      const publishTopic = body.slice(2, 2 + topicLength).toString('utf8');
      const payloadText = body.slice(2 + topicLength).toString('utf8');
      if (!/^home\/[^/]+\/status$/.test(publishTopic)) continue;
      let raw;
      try { raw = JSON.parse(payloadText); } catch { stats.errors++; continue; }
      if (!raw || typeof raw.deviceId !== 'string') { stats.errors++; continue; }
      stats.messages++;
      counters.observe(raw);
      let payload;
      try {
        payload = buildIngestPayload(raw, Date.now());
      } catch {
        stats.rejected++;
        continue;
      }
      postJson(`${backend.replace(/\/$/, '')}/internal/v1/device-status`, JSON.stringify(payload), {
        'x-ingest-key': ingestKey
      }).then((result) => {
        if (result.ok) stats.forwarded++;
        else stats.errors++;
      });
    }
  });

  socket.on('error', (error) => {
    console.error(`[feed] FATAL code=${error && error.code ? error.code : 'SOCKET_ERROR'}`);
    clearTimeout(timeout);
    process.exit(3);
  });
  socket.on('close', () => {
    if (!stopping) {
      clearTimeout(timeout);
      finish();
    }
  });
}

if (require.main === module) main();

module.exports = { DeviceDeltaCounter, parseArgs };
