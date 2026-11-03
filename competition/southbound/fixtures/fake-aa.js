#!/usr/bin/env node
'use strict';

/**
 * southbound/fixtures/fake-aa.js — `aa` 的替身，用于在没有 DAYU200 的机器上
 * 端到端验证"播放完成回执"协议。
 *
 * 它模拟 SosVoiceAbility 在收到 `aa start ... --ps k v` 之后的行为：
 *   1. 从 argv 解析 voiceResource / playbackMessageId / callbackPort / callbackNonce；
 *   2. 按 CALLBACK_MODE 决定回调内容：
 *        complete   （默认）回调 COMPLETED
 *        failed              回调 FAILED + errorCode
 *        silent              不回执（用于验证超时 → PLAYER_TIMEOUT）
 *        badnonce            用错误 nonce 回调（用于验证拒伪）
 *        badmessageid        用错误 messageId 回调
 *        http500             回调一个非 JSON 正文
 *        twice               先正确回调，再重复回调一次
 *        exit1               模拟 aa 拉起 Ability 失败，非零退出且不回执
 *   3. 可选 START_DELAY_MS 延迟，用于验证"回执之前不得回报 PLAYED"。
 *
 * 这是**测试替身**，不是真机证据：它不播放任何音频，也不接触 `aa`。
 */

const CALLBACK_PATH = '/playback-result';

function readParameters(argv) {
  const parameters = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--ps' && typeof argv[index + 1] === 'string') {
      parameters.set(argv[index + 1], String(argv[index + 2] ?? ''));
      index += 2;
    }
  }
  return parameters;
}

async function post(port, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
      signal: AbortSignal.timeout(5000)
    });
    return response.status;
  } catch (_) {
    return 0;
  }
}

async function main() {
  const parameters = readParameters(process.argv.slice(2));
  const voiceResource = parameters.get('voiceResource') || '';
  const playbackMessageId = parameters.get('playbackMessageId') || '';
  const callbackPort = parameters.get('callbackPort') || '';
  const callbackNonce = parameters.get('callbackNonce') || '';
  const mode = process.env.CALLBACK_MODE || 'complete';
  const startDelayMs = Number.parseInt(process.env.START_DELAY_MS || '0', 10);

  // 只输出非敏感的诊断信息，便于测试断言。
  process.stdout.write(`${JSON.stringify({
    event: 'fake_aa_start',
    voiceResource,
    hasCallback: callbackPort !== '' && callbackNonce !== '',
    mode
  })}\n`);

  if (!Number.isInteger(startDelayMs) || startDelayMs > 0) {
    if (Number.isInteger(startDelayMs) && startDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, startDelayMs));
    }
  }

  const port = Number.parseInt(callbackPort, 10);
  if (!Number.isInteger(port) || port < 1) {
    process.exitCode = 1;
    return;
  }

  switch (mode) {
    case 'exit1':
      process.exitCode = 7;
      return;
    case 'silent':
      process.exitCode = 0;
      return;
    case 'failed':
      await post(port, {
        playbackMessageId, callbackNonce, result: 'FAILED', errorCode: 'AUDIO_ROUTE_MISSING'
      });
      process.exitCode = 0;
      return;
    case 'badnonce':
      await post(port, {
        playbackMessageId, callbackNonce: 'x'.repeat(43), result: 'COMPLETED', errorCode: ''
      });
      process.exitCode = 0;
      return;
    case 'badmessageid':
      await post(port, {
        playbackMessageId: 'cmsg-forged0001', callbackNonce, result: 'COMPLETED', errorCode: ''
      });
      process.exitCode = 0;
      return;
    case 'http500':
      await post(port, 'this is not json');
      process.exitCode = 0;
      return;
    case 'twice':
      await post(port, { playbackMessageId, callbackNonce, result: 'COMPLETED', errorCode: '' });
      await post(port, { playbackMessageId, callbackNonce, result: 'FAILED', errorCode: 'LATE' });
      process.exitCode = 0;
      return;
    default:
      await post(port, { playbackMessageId, callbackNonce, result: 'COMPLETED', errorCode: '' });
      process.exitCode = 0;
      return;
  }
}

main().catch((error) => {
  process.stderr.write(`fake-aa error: ${error && error.name ? error.name : 'error'}\n`);
  process.exitCode = 1;
});
