'use strict';

/**
 * tools/tts/online-tts.test.js — 无密钥在线 TTS 路线的可测试部分
 *
 * 覆盖：
 *   - 引擎常量（名称/来源/端点）与五段文本的存在性、唯一性；
 *   - 请求 URL 构造（编码正确、不带任何密钥）；
 *   - 校验失败的音频被拒绝（静音/空数据/时长不符）；
 *   - 引擎不可达时返回明确失败而不是伪造音频；
 *   - 引擎可达时端到端产出通过 wav.js 校验的 WAV（无网络则明确 skip）。
 *
 * 本测试**不需要任何账号或密钥**；离线时相关用例会 skip 并说明原因。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const online = require('./online-tts');
const { writeWav, validateVoiceAsset } = require('./wav');

test('the online engine is named and sourced explicitly', () => {
  assert.equal(typeof online.ENGINE.name, 'string');
  assert.ok(online.ENGINE.name.length > 0);
  assert.ok(online.ENGINE.endpoint.startsWith('https://'), '必须是 HTTPS');
  assert.equal(online.ENGINE.requiresKey, false, '本路线不得需要密钥');
  assert.ok(online.ENGINE.notes.length > 0, '必须记录来源与用途说明');
});

test('the five sentences match the asset contract and are all distinct', () => {
  const { SENTENCES } = online;
  assert.equal(SENTENCES.length, 5);
  const files = SENTENCES.map((item) => item.file);
  assert.deepEqual(files.slice().sort(), [
    'check_in.wav', 'emergency_contacting.wav', 'family_message.wav',
    'medicine_reminder.wav', 'please_respond.wav'
  ]);
  const texts = SENTENCES.map((item) => item.text);
  assert.equal(new Set(texts).size, 5, '五段文本必须互不相同');
  for (const text of texts) {
    assert.ok(text.trim().length >= 6, `文本过短: ${text}`);
    assert.equal(/[A-Za-z0-9@]/.test(text), false, `文本不得含拉丁字母或 @: ${text}`);
  }
});

test('the request URL encodes the text and carries no credential', () => {
  const url = online.buildEngineUrl('该吃药了，请按时服药。');
  assert.ok(url.startsWith(online.ENGINE.endpoint));
  assert.ok(url.includes(encodeURIComponent('该吃药了，请按时服药。')), '文本必须被 URL 编码');
  for (const forbidden of ['key=', 'token=', 'secret=', 'appid=', 'access_']) {
    assert.equal(url.toLowerCase().includes(forbidden), false, `URL 不得包含 ${forbidden}`);
  }
});

test('silent or invalid audio is rejected by the shared validator', () => {
  const silent = writeWav(new Float32Array(16000), 16000);
  const silentResult = validateVoiceAsset(silent);
  assert.equal(silentResult.ok, false);
  assert.ok(silentResult.problems.some((item) => item.includes('静音')));

  const empty = online.validateDecodedBuffer(Buffer.alloc(0));
  assert.equal(empty.ok, false);
  assert.ok(empty.reason.length > 0);
});

test('a truncated WAV is rejected', () => {
  const truncated = writeWav(new Float32Array(16000).fill(0.3), 16000).subarray(0, 200);
  const result = online.validateDecodedBuffer(truncated);
  assert.equal(result.ok, false);
});

test('an unreachable engine produces an explicit failure, never fake audio', async () => {
  const result = await online.synthesizeOne(
    { file: 'check_in.wav', voiceId: 'CHECK_IN', text: '家里在问候您，请回应一下。' },
    {
      workDir: path.join(__dirname, '..', '..', '.tts-work'),
      fetchImpl: async () => { throw new Error('network down'); },
      attempts: 1
    }
  );
  assert.equal(result.ok, false);
  assert.ok(result.reason.startsWith('engine_unreachable'), result.reason);
  assert.equal(result.buffer, undefined, '失败时不得返回任何音频数据');
});

test('an HTTP error from the engine is reported, not swallowed', async () => {
  const result = await online.synthesizeOne(
    { file: 'check_in.wav', voiceId: 'CHECK_IN', text: '家里在问候您，请回应一下。' },
    {
      workDir: path.join(__dirname, '..', '..', '.tts-work'),
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => new ArrayBuffer(120)
      }),
      attempts: 1
    }
  );
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('http_500'), result.reason);
});

test('a non-audio response is rejected instead of being written as an asset', async () => {
  const result = await online.synthesizeOne(
    { file: 'check_in.wav', voiceId: 'CHECK_IN', text: '家里在问候您，请回应一下。' },
    {
      workDir: path.join(__dirname, '..', '..', '.tts-work'),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        arrayBuffer: async () => new TextEncoder().encode('<html>nope</html>').buffer
      }),
      attempts: 1
    }
  );
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('content_type'), result.reason);
});

test('the engine endpoint is reachable from this machine (skips when offline)', async (t) => {
  const probe = await online.probeEngine({ attempts: 1 });
  if (!probe.ok) {
    t.skip(`AUDIO ENGINE UNREACHABLE: ${probe.reason}`);
    return;
  }
  assert.equal(probe.ok, true);
  assert.ok(probe.bytes > 2000, `引擎返回数据过少: ${probe.bytes}`);
  assert.ok(probe.contentType.includes('audio'), `内容类型不是音频: ${probe.contentType}`);
});

test('end to end: the engine produces a WAV that passes the shared validator', async (t) => {
  const decoder = online.decoderPath();
  if (!fs.existsSync(decoder)) {
    t.skip(`MP3 decoder missing: ${decoder}`);
    return;
  }
  const probe = await online.probeEngine({ attempts: 1 });
  if (!probe.ok) {
    t.skip(`AUDIO ENGINE UNREACHABLE: ${probe.reason}`);
    return;
  }

  const sentence = online.SENTENCES[0];
  const result = await online.synthesizeOne(sentence, {
    workDir: path.join(__dirname, '..', '..', '.tts-work'),
    attempts: 2
  });
  assert.equal(result.ok, true, result.reason);
  const validation = validateVoiceAsset(result.buffer);
  assert.equal(validation.ok, true, validation.problems.join('; '));
  assert.equal(validation.info.channels, 1);
  assert.equal(validation.info.bitsPerSample, 16);
  assert.equal(validation.info.sampleRate, 16000);
  assert.ok(validation.info.durationSeconds >= 0.8, `时长过短: ${validation.info.durationSeconds}`);
  assert.ok(validation.info.durationSeconds <= 20, `时长过长: ${validation.info.durationSeconds}`);
  assert.ok(validation.info.rms > 0.005, `近似静音: ${validation.info.rms}`);
});
