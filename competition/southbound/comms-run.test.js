'use strict';

/**
 * southbound/comms-run.test.js — 交流代理 CLI 的参数校验与退出码测试
 *
 * 覆盖：必填项、格式校验、拒绝未知参数、--help、退出码映射，
 * 以及 --json 输出里不出现 ingest key。全程不打真实后端。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { EXIT, usage, parseArgs, exitCodeFor } = require('./comms-run');

test('usage mentions the one-shot design and never a long-running mode', () => {
  const text = usage();
  assert.match(text, /one-shot/);
  assert.match(text, /never starts a long-running service/);
  assert.equal(/--watch|--daemon|--interval/.test(text), false, 'CLI 不得提供长期驻留选项');
});

test('required arguments are enforced', () => {
  assert.throws(() => parseArgs([]), /--base-url is required/);
  assert.throws(() => parseArgs(['--base-url', 'http://127.0.0.1:8080']), /--device-id/);
  // ingest key 允许缺省：由 main() 回退到环境变量，便于把密钥移出命令行历史。
  assert.equal(parseArgs(['--base-url', 'http://127.0.0.1:8080', '--device-id', 'dayu200-room-1']).ingestKey, '');
});

test('argument formats are validated', () => {
  const base = ['--base-url', 'http://127.0.0.1:8080', '--device-id', 'dayu200-room-1', '--ingest-key', 'key-value-1234'];
  assert.equal(parseArgs(base).deviceId, 'dayu200-room-1');
  assert.equal(parseArgs([...base, '--dry-run']).dryRun, true);
  assert.equal(parseArgs([...base, '--json']).json, true);
  assert.equal(parseArgs([...base, '--hdc', 'D:\\tools\\hdc.exe']).hdc, 'D:\\tools\\hdc.exe');

  const badUrl = (value) => parseArgs(['--base-url', value, '--device-id', 'dayu200-room-1', '--ingest-key', 'key-value-1234']);
  assert.throws(() => badUrl('http://x/y/z'), /plain http/);
  assert.throws(() => badUrl('not-a-url'), /plain http/);
  assert.throws(() => badUrl('ftp://127.0.0.1'), /plain http/);
  assert.throws(() => parseArgs(['--base-url', base[1], '--device-id', 'bad device', ...base.slice(4)]), /device-id/);
  assert.throws(() => parseArgs(['--base-url', base[1], '--device-id', '../escape', ...base.slice(4)]), /device-id/);
  assert.throws(() => parseArgs([...base, '--limit', '0']), /--limit/);
  assert.throws(() => parseArgs([...base, '--limit', '99']), /--limit/);
  assert.throws(() => parseArgs([...base, '--timeout', '5']), /--timeout/);
  assert.throws(() => parseArgs([...base, '--hdc', '']), /--hdc/);
  assert.throws(() => parseArgs([...base, '--watch']), /unknown argument/);
  assert.throws(() => parseArgs([...base, '--daemon']), /unknown argument/);
});

test('--help short-circuits without requiring other arguments', () => {
  const options = parseArgs(['--help']);
  assert.equal(options.help, true);
  const withOthers = parseArgs(['--base-url', 'http://127.0.0.1:8080', '--help']);
  assert.equal(withOthers.help, true);
});

test('exit codes express success, partial failure, claim failure and total failure', () => {
  assert.equal(exitCodeFor({ claimed: 0, played: 0, failed: 0, failures: [] }), EXIT.OK, '没有待处理消息是成功');
  assert.equal(exitCodeFor({ claimed: 1, played: 1, failed: 0, failures: [] }), EXIT.OK);
  assert.equal(exitCodeFor({ claimed: 2, played: 1, failed: 1, failures: [] }), EXIT.PARTIAL);
  assert.equal(exitCodeFor({ claimed: 2, played: 0, failed: 2, failures: [] }), EXIT.FAILED);
  // 领取阶段失败必须是非零：运维要能感知"根本没拿到消息"。
  assert.equal(exitCodeFor({ claimed: 0, played: 0, failed: 0, failures: [{ stage: 'claim', code: 'CLAIM_FAILED' }] }), EXIT.FAILED);
  assert.equal(exitCodeFor({ claimed: 0, played: 0, failed: 0, failures: [{ stage: 'config', code: 'AGENT_NOT_CONFIGURED' }] }), EXIT.FAILED);
  assert.equal(EXIT.USAGE, 64);
});

test('the parsed options never echo the ingest key back in an error message', () => {
  const secret = 'SUPER-SECRET-INGEST-KEY-VALUE';
  try {
    parseArgs(['--base-url', 'http://127.0.0.1:8080', '--device-id', 'bad device', '--ingest-key', secret]);
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(String(error.message).includes(secret), false);
  }
});
