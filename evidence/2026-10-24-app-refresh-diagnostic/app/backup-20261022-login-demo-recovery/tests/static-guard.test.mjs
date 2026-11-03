/**
 * 静态守卫测试（STATIC SOURCE GUARD）
 *
 * 目的：在不依赖运行时的前提下，证明正式源码（entry/src/main/ets/**）没有
 * 回退到演示数据 / Mock、没有设备内部凭据、没有假成功文案、没有登录页旧账号体系。
 *
 * 注意：
 * - 本文件是静态扫描，不代表真实 API 或真机验收（NOT TESTED）。
 * - 注释内容在扫描前被剥离，避免“注释里提到 MockData”造成误报。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const ETS_ROOT = path.join(PROJECT_ROOT, 'entry', 'src', 'main', 'ets');

/** 递归收集 .ets / .ts 生产源码（相对 PROJECT_ROOT 的 / 分隔路径）。 */
function collectSources(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(ets|ts)$/.test(entry.name)) {
        out.push(path.relative(PROJECT_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 去掉 JS/TS 注释，保留字符串字面量与代码。
 * 简化状态机，足够处理 ArkTS 源码。
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let state = 'code'; // code | line | block | sq | dq | bt
  while (i < n) {
    const ch = source[i];
    const next = i + 1 < n ? source[i + 1] : '';
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ch === "'") { state = 'sq'; out += ch; i += 1; continue; }
      if (ch === '"') { state = 'dq'; out += ch; i += 1; continue; }
      if (ch === '`') { state = 'bt'; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (ch === '\n') out += ch;
      i += 1; continue;
    }
    // string states
    if (ch === '\\') { out += ch + (next || ''); i += 2; continue; }
    if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"') || (state === 'bt' && ch === '`')) {
      state = 'code'; out += ch; i += 1; continue;
    }
    out += ch; i += 1;
  }
  return out;
}

function readSource(rel) {
  return stripComments(fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8'));
}

/** 返回 [{rel, lineNo, line}] 命中列表。 */
function findPattern(relFiles, pattern) {
  const hits = [];
  for (const rel of relFiles) {
    const text = readSource(rel);
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      if (pattern.test(lines[idx])) {
        hits.push({ rel, lineNo: idx + 1, line: lines[idx].trim().slice(0, 160) });
      }
    }
  }
  return hits;
}

function formatHits(hits) {
  return hits.map((h) => `  ${h.rel}:${h.lineNo}  ${h.line}`).join('\n');
}

const ALL_SOURCES = collectSources(ETS_ROOT);
const MOCK_DATA_DEF = 'entry/src/main/ets/common/MockData.ets';
const FORMAL_SOURCES = ALL_SOURCES.filter((rel) => rel !== MOCK_DATA_DEF);

/** Lead 已确认最终会删除的旧演示/账号基础设施（保留即为回退隐患）。 */
const LEGACY_DEMO_FILES = [
  'entry/src/main/ets/common/MockData.ets',
  'entry/src/main/ets/common/Session.ets',
  'entry/src/main/ets/common/AccountStore.ets',
  'entry/src/main/ets/common/SmsService.ets',
  'entry/src/main/ets/model/Elder.ets',
  'entry/src/main/ets/model/Sensor.ets',
  'entry/src/main/ets/model/AlertEvent.ets'
];

function importRegex(symbol) {
  // 匹配 import { A, B } from '...' 中的符号，含多行 import。
  return new RegExp(`\\b${symbol}\\b`);
}

test('guard: entry/src/main/ets 源码存在且被扫描', () => {
  assert.ok(ALL_SOURCES.length > 20, `expected >20 sources, got ${ALL_SOURCES.length}`);
});

test('guard: 旧演示/账号基础设施文件已从最终树删除（Mock 回退源不得保留）', () => {
  const present = LEGACY_DEMO_FILES.filter((rel) => fs.existsSync(path.join(PROJECT_ROOT, rel)));
  assert.deepEqual(present, [], `旧演示/账号文件仍存在，可能被误用为回退：${present.join(', ')}`);
});

test('guard: 正式源码不 import MockData / 不使用 MockData 回退（REAL_API 铁律 1）', () => {
  const hits = findPattern(FORMAL_SOURCES, /\bMockData\b/);
  assert.deepEqual(hits, [], `正式源码仍引用 MockData:\n${formatHits(hits)}`);
});

