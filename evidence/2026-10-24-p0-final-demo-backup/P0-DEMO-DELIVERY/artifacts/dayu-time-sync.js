#!/usr/bin/env node
'use strict';
/*
 * dayu-time-sync.js — 把 PC 的可信 UTC 时间经 HDC 下发到 DAYU200
 *
 * 为什么需要它（实测根因）：
 *   1. DAYU200（RK3568）开机时内核用 hctosys 从 rtc0=rk808-rtc 取时间；
 *      该 RTC 掉电不保持，板端因此长期停在 2017-08-04，13 位毫秒值虽然"格式正确"但绝对时间错误。
 *   2. 板卡没有默认路由（eth0/eth1 down、wlan0 无 IPv4），无法自行访问 NTP；
 *      板端自带 toybox sntp 也用不上。唯一可用通道是 HDC。
 *   3. 因此把"PC 当前 UTC"作为可信时间源，通过 hdc shell 校准板端系统时钟，
 *      并写回两个 RTC（rtc0 是下次开机的 hctosys 来源，rtc1=hym8563 是电池 RTC）。
 *
 * 安全/边界：
 *   - 只认 hdc list targets -v 中唯一的 "USB Connected" 目标；COM 串口 / UART 列表永远不选。
 *   - 不打印完整设备 ID（只打印前 4 位 + 末 2 位的脱敏形式）。
 *   - 不读写任何密钥、Token、口令。
 *   - 只在漂移超过 --tolerance-ms 时才写时钟；写后必须读回校验，失败即 FAIL，绝不"乐观成功"。
 *   - --watch 模式默认 60 秒检查一次，失败按指数退避（30s→300s 封顶），不会形成忙循环。
 *
 * 用法：
 *   node southbound/dayu-time-sync.js --once            # 一次校时（demo_start 使用）
 *   node southbound/dayu-time-sync.js --watch           # 常驻守护，自动处理重连/重启后的回退
 *   node southbound/dayu-time-sync.js --once --json     # 机器可读输出
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TRUST_FLOOR_MS = 1735689600000;   /* 2025-01-01T00:00:00Z */
const TRUST_CEIL_MS = 4102444800000;    /* 2100-01-01T00:00:00Z */
const SECONDS_MAX = 100000000000;       /* 1e11: 秒/毫秒分界（见 time_util.h） */
const DEFAULT_TOLERANCE_MS = 5000;
const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_BACKOFF_BASE_MS = 30000;
const DEFAULT_BACKOFF_MAX_MS = 300000;
const DEFAULT_HDC = 'D:\\OpenHarmony\\tools\\hdc\\hdc.exe';
const RTC_DEVICES = ['/dev/rtc0', '/dev/rtc1'];

/* ------------------------------------------------------------ 纯逻辑（可单测） */

function looksLikeSeconds(v) {
  return Number.isFinite(v) && v > 0 && v < SECONDS_MAX;
}

/** 秒/毫秒归一化到毫秒。1.8e12 远小于 2^53，JS number 表示毫秒是精确的。 */
function normalizeEpochMs(v) {
  if (!Number.isFinite(v)) return NaN;
  const n = Math.trunc(v);
  return looksLikeSeconds(n) ? n * 1000 : n;
}

/** 只接受 [2025-01-01, 2100-01-01]：2017 年的"合法 13 位"必须判为不可信。 */
function epochMsTrusted(ms) {
  return Number.isFinite(ms) && ms >= TRUST_FLOOR_MS && ms <= TRUST_CEIL_MS;
}

