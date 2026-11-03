'use strict';

/**
 * reconnect-recovery.test.js — 断连/重启自愈回归测试（2026-10-27 修复）。
 *
 * 对应现场问题（evidence/2026-10-27-wearable-4g-gps-map/README.md §5.1、§6）：
 *   1) “ACK 未送达，恢复方法竟然是 docker restart wearable-mqtt”——
 *      设备重启窗口内 3 次下行全丢 → 命令 parked → 以前只能等 60s/5min 定时器或重启容器；
 *   2) 设备离线后 APP 仍把旧数据当实时——适配器从不发 online=false；
 *   3) 容器重启丢失内存态——可能把“已回执”或“未确认求助”的可见性搞乱。
 *
 * 本文件证明的语义（全部用假后端 + 真实 broker + 真实 MQTT 报文，不碰生产）：
 *   - 设备链路恢复（clientConnect）或任一业务上行（boot/hb）到达后，PENDING ACK 在 <10s 内重投，
 *     不需要任何人工重启；重投本身不代报 ACKED/FAILED。
 *   - 只有设备真实 `t:"ack"` 才 POST result(ACKED)。
 *   - 业务上行静默超过阈值才 online=false；恢复后首个业务上行立即 online=true；
 *     离线上报的 ts 用最后一次真实上行时间，不用 PC 当前时间冒充设备时间。
 *   - 持久化“最后已知状态”不含任何坐标；容器重启后不回退 ACKED、不丢未确认求助。
 *   - 同一 alarmId（含断连重连）不重复建告警。
 *   - 后端响应暂时缺少 parked 命令时不得静默丢弃 ACK。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createHarness, waitFor, sleep } = require('./helpers/harness');
const { RawMqttClient } = require('./helpers/raw-mqtt-client');

function pendingCommand(id, alarmId, overrides = {}) {
  return {
    id,
    createdAt: Date.now(),
    requestedBy: 'household-guardian',
    deviceId: 'esp32-sos',
    command: 'ACK',
    alarmId,
    action: '监护人已确认',
    status: 'PENDING',
    ...overrides
  };
}

/** 测试设备统一用 test-device 连接（harness 的 DEVICE_MQTT_CLIENT_ID=test-device）。 */
async function connectDevice(harness) {
  const client = new RawMqttClient();
  await client.connect({
    port: harness.brokerPort,
    clientId: 'test-device',
    username: harness.env.MQTT_USER,
    password: harness.env.MQTT_PASS,
    keepAlive: 60
  });
  return client;
}

function hbPacket(uptimeMs) {
  return JSON.stringify({
    v: 1,
    t: 'hb',
    dev: 'esp32-sos',
    state: 'IDLE',
    alarm: '',
    uptimeMs,
    csq: 26
  });
}

test('① 设备链路恢复（clientConnect）后 PENDING ACK 立即重投：<10s，无需重启容器', async () => {
  // parked 定时器故意调到 60s：如果恢复只靠定时器，本用例必然超时。
  const harness = await createHarness({
    env: {
      COMMAND_PARKED_RETRY_MS: '60000',
      COMMAND_SLOW_RETRY_MS: '60000',
      COMMAND_MAX_ROUNDS: '1'
    }
  });
  let device = null;
  try {
    harness.fake.addCommand(pendingCommand('1', 'sos-1-recover'));
    // 设备离线（没有任何 down 订阅者）：3 次投递全部 matched=0 → parked。
    await waitFor(() => harness.adapter.counters.commandsParked >= 1, { timeoutMs: 5000 });
    assert.equal(harness.fake.count('result'), 0, '无设备回执时绝不代报 result');
    assert.equal(harness.fake.findCommand('1').status, 'PENDING', '后端命令必须保持 PENDING');

    // 设备重新上线：clientConnect 触发链路恢复，下一次轮询（≤100ms）立即回读后端并重投。
    const startedAt = Date.now();
    device = await connectDevice(harness);
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    const downlink = await device.waitForMessage(() => true, 9000);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 10000, `链路恢复后重投必须 <10s，实际 ${elapsedMs}ms`);
    assert.equal(JSON.parse(downlink.payload).cmd, '1');
    assert.equal(harness.fake.count('result'), 0, '重投不是确认：仍不得代报 result');
    assert.equal(harness.fake.findCommand('1').status, 'PENDING');
    const afterRedeliver = (await harness.status()).json;
    assert.ok(afterRedeliver.adapter.counters.parkedRecoveryTriggers >= 1);

    // 只有设备真实 t:"ack" 之后才 ACKED（一次）。
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'ack', dev: 'esp32-sos', alarm: 'sos-1-recover', cmd: '1'
    }), { qos: 1 });
    await waitFor(() => harness.fake.count('result') === 1, { timeoutMs: 4000 });
    assert.equal(harness.fake.findCommand('1').status, 'ACKED');
  } finally {
    if (device) await device.disconnect();
    await harness.stop();
  }
});

