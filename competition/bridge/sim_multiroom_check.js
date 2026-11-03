#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { SimNodeState, parseArgs } = require('./sim_node');

const BASE_TS = 1_791_920_000_000;

function runScenario() {
  const kitchen = new SimNodeState(parseArgs(['--profile', 'kitchen']), { now: () => BASE_TS });
  const bedroom = new SimNodeState(parseArgs(['--profile', 'bedroom']), { now: () => BASE_TS });

  const gas = kitchen.handleCommand('gas', BASE_TS);
  const kitchenAlarm = kitchen.snapshot(BASE_TS);
  const bedroomBefore = bedroom.snapshot(BASE_TS);
  const roomIsolation = gas.accepted && kitchenAlarm.state === 'ALARM' &&
    kitchenAlarm.alarm.type === 'GAS' && bedroomBefore.state === 'NORMAL';
  assert.equal(roomIsolation, true);

  const gasRejected = bedroom.handleCommand('gas', BASE_TS + 1).code === 'UNSUPPORTED_CAPABILITY';
  const motion = bedroom.handleCommand('motion', BASE_TS + 2);
  const capabilityIsolation = gasRejected && motion.accepted &&
    bedroom.snapshot(BASE_TS + 2).sensors.motion.countToday === 1 &&
    kitchen.snapshot(BASE_TS + 2).state === 'ALARM';
  assert.equal(capabilityIsolation, true);

  const wrongAckRejected = kitchen.handleCommand('ack wrong-id', BASE_TS + 3).code === 'ALARM_ID_MISMATCH' &&
    kitchen.snapshot(BASE_TS + 3).state === 'ALARM';
  const correctAckAccepted = kitchen.handleCommand(`ack ${gas.alarmId}`, BASE_TS + 4).accepted &&
    kitchen.snapshot(BASE_TS + 4).state === 'ACKED';
  const exactAlarmAck = wrongAckRejected && correctAckAccepted;
  assert.equal(exactAlarmAck, true);

  const millisecondTimestamps = String(kitchen.snapshot(BASE_TS + 4).ts).length === 13 &&
    String(bedroom.snapshot(BASE_TS + 4).ts).length === 13;
  assert.equal(millisecondTimestamps, true);

  return Object.freeze({
    ok: true,
    simulated: true,
    nodes: 2,
    checks: Object.freeze({
      roomIsolation,
      capabilityIsolation,
      exactAlarmAck,
      millisecondTimestamps
    })
  });
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runScenario()));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, simulated: true, code: 'SCENARIO_FAILED', message: error.message }));
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ runScenario });
