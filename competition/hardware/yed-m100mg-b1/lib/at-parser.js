'use strict';

/**
 * lib/at-parser.js — 通用 3GPP AT 回包解析框架（**当前设备未使用**）
 *
 * 重要边界（必须连同结论一起引用）：
 *   本项目本地资料（`hardware/yed-m100mg-b1/README.md`、厂家命令文档核对记录、
 *   2026-10-12 进度与硬件清单 docx）中**没有** `AT+`、NMEA 或任何厂商私有 AT 命令的证据。
 *   YED-M100MG-B1（Y100E 路线 `YED_DTU4_2.0.3`）在真机上表现为 DTU 文本协议
 *   `config,get,<key>`，因此实际链路使用 lib/dtu-protocol.js，本模块不是该设备的驱动。
 *
 * 本模块存在的原因与用途：
 *   1. 为“模块固件在其它批次/其它子型号上确实暴露 AT 口”这一可能提供**已测试的解析框架**；
 *   2. 明确记录阻塞点：未取得厂商 AT 指令文档前，不得发送任何 AT 命令，不得猜测私有命令。
 *
 * 因此本模块：
 *   - 只做解析，不定义任何自动发送的命令序列；
 *   - `AT_PROBE_BLOCKED` 显式描述阻塞原因；
 *   - 只覆盖 3GPP TS 27.007 的公开标准回包：+CPIN / +CREG / +CGREG / +CEREG / +CSQ / +COPS；
 *   - CSQ 复用 lib/dtu-protocol.js 的换算，避免出现两套 dBm 语义。
 */

const { sanitizeLine, boundText } = require('./privacy');
const { parseCsq, SIGNAL_INVALID, SIGNAL_UNKNOWN, SIGNAL_VALID, CSQ_UNKNOWN, CSQ_MAX_VALID } = require('./dtu-protocol');

/** 总线阻塞说明：未取得厂商 AT 文档前不得发送 AT 命令。 */
const AT_PROBE_BLOCKED = Object.freeze({
  blocked: true,
  code: 'NO_LOCAL_AT_EVIDENCE',
  reason:
    'Local product material contains no AT command set and no NMEA/GNSS sentence evidence for this module; the Y100E firmware exposes the DTU config protocol instead.',
  action:
    'Do not send AT commands or guess vendor-private commands. Obtain the vendor AT manual or confirm the firmware variant before enabling any AT path.'
});

/** 单窗口解析上限。 */
const MAX_LINES = 64;
const MAX_LINE_BYTES = 512;

const REGISTRATION_STAT_DETAIL = Object.freeze({
  0: 'not_registered_not_searching',
  1: 'registered_home',
  2: 'searching',
  3: 'registration_denied',
  4: 'unknown',
  5: 'registered_roaming'
});

const REGISTRATION_STATE = Object.freeze({
  0: 'NOT_REGISTERED',
  1: 'REGISTERED',
  2: 'SEARCHING',
  3: 'DENIED',
  4: 'UNKNOWN',
  5: 'ROAMING'
});

/** +CPIN 允许的“已就绪”状态字。 */
const CPIN_READY_BASE = 'READY';
const CPIN_PIN_STATUS = Object.freeze({
  'SIM PIN': 'PIN_REQUIRED',
  'SIM PUK': 'PUK_REQUIRED',
  'SIM PIN2': 'PIN2_REQUIRED',
  'SIM PUK2': 'PUK2_REQUIRED',
  'PH-SIM PIN': 'PHONE_TO_SIM_PIN_REQUIRED',
  'PH-NET PIN': 'NETWORK_PIN_REQUIRED'
});

/** 各注册域的 AT 命令名（仅用于识别回包，不代表本设备会发送）。 */
const REGISTRATION_COMMANDS = Object.freeze({
  CREG: '+CREG',
  CGREG: '+CGREG',
  CEREG: '+CEREG'
});

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 把原始文本拆成有界、已清洗的 AT 回包行。 */
function toAtLines(chunk) {
  const lines = [];
  try {
    const text = stripBom(typeof chunk === 'string' ? chunk : String(chunk ?? ''));
    for (const rawPart of text.split(/[\r\n]+/)) {
      if (lines.length >= MAX_LINES) break;
      const cleaned = sanitizeLine(rawPart);
      if (!cleaned) continue;
      const bounded = boundText(cleaned, MAX_LINE_BYTES);
      if (!lines.includes(bounded)) lines.push(bounded);
    }
  } catch (_) {
    // 有界：不外抛。
  }
  return Object.freeze(lines);
}

