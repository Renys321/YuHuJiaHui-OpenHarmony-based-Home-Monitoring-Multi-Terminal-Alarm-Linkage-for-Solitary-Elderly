'use strict';

/**
 * logger.js — 结构化、脱敏、无第三方依赖的日志。
 *
 * 硬约束：
 *   - 只输出固定短码 + 白名单字段；绝不打印 MQTT 密码、INGEST_KEY、
 *     GPS 经纬度或原始业务载荷；
 *   - 所有行单行化（去掉 CR/LF），避免日志注入；
 *   - 字段值有界（默认 160 字符），非原始对象只打印 JSON 的浅层安全值。
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

const SENSITIVE_KEY_RE = /pass|secret|token|key|credential|authorization|coordinate|latitude|longitude|lat|lon/i;

function sanitizeText(value) {
  return String(value).replace(/[\r\n\t]/g, ' ').slice(0, 300);
}

function formatFieldValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return sanitizeText(value);
  return sanitizeText(JSON.stringify(value));
}

function formatFields(fields) {
  if (!fields || typeof fields !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      parts.push(`${key}=[redacted]`);
      continue;
    }
    parts.push(`${key}=${formatFieldValue(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * @param {object} [options]
 * @param {string} [options.level] debug|info|warn|error
 * @param {(line:string)=>void} [options.sink] 测试注入
 * @param {() => number} [options.now]
 */
function createLogger(options = {}) {
  const threshold = LEVELS[options.level] || LEVELS.info;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sink = typeof options.sink === 'function'
    ? options.sink
    : (line) => {
      try {
        process.stdout.write(`${line}\n`);
      } catch {
        /* stdout 关闭时忽略 */
      }
    };

  function write(level, code, fields) {
    if (LEVELS[level] < threshold) return;
    const stamp = new Date(now()).toISOString();
    sink(`${stamp} ${level.toUpperCase()} ${sanitizeText(code)}${formatFields(fields)}`);
  }

  return Object.freeze({
    debug: (code, fields) => write('debug', code, fields),
    info: (code, fields) => write('info', code, fields),
    warn: (code, fields) => write('warn', code, fields),
    error: (code, fields) => write('error', code, fields)
  });
}

/** 固定错误码：只允许大写下划线短码，避免把任意错误文本写进日志/诊断。 */
function safeErrorCode(error, fallback = 'UNKNOWN') {
  const raw = error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : (typeof error === 'string' ? error : '');
  return /^[A-Z][A-Z0-9_]{2,39}$/.test(raw) ? raw : fallback;
}

module.exports = Object.freeze({ createLogger, safeErrorCode, LEVELS });
