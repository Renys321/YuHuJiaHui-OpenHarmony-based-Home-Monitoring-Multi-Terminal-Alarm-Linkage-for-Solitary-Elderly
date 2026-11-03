'use strict';

/**
 * tools/tts/wav.test.js — WAV 校验/归一化的单元测试
 *
 * 覆盖：真实 WAV 读取、静音拒绝、空文件拒绝、错误头拒绝、
 * 归一化到 16 kHz 单声道、时长与能量统计。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readWav, writeWav, normalizeWav, validateVoiceAsset, analyse } = require('./wav');

/** 生成一段正弦波 PCM。 */
function tone(seconds, rate, frequency = 220, amplitude = 0.5, channels = 1) {
  const frames = Math.round(seconds * rate);
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / rate);
  }
  if (channels === 2) {
    const stereo = [];
    const buffer = Buffer.alloc(44 + frames * 4);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + frames * 4, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(2, 22);
    buffer.writeUInt32LE(rate, 24);
    buffer.writeUInt32LE(rate * 4, 28);
    buffer.writeUInt16LE(4, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(frames * 4, 40);
    for (let index = 0; index < frames; index += 1) {
      const value = Math.round(samples[index] * 32767);
      buffer.writeInt16LE(value, 44 + index * 4);
      buffer.writeInt16LE(value, 44 + index * 4 + 2);
    }
    void stereo;
    return buffer;
  }
  return writeWav(samples, rate);
}

test('a well-formed mono 16k WAV round-trips through read and write', () => {
  const buffer = tone(1.0, 16000);
  const parsed = readWav(buffer);
  assert.equal(parsed.format.sampleRate, 16000);
  assert.equal(parsed.format.channels, 1);
  assert.equal(parsed.format.bitsPerSample, 16);
  assert.equal(parsed.format.audioFormat, 1);
  assert.equal(parsed.frameCount, 16000);
  assert.ok(Math.abs(parsed.durationSeconds - 1.0) < 0.001);
});

test('a valid voice asset passes validation', () => {
  const result = validateVoiceAsset(tone(1.5, 16000));
  assert.equal(result.ok, true, result.problems.join('; '));
  assert.equal(result.info.sampleRate, 16000);
  assert.ok(result.info.rms > 0.2, '正弦波 RMS 应该明显非静音');
  assert.ok(result.info.durationSeconds > 1.4);
});

test('a silent file is rejected', () => {
  const silent = writeWav(new Float32Array(16000), 16000);
  const result = validateVoiceAsset(silent);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((item) => item.includes('静音')), result.problems.join('; '));
});

test('an empty or truncated file is rejected', () => {
  assert.equal(validateVoiceAsset(Buffer.alloc(0)).ok, false);
  assert.equal(validateVoiceAsset(Buffer.alloc(20)).ok, false);
  const truncated = tone(1.0, 16000).subarray(0, 100);
  assert.equal(validateVoiceAsset(truncated).ok, false);
});

test('a non-WAV file is rejected', () => {
  const junk = Buffer.alloc(100, 0x41);
  const result = validateVoiceAsset(junk);
  assert.equal(result.ok, false);
  assert.ok(result.problems[0].includes('RIFF'), result.problems.join('; '));
});

test('a file with a lying RIFF size is rejected', () => {
  const buffer = tone(0.5, 16000);
  buffer.writeUInt32LE(999999, 4);
  assert.equal(validateVoiceAsset(buffer).ok, false);
});

test('only 16k and 24k are accepted sample rates', () => {
  assert.equal(validateVoiceAsset(tone(1.0, 24000)).ok, true);
  const odd = validateVoiceAsset(tone(1.0, 22050));
  assert.equal(odd.ok, false);
  assert.ok(odd.problems.some((item) => item.includes('采样率')), odd.problems.join('; '));
});

test('normalisation converts 22.05 kHz to 16 kHz mono PCM', () => {
  const source = tone(1.0, 22050);
  const { buffer, info } = normalizeWav(source, 16000);
  const parsed = readWav(buffer);
  assert.equal(parsed.format.sampleRate, 16000);
  assert.equal(parsed.format.channels, 1);
  assert.equal(parsed.format.bitsPerSample, 16);
  assert.equal(info.sourceRate, 22050);
  assert.ok(Math.abs(parsed.durationSeconds - 1.0) < 0.02, `时长应保持约 1s，实际 ${parsed.durationSeconds}`);
  assert.equal(validateVoiceAsset(buffer).ok, true);
});

test('normalisation downmixes stereo to mono', () => {
  const stereo = tone(1.0, 16000, 220, 0.5, 2);
  const { buffer } = normalizeWav(stereo, 16000);
  const parsed = readWav(buffer);
  assert.equal(parsed.format.channels, 1);
  assert.equal(parsed.frameCount, 16000);
});

test('analysis reports silence, activity and clipping distinctly', () => {
  const silent = analyse(new Float32Array(1000));
  assert.equal(silent.rms, 0);
  assert.equal(silent.activeRatio, 0);

  const loud = new Float32Array(1000);
  loud.fill(1.0);
  const clipped = analyse(loud);
  assert.ok(clipped.clippingRatio > 0.9);

  const normal = analyse(new Float32Array(1000).fill(0.3));
  assert.ok(normal.rms > 0.29 && normal.rms < 0.31);
  assert.equal(normal.activeRatio, 1);
});

test('the real repository audio assets — if present — must be valid', (t) => {
  const rawfileDir = path.resolve(__dirname, '..', '..', 'northbound', 'entry', 'src', 'main', 'resources', 'rawfile');
  const expected = [
    'check_in.wav', 'please_respond.wav', 'medicine_reminder.wav',
    'family_message.wav', 'emergency_contacting.wav'
  ];
  const present = expected.filter((name) => fs.existsSync(path.join(rawfileDir, name)));
  if (present.length === 0) {
    // 资源尚未提供：明确记录 AUDIO ASSETS BLOCKED，而不是假装通过。
    t.diagnostic('AUDIO ASSETS BLOCKED: none of the five preset voice files exist yet');
    assert.equal(present.length, 0);
    return;
  }
  assert.equal(present.length, expected.length,
    `只找到部分语音资源: ${present.join(', ')} —— 五个必须同时存在`);
  const digests = new Set();
  for (const name of expected) {
    const buffer = fs.readFileSync(path.join(rawfileDir, name));
    const result = validateVoiceAsset(buffer);
    assert.equal(result.ok, true, `${name} 不合法: ${result.problems.join('; ')}`);
    digests.add(buffer.toString('base64').length + ':' + buffer.subarray(0, 64).toString('hex'));
  }
  assert.equal(digests.size, expected.length, '五个资源不得完全相同（不允许复制 sos.wav 冒充）');
});
