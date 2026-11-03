'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const entrySource = fs.readFileSync(path.resolve(
  __dirname, '..', 'entry', 'src', 'main', 'ets', 'entryability', 'EntryAbility.ets'), 'utf8');
const indexSource = fs.readFileSync(path.resolve(
  __dirname, '..', 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'), 'utf8');
const cameraSource = fs.readFileSync(path.resolve(
  __dirname, '..', 'entry', 'src', 'main', 'ets', 'model', 'CameraModel.ets'), 'utf8');
const streamerSource = fs.readFileSync(path.resolve(
  __dirname, '..', 'entry', 'src', 'main', 'ets', 'model', 'VisionFrameStreamer.ets'), 'utf8');

test('foreground recovery is re-emitted after the page listener can attach', () => {
  assert.match(entrySource, /guardForegroundGeneration/);
  assert.match(entrySource, /setTimeout\(\(\): void =>/);
  assert.match(entrySource, /Ability foreground recovery event/);
  assert.match(entrySource, /eventHub\.emit\(GUARD_FOREGROUND_EVENT, true\)/);
  assert.match(entrySource, /onBackground[\s\S]*guardForegroundGeneration = this\.guardForegroundGeneration \+ 1/,
    'background must invalidate a delayed foreground event');
});

test('camera XComponent overlay remains structurally stable while preview state changes', () => {
  assert.match(indexSource, /id: 'eldercareCameraPreview'/);
  assert.match(indexSource, /\.visibility\(this\.cameraPreviewActive \? Visibility\.Hidden : Visibility\.Visible\)/);
  assert.equal(/if \(!this\.cameraPreviewActive\) \{\s*Text\(this\.cameraGuardEnabled/.test(indexSource), false,
    'do not conditionally insert/remove the overlay around the native camera Surface');
});

test('DAYU preview rotation is locked without rotating the inference frame', () => {
  assert.match(cameraSource,
    /createPreviewOutput\(previewProfile, surfaceId\)[\s\S]*setPreviewRotation\(camera\.ImageRotation\.ROTATION_0, true\)/,
    'preview output must be locked to the upright raw-frame orientation');
  assert.doesNotMatch(indexSource, /eldercareCameraPreview[\s\S]{0,500}\.rotate\(/,
    'do not rotate the XComponent geometry or change its 4:3 clipping bounds');
  assert.match(streamerSource,
    /createPixelMapFromSurface\(this\.surfaceId\)[\s\S]*packer\.packToData\(pixelMap/,
    'inference must continue packing the unmodified Surface frame');
});

test('orientation suspension is visible instead of being reported as no person', () => {
  assert.match(streamerSource, /orientationState: string/);
  assert.match(streamerSource, /inference\.refused === true/);
  assert.match(streamerSource, /inference\.suspended === true/);
  assert.match(indexSource, /方向校准失败，跌倒检测已停用/);
  assert.match(indexSource, /画面方向异常，跌倒检测已暂停/);
  assert.match(indexSource, /正在校准画面方向，跌倒检测暂未启用/);
});
