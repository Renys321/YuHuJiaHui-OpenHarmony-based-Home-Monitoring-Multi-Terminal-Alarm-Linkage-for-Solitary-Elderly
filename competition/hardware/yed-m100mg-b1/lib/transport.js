'use strict';

/**
 * lib/transport.js — 串口 DTU/AT 传输层（依赖注入、可无硬件测试）
 *
 * 职责边界：
 *   - 只负责“打开 / 写 / 读 / 超时 / 重试 / 断开 / 重连 / 释放”，不解析协议语义。
 *   - 串口实现由 `createSerial` 依赖注入；协议解析器由调用方（device.js）注入。
 *   - 命令严格串行：同一时刻只有一条在途命令，后续命令排队。
 *   - 区分命令响应与异步 URC：URC 只通过 'urc' 事件与 urcLog 暴露，绝不混进命令响应行。
 *   - 主动 disconnect() 之后必须清空重连定时器并停止一切自动重连。
 *   - 端口/波特率/超时/重试全部来自配置；DEFAULT_PORT 只是默认值，不参与核心判断。
 */

const { EventEmitter } = require('node:events');

const { sanitizeLine, boundText, deepRedact } = require('./privacy');

/** 现场观测到的默认串口；只是默认值，可被配置覆盖。 */
const DEFAULT_PORT = 'COM12';
const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_COMMAND_TIMEOUT_MS = 1500;
const DEFAULT_RETRIES = 1;
/** 收到响应行后等待的静默窗口：DTU 协议没有 OK/ERROR 终止符。 */
const DEFAULT_QUIET_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 200;
const DEFAULT_RECONNECT_DELAY_MS = 300;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5000;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 10;
const DEFAULT_OPEN_TIMEOUT_MS = 5000;
const DEFAULT_MAX_LINES = 64;
const DEFAULT_MAX_BUFFER_BYTES = 8192;
const DEFAULT_URC_LOG_SIZE = 32;

/** 稳定错误码；调用方按码判断，不解析错误文本。 */
const ERROR_CODES = Object.freeze({
  NO_PORT: 'SERIAL_PORT_NOT_CONFIGURED',
  INVALID_CONFIG: 'SERIAL_CONFIG_INVALID',
  OPEN_FAILED: 'SERIAL_OPEN_FAILED',
  OPEN_TIMEOUT: 'SERIAL_OPEN_TIMEOUT',
  NOT_OPEN: 'SERIAL_NOT_OPEN',
  COMMAND_TIMEOUT: 'SERIAL_COMMAND_TIMEOUT',
  COMMAND_ERROR: 'SERIAL_COMMAND_ERROR',
  DISCONNECTED: 'SERIAL_DISCONNECTED',
  WRITE_FAILED: 'SERIAL_WRITE_FAILED',
  CLOSED: 'SERIAL_TRANSPORT_CLOSED'
});

const PORT_RE = /^(?:COM\d{1,3}|\/dev\/[A-Za-z0-9._/-]+|\\\\\.\\COM\d{1,3})$/;

/** URC 识别（粗筛）：AT 风格 `+XXX`、DTU 主动行、无前缀事件。 */
const DEFAULT_URC_RE = /^(?:\+|config\s*,|RING$|NO CARRIER$|RDY$|WIFI |\^)/i;

/**
 * 结构判定：`config,<key>,<status>` 是 DTU 命令响应，不是 URC。
 * 没有这条排除规则时，DTU 的正常响应会被误判成异步 URC。
 */
const DTU_RESPONSE_RE = /^config\s*,\s*[^,]+?\s*,\s*(?:ok|err|error|fail)\b/i;

/** 结构判定：`+CMD:` 带负载的是 AT 回包；AUX/脉冲类 `+CMD` 才是 URC。 */
const AT_PAYLOAD_RESPONSE_RE = /^\+[A-Za-z0-9_]+\s*:/;

