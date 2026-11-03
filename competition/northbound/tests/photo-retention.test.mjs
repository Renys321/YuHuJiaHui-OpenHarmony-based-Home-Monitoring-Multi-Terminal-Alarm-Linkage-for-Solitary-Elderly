import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPrivatePhotoName,
  selectPrivatePhotosToDelete,
} from '../entry/src/main/ets/model/PhotoRetention.ts';

test('only recognizes generated private JPEG names', () => {
  assert.equal(isPrivatePhotoName('eldercare-1791609077775.jpg'), true);
  assert.equal(isPrivatePhotoName('eldercare-1.jpg'), true);
  assert.equal(isPrivatePhotoName('../eldercare-1791609077775.jpg'), false);
  assert.equal(isPrivatePhotoName('eldercare-1791609077775.png'), false);
});

test('never deletes the current protected photo', () => {
  const current = 'eldercare-1791609077775.jpg';
  const old = 'eldercare-1791609077000.jpg';
  assert.deepEqual(selectPrivatePhotosToDelete([
    { fileName: current, mtimeSeconds: 1 },
    { fileName: old, mtimeSeconds: 2 },
  ], current, 1), [old]);
});

test('count cap retains protected photo and 99 newest peers', () => {
  const now = 2_000_000_000;
  const entries = Array.from({ length: 101 }, (_value, index) => ({
    fileName: `eldercare-${String(1700000000000 + index)}.jpg`,
    mtimeSeconds: now - (101 - index),
  }));
  const protectedName = entries[0].fileName;
  const deletions = selectPrivatePhotosToDelete(entries, protectedName);
  assert.equal(deletions.length, 1);
  assert.equal(deletions.includes(protectedName), false);
  assert.equal(deletions[0], entries[1].fileName);
});

test('clock-reset names stay managed and deletion depends only on count', () => {
  assert.deepEqual(selectPrivatePhotosToDelete([
    { fileName: 'eldercare-1.jpg', mtimeSeconds: 0 },
    { fileName: 'eldercare-1791609077001.jpg', mtimeSeconds: 9_999_999_999 },
  ], ''), []);
});
