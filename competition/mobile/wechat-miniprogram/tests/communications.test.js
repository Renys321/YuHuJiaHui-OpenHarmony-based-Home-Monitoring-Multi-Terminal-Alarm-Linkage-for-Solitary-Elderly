'use strict';

/**
 * tests/communications.test.js — 远程留言（远程交流）链路的确定性测试
 *
 * 覆盖：
 *   - 服务端语音白名单、状态中文映射与幂等键格式；
 *   - validateComposeInput 的正例与全部拒绝路径（含路径穿越 / 命令拼接语音编号）；
 *   - sendMessage 的请求路径、方法与**精确请求体**，且绝不提交 openid / recipientRef；
 *   - 失败后重试复用同一个 clientMessageId；
 *   - listMessages / getMessage 的路径、limit 收敛与编号校验；
 *   - 源码守卫：页面只在点击处理函数里发送、onLoad/onShow 绝不发送、也不自动刷新留言、
 *     没有轮询定时器与任何“通话”类表述；
 *   - 用 wx 打桩真实驱动页面：只点按钮才发请求，失败后重试幂等，刷新按钮渲染中文状态。
 *
 * 全程使用 wx 打桩，不连接微信、不访问网络、不使用真实 AppID/AppSecret/openid。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------ wx 打桩 */

const requests = [];
const toasts = [];
let scripted = [];

global.wx = {
  getStorageSync() { return { apiBaseUrl: 'https://trusted.example.com', demoMode: false } },
  setStorageSync() {},
  login(options) { options.success({ code: 'single-use-wechat-code' }) },
  request(options) {
    requests.push(options);
    let pathname = '';
    try { pathname = new URL(options.url).pathname } catch (error) { pathname = '' }
    if (pathname === '/api/v1/auth/wechat') {
      options.success({ statusCode: 200, data: { sessionToken: 'runtime-session-token-12345', expiresIn: 3600 } });
      return;
    }
    const run = scripted.shift();
    if (run) { run(options); return }
    options.success({ statusCode: 404, data: {} });
  },
  showToast(options) { toasts.push(options) },
  stopPullDownRefresh() {}
};

global.getApp = () => ({ globalData: { settings: {} } });

const api = require('../services/api');
const comms = require('../services/communications');

function resetWx() {
  requests.length = 0;
  toasts.length = 0;
  scripted = [];
  api.clearSession();
}

function callsFor(pathname, method) {
  return requests.filter(call => {
    let parsed;
    try { parsed = new URL(call.url) } catch (error) { return false }
    if (parsed.pathname !== pathname) return false;
    if (method && (call.method || 'GET') !== method) return false;
    return true;
  });
}

function lastToast() {
  return toasts.length > 0 ? toasts[toasts.length - 1] : {};
}

function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** 模板消息对象：形状与后端契约一致，是 UI 的唯一事实来源。 */
function message(overrides = {}) {
  return {
    messageId: 'cmsg-msg-001',
    deviceId: 'dayu200-living',
    text: '记得吃药',
    voiceId: 'MEDICINE_REMINDER',
    requestAck: true,
    status: 'QUEUED',
    createdAt: 1791609000123,
    updatedAt: 1791609000123,
    deliveredAt: 0,
    playedAt: 0,
    acknowledgedAt: 0,
    expiresAt: 0,
    failureCode: '',
    ...overrides
  };
}

/* ------------------------------------------------------------ 语音白名单与映射 */

test('VOICE_IDS is exactly the frozen server allowlist', () => {
  assert.deepEqual(
    [...comms.VOICE_IDS],
    ['CHECK_IN', 'PLEASE_RESPOND', 'MEDICINE_REMINDER', 'FAMILY_MESSAGE', 'EMERGENCY_CONTACTING']
  );
  assert.equal(Object.isFrozen(comms.VOICE_IDS), true, '白名单必须冻结，页面不能就地改写');
});