test('①b 设备重启（boot 上行）后 parked ACK 自动重投，无需人工重启容器', async () => {
  const harness = await createHarness({
    env: { COMMAND_PARKED_RETRY_MS: '60000', COMMAND_SLOW_RETRY_MS: '60000' }
  });
  const device = await connectDevice(harness);
  try {
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    harness.fake.addCommand(pendingCommand('1', 'sos-2-boot'));
    // 设备在线但“收到下行不回执”（真机只有收到匹配 ACK 才回执），构造 parked 场景。
    await waitFor(() => harness.adapter.counters.commandsParked >= 1, { timeoutMs: 5000 });
    assert.equal(harness.fake.count('result'), 0);

    device.clearMessages();
    const startedAt = Date.now();
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'boot', dev: 'esp32-sos', uptimeMs: 0, fw: 'wearable-1.0.0'
    }), { qos: 1 });
    const again = await device.waitForMessage(() => true, 9000);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 10000, `boot 到达后重投必须 <10s，实际 ${elapsedMs}ms`);
    assert.equal(JSON.parse(again.payload).cmd, '1');
    await sleep(200);
    assert.equal(harness.fake.count('result'), 0, 'boot 不是确认：绝不代报 ACKED');
    assert.equal(harness.fake.findCommand('1').status, 'PENDING');
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});

test('② 同一 alarmId 跨断连重连不重复告警；只有新 alarmId 才新告警', async () => {
  const harness = await createHarness();
  let first = null;
  let second = null;
  try {
    const sos = JSON.stringify({
      v: 1, t: 'sos', dev: 'esp32-sos', alarm: 'sos-4-same', uptimeMs: 1000, seq: 1, gps: null
    });
    first = await connectDevice(harness);
    await first.publish(harness.upTopic, sos, { qos: 1 });
    await waitFor(() => harness.fake.count('device-status') === 1);
    await first.disconnect();
    first = null;

    // 重连（真实固件断连恢复后也会重发同一 alarmId）
    second = await connectDevice(harness);
    await second.publish(harness.upTopic, sos, { qos: 1 });
    await sleep(400);
    assert.equal(harness.fake.count('device-status'), 1, '同一 alarmId 只能 POST 一次（后端按 alarmId 幂等，适配器本地去重）');
    assert.ok(harness.adapter.counters.sosDuplicates >= 1);

    await second.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'sos', dev: 'esp32-sos', alarm: 'sos-5-next', uptimeMs: 3000, seq: 2, gps: null
    }), { qos: 1 });
    await waitFor(() => harness.fake.count('device-status') === 2);
    assert.equal(harness.fake.records('device-status')[1].body.alarm.id, 'sos-5-next');
    assert.equal(harness.fake.count('result'), 0, 'SOS 链路绝不代报 ACK');
  } finally {
    if (first) await first.disconnect();
    if (second) await second.disconnect();
    await harness.stop();
  }
});

