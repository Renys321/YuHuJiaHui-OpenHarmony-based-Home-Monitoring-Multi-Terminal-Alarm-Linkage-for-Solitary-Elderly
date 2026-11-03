'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { EvidenceStore } = require('../src/evidence-store');

const JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9]);
const JPEG_B = Buffer.from([0xff, 0xd8, 0xff, 0x02, 0xff, 0xd9]);

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('stores, binds, reloads and reads the exact JPEG', (t) => {
  const directory = temporary(t);
  let now = 1_800_000_000_000;
  const store = new EvidenceStore({ directory, now: () => now });
  const evidenceId = 'fall-1791609077775-7';
  const uploaded = store.upload(evidenceId, 'dayu200-living', JPEG_A);
  assert.equal(uploaded.created, true);
  assert.equal(uploaded.metadata.available, false);
  assert.equal(store.bind(evidenceId, 'dayu200-living', 'a-1-1'), true);

  now += 1000;
  const reloaded = new EvidenceStore({ directory, now: () => now });
  const alert = { alarmId: 'a-1-1', deviceId: 'dayu200-living', evidenceId };
  const content = reloaded.readForAlert(alert);
  assert.deepEqual(content.payload, JPEG_A);
  assert.equal(content.metadata.available, true);
  assert.equal(content.metadata.alarmId, 'a-1-1');
  assert(!JSON.stringify(content.metadata).includes(directory), 'public metadata must not expose server paths');
});

test('same payload is idempotent while conflicting content or binding is rejected', (t) => {
  const store = new EvidenceStore({ directory: temporary(t), now: () => 1_800_000_000_000 });
  const evidenceId = 'fall-1791609077775-na';
  assert.equal(store.upload(evidenceId, 'dayu200-living', JPEG_A).created, true);
  assert.equal(store.upload(evidenceId, 'dayu200-living', JPEG_A).created, false);
  assert.throws(() => store.upload(evidenceId, 'dayu200-living', JPEG_B), /conflict/);
  assert.throws(() => store.upload(evidenceId, 'other-device', JPEG_A), /conflict/);
  store.bind(evidenceId, 'dayu200-living', 'a-1-1');
  assert.throws(() => store.bind(evidenceId, 'dayu200-living', 'a-1-2'), /conflict/);
  assert.throws(() => store.bind(evidenceId, 'other-device', 'a-1-1'), /mismatch/);
});

test('rejects traversal, non-JPEG, wrong digest and oversized input', (t) => {
  const store = new EvidenceStore({ directory: temporary(t) });
  assert.throws(() => store.upload('../escape', 'dayu200-living', JPEG_A), /invalid evidence/);
  assert.throws(() => store.upload('fall-1-1', '../device', JPEG_A), /deviceId/);
  assert.throws(() => store.upload('fall-1-1', 'dayu200-living', Buffer.from('not jpeg')), /JPEG/);
  assert.throws(() => store.upload('fall-1-1', 'dayu200-living', JPEG_A, '0'.repeat(64)), /SHA-256/);
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0);
  assert.throws(() => store.upload('fall-1-1', 'dayu200-living', oversized), /size/);
});

test('retention removes the oldest file and expiration uses upload time', (t) => {
  let now = 1_800_000_000_000;
  const directory = temporary(t);
  const store = new EvidenceStore({ directory, maxEvents: 2, retentionMs: 60_000, now: () => now });
  store.upload('fall-1-1', 'dayu200-living', JPEG_A);
  now += 1;
  store.upload('fall-2-1', 'dayu200-living', JPEG_A);
  now += 1;
  store.upload('fall-3-1', 'dayu200-living', JPEG_A);
  assert.equal(fs.existsSync(path.join(directory, 'fall-1-1.jpg')), false);
  assert.equal(store.records.size, 2);
  store.bind('fall-3-1', 'dayu200-living', 'a-expiring');
  const alert = { alarmId: 'a-expiring', deviceId: 'dayu200-living', evidenceId: 'fall-3-1' };
  assert.equal(store.forAlert(alert).available, true);
  fs.writeFileSync(path.join(directory, 'unrelated.txt'), 'keep');
  fs.writeFileSync(path.join(directory, 'fall-4-1.jpg'), JPEG_A);
  now += 60_001;
  assert.equal(store.forAlert(alert), null, 'expired data must be denied before the periodic sweep');
  assert.equal(store.prune(now), 2);
  assert.equal(store.records.size, 0);
  assert.equal(fs.existsSync(path.join(directory, 'fall-4-1.jpg')), false, 'orphan JPEG cleanup');
  assert.equal(fs.existsSync(path.join(directory, 'unrelated.txt')), true, 'unknown files must not be removed');
});

test('detects JPEG tampering before serving or accepting a restart', (t) => {
  const directory = temporary(t);
  const evidenceId = 'fall-1791609077775-7';
  const store = new EvidenceStore({ directory, now: () => 1_800_000_000_000 });
  store.upload(evidenceId, 'dayu200-living', JPEG_A);
  store.bind(evidenceId, 'dayu200-living', 'a-1-1');
  fs.writeFileSync(path.join(directory, `${evidenceId}.jpg`), JPEG_B);
  const alert = { alarmId: 'a-1-1', deviceId: 'dayu200-living', evidenceId };
  assert.throws(() => store.readForAlert(alert), (error) => {
    assert.equal(error.code, 'EVIDENCE_STORAGE');
    assert.match(error.message, /integrity/);
    return true;
  });
  assert.throws(() => new EvidenceStore({ directory }), /integrity/);
});
