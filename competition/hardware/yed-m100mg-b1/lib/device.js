'use strict';

/**
 * lib/device.js — 设备探测编排（协议无关，只依赖注入的传输层与解析器）
 *
 * 职责：
 *   - 按顺序发送只读命令，收集命令响应行；
 *   - 把结果行交给注入的解析器（默认 lib/dtu-protocol.js）；
 *   - 汇总为**稳定字段顺序**的 JSON 友好对象，便于后续接入 DAYU 网关。
 *
 * 安全边界：
 *   - 命令只读白名单在 dtu-protocol.js 中定义，本模块不构造写命令；
 *   - `commands[].lines` 是“已清洗但未脱敏”的原始回包，默认不输出；
 *     输出路径必须经 lib/privacy.js 的 deepRedact/safeJsonStringify。
 *   - 单个命令失败不中断整体探测；每个命令记录状态与错误码。
 */

const { deepRedact } = require('./privacy');
const {
  DEFAULT_DEVICE_COMMANDS,
  DEFAULT_GNSS_COMMANDS,
  summarizeDeviceState,
  toResponseLines
} = require('./dtu-protocol');

const COMMAND_STATUS = Object.freeze({
  OK: 'OK',
  ERROR: 'ERROR',
  TIMEOUT: 'TIMEOUT',
  DISCONNECTED: 'DISCONNECTED',
  NOT_OPEN: 'NOT_OPEN',
  CLOSED: 'CLOSED'
});

/** 把传输层错误码映射为稳定状态字符串。 */
function statusForError(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  switch (code) {
    case 'SERIAL_COMMAND_TIMEOUT':
      return COMMAND_STATUS.TIMEOUT;
    case 'SERIAL_DISCONNECTED':
      return COMMAND_STATUS.DISCONNECTED;
    case 'SERIAL_NOT_OPEN':
      return COMMAND_STATUS.NOT_OPEN;
    case 'SERIAL_TRANSPORT_CLOSED':
      return COMMAND_STATUS.CLOSED;
    case 'SERIAL_COMMAND_ERROR':
      return COMMAND_STATUS.ERROR;
    default:
      return code === '' ? COMMAND_STATUS.ERROR : code;
  }
}

/**
 * 依次执行命令并收集结果。
 * @param {object} deps
 *   - transport: 具备 request(command, options) 的对象（真实或夹具）
 *   - commands: 命令数组，默认只读四项
 *   - parser: 解析函数 (lines) => state，默认 summarizeDeviceState
 *   - commandTimeoutMs: 单命令超时
 *   - retries: 单命令重试次数
 */
async function probeDevice(deps = {}) {
  const transport = deps.transport;
  if (!transport || typeof transport.request !== 'function') {
    throw new TypeError('probeDevice requires a transport with request()');
  }
  const commands = Array.isArray(deps.commands) && deps.commands.length > 0
    ? deps.commands.map(String)
    : [...DEFAULT_DEVICE_COMMANDS];
  const parse = typeof deps.parser === 'function' ? deps.parser : summarizeDeviceState;
  const commandTimeoutMs =
    Number.isSafeInteger(deps.commandTimeoutMs) && deps.commandTimeoutMs > 0 ? deps.commandTimeoutMs : undefined;
  const retries = Number.isSafeInteger(deps.retries) && deps.retries >= 0 ? deps.retries : undefined;

  const allLines = [];
  const commandResults = [];
  const urc = [];
  const startedAtMs = Date.now();

  for (const command of commands) {
    let status = COMMAND_STATUS.OK;
    let errorCode = null;
    let errorMessage = null;
    let lines = [];
    const options = {};
    if (commandTimeoutMs !== undefined) options.timeoutMs = commandTimeoutMs;
    if (retries !== undefined) options.retries = retries;

    try {
      const result = await transport.request(command, options);
      lines = Array.isArray(result && result.lines) ? [...result.lines] : [];
    } catch (error) {
      status = statusForError(error);
      errorCode = error && typeof error.code === 'string' ? error.code : null;
      errorMessage = error && typeof error.message === 'string' ? error.message : 'command failed';
    }

    for (const line of lines) {
      const parsed = toResponseLines(line, [command]);
      for (const cleanLine of parsed.lines) {
        if (!allLines.includes(cleanLine)) allLines.push(cleanLine);
      }
    }
    commandResults.push({
      command,
      status,
      ok: status === COMMAND_STATUS.OK,
      ...(errorCode === null ? {} : { errorCode }),
      ...(errorMessage === null ? {} : { errorMessage }),
      lines
    });
  }

  if (Array.isArray(transport.urcLog)) {
    for (const line of transport.urcLog) {
      if (!urc.includes(line)) urc.push(line);
    }
  }

  const device = parse(allLines);
  const failed = commandResults.filter((entry) => entry.ok !== true).length;

  return deepRedact({
    probedAtMs: startedAtMs,
    port: typeof transport.port === 'string' ? transport.port : null,
    baudRate: Number.isSafeInteger(transport.baudRate) ? transport.baudRate : null,
    mode: transport.stats && transport.stats.mode ? transport.stats.mode : 'SERIAL',
    commands: commandResults,
    urc,
    device,
    stats: {
      total: commandResults.length,
      succeeded: commandResults.length - failed,
      failed
    }
  });
}

/** 只读命令清单（供 CLI 与文档引用，避免两处硬编码）。 */
function readonlyCommands(options = {}) {
  const includeGnss = options.includeGnss !== false;
  return Object.freeze([
    ...DEFAULT_DEVICE_COMMANDS,
    ...(includeGnss ? DEFAULT_GNSS_COMMANDS : [])
  ]);
}

module.exports = {
  COMMAND_STATUS,
  statusForError,
  probeDevice,
  readonlyCommands
};
