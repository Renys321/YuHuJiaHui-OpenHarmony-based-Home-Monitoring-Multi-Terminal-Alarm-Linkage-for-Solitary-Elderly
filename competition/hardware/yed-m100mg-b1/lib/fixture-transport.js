'use strict';

/**
 * lib/fixture-transport.js — 从录制/构造的 AT/DTU 回放夹具中创建传输层
 *
 * 用途：无硬件时确定性地复现命令—响应、URC 交错、超时、ERROR 与掉线。
 * 安全边界：夹具是文本，不联网、不开串口、不写文件；输出仍必须经 lib/privacy.js 后才能打印。
 *
 * 夹具文件格式（行导向，`#` 开头为注释）：
 *
 *   >>> config,get,csq
 *   config,get,csq
 *   config,csq,ok,26
 *   <<< SILENCE 40 30
 *   ^^^ DROP port closed by adaptor
 *
 * 指令：
 *   >>> <command>              开始一条命令的应答体（同一命令可重复出现，按顺序回放）
 *   <<< SILENCE <quietMs> [totalMs]  该命令的响应被静默窗口截断（不注入数据）
 *   <<< TIMEOUT                该命令完全不响应（客户端超时）
 *   ^^^ DROP [reason]          不返回响应，直接模拟串口掉线
 *   ^^^ URC <line>             主动注入一条异步 URC（与命令响应交错）
 */

const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const { sanitizeLine, boundText } = require('./privacy');
const { SerialTransportError, ERROR_CODES } = require('./transport');

const DEFAULT_FIXTURE_QUIET_MS = 25;
const DEFAULT_FIXTURE_TIMEOUT_MS = 60;
const DEFAULT_FIXTURE_OPEN_TIMEOUT_MS = 200;

/** 解析夹具文本为 { transcripts: Map<command, Entry[]> }。 */
function parseFixtureText(text) {
  const transcripts = new Map();
  let current = null;
  const pushEntry = (entry) => {
    const list = transcripts.get(entry.command) || [];
    list.push(entry);
    transcripts.set(entry.command, list);
  };

  try {
    const source = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, '');
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      if (trimmed.startsWith('>>>')) {
        const command = sanitizeLine(trimmed.slice(3));
        if (!command) continue;
        current = { command, lines: [], mode: 'RESPOND', dropReason: null };
        pushEntry(current);
        continue;
      }
      if (trimmed.startsWith('<<<')) {
        const [keyword, first, second] = trimmed.slice(3).trim().split(/\s+/);
        const mode = (keyword || '').toUpperCase();
        if (current === null) continue;
        if (mode === 'TIMEOUT') {
          current.mode = 'TIMEOUT';
        } else if (mode === 'SILENCE') {
          current.mode = 'RESPOND';
          const parsed = Number(first);
          if (Number.isFinite(parsed) && parsed >= 0) current.silenceMs = parsed;
          if (Number.isFinite(Number(second)) && Number(second) >= 0) current.totalMs = Number(second);
        }
        continue;
      }
      if (trimmed.startsWith('^^^')) {
        const rest = trimmed.slice(3).trim();
        const [keyword, ...tail] = rest.split(/\s+/);
        const directive = (keyword || '').toUpperCase();
        if (current === null) continue;
        if (directive === 'DROP') {
          current.mode = 'DROP';
          current.dropReason = sanitizeLine(tail.join(' ')) || null;
        } else if (directive === 'URC') {
          const urcLine = sanitizeLine(tail.join(' '));
          if (urcLine) {
            current.urcs = current.urcs || [];
            current.urcs.push(urcLine);
          }
        }
        continue;
      }
      if (current !== null) {
        const responseLine = sanitizeLine(line);
        if (responseLine) current.lines.push(responseLine);
      }
    }
  } catch (_) {
    // 有界：畸形夹具退化为空转录，由上层判定为无数据。
  }

  for (const [command, entries] of transcripts) {
    transcripts.set(command, Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))));
  }
  return transcripts;
}

/** 从文件读取夹具（只读）。 */
function loadFixtureFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseFixtureText(text);
}

/**
 * 夹具传输层：实现与 SerialTransport 相同的最小契约
 * （open / disconnect / request / on / listen / isOpen / stats）。
 * 注入给 device.js 与 failover 的“连接执行器”即可复用同一套上层逻辑。
 */
