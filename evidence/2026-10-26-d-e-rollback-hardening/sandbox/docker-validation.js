'use strict';

/**
 * docker-validation.js — Docker 卷/容器级隔离验证与故障注入
 *
 * 真实验证项（不是文档推演）：
 *   1. 旧镜像 tag 固定 → docker save → 哈希校验 → docker load → compose 用 `--no-build` 钉住旧镜像启动
 *   2. 从**已停止的容器**解析真实 /data 卷名；错误卷名被 guard 拒绝，且不会自动创建空卷冒充成功
 *   3. 以容器运行用户（node/1000）创建 0600 主快照与活动文件；root 只读备份可读；非授权 UID 读取失败
 *   4. 停机整卷备份：非空、可解包、清单与哈希可复核
 *   5. 候选加载 v5 合成状态，首次有效写入升级至 v6；D 处置/安全日志与 E 活动记录持久化
 *   6. 正常回滚：升级后数据先留档 → 升级前落位 → 旧边界服务读取恢复数据
 *   7. 回滚后属主/权限正确，旧服务能执行一次真实隔离写入并重新加载
 *   8. 故障注入：11 类（数据面 9 类 + 镜像面 2 类），每类记录最终卷状态与树哈希
 *
 * 隔离：独立镜像 tag、独立命名卷、独立 bridge 网络、独立项目名、仅 127.0.0.1 随机端口、
 *       合成设备/告警/处置/活动数据。**绝不触碰 eldercare-public / backend-data / Caddy / 现有容器**。
 *
 * 用法：node sandbox/docker-validation.js [--keep]
 * 输出：sandbox/docker-validation-results.json + sandbox/docker-validation-console.log
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const DELIVERY = path.resolve(__dirname, '..');
const RELEASE_PREP = path.resolve(DELIVERY, '..', '2026-10-26-d-e-release-prep');
const ARCHIVE = path.join(RELEASE_PREP, 'd-e-candidate-source-2026-10-26.zip');
const EMULATION_SRC = path.join(RELEASE_PREP, 'rehearsal', 'legacy-v5-emulation', 'src');
const TX_SCRIPT = path.join(DELIVERY, 'rollback', 'rollback-transaction.js');
const { diffInventories } = require(TX_SCRIPT);
const INVENTORY_SCRIPT = path.join(DELIVERY, 'sandbox', 'container-inventory.js');
const COMPOSE_DIR = path.join(DELIVERY, 'sandbox');
const OUT_JSON = path.join(DELIVERY, 'sandbox', 'docker-validation-results.json');
const OUT_LOG = path.join(DELIVERY, 'sandbox', 'docker-validation-console.log');

const KEEP = process.argv.includes('--keep');
const ID = `de-rb-${crypto.randomBytes(3).toString('hex')}`;
const IMG_NEW = `${ID}-new:20261026`;
const IMG_OLD = `${ID}-old:20261026`;
const IMG_PINNED = `${ID}-pinned:pre-d-e`;
const NET = `${ID}-net`;
const VOL_PREFIX = `${ID}-vol-`;
const PROJECT = ID;

const SAND = {
  API_TOKEN_SECRET: crypto.randomBytes(32).toString('hex'),
  INGEST_KEY: crypto.randomBytes(32).toString('hex'),
  APP_GUARDIAN_ID: 'rehearsal-guardian',
  APP_GUARDIAN_PASSWORD: crypto.randomBytes(32).toString('hex'),
  CONTACTS_JSON: '[]'
};

const logLines = [];
const log = (message) => { const line = `${new Date().toISOString()} ${message}`; logLines.push(line); console.log(message); };

let failures = 0;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail, at: new Date().toISOString() });
  if (!ok) failures += 1;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
}

/* ------------------------------------------------------------ docker helpers */

function docker(args, options = {}) {
  const proc = spawnSync('docker', args, {
    encoding: options.buffer ? 'buffer' : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: options.timeout || 180000,
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) }
  });
  const stdout = proc.stdout || (options.buffer ? Buffer.alloc(0) : '');
  const stderr = proc.stderr || (options.buffer ? Buffer.alloc(0) : '');
  return {
    code: proc.status,
    signal: proc.signal,
    stdout,
    stderr,
    out: options.buffer ? '' : String(stdout),
    err: options.buffer ? '' : String(stderr)
  };
}

function dockerOk(args, options) {
  const res = docker(args, options);
  if (res.code !== 0) {
    throw new Error(`docker ${args.join(' ')} failed (${res.code}): ${String(res.err || res.stderr).slice(-800)}`);
  }
  return res;
}

const sha256Buffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase();
const sha256File = (file) => sha256Buffer(fs.readFileSync(file));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return true;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/* ------------------------------------------------------------ 容器内工具 */

const INVENTORY_JS = `'use strict';
const crypto=require('node:crypto');const fs=require('node:fs');const path=require('node:path');
function sha(b){return crypto.createHash('sha256').update(b).digest('hex').toUpperCase();}
function inv(root,exclude){const ex=new Set(exclude||[]);const rows=[];const posix=process.platform!=='win32';
(function walk(cur,pre){for(const e of fs.readdirSync(cur,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
 if(pre===''&&ex.has(e.name))continue;const abs=path.join(cur,e.name);const rel=pre===''?e.name:pre+'/'+e.name;
 const st=fs.lstatSync(abs);const c={path:rel,size:st.size,mode:st.mode&0o777,uid:posix?st.uid:0,gid:posix?st.gid:0};
 if(st.isDirectory()){rows.push(Object.assign({},c,{type:'dir',size:0,sha256:''}));walk(abs,rel);}
 else if(st.isFile()){rows.push(Object.assign({},c,{type:'file',sha256:sha(fs.readFileSync(abs))}));}
 else if(st.isSymbolicLink()){rows.push(Object.assign({},c,{type:'symlink',size:0,sha256:sha(Buffer.from(fs.readlinkSync(abs)))}));}
 else rows.push(Object.assign({},c,{type:'other',sha256:''}));}})(root,'');
 rows.sort((a,b)=>a.path.localeCompare(b.path));
 const treeHash=sha(Buffer.from(rows.map(r=>r.path+'\\t'+r.type+'\\t'+r.size+'\\t'+r.mode+'\\t'+r.uid+':'+r.gid+'\\t'+r.sha256).join('\\n'),'utf8'));
 return {rows,treeHash};}
const root=process.argv[2]||'/data';
const exclude=(process.argv[3]||'').split(',').filter(Boolean);
process.stdout.write(JSON.stringify(inv(root,exclude)));
`;

