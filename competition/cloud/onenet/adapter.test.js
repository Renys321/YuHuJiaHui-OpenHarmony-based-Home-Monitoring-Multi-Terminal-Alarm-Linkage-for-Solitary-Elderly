'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildTopics,
  makePropertySetReply,
  mapPropertySet,
  toAlarmEvent,
  toPropertyPost,
  utcNowMs
} = require('./adapter');

const TS = 1_791_608_811_715;

function status(overrides = {}) {
  return {
    deviceId: 'esp32-bath',
    room: '卫生间',
    online: true,
    state: 'ALARM',
    sensors: {
      motion: { lastActiveTs: 1_791_608_769_555, countToday: 7 },
      door: { open: false, lastOpenTs: 0 },
      climate: { tempC: 24.6, rh: 41.2, ok: true },
      gas: { raw: 123, ok: true },
      smoke: { raw: 45, ok: false }
    },
    fall: { detected: true, confidence: 0.94, detectedAt: 1_791_608_800_000 },
    alarm: { id: 'e-1791608811-2', type: 'NO_MOTION', countToday: 2, detail: '长时间无活动' },
    gps: { latitude: 34.7466, longitude: 113.6254, altitude: 98.2 },
    csq: 24,
    ...overrides
  };
}

test('buildTopics creates only canonical OneJSON topics', () => {
  assert.deepEqual(buildTopics('prod_01', 'esp32-bath'), {
    propertyPost: '$sys/prod_01/esp32-bath/thing/property/post',
    propertyPostReply: '$sys/prod_01/esp32-bath/thing/property/post/reply',
    propertySet: '$sys/prod_01/esp32-bath/thing/property/set',
    propertySetReply: '$sys/prod_01/esp32-bath/thing/property/set_reply',
    eventPost: '$sys/prod_01/esp32-bath/thing/event/post',
    eventPostReply: '$sys/prod_01/esp32-bath/thing/event/post/reply'
  });
});

test('buildTopics rejects traversal, separators, whitespace and oversized segments', () => {
  for (const value of ['', '../x', 'a/b', '$sys', 'a b', '中移物联', `a${'x'.repeat(64)}`]) {
    assert.throws(() => buildTopics(value, 'device-1'), TypeError);
    assert.throws(() => buildTopics('product-1', value), TypeError);
  }
});

test('toPropertyPost maps the complete internal state with one millisecond timestamp', () => {
  const out = toPropertyPost(status(), { id: '101', timestampMs: TS });
  assert.equal(out.id, '101');
  assert.equal(out.version, '1.0');
  assert.equal(out.params.deviceId.value, 'esp32-bath');
  assert.equal(out.params.temperature.value, 24.6);
  assert.equal(out.params.humidity.value, 41.2);
  assert.deepEqual(out.params.motion.value, { lastActiveTs: 1_791_608_769_555, countToday: 7 });
  assert.deepEqual(out.params.door.value, { open: false, lastOpenTs: 0 });
  assert.deepEqual(out.params.gas.value, { ok: true, raw: 123 });
  assert.deepEqual(out.params.smoke.value, { ok: false, raw: 45 });
  assert.deepEqual(out.params.fall.value, {
    detected: true, confidence: 0.94, detectedAt: 1_791_608_800_000
  });
  assert.equal(out.params.gps.value.longitude, 113.6254);
  assert.equal(out.params.csq.value, 24);
  for (const property of Object.values(out.params)) assert.equal(property.time, TS);
  assert.match(String(out.params.state.time), /^\d{13}$/);
});

test('toPropertyPost accepts flat optional fields and derives online from state', () => {
  const out = toPropertyPost({
    deviceId: 'dayu200-living', room: '客厅', state: 'OFFLINE',
    motion: { lastActiveTs: 0, countToday: 0 },
    door: { open: true, lastOpenTs: TS },
    temperature: 22, humidity: 50, gas: true, smoke: false, csq: 99
  }, { id: '102', timestampMs: TS });
  assert.equal(out.params.online.value, false);
  assert.deepEqual(out.params.gas.value, { ok: true, raw: 0 });
  assert.equal(out.params.csq.value, 99);
});