test('voiceOptions exposes a Chinese label for every allowlisted voice', () => {
  const options = comms.voiceOptions();
  assert.deepEqual(options.map(item => item.id), [...comms.VOICE_IDS]);
  for (const option of options) {
    assert.equal(typeof option.label, 'string');
    assert.match(option.label, /[\u4e00-\u9fa5]/, `${option.id} 必须有中文标签`);
  }
  assert.equal(comms.voiceLabel('CHECK_IN'), '平安问候');
  assert.equal(comms.voiceLabel('NOT_A_VOICE'), '未知语音');
});

test('statusLabel and statusClass map all six statuses and fall back safely', () => {
  assert.deepEqual({ ...comms.STATUS_LABELS }, {
    QUEUED: '排队中',
    DELIVERED: '已送达',
    PLAYED: '已播放',
    ACKED: '老人已确认',
    FAILED: '失败',
    EXPIRED: '已过期'
  });
  for (const [status, label] of Object.entries(comms.STATUS_LABELS)) {
    assert.equal(comms.statusLabel(status), label);
    assert.equal(comms.statusClass(status), `status-${status.toLowerCase()}`);
  }
  for (const unknown of ['', 'queued', 'WAT', undefined, null, 42]) {
    assert.equal(comms.statusLabel(unknown), '未知');
    assert.equal(comms.statusClass(unknown), 'status-unknown');
  }
});

/* ------------------------------------------------------------ 幂等键 */

test('createClientMessageId matches the idempotency key format and never repeats', () => {
  const first = comms.createClientMessageId();
  const second = comms.createClientMessageId();
  assert.match(first, /^[A-Za-z0-9._-]{8,64}$/);
  assert.match(second, /^[A-Za-z0-9._-]{8,64}$/);
  assert.notEqual(first, second);
  assert.equal(comms.isValidClientMessageId(first), true);
  assert.equal(comms.isValidClientMessageId('short'), false);
  assert.equal(comms.isValidClientMessageId('x'.repeat(65)), false);
  assert.equal(comms.isValidClientMessageId('has space 12345'), false);
  assert.equal(comms.isValidClientMessageId(null), false);
});

/* ------------------------------------------------------------ 输入校验 */

test('validateComposeInput accepts a good payload and trims the text', () => {
  const result = comms.validateComposeInput({
    deviceId: ' dayu200-living ',
    text: '  记得吃药  ',
    voiceId: 'MEDICINE_REMINDER',
    requestAck: true
  });
  assert.deepEqual(result, { ok: true, errors: {} });
});

test('validateComposeInput rejects missing or malformed device ids', () => {
  const base = { text: '你好', voiceId: 'CHECK_IN', requestAck: false };
  const empty = comms.validateComposeInput({ ...base, deviceId: '' });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.deviceId, /设备/);

  for (const deviceId of ['bad device id', '../../etc/passwd', 'dayu200/living', '设备一号', 'a'.repeat(65), undefined]) {
    const result = comms.validateComposeInput({ ...base, deviceId });
    assert.equal(result.ok, false, `deviceId=${JSON.stringify(deviceId)} 必须被拒绝`);
    assert.ok(result.errors.deviceId);
  }
  assert.equal(comms.validateComposeInput(undefined).ok, false, '缺少输入必须安全失败');
});

test('validateComposeInput rejects empty and overlong text', () => {
  const base = { deviceId: 'dayu200-living', voiceId: 'CHECK_IN', requestAck: false };
  const empty = comms.validateComposeInput({ ...base, text: '   ' });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.text, /留言内容/);

  const overlong = comms.validateComposeInput({ ...base, text: '药'.repeat(121) });
  assert.equal(overlong.ok, false);
  assert.match(overlong.errors.text, /120/);

  assert.equal(comms.validateComposeInput({ ...base, text: '药'.repeat(120) }).ok, true, '恰好 120 字必须通过');
});

