'use strict';

/**
 * tools/tts/online-tts.js — 无密钥在线 TTS 路线（引擎 + 解码 + 校验）
 *
 * 本模块是本机 SAPI 完全不可用（ISpVoice::Speak 一律 0xC0000005 崩进程）之后的
 * **第二路线**，也是工作包允许的"不需要账号、密钥和付费充值的在线 TTS 工具"。
 *
 * 路线组成：
 *   1. 引擎：百度翻译网页版使用的无密钥语音端点（下方 ENGINE 记录名称/来源/用途）。
 *      —— 不注册、不登录、不需要 key，请求里不携带任何凭据。
 *   2. 解码：tools/tts/mp3-to-pcm.exe，用系统自带的 Windows Media Foundation
 *      Source Reader 把 audio/mpeg 解码为 16-bit PCM WAV。
 *      —— 本机没有 ffmpeg / sox，Media Foundation 随系统提供，无新增第三方依赖。
 *   3. 校验：tools/tts/wav.js（复用既有实现），不在这里放第二套标准。
 *
 * 失败语义（全部 fail closed，绝不伪造音频）：
 *   - 引擎不可达 / 超时 / HTTP 非 2xx / 内容类型不是音频 → 明确失败
 *   - 解码失败 / 解出空数据 → 明确失败
 *   - 校验不通过（静音、时长、声道、位深、采样率）→ 明确失败
 *   任何失败都不会写入目标文件、不会复制 sos.wav、不会生成占位音频。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateVoiceAsset } = require('./wav');

/** 引擎记录：名称、来源、端点、是否需要密钥、注意事项。 */
const ENGINE = Object.freeze({
  name: 'Baidu Fanyi web TTS (gettts)',
  endpoint: 'https://fanyi.baidu.com/gettts',
  requiresKey: false,
  source: '百度翻译网页版前端调用的公开语音端点（lan=zh&spd=3&source=web&text=...）',
  notes: '无需注册/登录/密钥；返回 audio/mpeg。仅用于生成项目自用的老人提示语音，请勿高频调用。'
});

/** 与 cloud/backend/src/comms-core.js 的 VOICE_MAP 语义一致的五段文本。 */
const SENTENCES = Object.freeze([
  Object.freeze({ file: 'check_in.wav', voiceId: 'CHECK_IN', text: '家里在问候您，请回应一下。' }),
  Object.freeze({ file: 'please_respond.wav', voiceId: 'PLEASE_RESPOND', text: '请按一下按钮回应家人。' }),
  Object.freeze({ file: 'medicine_reminder.wav', voiceId: 'MEDICINE_REMINDER', text: '该吃药了，请按时服药。' }),
  Object.freeze({ file: 'family_message.wav', voiceId: 'FAMILY_MESSAGE', text: '家人给您留了一句话，请注意收听。' }),
  Object.freeze({ file: 'emergency_contacting.wav', voiceId: 'EMERGENCY_CONTACTING', text: '正在联系家人，请稍等。' })
]);

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ATTEMPTS = 3;
const MIN_AUDIO_BYTES = 2000;

/** 解码器可执行文件路径（由 make-assets.js --build 生成）。 */
function decoderPath() {
  return path.join(__dirname, 'mp3-to-pcm.exe');
}

