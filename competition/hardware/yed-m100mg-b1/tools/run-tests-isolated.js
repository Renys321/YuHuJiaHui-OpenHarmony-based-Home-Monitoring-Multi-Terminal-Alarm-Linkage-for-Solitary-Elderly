'use strict';

/**
 * tools/run-tests-isolated.js — 逐个测试文件运行并强制超时
 *
 * 为什么需要：`node --test <dir>` 只要有一个测试文件挂住，整个 runner 会无限等待，
 * 无法定位问题文件。本脚本对每个 *.test.js 单独 spawn 一个子进程，超时即杀，
 * 并汇总每个文件的 pass / fail / 超时结论。
 *
 * 用法：
 *   node tools/run-tests-isolated.js [--timeout-ms 60000] [--json]
 *
 * 安全边界：只运行仓库内测试，不访问串口、不联网、不安装依赖。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'out', 'dist']);

function parseArgs(argv) {
  const options = { timeoutMs: 60000, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    }
  }
  return options;
}

function findTestFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

function runFile(file, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', file], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ file, status: 'ERROR', code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        file,
        status: timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL',
        code,
        stdout,
        stderr,
        timedOut
      });
    });
  });
}

/** 从 node:test TAP 输出里取计数。 */
function parseCounts(text) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = new RegExp(`^[^\\S\\r\\n]*[\\u2139#]?\\s*${key}\\s+(\\d+)`, 'm').exec(text);
    if (match) counts[key] = Number(match[1]);
  }
  return counts;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = findTestFiles(ROOT).sort();
  const results = [];

  for (const file of files) {
    const result = await runFile(file, options.timeoutMs);
    const counts = parseCounts(`${result.stdout}\n${result.stderr}`);
    results.push({ ...result, counts });
    if (!options.json) {
      const relative = path.relative(ROOT, file);
      process.stdout.write(
        `${result.status.padEnd(8)} ${relative.padEnd(44)} tests=${counts.tests ?? '?'} pass=${
          counts.pass ?? '?'
        } fail=${counts.fail ?? '?'}\n`
      );
      if (result.status !== 'PASS') {
        const tail = (result.stderr || result.stdout).split(/\r?\n/).slice(-25).join('\n');
        process.stdout.write(`---- ${relative} output tail ----\n${tail}\n------------------------------\n`);
      }
    }
  }

  const summary = {
    timeoutMs: options.timeoutMs,
    files: results.length,
    pass: results.filter((item) => item.status === 'PASS').length,
    fail: results.filter((item) => item.status === 'FAIL').length,
    timeout: results.filter((item) => item.status === 'TIMEOUT').length,
    error: results.filter((item) => item.status === 'ERROR').length,
    totalTests: results.reduce((sum, item) => sum + (item.counts.tests || 0), 0),
    totalPass: results.reduce((sum, item) => sum + (item.counts.pass || 0), 0),
    totalFail: results.reduce((sum, item) => sum + (item.counts.fail || 0), 0),
    results: results.map((item) => ({
      file: path.relative(ROOT, item.file),
      status: item.status,
      code: item.code,
      counts: item.counts
    }))
  };

  if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    process.stdout.write(
      `\nSUMMARY files=${summary.files} pass=${summary.pass} fail=${summary.fail} timeout=${summary.timeout} ` +
        `tests=${summary.totalTests} passed=${summary.totalPass} failed=${summary.totalFail}\n`
    );
  }
  process.exitCode = summary.fail + summary.timeout + summary.error > 0 ? 1 : 0;
}

main();
