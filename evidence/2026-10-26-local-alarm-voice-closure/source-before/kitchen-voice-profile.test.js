'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function profile(name) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'profiles', name + '.sdkconfig.defaults'), 'utf8');
  return Object.fromEntries([...text.matchAll(/^(CONFIG_\w+)=(.*)$/gm)].map(m => [m[1], m[2].trim()]));
}
test('kitchen rewire keeps both ADC sensors and reserves actual audio pins', () => {
  const frozen = profile('kitchen');
  const wiring = profile('kitchen-voice-rewire');
  const candidate = {...frozen, ...profile('voice-candidate'), ...wiring};
  assert.equal(frozen.CONFIG_NODE_MQ5_ADC_CHANNEL, '8');
  assert.deepEqual(Object.keys(wiring), ['CONFIG_NODE_MQ5_ADC_CHANNEL']);
  assert.equal(candidate.CONFIG_NODE_VOICE_ENABLED, 'y');
  assert.equal(candidate.CONFIG_NODE_MQ2_ADC_CHANNEL, '5');
  assert.equal(candidate.CONFIG_NODE_MQ5_ADC_CHANNEL, '6');
  const adcPins = [Number(candidate.CONFIG_NODE_MQ2_ADC_CHANNEL) + 1, Number(candidate.CONFIG_NODE_MQ5_ADC_CHANNEL) + 1];
  assert.equal(new Set(adcPins).size, 2);
  for (const pin of adcPins) {
    assert.ok(![3, 9, 10, 46, Number(candidate.CONFIG_NODE_I2C_SDA_GPIO), Number(candidate.CONFIG_NODE_I2C_SCL_GPIO)].includes(pin));
  }
  assert.equal(candidate.CONFIG_NODE_MQ2_ALARM_RAW, '4096');
  assert.equal(candidate.CONFIG_NODE_MQ5_ALARM_RAW, '4096');
  assert.equal(candidate.CONFIG_NODE_ID, '"esp32-kitchen"');
});