/** 一律以 UTC 呈现，绝不叠加本地时区偏移。 */
function formatUtc(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function absDiffMs(a, b) {
  return Math.abs(a - b);
}

/** 指数退避，封顶；用于 --watch 的失败重试，避免忙循环。 */
function backoffMs(failures, base = DEFAULT_BACKOFF_BASE_MS, max = DEFAULT_BACKOFF_MAX_MS) {
  if (!Number.isFinite(failures) || failures <= 0) return base;
  const raw = base * Math.pow(2, failures - 1);
  return Math.min(max, Math.max(base, raw));
}

/** 解析 hdc list targets -v：只区分 USB 与 UART/COM，绝不把串口当板子。 */
function parseHdcTargets(text) {
  const usb = [];
  const uart = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    const id = cols[0];
    const kind = (cols[1] || '').toUpperCase();
    const state = cols[2] || '';
    if (kind === 'USB') usb.push({ id, state });
    else if (kind === 'UART' || /^COM\d+$/i.test(id)) uart.push({ id, state });
  }
  return { usb, uart };
}

/** 安全选择目标：必须恰好一个 USB Connected；0 个或多于 1 个都拒绝写入。 */
function selectUsbTarget(text) {
  const parsed = parseHdcTargets(text);
  const connected = parsed.usb.filter((t) => /^connected$/i.test(t.state));
  if (connected.length === 0) {
    return { ok: false, code: 'NO_DEVICE', message: 'no USB Connected DAYU200 target', uartCount: parsed.uart.length };
  }
  if (connected.length > 1) {
    return { ok: false, code: 'MULTIPLE_DEVICES', message: connected.length + ' USB Connected targets; refusing to guess' };
  }
  return { ok: true, id: connected[0].id };
}

/** 脱敏：日志里绝不出现完整 HDC 设备 ID。 */
function redactId(id) {
  const s = String(id || '');
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '…' + s.slice(-2);
}

/* ------------------------------------------------------------ HDC 调用 */

/**
 * 用"输出重定向到临时文件"的方式调用 hdc。
 * 不用管道：某些受限环境下管道 stdio 会 EPERM；写文件在所有环境下都可靠。
 */
function runHdcFile(hdcPath, argv, timeoutMs = 20000) {
  const tmp = path.join(os.tmpdir(), 'dayu-time-sync-' + process.pid + '-' + Date.now() + '.out');
  const fd = fs.openSync(tmp, 'w');
  let res;
  try {
    res = spawnSync(hdcPath, argv, { stdio: ['ignore', fd, fd], windowsHide: true, timeout: timeoutMs });
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* 已关闭 */ }
  }
  let text = '';
  try { text = fs.readFileSync(tmp, 'utf8'); } catch (e) { /* 无输出 */ }
  try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
  if (res.error) throw new Error('hdc spawn failed: ' + (res.error.code || res.error.message));
  if (res.status !== 0) throw new Error('hdc exit ' + res.status + ': ' + text.trim().slice(0, 200));
  return text;
}

function makeHdcRunner(hdcPath) {
  return function run(target, args) {
    const argv = target ? ['-t', target].concat(args) : args.slice();
    return runHdcFile(hdcPath, argv);
  };
}

/**
 * 读板端 epoch 毫秒。优先用 toybox 的 "date +%s%3N"（毫秒精度），
 * 不支持时回退 "date +%s"（整秒）。整秒回退会把测量误差放大到 ±1s，
 * 所以只有毫秒读取失败才降级，并且降级事实会记在结果的 readPrecision 里。
 */
function readDeviceEpochMs(run, target) {
  let first = '';
  let precision = 'ms';
  try {
    const raw = run(target, ['shell', 'date +%s%3N']);
    first = String(raw).trim().split(/\s+/)[0];
  } catch (e) {
    first = '';
  }
  if (!/^\d{10,13}$/.test(first) || first.length !== 13) {
    precision = 'seconds';
    const raw = run(target, ['shell', 'date +%s']);
    first = String(raw).trim().split(/\s+/)[0];
  }
  return { value: first, ms: normalizeEpochMs(Number(first)), precision: precision };
}

/* ------------------------------------------------------------ 单次校时 */

/**
 * @param {object} o
 * @param {function} o.run      注入：run(targetId|null, hdcArgs) => stdout
 * @param {function} [o.now]    注入：() => epoch ms
 * @param {number}   [o.toleranceMs]
 * @param {function} [o.log]
 */
