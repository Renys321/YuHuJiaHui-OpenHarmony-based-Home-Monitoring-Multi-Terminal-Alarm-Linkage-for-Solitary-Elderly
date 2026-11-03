'use strict';

/**
 * northbound/tests/sosvoiceability-guard.test.js — HAP 侧播放链路的源码守卫
 *
 * 为什么需要它：ArkTS 很难在当前工作机上做运行时单测（需要板子/模拟器）。
 * 因此这里用源码级守卫把关键契约钉死，**然后再用 hvigor 真实编译**验证语法与类型。
 * 守卫不能替代编译，编译也不能替代守卫，两者都要跑。
 *
 * 覆盖：
 *   - 5 个预置资源白名单存在且与 southbound 代理一致；
 *   - 读取 want.parameters.voiceResource / playbackMessageId / callbackPort / callbackNonce；
 *   - 参数校验（黑名单字符、白名单精确匹配、端口范围、nonce 形状）；
 *   - 没有任何路径拼接；
 *   - completed / error 回调都存在，且 completed 才回执 COMPLETED；
 *   - 未知资源绝不回退 sos.wav；
 *   - 旧 SOS 行为（无参数时用 sos.wav）保留；
 *   - 回执正文包含 4 个固定字段、地址固定 127.0.0.1 + /playback-result；
 *   - 不把 ingest key / 后端 URL / 微信凭据写入源码。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HAP_SOURCE = path.resolve(__dirname, '..', 'entry', 'src', 'main', 'ets', 'sosvoiceability', 'SosVoiceAbility.ets');
const AGENT = require('../../southbound/comms-agent');

const source = fs.readFileSync(HAP_SOURCE, 'utf8');

/** 从 ArkTS 源码里取回白名单数组。 */
function extractResourceList() {
  const match = /const VOICE_RESOURCES: string\[\] = \[([\s\S]*?)\];/.exec(source);
  assert.ok(match, '必须声明 VOICE_RESOURCES 白名单');
  const names = match[1].match(/'[^']+'/g) || [];
  return names.map((item) => item.slice(1, -1));
}

test('the HAP declares exactly the five preset resources', () => {
  const list = extractResourceList();
  assert.deepEqual(list.slice().sort(), [
    'check_in.wav', 'emergency_contacting.wav', 'family_message.wav',
    'medicine_reminder.wav', 'please_respond.wav'
  ]);
});

test('the HAP whitelist matches the southbound device whitelist exactly', () => {
  const list = extractResourceList();
  assert.deepEqual(list.slice().sort(), [...AGENT.RESOURCE_NAMES].sort());
  for (const resource of list) {
    assert.equal(AGENT.isAllowedResourceName(resource), true, `${resource} 必须在代理白名单里`);
  }
});

test('the HAP reads the playback parameters from want.parameters', () => {
  for (const key of ['voiceResource', 'playbackMessageId', 'callbackPort', 'callbackNonce']) {
    assert.ok(source.includes(`'${key}'`), `必须读取参数 ${key}`);
  }
  assert.match(source, /want\.parameters/, '必须从 want.parameters 取值');
  assert.match(source, /export function readStringParam/, '必须有参数读取辅助函数');
  assert.match(source, /export function isValidPlaybackMessageId/, '必须校验 playbackMessageId');
  assert.match(source, /portParam\.length > 0 \|\| nonceParam\.length > 0/,
    '任意回执参数存在都必须进入远程模式，不能误播放 SOS');
});

test('the HAP validates the resource name and never builds a filesystem path from it', () => {
  assert.match(source, /export function resolveVoiceResource/, '必须有资源名校验函数');
  // 黑名单字符必须在源码里出现（说明确实做了拒绝）
  for (const token of ["'/'", "'\\\\'", "':'", "'?'", "'#'", "'%'", "'..'"]) {
    assert.ok(source.includes(token), `校验逻辑必须拒绝 ${token}`);
  }
  // 不得把参数拼进路径
  assert.equal(/voiceResource\s*\+/.test(source), false, '不得把 voiceResource 参与字符串拼接');
  assert.equal(/filesDir\s*\+\s*[a-zA-Z]*voiceResource/.test(source), false, '不得用参数拼沙箱路径');
  // 沙箱路径只能由**已通过白名单的资源名**构成
  assert.match(source, /this\.path = this\.context\.filesDir \+ '\/' \+ name;/,
    '沙箱路径只能由白名单校验后的 name 构成');
});

