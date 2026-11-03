'use strict';

/**
 * file-level-injection.js — 回滚事务的**文件级**故障注入台架
 *
 * 目的：不需要 Docker 也能验证回滚事务状态机在各类故障下的**最终数据状态**
 *       （而不只是“退出码非零”）：逐项落位、部分复制、校验失败、二次恢复失败、进程被硬中断后 resume。
 *
 * 证据等级：本台架用 Node fs 在临时目录上模拟卷内逐项操作，
 *   它证明的是**状态机逻辑与撤销清单**；Docker 卷/容器语义由
 *   sandbox/docker-validation.js 单独验证。
 *
 * 隔离：只用 %TEMP% 下的临时目录；合成数据；不涉及任何真实数据/容器/卷。
 *
 * 用法：node rehearsal/file-level-injection.js [--keep]
 * 输出：rehearsal/file-level-results.json + rehearsal/file-level-console.log
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const DELIVERY = path.resolve(__dirname, '..');
const TX_SCRIPT = path.join(DELIVERY, 'rollback', 'rollback-transaction.js');
const OUT_JSON = path.join(DELIVERY, 'rehearsal', 'file-level-results.json');
const OUT_LOG = path.join(DELIVERY, 'rehearsal', 'file-level-console.log');

const { inventory, sha256File, TX_DIRNAME } = require(TX_SCRIPT);

const KEEP = process.argv.includes('--keep');
const logLines = [];

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  logLines.push(line);
  console.log(message);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/* ------------------------------------------------------------ 合成 fixture */

function v5State() {
  return {
    schemaVersion: 5,
    savedAt: 1792950000000,
    devices: [
      { deviceId: 'rehearsal-fixture-bath', room: '合成演练-卫生间', online: true, monitorOnline: 1, state: 'ALARM', lastSeenTs: 1792949990000, sensors: { motion: { lastActiveTs: 1792949990000, countToday: 3 } } },
      { deviceId: 'rehearsal-fixture-kitchen', room: '合成演练-厨房', online: true, monitorOnline: 1, state: 'NORMAL', lastSeenTs: 1792949990000, sensors: { climate: { tempC: 24.5, rh: 51, ok: true } } },
      { deviceId: 'rehearsal-fixture-living', room: '合成演练-客厅', online: false, monitorOnline: 0, state: 'OFFLINE', lastSeenTs: 1792949000000, sensors: {} }
    ],
    alerts: [
      { alarmId: 'rehearsal-alarm-1', deviceId: 'rehearsal-fixture-bath', room: '合成演练-卫生间', type: 'MANUAL_SOS', status: 'ALARM', ackPending: false, createdAt: 1792949000000 },
      { alarmId: 'rehearsal-alarm-2', deviceId: 'rehearsal-fixture-living', room: '合成演练-客厅', type: 'NO_MOTION', status: 'ALARM', ackPending: true, createdAt: 1792949500000 }
    ],
    commands: [],
    contacts: [],
    notifications: [],
    subscriptions: [],
    communications: []
  };
}

function v6State() {
  return {
    ...v5State(),
    schemaVersion: 6,
    savedAt: 1792953600000,
    safetyLogs: [
      { dispositionId: 'dsp-1', clientDispositionId: 'rehearsal-disp-0001', alarmId: 'rehearsal-alarm-1', deviceId: 'rehearsal-fixture-bath', room: '合成演练-卫生间', type: 'MANUAL_SOS', outcome: 'CONTACTED_FAMILY', note: '合成演练：已联系家属', actor: 'household-guardian', serverTime: 1792953000000 },
      { dispositionId: 'dsp-2', clientDispositionId: 'rehearsal-disp-0002', alarmId: 'rehearsal-alarm-1', deviceId: 'rehearsal-fixture-bath', room: '合成演练-卫生间', type: 'MANUAL_SOS', outcome: 'ON_SITE_CONFIRMED_NORMAL', note: '合成演练：现场确认正常', actor: 'household-guardian', serverTime: 1792953100000 },
      { dispositionId: 'dsp-3', clientDispositionId: 'rehearsal-disp-0003', alarmId: 'rehearsal-alarm-2', deviceId: 'rehearsal-fixture-living', room: '合成演练-客厅', type: 'NO_MOTION', outcome: 'FALSE_ALARM', note: '', actor: 'household-guardian', serverTime: 1792953200000 }
    ]
  };
}

