'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FakeBroker } = require('./helpers/fake-broker');
const { MqttSource } = require('../src/source-mqtt');
const { WearableMirrorModel } = require('../src/model');
const { waitFor } = require('./helpers/wait');

const UP = 'eldercare/wearable/sos-001/up';

function makeSource(broker, options = {}) {
  const model = new WearableMirrorModel({ offlineAfterMs: 45000 });
  const source = new MqttSource({
    config: {
      mqtt: {
        host: '127.0.0.1',
        port: broker.port,
        clientId: options.clientId || 'mirror-test-client',
        user: broker.username,
        pass: broker.password,
        upTopic: UP
      }
    },
    model,
    log: () => {},
    onAuthRejected: options.onAuthRejected
  });
  return { model, source };
}

test('订阅 UP_TOPIC：sos → ALARM，ack → ACKED，坏 GPS 不写坐标', async (t) => {
  const broker = await new FakeBroker({ clientIds: ['mirror-test-client'] }).start();
  t.after(() => broker.close());
  const { model, source } = makeSource(broker);
  t.after(() => source.stop());
  source.start();

  await waitFor(() => broker.subscriptions.some((item) => item.filter === UP), { label: 'subscribe' });

  broker.publish(UP, '112.55326080300_32.966827393000');
  await waitFor(() => model.latestGps !== null, { label: 'gps fix' });
  assert.equal(model.latestGps.latitude, 32.9668274);

  broker.publish(UP, JSON.stringify({ v: 1, t: 'sos', dev: 'esp32-sos', alarm: 'sos-1-ab12cd', gps: null, seq: 1 }));
  await waitFor(() => model.event !== null, { label: 'sos event' });
  assert.equal(model.event.alarmId, 'sos-1-ab12cd');
  assert.equal(model.phase(), 'ALARM');
  assert.equal(model.event.gpsSource, 'm100-latest');

  broker.publish(UP, 'config,set,paramsrc,1');
  broker.publish(UP, '{"v":1,"t":"sos"');
  await waitFor(() => model.counters.gpsReject >= 1 && model.counters.malformed >= 1, { label: 'rejects counted' });

  broker.publish(UP, JSON.stringify({ v: 1, t: 'ack', dev: 'esp32-sos', alarm: 'sos-1-ab12cd', cmd: '42' }));
  await waitFor(() => model.phase() === 'ACKED', { label: 'acked' });
  assert.equal(model.event.ackedBy, 'device-ack');
});

test('同一 alarmId 的重发只保留一条事件', async (t) => {
  const broker = await new FakeBroker({ clientIds: ['mirror-test-client'] }).start();
  t.after(() => broker.close());
  const { model, source } = makeSource(broker);
  t.after(() => source.stop());
  source.start();
  await waitFor(() => broker.subscriptions.length >= 1, { label: 'subscribe' });

  for (let i = 0; i < 3; i++) {
    broker.publish(UP, JSON.stringify({ v: 1, t: 'sos', dev: 'esp32-sos', alarm: 'sos-2-retry', gps: null, seq: i + 1 }));
  }
  await waitFor(() => model.counters.sosRetransmit >= 2, { label: 'retransmits' });
  assert.equal(model.event.alarmId, 'sos-2-retry');
  assert.equal(model.knownAlarmIds.size, 1);
});

test('broker 白名单拒绝时触发 onAuthRejected（绝不复用设备 clientId）', async (t) => {
  const broker = await new FakeBroker({ clientIds: ['wearable-sos-001'] }).start();
  t.after(() => broker.close());
  let rejected = null;
  const { source } = makeSource(broker, {
    clientId: 'wearable-mirror-001',
    onAuthRejected: (info) => { rejected = info; }
  });
  t.after(() => source.stop());
  source.start();
  await waitFor(() => rejected !== null, { label: 'auth rejected' });
  assert.equal(rejected.code, 5);
  assert.equal(broker.counters.clientIdRejected, 1);
});
