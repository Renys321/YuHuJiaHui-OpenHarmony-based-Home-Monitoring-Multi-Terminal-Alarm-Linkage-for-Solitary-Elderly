#!/usr/bin/env node
'use strict';

/**
 * southbound/comms-run.js — DAYU200 远程交流代理的命令行入口
 *
 * 用法（默认是**一次性运行**，绝不启动长期后台进程）：
 *   node southbound/comms-run.js --base-url http://127.0.0.1:8080 \
 *        --device-id dayu200-room-1 --ingest-key <内部设备密钥> [--dry-run] [--once]
 *
 * 参数：
 *   --base-url <url>     可信后端地址（必填）
 *   --device-id <id>     本机设备 ID（必填）
 *   --ingest-key <key>   内部设备密钥（必填；也可用环境变量 COMMS_INGEST_KEY，避免进命令行历史）
 *   --dry-run            不调用真实播放器，只走完整协议（无 HAP 时用于本地验证）
 *   --limit <n>          本次最多领取多少条（默认 5）
 *   --timeout <ms>       单次 HTTP 超时（默认 8000）
 *   --json               只输出一行 JSON 摘要
 *   --help
 *
 * 退出码：0 全部成功；2 部分失败；1 领取失败或配置错误；64 用法错误。
 *
 * 安全边界：
 *   - 不读取、不打印任何 openid/token/密钥；ingest key 只放进请求头，日志里被过滤；
 *   - 播放命令以 argv 数组传递，不经过 shell；
 *   - 本入口不驻留：没有 --watch 之类会长期运行的选项。
 */

const { runOnce, createAgentLogger } = require('./comms-agent');
const { createHdcPlayerRunner } = require('./hdc-player');

const EXIT = Object.freeze({ OK: 0, FAILED: 1, PARTIAL: 2, USAGE: 64 });