test('validateComposeInput rejects voice ids outside the allowlist', () => {
  const base = { deviceId: 'dayu200-living', text: '你好', requestAck: false };
  for (const voiceId of ['', 'check_in', 'CHECK_IN ', 'UNKNOWN_VOICE', 'HELLO', 42, undefined]) {
    const result = comms.validateComposeInput({ ...base, voiceId });
    assert.equal(result.ok, false, `voiceId=${JSON.stringify(voiceId)} 必须被拒绝`);
    assert.match(result.errors.voiceId, /预置语音/);
  }
});

test('validateComposeInput rejects path-like and shell-like voice ids', () => {
  const base = { deviceId: 'dayu200-living', text: '你好', requestAck: false };
  for (const voiceId of [
    '../../etc/passwd',
    'CHECK_IN; rm -rf /',
    'CHECK_IN\nMEDICINE_REMINDER',
    'CHECK_IN/../MEDICINE_REMINDER',
    'CHECK_IN`whoami`'
  ]) {
    const result = comms.validateComposeInput({ ...base, voiceId });
    assert.equal(result.ok, false, `voiceId=${JSON.stringify(voiceId)} 必须被拒绝`);
    assert.ok(result.errors.voiceId);
  }
});

/* ------------------------------------------------------------ 发送 */

test('sendMessage posts the exact contract body without identity fields', async () => {
  resetWx();
  scripted.push(options => options.success({ statusCode: 201, data: { message: message() } }));

  const sent = await comms.sendMessage({
    clientMessageId: 'cmsg-abc12345-xyz98765',
    deviceId: ' dayu200-living ',
    text: '  记得吃药  ',
    voiceId: 'MEDICINE_REMINDER',
    requestAck: true
  });
  assert.equal(sent.messageId, 'cmsg-msg-001', '必须返回后端返回的 message 对象');

  const posts = callsFor('/api/v1/communications/messages', 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://trusted.example.com/api/v1/communications/messages');
  assert.deepEqual(Object.keys(posts[0].data).sort(), ['clientMessageId', 'deviceId', 'requestAck', 'text', 'voiceId']);
  assert.deepEqual(posts[0].data, {
    clientMessageId: 'cmsg-abc12345-xyz98765',
    deviceId: 'dayu200-living',
    text: '记得吃药',
    voiceId: 'MEDICINE_REMINDER',
    requestAck: true
  });
  for (const forbidden of ['openid', 'recipientRef', 'token', 'phone', 'latitude', 'longitude']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(posts[0].data, forbidden), false,
      `客户端绝不能提交 ${forbidden}`
    );
  }
  assert.match(String(posts[0].header.Authorization), /^Bearer /, '必须复用 api.js 的 Bearer 会话');
});

test('sendMessage generates a valid idempotency key and coerces requestAck when missing', async () => {
  resetWx();
  scripted.push(options => options.success({ statusCode: 201, data: { message: message() } }));

  await comms.sendMessage({
    deviceId: 'dayu200-living',
    text: ' 请回应一声 ',
    voiceId: 'PLEASE_RESPOND'
  });

  const posts = callsFor('/api/v1/communications/messages', 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].data.text, '请回应一声');
  assert.equal(posts[0].data.requestAck, false);
  assert.match(posts[0].data.clientMessageId, /^[A-Za-z0-9._-]{8,64}$/);
});

test('retrying a failed send reuses the same clientMessageId', async () => {
  resetWx();
  const draft = {
    clientMessageId: 'cmsg-retry001-abcd1234',
    deviceId: 'dayu200-living',
    text: '请回个话',
    voiceId: 'PLEASE_RESPOND',
    requestAck: true
  };

  scripted.push(options => options.fail({ errMsg: 'request:fail timeout' }));
  await assert.rejects(() => comms.sendMessage(draft), /超时/);

  scripted.push(options => options.success({ statusCode: 200, data: { message: message({ status: 'QUEUED' }) } }));
  await comms.sendMessage(draft);

  const posts = callsFor('/api/v1/communications/messages', 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].data.clientMessageId, 'cmsg-retry001-abcd1234');
  assert.equal(posts[1].data.clientMessageId, 'cmsg-retry001-abcd1234', '重试必须复用同一个幂等键');
});