test('state conversion rejects invalid timestamps and sensor ranges', () => {
  assert.throws(() => toPropertyPost(status(), { timestampMs: 1_791_608_811 }), /13-digit/);
  assert.throws(() => toPropertyPost(status({ csq: 32 }), { timestampMs: TS }), /0-31 or 99/);
  const bad = status();
  bad.sensors.climate.rh = 101;
  assert.throws(() => toPropertyPost(bad, { timestampMs: TS }), /humidity/);
  assert.throws(() => toPropertyPost(status({
    fall: { detected: true, confidence: 0.8, detectedAt: 0 }
  }), { timestampMs: TS }), /detection timestamp/);
  assert.throws(() => toPropertyPost(status({
    fall: { detected: false, confidence: 1.1, detectedAt: 0 }
  }), { timestampMs: TS }), /fall.confidence/);
});

test('toAlarmEvent emits one alarm event and optional GPS', () => {
  const out = toAlarmEvent(status(), { id: '103', timestampMs: TS });
  assert.equal(out.params.safetyAlarm.time, TS);
  assert.deepEqual(out.params.safetyAlarm.value.gps, {
    valid: true, fixTime: 0, latitude: 34.7466, longitude: 113.6254, altitude: 98.2
  });
  assert.equal(out.params.safetyAlarm.value.alarmId, 'e-1791608811-2');
  assert.equal(out.params.alarm, undefined);
});

test('toAlarmEvent refuses non-alarm state, empty alarm and unknown alarm type', () => {
  assert.throws(() => toAlarmEvent(status({ state: 'NORMAL' }), { timestampMs: TS }), /state/);
  assert.throws(() => toAlarmEvent(status({ alarm: { id: '', type: '', countToday: 0 } }), { timestampMs: TS }));
  assert.throws(() => toAlarmEvent(status({ alarm: { id: 'x', type: 'EXEC', countToday: 1 } }), { timestampMs: TS }), /not supported/);
});

test('property/set maps ACK, including the documented value wrapper', () => {
  const direct = mapPropertySet(JSON.stringify({
    id: '201', version: '1.0',
    params: { control: { command: 'ACK', alarmId: 'alarm-1', action: '已电话确认老人安全' } }
  }));
  assert.deepEqual(direct, {
    requestId: '201',
    command: { command: 'ACK', alarmId: 'alarm-1', action: '已电话确认老人安全' }
  });
  const wrapped = mapPropertySet(Buffer.from(JSON.stringify({
    id: '202', version: '1.0',
    params: { control: { value: { command: 'ACK', alarmId: 'alarm-2', action: '社区人员已到场' } } }
  })));
  assert.equal(wrapped.command.command, 'ACK');
});

test('property/set maps RESET and bounded SET_CONFIG', () => {
  assert.deepEqual(mapPropertySet({
    id: '301', version: '1.0', params: { control: { command: 'RESET' } }
  }), { requestId: '301', command: { command: 'RESET' } });
  assert.deepEqual(mapPropertySet({
    id: '3011', version: '1.0',
    params: { control: { command: 'RESET', alarmId: '', action: '' } }
  }), { requestId: '3011', command: { command: 'RESET' } });
  assert.deepEqual(mapPropertySet({
    id: '302', version: '1.0',
    params: { control: { command: 'SET_CONFIG', noMotionSec: 1800, reportIntervalSec: 5 } }
  }), {
    requestId: '302',
    command: { command: 'SET_CONFIG', config: { noMotionSec: 1800, reportIntervalSec: 5 } }
  });
});

