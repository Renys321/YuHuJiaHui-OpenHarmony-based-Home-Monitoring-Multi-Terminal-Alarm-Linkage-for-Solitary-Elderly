'use strict';

/**
 * lib/dtu-protocol.js — YED-M100MG-B1（Y100E 路线 `YED_DTU4_2.0.3`）串口协议解析
 *
 * 事实来源（本地/公开厂家资料，均为只读命令）：
 *   config,get,firmwarever -> config,firmwarever,ok,<version>
 *   config,get,paramver    -> config,paramver,ok,<version>
 *   config,get,csq         -> config,csq,ok,<0..31|99>
 *   config,get,ssta        -> config,ssta,ok,<0..6>
 *   config,get,location,2  -> config,location,ok,<enabled>,...
 *   config,get,gpsext      -> config,gps,ok,<flag 0|1>,<EW>,<lon>,<NS>,<lat>,...,<time>
 *
 * 关键边界：
 *   - 该模块的身份是 DTU 文本协议，**不是** AT 指令集；AT/3GPP 解析在 lib/at-parser.js，
 *     在那里明确标注为“通用框架、当前设备未使用、无证据”。
 *   - `sim` 字段由厂家 SSTA 枚举推导（枚举语义含“识别卡…”），来源必须标注为 `vendor-enum:SSTA`，
 *     不得当作直接读到的 SIM 指令回包。
 *   - 数据连接 / 服务器连接状态没有本地证据命令，一律 unknown，不发明指令也不猜测。
 *   - CSQ=99 是未知，绝不折算 dBm，也绝不当作强信号。
 *   - 无 fix、空字段、零坐标、越界坐标一律不得伪装成有效定位。
 */

const { sanitizeLine, boundText } = require('./privacy');

/** 单次解析窗口内的处理上限，保证超长输入有界。 */
const MAX_LINES = 64;
const MAX_FIELDS = 64;
const MAX_LINE_BYTES = 512;

/** CSQ（RSSI）标准换算：dBm = -113 + 2 * csq。 */
const CSQ_DBM_BASE = -113;
const CSQ_DBM_STEP = 2;
/** 该换算公认可用的 CSQ 上限；31 之上只保留 raw，不给 dBm。 */
const CSQ_MAX_VALID = 31;
/** 99 = 未知。 */
const CSQ_UNKNOWN = 99;

const SIGNAL_UNKNOWN = 'UNKNOWN';
const SIGNAL_VALID = 'VALID';
const SIGNAL_INVALID = 'INVALID';

/* ------------------------------------------------------------ SSTA 枚举 */

/**
 * 厂家 SSTA 枚举。语义来自厂家公开《DTU透传固件基本命令》：
 *   0 未检测到卡 / 1 检测到卡未识别 / 2 识别卡无网络（= SIM 已识别、蜂窝未注册）
 *   3 网络正常没连上服务器 / 4 已连服务器 / 5 服务器断开 / 6 其他异常
 * `simReady` 与 `registered` 是由枚举推导的结论，调用方必须看 `source`。
 */
const SSTA_ENUM = Object.freeze({
  0: Object.freeze({
    label: 'NO_CARD',
    simReady: false,
    registered: false,
    serverConnected: false,
    detail: 'no card detected'
  }),
  1: Object.freeze({
    label: 'CARD_UNREADABLE',
    simReady: false,
    registered: false,
    serverConnected: false,
    detail: 'card detected but unreadable'
  }),
  2: Object.freeze({
    label: 'CARD_OK_NO_NETWORK',
    simReady: true,
    registered: false,
    serverConnected: false,
    detail: 'card identified, cellular network not registered'
  }),
  3: Object.freeze({
    label: 'NETWORK_OK_NO_SERVER',
    simReady: true,
    registered: true,
    serverConnected: false,
    detail: 'cellular network registered, data server not connected'
  }),
  4: Object.freeze({
    label: 'SERVER_CONNECTED',
    simReady: true,
    registered: true,
    serverConnected: true,
    detail: 'data server connected'
  }),
  5: Object.freeze({
    label: 'SERVER_DISCONNECTED',
    simReady: true,
    registered: true,
    serverConnected: false,
    detail: 'data server disconnected'
  }),
  6: Object.freeze({
    label: 'OTHER_ERROR',
    simReady: false,
    registered: false,
    serverConnected: false,
    detail: 'other error'
  })
});

