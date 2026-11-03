'use strict';

/**
 * adapter.test.js — 适配器上行链路集成测试：
 * 假 HTTP 后端 + 真实 MQTT broker + 真实 MQTT 报文（裸 TCP 客户端）。
 *
 * 契约要点（Lead 2026-10-27 决策）：
 *   - 公网后端没有 wearable location 路由，位置只随 device-status 的 gps 字段上报；
 *   - SOS 时把“当时最新位置”快照为 eventGps，事件未 ACK 前不被后续 GPS 覆盖；
 *   - 设备真实 ack 后恢复发最新位置；
 *   - 无 fix 时 gps.valid=false 且不得用 (0,0)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createHarness, waitFor, sleep } = require('./helpers/harness');
const { RawMqttClient } = require('./helpers/raw-mqtt-client');

async function connectDevice(harness, clientId = 'test-device') {
  const client = new RawMqttClient();
  await client.connect({
    port: harness.brokerPort,
    clientId,
    username: harness.env.MQTT_USER,
    password: harness.env.MQTT_PASS,
    keepAlive: 60
  });
  return client;
}

async function withHarness(fn, options) {
  const harness = await createHarness(options);
  try {
    await fn(harness);
  } finally {
    await harness.stop();
  }
}

function validGps(gps) {
  assert.equal(gps.valid, true);
  assert.equal(typeof gps.latitude, 'number');
  assert.equal(typeof gps.longitude, 'number');
  assert.equal(Number.isSafeInteger(gps.fixTime), true);
  assert.ok(!(gps.latitude === 0 && gps.longitude === 0), '禁止 0,0 假坐标');
}

function invalidGps(gps) {
  assert.equal(gps.valid, false);
  assert.equal(gps.latitude, null);
  assert.equal(gps.longitude, null);
  assert.equal(gps.fixTime, 0);
}

test('SOS 上行 -> device-status（ALARM/MANUAL_SOS），位置取 M100 最新定位快照', async () => {
  await withHarness(async (harness) => {
    const device = await connectDevice(harness);
    try {
      // 1) 先来一帧 M100 GPS 固定格式：只更新“最新位置”，不调用任何 HTTP
      await device.publish(harness.upTopic, '113.9737_22.69271', { qos: 1 });
      await waitFor(async () => {
        const status = await harness.status();
        return status.json.adapter.latestGps !== null;
      });
      assert.equal(harness.fake.count('location'), 0, '公网后端无 location 路由，适配器不得调用');
      const latest = (await harness.status()).json.adapter.latestGps;
      assert.equal(latest.longitude, 113.9737);
      assert.equal(latest.latitude, 22.69271);
      assert.equal(latest.seq, 1);

      // 2) SOS（gps=null）：应把最新位置快照进 device-status.gps
      await device.publish(harness.upTopic, JSON.stringify({
        v: 1,
        t: 'sos',
        dev: 'esp32-sos',
        alarm: 'sos-1-ab12cd',
        uptimeMs: 12345,
        seq: 1,
        gps: null
      }), { qos: 1 });

      await waitFor(() => harness.fake.count('device-status') === 1);
      const record = harness.fake.records('device-status')[0];
      assert.equal(record.headers['x-ingest-key'], harness.env.INGEST_KEY);
      assert.equal(record.body.deviceId, 'esp32-sos');
      assert.equal(record.body.room, '随身求助');
      assert.equal(record.body.state, 'ALARM');
      assert.equal(record.body.online, true);
      assert.equal(record.body.monitorOnline, -1);
      assert.equal(Number.isSafeInteger(record.body.ts), true);
      assert.equal(record.body.alarm.id, 'sos-1-ab12cd');
      assert.equal(record.body.alarm.type, 'MANUAL_SOS');
      assert.equal(record.body.alarm.countToday, 1);
      validGps(record.body.gps);
      assert.equal(record.body.gps.latitude, 22.69271);
      assert.equal(record.body.gps.longitude, 113.9737);
      assert.equal(record.body.gps.fixTime, latest.fixTime, '求助时刻位置 fixTime 应等于最新定位接收时间');
      assert.ok(record.body.gps.fixTime <= record.body.ts);

      const status = await harness.status();
      assert.equal(status.json.adapter.device.state, 'ALARM');
      assert.equal(status.json.adapter.device.alarmId, 'sos-1-ab12cd');
      assert.equal(status.json.adapter.activeAlarm.alarmId, 'sos-1-ab12cd');
      assert.equal(status.json.adapter.counters.sosGpsFromLatest, 1);
    } finally {
      await device.disconnect();
    }
  });
});

test('SOS 无任何定位时 gps.valid=false（绝不用 0,0 冒充）', async () => {
  await withHarness(async (harness) => {
    const device = await connectDevice(harness);
    try {
      await device.publish(harness.upTopic, JSON.stringify({
        v: 1, t: 'sos', alarm: 'sos-2-nofix', uptimeMs: 1, seq: 1, gps: null
      }), { qos: 0 });
      await waitFor(() => harness.fake.count('device-status') === 1);
      invalidGps(harness.fake.records('device-status')[0].body.gps);
      const status = await harness.status();
      assert.equal(status.json.adapter.counters.sosGpsUnavailable, 1);
    } finally {
      await device.disconnect();
    }
  });
});

test('事件未 ACK 前：后续 GPS 不覆盖求助时刻位置；设备 ACK 后恢复最新位置', async () => {
  const harness = await createHarness();
  const device = await connectDevice(harness);
  try {
    // 求助前位置 A
    await device.publish(harness.upTopic, '113.90_22.60');
    await waitFor(async () => (await harness.status()).json.adapter.latestGps !== null);
    // 求助事件
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'sos', alarm: 'sos-3-lock', uptimeMs: 1, seq: 1, gps: null
    }));
    await waitFor(() => harness.fake.count('device-status') === 1);
    const eventGps = harness.fake.records('device-status')[0].body.gps;
    assert.equal(eventGps.longitude, 113.9);
    const eventFixTime = eventGps.fixTime;

    // 求助后位置 B（更新）：最新位置变 B，但未 ACK 事件的 gps 仍是 A
    await device.publish(harness.upTopic, '114.10_22.80');
    await waitFor(async () => {
      const status = await harness.status();
      return status.json.adapter.latestGps && status.json.adapter.latestGps.longitude === 114.1;
    });
    // 未 ACK 心跳（ALARM）：gps 仍为求助时刻 A
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'hb', dev: 'esp32-sos', state: 'ALARM', alarm: 'sos-3-lock', uptimeMs: 2, csq: 26
    }));
    await waitFor(() => harness.fake.count('device-status') === 2);
    const hbAlarm = harness.fake.records('device-status')[1].body;
    assert.equal(hbAlarm.state, 'ALARM');
    assert.equal(hbAlarm.gps.longitude, 113.9, '未 ACK 事件期间 gps 必须是求助时刻位置');
    assert.equal(hbAlarm.gps.fixTime, eventFixTime);
    const lockedStatus = await harness.status();
    assert.ok(lockedStatus.json.adapter.counters.gpsEventLocked >= 1);

    // 设备真实 ACK（通过真实 ACK 命令链路）
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    harness.fake.addCommand({
      id: '1',
      createdAt: Date.now(),
      requestedBy: 'household-guardian',
      deviceId: 'esp32-sos',
      command: 'ACK',
      alarmId: 'sos-3-lock',
      action: '监护人已确认',
      status: 'PENDING'
    });
    await device.waitForMessage(() => true);
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'ack', dev: 'esp32-sos', alarm: 'sos-3-lock', cmd: '1'
    }), { qos: 1 });

    // result 回写 + 一次 device-status ACKED（带最新位置 B）
    await waitFor(() => harness.fake.count('result') === 1);
    await waitFor(() => harness.fake.count('device-status') === 3);
    const acked = harness.fake.records('device-status')[2].body;
    assert.equal(acked.state, 'ACKED');
    assert.equal(acked.alarm.id, 'sos-3-lock');
    assert.equal(acked.gps.longitude, 114.1, 'ACK 后恢复最新位置');
    assert.equal(harness.fake.records('result')[0].body.status, 'ACKED');

    // 之后心跳恢复发最新位置
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'hb', dev: 'esp32-sos', state: 'IDLE', alarm: '', uptimeMs: 3
    }));
    await waitFor(() => harness.fake.count('device-status') === 4);
    const normal = harness.fake.records('device-status')[3].body;
    assert.equal(normal.state, 'NORMAL');
    assert.equal(normal.gps.longitude, 114.1);
    const status = await harness.status();
    assert.equal(status.json.adapter.activeAlarm, null);
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});

test('同一 alarmId 重复 SOS 不重复建告警（本地短时去重），新 alarmId 正常建告警', async () => {
  await withHarness(async (harness) => {
    const device = await connectDevice(harness);
    try {
      const packet = JSON.stringify({
        v: 1, t: 'sos', alarm: 'sos-4-ff00aa', uptimeMs: 1000, seq: 1, gps: null
      });
      await device.publish(harness.upTopic, packet, { qos: 0 });
      await waitFor(() => harness.fake.count('device-status') === 1);
      await device.publish(harness.upTopic, packet.replace('"uptimeMs":1000', '"uptimeMs":2000'), { qos: 0 });
      await sleep(150);
      await device.publish(harness.upTopic, packet, { qos: 1 });
      await sleep(400);
      assert.equal(harness.fake.count('device-status'), 1, '同一 alarmId 只能 POST 一次');
      const status = await harness.status();
      assert.ok(status.json.adapter.counters.sosDuplicates >= 1);

      await device.publish(harness.upTopic, JSON.stringify({
        v: 1, t: 'sos', alarm: 'sos-5-998877', uptimeMs: 3000, seq: 2, gps: null
      }), { qos: 0 });
      await waitFor(() => harness.fake.count('device-status') === 2);
      assert.equal(harness.fake.records('device-status')[1].body.alarm.id, 'sos-5-998877');
      assert.equal(harness.fake.records('device-status')[1].body.alarm.countToday, 2);
    } finally {
      await device.disconnect();
    }
  });
});

test('hb / boot 上行更新设备在线状态（NORMAL + lastSeen），带最新位置', async () => {
  await withHarness(async (harness) => {
    const device = await connectDevice(harness);
    try {
      await device.publish(harness.upTopic, '113.9737_22.69271');
      await waitFor(async () => (await harness.status()).json.adapter.latestGps !== null);
      await device.publish(harness.upTopic, JSON.stringify({
        v: 1, t: 'hb', dev: 'esp32-sos', state: 'IDLE', alarm: '', uptimeMs: 23456, csq: 26
      }), { qos: 0 });
      await waitFor(() => harness.fake.count('device-status') === 1);
      const hb = harness.fake.records('device-status')[0].body;
      assert.equal(hb.state, 'NORMAL');
      assert.equal(hb.online, true);
      assert.equal(hb.csq, 26);
      validGps(hb.gps);
      assert.equal(hb.gps.longitude, 113.9737);

      await device.publish(harness.upTopic, JSON.stringify({
        v: 1, t: 'boot', dev: 'esp32-sos', uptimeMs: 0, fw: 'wearable-1.0.0'
      }), { qos: 1 });
      await waitFor(() => harness.fake.count('device-status') === 2);
      assert.equal(harness.fake.records('device-status')[1].body.state, 'NORMAL');

      const status = await harness.status();
      assert.equal(status.json.adapter.device.state, 'NORMAL');
      assert.equal(status.json.adapter.device.online, true);
      assert.ok(status.json.adapter.device.lastSeen > 0);
      assert.ok(status.json.adapter.counters.hbReceived >= 1);
      assert.ok(status.json.adapter.counters.bootReceived >= 1);
    } finally {
      await device.disconnect();
    }
  });
});

test('GPS 固定格式：十进制/度分双兼容，解析失败只记诊断不改最新位置', async () => {
  await withHarness(async (harness) => {
    const device = await connectDevice(harness);
    try {
      await device.publish(harness.upTopic, '113.9737_22.69271\r\n', { qos: 1 });
      await waitFor(async () => {
        const status = await harness.status();
        return status.json.adapter.latestGps !== null;
      });
      let status = await harness.status();
      assert.equal(status.json.adapter.latestGps.longitude, 113.9737);
      assert.equal(status.json.adapter.latestGps.latitude, 22.69271);
      assert.equal(status.json.adapter.latestGps.format, 'dd');
      assert.equal(status.json.adapter.latestGps.seq, 1);
      assert.equal(harness.fake.count('location'), 0);

      // 度分格式：11358.4220 = 113°58.422' = 113.9737°
      await device.publish(harness.upTopic, '11358.4220_2231.5626', { qos: 0 });
      await waitFor(async () => {
        const s = await harness.status();
        return s.json.adapter.latestGps && s.json.adapter.latestGps.seq === 2;
      });
      status = await harness.status();
      assert.equal(status.json.adapter.latestGps.format, 'ddmm');
      assert.ok(Math.abs(status.json.adapter.latestGps.longitude - 113.9737) < 1e-4);

      // 坏报文：不改变最新位置、只增加诊断计数
      const before = status.json.adapter.latestGps;
      await device.publish(harness.upTopic, 'config,gps,ok,1,E,113.');
      await device.publish(harness.upTopic, '200.0_95.0');
      await device.publish(harness.upTopic, '{"t":"sos", broken');
      await sleep(250);
      status = await harness.status();
      assert.deepEqual(status.json.adapter.latestGps, before, '坏报文不得写入假坐标');
      assert.ok(status.json.adapter.counters.gpsParseFailures >= 2);
      assert.ok(status.json.adapter.counters.malformedJson >= 1);
      assert.equal(harness.fake.count('device-status'), 0);
    } finally {
      await device.disconnect();
    }
  });
});

test('GPS 帧计数（seq）持久化：重启后继续递增', async () => {
  const harness = await createHarness();
  let second = null;
  try {
    const device = await connectDevice(harness);
    await device.publish(harness.upTopic, '113.9737_22.69271');
    await device.publish(harness.upTopic, '113.9738_22.69272');
    await waitFor(async () => {
      const status = await harness.status();
      return status.json.adapter.latestGps && status.json.adapter.latestGps.seq === 2;
    });
    const stateFile = `${harness.dataDir}/wearable-mqtt-state.json`;
    assert.equal(fs.existsSync(stateFile), true);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).seq, 2);
    await device.disconnect();
    await harness.stopService();

    second = await createHarness({ dataDir: harness.dataDir, fake: harness.fake, keepDataDir: true });
    const device2 = await connectDevice(second);
    await device2.publish(second.upTopic, '113.9739_22.69273');
    await waitFor(async () => {
      const status = await second.status();
      return status.json.adapter.latestGps && status.json.adapter.latestGps.seq === 3;
    });
    assert.equal((await second.status()).json.adapter.latestGps.longitude, 113.9739);
    await device2.disconnect();
  } finally {
    if (second) await second.stop();
    else await harness.stop();
    await harness.fake.stop();
    fs.rmSync(harness.dataDir, { recursive: true, force: true });
  }
});

test('未知/其他设备报文只记诊断，不调用后端', async () => {
  await withHarness(async (harness) => {
    const device = await connectDevice(harness);
    try {
      await device.publish(harness.upTopic, JSON.stringify({ v: 1, t: 'unknown', dev: 'esp32-sos' }), { qos: 0 });
      await device.publish(harness.upTopic, JSON.stringify({ v: 1, t: 'hb', dev: 'other-device', state: 'IDLE' }), { qos: 0 });
      await device.publish('unrelated/topic', '113.9737_22.69271', { qos: 0 });
      await sleep(250);
      assert.equal(harness.fake.count('device-status'), 0);
      const status = await harness.status();
      assert.ok(status.json.adapter.counters.unknownType >= 1);
      assert.ok(status.json.adapter.counters.invalidMessage >= 1);
      assert.ok(status.json.adapter.counters.ignoredTopic >= 1);
    } finally {
      await device.disconnect();
    }
  });
});

test('HTTP 失败按指数退避重试：device-status 先 500 后成功', async () => {
  const harness = await createHarness({
    env: {
      HTTP_MAX_ATTEMPTS: '4',
      HTTP_BACKOFF_BASE_MS: '10',
      HTTP_BACKOFF_MAX_MS: '100'
    }
  });
  const device = await connectDevice(harness);
  try {
    harness.fake.failNext('device-status', 2, 500);
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'sos', alarm: 'sos-7-retry', uptimeMs: 1, seq: 1, gps: null
    }), { qos: 1 });
    await waitFor(async () => {
      const status = await harness.status();
      return status.json.adapter.counters.deviceStatusOk === 1;
    });
    // 前两次 500 被记录，第三次 202 成功
    assert.equal(harness.fake.count('device-status'), 3);
    const status = await harness.status();
    assert.ok(status.json.backend.counters.retries >= 2);
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});

test('SOS 包自带有效 gps 时优先使用（fixTime 用 ageMs 回推）', async () => {
  await withHarness(async (harness) => {
    const device = await connectDevice(harness);
    try {
      await device.publish(harness.upTopic, JSON.stringify({
        v: 1,
        t: 'sos',
        alarm: 'sos-6-payloadgps',
        uptimeMs: 100,
        seq: 1,
        gps: { lat: 32.9671, lon: 112.5532, fix: true, ageMs: 5000 }
      }));
      await waitFor(() => harness.fake.count('device-status') === 1);
      const record = harness.fake.records('device-status')[0];
      validGps(record.body.gps);
      assert.equal(record.body.gps.latitude, 32.9671);
      assert.equal(record.body.gps.longitude, 112.5532);
      assert.ok(record.body.gps.fixTime < record.body.ts, 'fixTime 应早于接收时间');
      assert.ok(record.body.ts - record.body.gps.fixTime >= 4000);
      assert.equal((await harness.status()).json.adapter.counters.sosGpsFromPayload, 1);
    } finally {
      await device.disconnect();
    }
  });
});
