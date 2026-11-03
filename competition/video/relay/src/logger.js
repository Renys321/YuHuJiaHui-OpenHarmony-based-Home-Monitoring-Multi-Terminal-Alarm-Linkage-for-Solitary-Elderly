'use strict';

/**
 * 日志器：契约 §2.2“安全”要求日志不得出现 APP token / agent key，
 * ticket 只允许前 6 位。这里做三层防护：
 *   1) 敏感字段名（authorization/token/ticket/key/secret/...）直接打 [redacted]；
 *   2) 注册进 logger 的密钥串在整行输出里被替换成 [redacted]；
 *   3) 调用方本来就不该把 header/query 传给 logger（relay 只记 path，不记 query）。
 *
 * 单行格式便于 docker logs / 证据文件 grep：
 *   [2026-10-27T12:00:00.000Z] INFO  msg key=value ...
 */

const LEVEL_WEIGHT = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });
const SENSITIVE_FIELD = /^(authorization|proxy-authorization|cookie|set-cookie|token|access_token|refresh_token|ticket|agent_?key|key|secret|password|passwd)$/i;

function normalizeFieldValue(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return '[unserializable]';
  }
}

function createLogger(options = {}) {
  const level = options.level || 'info';
  const sink = typeof options.sink === 'function'
    ? options.sink
    : (line) => process.stdout.write(`${line}\n`);
  const clock = options.clock || (() => new Date());
  const secrets = new Set();

  if (!LEVEL_WEIGHT[level]) throw new Error(`invalid log level: ${level}`);

  function scrub(text) {
    let out = String(text);
    for (const secret of secrets) {
      if (typeof secret !== 'string' || secret.length < 6) continue;
      out = out.split(secret).join('[redacted]');
    }
    return out;
  }

  function formatFields(fields) {
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (SENSITIVE_FIELD.test(name)) {
        parts.push(`${name}=[redacted]`);
        continue;
      }
      const text = scrub(normalizeFieldValue(value)).replace(/[\r\n]+/g, ' ');
      parts.push(`${name}=${text}`);
    }
    return parts;
  }

  function emit(levelName, message, fields) {
    if (LEVEL_WEIGHT[levelName] < LEVEL_WEIGHT[level]) return;
    const now = clock();
    const timestamp = now instanceof Date ? now.toISOString() : String(now);
    const parts = formatFields(fields || {});
    const line = `[${timestamp}] ${levelName.toUpperCase().padEnd(5)} ${scrub(message)}`
      + (parts.length ? ` ${parts.join(' ')}` : '');
    sink(line);
  }

  return {
    level,
    registerSecret(value) {
      if (typeof value === 'string' && value.length >= 6) secrets.add(value);
    },
    scrub,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child(fields) {
      // 为单个 viewer/agent 打前缀，不引入新状态。
      const prefix = formatFields(fields).join(' ');
      return {
        debug: (m, f) => emit('debug', prefix ? `${prefix} ${m}` : m, f),
        info: (m, f) => emit('info', prefix ? `${prefix} ${m}` : m, f),
        warn: (m, f) => emit('warn', prefix ? `${prefix} ${m}` : m, f),
        error: (m, f) => emit('error', prefix ? `${prefix} ${m}` : m, f)
      };
    }
  };
}

/** sha256 前 8 位，用于在不泄漏原文的前提下关联 token。 */
function hashPrefix(value, crypto = require('crypto')) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 8);
}

module.exports = { createLogger, hashPrefix, LEVEL_WEIGHT };
