'use strict';

/**
 * tools/tts/wav.js — 纯 Node 的 WAV 读取 / 校验 / 归一化
 *
 * 用途：
 *   1. 校验预置语音资源是不是**真实有效的 PCM WAV**（头、采样率、声道、位深、时长、非静音）；
 *   2. 把 SAPI 写出的 22.05 kHz WAV 归一化成 16 kHz / 16-bit / 单声道 PCM。
 *
 * 为什么要有这个模块：五段预置语音必须是"真实中文语音"，不能用空文件、
 * 静音文件或复制 sos.wav 冒充。把"能不能验"做成可测试的纯代码，
 * 才能对资源给出可核查的结论（而不是"看着像"）。
 *
 * 不依赖任何第三方库。
 */

/** 解析 RIFF/WAVE，返回头信息与 PCM 数据。 */
function readWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('wav: buffer too small');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('wav: missing RIFF header');
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('wav: not a WAVE file');
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) {
    throw new Error('wav: RIFF size does not match file length');
  }

  let offset = 12;
  let format = null;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) throw new Error(`wav: chunk ${id} overruns file`);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('wav: fmt chunk too small');
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        blockAlign: buffer.readUInt16LE(body + 12),
        bitsPerSample: buffer.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      dataStart = body;
      dataLength = size;
    }
    offset = body + size + (size % 2);
  }

  if (format === null) throw new Error('wav: missing fmt chunk');
  if (dataStart < 0) throw new Error('wav: missing data chunk');
  if (format.audioFormat !== 1) {
    throw new Error(`wav: only PCM (format 1) is supported, got ${format.audioFormat}`);
  }
  if (format.bitsPerSample !== 16) {
    throw new Error(`wav: only 16-bit PCM is supported, got ${format.bitsPerSample}`);
  }

  const frameBytes = format.channels * 2;
  const frameCount = Math.floor(dataLength / frameBytes);
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      sum += buffer.readInt16LE(dataStart + frame * frameBytes + channel * 2);
    }
    samples[frame] = sum / format.channels / 32768;
  }

  return {
    format,
    samples,
    frameCount,
    durationSeconds: format.sampleRate > 0 ? frameCount / format.sampleRate : 0,
    dataLength
  };
}

/** 统计非静音能量：返回 RMS 与峰值。 */
function analyse(samples) {
  if (samples.length === 0) return { rms: 0, peak: 0, activeRatio: 0, clippingRatio: 0 };
  let sumSquares = 0;
  let peak = 0;
  let active = 0;
  let clipping = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    const magnitude = Math.abs(value);
    sumSquares += value * value;
    if (magnitude > peak) peak = magnitude;
    if (magnitude > 0.01) active += 1;
    if (magnitude > 0.99) clipping += 1;
  }
  return {
    rms: Math.sqrt(sumSquares / samples.length),
    peak,
    activeRatio: active / samples.length,
    clippingRatio: clipping / samples.length
  };
}

/** 线性插值重采样。语音资源用 16 kHz 单声道即可，质量足够。 */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(samples);
  const ratio = toRate / fromRate;
  const outputLength = Math.max(1, Math.round(samples.length * ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = index / ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

/** 写出 16-bit 单声道 PCM WAV。 */
function writeWav(samples, sampleRate) {
  const dataLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);                 // PCM
  buffer.writeUInt16LE(1, 22);                 // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);    // byteRate
  buffer.writeUInt16LE(2, 32);                 // blockAlign
  buffer.writeUInt16LE(16, 34);                // bitsPerSample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  for (let index = 0; index < samples.length; index += 1) {
    let value = Math.round(samples[index] * 32767);
    if (value > 32767) value = 32767;
    if (value < -32768) value = -32768;
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

/**
 * 归一化到 16 kHz / 16-bit / 单声道 PCM。
 * @returns {{buffer: Buffer, info: object}}
 */
function normalizeWav(buffer, targetRate = 16000) {
  const parsed = readWav(buffer);
  const mono = parsed.format.channels === 1
    ? parsed.samples
    : parsed.samples; // readWav 已经下混成单声道
  const resampled = resample(mono, parsed.format.sampleRate, targetRate);
  const outBuffer = writeWav(resampled, targetRate);
  return {
    buffer: outBuffer,
    info: {
      sourceRate: parsed.format.sampleRate,
      sourceChannels: parsed.format.channels,
      sourceDurationSeconds: parsed.durationSeconds,
      targetRate,
      targetDurationSeconds: resampled.length / targetRate
    }
  };
}

/**
 * 校验一个语音资源是否满足交付要求。
 *
 * @returns {{ok: boolean, problems: string[], info: object}}
 */
function validateVoiceAsset(buffer, options = {}) {
  const problems = [];
  const minDuration = options.minDurationSeconds === undefined ? 0.8 : options.minDurationSeconds;
  const maxDuration = options.maxDurationSeconds === undefined ? 20 : options.maxDurationSeconds;
  const minRms = options.minRms === undefined ? 0.005 : options.minRms;
  const minActiveRatio = options.minActiveRatio === undefined ? 0.05 : options.minActiveRatio;

  let parsed = null;
  try {
    parsed = readWav(buffer);
  } catch (error) {
    return { ok: false, problems: [error.message], info: null };
  }

  const format = parsed.format;
  if (format.channels !== 1) problems.push(`必须是单声道，实际 ${format.channels}`);
  if (format.bitsPerSample !== 16) problems.push(`必须是 16-bit，实际 ${format.bitsPerSample}`);
  if (format.sampleRate !== 16000 && format.sampleRate !== 24000) {
    problems.push(`采样率必须是 16k 或 24k，实际 ${format.sampleRate}`);
  }
  if (parsed.durationSeconds < minDuration) {
    problems.push(`时长过短（${parsed.durationSeconds.toFixed(2)}s < ${minDuration}s）`);
  }
  if (parsed.durationSeconds > maxDuration) {
    problems.push(`时长过长（${parsed.durationSeconds.toFixed(2)}s > ${maxDuration}s）`);
  }
  if (format.byteRate !== format.sampleRate * format.channels * 2) {
    problems.push('byteRate 与采样参数不一致');
  }
  if (format.blockAlign !== format.channels * 2) {
    problems.push('blockAlign 与声道数不一致');
  }

  const stats = analyse(parsed.samples);
  if (stats.rms < minRms) problems.push(`音频近似静音（RMS ${stats.rms.toFixed(5)} < ${minRms}）`);
  if (stats.activeRatio < minActiveRatio) {
    problems.push(`有效语音占比过低（${(stats.activeRatio * 100).toFixed(1)}% < ${minActiveRatio * 100}%）`);
  }
  if (stats.clippingRatio > 0.05) {
    problems.push(`削波过多（${(stats.clippingRatio * 100).toFixed(1)}%）`);
  }

  return {
    ok: problems.length === 0,
    problems,
    info: {
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitsPerSample: format.bitsPerSample,
      durationSeconds: parsed.durationSeconds,
      frameCount: parsed.frameCount,
      dataLength: parsed.dataLength,
      rms: stats.rms,
      peak: stats.peak,
      activeRatio: stats.activeRatio
    }
  };
}

module.exports = { readWav, writeWav, resample, analyse, normalizeWav, validateVoiceAsset };