/** 判定“命令完成”的终止符（AT 风格）。DTU 形态靠静默窗口。 */
const TERMINATORS = Object.freeze({ OK: 'OK', ERROR: 'ERROR' });

class SerialTransportError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SerialTransportError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.attempts !== undefined) this.attempts = options.attempts;
    if (options.lines !== undefined) this.lines = options.lines;
  }
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 校验并补全传输层配置。只认识白名单键，其他字段一律忽略
 * （避免把凭据或无关对象带进传输层）。
 */
function resolveTransportConfig(rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const port =
    typeof config.port === 'string' && config.port.trim() !== '' ? config.port.trim() : DEFAULT_PORT;
  if (!PORT_RE.test(port)) {
    throw new SerialTransportError(ERROR_CODES.INVALID_CONFIG, 'port must be a COM port or /dev serial path');
  }
  const baudRate = isPositiveInt(config.baudRate) ? config.baudRate : DEFAULT_BAUD_RATE;
  if (baudRate < 1200 || baudRate > 460800) {
    throw new SerialTransportError(ERROR_CODES.INVALID_CONFIG, 'baudRate must be in [1200, 460800]');
  }
  const retries = isNonNegativeInt(config.retries) ? config.retries : DEFAULT_RETRIES;
  if (retries > 10) {
    throw new SerialTransportError(ERROR_CODES.INVALID_CONFIG, 'retries must be <= 10');
  }
  const reconnectDelayMs = isPositiveInt(config.reconnectDelayMs)
    ? config.reconnectDelayMs
    : DEFAULT_RECONNECT_DELAY_MS;
  const reconnectMaxDelayMs = isPositiveInt(config.reconnectMaxDelayMs)
    ? config.reconnectMaxDelayMs
    : DEFAULT_RECONNECT_MAX_DELAY_MS;
  const reconnectMaxAttempts = isNonNegativeInt(config.reconnectMaxAttempts)
    ? config.reconnectMaxAttempts
    : DEFAULT_RECONNECT_MAX_ATTEMPTS;
  const urcPattern =
    config.urcPattern instanceof RegExp
      ? config.urcPattern
      : typeof config.urcPattern === 'string' && config.urcPattern.length > 0
        ? new RegExp(config.urcPattern)
        : DEFAULT_URC_RE;

  return Object.freeze({
    port,
    baudRate,
    commandTimeoutMs: isPositiveInt(config.commandTimeoutMs)
      ? config.commandTimeoutMs
      : DEFAULT_COMMAND_TIMEOUT_MS,
    retries,
    retryDelayMs: isNonNegativeInt(config.retryDelayMs) ? config.retryDelayMs : DEFAULT_RETRY_DELAY_MS,
    quietMs: isNonNegativeInt(config.quietMs) ? config.quietMs : DEFAULT_QUIET_MS,
    reconnectDelayMs,
    reconnectMaxDelayMs: Math.max(reconnectDelayMs, reconnectMaxDelayMs),
    reconnectMaxAttempts,
    openTimeoutMs: isPositiveInt(config.openTimeoutMs) ? config.openTimeoutMs : DEFAULT_OPEN_TIMEOUT_MS,
    maxLines: isPositiveInt(config.maxLines) ? config.maxLines : DEFAULT_MAX_LINES,
    maxBufferBytes: isPositiveInt(config.maxBufferBytes) ? config.maxBufferBytes : DEFAULT_MAX_BUFFER_BYTES,
    urcLogSize: isPositiveInt(config.urcLogSize) ? config.urcLogSize : DEFAULT_URC_LOG_SIZE,
    lineTerminator: typeof config.lineTerminator === 'string' ? config.lineTerminator : '\r\n',
    urcPattern,
    autoReconnect: config.autoReconnect !== false,
    retryOnError: config.retryOnError === true,
    serialOptions: Object.freeze({ ...(config.serialOptions || {}) })
  });
}

