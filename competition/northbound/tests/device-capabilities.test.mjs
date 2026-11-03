import assert from 'node:assert/strict';
import test from 'node:test';

import { DeviceCapabilities } from '../entry/src/main/ets/model/DeviceCapabilities.ts';

test('living room exposes camera/PIR/door/climate but not MQ gas/smoke', () => {
  const c = DeviceCapabilities.forDevice('dayu200-living');
  assert.equal(c.known, true);
  assert.equal(c.motion, true);
  assert.equal(c.door, true);
  assert.equal(c.climate, true);
  assert.equal(c.camera, true);
  assert.equal(c.gas, false);
  assert.equal(c.smoke, false);
});

test('kitchen ignores compatible motion/door placeholders and keeps MQ ADC with alarm disabled', () => {
  const c = DeviceCapabilities.forDevice('esp32-kitchen');
  assert.equal(c.known, true);
  assert.equal(c.motion, false);
  assert.equal(c.door, false);
  assert.equal(c.camera, false);
  assert.equal(c.water, false);
  assert.equal(c.gas, true);
  assert.equal(c.smoke, true);
  assert.equal(c.mqAlarmEnabled, false);
});

test('bathroom has PIR/SOS but no gas, smoke, door, camera or water', () => {
  const c = DeviceCapabilities.forDevice('esp32-bath');
  assert.equal(c.known, true);
  assert.equal(c.motion, true);
  assert.equal(c.sos, true);
  assert.equal(c.gas, false);
  assert.equal(c.smoke, false);
  assert.equal(c.door, false);
  assert.equal(c.camera, false);
  assert.equal(c.water, false);
});

test('unknown device is conservative: no sensor capability and known=false', () => {
  const c = DeviceCapabilities.forDevice('esp32-unknown');
  assert.equal(c.known, false);
  assert.equal(c.motion, false);
  assert.equal(c.door, false);
  assert.equal(c.climate, false);
  assert.equal(c.gas, false);
  assert.equal(c.smoke, false);
  assert.equal(c.camera, false);
  assert.equal(c.sos, false);
  assert.equal(c.water, false);
  assert.equal(c.mqAlarmEnabled, false);
});

test('legacy living alias maps to the same capabilities, not room-name guessing', () => {
  const legacy = DeviceCapabilities.forDevice('dayu200-01');
  assert.equal(legacy.known, true);
  assert.equal(legacy.camera, true);
  assert.equal(legacy.motion, true);
  assert.equal(DeviceCapabilities.forDevice('厨房').known, false);
});