function syncOnce(o) {
  const run = o.run;
  const now = o.now || Date.now;
  const toleranceMs = Number.isFinite(o.toleranceMs) ? o.toleranceMs : DEFAULT_TOLERANCE_MS;
  const log = o.log || function () {};
  const result = { status: 'FAIL', code: 'UNKNOWN', toleranceMs: toleranceMs, steps: [] };

  const pcMs = now();
  result.pcUtc = formatUtc(pcMs);
  result.pcMs = pcMs;
  if (!epochMsTrusted(pcMs)) {
    result.code = 'PC_CLOCK_UNTRUSTED';
    result.message = 'PC clock ' + result.pcUtc + ' is outside the trusted window';
    return result;
  }

  let targetsText;
  try {
    targetsText = run(null, ['list', 'targets', '-v']);
  } catch (e) {
    result.code = 'HDC_UNAVAILABLE';
    result.message = String(e.message || e);
    return result;
  }
  const sel = selectUsbTarget(targetsText);
  if (!sel.ok) {
    result.code = sel.code;
    result.message = sel.message;
    result.uartCount = sel.uartCount || 0;
    return result;
  }
  result.target = redactId(sel.id);

  let before;
  try {
    /* 用 PC 侧 t0/t1 的中点作为"读取瞬间"的 PC 时间：
       单次 HDC shell 往返约 0.5–1s，直接用 now() 会把往返延迟算进偏差里。 */
    const t0 = now();
    before = readDeviceEpochMs(run, sel.id);
    before.pcMid = (t0 + now()) / 2;
  } catch (e) {
    result.code = 'READ_FAILED';
    result.message = String(e.message || e);
    return result;
  }
  if (!Number.isFinite(before.ms)) {
    result.code = 'READ_UNPARSABLE';
    result.message = 'device date returned: ' + String(before.value).slice(0, 80);
    return result;
  }
  result.readPrecision = before.precision;
  const deviceMs = before.ms;
  result.deviceMsBefore = deviceMs;
  result.deviceUtcBefore = formatUtc(deviceMs);
  result.pcMidBeforeMs = before.pcMid;
  result.driftMsBefore = absDiffMs(before.pcMid, deviceMs);

  if (epochMsTrusted(deviceMs) && result.driftMsBefore <= toleranceMs) {
    result.status = 'OK';
    result.code = 'ALREADY_IN_SYNC';
    return result;
  }

  /* 写入：系统时钟（@epoch 与本地时区无关）+ 两个 RTC。
     实测板端 toybox date 会**截掉**小数部分（date -s @X.750 实际得到 X.000），
     所以这里取"最近的整秒"而不是截断，把残差限制在 ±500ms 以内。
     另注：板端 sh 的 $(( )) 是 32 位，绝不能在 shell 里对 13 位毫秒做算术。 */
  const setSec = Math.round(pcMs / 1000);
  const setArg = '@' + setSec;
  try {
    run(sel.id, ['shell', 'date -u -s ' + setArg]);
    result.steps.push('date -u -s ' + setArg);
  } catch (e) {
    result.code = 'SET_FAILED';
    result.message = String(e.message || e);
    return result;
  }
  for (const dev of RTC_DEVICES) {
    try {
      run(sel.id, ['shell', 'hwclock -w -f ' + dev]);
      result.steps.push('hwclock -w -f ' + dev);
    } catch (e) {
      /* RTC 写失败不致命：系统时钟已校准；但要如实记录 */
      result.steps.push('hwclock -w -f ' + dev + ' FAILED: ' + String(e.message || e).slice(0, 80));
    }
  }

  let after;
  try {
    const t2 = now();
    after = readDeviceEpochMs(run, sel.id);
    after.pcMid = (t2 + now()) / 2;
  } catch (e) {
    result.code = 'VERIFY_READ_FAILED';
    result.message = String(e.message || e);
    return result;
  }
  const afterMs = after.ms;
  result.deviceMsAfter = afterMs;
  result.deviceUtcAfter = formatUtc(afterMs);
  result.driftMsAfter = absDiffMs(after.pcMid, afterMs);

  if (!epochMsTrusted(afterMs)) {
    result.code = 'VERIFY_UNTRUSTED';
    result.message = 'device still reports ' + result.deviceUtcAfter + ' after set';
    return result;
  }
  if (result.driftMsAfter > toleranceMs) {
    result.code = 'VERIFY_DRIFT';
    result.message = 'drift ' + result.driftMsAfter + 'ms > tolerance ' + toleranceMs + 'ms';
    return result;
  }
  result.status = 'SET';
  result.code = 'SYNCED';
  log('[time-sync] set device clock: before=' + result.deviceUtcBefore +
      ' after=' + result.deviceUtcAfter + ' drift(before)=' + result.driftMsBefore + 'ms');
  return result;
}