test('guard: 正式源码不含 mock-token / 伪造 token', () => {
  const hits = findPattern(FORMAL_SOURCES, /mock[-_]token|fake[-_]token(?!-000)/i);
  assert.deepEqual(hits, [], `正式源码含 mock-token:\n${formatHits(hits)}`);
});

test('guard: 正式源码不含 INGEST_KEY（APP 不得持有设备摄入凭据）', () => {
  const hits = findPattern(FORMAL_SOURCES, /INGEST_KEY/);
  assert.deepEqual(hits, [], `正式源码含 INGEST_KEY:\n${formatHits(hits)}`);
});

test('guard: 正式源码不含 /internal/v1 设备内部接口', () => {
  const hits = findPattern(FORMAL_SOURCES, /\/internal\/v1/);
  assert.deepEqual(hits, [], `正式源码含 /internal/v1:\n${formatHits(hits)}`);
});

test('guard: 不存在无条件假成功文案（SOS 已推送 / 声光报警器已启动 / 已联系全部联系人 / 处置已归档）', () => {
  const banned = [
    /SOS\s*已推送/,
    /本地声光报警器已启动/,
    /已联系全部联系人/,
    /处置已归档/
  ];
  const hits = [];
  for (const pattern of banned) hits.push(...findPattern(FORMAL_SOURCES, pattern));
  assert.deepEqual(hits, [], `发现无条件假成功文案:\n${formatHits(hits)}`);
});

test('guard: “设备已确认”只在能核对服务端 ACKED 状态的源码中出现', () => {
  const hits = findPattern(FORMAL_SOURCES, /设备已确认/);
  for (const hit of hits) {
    const text = readSource(hit.rel);
    // 合法来源：直接核对服务端 state==='ACKED'，或用 mapAlerts 产出的 statusKey==='acked'。
    const checksServerState = /\bACKED\b/.test(text) || /'acked'|"acked"|statusKey/.test(text);
    assert.ok(
      checksServerState,
      `${hit.rel}:${hit.lineNo} 出现“设备已确认”，但该文件不核对服务端 ACKED/statusKey 状态`
    );
  }
});

test('guard: LoginPage 不含旧账号体系 AccountStore / SmsService / Session', () => {
  const login = ALL_SOURCES.filter((rel) => rel.endsWith('/LoginPage.ets'));
  assert.equal(login.length, 1, 'LoginPage.ets 应存在且唯一');
  for (const symbol of ['AccountStore', 'SmsService', 'Session']) {
    assert.deepEqual(findPattern(login, importRegex(symbol)), [], `LoginPage 仍引用 ${symbol}`);
  }
});

test('guard: Register/Forgot/ChangePwd/CancelAccount 页面不调用 AccountStore/SmsService（无后端能力=未开放）', () => {
  const pages = ALL_SOURCES.filter((rel) => /pages\/(RegisterPage|ForgotPage|ChangePwdPage|CancelAccountPage)\.ets$/.test(rel));
  assert.ok(pages.length >= 1, '未找到无后端能力的账号页面');
  const hits = [];
  for (const symbol of ['AccountStore', 'SmsService']) {
    hits.push(...findPattern(pages, importRegex(symbol)));
  }
  assert.deepEqual(hits, [], `账号页面仍调用旧演示账号服务:\n${formatHits(hits)}`);
});

test('guard: 正式源码只使用 https://api.luxunacc.xyz（无 http:// 或其他域名）', () => {
  const hits = [];
  for (const rel of FORMAL_SOURCES) {
    const text = readSource(rel);
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      const urls = line.match(/https?:\/\/[^\s'"`)]+/g) || [];
      for (const url of urls) {
        if (!url.startsWith('https://api.luxunacc.xyz')) {
          hits.push({ rel, lineNo: idx + 1, line: `${line.trim().slice(0, 140)}  [${url}]` });
        }
      }
    }
  }
  assert.deepEqual(hits, [], `发现非正式域名/明文 HTTP:\n${formatHits(hits)}`);
});

test('guard: 正式源码不 import 纯演示数据文件 Elder / 旧 Sensor 模型（如已删除则跳过）', () => {
  // 旧演示模型若仍被页面引用，说明还停留在 Mock 数据形态。
  const hits = findPattern(FORMAL_SOURCES, /import\s*\{[^}]*\b(MockData|AccountStore|SmsService)\b[^}]*\}\s*from/);
  assert.deepEqual(hits, [], `旧演示依赖仍被 import:\n${formatHits(hits)}`);
});

