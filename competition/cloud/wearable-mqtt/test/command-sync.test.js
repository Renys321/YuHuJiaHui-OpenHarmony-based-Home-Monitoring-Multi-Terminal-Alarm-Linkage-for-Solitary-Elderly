'use strict';

/**
 * command-sync.test.js — APP ACK 命令下行与设备回执集成测试。
 * 覆盖：命令下发到 down 主题、3 次/5s(测试加速) 重发、无设备回执绝不代报、
 * 设备真实回执后按真实 schema 回写、其他设备命令忽略、重启 after 续读、
 * 过期命令迟来回执仍真实上报。
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

test('ACK 命令下发到 down 主题；3 次重发；无设备回执绝不 POST result（保持 PENDING）', async () => {
  const harness = await createHarness({ env: { COMMAND_PARKED_RETRY_MS: '3000' } });
  const device = await connectDevice(harness);
  try {
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    harness.fake.addCommand(pendingCommand('1', 'sos-1-ab12cd'));

    await waitFor(() => device.messages.length >= 3);
    const first = device.messages[0];
    assert.equal(first.topic, harness.downTopic);
    // M100 下行原样透传、不补换行：适配器必须补 '\n'，否则 ESP32 行解析卡住。
    assert.ok(first.payload.endsWith('\n'), 'downlink payload 必须以 \\n 结尾');
    assert.deepEqual(JSON.parse(first.payload), {
      v: 1,
      t: 'ack',
      alarm: 'sos-1-ab12cd',
      cmd: '1'
    });
    // 至少 3 次投递（测试里重发间隔 150ms）
    await waitFor(() => harness.adapter.counters.commandsPublished >= 3);
    await sleep(400);
    assert.equal(harness.fake.count('result'), 0, '无设备回执绝不代报 result');
    assert.equal(harness.fake.findCommand('1').status, 'PENDING', '后端命令必须保持 PENDING');

    await waitFor(async () => {
      const status = await harness.status();
      return status.json.adapter.commands.parked.some((item) => item.commandId === '1');
    });
    const status = await harness.status();
    assert.equal(status.json.adapter.counters.commandPublishNoSubscriber, 0, '设备已订阅，下行应有订阅者');
    assert.equal(status.json.adapter.commands.lastPoll.ok, true);
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});

test('设备真实回执（alarm/cmd 匹配）后才 POST result，字段符合真实后端 schema', async () => {
  const harness = await createHarness();
  const device = await connectDevice(harness);
  try {
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    harness.fake.addCommand(pendingCommand('1', 'sos-1-ab12cd'));

    const downlink = await device.waitForMessage(() => true);
    assert.equal(JSON.parse(downlink.payload).cmd, '1');
    assert.equal(harness.fake.count('result'), 0);

    await device.publish(harness.upTopic, JSON.stringify({
      v: 1,
      t: 'ack',
      dev: 'esp32-sos',
      alarm: 'sos-1-ab12cd',
      cmd: '1'
    }), { qos: 1 });

    await waitFor(() => harness.fake.count('result') === 1);
    await waitFor(() => harness.fake.findCommand('1').status === 'ACKED');
    const result = harness.fake.records('result')[0];
    assert.equal(result.headers['x-ingest-key'], harness.env.INGEST_KEY);
    assert.equal(result.path, '/internal/v1/commands/1/result');
    assert.equal(result.body.status, 'ACKED');
    assert.equal(result.body.deviceState.deviceId, 'esp32-sos');
    assert.equal(result.body.deviceState.state, 'ACKED');
    assert.equal(result.body.deviceState.room, '随身求助');
    assert.equal(result.body.deviceState.online, true);
    assert.equal(result.body.deviceState.alarm.id, 'sos-1-ab12cd');
    assert.equal(result.body.deviceState.alarm.type, 'MANUAL_SOS');
    assert.equal(Number.isSafeInteger(result.body.deviceState.ts), true);
    assert.equal(harness.fake.findCommand('1').status, 'ACKED');

    // 重复回执不得重复 POST
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1,
      t: 'ack',
      alarm: 'sos-1-ab12cd',
      cmd: '1'
    }), { qos: 0 });
    await sleep(400);
    assert.equal(harness.fake.count('result'), 1);

    await waitFor(async () => {
      const status = await harness.status();
      return status.json.state.commandCursor === 1 && status.json.adapter.commands.settled === 1;
    });
    const status = await harness.status();
    assert.equal(status.json.adapter.device.state, 'ACKED');
    assert.equal(status.json.adapter.counters.commandResultOk, 1);
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});

test('alarm/cmd 不匹配的设备回执被拒绝，不写 result', async () => {
  const harness = await createHarness();
  const device = await connectDevice(harness);
  try {
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    harness.fake.addCommand(pendingCommand('1', 'sos-1-ab12cd'));
    await device.waitForMessage(() => true);

    // 错误 alarm（cmd 对）
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'ack', alarm: 'sos-9-zzzzzz', cmd: '1'
    }), { qos: 0 });
    // 错误 cmd（alarm 对）
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'ack', alarm: 'sos-1-ab12cd', cmd: '999'
    }), { qos: 0 });
    await sleep(400);
    assert.equal(harness.fake.count('result'), 0);
    assert.equal(harness.fake.findCommand('1').status, 'PENDING');
    const status = await harness.status();
    assert.ok(status.json.adapter.counters.ackReceiptRejected >= 1);
    assert.ok(status.json.adapter.counters.ackReceiptUnknown >= 1);
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});

test('只处理 deviceId=esp32-sos & command=ACK & PENDING；其他设备命令只推进游标', async () => {
  const harness = await createHarness();
  const device = await connectDevice(harness);
  try {
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    harness.fake.addCommand(pendingCommand('1', 'sos-other-1', {
      deviceId: 'esp32-bath'
    }));
    harness.fake.addCommand(pendingCommand('2', 'sos-other-2', {
      command: 'REBOOT'
    }));
    harness.fake.addCommand(pendingCommand('3', 'sos-other-3', {
      status: 'ACKED'
    }));

    await waitFor(async () => {
      const status = await harness.status();
      return status.json.state.commandCursor === 3;
    });
    await sleep(200);
    assert.equal(device.messages.length, 0, '其他设备/非 ACK/已完成命令绝不下发');
    assert.equal(harness.fake.count('result'), 0);
    const status = await harness.status();
    assert.ok(status.json.adapter.counters.commandsIgnored >= 3);

    // 自己的命令仍应被领取（id 4）
    harness.fake.addCommand(pendingCommand('4', 'sos-1-owned'));
    const message = await device.waitForMessage(() => true);
    assert.equal(JSON.parse(message.payload).cmd, '4');
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});

test('重启 after 续读：已结算命令不重复下发，GET 使用持久化游标', async () => {
  const harness = await createHarness();
  const device = await connectDevice(harness);
  let second = null;
  try {
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    harness.fake.addCommand(pendingCommand('1', 'sos-1-ab12cd'));
    await device.waitForMessage(() => true);
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'ack', alarm: 'sos-1-ab12cd', cmd: '1'
    }), { qos: 1 });
    await waitFor(async () => {
      const status = await harness.status();
      return status.json.state.commandCursor === 1;
    }, { label: 'first command cursor=1' });
    await device.disconnect();
    await harness.stopService();

    const recordsBefore = harness.fake.records('commands').length;
    second = await createHarness({ dataDir: harness.dataDir, fake: harness.fake, keepDataDir: true });
    await waitFor(() => harness.fake.records('commands').length > recordsBefore, { label: 'restart poll after=1' });
    const restartPolls = harness.fake.records('commands').slice(recordsBefore);
    assert.equal(restartPolls[0].query.after, '1', '重启后必须从持久化游标续读');
    // 已 ACKED 的命令不得重新下发
    const device2 = await connectDevice(second);
    await device2.subscribe([{ filter: second.downTopic, qos: 1 }]);
    await sleep(400);
    assert.equal(device2.messages.length, 0);
    assert.equal(harness.fake.count('result'), 1);
    await device2.disconnect();
  } finally {
    if (second) await second.stop();
    else await harness.stop();
    await harness.fake.stop();
    fs.rmSync(harness.dataDir, { recursive: true, force: true });
  }
});

test('3 次无回执后 parked，后端仍 PENDING；本地超时后迟到回执仍真实上报', async () => {
  const harness = await createHarness();
  const device = await connectDevice(harness);
  try {
    harness.fake.addCommand(pendingCommand('1', 'sos-1-late'));
    // 无人订阅 down：每次 publish matched=0，但计为一次投递
    await waitFor(() => harness.adapter.counters.commandsPublished >= 3);
    await waitFor(() => harness.adapter.counters.commandsParked >= 1);
    // 多轮后本地超时（进入低频慢速重投）；期间绝不 POST result / FAILED
    await waitFor(() => harness.adapter.counters.commandsExpired >= 1, { timeoutMs: 6000 });
    assert.equal(harness.fake.count('result'), 0);
    assert.equal(harness.fake.findCommand('1').status, 'PENDING', '绝不代报 FAILED/ACKED');

    // 迟到设备回执：仍应按真实回执上报 ACKED（而不是丢弃）
    await device.subscribe([{ filter: harness.downTopic, qos: 1 }]);
    await device.publish(harness.upTopic, JSON.stringify({
      v: 1, t: 'ack', alarm: 'sos-1-late', cmd: '1'
    }), { qos: 0 });
    await waitFor(() => harness.fake.count('result') === 1);
    await waitFor(() => harness.fake.findCommand('1').status === 'ACKED');
    assert.equal(harness.fake.records('result')[0].body.status, 'ACKED');
  } finally {
    await device.disconnect();
    await harness.stop();
  }
});