/* ------------------------------------------------------------ 主流程 */

function parseArgv(argv) {
  const o = {
    mode: 'once',
    toleranceMs: DEFAULT_TOLERANCE_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    hdc: DEFAULT_HDC,
    json: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.mode = 'once';
    else if (a === '--watch') o.mode = 'watch';
    else if (a === '--json') o.json = true;
    else if (a === '--tolerance-ms') o.toleranceMs = Number(argv[++i]);
    else if (a === '--interval-ms') o.intervalMs = Number(argv[++i]);
    else if (a === '--hdc') o.hdc = argv[++i];
  }
  return o;
}

function describe(r) {
  const bits = [r.status, r.code];
  if (r.pcUtc) bits.push('pc=' + r.pcUtc);
  if (r.target) bits.push('target=' + r.target);
  if (r.deviceUtcBefore) bits.push('device_before=' + r.deviceUtcBefore);
  if (r.driftMsBefore !== undefined) bits.push('drift_before=' + r.driftMsBefore + 'ms');
  if (r.deviceUtcAfter) bits.push('device_after=' + r.deviceUtcAfter);
  if (r.driftMsAfter !== undefined) bits.push('drift_after=' + r.driftMsAfter + 'ms');
  if (r.message) bits.push(r.message);
  return '[time-sync] ' + bits.join(' ');
}

function main(argv) {
  const opt = parseArgv(argv);
  const run = makeHdcRunner(opt.hdc);
  const log = (s) => { if (!opt.json) console.log(s); };

  if (opt.mode === 'once') {
    const r = syncOnce({ run: run, toleranceMs: opt.toleranceMs, log: log });
    if (opt.json) console.log(JSON.stringify(r, null, 1));
    else console.log(describe(r));
    return (r.status === 'OK' || r.status === 'SET') ? 0 : 1;
  }

  /* watch：低频检查 + 指数退避；成功即回到正常间隔，绝不高频轮询 */
  let failures = 0;
  const tick = () => {
    const r = syncOnce({ run: run, toleranceMs: opt.toleranceMs, log: log });
    if (opt.json) console.log(JSON.stringify(r));
    else console.log(new Date().toISOString() + ' ' + describe(r));
    let delay;
    if (r.status === 'OK' || r.status === 'SET') { failures = 0; delay = opt.intervalMs; }
    else { failures += 1; delay = backoffMs(failures); }
    setTimeout(tick, delay);
  };
  log('[time-sync] watch mode: interval=' + opt.intervalMs + 'ms tolerance=' + opt.toleranceMs + 'ms');
  tick();
  return 0;   /* watch 不退出；由外部结束进程 */
}

module.exports = {
  TRUST_FLOOR_MS,
  TRUST_CEIL_MS,
  SECONDS_MAX,
  DEFAULT_TOLERANCE_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  RTC_DEVICES,
  looksLikeSeconds,
  normalizeEpochMs,
  epochMsTrusted,
  formatUtc,
  absDiffMs,
  backoffMs,
  parseHdcTargets,
  selectUsbTarget,
  redactId,
  readDeviceEpochMs,
  syncOnce,
  parseArgv,
  describe,
  main
};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
