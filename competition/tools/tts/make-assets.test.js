'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { commit } = require('./make-assets');

function stagedAssets() {
  return [
    { asset: { file: 'check_in.wav' }, buffer: Buffer.from('new-check-in') },
    { asset: { file: 'please_respond.wav' }, buffer: Buffer.from('new-please-respond') }
  ];
}

function transactionDirs(targetDir) {
  return fs.readdirSync(targetDir).filter((name) => name.startsWith('.tts-stage-') || name.startsWith('.tts-backup-'));
}

test('commit replaces every staged asset and removes transaction directories', () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-tts-commit-'));
  try {
    fs.writeFileSync(path.join(targetDir, 'check_in.wav'), 'old-check-in');
    fs.writeFileSync(path.join(targetDir, 'please_respond.wav'), 'old-please-respond');

    assert.equal(commit(stagedAssets(), { targetDir }), 0);
    assert.equal(fs.readFileSync(path.join(targetDir, 'check_in.wav'), 'utf8'), 'new-check-in');
    assert.equal(fs.readFileSync(path.join(targetDir, 'please_respond.wav'), 'utf8'), 'new-please-respond');
    assert.deepEqual(transactionDirs(targetDir), []);
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('commit restores every old asset when installing a later file fails', () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-tts-rollback-'));
  try {
    fs.writeFileSync(path.join(targetDir, 'check_in.wav'), 'old-check-in');
    fs.writeFileSync(path.join(targetDir, 'please_respond.wav'), 'old-please-respond');

    let stagedRenameCount = 0;
    const failingFs = new Proxy(fs, {
      get(target, property) {
        if (property !== 'renameSync') return target[property];
        return (source, destination) => {
          if (path.basename(path.dirname(source)).startsWith('.tts-stage-')) {
            stagedRenameCount += 1;
            if (stagedRenameCount === 2) {
              const error = new Error('simulated second install failure');
              error.code = 'EIO';
              throw error;
            }
          }
          return target.renameSync(source, destination);
        };
      }
    });

    assert.equal(commit(stagedAssets(), { targetDir, fsImpl: failingFs }), 1);
    assert.equal(fs.readFileSync(path.join(targetDir, 'check_in.wav'), 'utf8'), 'old-check-in');
    assert.equal(fs.readFileSync(path.join(targetDir, 'please_respond.wav'), 'utf8'), 'old-please-respond');
    assert.deepEqual(transactionDirs(targetDir), []);
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});
