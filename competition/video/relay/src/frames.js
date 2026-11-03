'use strict';

/**
 * DAYU200 VideoStreamServer 帧协议编解码（契约 §1）。
 *
 * TCP 线格式：4 字节大端无符号整数 N（4096 <= N <= 1048576）+ N 字节 JPEG。
 * 本模块只做字节层；控制行（hello/start/started/stop/stopped）在 dayu-link.js。
 */

const MIN_FRAME_BYTES = 1024; // 演示机位：暗场景/无人时 JPEG 可能只有 2–3KB，4096 会全部丢弃
const MAX_FRAME_BYTES = 1048576;

function encodeFrame(jpegBuffer) {
  const jpeg = Buffer.isBuffer(jpegBuffer) ? jpegBuffer : Buffer.from(jpegBuffer);
  if (jpeg.length < MIN_FRAME_BYTES || jpeg.length > MAX_FRAME_BYTES) {
    throw new Error(`frame length ${jpeg.length} outside ${MIN_FRAME_BYTES}..${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(jpeg.length, 0);
  return Buffer.concat([header, jpeg]);
}

function isJpeg(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  return buffer[0] === 0xff && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

/**
 * 增量帧解析器：任意切分的 TCP 数据块都能还原成完整 JPEG。
 * 协议损坏（长度越界）时回调 onError 并重置缓冲，避免把后续字节整体错位。
 */
function createFrameParser(onFrame, onError) {
  let pending = Buffer.alloc(0);

  function reset() {
    pending = Buffer.alloc(0);
  }

  function push(chunk) {
    if (!chunk || chunk.length === 0) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? incoming : Buffer.concat([pending, incoming]);

    for (;;) {
      if (pending.length < 4) return;
      const declared = pending.readUInt32BE(0);
      if (declared < MIN_FRAME_BYTES || declared > MAX_FRAME_BYTES) {
        const error = new Error(`invalid frame length ${declared}`);
        reset();
        if (typeof onError === 'function') onError(error);
        return;
      }
      if (pending.length < 4 + declared) return;
      const frame = pending.subarray(4, 4 + declared);
      pending = pending.subarray(4 + declared);
      onFrame(frame);
    }
  }

  return { push, reset, get bufferedBytes() { return pending.length; } };
}

module.exports = {
  MIN_FRAME_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
  isJpeg,
  createFrameParser
};
