'use strict';

/**
 * PC-side DAYU player adapter.
 *
 * The normal agent runs on DAYU and invokes `aa` directly. During USB acceptance
 * the agent runs on the PC, so this adapter creates an HDC reverse port for the
 * existing callback listener and invokes the same `aa` command on the only
 * connected USB target. No device identifier is logged or persisted.
 */

const childProcess = require('node:child_process');
const {
  AGENT_FAILURE_CODES,
  buildPlayerArgs,
  createPlaybackCallbackListener,
  extractPlaybackMessageId
} = require('./comms-agent');

const USB_CONNECTED_RE = /^([^\s]+)\s+USB\s+Connected(?:\s|$)/;

function executeFile(execute, command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (error, stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      resolve({
        code: error ? (Number.isInteger(error.code) ? error.code : -1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      });
    };
    try {
      execute(command, args, {
        shell: false,
        windowsHide: true,
        timeout: options.timeoutMs || 8000,
        maxBuffer: 256 * 1024
      }, done);
    } catch (_) {
      done(new Error('execute failed'));
    }
  });
}

function findSingleUsbTarget(output) {
  const targets = String(output || '')
    .split(/\r?\n/)
    .map((line) => USB_CONNECTED_RE.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[1]);
  return targets.length === 1 ? targets[0] : '';
}

function failure(code = AGENT_FAILURE_CODES.PLAYER_FAILED) {
  return { code: 1, stdout: '', stderr: '', failureCode: code };
}

function createHdcPlayerRunner(options = {}) {
  const hdcCommand = typeof options.hdcCommand === 'string' && options.hdcCommand !== ''
    ? options.hdcCommand
    : 'hdc';
  const execute = typeof options.execFileImpl === 'function' ? options.execFileImpl : childProcess.execFile;
  const createListener = typeof options.createListener === 'function'
    ? options.createListener
    : createPlaybackCallbackListener;
  const callbackTimeoutMs = Number.isSafeInteger(options.callbackTimeoutMs) && options.callbackTimeoutMs > 0
    ? options.callbackTimeoutMs
    : 30000;
  const commandTimeoutMs = Number.isSafeInteger(options.commandTimeoutMs) && options.commandTimeoutMs > 0
    ? options.commandTimeoutMs
    : 8000;

  return async function runPlayer(args) {
    const playbackMessageId = extractPlaybackMessageId(args);
    const resourceIndex = Array.isArray(args) ? args.indexOf('voiceResource') : -1;
    const resource = resourceIndex >= 0 ? args[resourceIndex + 1] : '';
    if (playbackMessageId === '' || resource === '') return failure();

    let listener = null;
    let target = '';
    let reverseAdded = false;
    let endpoint = '';
    try {
      const listed = await executeFile(execute, hdcCommand, ['list', 'targets', '-v'], {
        timeoutMs: commandTimeoutMs
      });
      if (listed.code !== 0) return failure(AGENT_FAILURE_CODES.DEVICE_REQUEST_FAILED);
      target = findSingleUsbTarget(listed.stdout);
      if (target === '') return failure(AGENT_FAILURE_CODES.DEVICE_REQUEST_FAILED);

      listener = await createListener({ playbackMessageId, timeoutMs: callbackTimeoutMs });
      endpoint = `tcp:${listener.port}`;

      const mapped = await executeFile(
        execute,
        hdcCommand,
        ['-t', target, 'rport', endpoint, endpoint],
        { timeoutMs: commandTimeoutMs }
      );
      // HDC 的成功文本随版本和调用方式变化；退出码负责判断映射命令是否成功。
      // 播放本身仍必须经过下面的 nonce 回执，绝不会因 HDC 退出码 0 而误报完成。
      if (mapped.code !== 0) {
        return failure(AGENT_FAILURE_CODES.DEVICE_REQUEST_FAILED);
      }
      reverseAdded = true;

      const fullArgs = buildPlayerArgs(resource, {
        playbackMessageId,
        callbackPort: listener.port,
        callbackNonce: listener.nonce
      });
      const started = await executeFile(
        execute,
        hdcCommand,
        ['-t', target, 'shell', 'aa', ...fullArgs],
        { timeoutMs: commandTimeoutMs }
      );
      if (started.code !== 0) {
        return failure(AGENT_FAILURE_CODES.PLAYER_FAILED);
      }

      const outcome = await listener.completion;
      if (outcome && outcome.result === 'COMPLETED') {
        return { code: 0, stdout: '', stderr: '', failureCode: '' };
      }
      return failure(outcome && typeof outcome.errorCode === 'string' && outcome.errorCode !== ''
        ? outcome.errorCode
        : AGENT_FAILURE_CODES.PLAYER_FAILED);
    } catch (_) {
      return failure(AGENT_FAILURE_CODES.DEVICE_REQUEST_FAILED);
    } finally {
      if (reverseAdded && target !== '' && endpoint !== '') {
        await executeFile(
          execute,
          hdcCommand,
          ['-t', target, 'fport', 'rm', endpoint, endpoint],
          { timeoutMs: commandTimeoutMs }
        );
      }
      if (listener && typeof listener.close === 'function') {
        try { await listener.close(); } catch (_) { /* best-effort cleanup */ }
      }
    }
  };
}

module.exports = {
  findSingleUsbTarget,
  createHdcPlayerRunner
};
