'use strict';

/**
 * 语音网关：板端录音 → 中文识别 → DeepSeek → 中文合成 → 音箱播放。
 *
 *   9302  DAYU200（经 hdc rport）   JSON 行 + [u32be len][PCM/WAV]
 *   9102  ESP32-S3 音箱节点          JSON 行 + 原始 PCM
 *   9303  ESP32-S3 板载咪头          JSON 行 + [u32be len][PCM]
 *
 * Key 只从环境变量或 ../.secrets 读取，日志统一走 redact()；原始音频只落系统
 * 临时目录，问答结束即删；发给 DeepSeek 的只有转写文本。
 */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 9302;
const PROTOCOL = 1;

const MAX_AUDIO_SECONDS = 12;                // 板端 10 秒 + 余量
const MAX_TEXT_CHARS = 500;
const MAX_CHUNK_BYTES = 256 * 1024;
const IDLE_TIMEOUT_MS = 25000;
const ASR_TIMEOUT_MS = 9000;
const DEEPSEEK_TIMEOUT_MS = 12000;
const TTS_TIMEOUT_MS = 8000;
const SPOKEN_MAX = 40;

const ASR_SCRIPT = path.join(__dirname, 'asr.ps1');
const TTS_SCRIPT = path.join(__dirname, 'tts.ps1');
const KEY_FILE = path.join(__dirname, '..', '.secrets', 'deepseek_api_key.txt');
const INGEST_KEY_FILE = path.join(__dirname, '..', '.secrets', 'ingest_key.txt');
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

const DEBUG_TEXT = process.env.VOICE_GATEWAY_DEBUG_TEXT === '1';

const SYSTEM_PROMPT = [
  '你是“守巢”居家安全助手的语音问答模块，服务对象是独居老人。',
  '硬性要求：',
  '1. 只给生活起居、居家安全、情绪陪伴方面的建议；不做医疗诊断，不判断疾病，不推荐或调整药物。',
  '2. 回答口语化、简短，严格控制在 40 个汉字以内，只讲最关键的一两点，适合直接朗读。',
  '3. 遇到胸痛、呼吸困难、意识不清、跌倒受伤、大量出血等紧急情况，明确建议立即联系家人或拨打 120。',
  '4. 不编造事实；不知道就直说，并建议咨询家人或医生。'
].join('\n');

const HEALTH_TEXT = '您说不舒服，先坐下休息，不要走动。我已经记录并通知家人；' +
  '如果胸闷、呼吸困难或意识不清，请立即拨打 120。';
const SAFE_ACK_TEXT = '好的，已记录，已通知家人。';

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${ts()}] ${msg}`);
}

/** 任何形似 API Key 的片段都不落日志。 */
function redact(text) {
  return String(text).replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-***');
}

function readSecret(file, envName) {
  const fromEnv = process.env[envName];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

const API_KEY = readSecret(KEY_FILE, 'DEEPSEEK_API_KEY');
const INGEST_KEY = readSecret(INGEST_KEY_FILE, 'INGEST_KEY');

/* ---- 老人自述安全的云端上报 ----
 * 只有“我没事/没事”这种固定短语会 POST 到 /internal/v1/elder-safe，供手机 APP
 * 展示。上报是旁路：超时、失败、没配 key 都只写日志，不影响本机播报和回执。 */
const CLOUD_BASE_URL = String(process.env.CLOUD_BASE_URL || 'https://api.luxunacc.xyz')
  .trim().replace(/\/+$/, '');
const ELDER_SAFE_REPORT_TIMEOUT_MS = 5000;

/** INGEST_KEY 不能走明文 HTTP；回环地址只为本地联调放行。 */
function cloudBaseAllowed(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ||
      parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch (e) {
    return false;
  }
}

const CLOUD_REPORT_ALLOWED = cloudBaseAllowed(CLOUD_BASE_URL);

async function postElderSafe(event) {
  if (INGEST_KEY.length === 0) {
    logError('[elder-safe] 未配置 INGEST_KEY，跳过云端上报（本机播报不受影响）');
    return;
  }
  if (!event.deviceId || !event.room) {
    logError('[elder-safe] 缺少 node/room，跳过云端上报');
    return;
  }
  if (!CLOUD_REPORT_ALLOWED) {
    logError('[elder-safe] CLOUD_BASE_URL 必须是 https（或本机回环），已拒绝明文上报');
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ELDER_SAFE_REPORT_TIMEOUT_MS);
  try {
    const response = await fetch(`${CLOUD_BASE_URL}/internal/v1/elder-safe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ingest-key': INGEST_KEY
      },
      body: JSON.stringify({
        deviceId: event.deviceId,
        room: event.room,
        alarmId: event.alarmId || '',
        text: event.text,
        at: event.at,
        source: event.source
      }),
      signal: controller.signal
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      logError(`[elder-safe] 云端上报失败 status=${response.status}`);
      return;
    }
    let eventId = '';
    try {
      const parsed = JSON.parse(text);
      eventId = parsed && typeof parsed.eventId === 'string' ? parsed.eventId : '';
    } catch (e) {
      // 响应体格式不对不影响主链路。
    }
    log(`[elder-safe] 云端已记录 eventId=${redact(eventId).slice(0, 40) || '?'} room=${redact(event.room)}`);
  } catch (e) {
    logError(`[elder-safe] 云端上报异常: ${redact(e && e.message ? e.message : e)}`);
  } finally {
    clearTimeout(timer);
  }
}

function reportElderSafe(event) {
  void postElderSafe(event).catch((e) => {
    logError(`[elder-safe] 云端上报异常: ${redact(e && e.message ? e.message : e)}`);
  });
}

