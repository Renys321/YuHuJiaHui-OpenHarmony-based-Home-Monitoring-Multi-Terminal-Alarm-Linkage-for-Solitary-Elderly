'use strict';

/*
 * Exactly one public-sync worker.
 * Receives INGEST_KEY through Node IPC only; never env/argv/files/logs.
 * Exits when the supervisor's IPC channel disconnects, so a killed supervisor
 * cannot leave an orphan worker that would duplicate backend ingestion.
 */
const { main } = require(process.env.PUBLIC_SYNC_ENTRY ||
  'D:\\OpenHarmony\\competition\\cloud\\onenet\\public-sync.js');

let key = '';
let started = false;
let stopping = false;
let gateway = null;

function send(message) {
  if (process.connected) {
    try { process.send(message); } catch (_) { /* supervisor gone */ }
  }
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  key = '';
  // Best-effort graceful stop so MQTT/HTTP clients are closed. A stuck close
  // must not keep the worker alive after its supervisor is gone.
  const force = setTimeout(() => process.exit(0), 3000);
  try {
    if (gateway && typeof gateway.stop === 'function') {
      await gateway.stop(reason);
    }
  } catch (_) {
    /* ignore shutdown errors */
  } finally {
    clearTimeout(force);
  }
  process.exit(0);
}

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'ingest-key' && !started) {
    started = true;
    key = typeof message.value === 'string' ? message.value : '';
    try {
      gateway = await main({ ingestKey: key });
      key = '';
      send({ type: 'ready', pid: process.pid });
    } catch (error) {
      key = '';
      send({ type: 'worker-fatal', code: error && error.code ? error.code : 'START_FAILED' });
      process.exit(1);
    }
    return;
  }

  if (message.type === 'shutdown') {
    void shutdown('SUPERVISOR_SHUTDOWN');
  }
});

process.on('disconnect', () => {
  void shutdown('SUPERVISOR_DISCONNECT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