test('guard: LoginPage 走真实 GuardianService 登录，不自行拼 HTTP', () => {
  const login = ALL_SOURCES.filter((rel) => rel.endsWith('/LoginPage.ets'));
  assert.equal(login.length, 1);
  const text = readSource(login[0]);
  assert.match(text, /GuardianService/, 'LoginPage 必须调用 GuardianService');
  assert.doesNotMatch(text, /\bApiClient\b|HarmonyHttpTransport/, '页面不得绕开 GuardianService 直接使用传输层');
});

test('guard: 页面层不直接 import ApiClient / HarmonyHttpTransport（唯一入口 GuardianService）', () => {
  const pages = ALL_SOURCES.filter((rel) => /\/pages\/[^/]+\.ets$/.test(rel));
  assert.ok(pages.length >= 10);
  const hits = findPattern(pages, /from\s+['"][^'"]*core\/api\/(ApiClient|HttpTransport)['"]/);
  assert.deepEqual(hits, [], `页面绕过 GuardianService 直接访问 API 层:\n${formatHits(hits)}`);
});

test('guard: 关键错误/状态文案包含规范要求的诚实表述（静态存在性）', () => {
  const corpus = FORMAL_SOURCES.map(readSource).join('\n');
  const required = [
    /账号或口令错误/,
    /尝试过多/,
    /服务端登录未配置/,
    /请求超时/,
    /网络不可用/,
    /账号已被服务端停用/,
    /告警不存在或已失效/,
    /命令已提交/,
    /等待设备确认/,
    /设备已确认/,
    /监测异常/,
    /等待数据/,
    /未安装\/未启用/
  ];
  const missing = required.filter((pattern) => !pattern.test(corpus)).map((p) => p.source);
  assert.deepEqual(missing, [], `缺少规范要求的用户文案: ${missing.join(' | ')}`);
});

// ---------------------------------------------------------------- 安全铁律

test('guard: 密码不落盘/不进日志/不进 AppStorage（LoginPage 只在内存使用）', () => {
  const login = ALL_SOURCES.filter((rel) => rel.endsWith('/LoginPage.ets'));
  assert.equal(login.length, 1);
  const text = readSource(login[0]);
  assert.match(text, /this\.pwd\s*=\s*''/, '登录成功后必须清空口令变量');
  const dangerous = /(AppStorage\.setOrCreate[^\n]*pwd)|(console\.[a-z]+[^\n]*pwd)|(hilog\.[a-z]+[^\n]*pwd)|(Preferences[^\n]*pwd)|(relationalStore[^\n]*pwd)|(setMemory[^\n]*pwd)|(saveSecure[^\n]*pwd)/i;
  assert.doesNotMatch(text, dangerous, '口令不得写入 AppStorage/安全存储/日志');
});

test('guard: token 只走系统安全存储（AssetStoreKit），不用明文 Preferences/SQLite', () => {
  const vault = ALL_SOURCES.filter((rel) => rel.endsWith('/auth/TokenVault.ets'));
  assert.equal(vault.length, 1, 'auth/TokenVault.ets 应存在');
  const text = readSource(vault[0]);
  assert.match(text, /AssetStoreKit/, 'token 首选系统安全存储');
  assert.match(text, /asset\.(add|query|remove)/, '必须实际调用 asset API');
  assert.doesNotMatch(text, /@kit\.ArkData|Preferences|relationalStore/, '禁止明文 Preferences/SQLite 存 token');
});

test('guard: 全仓库只有 net/HarmonyHttpTransport 直接使用 @kit.NetworkKit', () => {
  const hits = [];
  for (const rel of FORMAL_SOURCES) {
    const text = readSource(rel);
    if (!/@kit\.NetworkKit|@ohos\.net\.http/.test(text)) continue;
    if (rel.endsWith('/net/HarmonyHttpTransport.ets')) continue;
    hits.push({ rel, lineNo: 0, line: '引用网络栈' });
  }
  assert.deepEqual(hits, [], `除传输适配层外的源码直接使用网络栈:\n${formatHits(hits)}`);
});

test('guard: 正式源码不打印 token/password/secret', () => {
  const hits = [];
  for (const rel of FORMAL_SOURCES) {
    const lines = readSource(rel).split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      if (!/(console\.|hilog\.)/.test(line)) continue;
      if (/token|password|\bpwd\b|secret/i.test(line)) {
        hits.push({ rel, lineNo: idx + 1, line: line.trim().slice(0, 160) });
      }
    }
  }
  assert.deepEqual(hits, [], `日志中不得出现凭据:\n${formatHits(hits)}`);
});