/** 串口参数 8N1 无流控，与既有 YED 探测脚本一致。 */
function defaultSerialOptions(port, baudRate, serialOptions = {}) {
  return {
    path: port,
    baudRate,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    rtscts: false,
    xon: false,
    xoff: false,
    xany: false,
    hupcl: false,
    autoOpen: false,
    ...serialOptions
  };
}

/** 把任意 socket 错误归类为稳定错误码。 */
function classifySocketError(error) {
  if (error instanceof SerialTransportError) return error;
  const rawCode = error && typeof error.code === 'string' ? error.code : '';
  const message = error && typeof error.message === 'string' ? error.message : 'serial error';
  if (['ENOENT', 'ENXIO', 'EBUSY', 'EACCES', 'EPERM', 'EINVAL'].includes(rawCode)) {
    return new SerialTransportError(ERROR_CODES.OPEN_FAILED, message, { cause: error });
  }
  if (['EIO', 'ENODEV', 'ECONNRESET', 'ENOTCONN'].includes(rawCode)) {
    return new SerialTransportError(ERROR_CODES.DISCONNECTED, message, { cause: error });
  }
  return new SerialTransportError(rawCode === '' ? ERROR_CODES.WRITE_FAILED : rawCode, message, {
    cause: error
  });
}

const ATTEMPT_OK = 'OK';
const ATTEMPT_ERROR = 'ERROR';
const ATTEMPT_TIMEOUT = 'TIMEOUT';
const ATTEMPT_DISCONNECTED = 'DISCONNECTED';

class SerialTransport extends EventEmitter {
  /**
   * @param {object} config 端口/波特率/超时/重试等，见 resolveTransportConfig。
   * @param {object} deps 依赖注入：
   *   - createSerial(options) -> socket | Promise<socket>
   *   - now(): number
   *   - setTimeoutImpl / clearTimeoutImpl （假定时器，用于确定性测试）
   */
  constructor(config = {}, deps = {}) {
    super();
    this.config = resolveTransportConfig(config);
    this._createSerial = typeof deps.createSerial === 'function' ? deps.createSerial : null;
    this._now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    this._setTimeout = typeof deps.setTimeoutImpl === 'function' ? deps.setTimeoutImpl : setTimeout;
    this._clearTimeout = typeof deps.clearTimeoutImpl === 'function' ? deps.clearTimeoutImpl : clearTimeout;

    this._socket = null;
    this._opened = false;
    this._closedByUser = false;
    this._socketListenersBound = false;
    this._buffer = '';
    this._queue = [];
    this._attempt = null;
    this._retryTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._urcLog = [];
    this._commandCount = 0;
    this._timeoutCount = 0;
  }

  get port() {
    return this.config.port;
  }

  get baudRate() {
    return this.config.baudRate;
  }

  /** 已打开且未被用户主动关闭。 */
  get isOpen() {
    return this._opened === true && this._closedByUser === false;
  }

  /** 最近收到的 URC（有界环形缓冲），用于诊断交错顺序。 */
  get urcLog() {
    return Object.freeze([...this._urcLog]);
  }

  /** 诊断计数。 */
  get stats() {
    return Object.freeze({
      port: this.config.port,
      baudRate: this.config.baudRate,
      open: this.isOpen,
      closedByUser: this._closedByUser,
      pending: this._attempt === null ? 0 : 1,
      queued: this._queue.length,
      commandsSent: this._commandCount,
      timeouts: this._timeoutCount,
      reconnectAttempts: this._reconnectAttempt,
      reconnectScheduled: this._reconnectTimer !== null,
      retryScheduled: this._retryTimer !== null,
      bufferedBytes: Buffer.byteLength(this._buffer, 'utf8'),
      urcCount: this._urcLog.length
    });
  }

  /** 打开串口。 */
  async open() {
    if (this.isOpen) return this;
    this._closedByUser = false;
    await this._openSocket();
    return this;
  }