/** 本地证据中没有的数据连接查询命令。 */
const DATA_CONNECTION_QUERY_SUPPORTED = false;

const GNSS_STATE_FIXED = 'FIXED';
const GNSS_STATE_NO_FIX = 'NO_FIX';
const GNSS_STATE_UNKNOWN = 'UNKNOWN';
const GNSS_STATE_UNSUPPORTED = 'UNSUPPORTED';

const EW_RE = /^[EW]$/;
const NS_RE = /^[NS]$/;
const FIX_FLAG_RE = /^[01]$/;
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;
const GPIO_TIME_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/;
const URC_PREFIX_RE = /^(?:\+|config\s*,|RING$|NO CARRIER$|RDY$|\^)/i;

/* ------------------------------------------------------------ 编码 */

/**
 * 去掉 UTF-8 BOM。文件型 fixture 首行常带 BOM；如果不剥离，
 * `\ufeffconfig,csq,ok,26` 会因首字段不匹配而被静默丢弃。
 */
function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 把原始 chunk / 文本拆成有界的、已清洗的行。
 * 命令回显（等于任一条已发送命令的行）被视为回显，放进 `echoes` 而不是 `lines`。
 */
function toResponseLines(chunk, sentCommands = []) {
  const echoes = [];
  const lines = [];
  try {
    const text = stripBom(typeof chunk === 'string' ? chunk : String(chunk ?? ''));
    const sent = new Set(
      (Array.isArray(sentCommands) ? sentCommands : [sentCommands])
        .filter((item) => typeof item === 'string' && item.length > 0)
        .map((item) => item.trim())
    );
    for (const rawPart of text.split(/[\r\n]+/)) {
      if (lines.length + echoes.length >= MAX_LINES) break;
      const cleaned = sanitizeLine(rawPart);
      if (!cleaned) continue;
      const bounded = boundText(cleaned, MAX_LINE_BYTES);
      if (sent.has(bounded)) {
        if (!echoes.includes(bounded)) echoes.push(bounded);
        continue;
      }
      if (!lines.includes(bounded)) lines.push(bounded);
    }
  } catch (_) {
    // 有界：任何异常都不外抛。
  }
  return Object.freeze({ lines: Object.freeze(lines), echoes: Object.freeze(echoes) });
}

/**
 * 解析单行 DTU 回包：`config,<key>,<status>,<value...>`。
 * 无法识别时返回 null（调用方忽略）。命令回显 `config,get,<key>` 返回 null。
 */