function activityState() {
  return {
    version: 1,
    savedAt: 1792953600000,
    activity: {
      timezone: 'Asia/Shanghai',
      devices: [{
        deviceId: 'rehearsal-fixture-bath',
        hasMotionSensor: true,
        dataSince: 1792949000000,
        baseline: { countToday: 8, date: '2026-10-26' },
        days: [{
          date: '2026-10-26', count: 7, samples: 12, invalidSamples: 0,
          firstTs: 1792949000000, lastTs: 1792953000000, maxGapMs: 120000,
          observedMs: 600000, resets: 0,
          hourly: [null, null, null, null, null, null, null, null, null, null, 7, null, null, null, null, null, null, null, null, null, null, null, null, null]
        }]
      }]
    }
  };
}

const EVIDENCE_1 = Buffer.from('SYNTHETIC-JPEG-V5-ONLY\n', 'utf8');
const EVIDENCE_2 = Buffer.from('SYNTHETIC-JPEG-V6-ONLY\n', 'utf8');

function makeFixture(root) {
  const v5 = path.join(root, 'fixture-v5');
  const v6 = path.join(root, 'fixture-v6');
  fs.mkdirSync(path.join(v5, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(v6, 'evidence'), { recursive: true });

  fs.writeFileSync(path.join(v5, 'backend-state.json'), `${JSON.stringify(v5State(), null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(v5, 'evidence', 'rehearsal-evidence-1.jpg'), EVIDENCE_1);
  // evidence/index.json 在升级前后内容不同：用于构造“主快照已回滚、证据索引仍是新版”的真混合态
  fs.writeFileSync(path.join(v5, 'evidence', 'index.json'), '{"events":1,"note":"v5-index"}\n', 'utf8');

  fs.writeFileSync(path.join(v6, 'backend-state.json'), `${JSON.stringify(v6State(), null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(v6, 'activity-state.json'), `${JSON.stringify(activityState(), null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(v6, 'evidence', 'rehearsal-evidence-1.jpg'), EVIDENCE_1);
  fs.writeFileSync(path.join(v6, 'evidence', 'rehearsal-evidence-2.jpg'), EVIDENCE_2);
  fs.writeFileSync(path.join(v6, 'evidence', 'index.json'), '{"events":2,"note":"v6-index"}\n', 'utf8');
  return { v5, v6 };
}

/**
 * 期望的“回滚完成态” = 升级前归档内容 + 升级后多出来但被**原地保留**的顶层项
 * （这里：activity-state.json 与 evidence/rehearsal-evidence-2.jpg）。
 * 用一个期望目录算同口径树哈希，避免手写公式漂移。
 */
function makeExpectedFinal(root, v5, v6) {
  const expected = path.join(root, 'expected-final');
  fs.cpSync(v5, expected, { recursive: true, preserveTimestamps: true });
  fs.copyFileSync(path.join(v6, 'activity-state.json'), path.join(expected, 'activity-state.json'));
  fs.copyFileSync(path.join(v6, 'evidence', 'rehearsal-evidence-2.jpg'), path.join(expected, 'evidence', 'rehearsal-evidence-2.jpg'));
  return expected;
}

function makeArchive(dir, archivePath) {
  fs.rmSync(archivePath, { force: true });
  execFileSync('tar', ['-czf', archivePath, '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { path: archivePath, bytes: fs.statSync(archivePath).size, sha256: sha256File(archivePath) };
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true });
}

/* ------------------------------------------------------------ 运行单次事务 */

function runTransaction(args) {
  const started = Date.now();
  const proc = spawnSync(process.execPath, [TX_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  const durationMs = Date.now() - started;
  const stdout = proc.stdout || '';
  const stderr = proc.stderr || '';
  const summaryLine = `${stdout}\n${stderr}`.split('\n').find((line) => line.includes('[rollback] summary:')) || '';
  let summary = null;
  try { summary = JSON.parse(summaryLine.slice(summaryLine.indexOf('{'))); } catch { summary = null; }
  return {
    exitCode: proc.status,
    signal: proc.signal || null,
    durationMs,
    summary,
    hardExit: proc.status === 2 && summary === null,
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

/* ------------------------------------------------------------ 用例定义 */

const CASES = [
  { name: 'normal-rollback', kind: 'normal', expect: { state: 'COMPLETED', finalIs: 'pre-v5-with-preserved-extras' } },
  { name: 'preflight-only', kind: 'preflight', expect: { state: 'PREFLIGHT_OK', finalIs: 'original-v6' } },
  { name: 'corrupt-pre-archive', kind: 'corrupt-pre-archive', expect: { state: 'PREFLIGHT_ABORT', finalIs: 'original-v6' } },
  { name: 'pre-archive-checksum-metadata-mismatch', kind: 'wrong-expected-pre-hash', expect: { state: 'PREFLIGHT_ABORT', finalIs: 'original-v6' } },
  { name: 'post-archive-missing', kind: 'missing-post-archive', expect: { state: 'PREFLIGHT_ABORT', finalIs: 'original-v6' } },
  { name: 'staging-missing-backend-state', kind: 'failpoints', failPoints: ['staging-missing-state'], expect: { state: 'PREFLIGHT_ABORT', finalIs: 'original-v6' } },
  { name: 'staging-content-hash-mismatch', kind: 'failpoints', failPoints: ['staging-tamper'], expect: { state: 'PREFLIGHT_ABORT', finalIs: 'original-v6' } },
  { name: 'partial-aside-copy-failure', kind: 'failpoints', failPoints: ['partial-aside-copy'], failAfter: 1, expect: { state: 'PREFLIGHT_ABORT', finalIs: 'original-v6' } },
  { name: 'partial-staging-extract-failure', kind: 'failpoints', failPoints: ['partial-staging-extract'], expect: { state: 'PREFLIGHT_ABORT', finalIs: 'original-v6' } },
  { name: 'partial-landing-copy-failure', kind: 'failpoints', failPoints: ['partial-landing-copy'], failAfter: 1, expect: { state: 'RECOVERED_TO_V6', finalIs: 'original-v6' } },
  { name: 'partial-landing-move-failure', kind: 'failpoints', failPoints: ['partial-landing'], failAfter: 1, expect: { state: 'RECOVERED_TO_V6', finalIs: 'original-v6' } },
  { name: 'final-verify-failure', kind: 'failpoints', failPoints: ['final-verify'], expect: { state: 'RECOVERED_TO_V6', finalIs: 'original-v6' } },
  {
    // 落位 1 个文件后失败，且 journal 撤销在**任何动作之前**失败；original/ 副本完好
    // → 兜底恢复（用 S3 校验过的 original/ 重建）应当成功，数据回到升级后原状态。
    name: 'recovery-before-undo-then-fallback',
    kind: 'failpoints',
    failPoints: ['partial-landing', 'recovery-before-undo'],
    failAfterByPoint: { 'partial-landing': 1 },
    expect: { state: 'RECOVERED_TO_V6', finalIs: 'original-v6', manualTakeover: false }
  },
  {
    // 落位 2 个文件后失败，journal 撤销做 1 步后失败 → 走 original/ 兜底恢复。
    name: 'recovery-mid-undo-then-fallback',
    kind: 'failpoints',
    failPoints: ['partial-landing', 'recovery-fail'],
    failAfterByPoint: { 'partial-landing': 2, 'recovery-fail': 1 },
    expect: { state: 'RECOVERED_TO_V6', finalIs: 'original-v6', manualTakeover: false }
  },
  {
    // journal 撤销失败 + original/ 副本被破坏 → 兜底也失败 → 必须 MANUAL，且数据是真混合态
    name: 'recovery-failure-secondary',
    kind: 'failpoints',
    failPoints: ['partial-landing', 'recovery-before-undo', 'corrupt-original-copy'],
    failAfterByPoint: { 'partial-landing': 1 },
    expect: { state: 'MANUAL_TAKEOVER_REQUIRED', finalIs: 'not-original-not-pre', manualTakeover: true }
  },
  { name: 'hard-exit-then-resume-recover', kind: 'resume', expect: { state: 'RECOVERED_TO_V6', finalIs: 'original-v6', manualTakeover: false } },
  {
    // 升级后留档存在但**不可解包**（不是缺失）：S2 必须中止且不改数据
    name: 'post-archive-unreadable',
    kind: 'corrupt-post-archive',
    expect: { state: 'PREFLIGHT_ABORT', finalIs: 'original-v6' }
  },
  {
    // 卷与“升级后 treeHash”不一致（空卷/错卷）：必须在 S1 拒绝，绝不能在错卷上“成功回滚”
    name: 'wrong-or-empty-volume-refused',
    kind: 'empty-volume',
    expect: { state: 'PREFLIGHT_ABORT', finalIs: 'empty-volume' }
  }
];

function classify(finalHash, targets) {
  if (finalHash === targets.original) return 'original-v6';
  if (finalHash === targets.pre) return 'pre-v5-only';
  if (finalHash === targets.expectedFinal) return 'pre-v5-with-preserved-extras';
  if (finalHash === targets.empty) return 'empty-volume';
  return 'not-original-not-pre';
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rb-file-'));
  const tmpRoot = path.resolve(root);
  const fixtures = makeFixture(root);
  const expectedFinalDir = makeExpectedFinal(root, fixtures.v5, fixtures.v6);
  const archivesDir = path.join(root, 'archives');
  fs.mkdirSync(archivesDir, { recursive: true });

  const preArchive = makeArchive(fixtures.v5, path.join(archivesDir, 'pre-upgrade.tgz'));
  const postArchive = makeArchive(fixtures.v6, path.join(archivesDir, 'post-upgrade.tgz'));
  const expectedPreHash = inventory(fixtures.v5).treeHash;
  const expectedPostHash = inventory(fixtures.v6).treeHash;
  const expectedFinalHash = inventory(expectedFinalDir).treeHash;
  const emptyDir = path.join(root, 'empty-reference');
  fs.mkdirSync(emptyDir, { recursive: true });
  const targets = {
    original: expectedPostHash,
    pre: expectedPreHash,
    expectedFinal: expectedFinalHash,
    empty: inventory(emptyDir).treeHash
  };

  log(`[file-level] temp root: ${tmpRoot}`);
  log(`[file-level] pre archive  ${preArchive.bytes} B ${preArchive.sha256} tree=${expectedPreHash}`);
  log(`[file-level] post archive ${postArchive.bytes} B ${postArchive.sha256} tree=${expectedPostHash}`);
  log(`[file-level] expected rollback-complete tree (前 v5 + 保留的升级后项): ${expectedFinalHash}`);

  const results = [];
  let failures = 0;

  for (const testCase of CASES) {
    const caseDir = path.join(root, `case-${testCase.name}`);
    fs.mkdirSync(caseDir, { recursive: true });
    const dataDir = path.join(caseDir, 'data');
    copyDir(fixtures.v6, dataDir);
    const evidenceOut = path.join(caseDir, 'rollback-result.json');

    let usedPreArchive = preArchive.path;
    let usedPostArchive = postArchive.path;
    let usedExpectedPre = expectedPreHash;
    let mode = testCase.kind === 'preflight' ? 'preflight' : 'rollback';

    if (testCase.kind === 'corrupt-pre-archive') {
      usedPreArchive = path.join(caseDir, 'pre-corrupt.tgz');
      const broken = Buffer.from(fs.readFileSync(preArchive.path));
      for (let index = 100; index < 200 && index < broken.length; index += 1) broken[index] ^= 0xFF;
      fs.writeFileSync(usedPreArchive, broken);
    }
    if (testCase.kind === 'wrong-expected-pre-hash') usedExpectedPre = 'DEADBEEF'.repeat(8);
    if (testCase.kind === 'missing-post-archive') usedPostArchive = path.join(caseDir, 'not-present-post.tgz');
    if (testCase.kind === 'corrupt-post-archive') {
      usedPostArchive = path.join(caseDir, 'post-corrupt.tgz');
      const broken = Buffer.from(fs.readFileSync(postArchive.path));
      for (let index = 100; index < 200 && index < broken.length; index += 1) broken[index] ^= 0xFF;
      fs.writeFileSync(usedPostArchive, broken);
    }
    if (testCase.kind === 'empty-volume') {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const baseArgs = [
      '--mode', mode,
      '--data-root', dataDir,
      '--pre-archive', usedPreArchive,
      '--post-archive', usedPostArchive,
      '--evidence-out', evidenceOut,
      '--expected-pre-tree-hash', usedExpectedPre,
      '--expected-post-tree-hash', expectedPostHash,
      '--backend-stopped-asserted',
      '--op-id', `op-${testCase.name}`
    ];

    let run;
    let resumeChain = null;
    if (testCase.kind === 'resume') {
      // 第一次：硬中断（process.exit(2)，绕过自动恢复），模拟进程在落位中途被杀
      const first = runTransaction([...baseArgs, '--fail-point', 'hard-exit', '--fail-after', '2']);
      // 第二次：resume 模式按 journal 自动恢复
      run = runTransaction([
        '--mode', 'recover',
        '--data-root', dataDir,
        '--evidence-out', evidenceOut,
        '--expected-original-tree-hash', expectedPostHash,
        '--backend-stopped-asserted',
        '--op-id', `op-${testCase.name}`
      ]);
      resumeChain = {
        firstRun: { exitCode: first.exitCode, hardExit: first.hardExit, state: first.summary ? first.summary.state : 'HARD_EXIT_NO_SUMMARY' },
        resumeRun: { exitCode: run.exitCode, state: run.summary ? run.summary.state : 'NO_SUMMARY' }
      };
    } else {
      const extra = [];
      for (const failPoint of (testCase.failPoints || [])) extra.push('--fail-point', failPoint);
      if (testCase.failAfter) extra.push('--fail-after', String(testCase.failAfter));
      for (const [point, count] of Object.entries(testCase.failAfterByPoint || {})) {
        extra.push('--fail-after', `${point}=${count}`);
      }
      run = runTransaction([...baseArgs, ...extra]);
    }

    const finalInv = inventory(dataDir, { excludeTopLevel: new Set([TX_DIRNAME]) });
    const finalKind = classify(finalInv.treeHash, targets);
    const postArchiveSha = fs.existsSync(postArchive.path) ? sha256File(postArchive.path) : 'MISSING';
    const preArchiveSha = fs.existsSync(usedPreArchive) ? sha256File(usedPreArchive) : 'MISSING';
    const evidence = fs.existsSync(evidenceOut) ? JSON.parse(fs.readFileSync(evidenceOut, 'utf8')) : null;
    const actualState = run.summary ? run.summary.state : (evidence ? evidence.state : 'NO_SUMMARY');
    const expectedState = testCase.expect.state;
    const stateOk = actualState === expectedState;
    const finalOk = testCase.expect.finalIs === finalKind;
    const mixed = finalKind === 'not-original-not-pre';
    const manual = Boolean(evidence && evidence.manualTakeover);
    const manualOk = testCase.expect.manualTakeover === undefined ? !manual : manual === testCase.expect.manualTakeover;
    const ok = stateOk && finalOk && manualOk;
    if (!ok) failures += 1;

    const record = {
      case: testCase.name,
      injectionPoint: testCase.kind === 'failpoints'
        ? testCase.failPoints.map((point) => `--fail-point ${point}`).join(' ')
          + (testCase.failAfter ? ` --fail-after ${testCase.failAfter}` : '')
          + Object.entries(testCase.failAfterByPoint || {}).map(([point, count]) => ` --fail-after ${point}=${count}`).join('')
        : testCase.kind,
      expectedState,
      expectedFinalState: testCase.expect.finalIs,
      actualExitCode: run.exitCode,
      actualState,
      // 事实：本台架从不启动任何服务；同时记录事务脚本给出的“是否要求保持停止”
      serviceStayedStopped: true,
      serviceMustStayStopped: evidence ? Boolean(evidence.serviceMustStayStopped) : null,
      finalFileList: finalInv.rows.map((row) => `${row.type}:${row.path}`),
      beforeTreeHash: expectedPostHash,
      afterTreeHash: finalInv.treeHash,
      afterTreeHashKind: finalKind,
      expectedPreTreeHash: expectedPreHash,
      expectedRollbackCompleteTreeHash: expectedFinalHash,
      preArchiveSha256: preArchiveSha,
      preArchiveIntact: preArchiveSha === preArchive.sha256,
      postArchiveSha256: postArchiveSha,
      postArchiveIntact: postArchiveSha === postArchive.sha256,
      mixedState: mixed,
      manualTakeover: manual,
      passed: ok,
      checks: { stateOk, finalOk, manualOk },
      transactionEvidenceState: evidence ? evidence.state : null,
      transactionEvidenceError: evidence && evidence.error ? evidence.error.message : null,
      transactionRecovery: evidence ? evidence.recovery : null,
      resume: resumeChain,
      durationMs: run.durationMs,
      stdoutTail: run.stdout.split('\n').slice(-5),
      stderrTail: run.stderr.split('\n').slice(-5)
    };
    results.push(record);
    log(`[file-level] ${ok ? 'PASS' : 'FAIL'} ${testCase.name} :: exit=${run.exitCode} state=${actualState} final=${finalKind} mixed=${mixed} manual=${manual}`);
    if (!ok) log(`[file-level]   checks=${JSON.stringify(record.checks)} evidence=${JSON.stringify(record.transactionEvidenceError)}`);
  }

  const summary = {
    kind: 'FILE_LEVEL_FAULT_INJECTION',
    generatedAt: new Date().toISOString(),
    txScript: path.relative(DELIVERY, TX_SCRIPT).replace(/\\/g, '/'),
    tempRoot: tmpRoot,
    evidenceLevel: 'FILE-LEVEL：用 Node fs 在临时目录上验证状态机与撤销清单；不代表 Docker 卷/容器语义',
    fixtures: {
      preArchive: { path: path.relative(DELIVERY, preArchive.path).replace(/\\/g, '/'), bytes: preArchive.bytes, sha256: preArchive.sha256, treeHash: expectedPreHash },
      postArchive: { path: path.relative(DELIVERY, postArchive.path).replace(/\\/g, '/'), bytes: postArchive.bytes, sha256: postArchive.sha256, treeHash: expectedPostHash },
      rollbackCompleteTreeHash: expectedFinalHash
    },
    cases: results,
    total: results.length,
    passed: results.filter((row) => row.passed).length,
    failed: failures,
    result: failures === 0 ? 'FILE_LEVEL_HARDENING_VERIFIED' : 'FILE_LEVEL_HARDENING_FAILED'
  };
  writeJson(OUT_JSON, summary);
  fs.writeFileSync(OUT_LOG, `${logLines.join('\n')}\n`, 'utf8');

  log(`[file-level] total=${summary.total} passed=${summary.passed} failed=${summary.failed}`);
  log(`[file-level] ${summary.result}`);
  log(`[file-level] json: ${OUT_JSON}`);

  if (!KEEP) {
    const allowedPrefix = path.resolve(os.tmpdir()) + path.sep;
    if (tmpRoot.startsWith(allowedPrefix) && path.basename(tmpRoot).startsWith('de-rb-file-')) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      log('[file-level] temp dir cleaned');
    } else {
      log(`[file-level] REFUSED to clean unexpected path: ${tmpRoot}`);
    }
  } else {
    log(`[file-level] --keep: temp dir retained at ${tmpRoot}`);
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
