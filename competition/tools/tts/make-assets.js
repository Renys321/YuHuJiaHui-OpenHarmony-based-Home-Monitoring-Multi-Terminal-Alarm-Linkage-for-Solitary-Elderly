'use strict';

/**
 * tools/tts/make-assets.js — 生成并校验五段预置语音资源
 *
 * 用法：
 *   node tools/tts/make-assets.js --build          # 编译本地工具（Media Foundation 解码器）
 *   node tools/tts/make-assets.js --check          # 只校验现有资源（CI 友好）
 *   node tools/tts/make-assets.js --synth-online   # ★推荐：无密钥在线 TTS -> 解码 -> 校验 -> 写入
 *   node tools/tts/make-assets.js --synth          # （不可用）旧的 SAPI 路线，本机会崩进程
 *   node tools/tts/make-assets.js --force          # 允许覆盖已存在的资源（配合 --synth-online）
 *
 * 路线说明（为什么默认是 --synth-online）：
 *   本机 Windows SAPI（ISpVoice::Speak / System.Speech）在任何输出目标下都会以
 *   0xC0000005 崩进程，无法用于合成。因此本工具的主路线是：
 *     百度翻译网页版无密钥语音端点（audio/mpeg）
 *       -> tools/tts/mp3-to-pcm.exe（系统自带 Windows Media Foundation 解码）
 *       -> tools/tts/wav.js（解析 + 归一化 + 质量校验）
 *       -> 写入 northbound/entry/src/main/resources/rawfile/
 *
 * 绝不伪造资产：不复制 sos.wav、不生成静音/纯音/空文件；五段必须各自通过校验且哈希互不相同。
 * 任一环节失败即整体失败，且**不写入任何文件**（全有或全无）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { normalizeWav, validateVoiceAsset, readWav } = require('./wav');
const online = require('./online-tts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RAWFILE_DIR = path.join(REPO_ROOT, 'northbound', 'entry', 'src', 'main', 'resources', 'rawfile');
const WORK_DIR = path.join(REPO_ROOT, '.tts-work');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const EXE = path.join(__dirname, 'synth-wav.exe');
const SOURCE = path.join(__dirname, 'synth-wav.cs');
const MP3_DECODER_SOURCE = path.join(__dirname, 'mp3-to-pcm.cs');
const MP3_DECODER_EXE = path.join(__dirname, 'mp3-to-pcm.exe');
const VOICE = process.env.TTS_VOICE || 'Microsoft Huihui Desktop';
const RATE = process.env.TTS_RATE || '-1';

/** 五段预置语音的文本（与 cloud/backend/src/comms-core.js 的 VOICE_MAP 语义一致）。 */
const ASSETS = online.SENTENCES.map((item) => ({
  file: item.file,
  voiceId: item.voiceId,
  text: item.text
}));

/** 给 PowerShell 脚本补 UTF-8 BOM（PS 5.1 无 BOM 时按 ANSI 解码会破坏中文）。 */
function ensureUtf8Bom(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const bytes = fs.readFileSync(filePath);
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return true;
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), bytes]));
  return true;
}