function parseDtuResponseLine(line) {
  try {
    const text = boundText(sanitizeLine(stripBom(line)), MAX_LINE_BYTES);
    if (!text) return null;
    const parts = text.split(',').map((part) => part.trim());
    if (parts.length < 3 || parts.length > MAX_FIELDS + 3) return null;
    if (parts[0].toLowerCase() !== 'config') return null;
    const key = parts[1].toLowerCase();
    if (key === 'get' || key === 'set') return null; // 命令回显
    const status = parts[2].toLowerCase();
    if (status !== 'ok' && status !== 'err' && status !== 'error' && status !== 'fail') return null;
    const values = parts.slice(3);
    if (values.length > MAX_FIELDS) return null;
    return Object.freeze({
      key,
      status,
      values: Object.freeze(values),
      raw: text
    });
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------ CSQ */

/**
 * 解析 CSQ 值（信号质量）。
 * 接受 0-31（有效）与 99（未知）；其余一律 INVALID。
 * 只对 0-31 按标准公式换算 dBm；99 与非法值绝不产出 dBm，绝不视为高信号。
 */
function parseCsq(value) {
  const basis = { raw: null, csq: null, dbm: null, quality: SIGNAL_UNKNOWN, state: SIGNAL_INVALID };
  try {
    let candidate = value;
    if (Array.isArray(candidate)) candidate = candidate[0];
    if (typeof candidate === 'number') {
      if (!Number.isInteger(candidate)) return Object.freeze(basis);
    } else if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (!/^\d{1,3}$/.test(trimmed)) return Object.freeze(basis);
      candidate = Number(trimmed);
    } else {
      return Object.freeze(basis);
    }
    if (!Number.isSafeInteger(candidate) || candidate < 0) return Object.freeze(basis);

    if (candidate === CSQ_UNKNOWN) {
      return Object.freeze({
        raw: CSQ_UNKNOWN,
        csq: CSQ_UNKNOWN,
        dbm: null,
        quality: SIGNAL_UNKNOWN,
        state: SIGNAL_UNKNOWN
      });
    }
    if (candidate < 0 || candidate > CSQ_MAX_VALID) return Object.freeze(basis);
    return Object.freeze({
      raw: candidate,
      csq: candidate,
      dbm: CSQ_DBM_BASE + CSQ_DBM_STEP * candidate,
      quality: candidate >= 20 ? 'excellent' : candidate >= 15 ? 'good' : candidate >= 10 ? 'fair' : candidate >= 2 ? 'poor' : 'marginal',
      state: SIGNAL_VALID
    });
  } catch (_) {
    return Object.freeze(basis);
  }
}

/* ------------------------------------------------------------ SSTA */

/**
 * 解析 SSTA（网络 / 服务器状态枚举）。
 * 未知枚举返回 present=true 但状态 UNKNOWN，绝不推导出 simReady / registered。
 */
function parseSsta(value) {
  const unknown = {
    raw: null,
    code: null,
    state: 'UNKNOWN',
    label: 'UNKNOWN',
    simReady: null,
    registered: null,
    serverConnected: null,
    detail: 'unrecognized SSTA',
    source: 'vendor-enum:SSTA'
  };
  try {
    let candidate = Array.isArray(value) ? value[0] : value;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (!/^\d{1,2}$/.test(trimmed)) return Object.freeze(unknown);
      candidate = Number(trimmed);
    }
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate)) return Object.freeze(unknown);
    const entry = SSTA_ENUM[candidate];
    if (!entry) {
      return Object.freeze({ ...unknown, raw: candidate, code: candidate });
    }
    return Object.freeze({
      raw: candidate,
      code: candidate,
      state: entry.label,
      label: entry.label,
      simReady: entry.simReady,
      registered: entry.registered,
      serverConnected: entry.serverConnected,
      detail: entry.detail,
      source: 'vendor-enum:SSTA'
    });
  } catch (_) {
    return Object.freeze(unknown);
  }
}

/* ------------------------------------------------------------ GNSS */

/** 只用于校验：有限、可显式解析、绝对值在范围内。返回值仅参与判断。 */
function parseCoordinate(field, maxAbs) {
  if (typeof field !== 'string' || field.length === 0 || field.length > 32) return null;
  if (!NUMBER_RE.test(field)) return null;
  const value = Number(field);
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) > maxAbs) return null;
  return value;
}

/**
 * 把 DTU 的 `YYYY-M-D H:M:S`（UTC）转成 `YYYY-MM-DDTHH:MM:SSZ`。
 * 字段非法或范围越界（例如 13 月、32 日）时返回 null，不做宽松修正。
 */