if (API_KEY.length === 0) {
  logError('未找到 DeepSeek Key：请设置 DEEPSEEK_API_KEY 或 .secrets/deepseek_api_key.txt（文字/语音 ASR 仍可用，问答会返回可读错误）');
} else {
  log('DeepSeek Key 已加载（不显示内容）');
}
if (INGEST_KEY.length === 0) {
  logError('未找到 INGEST_KEY：老人自述安全只在本机播报，不上报手机 APP（可设置环境变量或 .secrets/ingest_key.txt）');
} else if (!CLOUD_REPORT_ALLOWED) {
  logError('CLOUD_BASE_URL 必须是 https（或本机回环）：已禁用老人自述安全的云端上报');
} else {
  log(`云端上报已启用（INGEST_KEY 已加载，不显示内容；base=${CLOUD_BASE_URL}）`);
}

/* ---- 临时音频 ----
 * PowerShell 的 TTS/ASR 需要真实文件路径，所以每次问答在系统临时目录建一个
 * WAV，读完立即删。目录若被外部清掉，下一次取路径时重建，免得 TTS 一直失败。 */
let tempDir = '';
let tempSeq = 0;

function ensureTempDir() {
  if (tempDir) {
    try {
      fs.accessSync(tempDir);
      return tempDir;
    } catch (e) {
      // 目录被删了，下面重建。
    }
  }
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-voice-'));
    log(`临时音频目录: ${tempDir}`);
  } catch (e) {
    logError(`创建临时目录失败: ${e.message}`);
    tempDir = '';
  }
  return tempDir;
}

function nextTempWav(name) {
  ensureTempDir();
  tempSeq += 1;
  return path.join(tempDir, `${name}-${process.pid}-${tempSeq}.wav`);
}

function safeUnlink(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (e) {
    // 已删除/不存在
  }
}

function cleanupTempDir() {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {
    // 忽略
  }
}
process.on('exit', cleanupTempDir);
process.on('SIGINT', () => { cleanupTempDir(); process.exit(0); });
process.on('SIGTERM', () => { cleanupTempDir(); process.exit(0); });

ensureTempDir();

/** 给 16bit 单声道 PCM 加 44 字节 RIFF 头。 */
function wavFromPcm(pcm, rate) {
  const channels = 1;
  const bits = 16;
  const byteRate = rate * channels * bits / 8;
  const blockAlign = channels * bits / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function stripPunctuation(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[\s，。！？、,.!?]/g, '');
}

/** 去掉标点后只认“我没事”“没事”。 */
function isElderSafe(text) {
  const t = stripPunctuation(text);
  return t === '我没事' || t === '没事';
}

/** 自由听写容易把“我没事”听成“我没事吧”之类，短句再走一遍安全语法。 */
function looksLikeSafeCandidate(text) {
  const t = stripPunctuation(text);
  if (t.length < 2 || t.length > 4) return false;
  if (t[0] !== '我') return false;
  return t.endsWith('是') || t.endsWith('事') || t.includes('没');
}

function isHealthConcern(text) {
  const t = String(text || '');
  const keys = ['不舒服', '难受', '头晕', '胸闷', '恶心', '心慌', '喘不上', '疼'];
  for (const k of keys) if (t.includes(k)) return true;
  return false;
}

function runPowerShell(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    try {
      child = spawn('powershell.exe', argv, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message, timedOut: false });
      return;
    }
    // 脚本内部已有自己的超时；这里只是兜底，防止进程卡死拖住整个会话。
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) { }
      resolve({ code: -1, stdout, stderr, timedOut: true });
    }, timeoutMs + 2000);

    child.stdout.on('data', (d) => {
      if (stdout.length < 65536) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 16384) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: e.message, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr, timedOut: false });
    });
  });
}

function parseJsonOutput(stdout) {
  const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch (e) {
      // 继续向前找
    }
  }
  return null;
}

async function transcribe(wavPath, mode = 'auto') {
  const args = ['-WavPath', wavPath];
  if (mode === 'safe' || mode === 'health') args.push('-Mode', mode);
  const r = await runPowerShell(ASR_SCRIPT, args, ASR_TIMEOUT_MS);
  if (r.timedOut) {
    return { error: 'TIMEOUT', message: '语音识别超时，请再说一次' };
  }
  const out = parseJsonOutput(r.stdout);
  if (out && typeof out.text === 'string' && out.text.trim().length > 0) {
    const conf = typeof out.confidence === 'string' ? Number.parseFloat(out.confidence) : NaN;
    return { text: out.text.trim(), confidence: Number.isFinite(conf) ? conf : 0 };
  }
  if (out && out.error === 'ASR_TIMEOUT') {
    return { error: 'TIMEOUT', message: '语音识别超时，请再说一次' };
  }
  if (out && out.error === 'ASR_EMPTY') {
    return { error: 'ASR_FAILED', message: '没有听清，请靠近麦克风再说一次，或改用文字输入' };
  }
  const detail = out && out.message ? out.message : (r.stderr || '识别器失败');
  return { error: 'ASR_FAILED', message: `语音识别失败（${redact(detail).slice(0, 120)}）` };
}