  async _openSocket() {
    if (typeof this._createSerial !== 'function') {
      throw new SerialTransportError(
        ERROR_CODES.NO_PORT,
        'createSerial dependency is required for real serial mode'
      );
    }
    const options = defaultSerialOptions(this.config.port, this.config.baudRate, this.config.serialOptions);
    let socket;
    try {
      socket = await this._createSerial(options);
    } catch (error) {
      throw classifySocketError(error);
    }
    this._socket = socket;
    this._bindSocket(socket);
    try {
      await this._waitForOpen(socket);
    } catch (error) {
      this._unbindSocket(socket);
      this._socket = null;
      await this._safeCloseSocket(socket);
      throw classifySocketError(error);
    }
    this._opened = true;
    this._reconnectAttempt = 0;
    this._buffer = '';
    this.emit('open', Object.freeze({ port: this.config.port, baudRate: this.config.baudRate }));
    this._pumpQueue();
    return socket;
  }

  _waitForOpen(socket) {
    return new Promise((resolve, reject) => {
      const alreadyOpen = () => {
        try {
          return typeof socket.isOpen === 'boolean' ? socket.isOpen === true : false;
        } catch (_) {
          return false;
        }
      };
      if (alreadyOpen() && typeof socket.open !== 'function') return resolve();
      if (typeof socket.open !== 'function') return resolve();

      let settled = false;
      const timer = this._setTimeout(
        () => finish(new SerialTransportError(ERROR_CODES.OPEN_TIMEOUT, 'opening the serial port timed out')),
        this.config.openTimeoutMs
      );
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeoutSafe();
        if (typeof socket.off === 'function') {
          socket.off('open', onOpen);
          socket.off('error', onError);
        }
        if (error) reject(error);
        else resolve();
      }
      const onOpen = () => finish(null);
      const onError = (error) => finish(error || new Error('serial port open failed'));
      const clearTimeoutSafe = () => this._clearTimeout(timer);

      if (typeof socket.once === 'function') {
        socket.once('open', onOpen);
        socket.once('error', onError);
      }
      try {
        const maybePromise = socket.open();
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(() => finish(null)).catch((error) => finish(error));
        } else if (typeof socket.once !== 'function') {
          finish(null);
        }
      } catch (error) {
        finish(error);
      }
    });
  }

  _bindSocket(socket) {
    if (this._socketListenersBound || typeof socket.on !== 'function') return;
    this._onData = (chunk) => this._handleChunk(chunk);
    this._onError = (error) => this._handleSocketError(error);
    this._onClose = () => this._handleSocketClose();
    socket.on('data', this._onData);
    socket.on('error', this._onError);
    socket.on('close', this._onClose);
    this._socketListenersBound = true;
    // 兜底监听器必须在真实 socket 之前挂上：Node 对无监听器的 'error'
    // 事件会直接抛异常，会杀掉使用方进程（例如 CLI 重连期间）。
    if (this.listenerCount('error') === 0) {
      this._defaultErrorListener = () => {
        // 有界：默认静默。诊断信息由 'reconnect:failed' 等事件与 stats 提供。
      };
      this.on('error', this._defaultErrorListener);
    }
  }

  _unbindSocket(socket) {
    if (!this._socketListenersBound || !socket) return;
    const detach = typeof socket.off === 'function' ? socket.off.bind(socket) : socket.removeListener?.bind(socket);
    if (detach) {
      detach('data', this._onData);
      detach('error', this._onError);
      detach('close', this._onClose);
    }
    this._socketListenersBound = false;
  }

  _safeCloseSocket(socket) {
    return new Promise((resolve) => {
      if (!socket || typeof socket.close !== 'function') return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        const maybePromise = socket.close(finish);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(finish).catch(finish);
        }
      } catch (_) {
        finish();
      }
      // 已关闭的端口可能不回调，兜底一个宏任务。
      this._setTimeout(finish, 0);
    });
  }

  /**
   * 主动关闭：清空重连/重试定时器、在途命令与队列，且此后不再自动重连。
   */
  async disconnect() {
    this._closedByUser = true;
    this._cancelReconnect();
    this._cancelRetry();
    this._reconnectAttempt = 0;
    // 先结束在途尝试，再清空队列。_finishAttempt 末尾会调用 _pumpQueue()，
    // 因此 _pumpQueue 必须自己按 _closedByUser 给出 CLOSED（而不是依赖
    // 此处循环的执行顺序）——两条路径现在都会得到 CLOSED。
    this._finishAttempt(ATTEMPT_DISCONNECTED, 'transport was closed by the caller', ERROR_CODES.CLOSED);
    for (const pending of this._queue.splice(0)) {
      pending.settle.reject(new SerialTransportError(ERROR_CODES.CLOSED, 'transport was closed by the caller'));
    }
    const socket = this._socket;
    this._socket = null;
    this._opened = false;
    this._buffer = '';
    this._unbindSocket(socket);
    if (socket) {
      await this._safeCloseSocket(socket);
      if (typeof socket.destroy === 'function') {
        try {
          socket.destroy();
        } catch (_) {
          // 已销毁。
        }
      }
    }
    this._socket = null;
    this.emit('closed', Object.freeze({ port: this.config.port }));
  }

  _cancelReconnect() {
    if (this._reconnectTimer !== null) {
      this._clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _cancelRetry() {
    if (this._retryTimer !== null) {
      this._clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  _scheduleReconnect() {
    if (!this.config.autoReconnect || this._closedByUser) return;
    if (this._reconnectTimer !== null) return;
    if (this._reconnectAttempt >= this.config.reconnectMaxAttempts) {
      this.emit('reconnect:exhausted', Object.freeze({ attempt: this._reconnectAttempt }));
      return;
    }
    const delay = Math.min(
      this.config.reconnectMaxDelayMs,
      this.config.reconnectDelayMs * Math.pow(2, this._reconnectAttempt)
    );
    this.emit('reconnect:scheduled', Object.freeze({ delayMs: delay, attempt: this._reconnectAttempt + 1 }));
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnect();
    }, delay);
  }

  async _reconnect() {
    if (this._closedByUser) return;
    this._reconnectAttempt += 1;
    try {
      await this._openSocket();
      this.emit('reconnect:succeeded', Object.freeze({ attempt: this._reconnectAttempt }));
      this._reconnectAttempt = 0;
      this._pumpQueue();
    } catch (error) {
      this.emit('reconnect:failed', deepRedact({ attempt: this._reconnectAttempt, error }));
      this._scheduleReconnect();
    }
  }

  _handleSocketError(error) {
    const classified = classifySocketError(error);
    this.emit('error', classified);
    if (classified.code === ERROR_CODES.DISCONNECTED) this._handleSocketClose();
  }

  _handleSocketClose() {
    const socket = this._socket;
    const wasOpen = this._opened;
    this._opened = false;
    this._buffer = '';
    this._unbindSocket(socket);
    this._socket = null;
    if (!wasOpen && this._closedByUser) return;
    if (this._attempt !== null) {
      this._finishAttempt(
        ATTEMPT_DISCONNECTED,
        'serial port was closed while a command was pending',
        ERROR_CODES.DISCONNECTED
      );
    }
    if (!this._closedByUser) {
      this.emit('disconnected', Object.freeze({ port: this.config.port }));
      this._scheduleReconnect();
    }
  }

  _handleChunk(chunk) {
    let text;
    try {
      text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    } catch (_) {
      return;
    }
    if (text === '') return;
    this._buffer += text;
    if (Buffer.byteLength(this._buffer, 'utf8') > this.config.maxBufferBytes) {
      // 有界：超长无换行输入强制作为一整行处理。
      const overflow = this._buffer;
      this._buffer = '';
      this._consumeLine(overflow);
      return;
    }
    const parts = this._buffer.split(/[\r\n]+/);
    this._buffer = parts.pop() || '';
    for (const part of parts) this._consumeLine(part);
  }

  /**
   * 处理一行：区分命令回显、终止符、命令响应与异步 URC。
   *
   * 处理顺序是契约的一部分（曾出现 `OK` 被当作数据行的缺陷）：
   *   1. 命令回显（等于在途命令的整行）——丢弃，绝不进入响应行或 URC。
   *   2. `OK` / `ERROR` 终止符——立即结束命令，且绝不进入响应行。
   *   3. URC 粗筛命中——进入 urcLog 与 'urc' 事件。
   *   4. 其余行——作为响应数据累积，并重开静默窗口。
   */
  _consumeLine(rawLine) {
    const line = boundText(sanitizeLine(rawLine), 512);
    if (!line) return;
    this.emit('line', line);

    const attempt = this._attempt;

    // 1) 命令回显：整行等于本次已发出的命令时丢弃。
    if (attempt !== null && this._isEcho(attempt, line)) return;

    // 2) AT 终止符先于 URC 判定，保证 OK/ERROR 永远不会混进响应数据。
    //    不传 lines 覆盖：保留终止符之前已累积的响应行。
    const upper = line.toUpperCase();
    if (upper === TERMINATORS.OK) {
      if (attempt === null) return; // 无在途命令：终止符只做诊断。
      this._finishAttempt(ATTEMPT_OK, null, null);
      return;
    }
    if (upper === TERMINATORS.ERROR) {
      if (attempt === null) return;
      this._finishAttempt(ATTEMPT_ERROR, 'device replied ERROR', ERROR_CODES.COMMAND_ERROR);
      return;
    }

    // 3) 异步 URC。
    if (this._isUrc(line)) {
      this._recordUrc(line);
      this.emit('urc', line);
      return;
    }

    const current = this._attempt;
    if (current === null) return; // 无在途命令：非 URC 行只做诊断，不影响状态。

    // 4) 响应数据行。
    if (current.lines.length < this.config.maxLines && !current.lines.includes(line)) {
      current.lines.push(line);
    }
    this._armQuiet(current);
  }

  /** 判断一行是否为本次在途命令的回显。 */
  _isEcho(attempt, line) {
    if (!attempt || typeof attempt.command !== 'string') return false;
    return line.trim() === attempt.command;
  }

  _recordUrc(line) {
    this._urcLog.push(line);
    if (this._urcLog.length > this.config.urcLogSize) this._urcLog.shift();
  }

  /**
   * URC 判定（两段式，避免把命令响应吃掉）：
   *   1. 明确的 URC 形态（`config,...` 主动行、RING/RDY/NO CARRIER/WIFI/^ 前缀）
   *      任何时刻都算 URC。
   *   2. `+CMD: payload` 形态在 AT 与 URC 之间歧义，例如 `+CSQ: 22,99`（响应）
   *      与 `+CREG: 1,1`（URC）。规则：无在途命令 -> URC；有在途命令 -> 响应。
   *      AT 命令的 `OK`/`ERROR` 终止符始终按响应处理。
   */
  _isUrc(line) {
    if (typeof line !== 'string' || line.length === 0) return false;
    if (line === TERMINATORS.OK || line === TERMINATORS.ERROR) return false;
    if (DTU_RESPONSE_RE.test(line)) return false; // DTU 命令响应，绝非 URC

    let matchesPattern = false;
    try {
      matchesPattern = this.config.urcPattern.test(line);
    } catch (_) {
      matchesPattern = false;
    }
    if (!matchesPattern) return false;
    if (AT_PAYLOAD_RESPONSE_RE.test(line)) return this._attempt === null;
    return true;
  }

  /** 收到响应行后重开静默窗口：窗口到期即判定该命令完成（DTU 无终止符）。 */
  _armQuiet(attempt) {
    if (this.config.quietMs <= 0) return;
    if (attempt.quietTimer !== null) this._clearTimeout(attempt.quietTimer);
    attempt.quietTimer = this._setTimeout(() => {
      attempt.quietTimer = null;
      this._finishAttempt(ATTEMPT_OK, null, null);
    }, this.config.quietMs);
  }

  _finishAttempt(status, error, code, lines) {
    const attempt = this._attempt;
    if (attempt === null) return;
    this._attempt = null;
    if (attempt.timer !== null) this._clearTimeout(attempt.timer);
    if (attempt.quietTimer !== null) this._clearTimeout(attempt.quietTimer);
    attempt.settle({ status, error, code, lines: lines || attempt.lines });
    this._pumpQueue();
  }

  _pumpQueue() {
    if (this._attempt !== null || this._retryTimer !== null) return;
    if (this._queue.length === 0) return;

    if (!this.isOpen) {
      // 端口不可用：只有「确实正在等待自动重连」时才有理由继续排队，
      // 否则请求会永远挂住（NOT_OPEN 分支在 _runAttempt 里因此不可达）。
      if (this._reconnectTimer !== null && !this._closedByUser) return;
      // 错误码必须不依赖调用顺序：主动关闭后一律 CLOSED，而不是 NOT_OPEN。
      const error = this._closedByUser
        ? new SerialTransportError(ERROR_CODES.CLOSED, 'transport was closed by the caller')
        : new SerialTransportError(ERROR_CODES.NOT_OPEN, 'serial port is not open');
      for (const pending of this._queue.splice(0)) {
        pending.settle.reject(error);
      }
      return;
    }

    const pending = this._queue.shift();
    this._runAttempt(pending);
  }

  /**
   * 发送一条命令并串行等待响应。
   * 结果四态显式区分：OK / ERROR / TIMEOUT / DISCONNECTED。
   * @returns {Promise<object>} 成功时 resolve 结构化结果；非 OK（含 ERROR/超时/断开）时 reject SerialTransportError。
   */
  request(command, options = {}) {
    if (typeof command !== 'string' || command.trim() === '') {
      return Promise.reject(
        new SerialTransportError(ERROR_CODES.COMMAND_ERROR, 'command must be a non-empty string')
      );
    }
    const normalized = command.trim();
    if (this._closedByUser) {
      return Promise.reject(
        new SerialTransportError(ERROR_CODES.CLOSED, 'transport was closed by the caller')
      );
    }
    const timeoutMs = isPositiveInt(options.timeoutMs) ? options.timeoutMs : this.config.commandTimeoutMs;
    const retries = isNonNegativeInt(options.retries) ? options.retries : this.config.retries;

    return new Promise((resolve, reject) => {
      this._queue.push({
        command: normalized,
        timeoutMs,
        retriesLeft: retries,
        settle: { resolve, reject }
      });
      this._pumpQueue();
    });
  }

  _runAttempt(pending) {
    if (this._closedByUser) {
      pending.settle.reject(
        new SerialTransportError(ERROR_CODES.CLOSED, 'transport was closed by the caller')
      );
      this._pumpQueue();
      return;
    }
    if (!this.isOpen) {
      pending.settle.reject(
        new SerialTransportError(ERROR_CODES.NOT_OPEN, 'serial port is not open', {
          attempts: pending.attempts || 0
        })
      );
      this._pumpQueue();
      return;
    }

    pending.attempts = (pending.attempts || 0) + 1;
    const attempt = {
      command: pending.command,
      timeoutMs: pending.timeoutMs,
      lines: [],
      timer: null,
      quietTimer: null,
      settle: null
    };
    this._attempt = attempt;
    attempt.timer = this._setTimeout(() => {
      attempt.timer = null;
      this._timeoutCount += 1;
      this._finishAttempt(
        ATTEMPT_TIMEOUT,
        `command timed out after ${attempt.timeoutMs} ms`,
        ERROR_CODES.COMMAND_TIMEOUT,
        attempt.lines
      );
    }, pending.timeoutMs);

    let written;
    try {
      written =
        this._socket && typeof this._socket.write === 'function'
          ? this._socket.write(`${pending.command}${this.config.lineTerminator}`)
          : Promise.reject(new Error('serial socket is not writable'));
    } catch (error) {
      written = Promise.reject(error);
    }
    this._commandCount += 1;
    Promise.resolve(written).catch((error) => {
      if (this._attempt !== attempt) return;
      this._finishAttempt(
        ATTEMPT_DISCONNECTED,
        (error && error.message) || 'serial write failed',
        ERROR_CODES.WRITE_FAILED
      );
    });

    attempt.settle = (outcome) => this._settle(pending, outcome);
  }

  _settle(pending, outcome) {
    const shouldRetry =
      pending.retriesLeft > 0 &&
      (outcome.status === ATTEMPT_TIMEOUT ||
        (outcome.status === ATTEMPT_ERROR && this.config.retryOnError === true));

    if (shouldRetry) {
      pending.retriesLeft -= 1;
      this.emit('retry', Object.freeze({ command: pending.command, remaining: pending.retriesLeft }));
      const delay = this.config.retryDelayMs;
      if (delay > 0) {
        this._retryTimer = this._setTimeout(() => {
          this._retryTimer = null;
          this._pumpQueue();
        }, delay);
      }
      this._queue.unshift(pending);
      if (delay <= 0) this._pumpQueue();
      return;
    }

    if (outcome.status === ATTEMPT_OK) {
      pending.settle.resolve(
        Object.freeze({
          command: pending.command,
          status: ATTEMPT_OK,
          ok: true,
          error: null,
          code: null,
          lines: Object.freeze([...(outcome.lines || [])]),
          attempts: pending.attempts || 1,
          timedOut: false
        })
      );
      return;
    }

    const code = outcome.code || ERROR_CODES.COMMAND_ERROR;
    // 失败时也附上已收到的部分响应行：DTU 无终止符，靠静默窗口收尾，
    // 部分行是判定「设备其实回了但没答完」的唯一线索。
    pending.settle.reject(
      new SerialTransportError(code, outcome.error || 'command failed', {
        attempts: pending.attempts || 0,
        lines: Object.freeze([...(outcome.lines || [])])
      })
    );
  }

  /** 主动读取一次（不发送命令），用于被动监听。到期或关闭后必须清理监听器与定时器。 */
  listen(durationMs) {
    if (!isPositiveInt(durationMs)) {
      return Promise.reject(
        new SerialTransportError(ERROR_CODES.COMMAND_ERROR, 'listen duration must be a positive integer')
      );
    }
    return new Promise((resolve) => {
      const received = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this._clearTimeout(timer);
        this.off('line', onLine);
        this.off('closed', finish);
        resolve(Object.freeze([...received]));
      };
      const onLine = (line) => received.push(line);
      const timer = this._setTimeout(finish, durationMs);
      this.on('line', onLine);
      this.once('closed', finish);
    });
  }
}

module.exports = {
  SerialTransport,
  SerialTransportError,
  ERROR_CODES,
  ATTEMPT_OK,
  ATTEMPT_ERROR,
  ATTEMPT_TIMEOUT,
  ATTEMPT_DISCONNECTED,
  TERMINATORS,
  DEFAULT_PORT,
  DEFAULT_BAUD_RATE,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_RETRIES,
  DEFAULT_QUIET_MS,
  DEFAULT_URC_RE,
  DTU_RESPONSE_RE,
  AT_PAYLOAD_RESPONSE_RE,
  PORT_RE,
  resolveTransportConfig,
  defaultSerialOptions,
  classifySocketError
};
