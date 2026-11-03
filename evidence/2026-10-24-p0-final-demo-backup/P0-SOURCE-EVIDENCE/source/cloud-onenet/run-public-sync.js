#!/usr/bin/env node
'use strict';
/*
 * run-public-sync.js —— 在用户可见终端里启动**唯一**的 public-sync 实例。
 *
 * 只做三件事：
 *   1) 单实例保护：已有存活实例时拒绝启动第二个（避免重复上传）；
 *   2) stdin 继承：public-sync 的隐藏输入需要真 TTY，绝不能走管道；
 *   3) stdout/stderr 双写：用户看得见，同时落盘到证据文件，便于取得 202/200 直接证据。
 *
 * 安全：本脚本不读取、不记录、不回显任何密钥；日志只包含 public-sync 自身输出
 *      （其中不含 INGEST_KEY、请求头、Token 或请求体）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const LOG_DIR = 'D:\\OpenHarmony\\competition\\evidence\\2026-10-15-public-sync-dual-device';
const LOG_FILE = path.join(LOG_DIR, 'public-sync.out.log');
const LOCK_FILE = path.join(LOG_DIR, 'public-sync.lock');

fs.mkdirSync(LOG_DIR, { recursive: true });

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

if (fs.existsSync(LOCK_FILE)) {
  const old = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
  if (Number.isSafeInteger(old) && old > 0 && pidAlive(old)) {
    console.error('[run-public-sync] 已有 public-sync 在运行（PID ' + old + '），拒绝启动第二个实例。');
    console.error('[run-public-sync] 如确需重启：先结束该进程，再删除 ' + LOCK_FILE);
    process.exit(2);
  }
  console.error('[run-public-sync] 清理过期锁文件（原 PID ' + old + ' 不存在）');
}

fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
const out = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const banner = '[run-public-sync] start ' + new Date().toISOString() + ' pid=' + process.pid +
  ' backend=https://api.luxunacc.xyz log=' + LOG_FILE + '\n';
process.stdout.write(banner);
out.write(banner);

const child = spawn(process.execPath, [path.join(ROOT, 'public-sync.js')], {
  cwd: ROOT,
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: false
});
child.stdout.on('data', function (d) { process.stdout.write(d); out.write(d); });
child.stderr.on('data', function (d) { process.stderr.write(d); out.write(d); });

function finish(code) {
  try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* 已删除 */ }
  out.end();
  process.exit(code === undefined || code === null ? 0 : code);
}
child.on('error', function (e) {
  const line = '[run-public-sync] spawn failed: ' + e.message + '\n';
  process.stdout.write(line); out.write(line);
  finish(1);
});
child.on('exit', function (code, signal) {
  const line = '[run-public-sync] public-sync exited code=' + code + ' signal=' + signal + '\n';
  process.stdout.write(line); out.write(line);
  setTimeout(function () { finish(code); }, 200);
});
process.on('SIGINT', function () { try { child.kill('SIGINT'); } catch (e) { /* 忽略 */ } });
