'use strict';

/**
 * lib/probe-device-core.js — YED-M100MG-B1 诊断 CLI 的纯逻辑核心（可单元测试）
 *
 * 与 CLI 的分工：
 *   - 本模块：参数解析、夹具选择、探测执行、failover 演示、稳定 JSON 组装。不做 argv/stdio。
 *   - probe-device.js：只负责进程入口、真实串口注入、信号处理与退出码。
 *
 * 安全边界：
 *   - 夹具模式是默认模式，绝不开串口；真实模式必须显式传 real:true + port。
 *   - 输出前统一经 lib/privacy.js 深度脱敏；错误对象同样脱敏。
 *   - `--at` 只允许夹具模式：本地无 AT 证据，禁止对真实设备发送 AT 命令。
 */

const path = require('node:path');

const { deepRedact, safeJsonStringify, sanitizeLine } = require('./privacy');
const { probeDevice, readonlyCommands } = require('./device');
const { loadFixtureFile, parseFixtureText, FixtureTransport } = require('./fixture-transport');
const { parseAtResponse, AT_PROBE_BLOCKED } = require('./at-parser');
const { summarizeDeviceState, CSQ_UNKNOWN } = require('./dtu-protocol');
const { FailoverStateMachine, STATES, ACTIONS } = require('./failover');
const { ERROR_CODES } = require('./transport');

const EXIT = Object.freeze({
  OK: 0,
  FAILED: 1,
  USAGE: 64,
  PARTIAL: 2
});

/** 内置夹具配置（无硬件演示用）。 */
const FIXTURE_PROFILES = Object.freeze({
  registered: 'device-registered.fixture',
  'gnss-fixed': 'device-gnss-fixed.fixture',
  'no-fix': 'device-no-fix.fixture',
  'csq-invalid': 'device-csq-invalid.fixture',
  'error-timeout-drop': 'device-error-timeout-drop.fixture',
  at: 'at-standard.fixture'
});

const DEFAULT_PROFILE = 'registered';

/**
 * AT 夹具模式使用的只读查询序列。
 *
 * 边界：这些命令**只对夹具发送**，绝不对真实设备发送——本地资料没有该模块的
 * AT 指令证据（见 AT_PROBE_BLOCKED）。最后一条 `AT+CGMR` 与
 * `lib/fixtures/at-standard.fixture` 里那条 ERROR 应答对应，用于覆盖
 * 「设备返回 ERROR」这条解析路径；如果它不在发送列表里，夹具里的
 * `>>> AT+CGMR` / `ERROR` 转录永远不会被请求，ERROR 分支也就无从验证。
 */
const AT_QUERY_COMMANDS = Object.freeze([
  'AT+CPIN?',
  'AT+CSQ',
  'AT+CREG?',
  'AT+CEREG?',
  'AT+COPS?',
  'AT+CGMR'
]);

function usage() {
  return [
    'Usage:',
    '  node probe-device.js --fixture [--profile registered|gnss-fixed|no-fix|csq-invalid|error-timeout-drop]',
    '  node probe-device.js --fixture --fixture-file <path> [--samples N]',
    '  node probe-device.js --fixture --profile at --at',
    '  node probe-device.js --real --port COM99 [--baud 115200] [--timeout 1500] [--retries 1]',
    '  node probe-device.js --failover-demo [--wifi-down-delay 3000] [--wifi-stable 10000]',
    '  node probe-device.js --help',
    '',
    'Safety:',
    '  --fixture (default) never opens a serial port.',
    '  --real requires BOTH --real and --port; tests never touch a real port automatically.',
    '  --at is fixture-only: local product material contains no AT evidence for this module.',
    '  Output JSON is deep-redacted; identifiers are never printed in full.'
  ].join('\n');
}

