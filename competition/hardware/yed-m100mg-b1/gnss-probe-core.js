'use strict';

/**
 * gnss-probe-core.js — YED-M100MG-B1 GNSS 只读探测的隐私优先纯函数核心
 *
 * 设计目标：在解析厂商 `config,gps,ok,...` 回包时，只产出"有没有定位标记、时间字段和
 * 合法方向"这类枚举/布尔结论，**绝不**把经度、纬度、速度、海拔、方向数值或完整原始行
 * 带进返回值、文本或日志。
 *
 * 数据来源与形态（厂家公开命令定义）：
 *   config,get,gps     -> config,gps,ok,E,110.1234567,N,20.1234567
 *   config,get,gpsext  -> config,gps,ok,1,E,113.9739056,N,22.6927826,0,0,184,-3.6,0,2022-11-3 2:43:51
 *   gpsext 第一个字段是定位标记：0=失败，1=成功；其余含经纬度、速度、海拔、方向和 GPS 时间。
 *   config,get,location,2 -> config,location,ok,0,0,0,0,0
 *   location 第一个字段是是否开启：0=关闭，1=开启；后续周期/上报类型/模板/通道一律不进入返回值。
 *
 * 安全边界：
 *   - 不读取 process.env、不做串口 IO、不写文件、不记录日志、不含账号或密钥。
 *   - 坐标只在函数内部用于"有限且落在经纬范围内"的校验，返回前丢弃。
 *   - 没有显式 fix=1 的短回包只能是 UNKNOWN；flag=0、零坐标、越界坐标、非法方向、
 *     命令回显、未知响应一律不得被误判为 FIXED。
 *   - 任意输入（非数组、畸形、超长）都有界且不抛异常；返回值与文本均冻结/固定。
 *
 * 复用同目录 `probe-core.js` 的有界清洗（ANSI/控制字符剥离 + trim + UTF-8 截断）。
 */

const { sanitizeResponseLine } = require('./probe-core');

/** 固定查询命令：只读，绝不写配置。 */
const GNSS_QUERY_COMMAND = 'config,get,gpsext';

/** GPS 配置状态查询：只读，回包形如 config,location,ok,<enabled>,<period>,... */
const GNSS_SETTINGS_QUERY_COMMAND = 'config,get,location,2';

const FIX_FIXED = 'FIXED';
const FIX_NO_FIX = 'NO_FIX';
const FIX_UNKNOWN = 'UNKNOWN';

const SETTINGS_ENABLED = 'ENABLED';
const SETTINGS_DISABLED = 'DISABLED';

/** 处理上限，保证超长/超多输入有界。 */
const MAX_LINES = 64;
const MAX_FIELDS = 64;

const EW_RE = /^[EW]$/;
const NS_RE = /^[NS]$/;
const FIX_FLAG_RE = /^[01]$/;
const COORDINATE_RE = /^[+-]?\d+(?:\.\d+)?$/;
const TIME_RE = /^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}:\d{2}/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 只用于校验：有限、可显式解析、绝对值在范围内。
 * 返回值仅参与布尔判断，绝不进入结果对象。
 */
function parseCoordinate(field, maxAbs) {
  if (typeof field !== 'string' || field.length === 0 || field.length > 32) return null;
  if (!COORDINATE_RE.test(field)) return null;
  const value = Number(field);
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) > maxAbs) return null;
  return value;
}

/** 解析单行 `config,gps,ok,...`；无法识别时返回 null（调用方忽略）。 */
function parseGpsResponse(text) {
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length < 4 || parts.length > MAX_FIELDS + 3) return null;
  if (parts[0].toLowerCase() !== 'config') return null;
  if (parts[1].toLowerCase() !== 'gps') return null;
  if (parts[2].toLowerCase() !== 'ok') return null;

  const fields = parts.slice(3);
  if (fields.length === 0 || fields.length > MAX_FIELDS) return null;
  if (fields.some((field) => field === '')) return null;

  const first = fields[0];

  // 短回包：<EW>,<lon>,<NS>,<lat>，没有显式 fix 标志 -> 只能 UNKNOWN。
  if (EW_RE.test(first)) {
    if (fields.length < 4) return null;
    const hemispheresValid = EW_RE.test(fields[0]) && NS_RE.test(fields[2]);
    const hasTime = fields.slice(4).some((field) => TIME_RE.test(field));
    return { fix: FIX_UNKNOWN, hasTime, hemispheresValid };
  }

  // 扩展回包：<flag>,<EW>,<lon>,<NS>,<lat>,...
  if (FIX_FLAG_RE.test(first)) {
    if (fields.length < 6) return null;
    const hemispheresValid = EW_RE.test(fields[1]) && NS_RE.test(fields[3]);
    let fix = FIX_NO_FIX;
    if (first === '1') {
      const lon = parseCoordinate(fields[2], 180);
      const lat = parseCoordinate(fields[4], 90);
      // 零坐标在 DTU 回包里等价于"无有效定位"，绝不能算 FIXED。
      const coordinatesValid = lon !== null && lat !== null && lon !== 0 && lat !== 0;
      fix = hemispheresValid && coordinatesValid ? FIX_FIXED : FIX_NO_FIX;
    }
    const hasTime = fields.slice(5).some((field) => TIME_RE.test(field));
    return { fix, hasTime, hemispheresValid };
  }

  return null;
}

