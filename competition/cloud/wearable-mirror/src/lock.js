'use strict';

/**
 * lock.js — 单实例锁（跨 Windows/PowerShell 与直接 node 启动）。
 *
 * 锁文件内容：{pid, startedAt, host}。启动时若发现锁文件存在且 pid 仍存活且不是自己，
 * 拒绝启动（避免两个镜像同时注入 relay 造成状态行交替/告警重复）。
 * 进程崩溃残留的锁（pid 不存活）会被安全接管。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 同一进程内重复 acquire 也必须被拒绝（否则测试/嵌入场景会出现两个实例） */
const heldByThisProcess = new Set();

function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

class InstanceLock {
  constructor(file) {
    this.file = file;
    this.held = false;
  }

  acquire() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (heldByThisProcess.has(this.file)) {
      const err = new Error(`another mirror instance is running in this process (${this.file})`);
      err.code = 'ELOCKED';
      throw err;
    }
    const existing = readLock(this.file);
    if (existing !== null && existing.pid !== process.pid && processAlive(existing.pid)) {
      const err = new Error(`another mirror instance is running (pid=${existing.pid}, startedAt=${existing.startedAt || '?'})`);
      err.code = 'ELOCKED';
      throw err;
    }
    const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: 'pc' });
    fs.writeFileSync(this.file, `${body}\n`, { encoding: 'utf8' });
    this.held = true;
    heldByThisProcess.add(this.file);
    return this;
  }

  release() {
    if (!this.held) return;
    this.held = false;
    heldByThisProcess.delete(this.file);
    try {
      const existing = readLock(this.file);
      if (existing !== null && existing.pid !== process.pid) return;
      fs.unlinkSync(this.file);
    } catch (err) { /* 已删除/无权限都不影响退出 */ }
  }
}

module.exports = Object.freeze({ InstanceLock, processAlive, readLock });