function parseIntegerArg(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value ?? ''))) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be in [${minimum}, ${maximum}]`);
  }
  return parsed;
}

/**
 * 解析 CLI 参数（纯函数，不读取 process.env / process.argv）。
 * @throws Error 用法错误（调用方映射为退出码 64）
 */
function parseArgs(argv = []) {
  const options = {
    mode: 'fixture',
    profile: null,
    fixtureFile: null,
    samples: 1,
    gnss: true,
    at: false,
    raw: false,
    pretty: false,
    out: null,
    baudRate: 115200,
    timeoutMs: 1500,
    retries: 1,
    real: false,
    port: null,
    failoverDemo: false,
    wifiDownDelayMs: 3000,
    wifiStableMs: 10000,
    maxAttemptsBeforeOffline: 5,
    backoffBaseMs: 1000,
    backoffMaxMs: 60000
  };
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const argument = String(list[index]);
    switch (argument) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--fixture':
        options.mode = 'fixture';
        break;
      case '--real':
        options.mode = 'real';
        options.real = true;
        break;
      case '--at':
        options.at = true;
        break;
      case '--raw':
        options.raw = true;
        break;
      case '--pretty':
        options.pretty = true;
        break;
      case '--no-gnss':
        options.gnss = false;
        break;
      case '--failover-demo':
        options.failoverDemo = true;
        break;
      case '--port':
        options.port = String(list[++index] ?? '');
        break;
      case '--baud':
        options.baudRate = parseIntegerArg(list[++index], '--baud', 1200, 460800);
        break;
      case '--timeout':
        options.timeoutMs = parseIntegerArg(list[++index], '--timeout', 200, 30000);
        break;
      case '--retries':
        options.retries = parseIntegerArg(list[++index], '--retries', 0, 10);
        break;
      case '--samples':
        options.samples = parseIntegerArg(list[++index], '--samples', 1, 50);
        break;
      case '--profile':
        options.profile = String(list[++index] ?? '');
        break;
      case '--fixture-file':
        options.fixtureFile = String(list[++index] ?? '');
        break;
      case '--out':
        options.out = String(list[++index] ?? '');
        break;
      case '--wifi-down-delay':
        options.wifiDownDelayMs = parseIntegerArg(list[++index], '--wifi-down-delay', 0, 600000);
        break;
      case '--wifi-stable':
        options.wifiStableMs = parseIntegerArg(list[++index], '--wifi-stable', 0, 600000);
        break;
      case '--max-attempts':
        options.maxAttemptsBeforeOffline = parseIntegerArg(list[++index], '--max-attempts', 1, 100);
        break;
      case '--backoff-base':
        options.backoffBaseMs = parseIntegerArg(list[++index], '--backoff-base', 1, 600000);
        break;
      case '--backoff-max':
        options.backoffMaxMs = parseIntegerArg(list[++index], '--backoff-max', 1, 3600000);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (options.help) return Object.freeze(options);
  if (options.failoverDemo) return Object.freeze(options);

  // `--port` 单独出现是危险的歧义：用户以为要开真实串口，实际却会静默走夹具模式。
  if (options.port !== null && options.mode !== 'real') {
    throw new Error('--port requires --real; fixture mode never opens a serial port');
  }

  if (options.mode === 'real') {
    if (typeof options.port !== 'string' || options.port === '') {
      throw new Error('real mode requires an explicit --port (e.g. --port COM99)');
    }
    if (!/^(?:COM\d{1,3}|\/dev\/[A-Za-z0-9._/-]+)$/.test(options.port)) {
      throw new Error('--port must be a COM port or /dev serial path');
    }
    if (options.at) {
      throw new Error('--at is fixture-only: local material has no AT command evidence for this module');
    }
  }
  if (options.at && !options.fixtureFile && options.profile === null) options.profile = 'at';
  if (options.profile !== null && !Object.prototype.hasOwnProperty.call(FIXTURE_PROFILES, options.profile)) {
    throw new Error(`unknown --profile: ${options.profile} (expected ${Object.keys(FIXTURE_PROFILES).join('|')})`);
  }
  return Object.freeze(options);
}

/** 解析夹具路径；profile 与 fixture-file 二选一。 */
function resolveFixturePath(options, baseDir) {
  if (options.fixtureFile) return path.resolve(baseDir, options.fixtureFile);
  const profile = options.profile || DEFAULT_PROFILE;
  const file = FIXTURE_PROFILES[profile];
  // 夹具目录是 `lib/fixtures`（本模块位于 lib/），不是与模块同级的 `fixtures`。
  return path.join(baseDir, 'fixtures', file);
}

/** 构造探测器注入的解析器：AT 夹具走 at-parser，DTU 走 dtu-protocol。 */
function createParser(options) {
  if (options.at) {
    return (lines) => {
      const parsed = parseAtResponse(lines);
      return {
        protocol: 'AT_3GPP_FRAMEWORK_ONLY',
        at: parsed,
        blocked: AT_PROBE_BLOCKED,
        dtu: null
      };
    };
  }
  return (lines) => Object.freeze({ protocol: 'YED_DTU_CONFIG', at: null, dtu: summarizeDeviceState(lines) });
}

/**
 * 夹具模式探测。夹具只读，不打开任何串口。
 * `samples` 会重复整个命令序列，用于回放同一命令的多个应答体（例如 CSQ 0/31/99/非法）。
 */
async function runFixtureProbe(options, baseDir) {
  // 默认以本模块所在目录（lib/）为基准，夹具固定在 lib/fixtures/。
  const resolvedBaseDir = typeof baseDir === 'string' && baseDir !== '' ? baseDir : __dirname;
  const fixturePath = resolveFixturePath(options, resolvedBaseDir);
  const transcripts = loadFixtureFile(fixturePath);
  const commands = options.at
    ? [...AT_QUERY_COMMANDS]
    : [...readonlyCommands({ includeGnss: options.gnss !== false })];

  const transport = new FixtureTransport(transcripts, {
    port: `FIXTURE:${path.basename(fixturePath)}`,
    baudRate: options.baudRate
  });
  await transport.open();

  const samples = [];
  try {
    for (let index = 0; index < options.samples; index += 1) {
      const result = await probeDevice({
        transport,
        commands,
        parser: createParser(options),
        commandTimeoutMs: options.timeoutMs,
        retries: options.retries
      });
      samples.push(result);
      if (transport.isOpen !== true) break; // 夹具模拟掉线后停止继续采样。
    }
  } finally {
    await transport.disconnect();
  }

  return {
    mode: 'fixture',
    fixtureFile: path.basename(fixturePath),
    commands,
    samples
  };
}

/** 4G 连接尝试在演示中的固定超时（毫秒）。 */
const FAILOVER_ATTEMPT_TIMEOUT_MS = 20000;

/**
 * 演示时间线的固定锚点（相对 Wi-Fi 掉线点）。
 *
 * 说明：状态机是事件驱动的，单次 `tick(t)` 只会完成一个阶段。因此真实推进由
 * `runFailoverDemo` 按状态机自己给出的 `nextAttemptAtMs` 逐次进行；本函数只负责
 * 产出确定性的、可断言的固定锚点集合，避免把时间依赖藏进循环里。
 */
function buildFailoverTimeline(options) {
  const downDelay = options.wifiDownDelayMs;
  const stable = options.wifiStableMs;
  const maxAttempts = options.maxAttemptsBeforeOffline;

  const anchors = [
    { atMs: 0, label: 'wifi_up' },
    { atMs: 1000, label: 'wifi_down' },
    { atMs: 1200, label: 'wifi_flap_up' },
    { atMs: 1400, label: 'wifi_flap_down' },
    { atMs: 1000 + Math.max(1, downDelay - 1), label: 'wifi_debounce_pending' },
    { atMs: 1000 + downDelay + 1, label: 'debounce_elapsed' }
  ];

  // 上限只用于提供「最早可能到达 OFFLINE」的时间下界；真实到达时间由退避决定。
  const lowerBound = 1000 + downDelay + 1 + maxAttempts * FAILOVER_ATTEMPT_TIMEOUT_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    anchors.push({
      atMs: lowerBound + attempt,
      label: `recovery_anchor_${attempt}`,
      simulated: true
    });
  }
  anchors.push({
    atMs: lowerBound + maxAttempts + Math.max(1, Math.floor(stable / 2)) + 1,
    label: 'wifi_not_stable_yet',
    simulated: true
  });
  anchors.push({
    atMs: lowerBound + maxAttempts + stable + 2,
    label: 'wifi_stable',
    simulated: true
  });
  anchors.push({
    atMs: lowerBound + maxAttempts + stable + 100,
    label: 'settled',
    simulated: true
  });
  return anchors;
}

/**
 * 纯软件 failover 演示：注入确定性时间，不触碰真实网络。
 * @returns {object} 冻结的演示结果，含 timeline / transitions / actions / backoffSamples
 */
function runFailoverDemo(options) {
  const downDelay = options.wifiDownDelayMs;
  const stable = options.wifiStableMs;
  const maxAttempts = options.maxAttemptsBeforeOffline;

  const transitions = [];
  const actions = [];
  const timeline = [];
  let nowMs = 0;

  const machine = new FailoverStateMachine(
    {
      wifiDownDelayMs: downDelay,
      wifiStableMs: stable,
      maxAttemptsBeforeOffline: maxAttempts,
      backoffBaseMs: options.backoffBaseMs,
      backoffMaxMs: options.backoffMaxMs
    },
    {
      onTransition: (event) => transitions.push({ ...event }),
      onAction: (event) => actions.push({ ...event })
    }
  );

  /** 记录当前状态机快照。 */
  const record = (atMs, label) => {
    const status = machine.getStatus();
    timeline.push({
      atMs,
      step: label,
      state: status.state,
      activePath: status.activePath,
      attempt: status.attempt,
      nextAttemptAtMs: status.nextAttemptAtMs
    });
  };

  /**
   * 前进到 `targetMs` 并 tick，记录一次推进。
   * 只在状态/尝试数/退避变化或 `force` 为真时记录，避免退避窗口内产生
   * 大量无意义的重复条目。
   */
  const advanceTo = (targetMs, label, force = false) => {
    const before = machine.getStatus();
    nowMs = Math.max(nowMs, targetMs);
    machine.tick(nowMs);
    const after = machine.getStatus();
    const changed =
      force === true ||
      before.state !== after.state ||
      before.attempt !== after.attempt ||
      before.nextAttemptAtMs !== after.nextAttemptAtMs ||
      before.activePath !== after.activePath;
    if (changed) record(nowMs, label);
    return after;
  };

  machine.reportWifi(true, 0);
  record(0, 'wifi_up');

  // Wi-Fi 先掉线，再在去抖窗口内抖动一次。
  nowMs = 1000;
  machine.reportWifi(false, 1000);
  record(1000, 'wifi_down');

  nowMs = 1200;
  machine.reportWifi(true, 1200);
  record(1200, 'wifi_flap_up');

  nowMs = 1400;
  machine.reportWifi(false, 1400);
  record(1400, 'wifi_flap_down');

  // 抖动结束后必须真正处于「Wi-Fi 不可用」状态：否则 reportWifi 的重复上报
  // 不会刷新基准时间，后续所有基于 tick 的推进都会被当成 Wi-Fi 仍可用而短路。
  nowMs = 1600;
  machine.reportWifi(false, 1600);
  record(1600, 'wifi_still_down');

  // 去抖窗口内：不得发起切换。
  advanceTo(1600 + Math.max(1, downDelay - 1), 'wifi_debounce_pending');

  // 去抖窗口到期：发起 4G 备链。
  const debounceDeadlineMs = 1600 + downDelay + 1;

  // 逐次推进直到 OFFLINE。
  //
  // 这里刻意在驱动侧维护一个两阶段标记，而不是猜测状态机的内部状态：
  // `getStatus()` 无法区分「已有在途尝试」和「正在指数退避」——两种情况下
  // `locked` 都可能为 true，`nextAttemptAtMs` 也可能非 null。因此驱动自己记住：
  //   IN_FLIGHT  已发起连接，等 FAILOVER_ATTEMPT_TIMEOUT_MS 判定本次失败
  //   BACKOFF    已失败，等状态机给出的 nextAttemptAtMs 到期后允许重试
  // 每次 reportCellular(false) 后进入 BACKOFF，下一次推进目标直接取自
  // nextAttemptAtMs，因此推进顺序完全由状态机决定，且保证收敛到 OFFLINE。
  let timeoutSeq = 0;
  let phase = 'IN_FLIGHT';
  let dueAtMs = debounceDeadlineMs;
  const bound = maxAttempts * 3 + 10;

  for (let index = 0; index < bound && machine.state !== STATES.OFFLINE; index += 1) {
    if (phase === 'BACKOFF') {
      const status = machine.getStatus();
      dueAtMs = status.nextAttemptAtMs === null ? nowMs : status.nextAttemptAtMs;
      advanceTo(dueAtMs, `retry_backoff_${status.attempt + 1}`, true);
      phase = 'IN_FLIGHT';
      continue;
    }

    advanceTo(dueAtMs, 'connect_or_timeout');
    const status = machine.getStatus();
    if (status.state === STATES.CELLULAR_CONNECTING || status.state === STATES.CELLULAR_ACTIVE) {
      timeoutSeq += 1;
      const failedAtMs = nowMs + FAILOVER_ATTEMPT_TIMEOUT_MS;
      nowMs = failedAtMs;
      machine.reportCellular(false, failedAtMs);
      record(failedAtMs, `attempt_timeout_${timeoutSeq}`);
      phase = 'BACKOFF';
      continue;
    }
    // 还没进入 CELLULAR_CONNECTING：推进到去抖截止时刻再试。
    dueAtMs = Math.max(nowMs + 1, debounceDeadlineMs);
  }
  if (machine.state === STATES.OFFLINE) {
    record(nowMs, 'cellular_offline');
  } else {
    // 有界兜底：极端配置下也不无限循环。
    advanceTo(nowMs + FAILOVER_ATTEMPT_TIMEOUT_MS * 2, 'cellular_bounded');
  }

  // Wi-Fi 恢复：未稳定前不回切，稳定 wifiStableMs 后回切。
  const wifiBackAt = nowMs + 1000;
  machine.reportWifi(true, wifiBackAt);
  nowMs = wifiBackAt;
  record(nowMs, 'wifi_back');

  const halfwayAt = wifiBackAt + Math.max(1, Math.floor(stable / 2));
  // 强制记录：这一步的意义就是证明「Wi-Fi 已恢复但尚未稳定，不得回切」。
  advanceTo(halfwayAt, 'wifi_not_stable_yet', true);

  const stableAt = wifiBackAt + stable;
  advanceTo(stableAt, 'wifi_stable');

  advanceTo(stableAt + 100, 'settled');

  const backoffSamples = [];
  for (let attempt = 0; attempt <= 6; attempt += 1) {
    const base = options.backoffBaseMs;
    const max = options.backoffMaxMs;
    const raw = base * Math.pow(2, attempt);
    backoffSamples.push({ attempt, delayMs: Math.min(max, Math.max(base, raw)) });
  }

  return {
    mode: 'failover-demo',
    claims: {
      realWifiToCellularTakeoverVerified: false,
      note:
        'Pure software state machine only. No real network was touched; Wi-Fi to 4G automatic takeover is NOT verified.'
    },
    config: machine.config,
    timeline,
    transitions,
    actions,
    backoffSamples,
    finalState: machine.getStatus()
  };
}

/** 汇总一次/多次采样为稳定 JSON。 */
function buildReport({ options, probeResult, failures }) {
  const samples = probeResult.samples || [];
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const deviceSamples = samples.map((sample) => (sample.device && sample.device.dtu) || null);
  const allCommands = samples.flatMap((sample) => sample.commands || []);
  const succeeded = allCommands.filter((entry) => entry.ok === true).length;
  const failed = allCommands.length - succeeded;

  const report = {
    schemaVersion: 1,
    mode: probeResult.mode,
    protocol: options.at ? 'AT_3GPP_FRAMEWORK_ONLY' : 'YED_DTU_CONFIG',
    generatedAtMs: Date.now(),
    options: {
      fixtureFile: probeResult.fixtureFile || null,
      port: options.mode === 'real' ? options.port : null,
      baudRate: options.baudRate,
      commandTimeoutMs: options.timeoutMs,
      retries: options.retries,
      samples: options.samples,
      includeGnss: options.gnss !== false,
      includeRawLines: options.raw === true
    },
    commands: probeResult.commands,
    summary: {
      samples: samples.length,
      commandsAttempted: allCommands.length,
      commandsSucceeded: succeeded,
      commandsFailed: failed,
      urcCount: samples.reduce((total, sample) => total + (sample.urc || []).length, 0)
    },
    device: latest ? latest.device && latest.device.dtu : null,
    deviceSamples,
    at: options.at ? { blocked: AT_PROBE_BLOCKED } : null,
    urc: latest ? latest.urc : [],
    failures,
    rawLines: options.raw ? samples.map((sample) => (sample.commands || []).map((entry) => entry.lines)) : null,
    notes: [
      'Fixture mode replays constructed responses; it does NOT prove real 4G, GNSS or OneNET behaviour.',
      'This module uses the YED DTU config protocol; AT is only a documented, unused framework.'
    ]
  };

  if (options.at) {
    // AT 夹具只展示解析结果，设备字段置空以示区分。
    const atLines = samples.flatMap((sample) => (sample.commands || []).flatMap((entry) => entry.lines || []));
    report.device = null;
    report.deviceSamples = null;
    report.at = { blocked: AT_PROBE_BLOCKED, parsed: parseAtResponse(atLines) };
  }
  if (report.rawLines === null) delete report.rawLines;
  return deepRedact(report);
}

function exitCodeFor(report) {
  const summary = report.summary || {};
  if (summary.commandsAttempted === 0) return EXIT.FAILED;
  if (summary.commandsFailed === 0) return EXIT.OK;
  if (summary.commandsSucceeded > 0) return EXIT.PARTIAL;
  return EXIT.FAILED;
}

/** 稳定 JSON 文本（深度脱敏 + 固定缩进）。 */
function renderReport(report, pretty) {
  return pretty ? safeJsonStringify(report, 2) : safeJsonStringify(report, 0);
}

/** 供 CLI 与测试共用：夹具目录默认位置。 */
function defaultBaseDir() {
  return __dirname;
}

/** 校验 CLI 输出路径（只允许本目录内的相对路径或绝对路径）。 */
function normalizeOutPath(outPath, cwd) {
  const trimmed = sanitizeLine(outPath);
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd || process.cwd(), trimmed);
}

module.exports = {
  EXIT,
  FIXTURE_PROFILES,
  DEFAULT_PROFILE,
  AT_QUERY_COMMANDS,
  usage,
  parseArgs,
  parseIntegerArg,
  resolveFixturePath,
  createParser,
  runFixtureProbe,
  runFailoverDemo,
  buildFailoverTimeline,
  buildReport,
  exitCodeFor,
  renderReport,
  defaultBaseDir,
  normalizeOutPath,
  STATES,
  ACTIONS,
  CSQ_UNKNOWN,
  ERROR_CODES
};