async function askDeepSeek(text) {
  if (API_KEY.length === 0) {
    const err = new Error('服务端未配置 DeepSeek Key');
    err.code = 'DEEPSEEK_FAILED';
    throw err;
  }
  let response;
  try {
    response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `老人说：“${text}”` }
        ],
        max_tokens: 120,
        temperature: 0.3,
        stream: false
      }),
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS)
    });
  } catch (e) {
    const err = new Error(e.name === 'TimeoutError' ? 'AI 回答超时' : 'AI 服务连接失败');
    err.code = e.name === 'TimeoutError' ? 'TIMEOUT' : 'DEEPSEEK_FAILED';
    throw err;
  }

  if (!response.ok) {
    const err = new Error(`AI 服务返回 HTTP ${response.status}`);
    err.code = 'DEEPSEEK_FAILED';
    throw err;
  }
  let data;
  try {
    data = await response.json();
  } catch (e) {
    const err = new Error('AI 返回内容无法解析');
    err.code = 'DEEPSEEK_FAILED';
    throw err;
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message ?
    data.choices[0].message.content : '';
  if (typeof content !== 'string' || content.trim().length === 0) {
    const err = new Error('AI 返回了空回答');
    err.code = 'DEEPSEEK_FAILED';
    throw err;
  }
  const raw = content.trim();
  const answer = trimForSpeech(raw);
  if (raw.length > SPOKEN_MAX) {
    log(`回答限长: 原文 ${raw.length} 字 -> 播报 ${answer.length} 字`);
  }
  return { text: answer, model: DEEPSEEK_MODEL };
}

/** 超过 40 字就截断，优先停在句末标点；太靠前则直接加省略号。 */
function trimForSpeech(text) {
  if (text.length <= SPOKEN_MAX) return text;
  const cut = text.slice(0, SPOKEN_MAX);
  let end = -1;
  for (const ch of ['。', '！', '？', '；']) {
    const i = cut.lastIndexOf(ch);
    if (i > end) end = i;
  }
  return end >= 10 ? cut.slice(0, end + 1) : `${cut}…`;
}

async function synthesize(text) {
  const outPath = nextTempWav('tts');
  const r = await runPowerShell(TTS_SCRIPT, ['-Text', text, '-OutPath', outPath], TTS_TIMEOUT_MS);
  let wav = null;
  let errorMessage = '';
  if (r.timedOut) {
    errorMessage = '语音合成超时';
  } else {
    const out = parseJsonOutput(r.stdout);
    if (out && out.ok === true) {
      try {
        wav = fs.readFileSync(outPath);
      } catch (e) {
        errorMessage = '合成音频读取失败';
      }
    } else {
      errorMessage = out && out.message ? out.message : (r.stderr || '语音合成失败');
    }
  }
  safeUnlink(outPath);
  if (wav === null || wav.length <= 44) {
    const err = new Error(`语音合成失败（${redact(errorMessage).slice(0, 120)}）`);
    err.code = 'TTS_FAILED';
    throw err;
  }
  return wav;
}

/* ---- 9302 文本广播 ----
 * S3 的语音事件以纯文本发给所有已连入的板端页面，不发音频。广播是尽力而为：
 * 慢连接或写失败只会被移出集合，不拖住 ASR、问答与音箱播报。 */
const boardClients = new Set();
const BOARD_BACKLOG_LIMIT = 256 * 1024;
const BOARD_TEXT_MAX = 500;

function boardText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\r\n]+/g, ' ').slice(0, BOARD_TEXT_MAX);
}

function broadcastBoardJson(obj) {
  if (boardClients.size === 0) return 0;
  const payload = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
  let sent = 0;
  for (const session of boardClients) {
    try {
      if (session.closed || session.socket.destroyed) {
        boardClients.delete(session);
        continue;
      }
      if (session.socket.writableLength > BOARD_BACKLOG_LIMIT) {
        boardClients.delete(session);
        logError(`板端订阅客户端积压 ${session.socket.writableLength}B，已移出广播（不影响语音主链路）`);
        continue;
      }
      session.socket.write(payload);
      sent++;
    } catch (e) {
      boardClients.delete(session);
      logError(`板端广播失败: ${redact(e && e.message ? e.message : e)}`);
    }
  }
  return sent;
}

/* ---- 共用分帧 ----
 * 两条 TCP 流都是“JSON 行 + 长度前缀二进制”混排。进入 audio 模式后，用首字节
 * 0x7B（'{'）判断当前是控制行还是 PCM：PCM 分片长度不会达到 JSON 的长度。
 * 解析出错时由各会话自己决定回什么错误并断开，这里只负责切消息。 */
function consumeFrames(session, maxAudioBytes, handlers) {
  for (;;) {
    if (session.audioMode) {
      if (session.buffer.length === 0) return true;
      if (session.buffer[0] === 0x7B) {
        const nl = session.buffer.indexOf(0x0A);
        if (nl < 0) return true;
        const line = session.buffer.subarray(0, nl).toString('utf8').trim();
        session.buffer = session.buffer.subarray(nl + 1);
        if (line.length > 0) handlers.line(line);
        continue;
      }
      if (session.buffer.length < 4) return true;
      const len = session.buffer.readUInt32BE(0);
      if (len <= 0 || len > MAX_CHUNK_BYTES) {
        handlers.bad('BAD_REQUEST', '音频分片长度非法');
        return false;
      }
      if (session.buffer.length < 4 + len) return true;
      const payload = session.buffer.subarray(4, 4 + len);
      session.buffer = session.buffer.subarray(4 + len);
      session.audioBytes += len;
      if (session.audioBytes > maxAudioBytes) {
        session.audioChunks = [];
        session.audioBytes = 0;
        handlers.bad('AUDIO_TOO_LARGE', '录音过长（上限 12 秒）');
        return false;
      }
      session.audioChunks.push(Buffer.from(payload));
      continue;
    }

    const nl = session.buffer.indexOf(0x0A);
    if (nl < 0) {
      if (session.buffer.length > 8192) {
        handlers.bad('BAD_REQUEST', '控制消息过长');
        return false;
      }
      return true;
    }
    const line = session.buffer.subarray(0, nl).toString('utf8').trim();
    session.buffer = session.buffer.subarray(nl + 1);
    if (line.length > 0) handlers.line(line);
  }
}

