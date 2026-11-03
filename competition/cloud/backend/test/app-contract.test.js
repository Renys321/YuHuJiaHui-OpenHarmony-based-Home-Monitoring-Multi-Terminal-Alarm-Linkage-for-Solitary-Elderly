'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const contractPath = path.resolve(__dirname, '..', '..', '..', 'docs', 'APP-API-v1.json');

test('the frozen APP v1 contract is machine-readable and contains every mobile workflow', () => {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  assert.equal(contract.contract, 'eldercare-guardian-app');
  // 合同版本跟随 docs/APP-API-v1.md：
  // 1.1.0 = 处置结果/安全日志，1.2.0 = PIR 活动报告，1.3.0 = 健康资料 + 健康科普建议。
  assert.equal(contract.version, '1.3.0');
  assert.equal(contract.timeUnit, 'unix-milliseconds');
  const endpoints = new Set(contract.endpoints.map((item) => `${item.method} ${item.path}`));
  for (const endpoint of [
    'POST /api/v1/auth/app',
    'GET /api/v1/overview',
    'GET /api/v1/rooms',
    'GET /api/v1/devices',
    'GET /api/v1/alerts',
    'GET /api/v1/alerts/{alarmId}/evidence/content',
    'POST /api/v1/alerts/{alarmId}/ack',
    'GET /api/v1/contacts',
    'POST /api/v1/communications/messages',
    'GET /api/v1/communications/messages/{messageId}',
    // v1.1.0 增量：处置结果与持久安全日志
    'POST /api/v1/alerts/{alarmId}/dispositions',
    'GET /api/v1/alerts/{alarmId}/dispositions',
    'GET /api/v1/safety-logs?limit={1..200}&alarmId={alarmId}',
    // v1.2.0 增量：PIR 活动日/周/月报告
    'GET /api/v1/activity/report?scope={day|week|month}&date={YYYY-MM-DD}',
    // v1.3.0 增量：健康资料与 DeepSeek 健康科普建议
    'GET /api/v1/health-profile',
    'PUT /api/v1/health-profile',
    'POST /api/v1/health-advice'
  ]) {
    assert.ok(endpoints.has(endpoint), `missing contract endpoint: ${endpoint}`);
  }
  assert.deepEqual(contract.enums.communicationState,
    ['QUEUED', 'DELIVERED', 'PLAYED', 'ACKED', 'FAILED', 'EXPIRED']);
  assert.equal(contract.enums.voiceId.length, 5);
  assert.deepEqual(contract.enums.dispositionOutcome,
    ['CONTACTED_FAMILY', 'CONTACTED_COMMUNITY', 'ON_SITE_CONFIRMED_NORMAL', 'FALSE_ALARM', 'OTHER']);
  assert.deepEqual(contract.enums.activityScope, ['day', 'week', 'month']);
  assert.deepEqual(contract.enums.activityStatus, ['no_data', 'insufficient', 'partial', 'ok']);
  assert.deepEqual(contract.enums.healthTaste, ['light', 'normal', 'salty']);
  assert.equal(contract.versionHistory[contract.versionHistory.length - 1].version, '1.3.0');
});