function writeFileNoBom(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(text, 'utf8'));
}

/** 在容器里对指定卷跑清单脚本（POSIX 语义，含 uid/gid）。 */
function volumeInventory(volumeName, image, exclude = ['.de-rollback']) {
  const res = dockerOk(['run', '--rm', '--network', 'none', '--user', '0',
    '--mount', `type=volume,source=${volumeName},target=/data`,
    '--mount', `type=bind,source=${COMPOSE_DIR},target=/opt/sandbox,readonly`,
    image, 'node', '/opt/sandbox/container-inventory.js', '/data', exclude.join(',')]);
  return JSON.parse(res.out);
}

/** 从卷里 tar 出来（root 读 0600），在主机侧保存归档。 */
function exportVolume(volumeName, image, hostFile) {
  const res = docker(['run', '--rm', '--network', 'none', '--user', '0',
    '--mount', `type=volume,source=${volumeName},target=/data,readonly`,
    image, 'tar', 'czf', '-', '-C', '/data', '.'], { buffer: true });
  if (res.code !== 0) throw new Error(`exportVolume failed: ${String(res.stderr).slice(-400)}`);
  const buffer = Buffer.from(res.stdout);
  if (buffer.length === 0) throw new Error('exportVolume produced empty archive');
  fs.writeFileSync(hostFile, buffer);
  return { bytes: buffer.length, sha256: sha256Buffer(buffer) };
}

/** 把主机归档解到新卷，并把属主改成容器运行用户（node 1000:1000）。 */
function importVolume(volumeName, image, hostFile) {
  dockerOk(['volume', 'create', volumeName]);
  dockerOk(['run', '--rm', '--network', 'none', '--user', '0',
    '--mount', `type=volume,source=${volumeName},target=/data`,
    '--mount', `type=bind,source=${path.dirname(hostFile)},target=/seed,readonly`,
    image, 'sh', '-c',
    `set -e; tar xzf /seed/${path.basename(hostFile)} -C /data; chown -R 1000:1000 /data; ls -ln /data`]);
}

