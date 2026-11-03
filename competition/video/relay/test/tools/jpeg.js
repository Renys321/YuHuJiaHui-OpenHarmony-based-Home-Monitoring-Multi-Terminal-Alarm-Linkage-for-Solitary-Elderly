'use strict';

/**
 * 合成 JPEG 帧（仅测试用）。
 *
 * 基图是 Pillow 生成的 640x480 彩色渐变图，图片上直接写着
 * "FAKE DAYU FRAME SOURCE (TEST ONLY)"，避免被误当成真实摄像头画面。
 * 每帧在 EOI 前插入一个 COM 段携带帧号，因此**每帧字节都不同**（可用来
 * 证明 relay 没有把同一张静态图重复发送，也可在证据里一眼标出 FAKE）。
 */

const fs = require('fs');
const path = require('path');
const { encodeFrame, isJpeg } = require('../../src/frames');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-dayu-base.jpg');
const BASE = fs.readFileSync(FIXTURE);
if (!isJpeg(BASE)) throw new Error(`fake fixture is not a JPEG: ${FIXTURE}`);

const EOI = BASE.subarray(BASE.length - 2);
const BODY = BASE.subarray(0, BASE.length - 2);

function makeFakeFrame(frameIndex) {
  const label = Buffer.from(`FAKE-DAYU frame=${frameIndex} synthetic-not-real-camera`, 'utf8');
  const com = Buffer.alloc(4 + label.length);
  com.writeUInt16BE(0xfffe, 0); // COM marker
  com.writeUInt16BE(2 + label.length, 2); // 段长度（含长度字段自身）
  label.copy(com, 4);
  return Buffer.concat([BODY, com, EOI]);
}

function makeDayuFrame(frameIndex) {
  return encodeFrame(makeFakeFrame(frameIndex));
}

/** 从 JPEG 的 SOF 段读宽高（读到 SOS 之前为止）。 */
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
    if (isSof) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    if (marker === 0xda) return null; // SOS 前没找到 SOF
    offset += 2 + length;
  }
  return null;
}

module.exports = {
  FAKE_LABEL: 'FAKE-DAYU',
  makeFakeFrame,
  makeDayuFrame,
  isJpeg,
  jpegDimensions
};