function formatUtcTimestamp(field) {
  try {
    if (typeof field !== 'string') return null;
    const match = GPIO_TIME_RE.exec(field.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (year < 2000 || year > 2099) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const pad = (number, width) => String(number).padStart(width, '0');
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}Z`;
  } catch (_) {
    return null;
  }
}

function numberOrNull(field, maxAbs) {
  const value = parseCoordinate(field, maxAbs);
  return value === null ? null : value;
}

const GNSS_UNKNOWN = Object.freeze({
  supported: false,
  state: GNSS_STATE_UNKNOWN,
  valid: false,
  reason: 'no_gnss_response',
  latitude: null,
  longitude: null,
  fixTimeUtc: null,
  speedKmh: null,
  courseDeg: null,
  altitudeM: null
});

/**
 * 解析单行 `config,gps,ok,...`。
 * 两种实测形态：
 *   短包 `<EW>,<lon>,<NS>,<lat>[,<time>]`  —— 没有显式 fix 标志，只能 UNKNOWN；
 *   扩展包 `<flag>,<EW>,<lon>,<NS>,<lat>,<speed>,<course>,<alt>,...,<time>` —— flag=1 才算候选 fix。
 * 坐标必须成对、同号半球、有限、在范围内，且不得为零值；否则一律 NO_FIX。
 */
function parseGpsResponseLine(line) {
  try {
    const text = boundText(sanitizeLine(stripBom(line)), MAX_LINE_BYTES);
    if (!text) return null;
    const parts = text.split(',').map((part) => part.trim());
    if (parts.length < 4 || parts.length > MAX_FIELDS + 3) return null;
    if (parts[0].toLowerCase() !== 'config') return null;
    if (parts[1].toLowerCase() !== 'gps') return null;
    if (parts[2].toLowerCase() !== 'ok') return null;

    const fields = parts.slice(3);
    if (fields.length === 0 || fields.length > MAX_FIELDS) return null;
    if (fields.some((field) => field === '')) return null;

    const first = fields[0];

    if (EW_RE.test(first)) {
      if (fields.length < 4) return null;
      const hemispheresValid = EW_RE.test(fields[0]) && NS_RE.test(fields[2]);
      const times = fields.slice(4).map(formatUtcTimestamp).filter(Boolean);
      return Object.freeze({
        supported: true,
        state: GNSS_STATE_UNKNOWN,
        valid: false,
        reason: 'no_explicit_fix_flag',
        hemispheresValid,
        latitude: null,
        longitude: null,
        fixTimeUtc: times.length > 0 ? times[0] : null,
        speedKmh: null,
        courseDeg: null,
        altitudeM: null
      });
    }

    if (FIX_FLAG_RE.test(first)) {
      if (fields.length < 6) return null;
      const hemispheresValid = EW_RE.test(fields[1]) && NS_RE.test(fields[3]);
      const longitude = numberOrNull(fields[2], 180);
      const latitude = numberOrNull(fields[4], 90);
      const coordinatesValid =
        longitude !== null && latitude !== null && longitude !== 0 && latitude !== 0;
      const times = fields.slice(5).map(formatUtcTimestamp).filter(Boolean);
      const fixTimeUtc = times.length > 0 ? times[0] : null;

      if (first !== '1') {
        return Object.freeze({
          supported: true,
          state: GNSS_STATE_NO_FIX,
          valid: false,
          reason: 'fix_flag_zero',
          hemispheresValid,
          latitude: null,
          longitude: null,
          fixTimeUtc,
          speedKmh: null,
          courseDeg: null,
          altitudeM: null
        });
      }
      if (!hemispheresValid) {
        return Object.freeze({
          supported: true,
          state: GNSS_STATE_NO_FIX,
          valid: false,
          reason: 'invalid_hemisphere',
          hemispheresValid: false,
          latitude: null,
          longitude: null,
          fixTimeUtc,
          speedKmh: null,
          courseDeg: null,
          altitudeM: null
        });
      }
      if (!coordinatesValid) {
        return Object.freeze({
          supported: true,
          state: GNSS_STATE_NO_FIX,
          valid: false,
          reason: 'invalid_coordinates',
          hemispheresValid,
          latitude: null,
          longitude: null,
          fixTimeUtc,
          speedKmh: null,
          courseDeg: null,
          altitudeM: null
        });
      }
      // 只有显式 fix=1 + 合法半球 + 合法非零坐标，才允许 valid=true。
      return Object.freeze({
        supported: true,
        state: GNSS_STATE_FIXED,
        valid: true,
        reason: 'fix_flag_one',
        hemispheresValid: true,
        latitude,
        longitude,
        fixTimeUtc,
        speedKmh: numberOrNull(fields[5], 2000),
        courseDeg: numberOrNull(fields[6], 360),
        altitudeM: numberOrNull(fields[7], 20000)
      });
    }

    return null;
  } catch (_) {
    return null;
  }
}

/**
 * 解析单行 `config,location,ok,<enabled>,...`，只关心第一个字段 0/1。
 */
function parseLocationSettingsLine(line) {
  try {
    const text = boundText(sanitizeLine(stripBom(line)), MAX_LINE_BYTES);
    if (!text) return null;
    const parts = text.split(',').map((part) => part.trim());
    if (parts.length < 4 || parts.length > MAX_FIELDS + 3) return null;
    if (parts[0].toLowerCase() !== 'config') return null;
    if (parts[1].toLowerCase() !== 'location') return null;
    if (parts[2].toLowerCase() !== 'ok') return null;
    const fields = parts.slice(3);
    if (fields.length === 0 || fields.length > MAX_FIELDS) return null;
    if (fields[0] === '1') return Object.freeze({ supported: true, enabled: true });
    if (fields[0] === '0') return Object.freeze({ supported: true, enabled: false });
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * 从一组回包行中提取 GNSS 结论。
 * 同窗口取“最强证据”：任何自洽 FIXED 优先；否则 NO_FIX 优先于 UNKNOWN。
 * 坐标只在内部校验，只有 valid===true 时才允许进入返回值。
 */
function parseGnssLines(lines) {
  const result = {
    supported: false,
    state: GNSS_STATE_UNKNOWN,
    valid: false,
    reason: 'no_gnss_response',
    latitude: null,
    longitude: null,
    fixTimeUtc: null,
    speedKmh: null,
    courseDeg: null,
    altitudeM: null
  };
  try {
    if (!Array.isArray(lines)) return Object.freeze(result);
    let processed = 0;
    for (const line of lines) {
      if (processed >= MAX_LINES) break;
      processed += 1;
      const parsed = parseGpsResponseLine(line);
      if (!parsed) continue;
      result.supported = true;
      if (parsed.valid === true && result.valid !== true) {
        result.state = GNSS_STATE_FIXED;
        result.valid = true;
        result.reason = parsed.reason;
        result.latitude = parsed.latitude;
        result.longitude = parsed.longitude;
        result.fixTimeUtc = parsed.fixTimeUtc;
        result.speedKmh = parsed.speedKmh;
        result.courseDeg = parsed.courseDeg;
        result.altitudeM = parsed.altitudeM;
      } else if (result.valid !== true) {
        result.state = parsed.state;
        result.reason = parsed.reason;
        if (result.fixTimeUtc === null) result.fixTimeUtc = parsed.fixTimeUtc;
      }
    }
  } catch (_) {
    // 有界：不外抛。
  }
  return Object.freeze(result);
}

/** 从一组回包行中提取 GPS 开关结论。 */
function parseGnssSettingsLines(lines) {
  const result = { supported: false, enabled: null };
  try {
    if (!Array.isArray(lines)) return Object.freeze(result);
    let processed = 0;
    for (const line of lines) {
      if (processed >= MAX_LINES) break;
      processed += 1;
      const parsed = parseLocationSettingsLine(line);
      if (!parsed) continue;
      result.supported = true;
      if (parsed.enabled === true) result.enabled = true;
      else if (result.enabled !== true) result.enabled = false;
    }
  } catch (_) {
    // 有界：不外抛。
  }
  return Object.freeze(result);
}

/* ------------------------------------------------------------ 汇总 */

function firstValue(lines, key) {
  for (const line of Array.isArray(lines) ? lines : []) {
    const parsed = parseDtuResponseLine(line);
    if (!parsed || parsed.key !== key || parsed.status !== 'ok') continue;
    const value = parsed.values[0];
    if (value === undefined || value === '') continue;
    return { value: boundText(value, 128), raw: parsed.raw };
  }
  return null;
}

/**
 * 由已解析的回包行构造 4G/GNSS 设备状态。
 * 每个字段都带来源标记；没有证据的字段一律 unknown，绝不臆造。
 */
function summarizeDeviceState(lines) {
  const source = Array.isArray(lines) ? lines : [];
  const firmware = firstValue(source, 'firmwarever');
  const paramVersion = firstValue(source, 'paramver');
  const csqEntry = firstValue(source, 'csq');
  const sstaEntry = firstValue(source, 'ssta');
  const gnssSettings = parseGnssSettingsLines(source);
  const gnss = parseGnssLines(source);
  const ssta = parseSsta(sstaEntry ? sstaEntry.value : null);
  const csq = parseCsq(csqEntry ? csqEntry.value : null);

  return Object.freeze({
    firmware: firmware ? firmware.value : null,
    paramVersion: paramVersion ? paramVersion.value : null,
    signal: Object.freeze({
      csq: csq.csq,
      raw: csq.raw,
      dbm: csq.dbm,
      state: csq.state,
      quality: csq.quality,
      source: csqEntry ? 'config,get,csq' : null
    }),
    network: Object.freeze({
      state: ssta.state,
      label: ssta.label,
      code: ssta.code,
      registered: ssta.registered,
      detail: ssta.detail,
      source: sstaEntry ? 'vendor-enum:SSTA' : null
    }),
    sim: Object.freeze({
      ready: ssta.simReady,
      state:
        ssta.simReady === true
          ? 'READY'
          : ssta.simReady === false
            ? 'NOT_READY'
            : 'UNKNOWN',
      source: sstaEntry ? 'vendor-enum:SSTA' : null
    }),
    server: Object.freeze({
      connected: ssta.serverConnected,
      state:
        ssta.serverConnected === true
          ? 'CONNECTED'
          : ssta.serverConnected === false
            ? 'DISCONNECTED'
            : 'UNKNOWN',
      source: sstaEntry ? 'vendor-enum:SSTA' : null
    }),
    data: Object.freeze({
      supported: DATA_CONNECTION_QUERY_SUPPORTED,
      state: 'UNKNOWN',
      reason: DATA_CONNECTION_QUERY_SUPPORTED ? null : 'no_local_evidence_for_data_connection_query'
    }),
    operator: Object.freeze({
      supported: false,
      value: null,
      reason: 'no_local_evidence_for_operator_query'
    }),
    gnssSettings: Object.freeze({
      supported: gnssSettings.supported,
      enabled: gnssSettings.enabled
    }),
    gnss
  });
}

/** 默认只读命令序列：全部来自已验证的厂家命令集，不含任何写操作。 */
const DEFAULT_DEVICE_COMMANDS = Object.freeze([
  'config,get,firmwarever',
  'config,get,paramver',
  'config,get,csq',
  'config,get,ssta'
]);

const DEFAULT_GNSS_COMMANDS = Object.freeze(['config,get,location,2', 'config,get,gpsext']);

module.exports = {
  MAX_LINES,
  MAX_FIELDS,
  MAX_LINE_BYTES,
  CSQ_DBM_BASE,
  CSQ_DBM_STEP,
  CSQ_MAX_VALID,
  CSQ_UNKNOWN,
  SIGNAL_VALID,
  SIGNAL_UNKNOWN,
  SIGNAL_INVALID,
  GNSS_STATE_FIXED,
  GNSS_STATE_NO_FIX,
  GNSS_STATE_UNKNOWN,
  GNSS_STATE_UNSUPPORTED,
  SSTA_ENUM,
  DATA_CONNECTION_QUERY_SUPPORTED,
  DEFAULT_DEVICE_COMMANDS,
  DEFAULT_GNSS_COMMANDS,
  URC_PREFIX_RE,
  stripBom,
  toResponseLines,
  parseDtuResponseLine,
  parseCsq,
  parseSsta,
  parseGpsResponseLine,
  parseGnssLines,
  parseLocationSettingsLine,
  parseGnssSettingsLines,
  summarizeDeviceState,
  formatUtcTimestamp,
  GNSS_UNKNOWN
};
