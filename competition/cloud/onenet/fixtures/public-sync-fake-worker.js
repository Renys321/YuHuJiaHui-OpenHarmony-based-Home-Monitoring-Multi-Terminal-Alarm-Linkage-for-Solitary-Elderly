'use strict';
/*
 * public-sync-fake-worker.js — 测试专用假 worker（MOCK）
 *
 * 只用于验证 public-sync-supervisor 的拉起/重启/有界熔断逻辑：
 * 收到 supervisor 通过 IPC 发来的 ingest-key 后先报 ready，再按
 * TEST_FAKE_WORKER_MODE 退出（exit1=异常退出、exit0=干净退出、stay=保持运行）。
 * 不连接任何 Broker / 后端，不读取、不记录任何真实密钥。
 */
const mode = process.env.TEST_FAKE_WORKER_MODE || 'exit1';

process.on('message', (message) => {
  if (!message || message.type !== 'ingest-key') return;
  if (process.connected) {
    try { process.send({ type: 'ready', pid: process.pid }); } catch (_) { /* supervisor 已退出 */ }
  }
  if (mode === 'stay') {
    setTimeout(() => process.exit(0), 8000);
    return;
  }
  setTimeout(() => process.exit(mode === 'exit0' ? 0 : 1), 5);
});

process.on('disconnect', () => process.exit(0));
