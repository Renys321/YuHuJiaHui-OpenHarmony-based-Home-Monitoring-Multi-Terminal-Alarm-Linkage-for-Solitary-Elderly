'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { PROFILES, SimNodeState, parseArgs, parseGateway, startClient } = require('./sim_node');
const { runScenario } = require('./sim_multiroom_check');
const { toPropertyPost } = require('../cloud/onenet/adapter');

const NOW = 1_791_920_000_000;

function waitFor(predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = predicate();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('profile defaults describe distinct kitchen and bedroom nodes', () => {
  const kitchen = parseArgs(['--profile', 'kitchen']);
  const bedroom = parseArgs(['--profile', 'bedroom']);
  assert.equal(kitchen.deviceId, 'esp32-kitchen');
  assert.equal(kitchen.room, '厨房');
  assert.deepEqual(kitchen.capabilities, PROFILES.kitchen.capabilities);
  assert.equal(bedroom.deviceId, 'esp32-bedroom');
  assert.equal(bedroom.room, '卧室');
  assert.deepEqual(bedroom.capabilities, PROFILES.bedroom.capabilities);
});

test('legacy explicit arguments remain compatible', () => {
  const config = parseArgs(['--gw', '127.0.0.1:9101', '--id', 'esp32-bath', '--room', '卫生间', '--every', '5']);
  assert.deepEqual(config.gateway, { host: '127.0.0.1', port: 9101 });
  assert.equal(config.deviceId, 'esp32-bath');
  assert.equal(config.room, '卫生间');
  assert.equal(config.everySec, 5);
});

test('CLI rejects malformed IDs, rooms, ports, intervals, unknown and duplicate options', () => {
  assert.throws(() => parseArgs(['--id', '../bad']), /--id/);
  assert.throws(() => parseArgs(['--id', '_leading-punctuation']), /--id/);
  assert.throws(() => parseArgs(['--room', ' 厨房']), /--room/);
  assert.throws(() => parseArgs(['--gw', '127.0.0.1:0']), /\[1, 65535\]/);
  assert.throws(() => parseArgs(['--gw', '::1:9100']), /IPv6|host:port/);
  assert.throws(() => parseArgs(['--every', '0']), /\[1, 3600\]/);
  assert.throws(() => parseArgs(['--other', 'x']), /unknown option/);
  assert.throws(() => parseArgs(['--room', '厨房', '--room', '卧室']), /duplicate option/);
  assert.throws(() => parseArgs(['--profile']), /missing value/);
  assert.deepEqual(parseGateway('[::1]:9100'), { host: '::1', port: 9100 });
});

test('profiles expose only their intended simulated sensors with millisecond timestamps', () => {
  const kitchen = new SimNodeState(parseArgs(['--profile', 'kitchen']), { now: () => NOW });
  const bedroom = new SimNodeState(parseArgs(['--profile', 'bedroom']), { now: () => NOW });
  const kitchenStatus = kitchen.snapshot();
  const bedroomStatus = bedroom.snapshot();
  assert.equal(String(kitchenStatus.ts).length, 13);
  assert.deepEqual(Object.keys(kitchenStatus.sensors), ['climate', 'gas', 'smoke']);
  assert.deepEqual(Object.keys(bedroomStatus.sensors), ['motion', 'door', 'climate']);
  assert.equal(kitchenStatus.sensors.motion, undefined);
  assert.equal(bedroomStatus.sensors.gas, undefined);
  assert.match(kitchen.statusLine(), /\n$/);
  assert.throws(() => kitchen.snapshot(1_700_000_000), /13-digit/);
});

test('alarm acknowledgement requires the exact current alarm ID', () => {
  const state = new SimNodeState(parseArgs(['--profile', 'kitchen']), { now: () => NOW });
  const alarm = state.handleCommand('smoke');
  assert.equal(alarm.accepted, true);
  assert.equal(state.handleCommand('ack').code, 'ALARM_ID_MISMATCH');
  assert.equal(state.handleCommand('ack old-id').code, 'ALARM_ID_MISMATCH');
  assert.equal(state.state, 'ALARM');
  assert.equal(state.handleCommand(`ack ${alarm.alarmId}`).code, 'ACKED');
  assert.equal(state.state, 'ACKED');
  assert.equal(state.handleCommand(`ack ${alarm.alarmId}`).code, 'NO_ACTIVE_ALARM');
});

test('motion updates activity without bypassing an active alarm', () => {
  const state = new SimNodeState(parseArgs(['--profile', 'bedroom']), { now: () => NOW });
  const alarm = state.handleCommand('sos', NOW);
  assert.equal(state.handleCommand('motion', NOW + 1).accepted, true);
  const snapshot = state.snapshot(NOW + 1);
  assert.equal(snapshot.state, 'ALARM');
  assert.equal(snapshot.alarm.id, alarm.alarmId);
  assert.equal(snapshot.sensors.motion.countToday, 1);
  assert.equal(snapshot.sensors.motion.lastActiveTs, NOW + 1);
});

test('alarm IDs are distinct across nodes even at the same millisecond and sequence', () => {
  const kitchen = new SimNodeState(parseArgs(['--profile', 'kitchen']), { now: () => NOW });
  const bedroom = new SimNodeState(parseArgs(['--profile', 'bedroom']), { now: () => NOW });
  const kitchenAlarm = kitchen.handleCommand('sos', NOW);
  const bedroomAlarm = bedroom.handleCommand('sos', NOW);
  assert.notEqual(kitchenAlarm.alarmId, bedroomAlarm.alarmId);
  assert.match(kitchenAlarm.alarmId, /^sim-[0-9a-f]{8}-\d{13}-1$/);
  assert.ok(kitchenAlarm.alarmId.length <= 80);
});

test('unsupported room capabilities cannot mutate alarm or motion state', () => {
  const kitchen = new SimNodeState(parseArgs(['--profile', 'kitchen']), { now: () => NOW });
  const bedroom = new SimNodeState(parseArgs(['--profile', 'bedroom']), { now: () => NOW });
  assert.equal(kitchen.handleCommand('motion').code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(kitchen.motionCount, 0);
  assert.equal(bedroom.handleCommand('smoke').code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(bedroom.state, 'NORMAL');
  assert.equal(bedroom.handleCommand('gaslight').code, 'UNKNOWN_COMMAND');
  assert.equal(bedroom.state, 'NORMAL');
});

test('software-only multi-room harness proves route state isolation', () => {
  const result = runScenario();
  assert.equal(result.ok, true);
  assert.equal(result.simulated, true);
  assert.equal(result.nodes, 2);
  assert.equal(Object.values(result.checks).every(Boolean), true);
});

test('kitchen and bedroom snapshots pass the real OneNET adapter', () => {
  const kitchen = new SimNodeState(parseArgs(['--profile', 'kitchen']), { now: () => NOW }).snapshot();
  const bedroom = new SimNodeState(parseArgs(['--profile', 'bedroom']), { now: () => NOW }).snapshot();
  const kitchenPost = toPropertyPost(kitchen, { id: '1', timestampMs: NOW });
  const bedroomPost = toPropertyPost(bedroom, { id: '2', timestampMs: NOW });
  assert.deepEqual(Object.keys(kitchenPost.params).sort(),
    ['alarm', 'deviceId', 'gas', 'humidity', 'online', 'room', 'smoke', 'state', 'temperature']);
  assert.deepEqual(Object.keys(bedroomPost.params).sort(),
    ['alarm', 'deviceId', 'door', 'humidity', 'motion', 'online', 'room', 'state', 'temperature']);
});

test('real socket completes status, alarm and exact ACK round-trip', async (t) => {
  const server = net.createServer();
  const sockets = new Set();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });

  const port = server.address().port;
  const states = [];
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const status = JSON.parse(line);
        states.push(status);
        if (status.state === 'NORMAL') socket.write('gas\n');
        if (status.state === 'ALARM') socket.write(`ack ${status.alarm.id} 已确认\n`);
      }
    });
  });

  const client = startClient(parseArgs(['--profile', 'kitchen', '--gw', `127.0.0.1:${port}`]), {
    reportIntervalMs: 20,
    reconnectDelayMs: 40,
    logger: { log() {}, error() {} }
  });
  t.after(() => client.close());
  const acked = await waitFor(() => states.find((status) => status.state === 'ACKED'), 'ACKED socket status');
  const normal = states.find((status) => status.state === 'NORMAL');
  const alarm = states.find((status) => status.state === 'ALARM');
  assert.equal(normal.deviceId, 'esp32-kitchen');
  assert.equal(String(normal.ts).length, 13);
  assert.equal(alarm.alarm.type, 'GAS');
  assert.equal(acked.alarm.id, alarm.alarm.id);
});

test('explicit close cancels an already scheduled reconnect', async (t) => {
  const server = net.createServer();
  const sockets = new Set();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });

  let connections = 0;
  server.on('connection', (socket) => {
    sockets.add(socket);
    connections += 1;
    socket.on('close', () => sockets.delete(socket));
    socket.destroy();
  });
  const logs = [];
  const port = server.address().port;
  const client = startClient(parseArgs(['--gw', `127.0.0.1:${port}`, '--every', '3600']), {
    reconnectDelayMs: 100,
    logger: { log(line) { logs.push(line); }, error() {} }
  });
  await waitFor(() => logs.some((line) => line.includes('后重连')), 'scheduled reconnect');
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(connections, 1);
});