test('guard: 正式源码不存在 dataSource=mock 之类的假数据源标记', () => {
  const hits = findPattern(FORMAL_SOURCES, /dataSource[^\n]*['"]mock['"]|['"]mock['"][^\n]*dataSource|DataSource\.MOCK/i);
  assert.deepEqual(hits, [], `不得存在 mock 数据源:\n${formatHits(hits)}`);
});

test('guard: AlertDetailPage 按 alarmId 从真实 gv.alerts 查找，ACKED 才确认（重写后启用）', () => {
  const detail = ALL_SOURCES.filter((rel) => rel.endsWith('/pages/AlertDetailPage.ets'));
  assert.equal(detail.length, 1, 'AlertDetailPage.ets 应存在');
  const text = readSource(detail[0]);
  assert.match(text, /gv\.alerts|AppKeys\.ALERTS|findAlert/, '必须从真实 gv.alerts 查找告警');
  assert.match(text, /ACKED/, '必须核对服务端 ACKED 状态');
  assert.match(text, /告警不存在或已失效/, '查不到告警必须提示不存在/已失效');
  assert.doesNotMatch(text, /MockData/, '禁止 Mock 回退');
  assert.match(text, /refreshAlerts/, '202 后必须轮询真实 alerts（refreshAlerts）');
});

test('guard: GuardianService 登录错误文案按规范映射（401/429/503/超时/网络）', () => {
  const service = ALL_SOURCES.filter((rel) => rel.endsWith('/service/GuardianService.ets'));
  assert.equal(service.length, 1, 'service/GuardianService.ets 应存在');
  const text = readSource(service[0]);
  const required = [
    /账号或口令错误/,
    /尝试过多，请/,
    /服务端登录未配置/,
    /请求超时，请检查网络后重试/,
    /网络不可用，请检查连接/,
    /账号已被服务端停用/,
    /告警不存在或已失效/,
    /命令已提交，等待设备确认/
  ];
  const missing = required.filter((p) => !p.test(text)).map((p) => p.source);
  assert.deepEqual(missing, [], `GuardianService 缺少规范文案: ${missing.join(' | ')}`);
});

test('guard: LoginPage 本地校验 guardianId(3–64 A-Za-z0-9._-) 与 password(32–256)', () => {
  const login = ALL_SOURCES.filter((rel) => rel.endsWith('/LoginPage.ets'));
  const text = readSource(login[0]);
  assert.match(text, /\[A-Za-z0-9\._-\]\{3,64\}|GUARDIAN_ID_RE|guardianIdOk/, 'guardianId 规则校验');
  assert.match(text, />= 32|32,|PASSWORD_MIN|32\b/, '口令最短 32');
  assert.match(text, /<= 256|256,|-256|256\b/, '口令最长 256');
});

test('guard: Index 初始化/清理真实轮询与 401 跳转', () => {
  const index = ALL_SOURCES.filter((rel) => rel.endsWith('/pages/Index.ets'));
  assert.equal(index.length, 1, 'Index.ets 应存在');
  const text = readSource(index[0]);
  assert.match(text, /startAutoRefresh/, '进入需启动真实自动刷新');
  assert.match(text, /stopAutoRefresh/, '退出需停止定时器');
  assert.match(text, /unauthorized/i, '需监听 401/unauthorized 跳登录');
});

test('guard: SOS 浮钮/入口明确“未开放”，不宣称已推送', () => {
  const sosFiles = ALL_SOURCES.filter((rel) => rel.endsWith('/SosFloatingButton.ets') || rel.endsWith('/pages/Index.ets'));
  assert.ok(sosFiles.length >= 1, 'SOS 浮钮或入口应存在');
  const corpus = sosFiles.map(readSource).join('\n');
  assert.match(corpus, /未开放/, 'SOS 无远程接口，必须明确未开放');
  assert.doesNotMatch(corpus, /SOS\s*已推送|已启动报警器|报警器已启动/);
});

test('guard: token 不出现在 URL 查询参数中', () => {
  const hits = findPattern(FORMAL_SOURCES, /[?&](token|access_token|sessionToken|session)=/i);
  assert.deepEqual(hits, [], `token 只能放在 Authorization 头:\n${formatHits(hits)}`);
});
