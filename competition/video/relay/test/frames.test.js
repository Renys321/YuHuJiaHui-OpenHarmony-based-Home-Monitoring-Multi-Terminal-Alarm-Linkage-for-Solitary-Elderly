'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_FRAME_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
  isJpeg,
  createFrameParser
} = require('../src/frames');
const { makeFakeFrame } = require('./tools/jpeg');

function collectParserErrors() {
  const errors = [];
  const frames = [];
  const parser = createFrameParser(
    (frame) => frames.push(frame),
    (error) => errors.push(error)
  );
  return { parser, frames, errors };
}

test('encodeFrame 拒绝过小/过大的帧', () => {
  assert.throws(() => encodeFrame(Buffer.alloc(MIN_FRAME_BYTES - 1)), /outside/);
  assert.throws(() => encodeFrame(Buffer.alloc(MAX_FRAME_BYTES + 1)), /outside/);
  const encoded = encodeFrame(Buffer.alloc(MIN_FRAME_BYTES));
  assert.equal(encoded.readUInt32BE(0), MIN_FRAME_BYTES);
  assert.equal(encoded.length, MIN_FRAME_BYTES + 4);
});

test('isJpeg 只认 FF D8 ... FF D9', () => {
  const jpeg = makeFakeFrame(0);
  assert.equal(isJpeg(jpeg), true);
  assert.equal(isJpeg(Buffer.from([0xff, 0xd8, 0x00, 0x00])), false);
  assert.equal(isJpeg(Buffer.from([0x00, 0x00, 0xff, 0xd9])), false);
  assert.equal(isJpeg(Buffer.alloc(2)), false);
});

test('帧解析器能还原任意切分的 TCP 数据块', () => {
  const { parser, frames, errors } = collectParserErrors();
  const first = makeFakeFrame(1);
  const second = makeFakeFrame(2);
  const payload = Buffer.concat([encodeFrame(first), encodeFrame(second)]);

  // 逐字节切分，覆盖长度头跨包的边界。
  for (let i = 0; i < payload.length; i += 1) parser.push(payload.subarray(i, i + 1));

  assert.equal(errors.length, 0);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], first);
  assert.deepEqual(frames[1], second);
});

test('一次 push 多帧与多帧混合切分都正确', () => {
  const { parser, frames } = collectParserErrors();
  const a = makeFakeFrame(10);
  const b = makeFakeFrame(11);
  const c = makeFakeFrame(12);
  const payload = Buffer.concat([encodeFrame(a), encodeFrame(b), encodeFrame(c)]);
  parser.push(payload.subarray(0, 7));
  parser.push(payload.subarray(7));
  assert.deepEqual(frames.map((frame) => frame.length), [a.length, b.length, c.length]);
});

test('长度越界报错并重置缓冲，不会整体错位', () => {
  const { parser, frames, errors } = collectParserErrors();
  const badHeader = Buffer.alloc(4);
  badHeader.writeUInt32BE(100, 0); // < MIN_FRAME_BYTES
  parser.push(badHeader);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /invalid frame length/);

  // 报错后缓冲已被重置，后续合法帧仍能解析。
  const valid = makeFakeFrame(20);
  parser.push(encodeFrame(valid));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], valid);
});