test('③ 业务上行静默 > 阈值才 online=false（去抖），恢复首个上行立即 true；不伪造设备时间/坐标', async () => {
  const harness = await createHarness({ env: { DEVICE_ALIVE_TIMEOUT_MS: '1200' } });
  const device = await connectDevice(harness);
  try {
    await device.publish(harness.upTopic, hbPacket(1), { qos: 0 });
    await waitFor(() => harness.fake.count('device-status') === 1);
    const hbBody = harness.fake.records('device-status')[0].body;
    assert.equal(hbBody.online, true);

    // M100 的 GPS 固定格式行仍在上报：它不代表 ESP32 存活，不能阻止离线判定。
    const gpsSentAfterMs = Date.now();
    await device.publish(harness.upTopic, '113.9737_22.69271', { qos: 0 });
    const gpsSentBeforeMs = Date.now();

    await waitFor(() => harness.fake.count('device-status') === 2, { timeoutMs: 5000 });
    const offline = harness.fake.records('device-status')[1].body;
    assert.equal(offline.online, false, '静默超阈值必须如实上报 offline');
    assert.equal(offline.state, 'NORMAL');
    assert.equal(offline.alarm.id, '');
    assert.equal(offline.ts, hbBody.ts, '离线上报的 ts 必须是最后真实上行时间，不得用 PC 当前时间冒充设备时间');
    // 位置字段只允许是“最后一次真实定位”（含真实 fixTime），不得写入新坐标：
    assert.equal(offline.gps.valid, true);
    assert.equal(offline.gps.latitude, 22.69271);
    assert.ok(offline.gps.fixTime >= gpsSentAfterMs - 1000 && offline.gps.fixTime <= gpsSentBeforeMs + 1000,
      `gps.fixTime 必须是该定位帧真实接收时间（${offline.gps.fixTime}）`);

    let status = (await harness.status()).json;
    assert.equal(status.adapter.device.online, false);
    assert.ok(status.adapter.counters.deviceOfflineReports >= 1);
    assert.equal(status.adapter.link.watchdogArmed, false);

    // 静默期只上报一次，不刷接口
    await sleep(500);
    assert.equal(harness.fake.count('device-status'), 2);

    // 恢复：首个业务上行立即 online=true（不需要等阈值）
    await device.publish(harness.upTopic, hbPacket(9000), { qos: 0 });
    await waitFor(() => harness.fake.count('device-status') === 3, { timeoutMs: 3000 });
    const back = harness.fake.records('device-status')[2].body;
    assert.equal(back.online, true);
    status = (await harness.status()).json;
    assert.equal(status.adapter.device.online, true);
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});

test('③b 离线判定去抖：阈值内的心跳只刷新、绝不让 APP 闪“离线”', async () => {
  const harness = await createHarness({ env: { DEVICE_ALIVE_TIMEOUT_MS: '1500' } });
  const device = await connectDevice(harness);
  try {
    await device.publish(harness.upTopic, hbPacket(1), { qos: 0 });
    await waitFor(() => harness.fake.count('device-status') === 1);
    await sleep(600);
    await device.publish(harness.upTopic, hbPacket(2), { qos: 0 });
    await waitFor(() => harness.fake.count('device-status') === 2);
    // 距第一次心跳已 1.3s（>阈值），但距第二次只有 0.7s：必须重新计时，不得报离线。
    await sleep(700);
    assert.equal(harness.fake.count('device-status'), 2, '阈值内的新心跳必须重置看门狗');
    // 第二次心跳后静默满阈值才报离线。
    await waitFor(() => harness.fake.count('device-status') === 3, { timeoutMs: 5000 });
    assert.equal(harness.fake.records('device-status')[2].body.online, false);
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});

test('④ 容器重启（内存态丢失）：持久化最后已知状态不含坐标，不丢未确认求助、不代报 ACKED', async () => {
  const harness = await createHarness({ env: { DEVICE_ALIVE_TIMEOUT_MS: '1200' } });
  let second = null;
  try {
    const device = await connectDevice(harness);
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'sos', dev: 'esp32-sos', alarm: 'sos-9-persist', uptimeMs: 1, seq: 1, gps: null
    }), { qos: 1 });
    await waitFor(() => harness.fake.count('device-status') === 1);
    assert.equal(harness.fake.records('device-status')[0].body.state, 'ALARM');
    await device.disconnect();
    await harness.stopService();

    // 持久化内容：最后已知状态（state/alarmId/csq/时间戳），绝不含坐标。
    const stateFile = `${harness.dataDir}/wearable-mqtt-state.json`;
    const document = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(document.device.state, 'ALARM');
    assert.equal(document.device.alarmId, 'sos-9-persist');
    const persistedText = JSON.stringify(document.device);
    assert.ok(!/latitude|longitude|gps|fixTime|coordinate/i.test(persistedText), '持久化设备状态不得包含坐标');

    const resultBefore = harness.fake.count('result');
    second = await createHarness({
      dataDir: harness.dataDir,
      fake: harness.fake,
      keepDataDir: true,
      env: { DEVICE_ALIVE_TIMEOUT_MS: '1200' }
    });
    // 设备一直不回来：适配器只能用持久化的最后已知状态如实上报 offline，绝不代报 ACKED/FAILED。
    await waitFor(() => second.fake.count('device-status') >= 2, { timeoutMs: 6000 });
    const offlineRecord = second.fake.records('device-status').slice(-1)[0].body;
    assert.equal(offlineRecord.online, false);
    assert.equal(offlineRecord.state, 'ALARM', '未确认求助在重启后仍是 ALARM，不能被恢复成 NORMAL/ACKED');
    assert.equal(offlineRecord.alarm.id, 'sos-9-persist', '未确认求助的 alarmId 必须保留（APP 仍能看到该告警）');
    assert.equal(second.fake.count('result'), resultBefore, '重启不得代报 result');
    const status = (await second.status()).json;
    assert.ok(status.adapter.counters.deviceStateRestored >= 1, '必须从持久化状态恢复');
    assert.equal(status.adapter.device.state, 'ALARM');
    assert.equal(status.adapter.device.alarmId, 'sos-9-persist');
  } finally {
    if (second) await second.stop();
    else await harness.stop();
    await harness.fake.stop();
    fs.rmSync(harness.dataDir, { recursive: true, force: true });
  }
});

