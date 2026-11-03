#!/usr/bin/env node
'use strict';

/**
 * probe-device.js — YED-M100MG-B1 4G/GNSS 串口接入诊断 CLI
 *
 * 默认（推荐）模式是 `--fixture`：无硬件、不开串口、可重复地回放构造夹具。
 * 真实串口必须显式：`--real --port <PORT>`（`--real` 与 `--port` 缺一不可）。
 *
 * 退出码：
 *   0  全部命令成功
 *   1  失败（用法错误、全部命令失败、或真实串口异常）
 *   2  部分成功（存在失败命令）
 *   64 用法错误
 *
 * 退出行为：无论成功、失败还是 Ctrl+C，都必须关闭串口、清空定时器与事件监听器。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  EXIT,
  parseArgs,
  usage,
  runFixtureProbe,
  runFailoverDemo,
  buildReport,
  exitCodeFor,
  renderReport,
  normalizeOutPath
} = require('./lib/probe-device-core');
const { SerialTransport, SerialTransportError } = require('./lib/transport');
const { probeDevice, readonlyCommands } = require('./lib/device');
const { safeJsonStringify } = require('./lib/privacy');

/** 只读命令序列：无 GNSS 时只取 4G 四项。 */
function commandsFor(options) {
  return [...readonlyCommands({ includeGnss: options.gnss !== false })];
}

/**
 * 夹具根目录：夹具固定在 `lib/fixtures/`，即 core 模块所在目录。
 * 不能用本文件所在的包根目录，否则会解析成 `<pkg>/fixtures/` 而全部 ENOENT。
 */
const FIXTURE_BASE_DIR = path.join(__dirname, 'lib');

/**
 * 真实串口模式：显式才进入。
 * 注意：本模式需要现场确认独立供电、共地、TX/RX 交叉与 TTL 电平；测试绝不会走到这里。
 */
async function runRealProbe(options) {
  const { SerialPort } = require('serialport');
  const transport = new SerialTransport(
    {
      port: options.port,
      baudRate: options.baudRate,
      commandTimeoutMs: options.timeoutMs,
      retries: options.retries,
      // DTU 回包无 OK/ERROR 终止符，靠静默窗口收尾；主动关闭后不得自动重连。
      quietMs: 250,
      autoReconnect: false
    },
    {
      createSerial: (serialOptions) =>
        new SerialPort({
          ...serialOptions,
          autoOpen: false
        })
    }
  );

  const result = { mode: 'real', fixtureFile: null, commands: commandsFor(options), samples: [] };
  await transport.open();
  try {
    for (let index = 0; index < options.samples; index += 1) {
      const sample = await probeDevice({
        transport,
        commands: result.commands,
        commandTimeoutMs: options.timeoutMs,
        retries: options.retries
      });
      result.samples.push(sample);
    }
  } finally {
    // 必须主动断开：清串口、清定时器、清监听器。
    await transport.disconnect();
  }
  return result;
}

function writeOutput(text, outPath) {
  if (outPath) {
    fs.writeFileSync(outPath, `${text}\n`, { encoding: 'utf8', flag: 'w' });
    process.stdout.write(`Report written to ${outPath}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write(`${usage()}\n`);
    return EXIT.USAGE;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return EXIT.OK;
  }

  const outPath = options.out ? normalizeOutPath(options.out, process.cwd()) : null;
  if (outPath) {
    const directory = path.dirname(outPath);
    if (!fs.existsSync(directory)) {
      process.stderr.write('output directory does not exist\n');
      return EXIT.USAGE;
    }
  }

  if (options.failoverDemo) {
    const report = runFailoverDemo(options);
    writeOutput(renderReport(report, options.pretty), outPath);
    return EXIT.OK;
  }

  const failures = [];
  let probeResult;
  try {
    probeResult =
      options.mode === 'real' ? await runRealProbe(options) : await runFixtureProbe(options, FIXTURE_BASE_DIR);
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'PROBE_FAILED';
    const message = error instanceof SerialTransportError || error instanceof Error ? error.message : 'probe failed';
    failures.push({ stage: options.mode === 'real' ? 'real-serial' : 'fixture', code, message });
    const report = buildReport({
      options,
      probeResult: { mode: options.mode, fixtureFile: null, commands: commandsFor(options), samples: [] },
      failures
    });
    writeOutput(renderReport(report, options.pretty), outPath);
    return options.mode === 'real' ? EXIT.FAILED : EXIT.FAILED;
  }

  const report = buildReport({ options, probeResult, failures });
  writeOutput(renderReport(report, options.pretty), outPath);
  return exitCodeFor(report);
}

/** Ctrl+C：走同一个 finally 清理路径，不留串口与定时器。 */
function installSignalHandlers() {
  let interrupted = false;
  const handler = (signal) => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write(`\nReceived ${signal}; cleaning up.\n`);
    process.exitCode = 130;
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

if (require.main === module) {
  installSignalHandlers();
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const code = error && typeof error.code === 'string' ? error.code : 'PROBE_FAILED';
      process.stderr.write(`${safeJsonStringify({ error: { code, message: error && error.message } })}\n`);
      process.exitCode = EXIT.FAILED;
    });
}

module.exports = { main, commandsFor, runRealProbe };
