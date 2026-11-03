'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const prof = fs.readFileSync(path.join(__dirname, '..', 'profiles', 'bathroom.sdkconfig.defaults'), 'utf8');
function val(key) {
  const m = prof.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim() : undefined;
}

test('bathroom 身份与正式引脚', () => {
  assert.equal(val('CONFIG_NODE_ID'), '"esp32-bath"');
  assert.equal(val('CONFIG_NODE_ROOM'), '"卫生间"');
  assert.equal(val('CONFIG_NODE_MOTION_GPIO'), '36');
  // Accepted bathroom wiring moved SOS to GPIO15; GPIO35 is the old profile.
  assert.equal(val('CONFIG_NODE_SOS_GPIO'), '15');
  /* 水漏本轮不做，明天启用只需把该行改为 37（代码与主机测试已就绪） */
  assert.equal(val('CONFIG_NODE_WATER_GPIO'), '-1');
  assert.equal(val('CONFIG_NODE_I2C_SDA_GPIO'), '4');
  assert.equal(val('CONFIG_NODE_I2C_SCL_GPIO'), '5');
  assert.equal(val('CONFIG_NODE_BUZZER_XL9555'), 'y');
  assert.equal(val('CONFIG_NODE_BOOT_BEEP_MS'), '0');
  assert.equal(val('CONFIG_NODE_NO_MOTION_SEC'), '1800');
});

test('bathroom 禁用 MQ 与门磁', () => {
  assert.equal(val('CONFIG_NODE_MQ2_ADC_CHANNEL'), '-1');
  assert.equal(val('CONFIG_NODE_MQ5_ADC_CHANNEL'), '-1');
  assert.equal(val('CONFIG_NODE_DOOR_GPIO'), '-1');
});

test('bathroom 不覆盖 kitchen 配置', () => {
  const k = fs.readFileSync(path.join(__dirname, '..', 'profiles', 'kitchen.sdkconfig.defaults'), 'utf8');
  assert.ok(k.indexOf('CONFIG_NODE_ID="esp32-kitchen"') >= 0);
  assert.ok(k.indexOf('CONFIG_NODE_MQ2_ADC_CHANNEL=5') >= 0);
  assert.ok(k.indexOf('CONFIG_NODE_MQ5_ADC_CHANNEL=8') >= 0);
  assert.ok(k.indexOf('CONFIG_NODE_MQ2_ALARM_RAW=4096') >= 0);
  assert.ok(k.indexOf('CONFIG_NODE_MQ5_ALARM_RAW=4096') >= 0);
});
