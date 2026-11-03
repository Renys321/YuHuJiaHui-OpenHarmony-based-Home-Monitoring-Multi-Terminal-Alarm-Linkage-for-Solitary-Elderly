'use strict';

/**
 * test-mic-client.js — 模拟 S3 板载咪头连到网关 9303，验证采音协议与 ASR 链路。
 *
 * 用法:
 *   node test-mic-client.js <wav> [node] [room] [host] [port]
 *   wav 必须是 16kHz/mono/16bit（tts.ps1 默认就是）。
 *
 * 只做本地联调：不发 DeepSeek Key，不写业务文件。
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const wavPath = process.argv[2];
const nodeName = process.argv[3] || 's3-simulator';
const room = process.argv[4] || '联调';
const host = process.argv[5] || '127.0.0.1';
const port = Number(process.argv[6] || 9303);

if (!wavPath) {
  console.error('用法: node test-mic-client.js <wav> [node] [room] [host] [port]');
  process.exit(2);
}

function readWavPcm(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22)
      };
    }
    if (id === 'data') {
      return { fmt, pcm: buf.subarray(off + 8, Math.min(off + 8 + size, buf.length)) };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('WAV 中没有 data 分块');
}

const { fmt, pcm } = readWavPcm(wavPath);
if (!fmt || fmt.rate !== 16000 || fmt.channels !== 1 || fmt.bits !== 16) {
  console.error(`需要 16kHz/mono/16bit，实际 ${JSON.stringify(fmt)}`);
  process.exit(2);
}

const socket = net.connect(port, host, () => {
  socket.setNoDelay(true);
  socket.write(`${JSON.stringify({ type: 'hello', role: 'mic', node: nodeName, room })}\n`);
  socket.write(`${JSON.stringify({ type: 'audio_start', rate: 16000, channels: 1, codec: 'pcm_s16le' })}\n`);
  const chunk = 640; // 320 samples = 20 ms
  for (let off = 0; off < pcm.length; off += chunk) {
    const payload = pcm.subarray(off, Math.min(off + chunk, pcm.length));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(header);
    socket.write(payload);
  }
  socket.write('{"type":"audio_end"}\n');
  console.log(`已上传 ${(pcm.length / 32000).toFixed(2)}s PCM -> ${host}:${port}`);
});

let buf = '';
let settled = false;
function finish(why) {
  if (settled) return;
  settled = true;
  console.log(`结束: ${why}`);
  socket.destroy();
  setTimeout(() => process.exit(0), 50);
}

const timer = setTimeout(() => finish('35s 超时'), 35000);
timer.unref();

socket.on('data', (d) => {
  buf += d.toString('utf8');
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      console.log(`<- ${line}`);
      if (line.includes('"elder_safe"') || line.includes('"answer"') || line.includes('"error"')) {
        setTimeout(() => finish('收到终止回执'), 100);
      }
    }
    nl = buf.indexOf('\n');
  }
});
socket.on('error', (e) => finish(`连接错误: ${e.message}`));
socket.on('close', () => finish('网关关闭连接'));
console.log(`WAV: ${path.basename(wavPath)} ${(pcm.length / 32000).toFixed(2)}s`);
