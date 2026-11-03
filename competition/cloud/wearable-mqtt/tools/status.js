#!/usr/bin/env node
'use strict';

/**
 * tools/status.js — 诊断 CLI（零依赖）。
 *
 * 用法：
 *   node tools/status.js                       # 读 http://127.0.0.1:8099/status
 *   node tools/status.js --url http://127.0.0.1:8099/status
 *   node tools/status.js --health              # 只看 /healthz（退出码 0/1）
 *   node tools/status.js --raw                 # 原样输出 JSON（默认带缩进）
 *
 * 只读本地回环诊断端口；不读取任何密钥，也不会把响应写进文件。
 */

const http = require('node:http');
const https = require('node:https');

function usage() {
  return [
    'usage: node tools/status.js [--url URL] [--health] [--raw] [--timeout MS]',
    '',
    '  --url URL     诊断地址（默认 http://127.0.0.1:8099/status）',
    '  --health      请求 /healthz，仅以退出码表达健康状态',
    '  --raw         紧凑输出 JSON（默认 2 空格缩进）',
    '  --timeout MS  请求超时（默认 3000）'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { url: 'http://127.0.0.1:8099/status', health: false, raw: false, timeoutMs: 3000, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    switch (arg) {
      case '--url': options.url = next(); break;
      case '--health': options.health = true; break;
      case '--raw': options.raw = true; break;
      case '--timeout': options.timeoutMs = Number.parseInt(next(), 10); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  if (options.help) return options;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60000) {
    throw new Error('--timeout must be an integer in [100, 60000]');
  }
  const parsed = new URL(options.url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('--url must use http or https');
  if (options.health) parsed.pathname = '/healthz';
  options.parsedUrl = parsed;
  return options;
}

function fetchJson(parsedUrl, timeoutMs) {
  const transport = parsedUrl.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'GET',
      timeout: timeoutMs,
      headers: { accept: 'application/json' }
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.destroy();
          reject(new Error('response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* 保留 text 供 --health 判定 */
        }
        resolve({ statusCode: response.statusCode, text, json });
      });
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('request timed out'));
    });
    request.end();
  });
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  let response;
  try {
    response = await fetchJson(options.parsedUrl, options.timeoutMs);
  } catch (error) {
    process.stderr.write(`status request failed: ${error.code || error.message}\n`);
    return 1;
  }
  if (options.health) {
    const healthy = response.statusCode === 200 && response.json && response.json.ok === true;
    process.stdout.write(`${healthy ? 'healthy' : 'unhealthy'} status=${response.statusCode}\n`);
    return healthy ? 0 : 1;
  }
  if (response.json === null) {
    process.stderr.write(`status endpoint returned non-JSON status=${response.statusCode}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(response.json, null, options.raw ? 0 : 2)}\n`);
  return response.statusCode === 200 ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`fatal: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ parseArgs, fetchJson, main, usage });