class FixtureTransport extends EventEmitter {
  constructor(transcripts = new Map(), options = {}) {
    super();
    this.transcripts = transcripts instanceof Map ? transcripts : new Map();
    this.cursor = new Map();
    this.commandLog = [];
    this.urcLog = [];
    this._opened = false;
    this._closedByUser = false;
    this._timer = typeof options.setTimeoutImpl === 'function' ? options.setTimeoutImpl : setTimeout;
    this._clearTimer = typeof options.clearTimeoutImpl === 'function' ? options.clearTimeoutImpl : clearTimeout;
    this.options = Object.freeze({
      port: options.port || 'FIXTURE',
      baudRate: Number.isSafeInteger(options.baudRate) ? options.baudRate : 115200,
      timeoutMs: Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_FIXTURE_TIMEOUT_MS
    });
  }

  get isOpen() {
    return this._opened === true && this._closedByUser === false;
  }

  get port() {
    return this.options.port;
  }

  get baudRate() {
    return this.options.baudRate;
  }

  get stats() {
    return Object.freeze({
      port: this.options.port,
      baudRate: this.options.baudRate,
      open: this.isOpen,
      closedByUser: this._closedByUser,
      commandsSent: this.commandLog.length,
      urcCount: this.urcLog.length,
      mode: 'FIXTURE'
    });
  }

  async open() {
    this._closedByUser = false;
    this._opened = true;
    this.emit('open', Object.freeze({ port: this.options.port, baudRate: this.options.baudRate }));
    return this;
  }

  async disconnect() {
    this._closedByUser = true;
    this._opened = false;
    this.emit('closed', Object.freeze({ port: this.options.port }));
  }

  _nextEntry(command) {
    const entries = this.transcripts.get(command);
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const index = this.cursor.get(command) || 0;
    const entry = entries[index];
    this.cursor.set(command, entries.length === 0 ? 0 : Math.min(index + 1, entries.length - 1));
    return entry || null;
  }

  /** 回放一条命令。语义与 SerialTransport.request 对齐：非 OK 一律 reject。 */
  async request(command, options = {}) {
    const normalized = typeof command === 'string' ? command.trim() : '';
    if (!normalized) {
      throw new SerialTransportError(ERROR_CODES.COMMAND_ERROR, 'command must be a non-empty string');
    }
    if (this._closedByUser) {
      throw new SerialTransportError(ERROR_CODES.CLOSED, 'transport was closed by the caller');
    }
    if (!this.isOpen) {
      throw new SerialTransportError(ERROR_CODES.NOT_OPEN, 'fixture transport is not open');
    }
    this.commandLog.push(normalized);
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : this.options.timeoutMs;
    const entry = this._nextEntry(normalized);

    if (entry === null) {
      // 未录制：默认按超时处理，绝不编造响应。
      throw new SerialTransportError(
        ERROR_CODES.COMMAND_TIMEOUT,
        `no fixture recorded for command (waited ${timeoutMs} ms)`,
        { attempts: 1 }
      );
    }

    for (const urcLine of entry.urcs || []) {
      this.urcLog.push(urcLine);
      this.emit('urc', urcLine);
    }
    if (entry.mode === 'DROP') {
      const reason = entry.dropReason || 'fixture drop';
      this._opened = false;
      this.emit('disconnected', Object.freeze({ port: this.options.port, reason }));
      throw new SerialTransportError(ERROR_CODES.DISCONNECTED, reason, { attempts: 1 });
    }
    if (entry.mode === 'TIMEOUT') {
      throw new SerialTransportError(
        ERROR_CODES.COMMAND_TIMEOUT,
        `fixture timeout for ${normalized} (${timeoutMs} ms)`,
        { attempts: 1 }
      );
    }

    const hasError = (entry.lines || []).some((line) => /^ERROR$/i.test(line));
    if (hasError) {
      throw new SerialTransportError(ERROR_CODES.COMMAND_ERROR, 'device replied ERROR', { attempts: 1 });
    }

    return Object.freeze({
      command: normalized,
      status: 'OK',
      ok: true,
      error: null,
      code: null,
      lines: Object.freeze([...(entry.lines || [])]),
      attempts: 1,
      timedOut: false,
      fixture: true
    });
  }

  /** 被动监听：夹具模式不会产出未录制的数据，立即返回空。 */
  async listen(durationMs) {
    void durationMs;
    return Object.freeze([]);
  }
}

module.exports = {
  DEFAULT_FIXTURE_QUIET_MS,
  DEFAULT_FIXTURE_TIMEOUT_MS,
  DEFAULT_FIXTURE_OPEN_TIMEOUT_MS,
  parseFixtureText,
  loadFixtureFile,
  FixtureTransport
};