test('④b 容器重启不回退 ACKED：不重复 result、不重复告警', async () => {
  const harness = await createHarness({ env: { DEVICE_ALIVE_TIMEOUT_MS: '1200' } });
  let second = null;
  try {
    const device = await connectDevice(harness);
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    harness.fake.addCommand(pendingCommand('1', 'sos-10-acked'));
    await device.waitForMessage(() => true);
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'ack', dev: 'esp32-sos', alarm: 'sos-10-acked', cmd: '1'
    }), { qos: 1 });
    await waitFor(() => harness.fake.count('result') === 1);
    await waitFor(async () => (await harness.status()).json.state.commandCursor === 1);
    await device.disconnect();
    await harness.stopService();

    const document = JSON.parse(fs.readFileSync(`${harness.dataDir}/wearable-mqtt-state.json`, 'utf8'));
    assert.equal(document.device.state, 'ACKED');
    assert.equal(document.commandCursor, 1);

    second = await createHarness({
      dataDir: harness.dataDir,
      fake: harness.fake,
      keepDataDir: true,
      env: { DEVICE_ALIVE_TIMEOUT_MS: '1200' }
    });
    await sleep(1500);
    assert.equal(second.fake.count('result'), 1, '重启不得重复 POST result');
    assert.equal(second.fake.findCommand('1').status, 'ACKED');
    const status = (await second.status()).json;
    assert.equal(status.adapter.device.state, 'ACKED', '已 ACKED 不得回退');
    assert.equal(status.state.commandCursor, 1, '游标不得回退');

    // 设备回来：只应新增一条真实心跳状态，不得再次 ACKED/告警。
    const statusBefore = second.fake.count('device-status');
    const device2 = await connectDevice(second);
    try {
      await device2.publish(second.upTopic, hbPacket(100), { qos: 0 });
      await waitFor(() => second.fake.count('device-status') > statusBefore, { timeoutMs: 4000 });
      const last = second.fake.records('device-status').slice(-1)[0].body;
      assert.equal(last.state, 'NORMAL');
      assert.equal(second.fake.count('result'), 1);
    } finally {
      await device2.disconnect();
    }
  } finally {
    if (second) await second.stop();
    else await harness.stop();
    await harness.fake.stop();
    fs.rmSync(harness.dataDir, { recursive: true, force: true });
  }
});

test('⑤ 后端响应暂时缺少 parked 命令：不得静默丢弃 ACK，恢复后继续重投', async () => {
  const harness = await createHarness({
    env: { COMMAND_PARKED_RETRY_MS: '300', COMMAND_SLOW_RETRY_MS: '1000', COMMAND_MAX_ROUNDS: '1' }
  });
  try {
    harness.fake.addCommand(pendingCommand('1', 'sos-3-lookup'));
    await waitFor(() => harness.adapter.counters.commandsParked >= 1, { timeoutMs: 5000 });

    harness.fake.setCommands([]); // 模拟后端响应异常/暂时看不到该命令
    await waitFor(() => harness.adapter.counters.parkedLookupMissing >= 1, { timeoutMs: 5000 });
    const parked = (await harness.status()).json.adapter.commands.parked;
    assert.equal(parked.length, 1, '后端响应缺项时不得把 parked 命令静默删除');
    assert.equal(harness.fake.count('result'), 0);

    harness.fake.addCommand(pendingCommand('1', 'sos-3-lookup')); // 后端恢复可见
    await waitFor(() => harness.adapter.counters.commandsRedelivered >= 1, { timeoutMs: 5000 });
    assert.equal(harness.fake.count('result'), 0, '重投仍然不是确认');
    assert.equal(harness.fake.findCommand('1').status, 'PENDING');
  } finally {
    await harness.stop();
  }
});
