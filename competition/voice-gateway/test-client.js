'use strict';

/**
 * 不接板子也能验证网关：
 *   node test-client.js --wav D:\tmp\question.wav [--out answer.wav]
 *   node test-client.js --text "我有点头晕怎么办" [--out answer.wav]
 *   node test-client.js --selftest          # 用本机 Huihui 合成一句问题再走完整链路
 *
 * 打印 ASR 文本、DeepSeek 回答，并把回答 WAV 保存到 --out（默认 ./out/answer-<ts>.wav）。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 9302;
const TIMEOUT_MS = 45000;

function parseArgs(argv) {
  const out = { wav: '', text: '', out: '', selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--wav' && argv[i + 1]) { out.wav = argv[i + 1]; i += 1; }
    else if (a === '--text' && argv[i + 1]) { out.text = argv[i + 1]; i += 1; }
    else if (a === '--out' && argv[i + 1]) { out.out = argv[i + 1]; i += 1; }
    else if (a === '--selftest') { out.selftest = true; }
  }
  return out;
}

function defaultOutPath() {
  const dir = path.join(__dirname, 'out');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `answer-${Date.now()}.wav`);
}

function synthesizeQuestion(text) {
  const workDir = path.join(__dirname, '.work');
  fs.mkdirSync(workDir, { recursive: true });
  const wav = path.join(workDir, `question-${Date.now()}.wav`);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'tts.ps1'), '-Text', text, '-OutPath', wav
    ], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('close', () => {
      if (fs.existsSync(wav)) resolve(wav);
      else reject(new Error(`TTS 生成问题失败: ${out.trim()}`));
    });
    child.on('error', reject);
  });
}

function frame(data) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  return Buffer.concat([header, data]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let wavPath = args.wav;
  const outPath = args.out || defaultOutPath();

  if (args.selftest && !wavPath) {
    wavPath = await synthesizeQuestion('我有点头晕怎么办');
    console.log(`[selftest] 已合成问题 WAV: ${wavPath}`);
  }
  if (!wavPath && !args.text) {
    console.error('用法: node test-client.js --wav <file> | --text <text> | --selftest');
    process.exit(2);
  }
  if (wavPath && !fs.existsSync(wavPath)) {
    console.error(`找不到 WAV: ${wavPath}`);
    process.exit(2);
  }

  const pcm = wavPath ? fs.readFileSync(wavPath).subarray(44) : null;
  const socket = net.connect({ host: HOST, port: PORT });
  let buffer = Buffer.alloc(0);
  // tts_start 给出下一帧字节数；等待 WAV 期间若先收到 JSON 行，先按控制行处理。
  let waitingWav = 0;
  let wavParts = [];
  let finished = false;

  const timer = setTimeout(() => {
    if (!finished) {
      console.error('[x] 45 秒内未完成');
      socket.destroy();
      process.exit(1);
    }
  }, TIMEOUT_MS);

  function send(obj) {
    socket.write(`${JSON.stringify(obj)}\n`);
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { socket.end(); } catch (e) { }
    setTimeout(() => process.exit(code), 100);
  }

  socket.on('connect', () => {
    console.log(`已连接 ${HOST}:${PORT}`);
    send({ type: 'hello', protocol: 1 });
  });

  socket.on('error', (e) => {
    console.error(`[x] 连接失败: ${e.message}`);
    console.error('  请确认已执行 hdc rport tcp:9302 tcp:9302 并启动 server.js');
    finish(1);
  });

  socket.on('close', () => {
    if (!finished) finish(0);
  });

  // 文本行和二进制帧共用一条 TCP 流，按状态切分，不能依赖单次 data 的边界。
  socket.on('data', (d) => {
    buffer = Buffer.concat([buffer, d]);
    for (;;) {
      if (waitingWav > 0) {
        if (buffer.length < 4) return;
        if (buffer[0] === 0x7B) {
          const nl = buffer.indexOf(0x0A);
          if (nl < 0) return;
          const line = buffer.subarray(0, nl).toString('utf8').trim();
          buffer = buffer.subarray(nl + 1);
          waitingWav = 0;
          handleJson(JSON.parse(line));
          continue;
        }
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) return;
        wavParts.push(Buffer.from(buffer.subarray(4, 4 + len)));
        buffer = buffer.subarray(4 + len);
        waitingWav = 0;
        fs.writeFileSync(outPath, Buffer.concat(wavParts));
        console.log(`[ok] 回答音频已保存: ${outPath} (${fs.statSync(outPath).size} B)`);
        continue;
      }
      const nl = buffer.indexOf(0x0A);
      if (nl < 0) return;
      const line = buffer.subarray(0, nl).toString('utf8').trim();
      buffer = buffer.subarray(nl + 1);
      if (line.length > 0) handleJson(JSON.parse(line));
    }
  });

  function handleJson(msg) {
    if (msg.type === 'ready') {
      console.log('[ok] 握手成功');
      if (pcm) {
        send({ type: 'audio_start', codec: 'pcm_s16le', rate: 16000, channels: 1 });
        const chunk = 3200;
        for (let off = 0; off < pcm.length; off += chunk) {
          socket.write(frame(pcm.subarray(off, Math.min(off + chunk, pcm.length))));
        }
        send({ type: 'audio_end' });
        console.log(`[send] 已发送 PCM ${pcm.length} B`);
      } else {
        send({ type: 'text_query', text: args.text });
        console.log(`[send] 已发送文字: ${args.text}`);
      }
    } else if (msg.type === 'asr') {
      console.log(`ASR: ${msg.text}`);
    } else if (msg.type === 'answer') {
      console.log(`回答(${msg.model}): ${msg.text}`);
    } else if (msg.type === 'elder_safe') {
      console.log(`自述安全(${msg.text})，不 ACK 告警`);
    } else if (msg.type === 'tts_start') {
      waitingWav = msg.bytes;
      wavParts = [];
    } else if (msg.type === 'tts_end') {
      console.log('[ok] 语音回答接收完成');
      finish(0);
    } else if (msg.type === 'error') {
      console.error(`[x] 服务端错误 [${msg.code}] ${msg.message}`);
      finish(1);
    }
  }
}

main().catch((e) => {
  console.error(`[x] ${e.message}`);
  process.exit(1);
});