/** 校验 audio_start；通过时切到录音态并返回采样率，失败返回 0。 */
function startAudioCapture(session, msg, rates, reject) {
  const rate = Number(msg.rate);
  const channels = Number(msg.channels);
  const codec = typeof msg.codec === 'string' ? msg.codec : '';
  if (codec !== 'pcm_s16le' || !rates.includes(rate) || channels !== 1) {
    reject();
    return 0;
  }
  session.audioFormat = { rate, channels, bits: 16 };
  session.audioMode = true;
  session.audioChunks = [];
  session.audioBytes = 0;
  return rate;
}

function takeAudio(session) {
  const pcm = session.audioChunks.length > 0 ? Buffer.concat(session.audioChunks) : Buffer.alloc(0);
  session.audioChunks = [];
  session.audioBytes = 0;
  return pcm;
}

/* ---- 9102 网络音箱 ----
 * ESP32-S3 节点主动连入并登记 node 名。TTS 完成后按目标节点推 16kHz/mono/s16le
 * 原始 PCM；节点播完回 done。音箱故障只影响播报，不影响文字问答。 */
const SPEAKER_PORT = Number(process.env.VOICE_SPEAKER_PORT || 9102);
const speakerClients = new Set();
const SPEAKER_DONE_GRACE_MS = 5000;
let speakerPushSeq = 0;

/** 本次真正会响的节点数。用 speakerClients.size 会把“目标节点掉线、另一块还连着”算成成功。 */
function targetedSpeakers(targetNode) {
  let n = 0;
  for (const sock of speakerClients) {
    if (!targetNode || sock.speakerNode === targetNode) n++;
  }
  return n;
}

/**
 * 按“播放时长 + 宽限”看护 done 回执。超时就判失败并断开该节点，让它重连；
 * 不主动断开的话，半死连接会一直占着“已连接”的假象。
 */
function armSpeakerDoneWatch(sock, seq, bytes) {
  if (sock.pendingTimer) {
    clearTimeout(sock.pendingTimer);
    sock.pendingTimer = null;
  }
  const expectMs = Math.ceil((bytes / 32000) * 1000) + SPEAKER_DONE_GRACE_MS;
  sock.pendingPush = { seq, expectMs, at: Date.now() };
  sock.pendingTimer = setTimeout(() => {
    if (!sock.pendingPush || sock.pendingPush.seq !== seq) return;
    sock.pendingPush = null;
    sock.pendingTimer = null;
    logError(`音箱未回执：node=${sock.speakerNode || '?'} seq=${seq} 期望 ${expectMs}ms 内 done，主动断开等待重连`);
    try { sock.destroy(); } catch (e) { /* 忽略 */ }
  }, expectMs);
}

function pcmFromWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    return null;
  }
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'data') {
      const end = Math.min(off + 8 + size, wav.length);
      return wav.subarray(off + 8, end);
    }
    off += 8 + size + (size & 1);
  }
  return null;
}

function pushClipToSpeakers(clip, targetNode) {
  let sent = 0;
  const line = Buffer.from(JSON.stringify({ type: 'clip', clip: clip }) + String.fromCharCode(10));
  for (const sock of speakerClients) {
    if (targetNode && sock.speakerNode !== targetNode) continue;
    try { sock.write(line); sent++; } catch (e) { speakerClients.delete(sock); }
  }
  if (sent === 0) {
    logError(`本地片段未送达：clip=${clip} target=${targetNode || '全部'} 无可用音箱连接`);
  }
  log('本地片段播报：clip=' + clip + ' 推送到 ' + sent + ' 个节点' + (targetNode ? '（仅 ' + targetNode + '）' : ''));
  return sent;
}

function pushToSpeakers(wav, targetNode) {
  const pcm = pcmFromWav(wav);
  if (!pcm || pcm.length === 0) {
    logError('音箱推送失败：WAV 中没有 PCM 数据');
    return { sent: 0, target: targetNode || '', seq: 0 };
  }
  const targets = [];
  for (const sock of speakerClients) {
    if (!targetNode || sock.speakerNode === targetNode) targets.push(sock);
  }
  if (targets.length === 0) {
    log(`音箱：目标 ${targetNode || '全部'} 当前没有节点连接，跳过本次播报`);
    return { sent: 0, target: targetNode || '', seq: 0 };
  }
  const header = Buffer.from(JSON.stringify({
    type: 'pcm', codec: 'pcm_s16le', rate: 16000, channels: 1, bits: 16, bytes: pcm.length
  }) + '\n');
  const seq = ++speakerPushSeq;
  let sent = 0;
  for (const sock of targets) {
    try {
      sock.write(header);
      sock.write(pcm);
      sent++;
      armSpeakerDoneWatch(sock, seq, pcm.length);
    } catch (e) {
      speakerClients.delete(sock);
      try { sock.destroy(); } catch (e2) { /* 忽略 */ }
    }
  }
  log(`音箱播报：已推送 ${pcm.length}B PCM 到 ${sent} 个节点` +
    (targetNode ? `（仅 ${targetNode}）` : '') + ` seq=${seq}`);
  return { sent, target: targetNode || '', seq };
}

function registerSpeaker(socket, line) {
  let nodeName = '';
  try { nodeName = String(JSON.parse(line).node || ''); } catch (e) { /* 非 hello 忽略 */ }
  if (nodeName) {
    // 同一个 node 重连时丢掉旧 socket，避免重复推送和计数虚高。
    for (const old of speakerClients) {
      if (old !== socket && old.speakerNode === nodeName) {
        speakerClients.delete(old);
        try { old.destroy(); } catch (e) { /* 忽略 */ }
      }
    }
  }
  socket.speakerNode = nodeName;
  speakerClients.add(socket);
  log(`音箱已登记: ${redact(line).slice(0, 160)}`);
}