test('sendMessage rejects a malformed caller-supplied clientMessageId instead of replacing it', async () => {
  resetWx();
  await assert.rejects(
    () => comms.sendMessage({
      clientMessageId: 'bad id',
      deviceId: 'dayu200-living',
      text: '你好',
      voiceId: 'CHECK_IN',
      requestAck: false
    }),
    /留言编号无效/
  );
  assert.equal(callsFor('/api/v1/communications/messages').length, 0, '非法幂等键连请求都不该发出');
});

test('sendMessage rejects invalid input without touching the network', async () => {
  resetWx();
  await assert.rejects(
    () => comms.sendMessage({ deviceId: '', text: '你好', voiceId: 'CHECK_IN', requestAck: false }),
    /设备/
  );
  await assert.rejects(
    () => comms.sendMessage({ deviceId: 'dayu200-living', text: '', voiceId: 'CHECK_IN', requestAck: false }),
    /留言内容/
  );
  await assert.rejects(
    () => comms.sendMessage({ deviceId: 'dayu200-living', text: '你好', voiceId: 'CHECK_IN; rm -rf /', requestAck: false }),
    /预置语音/
  );
  assert.equal(requests.length, 0, '校验失败时不得发起任何请求');
});

test('sendMessage surfaces readable Chinese errors for the documented status codes', async () => {
  const cases = [[400, /不符合要求/], [403, /未获监护授权/], [404, /不存在/], [413, /过长/]];
  for (const [statusCode, pattern] of cases) {
    resetWx();
    scripted.push(options => options.success({ statusCode, data: {} }));
    await assert.rejects(
      () => comms.sendMessage({ deviceId: 'dayu200-living', text: '你好', voiceId: 'CHECK_IN', requestAck: false }),
      pattern
    );
    assert.equal(callsFor('/api/v1/communications/messages', 'POST').length, 1, `${statusCode} 不应触发额外请求`);
  }
});

/* ------------------------------------------------------------ 查询 */

test('listMessages requests the documented path and returns the array', async () => {
  resetWx();
  scripted.push(options => options.success({
    statusCode: 200,
    data: { messages: [message({ messageId: 'msg-2', status: 'PLAYED' }), message({ messageId: 'msg-1', status: 'ACKED' })] }
  }));

  const list = await comms.listMessages(20);
  assert.equal(list.length, 2);
  assert.equal(list[0].messageId, 'msg-2');

  const calls = callsFor('/api/v1/communications/messages', 'GET');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://trusted.example.com/api/v1/communications/messages?limit=20');
});

test('listMessages clamps the limit and tolerates a malformed payload', async () => {
  resetWx();
  scripted.push(options => options.success({ statusCode: 200, data: { messages: [] } }));
  await comms.listMessages(999);
  scripted.push(options => options.success({ statusCode: 200, data: { messages: [] } }));
  await comms.listMessages(0);
  scripted.push(options => options.success({ statusCode: 200, data: {} }));

  const calls = callsFor('/api/v1/communications/messages', 'GET');
  assert.match(calls[0].url, /limit=50$/);
  assert.match(calls[1].url, /limit=20$/);
  assert.deepEqual(await comms.listMessages('nope'), []);
});