/** AT 最终结果码：OK / ERROR（大小写不敏感，容忍前置空白）。 */
function parseFinalResult(line) {
  const text = sanitizeLine(line);
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper === 'OK') return 'OK';
  if (upper === 'ERROR') return 'ERROR';
  return null;
}

/** 提取 `+CMD: payload` 中的 payload；不匹配返回 null。 */
function extractInformational(line, command) {
  const text = sanitizeLine(line);
  if (!text) return null;
  const wanted = String(command || '').replace(/^\+/, '').toUpperCase();
  if (!wanted) return null;
  const match = new RegExp(`^\\+${wanted}\\s*:(.*)$`, 'i').exec(text.trim());
  if (!match) return null;
  return match[1].trim();
}

/**
 * 解析 +CPIN 回包行。
 * 返回 { present, ready, state }：READY 才算 ready=true；未知状态一律 ready=null。
 */
function parseCpinLine(line) {
  const payload = extractInformational(line, 'CPIN');
  if (payload === null) return null;
  const text = payload.toUpperCase();
  if (text === CPIN_READY_BASE) return Object.freeze({ present: true, ready: true, state: 'READY' });
  if (text === '' || text === 'NOT READY' || text === 'NOT_READY') {
    return Object.freeze({ present: true, ready: false, state: 'NOT_READY' });
  }
  if (Object.prototype.hasOwnProperty.call(CPIN_PIN_STATUS, text)) {
    return Object.freeze({ present: true, ready: false, state: CPIN_PIN_STATUS[text] });
  }
  return Object.freeze({ present: true, ready: null, state: 'UNKNOWN' });
}

/**
 * 解析 +CREG / +CGREG / +CEREG 回包行。
 * 支持 `+CEREG: <n>,<stat>`、`+CEREG: <n>,<stat>,"...","..."` 与单字段 URC 形式。
 *
 * 两种形态的字段含义不同，必须按字段个数区分：
 *   - 读命令回包 `+CREG: <n>,<stat>` —— 取 fields[1] 作为 <stat>，fields[0] 是 <n>。
 *   - URC（TS 27.007 定义 `+CREG: <stat>`）—— 只有一个数值字段，它就是 <stat>。
 * 单字段且非数字时才返回 UNKNOWN；不会在字段缺失的情况下凭空推断 <stat>。
 * 注意：仅凭一行文本无法区分「读命令回包只回了 <n>」与「URC 回了 <stat>」；
 * 本模块不发送任何 AT 命令（见 AT_PROBE_BLOCKED），因此采用 URC 语义。
 */
function parseRegistrationLine(line, command) {
  const payload = extractInformational(line, command);
  if (payload === null) return null;
  const fields = payload.split(',').map((field) => field.trim().replace(/^"|"$/g, ''));
  const statField = fields.length >= 2 ? fields[1] : fields[0];
  if (!/^\d+$/.test(statField)) {
    return Object.freeze({
      command: String(command).toUpperCase(),
      mode: null,
      stat: null,
      state: 'UNKNOWN',
      detail: 'unrecognized_registration_fields'
    });
  }
  const stat = Number(statField);
  return Object.freeze({
    command: String(command).toUpperCase(),
    mode: fields.length >= 2 && /^\d+$/.test(fields[0]) ? Number(fields[0]) : null,
    stat,
    state: REGISTRATION_STATE[stat] !== undefined ? REGISTRATION_STATE[stat] : 'UNKNOWN',
    detail: REGISTRATION_STAT_DETAIL[stat] !== undefined ? REGISTRATION_STAT_DETAIL[stat] : 'unknown'
  });
}

/** 解析 +CSQ 回包行；复用 dtu-protocol 的 CSQ 语义（0-31 有效，99 未知）。 */
function parseCsqLine(line) {
  const payload = extractInformational(line, 'CSQ');
  if (payload === null) return null;
  const fields = payload.split(',').map((field) => field.trim());
  const csqField = fields[0];
  const parsed = parseCsq(csqField);
  if (!/^\d{1,3}$/.test(csqField)) {
    return Object.freeze({ present: true, ...parsed, reason: 'malformed_csq_field' });
  }
  return Object.freeze({ present: true, ...parsed });
}

