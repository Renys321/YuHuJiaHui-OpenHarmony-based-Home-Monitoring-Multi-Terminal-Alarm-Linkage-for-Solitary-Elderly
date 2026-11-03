'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, publicSummary, DEFAULTS } = require('../src/config');

function env(overrides = {}) {
  return { ...DEFAULTS, ...overrides };
}

test('默认配置是 local 模式，端口 9443，连 127.0.0.1:9301', () => {
  const config = loadConfig(env());
  assert.equal(config.mode, 'local');
  assert.equal(config.relayPort, 9443);
  assert.equal(config.relayHost, '0.0.0.0');
  assert.equal(config.dayuHost, '127.0.0.1');
  assert.equal(config.dayuPort, 9301);
  assert.equal(config.maxViewers, 2);
  assert.equal(config.idleStopMs, 3000);
  assert.equal(config.ticketTtlMs, 60000);
  assert.equal(config.dayuDownGraceMs, 30000);
  assert.deepEqual(config.reconnectDelaysMs, [500, 1000, 2000, 5000, 10000]);
});

test('有 VIDEO_AGENT_KEY 但未显式指定 VIDEO_MODE 时推断为 agent', () => {
  const config = loadConfig(env({ VIDEO_AGENT_KEY: 'k'.repeat(32) }));
  assert.equal(config.mode, 'agent');
  assert.equal(config.agentKey, 'k'.repeat(32));
});

test('显式 VIDEO_MODE=local 优先于 agent key（两者不同时活动）', () => {
  const config = loadConfig(env({ VIDEO_MODE: 'local', VIDEO_AGENT_KEY: 'k'.repeat(32) }));
  assert.equal(config.mode, 'local');
});

test('agent 模式缺少 VIDEO_AGENT_KEY 时拒绝启动', () => {
  assert.throws(() => loadConfig(env({ VIDEO_MODE: 'agent' })), /VIDEO_AGENT_KEY is required/);
});

test('非法 VIDEO_MODE / 端口 / 数值都会 fail-fast', () => {
  assert.throws(() => loadConfig(env({ VIDEO_MODE: 'bridge' })), /VIDEO_MODE/);
  assert.throws(() => loadConfig(env({ VIDEO_RELAY_PORT: 'abc' })), /VIDEO_RELAY_PORT/);
  assert.throws(() => loadConfig(env({ VIDEO_RELAY_PORT: '70000' })), /VIDEO_RELAY_PORT/);
  assert.throws(() => loadConfig(env({ VIDEO_MAX_VIEWERS: '0' })), /VIDEO_MAX_VIEWERS/);
  assert.throws(() => loadConfig(env({ VIDEO_RECONNECT_DELAYS_MS: '500,abc' })), /VIDEO_RECONNECT_DELAYS_MS/);
  assert.throws(() => loadConfig(env({ BACKEND_BASE: 'ftp://x' })), /http or https/);
  assert.throws(() => loadConfig(env({ VIDEO_LOG_LEVEL: 'verbose' })), /VIDEO_LOG_LEVEL/);
});

test('可覆盖端口 / 并发 / 空闲停止 / ticket TTL / 退避序列', () => {
  const config = loadConfig(env({
    VIDEO_RELAY_HOST: '127.0.0.1',
    VIDEO_RELAY_PORT: '0',
    VIDEO_MAX_VIEWERS: '1',
    VIDEO_IDLE_STOP_MS: '250',
    VIDEO_TICKET_TTL_MS: '100',
    VIDEO_RECONNECT_DELAYS_MS: '10,20',
    VIDEO_ACCESS_LOG: '0'
  }));
  assert.equal(config.relayPort, 0);
  assert.equal(config.maxViewers, 1);
  assert.equal(config.idleStopMs, 250);
  assert.equal(config.ticketTtlMs, 100);
  assert.deepEqual(config.reconnectDelaysMs, [10, 20]);
  assert.equal(config.accessLog, false);
});

test('publicSummary 不包含 agent key', () => {
  const secret = 'super-secret-agent-key-0123456789';
  const config = loadConfig(env({ VIDEO_MODE: 'agent', VIDEO_AGENT_KEY: secret }));
  const summary = JSON.stringify(publicSummary(config));
  assert.equal(summary.includes(secret), false);
  assert.equal(summary.includes('super-secret'), false);
  assert.equal(JSON.parse(summary).mode, 'agent');
});
