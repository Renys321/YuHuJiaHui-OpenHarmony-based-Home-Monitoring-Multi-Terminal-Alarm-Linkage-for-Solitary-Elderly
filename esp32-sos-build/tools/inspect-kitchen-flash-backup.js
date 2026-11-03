'use strict';
// Inspect a private Flash backup without decoding credentials or dumping bytes.
// Generated rollback images stay beside the private backup, outside evidence.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = path.resolve(__dirname, '../.local/speaker-backup-2026-10-26-com5');
const backupPath = path.join(dir, 'flash-before.bin');
const flash = fs.readFileSync(backupPath);
if (flash.length !== 0x1000000) throw new Error('Full 16 MiB backup is not complete');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const table = flash.subarray(0x8000, 0x9000);
const partitions = [];
let md5Verified = false;
for (let n = 0; n < table.length; n += 32) {
  const magic = table.readUInt16LE(n);
  if (magic === 0xffff) break;
  if (magic === 0xebeb) {
    const digest = crypto.createHash('md5').update(table.subarray(0, n)).digest();
    if (!digest.equals(table.subarray(n + 16, n + 32))) throw new Error('Partition table MD5 mismatch');
    md5Verified = true;
    break;
  }
  if (magic !== 0x50aa) throw new Error('Invalid partition entry');
  const entry = {
    type: table[n + 2], subtype: table[n + 3],
    offset: table.readUInt32LE(n + 4), size: table.readUInt32LE(n + 8),
    label: table.subarray(n + 12, n + 28).toString('ascii').replace(/\0.*$/, ''),
    flags: table.readUInt32LE(n + 28)
  };
  if (entry.offset + entry.size > flash.length) throw new Error('Partition outside Flash');
  partitions.push(entry);
}
if (!md5Verified) throw new Error('No partition-table MD5 found');
const apps = partitions.filter(p => p.type === 0);
if (apps.length !== 1 || apps[0].subtype !== 0 || apps[0].offset !== 0x10000 || apps[0].size !== 0x100000 || apps[0].flags !== 0) {
  throw new Error('Actual app layout differs from expected single, unencrypted factory partition');
}
const app = flash.subarray(apps[0].offset, apps[0].offset + apps[0].size);
if (app[0] !== 0xe9 || app.readUInt16LE(12) !== 9) throw new Error('Original app is not an ESP32-S3 image');
const frozenPath = path.resolve(__dirname, '../../evidence/2026-10-24-demo-backup/artifacts/firmware/kitchen-330D9CA6.bin');
const frozen = fs.readFileSync(frozenPath);
if (sha256(frozen) !== '330D9CA6EF858B0A4043607CA2EB7E92125A9030F2D06B05DA1218B8CCE62938') throw new Error('Frozen rollback hash changed');
const originalMatchesFrozen = app.subarray(0, frozen.length).equals(frozen);
if (!originalMatchesFrozen) throw new Error('Current app differs from frozen kitchen baseline; stop for review');
const rollbackPath = path.join(dir, 'factory-app-before-1MiB.bin');
fs.writeFileSync(rollbackPath, app, { flag: 'wx' });
const result = {
  inspectedAt: new Date().toISOString(), port: 'COM5', device: 'esp32-kitchen',
  mac: '50:78:7d:16:ed:60', flashBytes: flash.length, flashSHA256: sha256(flash),
  partitionTableMD5Verified: md5Verified, partitions,
  appPartitionBytes: app.length, appPartitionSHA256: sha256(app),
  originalMatchesFrozen, frozenAppBytes: frozen.length, frozenAppSHA256: sha256(frozen),
  backupPrivate: true, flashed: false
};
fs.writeFileSync(path.join(dir, 'backup-verification.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