test('getMessage fetches by id and rejects unsafe ids without a request', async () => {
  resetWx();
  scripted.push(options => options.success({ statusCode: 200, data: { message: message({ messageId: 'msg-9' }) } }));

  const found = await comms.getMessage('msg-9');
  assert.equal(found.messageId, 'msg-9');
  assert.equal(callsFor('/api/v1/communications/messages/msg-9', 'GET').length, 1);

  await assert.rejects(() => comms.getMessage('../../etc/passwd'), /留言编号无效/);
  await assert.rejects(() => comms.getMessage(''), /留言编号无效/);
  const messageCalls = requests.filter(call => {
    try { return new URL(call.url).pathname.startsWith('/api/v1/communications/messages') } catch (error) { return false }
  });
  assert.equal(messageCalls.length, 1, '非法编号不得发出请求');
});

/* ------------------------------------------------------------ 源码守卫 */

function extractMethodBody(source, name) {
  const pattern = new RegExp(`(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`);
  const match = pattern.exec(source);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

test('the page only sends from a tap handler and never from onLoad/onShow', () => {
  const source = readSource('pages/communications/index.js');
  const onLoad = extractMethodBody(source, 'onLoad');
  const onShow = extractMethodBody(source, 'onShow');
  assert.ok(onLoad, '页面必须有 onLoad');
  assert.ok(onShow, '页面必须有 onShow');

  for (const [name, body] of [['onLoad', onLoad], ['onShow', onShow]]) {
    assert.equal(/sendMessage\s*\(/.test(body), false, `${name} 绝不能发送留言`);
    assert.equal(/listMessages\s*\(/.test(body), false, `${name} 绝不能自动刷新近期留言`);
  }

  const sendCallCount = (source.match(/sendMessage\s*\(/g) || []).length;
  const submitBody = extractMethodBody(source, 'submitMessage');
  assert.ok(submitBody, '页面必须有唯一的发送处理函数');
  const sendCallsInSubmit = (submitBody.match(/sendMessage\s*\(/g) || []).length;
  assert.equal(sendCallCount, sendCallsInSubmit, 'sendMessage 的调用点必须全部在 submitMessage 内');

  const listCallCount = (source.match(/listMessages\s*\(/g) || []).length;
  const refreshBody = extractMethodBody(source, 'refreshMessages');
  const listCallsInRefresh = (refreshBody.match(/listMessages\s*\(/g) || []).length;
  assert.equal(listCallCount, listCallsInRefresh, 'listMessages 的调用点必须全部在 refreshMessages 内');

  assert.match(source, /onSendTap\s*\([^)]*\)\s*\{\s*return this\.submitMessage\(\)/, '发送必须由按钮处理函数触发');
  assert.match(source, /onRetryTap\s*\([^)]*\)\s*\{\s*return this\.submitMessage\(\)/, '重试必须由按钮处理函数触发');

  const markup = readSource('pages/communications/index.wxml');
  assert.match(markup, /bindtap="onSendTap"/);
  assert.match(markup, /bindtap="onRetryTap"/);
  assert.match(markup, /bindtap="onRefreshTap"/);
  assert.match(markup, /maxlength="120"/);
  assert.match(markup, /<switch /);
});

test('the page and service are timer-free and free of forbidden call wording', () => {
  const files = [
    'services/communications.js',
    'pages/communications/index.js',
    'pages/communications/index.wxml',
    'pages/communications/index.wxss'
  ];
  const forbidden = [
    '正在通话', '双向实时通话', '实时通话', '实时对讲', '语音通话',
    'getRecorderManager', 'startRecord'
  ];
  for (const file of files) {
    const content = readSource(file);
    for (const word of forbidden) {
      assert.equal(content.includes(word), false, `${file} 不得包含「${word}」`);
    }
  }

  const page = readSource('pages/communications/index.js');
  const markup = readSource('pages/communications/index.wxml');
  assert.equal(/通话/.test(page + markup), false, '本阶段不存在任何“通话”表述');
  assert.equal(/setInterval\s*\(/.test(page), false, '页面不得有轮询定时器');
  assert.equal(/setTimeout\s*\(/.test(page), false, '页面不得有延迟发送');
});

test('app.json registers the communications page and its files exist', () => {
  const appJson = JSON.parse(readSource('app.json'));
  assert.ok(appJson.pages.includes('pages/communications/index'));
  assert.equal(
    appJson.pages.filter(item => item === 'pages/communications/index').length, 1,
    'app.json 不能重复登记该页面'
  );
  for (const file of ['index.js', 'index.json', 'index.wxml', 'index.wxss']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'pages/communications', file)), true, `${file} 必须存在`);
  }
  assert.equal(JSON.parse(readSource('pages/communications/index.json')).enablePullDownRefresh, true);
});

/* ------------------------------------------------------------ 页面真实行为（wx 打桩） */

let pageDefinition = null;

function makePage() {
  global.Page = definition => { pageDefinition = definition };
  const target = require.resolve('../pages/communications/index');
  delete require.cache[target];
  require('../pages/communications/index');
  const page = Object.create(pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  page.setData = function setData(value) { Object.assign(this.data, value) };
  return page;
}

test('page onLoad/onShow never post a message and never auto-refresh the list', async () => {
  resetWx();
  const page = makePage();
  page.onLoad();
  await page.onShow();

  assert.equal(callsFor('/api/v1/communications/messages', 'POST').length, 0, 'onLoad/onShow 绝不能发送留言');
  assert.equal(callsFor('/api/v1/communications/messages', 'GET').length, 0, 'onLoad/onShow 绝不能自动刷新近期留言');
  assert.equal(page.data.sending, false);
  assert.equal(page.data.clientMessageId, '');
  assert.ok(page.data.voices.length > 0, '预置语音选项必须在本地初始化');
  assert.equal(page.data.voiceId, page.data.voices[0].id);
});

test('the send tap posts exactly once with the composed values and clears the draft', async () => {
  resetWx();
  const page = makePage();
  page.onLoad();
  page.setData({
    mode: 'connected',
    devices: [{ id: 'dayu200-living', name: '客厅主机' }],
    deviceNames: ['客厅主机'],
    deviceIndex: 0,
    text: '记得吃药',
    voiceId: 'MEDICINE_REMINDER',
    requestAck: true
  });
  scripted.push(options => options.success({ statusCode: 201, data: { message: message() } }));
  scripted.push(options => options.success({ statusCode: 200, data: { messages: [message()] } }));

  await page.onSendTap();

  const posts = callsFor('/api/v1/communications/messages', 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0].data).sort(), ['clientMessageId', 'deviceId', 'requestAck', 'text', 'voiceId']);
  assert.equal(posts[0].data.deviceId, 'dayu200-living');
  assert.equal(posts[0].data.text, '记得吃药');
  assert.equal(posts[0].data.voiceId, 'MEDICINE_REMINDER');
  assert.equal(posts[0].data.requestAck, true);
  assert.match(posts[0].data.clientMessageId, /^[A-Za-z0-9._-]{8,64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(posts[0].data, 'openid'), false);

  assert.equal(page.data.sending, false);
  assert.equal(page.data.clientMessageId, '');
  assert.equal(page.data.canRetry, false);
  assert.equal(page.data.text, '');
  assert.equal(page.data.messages.length, 1);
  assert.match(String(lastToast().title), /已提交/);
});

test('a failed send keeps a retry that reuses the same clientMessageId', async () => {
  resetWx();
  const page = makePage();
  page.onLoad();
  page.setData({
    mode: 'connected',
    devices: [{ id: 'dayu200-living', name: '客厅主机' }],
    deviceNames: ['客厅主机'],
    deviceIndex: 0,
    text: '请回个话',
    voiceId: 'PLEASE_RESPOND',
    requestAck: true
  });
  scripted.push(options => options.fail({ errMsg: 'request:fail timeout' }));

  await page.onSendTap();

  const firstId = page.data.clientMessageId;
  assert.match(firstId, /^[A-Za-z0-9._-]{8,64}$/, '失败后必须把幂等键留在页面里');
  assert.equal(page.data.canRetry, true, '失败必须给出显式重试入口');
  assert.equal(page.data.sending, false);
  assert.match(String(lastToast().title), /超时|网络/);

  scripted.push(options => options.success({ statusCode: 200, data: { message: message() } }));
  scripted.push(options => options.success({ statusCode: 200, data: { messages: [] } }));
  await page.onRetryTap();

  const posts = callsFor('/api/v1/communications/messages', 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].data.clientMessageId, firstId);
  assert.equal(posts[1].data.clientMessageId, firstId, '点击重试必须复用同一个幂等键');
  assert.equal(page.data.canRetry, false);
  assert.equal(page.data.clientMessageId, '');
});

test('changing the draft resets the idempotency key so a new message is created', async () => {
  resetWx();
  const page = makePage();
  page.onLoad();
  page.setData({
    mode: 'connected',
    devices: [{ id: 'dayu200-living', name: '客厅主机' }],
    deviceNames: ['客厅主机'],
    deviceIndex: 0,
    text: '第一次内容',
    voiceId: 'CHECK_IN',
    requestAck: false
  });
  scripted.push(options => options.fail({ errMsg: 'request:fail network' }));
  await page.onSendTap();
  assert.ok(page.data.clientMessageId);

  page.onTextInput({ detail: { value: '改成了新的内容' } });
  assert.equal(page.data.clientMessageId, '', '改动内容后必须换新的幂等键');
  assert.equal(page.data.canRetry, false);

  scripted.push(options => options.success({ statusCode: 201, data: { message: message() } }));
  scripted.push(options => options.success({ statusCode: 200, data: { messages: [] } }));
  await page.onSendTap();

  const posts = callsFor('/api/v1/communications/messages', 'POST');
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].data.clientMessageId, posts[1].data.clientMessageId);
});

test('the explicit refresh tap renders Chinese status labels and timestamps', async () => {
  resetWx();
  const page = makePage();
  page.onLoad();
  page.setData({ mode: 'connected', devices: [{ id: 'dayu200-living', name: '客厅主机' }] });
  scripted.push(options => options.success({
    statusCode: 200,
    data: {
      messages: [
        message({ messageId: 'msg-2', status: 'PLAYED', voiceId: 'MEDICINE_REMINDER', createdAt: 1791609000123 }),
        message({ messageId: 'msg-1', status: 'ACKED', acknowledgedAt: 1791609000999 })
      ]
    }
  }));

  await page.onRefreshTap();

  const calls = callsFor('/api/v1/communications/messages', 'GET');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://trusted.example.com/api/v1/communications/messages?limit=20');
  assert.equal(page.data.listError, '');
  assert.equal(page.data.messages.length, 2);
  assert.equal(page.data.messages[0].statusText, '已播放');
  assert.equal(page.data.messages[0].statusClass, 'status-played');
  assert.equal(page.data.messages[0].voiceLabel, '用药提醒');
  assert.equal(page.data.messages[0].deviceName, '客厅主机');
  assert.match(page.data.messages[0].timeText, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(page.data.messages[1].statusText, '老人已确认');
  assert.match(page.data.messages[1].ackText, /老人已确认/);
});

test('demo/unconnected mode refuses to fake a send or a list', async () => {
  resetWx();
  const page = makePage();
  page.onLoad();
  page.setData({ mode: 'demo' });

  await page.onSendTap();
  await page.onRetryTap();
  await page.onRefreshTap();

  assert.equal(requests.length, 0, '演示模式不得发起任何网络请求');
  assert.equal(page.data.canRetry, false);
  assert.equal(page.data.sending, false);
  assert.equal(page.data.messages.length, 0);
  const titles = toasts.map(item => String(item.title));
  assert.equal(titles.some(title => /演示/.test(title)), true, '必须明确说明演示数据不能发送');
  assert.equal(titles.some(title => /未连接/.test(title)), true, '必须明确说明云端未连接');
});