function handleSpeakerLine(socket, line) {
  if (!speakerClients.has(socket)) {
    registerSpeaker(socket, line);
    return;
  }
  if (!line.includes('"done"')) return;
  if (socket.pendingTimer) {
    clearTimeout(socket.pendingTimer);
    socket.pendingTimer = null;
  }
  socket.pendingPush = null;
  log(`音箱播报完成: ${redact(line).slice(0, 160)}`);
  if (/"ok"\s*:\s*0/.test(line)) {
    logError(`音箱自报播放失败：node=${socket.speakerNode || '?'}（PCM 未写入 I2S）`);
  }
}

const speakerServer = net.createServer((socket) => {
  log(`音箱节点已连接 ${socket.remoteAddress}:${socket.remotePort}`);
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (data) => {
    buf += data;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) handleSpeakerLine(socket, line);
      nl = buf.indexOf('\n');
    }
    if (buf.length > 4096) {
      buf = '';
    }
  });
  socket.on('close', () => {
    if (socket.pendingTimer) {
      clearTimeout(socket.pendingTimer);
      socket.pendingTimer = null;
    }
    socket.pendingPush = null;
    if (speakerClients.delete(socket)) {
      log('音箱节点已断开');
    }
  });
  socket.on('error', (e) => logError(`音箱连接错误: ${redact(e.message)}`));
});
speakerServer.on('error', (e) => {
  logError(`音箱端口 ${SPEAKER_PORT} 监听失败: ${redact(e.message)}（仅影响音箱播报）`);
});
// 空闲时保持 TCP 活跃，避免板端/WiFi 约 30s 后静默断链导致后续播报无声。
setInterval(() => {
  const ping = Buffer.from('{"type":"ping"}' + String.fromCharCode(10));
  for (const sock of speakerClients) {
    try { sock.write(ping); } catch (e) { /* close 事件会清理 */ }
  }
}, 10000).unref();

speakerServer.listen(SPEAKER_PORT, '0.0.0.0', () => {
  log(`音箱服务已启动: 0.0.0.0:${SPEAKER_PORT}`);
});

/* ---- 9302 板端会话 ----
 * DAYU200 的语音查询、文字兜底和只读订阅共用这条连接。语音查询由板端直接
 * 触发；S3 事件则通过 boardClients 广播给页面。 */
class BoardSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.audioMode = false;
    this.audioChunks = [];
    this.audioBytes = 0;
    this.busy = false;
    this.closed = false;
    this.idleTimer = null;
    this.audioFormat = { rate: 16000, channels: 1, bits: 16 };

    boardClients.add(this);
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => {
      logError(`连接错误: ${redact(e.message)}`);
    });
    socket.on('close', () => {
      this.closed = true;
      boardClients.delete(this);
      this.clearIdle();
      log('板端连接已关闭');
    });
    this.resetIdle();
  }

  resetIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (!this.closed) {
        log('空闲超时，关闭连接');
        this.socket.destroy();
      }
    }, IDLE_TIMEOUT_MS);
  }

  clearIdle() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  writeRaw(buf) {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.write(buf, () => resolve());
    });
  }

  sendJson(obj) {
    return this.writeRaw(Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8'));
  }

  sendFrame(payload) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return this.writeRaw(Buffer.concat([header, payload]));
  }

  sendError(code, message) {
    return this.sendJson({ type: 'error', code, message }).catch(() => { });
  }

  onData(data) {
    this.resetIdle();
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    try {
      consumeFrames(this, this.audioFormat.rate * 2 * MAX_AUDIO_SECONDS, {
        line: (line) => this.handleJson(line),
        bad: (code, message) => {
          this.sendError(code, message);
          this.socket.destroy();
        }
      });
    } catch (e) {
      logError(`协议解析失败: ${redact(e.message)}`);
      this.sendError('BAD_REQUEST', '消息格式错误');
      this.socket.destroy();
    }
  }

  handleJson(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this.sendError('BAD_REQUEST', 'JSON 解析失败');
      return;
    }
    const type = msg && typeof msg.type === 'string' ? msg.type : '';
    switch (type) {
      case 'hello':
        log(`握手成功 protocol=${msg.protocol}`);
        this.sendJson({ type: 'ready', protocol: PROTOCOL });
        break;
      case 'ping':
        this.sendJson({ type: 'pong' });
        break;
      case 'audio_start': {
        const rate = startAudioCapture(this, msg, [16000, 44100, 48000], () => {
          this.sendError('BAD_REQUEST', '仅支持 pcm_s16le / 16k|44.1k|48kHz / 单声道');
        });
        if (rate > 0) log(`开始接收录音 (${rate}Hz mono)`);
        break;
      }
      case 'audio_end': {
        this.audioMode = false;
        const pcm = takeAudio(this);
        if (pcm.length < 3200) {
          this.sendError('ASR_FAILED', '录音太短，请按住说完整一句话');
          return;
        }
        this.startQuery(pcm);
        break;
      }
      case 'text_query': {
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (text.length === 0 || text.length > MAX_TEXT_CHARS) {
          this.sendError('BAD_REQUEST', '文字内容为空或过长');
          return;
        }
        const target = typeof msg.target === 'string' ? msg.target.slice(0, 64) : '';
        this.startQuery(text, target);
        break;
      }
      default:
        this.sendError('BAD_REQUEST', `未知消息类型: ${type.slice(0, 32)}`);
    }
  }

  startQuery(payload, targetNode) {
    if (this.busy) {
      this.sendError('BUSY', '上一条问答还在处理，请稍候');
      return;
    }
    this.busy = true;
    const isAudio = Buffer.isBuffer(payload);
    this.handleQuery(payload, isAudio, targetNode || '')
      .catch((e) => {
        logError(`问答异常: ${redact(e && e.message ? e.message : e)}`);
        this.sendError(e && e.code ? e.code : 'INTERNAL', '服务内部错误');
      })
      .finally(() => {
        this.busy = false;
        this.resetIdle();
      });
  }

  async handleQuery(payload, isAudio, targetNode) {
    const started = Date.now();
    try {
      let text;
      if (isAudio) {
        const asr = await this.recognizeAudio(payload);
        if (asr.error) {
          await this.sendError(asr.error, asr.message);
          return;
        }
        text = asr.text;
      } else {
        text = payload;
        log(`文字查询: ${text.length} 字` + (DEBUG_TEXT ? `, text=${text}` : ''));
      }

      if (isElderSafe(text)) {
        log('[elder-safe] 收到自述安全短语');
        await this.acknowledgeSafe(targetNode);
        log('[elder-safe] 已记录，不改变告警状态');
        return;
      }
      if (isHealthConcern(text)) {
        log(`[S3 健康] 文字查询不适：${text}，推本地 clip=9`);
        await this.sendJson({
          type: 'answer', text: HEALTH_TEXT, model: 'safety-rule',
          speakers: targetedSpeakers(targetNode), speakersTotal: speakerClients.size, target: targetNode || ''
        });
        pushClipToSpeakers(9, targetNode || '');
        return;
      }

      await this.answerWithSpeech(text, targetNode, started);
    } catch (e) {
      logError(`问答失败: ${redact(e && e.message ? e.message : e)}`);
      await this.sendError(e && e.code ? e.code : 'INTERNAL', e && e.message ? redact(e.message) : '服务内部错误');
    }
  }

  /** 板端上传的 PCM 落盘、识别，并把识别文本回给本会话；临时文件随后删除。 */
  async recognizeAudio(payload) {
    const wavPath = nextTempWav('asr');
    try {
      fs.writeFileSync(wavPath, wavFromPcm(payload, this.audioFormat.rate));
      if (process.env.VOICE_KEEP_WAV === '1') {
        try {
          const keepDir = path.join(__dirname, '.work');
          fs.mkdirSync(keepDir, { recursive: true });
          const keep = path.join(keepDir, 'last-asr.wav');
          fs.copyFileSync(wavPath, keep);
          log(`[debug] 已保留本次录音: ${keep}`);
        } catch (e) {
          logError(`[debug] 保留录音失败: ${redact(e.message)}`);
        }
      }
      log(`ASR 开始: pcm=${payload.length}B`);
      const started = Date.now();
      const asr = await transcribe(wavPath);
      if (asr.error) {
        logError(`ASR 失败: ${asr.error} (${Date.now() - started}ms)`);
        return asr;
      }
      log(`ASR 完成: ${Date.now() - started}ms, ${asr.text.length} 字` +
        (DEBUG_TEXT ? `, text=${asr.text}` : ''));
      await this.sendJson({ type: 'asr', text: asr.text });
      return { text: asr.text };
    } finally {
      safeUnlink(wavPath);
    }
  }

  async acknowledgeSafe(targetNode) {
    await this.sendJson({ type: 'elder_safe', text: '老人自述安全：我没事' });
    try {
      const ackWav = await synthesize(SAFE_ACK_TEXT);
      const speakers = targetedSpeakers(targetNode);
      await this.sendJson({
        type: 'tts_start', codec: 'wav', bytes: ackWav.length, speakers: speakers,
        speakersTotal: speakerClients.size, target: targetNode || ''
      });
      await this.sendFrame(ackWav);
      await this.sendJson({ type: 'tts_end' });
      pushToSpeakers(ackWav, targetNode);
    } catch (e) {
      logError(`[elder-safe] 播报失败: ${redact(e.message)}`);
    }
  }

  async answerWithSpeech(text, targetNode, started) {
    const dsStarted = Date.now();
    const answer = await askDeepSeek(text);
    log(`DeepSeek 完成: ${Date.now() - dsStarted}ms, ${answer.text.length} 字` +
      (DEBUG_TEXT ? `, answer=${answer.text}` : ''));
    await this.sendJson({
      type: 'answer', text: answer.text, model: answer.model,
      speakers: targetedSpeakers(targetNode), speakersTotal: speakerClients.size, target: targetNode || ''
    });

    const ttsStarted = Date.now();
    let wav;
    try {
      wav = await synthesize(answer.text);
    } catch (e) {
      logError(`TTS 失败: ${redact(e.message)}`);
      await this.sendError(e.code || 'TTS_FAILED', e.message || '语音合成失败');
      return;
    }
    log(`TTS 完成: ${Date.now() - ttsStarted}ms, wav=${wav.length}B`);

    await this.sendJson({
      type: 'tts_start', codec: 'wav', bytes: wav.length,
      speakers: targetedSpeakers(targetNode), speakersTotal: speakerClients.size, target: targetNode || ''
    });
    await this.sendFrame(wav);
    await this.sendJson({ type: 'tts_end' });
    const pushRes = pushToSpeakers(wav, targetNode);
    if (pushRes.sent === 0) {
      logError(`目标音箱未连接：target=${targetNode || '全部'}，本次只有文字回答`);
    }
    log(`问答完成: 总耗时 ${Date.now() - started}ms`);
  }
}

/* ---- 9303 S3 板载咪头 ----
 * S3 只在告警窗口或 micupload 命令时连入，上传 hello + 16k 单声道 PCM。
 * 网关保存一份录音供复盘，然后复用同一套 ASR / DeepSeek / TTS / 音箱推送。 */
const MIC_PORT = Number(process.env.VOICE_MIC_PORT || 9303);
const MIC_KEEP_DIR = path.join(__dirname, '.work', 'recordings');
const MIC_KEEP_MAX = 40;