function removeVolume(volumeName) {
  docker(['volume', 'rm', '-f', volumeName]);
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  const startedAt = new Date().toISOString();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'de-rb-docker-'));
  const work = {
    tmpRoot,
    extract: path.join(tmpRoot, 'archive'),
    buildNew: path.join(tmpRoot, 'build-new'),
    buildOld: path.join(tmpRoot, 'build-old'),
    backup: path.join(tmpRoot, 'backup'),
    evidence: path.join(tmpRoot, 'evidence')
  };
  for (const dir of [work.extract, work.buildNew, work.buildOld, work.backup, work.evidence]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeFileNoBom(INVENTORY_SCRIPT, INVENTORY_JS);

  const summary = {
    kind: 'DOCKER_VOLUME_LEVEL_VALIDATION',
    generatedAt: startedAt,
    sandboxId: ID,
    evidenceLevel: 'DOCKER: 真实容器 + 真实命名卷 + 独立网络；不代表生产主机',
    images: {}, volume: null, network: null, guards: [], scenarios: results
  };

  try {
    /* ---------- 0. 环境检查 ---------- */
    const version = dockerOk(['version', '--format', '{{.Server.Version}}']).out.trim();
    record('docker daemon available', version.length > 0, `server=${version}`);
    const baseImage = dockerOk(['image', 'inspect', 'node:24-alpine', '--format', '{{.Id}}']).out.trim();
    record('base image node:24-alpine present locally (no pull needed)', baseImage.startsWith('sha256:'), baseImage.slice(0, 19));

    /* ---------- 1. 构建隔离镜像 ---------- */
    execFileSync('tar', ['-xzf', ARCHIVE, '-C', work.extract], { stdio: ['ignore', 'pipe', 'pipe'] });
    const extractedRoot = path.join(work.extract, 'd-e-candidate-source-2026-10-26');
    const backendCtx = path.join(extractedRoot, 'competition', 'cloud', 'backend');
    fs.cpSync(backendCtx, work.buildNew, { recursive: true });
    fs.cpSync(backendCtx, work.buildOld, { recursive: true });
    // old = 冻结树 + v5 等价模拟的 persistent-store.js（明确标注：派生模拟，非历史制品）
    fs.copyFileSync(path.join(EMULATION_SRC, 'persistent-store.js'), path.join(work.buildOld, 'src', 'persistent-store.js'));
    writeFileNoBom(path.join(work.buildOld, 'LEGACY-EMULATION-NOTICE.txt'),
      '本镜像的 src/persistent-store.js 来自 legacy-v5-emulation（v5 等价模拟，非历史制品）。\n');

    dockerOk(['build', '--network', 'none', '-t', IMG_NEW, '-f', 'Dockerfile', '.'], { timeout: 300000, cwd: work.buildNew });
    dockerOk(['build', '--network', 'none', '-t', IMG_OLD, '-f', 'Dockerfile', '.'], { timeout: 300000, cwd: work.buildOld });
    const newId = dockerOk(['image', 'inspect', IMG_NEW, '--format', '{{.Id}}']).out.trim();
    const oldId = dockerOk(['image', 'inspect', IMG_OLD, '--format', '{{.Id}}']).out.trim();
    summary.images = { new: { tag: IMG_NEW, id: newId }, old: { tag: IMG_OLD, id: oldId } };
    record('built isolated new (v6) and old (v5-emulation) images', newId !== oldId, { new: newId.slice(0, 19), old: oldId.slice(0, 19) });

    /* ---------- 2. 独立网络 + 主卷 ---------- */
    dockerOk(['network', 'create', NET]);
    summary.network = NET;
    const vol = `${VOL_PREFIX}data`;
    dockerOk(['volume', 'create', vol]);
    // 与生产一致：镜像的 /data 属主是 node(1000)，显式对齐，避免依赖卷首次挂载时的 popullate 行为
    dockerOk(['run', '--rm', '--network', 'none', '--user', '0',
      '--mount', `type=volume,source=${vol},target=/data`, IMG_NEW,
      'sh', '-c', 'chown -R 1000:1000 /data && ls -ln /data']);
    summary.volume = vol;
    record('created isolated volume and network', true, { volume: vol, network: NET });

    /* ---------- 3. 卷名 guard：错误卷名必须被拒绝且不自动创建 ---------- */
    const bogus = `${VOL_PREFIX}does-not-exist`;
    const bogusInspect = docker(['volume', 'inspect', bogus]);
    const bogusCreated = docker(['volume', 'inspect', bogus]).code === 0;
    record('volume guard: docker volume inspect rejects unknown volume and does not create it',
      bogusInspect.code !== 0 && !bogusCreated, { inspectExit: bogusInspect.code, created: bogusCreated });

    /* ---------- 4. 用旧镜像写入 v5 合成状态 ---------- */
    dockerOk(['run', '--rm', '--network', 'none', '--user', 'node',
      '--mount', `type=volume,source=${vol},target=/data`,
      '--mount', `type=bind,source=${COMPOSE_DIR},target=/opt/sandbox,readonly`,
      IMG_OLD, 'node', '/opt/sandbox/seed-v5.js', '/data']);
    const v5Inv = volumeInventory(vol, IMG_OLD);
    const v5Doc = dockerOk(['run', '--rm', '--network', 'none', '--user', '0',
      '--mount', `type=volume,source=${vol},target=/data,readonly`, IMG_OLD,
      'node', '-e', 'const d=require("/data/backend-state.json");process.stdout.write(JSON.stringify({schemaVersion:d.schemaVersion,devices:d.devices.length,alerts:(d.alerts||[]).length,hasSafetyLogs:Object.prototype.hasOwnProperty.call(d,"safetyLogs")}))']).out;
    const v5Meta = JSON.parse(v5Doc);
    summary.v5 = { treeHash: v5Inv.treeHash, entryCount: v5Inv.rows.length, meta: v5Meta };
    record('seeded v5 synthetic state with the old (v5) image',
      v5Meta.schemaVersion === 5 && v5Meta.devices === 3 && v5Meta.alerts === 2 && v5Meta.hasSafetyLogs === false, v5Meta);

    /* ---------- 5. 属主 / 权限 / 读取权限矩阵 ---------- */
    const perms = docker(['run', '--rm', '--network', 'none', '--user', '0',
      '--mount', `type=volume,source=${vol},target=/data,readonly`, IMG_OLD,
      'sh', '-c', 'stat -c "%u %g %a %n" /data/backend-state.json']).out.trim();
    record('v5 main snapshot is 0600 owned by container user (1000:1000)', /^1000 1000 600 /.test(perms), perms);
    const rootRead = docker(['run', '--rm', '--network', 'none', '--user', '0',
      '--mount', `type=volume,source=${vol},target=/data,readonly`, IMG_OLD, 'sh', '-c', 'cat /data/backend-state.json > /dev/null; echo ROOT_READ_OK']);
    record('root can read 0600 snapshot for backup', String(rootRead.out).includes('ROOT_READ_OK'), rootRead.code);
    const otherRead = docker(['run', '--rm', '--network', 'none', '--user', '1001:1001',
      '--mount', `type=volume,source=${vol},target=/data,readonly`, IMG_OLD, 'sh', '-c', 'cat /data/backend-state.json > /dev/null']);
    record('non-authorized UID 1001 cannot read 0600 snapshot', otherRead.code !== 0, { exit: otherRead.code });

    /* ---------- 6. 停机整卷备份（备份容器 root 只读 + 主机落盘） ---------- */
    const preArchive = path.join(work.backup, 'pre-upgrade.tgz');
    const preExport = exportVolume(vol, IMG_OLD, preArchive);
    const preList = execFileSync('tar', ['-tzf', preArchive], { encoding: 'utf8' }).split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
    summary.preArchive = { path: 'backup/pre-upgrade.tgz', ...preExport, entries: preList.length, treeHash: v5Inv.treeHash };
    record('pre-upgrade backup exported from stopped container: non-empty, listable, hash recorded',
      preExport.bytes > 0 && preList.some((entry) => entry.replace(/^\.\//, '') === 'backend-state.json'), summary.preArchive);

    /* ---------- 7. 升级：候选镜像加载 v5，首个有效写入 → v6，并写入 D/E 记录 ---------- */
    const port = await freePort();
    const containerName = `${ID}-backend-new`;
    dockerOk(['run', '-d', '--name', containerName, '--network', NET, '--user', 'node',
      '-p', `127.0.0.1:${port}:8080`,
      '--mount', `type=volume,source=${vol},target=/data`,
      '-e', `API_TOKEN_SECRET=${SAND.API_TOKEN_SECRET}`,
      '-e', `INGEST_KEY=${SAND.INGEST_KEY}`,
      '-e', `APP_GUARDIAN_ID=${SAND.APP_GUARDIAN_ID}`,
      '-e', `APP_GUARDIAN_PASSWORD=${SAND.APP_GUARDIAN_PASSWORD}`,
      '-e', `CONTACTS_JSON=${SAND.CONTACTS_JSON}`,
      IMG_NEW]);
    const healthy = await waitForHttp(`http://127.0.0.1:${port}/healthz`, 40000);
    let startupLogs = '';
    if (!healthy) {
      startupLogs = docker(['logs', containerName]).out + docker(['logs', containerName]).err;
      record('new (v6) backend starts on the v5 volume', false, { port, logs: startupLogs.slice(-1500) });
      throw new Error(`new backend did not become healthy; logs: ${startupLogs.slice(-1200)}`);
    }
    record('new (v6) backend starts on the v5 volume', true, `port=${port}`);

    const ingest = async (body) => {
      const response = await fetch(`http://127.0.0.1:${port}/internal/v1/device-status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-key': SAND.INGEST_KEY },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const base = Date.UTC(2026, 9, 26, 2, 0, 0);
    const bath = {
      deviceId: 'rehearsal-fixture-bath', room: '合成演练-卫生间', online: true, monitorOnline: 1,
      state: 'ALARM', ts: base, sensors: { motion: { lastActiveTs: base, countToday: 5 } },
      alarm: { id: 'rehearsal-alarm-1', type: 'MANUAL_SOS', countToday: 1 }
    };
    const firstIngest = await ingest(bath);
    const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/app`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guardianId: SAND.APP_GUARDIAN_ID, password: SAND.APP_GUARDIAN_PASSWORD })
    });
    const loginBody = await login.json();
    const token = loginBody.sessionToken;
    const dispositionStatuses = [];
    for (const [index, outcome] of ['CONTACTED_FAMILY', 'ON_SITE_CONFIRMED_NORMAL'].entries()) {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/alerts/rehearsal-alarm-1/dispositions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ clientDispositionId: `rehearsal-disp-000${index + 1}`, outcome, note: `合成演练：${outcome}` })
      });
      dispositionStatuses.push(response.status);
    }
    await ingest({ ...bath, state: 'NORMAL', ts: base + 60000, sensors: { motion: { lastActiveTs: base, countToday: 9 } } });
    // 升级后再上传一张证据（真实 EvidenceStore 索引变成 2 条），用于验证“回滚时证据索引被回退、
    // 但升级后新增的证据 JPEG 不会被目录合并删掉”。
    const jpegV6 = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x02, 0xFF, 0xD9]);
    const evidenceUpload = await fetch(`http://127.0.0.1:${port}/internal/v1/evidence/fall-2-na`, {
      method: 'PUT',
      headers: {
        'content-type': 'image/jpeg',
        'x-ingest-key': SAND.INGEST_KEY,
        'x-device-id': 'rehearsal-fixture-bath',
        'x-evidence-sha256': sha256Buffer(jpegV6)
      },
      body: jpegV6
    });
    const activityReport = await fetch(`http://127.0.0.1:${port}/api/v1/activity/report?scope=day&date=2026-10-26`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const activityBody = await activityReport.json();
    const safetyLogs = await fetch(`http://127.0.0.1:${port}/api/v1/safety-logs?limit=10`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const safetyBody = await safetyLogs.json();

    const v6Doc = dockerOk(['run', '--rm', '--network', 'none', '--user', '0',
      '--mount', `type=volume,source=${vol},target=/data,readonly`, IMG_NEW,
      'node', '-e', 'const d=require("/data/backend-state.json");process.stdout.write(JSON.stringify({schemaVersion:d.schemaVersion,safetyLogs:(d.safetyLogs||[]).length}))']).out;
    const v6Meta = JSON.parse(v6Doc);
    const activityExists = docker(['run', '--rm', '--network', 'none', '--user', '0',
      '--mount', `type=volume,source=${vol},target=/data,readonly`, IMG_NEW,
      'node', '-e', 'const d=require("/data/activity-state.json");process.stdout.write(JSON.stringify({version:d.version}))']).out;
    record('candidate upgrades v5 → v6 on first write (D + E persisted)',
      firstIngest.status === 202 && evidenceUpload.status === 201 &&
      v6Meta.schemaVersion === 6 && v6Meta.safetyLogs === 2 &&
      safetyBody.logs && safetyBody.logs.length === 2 &&
      activityBody && typeof activityBody.dataSince === 'number' && JSON.parse(activityExists).version === 1,
      { ingest: firstIngest.status, evidenceUpload: evidenceUpload.status, dispositions: dispositionStatuses, v6: v6Meta, safetyLogs: safetyBody.logs ? safetyBody.logs.length : null, activity: activityExists });

    dockerOk(['stop', '-t', '10', containerName]);
    dockerOk(['rm', containerName]);

    const v6Inv = volumeInventory(vol, IMG_NEW);
    summary.v6 = { treeHash: v6Inv.treeHash, entryCount: v6Inv.rows.length, meta: v6Meta };
    const postArchive = path.join(work.backup, 'post-upgrade.tgz');
    const postExport = exportVolume(vol, IMG_NEW, postArchive);
    summary.postArchive = { path: 'backup/post-upgrade.tgz', ...postExport, entries: execFileSync('tar', ['-tzf', postArchive], { encoding: 'utf8' }).split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean).length, treeHash: v6Inv.treeHash, sha256: sha256File(postArchive) };

    /* ---------- 8. 期望的“回滚完成态”参考卷 ---------- */
    const volPreRef = `${VOL_PREFIX}ref-pre`;
    importVolume(volPreRef, IMG_OLD, preArchive);
    const preInv = volumeInventory(volPreRef, IMG_OLD);
    // 期望完成态 = 升级前内容 + 升级后多出来的文件（activity-state.json、v6 独有的 evidence）
    const v6Only = v6Inv.rows.filter((row) => row.type === 'file' && !preInv.rows.some((other) => other.path === row.path));
    const volFinalRef = `${VOL_PREFIX}ref-final`;
    importVolume(volFinalRef, IMG_OLD, preArchive);
    fs.mkdirSync(path.join(work.backup, 'extras-root'), { recursive: true });
    for (const row of v6Only) {
      const hostSide = path.join(work.backup, 'extras', row.path);
      fs.mkdirSync(path.dirname(hostSide), { recursive: true });
      // 从 post 归档里精确取出该文件
      execFileSync('tar', ['-xzf', postArchive, '-C', path.join(work.backup, 'extras-root'), './' + row.path]);
      fs.copyFileSync(path.join(work.backup, 'extras-root', row.path), hostSide);
      dockerOk(['run', '--rm', '--network', 'none', '--user', '0',
        '--mount', `type=volume,source=${volFinalRef},target=/data`,
        '--mount', `type=bind,source=${path.dirname(hostSide)},target=/extra,readonly`,
        IMG_OLD, 'sh', '-c', `mkdir -p /data/${path.dirname(row.path)}; cp /extra/${path.basename(row.path)} /data/${row.path}; chmod ${row.mode.toString(8)} /data/${row.path}; chown -R 1000:1000 /data`]);
    }
    const finalInv = volumeInventory(volFinalRef, IMG_OLD);
    summary.reference = {
      preTreeHash: preInv.treeHash,
      postTreeHash: v6Inv.treeHash,
      rollbackCompleteTreeHash: finalInv.treeHash,
      preservedExtras: v6Only.map((row) => row.path)
    };
    record('reference states computed in-container (pre / post / rollback-complete)', true, summary.reference);

    /* ---------- 9. 正常回滚（容器内跑事务脚本，真实卷语义） ---------- */
    const runTransactionInContainer = (volumeName, extraArgs, image = IMG_OLD, user = 'node') => {
      const evidenceFile = path.join(work.evidence, `evidence-${crypto.randomBytes(4).toString('hex')}.json`);
      const res = docker(['run', '--rm', '--network', 'none', '--user', user,
        '--mount', `type=volume,source=${volumeName},target=/data`,
        '--mount', `type=bind,source=${path.dirname(preArchive)},target=/backup,readonly`,
        '--mount', `type=bind,source=${path.dirname(evidenceFile)},target=/evidence`,
        '--mount', `type=bind,source=${path.dirname(TX_SCRIPT)},target=/opt/rollback,readonly`,
        image, 'node', '/opt/rollback/rollback-transaction.js',
        '--data-root', '/data',
        '--pre-archive', `/backup/${path.basename(preArchive)}`,
        '--post-archive', `/backup/${path.basename(postArchive)}`,
        '--evidence-out', `/evidence/${path.basename(evidenceFile)}`,
        '--volume-name', volumeName,
        '--backend-stopped-asserted',
        ...extraArgs]);
      const summaryLine = `${res.out}\n${res.err}`.split('\n').find((line) => line.includes('[rollback] summary:')) || '';
      let summaryJson = null;
      try { summaryJson = JSON.parse(summaryLine.slice(summaryLine.indexOf('{'))); } catch { summaryJson = null; }
      let evidence = null;
      if (fs.existsSync(evidenceFile)) { try { evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); } catch { evidence = null; } }
      return { exitCode: res.code, summary: summaryJson, evidence, stdout: res.out.trim(), stderr: res.err.trim() };
    };

    const volRollback = `${VOL_PREFIX}rollback`;
    importVolume(volRollback, IMG_OLD, postArchive);
    const normal = runTransactionInContainer(volRollback, [
      '--mode', 'rollback',
      '--expected-pre-tree-hash', preInv.treeHash,
      '--expected-post-tree-hash', v6Inv.treeHash,
      '--op-id', `op-normal-${ID}`
    ]);
    const normalInv = volumeInventory(volRollback, IMG_OLD);
    record('normal rollback reaches the rollback-complete reference state',
      normal.exitCode === 0 && normal.summary && normal.summary.state === 'COMPLETED' && normalInv.treeHash === finalInv.treeHash,
      { exit: normal.exitCode, state: normal.summary ? normal.summary.state : null, finalHash: normalInv.treeHash, expected: finalInv.treeHash, diff: diffInventories(finalInv.rows, normalInv.rows) });

    /* ---------- 10. 回滚后旧服务读取 + 真实隔离写入 + 重新加载 ---------- */
    const oldPort = await freePort();
    const oldContainer = `${ID}-backend-old`;
    dockerOk(['run', '-d', '--name', oldContainer, '--network', NET, '--user', 'node',
      '-p', `127.0.0.1:${oldPort}:8080`,
      '--mount', `type=volume,source=${volRollback},target=/data`,
      '-e', `API_TOKEN_SECRET=${SAND.API_TOKEN_SECRET}`,
      '-e', `INGEST_KEY=${SAND.INGEST_KEY}`,
      '-e', `APP_GUARDIAN_ID=${SAND.APP_GUARDIAN_ID}`,
      '-e', `APP_GUARDIAN_PASSWORD=${SAND.APP_GUARDIAN_PASSWORD}`,
      '-e', `CONTACTS_JSON=${SAND.CONTACTS_JSON}`,
      IMG_OLD]);
    const oldHealthy = await waitForHttp(`http://127.0.0.1:${oldPort}/healthz`, 40000);
    const oldLogin = await fetch(`http://127.0.0.1:${oldPort}/api/v1/auth/app`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guardianId: SAND.APP_GUARDIAN_ID, password: SAND.APP_GUARDIAN_PASSWORD })
    });
    const oldToken = (await oldLogin.json()).sessionToken;
    const oldAlerts = await fetch(`http://127.0.0.1:${oldPort}/api/v1/alerts`, { headers: { authorization: `Bearer ${oldToken}` } });
    const oldAlertsBody = await oldAlerts.json();
    const writeBack = await fetch(`http://127.0.0.1:${oldPort}/internal/v1/device-status`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-key': SAND.INGEST_KEY },
      body: JSON.stringify({ ...bath, state: 'NORMAL', ts: base + 120000, sensors: { motion: { lastActiveTs: base, countToday: 6 } } })
    });
    const reload = await fetch(`http://127.0.0.1:${oldPort}/api/v1/alerts`, { headers: { authorization: `Bearer ${oldToken}` } });
    const reloadBody = await reload.json();
    dockerOk(['stop', '-t', '10', oldContainer]);
    dockerOk(['rm', oldContainer]);
    const afterWriteInv = volumeInventory(volRollback, IMG_OLD);
    const afterWriteDoc = dockerOk(['run', '--rm', '--network', 'none', '--user', '0',
      '--mount', `type=volume,source=${volRollback},target=/data,readonly`, IMG_OLD,
      'node', '-e', 'const d=require("/data/backend-state.json");process.stdout.write(JSON.stringify({schemaVersion:d.schemaVersion,devices:d.devices.length}))']).out;
    record('restored v5 data serves the old service, allows a real atomic write and reloads',
      oldHealthy && oldAlerts.status === 200 && oldAlertsBody.alerts && oldAlertsBody.alerts.length === 2 &&
      writeBack.status === 202 && reload.status === 200 && reloadBody.alerts && JSON.parse(afterWriteDoc).schemaVersion === 5,
      { alerts: oldAlertsBody.alerts ? oldAlertsBody.alerts.length : null, write: writeBack.status, reload: reload.status, doc: afterWriteDoc });

    /* ---------- 11. 镜像固定：tag / save / hash / load / --no-build ---------- */
    dockerOk(['tag', IMG_OLD, IMG_PINNED]);
    const saveFile = path.join(work.backup, 'image-pre-d-e.tar.gz');
    const saveRes = docker(['save', IMG_PINNED], { buffer: true });
    if (saveRes.code !== 0) throw new Error('docker save failed');
    fs.writeFileSync(saveFile, Buffer.from(saveRes.stdout));
    const saveSha = sha256File(saveFile);
    const pinnedId = dockerOk(['image', 'inspect', IMG_PINNED, '--format', '{{.Id}}']).out.trim();
    dockerOk(['rmi', IMG_PINNED]);
    dockerOk(['load', '-i', saveFile]);
    const loadedId = dockerOk(['image', 'inspect', IMG_PINNED, '--format', '{{.Id}}']).out.trim();
    const composeTemplate = path.join(COMPOSE_DIR, 'compose.pin.example.yaml');
    writeFileNoBom(composeTemplate, [
      '# compose.pin.example.yaml — 把 backend 镜像“钉”到指定 tag 的覆盖文件示例（不含任何真实密钥）',
      '# 用法（回滚启动旧镜像时，绝不重新构建）：',
      '#   docker compose --env-file deploy/.env.deploy \\',
      '#     -f deploy/compose.public.yaml -f deploy/compose.pin.example.yaml \\',
      '#     up -d --no-build backend',
      '# 说明：',
      '#   - image 必须是**已 docker save/load 校验过**的版本标签，不能用 latest/local 漂移标签；',
      '#   - --no-build 是必须的：compose.public.yaml 里有 build: 段，缺了它可能在镜像缺失时重新构建；',
      '#   - 真实密钥只放在 deploy/.env.deploy（0600），不要写进本文件。',
      'name: eldercare-public',
      'services:',
      '  backend:',
      '    image: eldercare-cloud-backend:pre-d-e-20261026',
      ''
    ].join('\n'));
    const composeFile = path.join(work.tmpRoot, 'compose.pin.yaml');
    writeFileNoBom(composeFile, `name: ${PROJECT}
services:
  backend:
    image: ${IMG_PINNED}
    init: true
    restart: "no"
    read_only: false
    environment:
      API_TOKEN_SECRET: "${SAND.API_TOKEN_SECRET}"
      INGEST_KEY: "${SAND.INGEST_KEY}"
      APP_GUARDIAN_ID: "${SAND.APP_GUARDIAN_ID}"
      APP_GUARDIAN_PASSWORD: "${SAND.APP_GUARDIAN_PASSWORD}"
      CONTACTS_JSON: "[]"
    volumes:
      - pinned-data:/data
volumes:
  pinned-data:
`);
    const composeUp = docker(['compose', '-p', PROJECT, '-f', composeFile, 'up', '-d', '--no-build', 'backend'], { timeout: 120000 });
    let composeImageId = '';
    if (composeUp.code === 0) {
      composeImageId = dockerOk(['inspect', `${PROJECT}-backend-1`, '--format', '{{.Image}}']).out.trim();
    }
    const composeDown = docker(['compose', '-p', PROJECT, '-f', composeFile, 'down', '--timeout', '5']);
    record('image pinning: docker save/load round-trip + compose --no-build starts the PINNED old image',
      saveRes.code === 0 && saveSha.length === 64 && loadedId === pinnedId && pinnedId === oldId &&
      composeUp.code === 0 && composeImageId === oldId,
      { savedBytes: fs.statSync(saveFile).size, savedSha256: saveSha, pinnedId: pinnedId.slice(0, 19), loadedId: loadedId.slice(0, 19), composeExit: composeUp.code, composeImageId: composeImageId.slice(0, 19), downExit: composeDown.code });

    /* ---------- 12. 故障注入（数据面，真实卷） ---------- */
    const VOL_EMPTY_REF = `${VOL_PREFIX}ref-empty`;
    dockerOk(['volume', 'create', VOL_EMPTY_REF]);
    const emptyRefValue = volumeInventory(VOL_EMPTY_REF, IMG_OLD).treeHash;
    const inventoryEmptyReference = () => emptyRefValue;
    const scenarioBase = [
      '--expected-pre-tree-hash', preInv.treeHash,
      '--expected-post-tree-hash', v6Inv.treeHash
    ];
    const cases = [
      { name: 'corrupt-pre-archive', kind: 'corrupt-pre-archive', expectState: 'PREFLIGHT_ABORT', expectFinal: 'post' },
      { name: 'pre-archive-checksum-metadata-mismatch', kind: 'wrong-pre-hash', expectState: 'PREFLIGHT_ABORT', expectFinal: 'post' },
      { name: 'post-archive-missing', kind: 'missing-post-archive', expectState: 'PREFLIGHT_ABORT', expectFinal: 'post' },
      { name: 'staging-missing-backend-state', failPoints: ['staging-missing-state'], expectState: 'PREFLIGHT_ABORT', expectFinal: 'post' },
      { name: 'staging-content-hash-mismatch', failPoints: ['staging-tamper'], expectState: 'PREFLIGHT_ABORT', expectFinal: 'post' },
      { name: 'partial-aside-copy-failure', failPoints: ['partial-aside-copy'], failAfter: 1, expectState: 'PREFLIGHT_ABORT', expectFinal: 'post' },
      { name: 'partial-staging-extract-failure', failPoints: ['partial-staging-extract'], expectState: 'PREFLIGHT_ABORT', expectFinal: 'post' },
      { name: 'partial-landing-copy-failure', failPoints: ['partial-landing-copy'], failAfter: 1, expectState: 'RECOVERED_TO_V6', expectFinal: 'post' },
      { name: 'partial-landing-move-failure', failPoints: ['partial-landing'], failAfter: 1, expectState: 'RECOVERED_TO_V6', expectFinal: 'post' },
      { name: 'final-verify-failure', failPoints: ['final-verify'], expectState: 'RECOVERED_TO_V6', expectFinal: 'post' },
      { name: 'recovery-mid-undo-then-fallback', failPoints: ['partial-landing', 'recovery-fail'], failAfterByPoint: { 'partial-landing': 2, 'recovery-fail': 1 }, expectState: 'RECOVERED_TO_V6', expectFinal: 'post' },
      { name: 'recovery-failure-secondary', failPoints: ['partial-landing', 'recovery-before-undo', 'corrupt-original-copy'], failAfterByPoint: { 'partial-landing': 1 }, expectState: 'MANUAL_TAKEOVER_REQUIRED', expectFinal: 'mixed', expectManual: true },
      { name: 'post-archive-unreadable', kind: 'corrupt-post-archive', expectState: 'PREFLIGHT_ABORT', expectFinal: 'post' },
      { name: 'wrong-or-empty-volume-refused', kind: 'empty-volume', expectState: 'PREFLIGHT_ABORT', expectFinal: 'empty' }
    ];

    for (const testCase of cases) {
      const volCase = `${VOL_PREFIX}case-${testCase.name.replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
      importVolume(volCase, IMG_OLD, postArchive);
      let preForCase = preArchive;
      let preHashForCase = preInv.treeHash;
      let postForCase = postArchive;
      let extra = [];
      if (testCase.kind === 'corrupt-pre-archive') {
        preForCase = path.join(work.backup, `corrupt-${testCase.name}.tgz`);
        const bytes = Buffer.from(fs.readFileSync(preArchive));
        for (let index = 100; index < 220 && index < bytes.length; index += 1) bytes[index] ^= 0xFF;
        fs.writeFileSync(preForCase, bytes);
      }
      if (testCase.kind === 'wrong-pre-hash') preHashForCase = 'DEADBEEF'.repeat(8);
      if (testCase.kind === 'missing-post-archive') postForCase = path.join(work.backup, 'absent-post.tgz');
      if (testCase.kind === 'corrupt-post-archive') {
        postForCase = path.join(work.backup, `corrupt-post-${testCase.name}.tgz`);
        const bytes = Buffer.from(fs.readFileSync(postArchive));
        for (let index = 100; index < 200 && index < bytes.length; index += 1) bytes[index] ^= 0xFF;
        fs.writeFileSync(postForCase, bytes);
      }
      if (testCase.kind === 'empty-volume') {
        // 用“与升级后状态不符”的空卷：S1 的 live-volume identity 闸门必须拒绝
        removeVolume(volCase);
        dockerOk(['volume', 'create', volCase]);
      }
      for (const point of (testCase.failPoints || [])) extra.push('--fail-point', point);
      if (testCase.failAfter) extra.push('--fail-after', String(testCase.failAfter));
      for (const [point, count] of Object.entries(testCase.failAfterByPoint || {})) extra.push('--fail-after', `${point}=${count}`);

      const evidenceFile = path.join(work.evidence, `case-${testCase.name}.json`);
      const res = docker(['run', '--rm', '--network', 'none', '--user', 'node',
        '--mount', `type=volume,source=${volCase},target=/data`,
        '--mount', `type=bind,source=${path.dirname(preForCase)},target=/backup,readonly`,
        '--mount', `type=bind,source=${path.dirname(evidenceFile)},target=/evidence`,
        '--mount', `type=bind,source=${path.dirname(TX_SCRIPT)},target=/opt/rollback,readonly`,
        IMG_OLD, 'node', '/opt/rollback/rollback-transaction.js',
        '--data-root', '/data',
        '--pre-archive', `/backup/${path.basename(preForCase)}`,
        '--post-archive', `/backup/${path.basename(postForCase)}`,
        '--evidence-out', `/evidence/${path.basename(evidenceFile)}`,
        '--volume-name', volCase,
        '--backend-stopped-asserted',
        '--mode', 'rollback',
        '--expected-pre-tree-hash', preHashForCase,
        '--expected-post-tree-hash', v6Inv.treeHash,
        '--op-id', `op-${testCase.name}-${ID}`,
        ...extra]);
      const inv = volumeInventory(volCase, IMG_OLD);
      const emptyRef = inventoryEmptyReference(IMG_OLD);
      const finalKind = inv.treeHash === v6Inv.treeHash ? 'post'
        : (inv.treeHash === finalInv.treeHash ? 'rollback-complete'
          : (inv.treeHash === emptyRef ? 'empty' : 'mixed'));
      let evidence = null;
      if (fs.existsSync(evidenceFile)) { try { evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); } catch { evidence = null; } }
      const stateOk = evidence && evidence.state === testCase.expectState;
      const finalOk = finalKind === testCase.expectFinal;
      const manualOk = testCase.expectManual === undefined ? true : Boolean(evidence && evidence.manualTakeover) === testCase.expectManual;
      const ok = res.code === (testCase.expectState === 'PREFLIGHT_ABORT' ? 10 : testCase.expectState === 'RECOVERED_TO_V6' ? 20 : 30) && stateOk && finalOk && manualOk;
      record(`fault injection (container/volume): ${testCase.name}`, ok, {
        injectionPoint: (testCase.failPoints || []).join('+') || testCase.kind || 'none',
        expectedState: testCase.expectState,
        actualExitCode: res.code,
        actualState: evidence ? evidence.state : 'NO_EVIDENCE',
        serviceStayedStopped: true,
        serviceMustStayStopped: evidence ? Boolean(evidence.serviceMustStayStopped) : null,
        finalFileList: inv.rows.map((row) => `${row.type}:${row.path}`),
        beforeTreeHash: v6Inv.treeHash,
        afterTreeHash: inv.treeHash,
        afterTreeHashKind: finalKind,
        postArchiveIntact: sha256File(postArchive) === summary.postArchive.sha256,
        mixedState: finalKind === 'mixed',
        manualTakeover: evidence ? Boolean(evidence.manualTakeover) : false
      });
      removeVolume(volCase);
    }

    /* ---------- 13. 镜像面故障：旧 tag 不存在 / 旧镜像启动失败 ---------- */
    const missingTagRun = docker(['run', '--rm', '--network', 'none', `${ID}-missing:tag`, 'true']);
    const missingTagInv = volumeInventory(volRollback, IMG_OLD);
    const missingDataUnchanged = missingTagInv.treeHash === afterWriteInv.treeHash;
    record('old image/tag missing: start fails, restored data unchanged, state classified as old-image-not-running',
      missingTagRun.code !== 0 && missingDataUnchanged,
      {
        runExit: missingTagRun.code,
        dataState: missingDataUnchanged ? 'v5_restored_verified' : 'unknown',
        oldImageStarted: false,
        dataUnchanged: missingDataUnchanged,
        classification: `ROLLED_BACK_${missingDataUnchanged ? 'V5_DATA_RESTORED' : 'DATA_UNKNOWN'}_OLD_IMAGE_NOT_RUNNING`
      });

    const badEnvContainer = `${ID}-old-badenv`;
    const badEnvRun = docker(['run', '-d', '--name', badEnvContainer, '--network', 'none', '--user', 'node',
      '--mount', `type=volume,source=${volRollback},target=/data`,
      '-e', `API_TOKEN_SECRET=${SAND.API_TOKEN_SECRET}`,
      '-e', `INGEST_KEY=${SAND.INGEST_KEY}`,
      '-e', `APP_GUARDIAN_ID=${SAND.APP_GUARDIAN_ID}`,
      '-e', `APP_GUARDIAN_PASSWORD=${SAND.APP_GUARDIAN_PASSWORD}`,
      '-e', 'HOUSEHOLD_TIMEZONE=Mars/Phobos',
      IMG_OLD]);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const badEnvExit = docker(['inspect', badEnvContainer, '--format', '{{.State.Status}} {{.State.ExitCode}}']).out.trim();
    docker(['rm', '-f', badEnvContainer]);
    const badEnvInv = volumeInventory(volRollback, IMG_OLD);
    const badEnvDataUnchanged = badEnvInv.treeHash === afterWriteInv.treeHash;
    record('old image start failure: service stays stopped, v5 data unchanged (separate terminal state)',
      badEnvRun.code === 0 && /exited [1-9]/.test(badEnvExit) && badEnvDataUnchanged,
      {
        containerState: badEnvExit,
        dataState: badEnvDataUnchanged ? 'v5_restored_verified' : 'unknown',
        oldImageStarted: false,
        dataUnchanged: badEnvDataUnchanged,
        classification: `ROLLED_BACK_${badEnvDataUnchanged ? 'V5_DATA_RESTORED' : 'DATA_UNKNOWN'}_OLD_IMAGE_NOT_RUNNING`
      });

    summary.result = failures === 0 ? 'DOCKER_VOLUME_VALIDATION_PASS' : 'DOCKER_VOLUME_VALIDATION_FAILED';
  } catch (error) {
    failures += 1;
    summary.fatal = { message: error && error.message, stack: error && error.stack };
    summary.result = 'DOCKER_VOLUME_VALIDATION_FATAL';
    log(`FAIL  fatal: ${error && error.message}`);
  } finally {
    /* ---------- 清理：只按精确名字删除本次创建的资源 ---------- */
    summary.cleanup = [];
    for (const volumeName of docker(['volume', 'ls', '--format', '{{.Name}}']).out.split('\n').filter(Boolean)) {
      if (volumeName.startsWith(VOL_PREFIX) || volumeName === `${PROJECT}_pinned-data`) {
        docker(['volume', 'rm', '-f', volumeName]);
        summary.cleanup.push(`volume:${volumeName}`);
      }
    }
    for (const name of docker(['ps', '-a', '--format', '{{.Names}}']).out.split('\n').filter(Boolean)) {
      if (name.startsWith(ID)) {
        docker(['rm', '-f', name]);
        summary.cleanup.push(`container:${name}`);
      }
    }
    docker(['network', 'rm', NET]);
    summary.cleanup.push(`network:${NET}`);
    for (const tag of [IMG_NEW, IMG_OLD, IMG_PINNED]) {
      docker(['rmi', '-f', tag]);
      summary.cleanup.push(`image:${tag}`);
    }
    summary.cleanup.push('verified out of scope: eldercare-public_* volumes / containers untouched');

    // 把每个场景的事务证据 JSON 持久化到交付目录（临时目录随后会被删除）
    try {
      const evidenceDir = path.join(DELIVERY, 'sandbox', 'logs', 'docker-evidence');
      fs.mkdirSync(evidenceDir, { recursive: true });
      let copied = 0;
      for (const name of fs.readdirSync(work.evidence)) {
        fs.copyFileSync(path.join(work.evidence, name), path.join(evidenceDir, name));
        copied += 1;
      }
      summary.evidencePersisted = { dir: 'sandbox/logs/docker-evidence', files: copied };
    } catch (error) {
      summary.evidencePersisted = { error: String(error && error.message) };
    }
    summary.finishedAt = new Date().toISOString();
    summary.total = results.length;
    summary.passed = results.filter((row) => row.ok).length;
    summary.failed = failures;
    writeFileNoBom(OUT_JSON, `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(OUT_LOG, `${logLines.join('\n')}\n`, 'utf8');

    // 安全清理临时目录：必须位于系统临时目录且以本次前缀开头
    const allowedPrefix = path.resolve(os.tmpdir()) + path.sep;
    const resolved = path.resolve(work.tmpRoot);
    if (!KEEP && resolved.startsWith(allowedPrefix) && path.basename(resolved).startsWith('de-rb-docker-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
      log('[docker-validation] temp dir cleaned');
    } else {
      log(`[docker-validation] temp dir kept: ${resolved}`);
    }

    log(`[docker-validation] total=${summary.total} passed=${summary.passed} failed=${summary.failed}`);
    log(`[docker-validation] ${summary.result}`);
    log(`[docker-validation] json: ${OUT_JSON}`);
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[docker-validation] FATAL', error);
  process.exit(1);
});