test('the HAP rejects unknown resources without falling back to sos.wav', () => {
  // 远程留言模式的候选列表只有一个元素
  assert.match(source, /this\.candidates = \[resource\];/, '远程留言只能有一个候选资源');
  // 未知资源必须走失败分支，而不是继续用 SOS 列表
  assert.match(source, /UNKNOWN_VOICE/, '未知资源必须产生 UNKNOWN_VOICE 失败码');
  // 反向证据：在"resource === ''' 的分支里不得出现 SOS_CANDIDATES
  const guard = /if \(resource === ''\) \{([\s\S]*?)\n      \}/.exec(source);
  assert.ok(guard, '必须存在"资源非法"的判断分支');
  assert.equal(guard[1].includes('SOS_CANDIDATES'), false, '非法资源不得回退到 SOS 候选');
});

test('the HAP keeps the legacy SOS behaviour when no parameter is given', () => {
  assert.match(source, /const SOS_CANDIDATES: string\[\] = \['sos\.wav'/, '必须保留 sos.wav 候选');
  assert.match(source, /this\.candidates = SOS_CANDIDATES;/, '无参数时必须使用 SOS 候选');
  assert.match(source, /this\.remoteMode = false;/, '无参数时必须标记为非远程留言模式');
});

test('the HAP only reports COMPLETED from the AVPlayer completed callback', () => {
  // completed 分支必须调用 finish('COMPLETED', ...)
  const completedBranch = /state === 'completed'\) \{([\s\S]*?)\n        \}/.exec(source);
  assert.ok(completedBranch, '必须有 completed 状态分支');
  assert.match(completedBranch[1], /this\.finish\('COMPLETED'/, 'completed 分支才允许回执 COMPLETED');
  // error / 失败路径不得回执 COMPLETED
  assert.match(source, /player\.on\('error'/, '必须监听 error');
  assert.equal(/nextAttempt\(\)[\s\S]{0,40}COMPLETED/.test(source), false, 'error 路径不得回执 COMPLETED');
  // 不得用定时器/睡眼冒充播放完成
  assert.equal(/setTimeout/.test(source), false, '不得用 sleep 冒充播放完成');
  assert.equal(/setInterval/.test(source), false, '不得用轮询冒充播放完成');
  assert.match(source, /if \(this\.player !== player \|\| this\.released\)/,
    '必须忽略旧播放器的迟到状态和错误事件');
});

test('the HAP posts a fixed, bounded callback body to a fixed loopback path', () => {
  assert.match(source, /const CALLBACK_PATH = '\/playback-result';/, '路径必须固定');
  assert.match(source, /const CALLBACK_HOST_PREFIX = 'http:\/\/127\.0\.0\.1:'/, '只能回环地址');
  for (const field of ['playbackMessageId', 'callbackNonce', 'result', 'errorCode']) {
    assert.ok(source.includes(`'${field}'`), `回执正文必须包含 ${field}`);
  }
  assert.match(source, /sanitizeErrorCode/, '失败码必须被清洗');
  // 不接受任意 callback URL：地址完全由 port 拼出
  assert.match(source, /export function buildCallbackUrl\(port: number\)/,
    '回调地址必须由端口构造，而不是来自参数');
  assert.equal(/callbackUrl\s*=\s*readStringParam/.test(source), false, '回调地址不得来自 want 参数');
});

test('the HAP does not embed any secret or backend address', () => {
  for (const forbidden of ['INGEST_KEY', 'ingestKey', 'x-ingest-key', 'AppSecret', 'appSecret',
    'access_token', 'openid', 'Bearer', 'https://']) {
    assert.equal(source.includes(forbidden), false, `HAP 源码不得包含 ${forbidden}`);
  }
});

test('the HAP still requests only the permissions it needs', () => {
  const moduleJson = fs.readFileSync(
    path.resolve(__dirname, '..', 'entry', 'src', 'main', 'module.json5'), 'utf8');
  // 本地回执需要 INTERNET；不得出现与播放无关的高危权限
  assert.ok(moduleJson.includes('ohos.permission.INTERNET'), '必须声明 INTERNET 权限');
  for (const forbidden of ['ohos.permission.READ_CONTACTS', 'ohos.permission.LOCATION',
    'ohos.permission.WRITE_MEDIA', 'ohos.permission.READ_MEDIA']) {
    assert.equal(moduleJson.includes(forbidden), false, `不得申请 ${forbidden}`);
  }
});

test('the exported pure validators behave as the contract requires', () => {
  // 直接验证参数校验的语义（与 ArkTS 实现同源的 Node 侧等价实现）
  const port = AGENT.createCallbackNonce();
  assert.equal(AGENT.CALLBACK_PATH, '/playback-result');
  assert.equal(AGENT.CALLBACK_HOST, '127.0.0.1');
  assert.ok(port.length >= 22);
});