function usage() {
  return [
    'Usage:',
    '  node southbound/comms-run.js --base-url <url> --device-id <id> --ingest-key <key> [--dry-run] [--hdc <path>]',
    '',
    'Options:',
    '  --base-url <url>    trusted backend base URL (required)',
    '  --device-id <id>    this DAYU device id (required)',
    '  --ingest-key <key>  internal device key (or env COMMS_INGEST_KEY)',
    '  --dry-run           walk the protocol without invoking the real player',
    '  --hdc <path>        run aa on the only USB Connected DAYU through HDC',
    '  --limit <n>         max messages to claim in this run (default 5)',
    '  --timeout <ms>      per-request HTTP timeout (default 8000)',
    '  --json              print only one JSON summary line',
    '  --help',
    '',
    'This entry point is one-shot by design: it never starts a long-running service.'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { help: false, json: false, dryRun: false, limit: 5, timeoutMs: 8000 };
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const argument = String(list[index]);
    const next = () => String(list[index + 1] ?? '');
    switch (argument) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--base-url':
        options.baseUrl = next();
        index += 1;
        break;
      case '--device-id':
        options.deviceId = next();
        index += 1;
        break;
      case '--ingest-key':
        options.ingestKey = next();
        index += 1;
        break;
      case '--hdc':
        options.hdc = next();
        index += 1;
        break;
      case '--limit':
        options.limit = Number.parseInt(next(), 10);
        index += 1;
        break;
      case '--timeout':
        options.timeoutMs = Number.parseInt(next(), 10);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (options.help) return Object.freeze(options);
  if (typeof options.baseUrl !== 'string' || options.baseUrl.trim() === '') {
    throw new Error('--base-url is required');
  }
  if (!/^https?:\/\/[A-Za-z0-9._:-]+$/.test(options.baseUrl.trim())) {
    throw new Error('--base-url must be a plain http(s) origin');
  }
  if (typeof options.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(options.deviceId)) {
    throw new Error('--device-id must be 1-64 characters of [A-Za-z0-9._-]');
  }
  // ingest key 允许缺省：由 main() 再回退到环境变量，避免密钥进入命令行历史。
  if (options.ingestKey !== undefined && typeof options.ingestKey !== 'string') {
    throw new Error('--ingest-key must be a string');
  }
  if (options.hdc !== undefined && (typeof options.hdc !== 'string' || options.hdc === ''
      || options.hdc.includes('\0') || options.hdc.length > 1024)) {
    throw new Error('--hdc must be a valid executable path');
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20) {
    throw new Error('--limit must be in [1, 20]');
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60000) {
    throw new Error('--timeout must be in [100, 60000]');
  }
  return Object.freeze({
    ...options,
    baseUrl: options.baseUrl.trim(),
    deviceId: options.deviceId,
    ingestKey: typeof options.ingestKey === 'string' ? options.ingestKey : '',
    hdc: typeof options.hdc === 'string' ? options.hdc : ''
  });
}

/**
 * 退出码：
 *   - 领取阶段失败（网络/配置/鉴权）-> FAILED(1)：运维必须能感知"根本没拿到消息"；
 *   - 有待处理消息且全部成功 -> OK(0)；
 *   - 部分成功 -> PARTIAL(2)；全部失败 -> FAILED(1)。
 */
function exitCodeFor(summary) {
  const claimFailure = summary.failures.some((item) => item.stage === 'claim' || item.stage === 'config');
  if (claimFailure) return EXIT.FAILED;
  if (summary.claimed === 0) return EXIT.OK;
  if (summary.failed === 0) return EXIT.OK;
  if (summary.played > 0) return EXIT.PARTIAL;
  return EXIT.FAILED;
}

/**
 * @param {string[]} argv
 * @param {object}   env            环境变量（默认 process.env）
 * @param {object}   [streams]      { out, err } 可注入的输出流（测试用，默认 process.stdout/process.stderr）
 */
async function main(argv = process.argv.slice(2), env = process.env, streams = {}) {
  const out = streams.out && typeof streams.out.write === 'function' ? streams.out : process.stdout;
  const err = streams.err && typeof streams.err.write === 'function' ? streams.err : process.stderr;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err.write(`${error.message}\n${usage()}\n`);
    return EXIT.USAGE;
  }
  if (options.help) {
    out.write(`${usage()}\n`);
    return EXIT.OK;
  }

  const ingestKey = options.ingestKey || (typeof env.COMMS_INGEST_KEY === 'string' ? env.COMMS_INGEST_KEY : '');
  if (ingestKey === '') {
    err.write('--ingest-key is required (or set COMMS_INGEST_KEY)\n');
    return EXIT.USAGE;
  }
  const log = options.json ? () => {} : createAgentLogger((line) => out.write(`${line}\n`));
  const hdcCommand = options.hdc || (typeof env.COMMS_HDC === 'string' ? env.COMMS_HDC : '');

  const summary = await runOnce({
    baseUrl: options.baseUrl,
    deviceId: options.deviceId,
    ingestKey,
    limit: options.limit,
    httpTimeoutMs: options.timeoutMs,
    dryRun: options.dryRun,
    runPlayer: !options.dryRun && hdcCommand !== '' ? createHdcPlayerRunner({ hdcCommand }) : undefined,
    log
  });

  if (options.json) {
    // 摘要本身已不含密钥；再序列化一次即可。
    out.write(`${JSON.stringify({
      claimed: summary.claimed,
      delivered: summary.delivered,
      played: summary.played,
      failed: summary.failed,
      dryRun: summary.dryRun,
      failures: summary.failures
    })}\n`);
  } else if (summary.claimed === 0 && summary.failures.length > 0) {
    err.write(`claim failed: ${summary.failures.map((item) => item.code).join(',')}\n`);
  }

  // 诊断：把失败原因写到 stderr（只含稳定码与状态码，不含密钥或响应正文）。
  if (summary.failures.length > 0 && typeof env.COMMS_RUN_DEBUG === 'string') {
    err.write(`debug: ${JSON.stringify(summary.failures)}\n`);
  }

  return exitCodeFor(summary);
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      // 绝不回显可能含密钥的原始错误对象。
      process.stderr.write(`comms-run failed: ${error && error.name ? error.name : 'error'}\n`);
      process.exitCode = EXIT.FAILED;
    });
}

module.exports = { EXIT, usage, parseArgs, exitCodeFor, main };
