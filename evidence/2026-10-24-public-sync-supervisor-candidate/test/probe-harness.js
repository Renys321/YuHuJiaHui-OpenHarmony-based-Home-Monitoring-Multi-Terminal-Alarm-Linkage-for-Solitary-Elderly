'use strict';

/*
 * Probe harness: runs the real supervisor + real worker against a local stub
 * public-sync entry (no network, no devices, no key). The orchestrator
 * (lifecycle-probe.js) kills this process to simulate an external kill.
 */
const path = require('node:path');
const fs = require('node:fs');
const { PublicSyncSupervisor } = require(path.join(__dirname, '..', 'public-sync-supervisor.js'));

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node probe-harness.js <runtime-dir>');
  process.exit(64);
}
fs.mkdirSync(dir, { recursive: true });

const supervisor = new PublicSyncSupervisor({
  publicSyncEntry: path.join(__dirname, 'probe-stub-public-sync.js'),
  workerScript: path.join(__dirname, '..', 'public-sync-worker.js'),
  stateFile: path.join(dir, 'state.json'),
  lockFile: path.join(dir, 'lock'),
  logFile: path.join(dir, 'supervisor.log'),
  heartbeatMs: 1000,
  readKey: async () => 'PROBE_ONLY_KEY_NOT_A_SECRET'
});

supervisor.start().then((ok) => {
  if (!ok) {
    console.error('harness: supervisor start refused');
    process.exit(2);
  }
}).catch((error) => {
  console.error(`harness: ${error && error.message}`);
  process.exit(1);
});
