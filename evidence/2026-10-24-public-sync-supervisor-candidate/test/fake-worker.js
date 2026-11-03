'use strict';
const fs = require('node:fs');

const mode = process.env.FAKE_WORKER_MODE || 'stay';
const resultFile = process.env.FAKE_WORKER_RESULT;
let keyReceived = false;
let keyLength = 0;

function record(extra = {}) {
  if (!resultFile) return;
  const row = {
    pid: process.pid,
    mode,
    keyReceived,
    keyLength,
    envIngestKey: Object.prototype.hasOwnProperty.call(process.env, 'INGEST_KEY'),
    argvLongSecret: process.argv.some((arg) => arg.length > 40),
    ...extra
  };
  try { fs.appendFileSync(resultFile, JSON.stringify(row) + '\n', 'utf8'); } catch (_) { /* ignore */ }
}

function finish(code, signal) {
  record({ exitCode: code, exitSignal: signal || null });
  if (signal) {
    try { process.kill(process.pid, signal); } catch (_) { process.exit(1); }
    return;
  }
  process.exit(code);
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'ingest-key' && !keyReceived) {
    keyReceived = true;
    keyLength = typeof message.value === 'string' ? message.value.length : 0;
    record({ event: 'key' });
    if (process.connected) process.send({ type: 'ready', pid: process.pid });
    if (mode === 'crash') setTimeout(() => finish(7), 30);
    else if (mode === 'normal') setTimeout(() => finish(0), 30);
    else if (mode === 'signal') setTimeout(() => finish(0, 'SIGTERM'), 30);
    else if (mode === 'no-ready') {
      record({ event: 'no-ready' });
      process.exit(1);
    }
    return;
  }
  if (message.type === 'shutdown') finish(0);
});