function saveMicWav(wav, node) {
  try {
    fs.mkdirSync(MIC_KEEP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeNode = String(node || 's3').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
    const file = path.join(MIC_KEEP_DIR, `${safeNode}-${stamp}.wav`);
    fs.writeFileSync(file, wav);
    const files = fs.readdirSync(MIC_KEEP_DIR).filter((f) => f.endsWith('.wav')).sort();
    while (files.length > MIC_KEEP_MAX) {
      try { fs.unlinkSync(path.join(MIC_KEEP_DIR, files.shift())); } catch (e) { /* 忽略 */ }
    }
    return file;
  } catch (e) {
    logError(`保存 S3 录音失败: ${redact(e.message)}`);
    return null;
  }
}

class MicSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.audioMode = false;
    this.audioChunks = [];
    this.audioBytes = 0;
    this.busy = false;
    this.node = '';
    this.room = '';
    this.alarmId = '';
    this.reason = '';
    socket.setNoDelay(true);
    socket.setTimeout(120000, () => {
      log('S3 采音空闲超时，关闭连接');
      socket.destroy();
    });
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => logError(`S3 采音连接错误: ${redact(e.message)}`));
    socket.on('close', () => log(`S3 采音连接已关闭 ${this.node || ''}`));
  }

  sendJson(obj) {
    if (this.socket.destroyed) return;
    this.socket.write(Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8'));
  }

  /** 同时告诉 S3（让它知道结果）和板端页面（让家属看到失败原因）。 */
  reportError(code, message) {
    this.sendJson({ type: 'error', code, message });
    broadcastBoardJson({
      type: 's3_error', code, message: boardText(message),
      node: this.node, room: this.room, at: Date.now()
    });
  }

  onData(data) {
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    try {
      consumeFrames(this, 16000 * 2 * MAX_AUDIO_SECONDS, {
        line: (line) => this.handleLine(line),
        bad: (code, message) => {
          this.sendJson({ type: 'error', code, message });
          this.socket.destroy();
        }
      });
    } catch (e) {
      logError(`S3 采音协议解析失败: ${redact(e.message)}`);
      this.sendJson({ type: 'error', code: 'BAD_REQUEST', message: '消息格式错误' });
      this.socket.destroy();
    }
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this.sendJson({ type: 'error', code: 'BAD_REQUEST', message: 'JSON 解析失败' });
      return;
    }
    const type = msg && typeof msg.type === 'string' ? msg.type : '';
    switch (type) {
      case 'hello':
        this.node = typeof msg.node === 'string' ? msg.node.slice(0, 64) : '';
        this.room = typeof msg.room === 'string' ? msg.room.slice(0, 32) : '';
        this.alarmId = typeof msg.alarmId === 'string' ? msg.alarmId.slice(0, 80) : '';
        this.reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 32) : '';
        log(`[S3 采音] hello node=${this.node || '?'} room=${this.room || '?'} ` +
          `alarmId=${this.alarmId || '-'} reason=${this.reason || '-'}`);
        this.sendJson({ type: 'ready', protocol: PROTOCOL });
        break;
      case 'ping':
        this.sendJson({ type: 'pong' });
        break;
      case 'audio_start': {
        const rate = startAudioCapture(this, msg, [16000], () => {
          this.sendJson({ type: 'error', code: 'BAD_REQUEST', message: '仅支持 pcm_s16le / 16kHz / 单声道' });
        });
        if (rate > 0) log(`[S3 采音] 开始接收 (${rate}Hz mono)`);
        break;
      }
      case 'audio_end': {
        this.audioMode = false;
        const pcm = takeAudio(this);
        if (pcm.length < 3200) {
          this.reportError('ASR_FAILED', '录音太短');
          return;
        }
        this.handle(pcm);
        break;
      }
      default:
        this.sendJson({ type: 'error', code: 'BAD_REQUEST', message: `未知消息类型: ${type.slice(0, 32)}` });
    }
  }

  async handle(pcm) {
    if (this.busy) {
      this.reportError('BUSY', '上一条还在处理');
      return;
    }
    this.busy = true;
    const started = Date.now();
    const wav = wavFromPcm(pcm, 16000);
    const keep = saveMicWav(wav, this.node);
    log(`[S3 录音] node=${this.node || '?'} room=${this.room || '?'} pcm=${pcm.length}B ` +
      `(${(pcm.length / 32000).toFixed(1)}s)` + (keep ? ` file=${keep}` : ''));
    const wavPath = nextTempWav('s3');
    try {
      fs.writeFileSync(wavPath, wav);
      const { asr, elapsed } = await this.recognize(wavPath);
      if (asr.error) {
        logError(`[S3 ASR] 失败: ${asr.error}（${asr.message}）`);
        this.reportError(asr.error, asr.message);
        return;
      }
      log(`[S3 ASR] ${elapsed}ms, text=${asr.text}`);
      this.sendJson({ type: 'asr', text: asr.text });
      broadcastBoardJson({
        type: 's3_asr', text: boardText(asr.text),
        node: this.node, room: this.room, at: Date.now()
      });

      if (isElderSafe(asr.text)) {
        await this.replySafe(asr.text);
        return;
      }
      if (isHealthConcern(asr.text)) {
        this.replyHealth(asr.text);
        return;
      }
      await this.replyAnswer(asr.text, started);
    } catch (e) {
      logError(`[S3 问答] 失败: ${redact(e && e.message ? e.message : e)}`);
      this.sendJson({ type: 'error', code: (e && e.code) || 'INTERNAL', message: '服务内部错误' });
      broadcastBoardJson({
        type: 's3_error', code: (e && e.code) || 'INTERNAL', message: '服务内部错误',
        node: this.node, room: this.room, at: Date.now()
      });
    } finally {
      this.busy = false;
      safeUnlink(wavPath);
    }
  }

  /**
   * 按触发原因选识别语法：health/prompt 先用定向语法，失败再退回自由听写；
   * 疑似“我没事”的短句会再用安全语法确认一次，避免误判。
   */
  async recognize(wavPath) {
    const started = Date.now();
    let asr;
    if (this.reason === 'health') {
      // KEY1 健康短语模式：直接走定向语法，避免自由听写把“我不舒服”听成“女孩后忙”。
      const healthAsr = await transcribe(wavPath, 'health');
      asr = healthAsr.error ? await transcribe(wavPath, 'auto') : healthAsr;
    } else if (this.reason === 'prompt') {
      // 告警后的“安全提示”窗口：用户被明确要求说“没事”，先按安全语法识别，
      // 避免自由听写把“我没事”听成“我们是/我只是”导致 APP 不更新。
      const prompted = await transcribe(wavPath, 'safe');
      asr = (!prompted.error && isElderSafe(prompted.text)) ? prompted
        : await transcribe(wavPath, 'auto');
    } else {
      asr = await transcribe(wavPath, 'auto');
    }
    if (!asr.error && !isElderSafe(asr.text) && looksLikeSafeCandidate(asr.text)) {
      const safeTry = await transcribe(wavPath, 'safe');
      if (!safeTry.error && isElderSafe(safeTry.text)) {
        log(`[S3 ASR] 安全短语二次识别: ${asr.text} -> ${safeTry.text}（conf=${safeTry.confidence}）`);
        asr = safeTry;
      }
    }
    return { asr, elapsed: Date.now() - started };
  }

  async replySafe(text) {
    log('[elder-safe] S3 自述安全：只记录，不 ACK 告警');
    // 云端上报不 await：手机 APP 尽快看到，失败也不影响播报。
    reportElderSafe({
      deviceId: this.node,
      room: this.room,
      alarmId: this.alarmId || '',
      text: text,
      at: Date.now(),
      source: 's3-mic'
    });
    // 板端只读页先看到“自述安全”，再等 TTS，避免 2 秒窗口被合成耗时拖慢。
    broadcastBoardJson({
      type: 's3_safe', text: '老人自述安全：我没事', speakers: targetedSpeakers(this.node), speakersTotal: speakerClients.size,
      node: this.node, room: this.room, alarmId: this.alarmId || '', at: Date.now()
    });
    try {
      // 给 S3 留出 mic_end 恢复 ES8388 播放通路的时间，避免回执 PCM 被静默丢弃。
      await new Promise(resolve => setTimeout(resolve, 600));
      const ackWav = await synthesize(SAFE_ACK_TEXT);
      this.sendJson({
        type: 'elder_safe', text: '老人自述安全：我没事', speakers: targetedSpeakers(this.node), speakersTotal: speakerClients.size
      });
      pushToSpeakers(ackWav, this.node);
      log('[elder-safe] 已记录，不改变告警状态');
    } catch (e) {
      logError(`[elder-safe] 播报失败: ${redact(e.message)}`);
      this.reportError(e.code || 'TTS_FAILED', e.message || '播报失败');
    }
  }

  replyHealth(text) {
    log(`[S3 健康] 识别到不适：${text}，按安全建议回复`);
    // 必须先发 clip：S3 read_responses() 收到 answer 会立即 return，后面的 clip 会丢。
    this.sendJson({ type: 'clip', clip: 9 });
    this.sendJson({
      type: 'answer', text: HEALTH_TEXT, model: 'safety-rule',
      speakers: targetedSpeakers(this.node), speakersTotal: speakerClients.size
    });
    broadcastBoardJson({
      type: 's3_answer', text: boardText(HEALTH_TEXT), model: 'safety-rule',
      speakers: targetedSpeakers(this.node), speakersTotal: speakerClients.size, node: this.node, room: this.room, at: Date.now()
    });
    log('[S3 健康] 已先发 clip=9，再发 answer（S3 本板播放）');
  }

  async replyAnswer(text, started) {
    const answer = await askDeepSeek(text);
    this.sendJson({
      type: 'answer', text: answer.text, model: answer.model,
      speakers: targetedSpeakers(this.node), speakersTotal: speakerClients.size
    });
    broadcastBoardJson({
      type: 's3_answer', text: boardText(answer.text), model: answer.model,
      speakers: targetedSpeakers(this.node), speakersTotal: speakerClients.size, node: this.node, room: this.room, at: Date.now()
    });
    try {
      const wavOut = await synthesize(answer.text);
      pushToSpeakers(wavOut, this.node);
    } catch (e) {
      logError(`[S3 问答] TTS 失败: ${redact(e.message)}`);
      this.reportError(e.code || 'TTS_FAILED', e.message || '语音合成失败');
    }
    log(`[S3 问答] 完成: 总耗时 ${Date.now() - started}ms`);
  }
}

const micServer = net.createServer((socket) => {
  log(`S3 采音节点已连接 ${socket.remoteAddress}:${socket.remotePort}`);
  new MicSession(socket);
});
micServer.on('error', (e) => {
  logError(`S3 采音端口 ${MIC_PORT} 监听失败: ${redact(e.message)}（仅影响告警录音上传）`);
});
micServer.listen(MIC_PORT, '0.0.0.0', () => {
  log(`S3 采音服务已启动: 0.0.0.0:${MIC_PORT}`);
});

const server = net.createServer((socket) => {
  log(`板端已连接 ${socket.remoteAddress}:${socket.remotePort}`);
  new BoardSession(socket);
});

server.on('error', (e) => {
  logError(`监听失败: ${redact(e.message)}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`语音网关已启动: ${HOST}:${PORT}（协议 v${PROTOCOL}）`);
  log('提示：板子重插/重启后需重新执行 hdc rport tcp:9302 tcp:9302');
});