/** 编译一个 C# 源文件为 exe（不做 unblock：exe 由本工具生成，不受来源标记影响）。 */
function compile(sourcePath, outputPath, extraArgs = []) {
  if (!fs.existsSync(CSC)) {
    console.error(`找不到 csc.exe：${CSC}`);
    return 1;
  }
  if (!fs.existsSync(sourcePath)) {
    console.error(`找不到源文件：${sourcePath}`);
    return 1;
  }
  const result = spawnSync(CSC,
    ['/nologo', '/target:exe', `/out:${outputPath}`, '/platform:x64', sourcePath, ...extraArgs],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status === 0 ? 0 : 1;
}

/** 编译本地工具链。 */
function build() {
  let failures = 0;

  // 1) Media Foundation MP3 解码器（在线 TTS 路线的必需件）
  if (compile(MP3_DECODER_SOURCE, MP3_DECODER_EXE) === 0) {
    console.log(`已编译 ${path.relative(REPO_ROOT, MP3_DECODER_EXE)}`);
  } else {
    console.error('编译 mp3-to-pcm.exe 失败');
    failures += 1;
  }

  // 2) 旧的 SAPI 合成器（本机不可用，但保留以便在别的机器上使用）
  if (compile(SOURCE, EXE, []) === 0) {
    console.log(`已编译 ${path.relative(REPO_ROOT, EXE)}（SAPI 路线，本机不可用）`);
  } else {
    console.error('编译 synth-wav.exe 失败');
    failures += 1;
  }

  // 3) PowerShell 驱动脚本必须有 BOM
  if (ensureUtf8Bom(path.join(__dirname, 'offline-synth.ps1'))) {
    console.log('已确保 tools/tts/offline-synth.ps1 为 UTF-8 with BOM');
  }

  return failures === 0 ? 0 : 1;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 校验现有资源（CI 友好）。 */
function check() {
  let failures = 0;
  let present = 0;
  const digests = new Map();

  for (const asset of ASSETS) {
    const target = path.join(RAWFILE_DIR, asset.file);
    if (!fs.existsSync(target)) {
      console.log(`${asset.file}: MISSING`);
      failures += 1;
      continue;
    }
    present += 1;
    const buffer = fs.readFileSync(target);
    const result = validateVoiceAsset(buffer);
    if (!result.ok) {
      console.log(`${asset.file}: INVALID -> ${result.problems.join('; ')}`);
      failures += 1;
      continue;
    }
    const digest = sha256(buffer);
    if (digests.has(digest)) {
      console.log(`${asset.file}: DUPLICATE of ${digests.get(digest)}（不允许复制同一段音频）`);
      failures += 1;
      continue;
    }
    digests.set(digest, asset.file);
    console.log(`${asset.file}: OK ${result.info.sampleRate}Hz ${result.info.channels}ch ` +
      `${result.info.bitsPerSample}bit ${result.info.durationSeconds.toFixed(2)}s ` +
      `rms=${result.info.rms.toFixed(4)} bytes=${buffer.length} sha256=${digest}`);
  }

  if (present === 0) {
    console.log('\nAUDIO ASSETS BLOCKED: 五个预置语音均不存在。请运行 --synth-online。');
  } else if (present < ASSETS.length) {
    console.log(`\nAUDIO ASSETS INCOMPLETE: 只存在 ${present}/${ASSETS.length} 个。`);
  }
  return failures === 0 ? 0 : 1;
}

/** 旧的 SAPI 路线（本机会崩进程，保留以便在别的机器上使用）。 */
function synth() {
  if (!fs.existsSync(EXE)) {
    console.error('尚未编译 synth-wav.exe，请先运行 --build');
    return 1;
  }
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const staged = [];
  for (const asset of ASSETS) {
    const raw = path.join(WORK_DIR, `sapi-${asset.file}`);
    const result = spawnSync(EXE, [VOICE, RATE, raw, asset.text], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
    });
    if (result.status !== 0 || !fs.existsSync(raw)) {
      console.error(`${asset.file}: 合成失败 (exit=${result.status}, signal=${result.signal})`);
      if (result.stderr) process.stderr.write(result.stderr);
      console.error('\nAUDIO ASSETS BLOCKED: 本机 SAPI 无法合成语音，未写入任何资源。');
      console.error('请改用：node tools/tts/make-assets.js --synth-online');
      return 1;
    }
    const { buffer, info } = normalizeWav(fs.readFileSync(raw), 16000);
    const validation = validateVoiceAsset(buffer);
    if (!validation.ok) {
      console.error(`${asset.file}: 归一化后校验失败 -> ${validation.problems.join('; ')}`);
      return 1;
    }
    staged.push({ asset, buffer, info, validation });
    fs.rmSync(raw, { force: true });
    console.log(`${asset.file}: 合成完成 ${info.sourceRate}Hz -> 16000Hz, ` +
      `${validation.info.durationSeconds.toFixed(2)}s, rms=${validation.info.rms.toFixed(4)}`);
  }
  return commit(staged);
}

/** 在线路线：引擎 -> Media Foundation 解码 -> 校验 -> 写入。 */
async function synthOnline(options = {}) {
  const force = options.force === true;

  const existing = ASSETS.filter((asset) => fs.existsSync(path.join(RAWFILE_DIR, asset.file)));
  if (existing.length > 0 && !force) {
    console.error(`已存在 ${existing.length} 个资源（${existing.map((item) => item.file).join(', ')}）；` +
      '如需覆盖请加 --force');
    return 1;
  }

  if (!fs.existsSync(MP3_DECODER_EXE)) {
    console.error(`缺少解码器 ${path.relative(REPO_ROOT, MP3_DECODER_EXE)}，请先运行 --build`);
    return 1;
  }

  const probe = await online.probeEngine({ attempts: 2 });
  if (!probe.ok) {
    console.error(`AUDIO ENGINE UNREACHABLE: ${probe.reason}`);
    console.error('未写入任何资源（不使用 SAPI 兜底，也不伪造音频）。');
    return 1;
  }
  console.log(`引擎可用：${online.ENGINE.name}（${probe.status}, ${probe.contentType}, ${probe.bytes} 字节）`);

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const staged = [];
  for (const asset of ASSETS) {
    const result = await online.synthesizeOne(asset, { workDir: WORK_DIR });
    if (!result.ok) {
      console.error(`${asset.file}: 合成失败 -> ${result.reason}`);
      console.error('\nAUDIO ASSETS BLOCKED: 未写入任何资源。');
      return 1;
    }
    staged.push({ asset, buffer: result.buffer, validation: { ok: true, info: result.info } });
    console.log(`${asset.file}: 合成完成 16000Hz 1ch 16bit ` +
      `${result.info.durationSeconds.toFixed(2)}s rms=${result.info.rms.toFixed(4)} ` +
      `bytes=${result.buffer.length}`);
  }

  // 五个哈希必须互不相同
  const digests = new Map();
  for (const item of staged) {
    const digest = sha256(item.buffer);
    if (digests.has(digest)) {
      console.error(`${item.asset.file}: 与 ${digests.get(digest)} 完全相同，拒绝写入（不允许复制音频）`);
      return 1;
    }
    digests.set(digest, item.asset.file);
  }

  return commit(staged);
}

/**
 * 事务式提交：先在目标卷内写完全部临时文件，再备份旧文件并逐个原子重命名。
 * 任一步失败都会删除新文件并恢复备份，避免留下半套资源。
 */
function commit(staged, options = {}) {
  const io = options.fsImpl || fs;
  const targetDir = options.targetDir || RAWFILE_DIR;
  const transactionId = crypto.randomBytes(8).toString('hex');
  const stageDir = path.join(targetDir, `.tts-stage-${transactionId}`);
  const backupDir = path.join(targetDir, `.tts-backup-${transactionId}`);
  const installed = [];
  const backups = [];

  try {
    io.mkdirSync(targetDir, { recursive: true });
    io.mkdirSync(stageDir, { recursive: false });
    io.mkdirSync(backupDir, { recursive: false });

    for (const item of staged) {
      io.writeFileSync(path.join(stageDir, item.asset.file), item.buffer, { flag: 'wx' });
    }

    for (const item of staged) {
      const target = path.join(targetDir, item.asset.file);
      if (io.existsSync(target)) {
        const backup = path.join(backupDir, item.asset.file);
        io.renameSync(target, backup);
        backups.push({ target, backup });
      }
    }

    for (const item of staged) {
      const target = path.join(targetDir, item.asset.file);
      io.renameSync(path.join(stageDir, item.asset.file), target);
      installed.push(target);
    }

    for (const item of staged) {
      const target = path.join(targetDir, item.asset.file);
      console.log(`已写入 ${path.relative(REPO_ROOT, target)} (${item.buffer.length} 字节, sha256=${sha256(item.buffer)})`);
    }
    console.log(`\n共写入 ${staged.length} 个资源；请运行 --check 复核。`);
    return 0;
  } catch (error) {
    for (const target of installed.reverse()) {
      try { if (io.existsSync(target)) io.rmSync(target, { force: true }); } catch (_) { /* best effort */ }
    }
    for (const item of backups.reverse()) {
      try { if (io.existsSync(item.backup)) io.renameSync(item.backup, item.target); } catch (_) { /* best effort */ }
    }
    console.error(`音频资源事务提交失败：${error && error.code ? error.code : 'write_error'}；已回滚旧资源。`);
    return 1;
  } finally {
    try { if (io.existsSync(stageDir)) io.rmSync(stageDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    try { if (io.existsSync(backupDir)) io.rmSync(backupDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

function usage() {
  console.error('usage: node tools/tts/make-assets.js [--build|--check|--synth-online|--synth] [--force]');
}

async function main(argv) {
  if (argv.includes('--build')) return build();
  if (argv.includes('--check')) return check();
  if (argv.includes('--synth-online')) return synthOnline({ force: argv.includes('--force') });
  if (argv.includes('--synth')) return synth();
  usage();
  return 64;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error('make-assets failed: ' + (error && error.name ? error.name : 'error'));
      process.exitCode = 1;
    });
}

module.exports = { ASSETS, RAWFILE_DIR, WORK_DIR, ensureUtf8Bom, build, check, synth, synthOnline, commit, main, sha256, readWav };