/** 构造引擎请求 URL（只含文本，不含任何凭据）。 */
function buildEngineUrl(text) {
  return `${ENGINE.endpoint}?lan=zh&spd=3&source=web&text=${encodeURIComponent(text)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 校验解码后的 WAV 缓冲区（复用 wav.js 标准）。 */
function validateDecodedBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: 'empty_audio_buffer', info: null };
  }
  const result = validateVoiceAsset(buffer);
  if (!result.ok) {
    return { ok: false, reason: 'validation_failed: ' + result.problems.join('; '), info: result.info };
  }
  return { ok: true, reason: '', info: result.info };
}

/**
 * 探测引擎是否可用（不写任何文件）。
 * 用一段固定短文本请求，检查状态码、内容类型与数据量。
 */
async function probeEngine(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const attempts = Number.isSafeInteger(options.attempts) && options.attempts > 0 ? options.attempts : 1;
  const probeText = options.probeText || '你好';

  let lastReason = 'not_attempted';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(buildEngineUrl(probeText), {
        headers: { 'user-agent': DEFAULT_USER_AGENT, accept: '*/*', referer: 'https://fanyi.baidu.com/' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      const contentType = (response.headers && response.headers.get ? response.headers.get('content-type') : '') || '';
      const arrayBuffer = await response.arrayBuffer();
      const bytes = arrayBuffer.byteLength;
      if (!response.ok) {
        lastReason = `http_${response.status}`;
      } else if (!contentType.includes('audio')) {
        lastReason = `content_type_not_audio: ${contentType}`;
      } else if (bytes < MIN_AUDIO_BYTES) {
        lastReason = `audio_too_small: ${bytes}`;
      } else {
        return { ok: true, reason: '', bytes, contentType, status: response.status };
      }
    } catch (error) {
      lastReason = `engine_unreachable: ${error && error.name ? error.name : 'error'}`;
    }
    if (attempt < attempts) await sleep(800 * attempt);
  }
  return { ok: false, reason: lastReason, bytes: 0, contentType: '', status: 0 };
}

/**
 * 合成一段语音：请求引擎 -> 解码 -> 校验。
 *
 * @returns {Promise<{ok: boolean, reason: string, buffer?: Buffer, info?: object}>}
 *          失败时不返回任何音频数据。
 */
async function synthesizeOne(sentence, options = {}) {
  if (sentence === null || typeof sentence !== 'object' || typeof sentence.text !== 'string') {
    return { ok: false, reason: 'invalid_sentence' };
  }
  const workDir = typeof options.workDir === 'string' && options.workDir !== ''
    ? options.workDir
    : path.join(__dirname, '..', '..', '.tts-work');
  const decoder = typeof options.decoder === 'string' ? options.decoder : decoderPath();
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const attempts = Number.isSafeInteger(options.attempts) && options.attempts > 0 ? options.attempts : DEFAULT_ATTEMPTS;
  const targetRate = Number.isSafeInteger(options.targetRate) ? options.targetRate : 16000;
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;

  fs.mkdirSync(workDir, { recursive: true });
  const tag = crypto.randomBytes(6).toString('hex');
  const mp3Path = path.join(workDir, `src-${tag}.mp3`);
  const wavPath = path.join(workDir, `out-${tag}.wav`);

  let lastReason = 'not_attempted';
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(buildEngineUrl(sentence.text), {
          headers: { 'user-agent': DEFAULT_USER_AGENT, accept: '*/*', referer: 'https://fanyi.baidu.com/' },
          signal: AbortSignal.timeout(timeoutMs)
        });
        const contentType = (response.headers && response.headers.get ? response.headers.get('content-type') : '') || '';
        const arrayBuffer = await response.arrayBuffer();
        const audio = Buffer.from(arrayBuffer);

        if (!response.ok) {
          lastReason = `http_${response.status}`;
        } else if (!contentType.includes('audio')) {
          lastReason = `content_type_not_audio: ${contentType}`;
        } else if (audio.length < MIN_AUDIO_BYTES) {
          lastReason = `audio_too_small: ${audio.length}`;
        } else if (!fs.existsSync(decoder)) {
          lastReason = `decoder_missing: ${decoder}`;
        } else {
          fs.writeFileSync(mp3Path, audio);
          if (fs.existsSync(wavPath)) fs.rmSync(wavPath, { force: true });
          const decoded = spawnSync(decoder,
            ['--in', mp3Path, '--out', wavPath, '--rate', String(targetRate), '--channels', '1'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });

          if (decoded.error) {
            lastReason = `decoder_error: ${decoded.error.code || decoded.error.name || 'error'}`;
          } else if (decoded.status !== 0) {
            lastReason = `decoder_exit_${decoded.status}: ${(decoded.stderr || '').trim().slice(0, 200)}`;
          } else if (!fs.existsSync(wavPath)) {
            lastReason = 'decoder_no_output';
          } else {
            const buffer = fs.readFileSync(wavPath);
            const validation = validateDecodedBuffer(buffer);
            if (validation.ok) {
              return { ok: true, reason: '', buffer, info: validation.info };
            }
            lastReason = validation.reason;
          }
        }
      } catch (error) {
        lastReason = `engine_unreachable: ${error && error.name ? error.name : 'error'}`;
      }
      if (attempt < attempts) await sleepFn(1200 * attempt);
    }
    return { ok: false, reason: lastReason };
  } finally {
    for (const temp of [mp3Path, wavPath]) {
      try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch (_) { /* 清理失败不影响结论 */ }
    }
  }
}

/** 合成全部五段（全部成功才返回；否则整体失败）。 */
async function synthesizeAll(options = {}) {
  const results = [];
  for (const sentence of SENTENCES) {
    const result = await synthesizeOne(sentence, options);
    if (!result.ok) {
      return { ok: false, reason: `${sentence.file}: ${result.reason}`, results };
    }
    results.push({ file: sentence.file, voiceId: sentence.voiceId, text: sentence.text, buffer: result.buffer, info: result.info });
  }
  return { ok: true, reason: '', results };
}

module.exports = {
  ENGINE,
  SENTENCES,
  DEFAULT_USER_AGENT,
  MIN_AUDIO_BYTES,
  decoderPath,
  buildEngineUrl,
  validateDecodedBuffer,
  probeEngine,
  synthesizeOne,
  synthesizeAll
};
