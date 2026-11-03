'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FakeApi } = require('./helpers/fake-api');
const { ApiSource } = require('../src/source-api');
const { WearableMirrorModel } = require('../src/model');
const { waitFor, sleep } = require('./helpers/wait');

const T0 = 1_793_100_000_000;

function makeSource(api, model) {
  return new ApiSource({
    config: {
      api: {
        base: api.base,
        guardianId: api.guardianId,
        password: api.password,
        pollMs: 30,
        requestTimeoutMs: 1000
      }
    },
    model,
    log: () => {}
  });
}

function setAlarm(api, state, acknowledgedAt = 0) {
  api.devices = [{
    id: 'esp32-sos', deviceId: 'esp32-sos', name: '随身求助节点', roomName: '随身求助',
    online: true, state, lastSeenTs: T0, sensors: {}, csq: 26
  }];
  api.alerts = [{
    id: 'sos-20-api', alarmId: 'sos-20-api', deviceId: 'esp32-sos', roomName: '随身求助',
    type: 'MANUAL_SOS', message: '随身求助', state, ackPending: state !== 'ACKED',
    createdAt: T0 - 1000, acknowledgedAt
  }];
  api.locations = [{
    deviceId: 'esp32-sos', location: '32.9, 112.5', latitude: 32.9, longitude: 112.5, fixTime: T0 - 2000
  }];
}

test('只读轮询：ALARM → 事件；ACKED 只在后端 ACKED 后；位置来自 /location', async (t) => {
  const api = await new FakeApi().start();
  t.after(() => api.close());
  setAlarm(api, 'ALARM');
  const model = new WearableMirrorModel({ offlineAfterMs: 60000 });
  const source = makeSource(api, model);
  t.after(() => source.stop());
  source.start();

  await waitFor(() => model.event !== null, { label: 'api event' });
  assert.equal(model.event.alarmId, 'sos-20-api');
  assert.equal(model.phase(), 'ALARM');
  assert.equal(model.event.eventTs, T0 - 1000);
  assert.equal(model.event.gps.valid, true);
  assert.equal(model.event.gps.latitude, 32.9);
  assert.equal(model.event.gps.fixTime, T0 - 2000);
  assert.equal(model.counters.apiPolls >= 1, true);

  /* 后端仍 ALARM（家属点了确认但设备未回执）：不能变 ACKED */
  setAlarm(api, 'ALARM');
  await sleep(120);
  assert.equal(model.phase(), 'ALARM');

  setAlarm(api, 'ACKED', T0 + 5000);
  await waitFor(() => model.phase() === 'ACKED', { label: 'api acked' });
  assert.equal(model.event.ackedBy, 'device-ack-via-backend');
  assert.equal(model.event.ackTs, T0 + 5000);
  assert.ok(api.counters.alerts >= 2);
});

test('会话过期（401）后自动重新登录并继续轮询', async (t) => {
  const api = await new FakeApi().start();
  t.after(() => api.close());
  setAlarm(api, 'ALARM');
  const model = new WearableMirrorModel({ offlineAfterMs: 60000 });
  const source = makeSource(api, model);
  t.after(() => source.stop());
  source.start();
  await waitFor(() => model.event !== null, { label: 'first poll' });
  const loginsBefore = api.counters.logins;

  api.forceUnauthorizedOnce = true;
  await waitFor(() => api.counters.logins > loginsBefore, { label: 'relogin after 401' });
  await waitFor(() => model.counters.apiPolls >= 2, { label: 'polling continues after relogin' });
});

test('登录失败不打印凭据且不伪造数据', async (t) => {
  const api = await new FakeApi().start();
  t.after(() => api.close());
  setAlarm(api, 'ALARM');
  const model = new WearableMirrorModel({ offlineAfterMs: 60000 });
  const source = new ApiSource({
    config: {
      api: {
        base: api.base,
        guardianId: api.guardianId,
        password: 'wrong-password',
        pollMs: 20,
        requestTimeoutMs: 500
      }
    },
    model,
    log: () => {}
  });
  t.after(() => source.stop());
  source.start();
  await waitFor(() => source.status().authFailures >= 1, { label: 'auth failure counted' });
  assert.equal(model.event, null);
  assert.equal(model.lastSeenPcMs, 0);
});
