'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MemoryStore, normalizeStatus } = require('../src/store');

function status(overrides = {}) {
  return {
    deviceId: 'dayu200-living', room: '客厅', state: 'ALARM', ts: 1791609077775,
    alarm: { id: 'a-first', type: 'FALL', countToday: 1, evidenceId: 'fall-1791609077775-7' },
    ...overrides
  };
}

test('invalid evidence, device collisions and rebindings do not partially mutate memory', () => {
  const store = new MemoryStore();
  store.ingest(status());
  const before = JSON.stringify({ devices: store.listDevices(), alerts: store.listAlerts() });
  for (const bad of [
    status({ deviceId: 'other-device' }),
    status({ state: 'ACKED', deviceId: 'other-device' }),
    status({ alarm: { id: 'a-first', type: 'FALL', evidenceId: 'fall-1791609077776-8' } }),
    status({ alarm: { id: 'a-second', type: 'FALL', evidenceId: 'fall-1791609077775-7' } })
  ]) {
    assert.throws(() => store.ingest(bad), /another|conflict/);
    assert.equal(JSON.stringify({ devices: store.listDevices(), alerts: store.listAlerts() }), before);
  }
  assert.throws(() => normalizeStatus(status({ alarm: { id: 'a-first', type: 'FALL', evidenceId: 123 } })), /evidence/);
  assert.throws(() => normalizeStatus(status({ alarm: { id: 'a-first', type: 'GAS', evidenceId: 'fall-1-7' } })), /FALL/);
});
