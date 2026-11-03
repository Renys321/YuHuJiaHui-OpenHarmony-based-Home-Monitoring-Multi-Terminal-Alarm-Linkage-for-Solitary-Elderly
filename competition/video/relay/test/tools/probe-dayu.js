#!/usr/bin/env node
'use strict';

/**
 * 真实 DAYU200 探针：直接按契约 §1 与 board VideoStreamServer 握手并统计真实帧。
 *
 * 用途：在 relay 联调前证明“板端服务在、协议对、帧是真 JPEG、分辨率 640x480”。
 * 不经过 relay，不写任何文件；12 秒左右结束并主动 stop（不多占相机）。
 *
 * 用法:
 *   node test/tools/probe-dayu.js [--host 127.0.0.1] [--port 9301] [--frames 30] [--timeout-ms 20000]
 */

const net = require('net');
const crypto = require('crypto');
const { createFrameParser, isJpeg } = require('../../src/frames');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

/** 从 JPEG 的 SOF 段读宽高（只处理到 SOS 之前）。 */
function jpegDimensions(buffer) {
  if (!isJpeg(buffer)) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xda) return null; // SOS 之前没找到 SOF
    offset += 2 + length;
  }
  return null;
}

function main() {
  const host = argValue('--host', '127.0.0.1');
  const port = Number(argValue('--port', '9301'));
  const framesTarget = Number(argValue('--frames', '30'));
  const timeoutMs = Number(argValue('--timeout-ms', '20000'));

  const frames = [];
  const result = { ok: false, hello: null, error: null };
  const startedAt = Date.now();
  let firstFrameAt = 0;
  let startedAtMarker = 0;
  let lineBuffer = Buffer.alloc(0);
  let started = false;
  let finished = false;

  const socket = net.connect({ host, port });
  socket.setNoDelay(true);
  const connectTimer = setTimeout(() => finish(new Error('connect timeout')), 3000);
  const overallTimer = setTimeout(() => finish(new Error(`overall timeout (${timeoutMs}ms)`)), timeoutMs);

  const parser = createFrameParser((frame) => {
    if (!isJpeg(frame)) {
      finish(new Error('收到非 JPEG 帧'));
      return;
    }
    if (frames.length === 0) firstFrameAt = Date.now();
    frames.push(frame);
    if (frames.length >= framesTarget) finish(null);
  }, (error) => finish(error));

  function send(object) {
    if (socket.writable) socket.write(`${JSON.stringify(object)}\n`);
  }

  function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(connectTimer);
    clearTimeout(overallTimer);
    if (error) result.error = error.message;
    // 主动 stop（契约要求正常 stop 回 stopped；这里等 400ms 或直接断开）。
    if (socket.writable) {
      try {
        socket.write('{"type":"stop"}\n');
      } catch (_) {
        // ignore
      }
    }
    setTimeout(() => {
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
      report();
    }, 400);
  }

  function report() {
    const elapsed = Date.now() - startedAt;
    const sizes = frames.map((frame) => frame.length);
    const hashes = new Set(frames.map((frame) => crypto.createHash('sha256').update(frame).digest('hex')));
    const dimensions = frames.length > 0 ? jpegDimensions(frames[0]) : null;
    const fpsWindowMs = Math.max(1, (frames.length > 0 ? Date.now() - firstFrameAt : elapsed));
    result.ok = frames.length >= framesTarget
      && hashes.size === frames.length
      && dimensions !== null
      && dimensions.width === 640
      && dimensions.height === 480;
    result.realDayu = true;
    result.host = `${host}:${port}`;
    result.frames = frames.length;
    result.framesTarget = framesTarget;
    result.elapsedMs = elapsed;
    result.startLatencyMs = startedAtMarker && frames.length > 0 ? firstFrameAt - startedAtMarker : null;
    result.fps = Number((frames.length / (fpsWindowMs / 1000)).toFixed(2));
    result.sizeMin = sizes.length ? Math.min(...sizes) : 0;
    result.sizeMax = sizes.length ? Math.max(...sizes) : 0;
    result.sizeAvg = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
    result.uniqueFrameHashes = hashes.size;
    result.dimensions = dimensions;
    result.jpegHeaderTailOk = frames.every((frame) => isJpeg(frame));
    console.log(`[probe-real-dayu] ${JSON.stringify(result, null, 2)}`);
    process.exit(result.ok ? 0 : 1);
  }

  socket.on('connect', () => {
    clearTimeout(connectTimer);
  });
  socket.on('data', (chunk) => {
    if (started) {
      parser.push(chunk);
      return;
    }
    lineBuffer = Buffer.concat([lineBuffer, chunk]);
    let newline;
    while (!started && (newline = lineBuffer.indexOf(0x0a)) >= 0) {
      const line = lineBuffer.subarray(0, newline).toString('utf8').trim();
      lineBuffer = lineBuffer.subarray(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (message.type === 'hello') {
        result.hello = message;
        send({ type: 'start', viewer: 'smoke-probe' });
      } else if (message.type === 'started') {
        started = true;
        startedAtMarker = Date.now();
        if (lineBuffer.length > 0) parser.push(lineBuffer);
        lineBuffer = Buffer.alloc(0);
      } else if (message.type === 'busy') {
        finish(new Error('DAYU busy: 另一个客户端持有视频流'));
      }
    }
  });
  socket.on('error', (error) => finish(error));
  socket.on('close', () => {
    if (!finished) finish(new Error(`socket closed after ${frames.length} frames`));
  });
}

main();