test('property/set rejects unknown commands, fields, injection and dangerous config', () => {
  const payload = (control) => ({ id: '401', version: '1.0', params: { control } });
  assert.throws(() => mapPropertySet(payload({ command: 'SHELL', commandLine: 'rm -rf /' })), /unknown field|unsupported/);
  assert.throws(() => mapPropertySet(payload({ command: 'ACK', alarmId: 'a', action: 'ok\nreset' })), /control characters/);
  assert.throws(() => mapPropertySet(payload({ command: 'RESET', extra: true })), /unknown field/);
  assert.throws(() => mapPropertySet(payload({ command: 'RESET', alarmId: 'not-empty', action: '' })), /must be empty/);
  assert.throws(() => mapPropertySet(payload({ command: 'SET_CONFIG', config: { noMotionSec: 1800 } })), /unknown field/);
  assert.throws(() => mapPropertySet(payload({ command: 'SET_CONFIG', wifiPassword: 'secret' })), /unknown field/);
  assert.throws(() => mapPropertySet(payload({ command: 'SET_CONFIG' })), /at least one/);
  assert.throws(() => mapPropertySet(payload({ command: 'SET_CONFIG', noMotionSec: 1 })), /30, 86400/);
  assert.throws(() => mapPropertySet({ id: '401', version: '1.0', params: { control: { command: 'RESET' }, other: 1 } }), /unknown field/);
});

test('property/set enforces protocol envelope and payload size', () => {
  assert.throws(() => mapPropertySet('{bad'), /valid JSON/);
  assert.throws(() => mapPropertySet({ id: '../bad', version: '1.0', params: { control: { command: 'RESET' } } }), /message id/);
  assert.throws(() => mapPropertySet({ id: '402', version: '2.0', params: { control: { command: 'RESET' } } }), /version/);
  assert.throws(() => mapPropertySet('x'.repeat(16 * 1024 + 1)), /exceeds/);
});

test('property/set reply is tied to the request id', () => {
  assert.deepEqual(makePropertySetReply('501', { ok: true }), { id: '501', code: 200, msg: 'success' });
  assert.deepEqual(makePropertySetReply('502', { ok: false, message: 'device offline' }), {
    id: '502', code: 400, msg: 'device offline'
  });
});

test('message ids are numeric strings with at most 13 digits', () => {
  assert.throws(() => makePropertySetReply('request-1', { ok: true }), /message id/);
  assert.throws(() => makePropertySetReply('12345678901234', { ok: true }), /message id/);
});

test('GPS distinguishes an invalid indoor fix from a valid WGS84 fix', () => {
  const invalid = toPropertyPost(status({ gps: { valid: false, fixTime: 0 } }), {
    id: '601', timestampMs: TS
  });
  assert.deepEqual(invalid.params.gps.value, { valid: false, fixTime: 0 });
  assert.throws(() => toPropertyPost(status({ gps: { valid: true } }), {
    id: '602', timestampMs: TS
  }), /requires latitude and longitude/);
});

test('utcNowMs returns a current 13-digit UTC epoch millisecond value', () => {
  const before = Date.now();
  const actual = utcNowMs();
  const after = Date.now();
  assert.ok(actual >= before && actual <= after);
  assert.match(String(actual), /^\d{13}$/);
});

test('thing-model is valid JSON and covers every required identifier', () => {
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, 'thing-model.json'), 'utf8'));
  const properties = new Set(model.properties.map((item) => item.identifier));
  const events = new Set(model.events.map((item) => item.identifier));
  for (const id of [
    'deviceId', 'room', 'online', 'state', 'motion', 'door', 'temperature',
    'humidity', 'gas', 'smoke', 'fall', 'alarm', 'gps', 'csq'
  ]) assert.ok(properties.has(id), `missing property ${id}`);
  assert.ok(properties.has('control'));
  assert.ok(events.has('safetyAlarm'));
});

test('OneNET import model matches the adapter-facing identifiers', () => {
  const model = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'thing-model.onenet-import.json'),
    'utf8'
  ));
  const properties = new Map(model.properties.map((item) => [item.identifier, item]));
  const events = new Map(model.events.map((item) => [item.identifier, item]));
  for (const id of [
    'deviceId', 'room', 'online', 'state', 'motion', 'door', 'temperature',
    'humidity', 'gas', 'smoke', 'fall', 'alarm', 'gps', 'csq', 'control'
  ]) assert.ok(properties.has(id), `missing OneNET property ${id}`);
  assert.equal(properties.get('control').accessMode, 'rw');
  assert.ok(events.has('safetyAlarm'));
  assert.equal(model.profile.productId, 'I19NBBq4xe');
});