/**
 * 解析一组串口行，返回冻结的安全摘要。
 * 只允许出现 supported / fix / hasTime / hemispheresValid 四个字段。
 * 同一探测窗口内取"最强证据"：出现任何自洽的 FIXED 即 FIXED，否则 NO_FIX 优先于 UNKNOWN；
 * hasTime / hemispheresValid 为窗口内任意一条有效回包的逻辑或。
 */
function parseGnssLines(lines) {
  const result = {
    supported: false,
    fix: FIX_UNKNOWN,
    hasTime: false,
    hemispheresValid: false
  };

  try {
    if (!Array.isArray(lines)) return Object.freeze(result);
    let processed = 0;
    for (const line of lines) {
      if (processed >= MAX_LINES) break;
      processed += 1;
      const text = sanitizeResponseLine(line);
      if (!text) continue;
      const parsed = parseGpsResponse(text);
      if (!parsed) continue;

      result.supported = true;
      if (parsed.hasTime) result.hasTime = true;
      if (parsed.hemispheresValid) result.hemispheresValid = true;
      if (parsed.fix === FIX_FIXED) {
        result.fix = FIX_FIXED;
      } else if (parsed.fix === FIX_NO_FIX && result.fix !== FIX_FIXED) {
        result.fix = FIX_NO_FIX;
      }
    }
  } catch (_) {
    // 有界：任何异常都不外抛，返回已收集到的结论。
  }

  return Object.freeze(result);
}

/**
 * 只渲染固定枚举文本，绝不包含输入原文、坐标或任何数值。
 * 可安全打印到终端或写入脱敏证据。
 */
function safeGnssSummaryText(summary) {
  try {
    if (!isPlainObject(summary)) return 'GNSS: UNKNOWN';
    if (summary.supported !== true) return 'GNSS: UNSUPPORTED';
    if (summary.fix === FIX_FIXED) {
      const time = summary.hasTime === true ? 'TIME=YES' : 'TIME=NO';
      const hemispheres = summary.hemispheresValid === true ? 'HEMISPHERES=OK' : 'HEMISPHERES=INVALID';
      return `GNSS: FIXED ${time} ${hemispheres}`;
    }
    if (summary.fix === FIX_NO_FIX) return 'GNSS: NO_FIX';
    return 'GNSS: UNKNOWN';
  } catch (_) {
    return 'GNSS: UNKNOWN';
  }
}

/** 解析单行 `config,location,ok,...`；只关心第一个字段 0/1，其余配置一律丢弃。 */
function parseLocationSettingsResponse(text) {
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length < 4 || parts.length > MAX_FIELDS + 3) return null;
  if (parts[0].toLowerCase() !== 'config') return null;
  if (parts[1].toLowerCase() !== 'location') return null;
  if (parts[2].toLowerCase() !== 'ok') return null;

  const fields = parts.slice(3);
  if (fields.length === 0 || fields.length > MAX_FIELDS) return null;

  // 严格只认 0/1；后续周期、上报类型、模板、网络通道一律不进入返回值。
  if (fields[0] === '1') return { enabled: SETTINGS_ENABLED };
  if (fields[0] === '0') return { enabled: SETTINGS_DISABLED };
  return null;
}

/**
 * 解析 GPS 配置状态回包，返回冻结对象，字段只允许 supported 与 enabled。
 * 同一窗口内出现任何 enabled 回包即 ENABLED 优先，其次 DISABLED，最后 UNKNOWN。
 * 命令回显、畸形、超长输入一律忽略且不抛异常。
 */
function parseGnssSettingsLines(lines) {
  const result = { supported: false, enabled: FIX_UNKNOWN };

  try {
    if (!Array.isArray(lines)) return Object.freeze(result);
    let processed = 0;
    for (const line of lines) {
      if (processed >= MAX_LINES) break;
      processed += 1;
      const text = sanitizeResponseLine(line);
      if (!text) continue;
      const parsed = parseLocationSettingsResponse(text);
      if (!parsed) continue;

      result.supported = true;
      if (parsed.enabled === SETTINGS_ENABLED) {
        result.enabled = SETTINGS_ENABLED;
      } else if (parsed.enabled === SETTINGS_DISABLED && result.enabled !== SETTINGS_ENABLED) {
        result.enabled = SETTINGS_DISABLED;
      }
    }
  } catch (_) {
    // 有界：任何异常都不外抛。
  }

  return Object.freeze(result);
}

/** 只渲染固定枚举文本，不回显任何输入。 */
function safeGnssSettingsText(summary) {
  try {
    if (!isPlainObject(summary)) return 'GNSS SETTINGS: UNKNOWN';
    if (summary.supported !== true) return 'GNSS SETTINGS: UNSUPPORTED';
    if (summary.enabled === SETTINGS_ENABLED) return 'GNSS SETTINGS: ENABLED';
    if (summary.enabled === SETTINGS_DISABLED) return 'GNSS SETTINGS: DISABLED';
    return 'GNSS SETTINGS: UNKNOWN';
  } catch (_) {
    return 'GNSS SETTINGS: UNKNOWN';
  }
}

module.exports = {
  GNSS_QUERY_COMMAND,
  GNSS_SETTINGS_QUERY_COMMAND,
  parseGnssLines,
  safeGnssSummaryText,
  parseGnssSettingsLines,
  safeGnssSettingsText
};