/** 解析 +COPS 回包行（运营商）。只做格式校验，不回显原值以外的推断。 */
function parseCopsLine(line) {
  const payload = extractInformational(line, 'COPS');
  if (payload === null) return null;
  const fields = payload.split(',').map((field) => field.trim().replace(/^"|"$/g, ''));
  if (fields.length < 3) return Object.freeze({ present: true, state: 'UNKNOWN' });
  return Object.freeze({
    present: true,
    mode: /^\d+$/.test(fields[0]) ? Number(fields[0]) : null,
    format: /^\d+$/.test(fields[1]) ? Number(fields[1]) : null,
    // 运营商名可能含非 ASCII；调用方仍需经 privacy.redactLine 后才能输出。
    operator: boundText(fields[2] || '', 64) || null,
    state: 'PARSED'
  });
}

function mergeRegistration(target, parsed) {
  if (!parsed) return;
  const key = parsed.command;
  const previous = target[key];
  // 同一窗口内以最后一次有效回包为准；URC 与命令响应交错时行为确定。
  target[key] = parsed;
  if (previous && previous.stat !== parsed.stat) {
    target.transitions = (target.transitions || 0) + 1;
  }
}

/**
 * 解析一组 AT 回包行，输出结构化结果。
 * 只解析 +CPIN / +CREG / +CGREG / +CEREG / +CSQ / +COPS 与最终结果码，
 * 其余行进入 `unrecognized`（已清洗，不含命令回显）。
 */
function parseAtResponse(lines, options = {}) {
  const sentCommands = Array.isArray(options.sentCommands) ? options.sentCommands : [];
  const sent = new Set(sentCommands.map((item) => String(item).trim().toUpperCase()));
  const result = {
    ok: null,
    error: false,
    pin: null,
    csq: null,
    operator: null,
    registrations: {},
    unrecognized: [],
    blocked: AT_PROBE_BLOCKED
  };

  try {
    if (!Array.isArray(lines)) return Object.freeze(result);
    let processed = 0;
    for (const line of lines) {
      if (processed >= MAX_LINES) break;
      processed += 1;
      const text = sanitizeLine(stripBom(line));
      if (!text) continue;
      if (sent.has(text.toUpperCase())) continue; // 命令回显

      const finalResult = parseFinalResult(text);
      if (finalResult === 'OK') {
        if (result.ok !== false) result.ok = true;
        continue;
      }
      if (finalResult === 'ERROR') {
        result.error = true;
        result.ok = false;
        continue;
      }

      const pin = parseCpinLine(text);
      if (pin) {
        result.pin = pin;
        continue;
      }
      const csq = parseCsqLine(text);
      if (csq) {
        result.csq = csq;
        continue;
      }
      const cops = parseCopsLine(text);
      if (cops) {
        result.operator = cops;
        continue;
      }
      let matchedRegistration = false;
      for (const command of Object.keys(REGISTRATION_COMMANDS)) {
        const registration = parseRegistrationLine(text, REGISTRATION_COMMANDS[command]);
        if (registration) {
          mergeRegistration(result.registrations, registration);
          matchedRegistration = true;
          break;
        }
      }
      if (matchedRegistration) continue;

      if (result.unrecognized.length < MAX_LINES) result.unrecognized.push(text);
    }
  } catch (_) {
    // 有界：不外抛。
  }

  result.registrations = Object.freeze({ ...result.registrations });
  result.unrecognized = Object.freeze([...result.unrecognized]);
  return Object.freeze(result);
}

module.exports = {
  AT_PROBE_BLOCKED,
  MAX_LINES,
  MAX_LINE_BYTES,
  CPIN_READY_BASE,
  REGISTRATION_STATE,
  REGISTRATION_STAT_DETAIL,
  REGISTRATION_COMMANDS,
  SIGNAL_INVALID,
  SIGNAL_UNKNOWN,
  SIGNAL_VALID,
  CSQ_UNKNOWN,
  CSQ_MAX_VALID,
  stripBom,
  toAtLines,
  parseFinalResult,
  extractInformational,
  parseCpinLine,
  parseRegistrationLine,
  parseCsqLine,
  parseCopsLine,
  parseAtResponse
};
