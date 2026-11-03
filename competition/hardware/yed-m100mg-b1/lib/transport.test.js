'use strict';

/**
 * lib/transport.test.js — SerialTransport 公共 API 契约测试（node:test）
 *
 * 测试边界：
 *   - 只通过公共 API 驱动（构造器 / open / request / listen / disconnect / 事件 / stats），
 *     不调用下划线私有方法，不 monkey-patch。
 *   - 串口与定时器全部依赖注入：lib/fake-serial.js + lib/test-helpers.js。
 *     不打开真实串口、不 require('serialport')、不访问网络。
 *   - 假端口一律 COM99，绝不使用现场端口（COM6/COM7/COM12）。
 *
 * 两条必须遵守的测试纪律（旧套件曾因此卡死/崩溃）：
 *   1. 任何可能 emit('error') 的操作之前先挂 'error' 监听器。SerialTransport 的
 *      'error' 若无监听器，Node 会直接抛出并杀掉测试进程。
 *   2. 命令 promise 必须在注入响应之前就挂上 then/catch（见 track()）。request()
 *      的 rejection 会在 socket.push() 内同步触发，若不提前挂处理器，Node 会以
 *      unhandledRejection 结束进程。
 *
 * 每个用例结束都会 cleanup()：disconnect + 抽干假定时器，并断言 pendingCount()===0，
 * 保证没有悬挂的 promise、没有未结算的定时器。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SerialTransport,
  SerialTransportError,
  ERROR_CODES,
  DEFAULT_PORT,
  DEFAULT_BAUD_RATE,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_RETRIES,
  DEFAULT_QUIET_MS,
  resolveTransportConfig,
  defaultSerialOptions,
  classifySocketError
} = require('./transport');
const { createFakeSerialFactory } = require('./fake-serial');
const { createFakeTimers } = require('./test-helpers');

const PORT = 'COM99';

/** 非法配置的统一校验器。 */
const isInvalidConfig = (error) =>
  error instanceof SerialTransportError && error.code === ERROR_CODES.INVALID_CONFIG;

/* ------------------------------------------------------------ 测试工具 */

/** 推进真实事件循环一轮：socket.open/close 走 setImmediate 回调。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 让注入的 setImmediate 回调（open/close）与微任务跑完。 */
async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await tick();
}

/**
 * 结算跟踪器：立即挂上 then/catch，把 resolve/reject 收敛成可断言的 state。
 * 之所以不能直接 await request()：rejection 可能在 socket.push() 内同步发生，
 * 未挂处理器的 promise 会被 Node 当作 unhandledRejection 终止进程。
 */
function track(promise) {
  const state = { status: 'pending', value: undefined, error: undefined };
  promise.then(
    (value) => {
      state.status = 'resolved';
      state.value = value;
    },
    (error) => {
      state.status = 'rejected';
      state.error = error;
    }
  );
  return state;
}

/**
 * 组装被测对象：假串口工厂 + 假定时器 + 调用方 'error' 监听器（强制）。
 * @param {object} config 传输层配置（port 固定为 COM99）
 * @param {object} factoryOptions 传给 createFakeSerialFactory 的选项
 */
function createHarness(config = {}, factoryOptions = {}) {
  const timers = createFakeTimers();
  const factory = createFakeSerialFactory(factoryOptions);
  const transport = new SerialTransport(
    { port: PORT, ...config },
    {
      createSerial: factory.createSerial,
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
      now: () => timers.now()
    }
  );

  // 纪律 1：必须在任何操作之前挂上，否则 'error' 事件会杀掉进程。
  const errors = [];
  transport.on('error', (error) => errors.push(error));

  const events = {
    urc: [],
    retry: [],
    disconnected: [],
    scheduled: [],
    succeeded: [],
    failed: [],
    exhausted: [],
    open: [],
    closed: []
  };
  transport.on('urc', (line) => events.urc.push(line));
  transport.on('retry', (payload) => events.retry.push(payload));
  transport.on('disconnected', (payload) => events.disconnected.push(payload));
  transport.on('reconnect:scheduled', (payload) => events.scheduled.push(payload));
  transport.on('reconnect:succeeded', (payload) => events.succeeded.push(payload));
  transport.on('reconnect:failed', (payload) => events.failed.push(payload));
  transport.on('reconnect:exhausted', (payload) => events.exhausted.push(payload));
  transport.on('open', (payload) => events.open.push(payload));
  transport.on('closed', (payload) => events.closed.push(payload));

  const harness = {
    timers,
    factory,
    transport,
    errors,
    events,
    socket: () => factory.last(),
    async open() {
      await transport.open();
      await flush();
      return transport;
    },
    /** 结束用例：关闭传输并抽干所有假定时器，断言无残留。 */
    async cleanup() {
      if (!transport.stats.closedByUser) await transport.disconnect();
      await flush();
      timers.advance(0); // 清掉 _safeCloseSocket 的 0ms 兜底定时器
      await flush();
      assert.equal(timers.pendingCount(), 0, '用例结束时不得残留假定时器');
    }
  };
  return harness;
}

/** 带自动清理的用例包装。 */
function withHarness(name, options, body) {
  test(name, async (t) => {
    const harness = createHarness(options && options.config, options && options.factory);
    t.after(async () => {
      await harness.cleanup();
    });
    await body(harness, t);
  });
}

/* ------------------------------------------------------------ 1. 配置 */

test('resolveTransportConfig：默认值、显式覆盖、未知键忽略、非法值抛错、端口不写死', () => {
  const defaults = resolveTransportConfig();
  assert.equal(defaults.port, DEFAULT_PORT);
  assert.equal(defaults.baudRate, DEFAULT_BAUD_RATE);
  assert.equal(defaults.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
  assert.equal(defaults.retries, DEFAULT_RETRIES);
  assert.equal(defaults.quietMs, DEFAULT_QUIET_MS);
  assert.equal(defaults.lineTerminator, '\r\n');
  assert.equal(defaults.autoReconnect, true);
  assert.equal(defaults.retryOnError, false);
  assert.ok(Object.isFrozen(defaults), '配置对象必须冻结');

  const explicit = resolveTransportConfig({
    port: 'COM99',
    baudRate: 9600,
    commandTimeoutMs: 1234,
    retries: 3,
    quietMs: 20,
    retryDelayMs: 7,
    reconnectDelayMs: 50,
    reconnectMaxDelayMs: 400,
    reconnectMaxAttempts: 2,
    openTimeoutMs: 777,
    maxLines: 5,
    maxBufferBytes: 256,
    urcLogSize: 4,
    lineTerminator: '\n',
    autoReconnect: false,
    retryOnError: true,
    serialOptions: { dataBits: 7 },
    unknownKey: 'ignored',
    token: 'must-not-be-carried'
  });
  assert.equal(explicit.port, 'COM99');
  assert.equal(explicit.baudRate, 9600);
  assert.equal(explicit.commandTimeoutMs, 1234);
  assert.equal(explicit.retries, 3);
  assert.equal(explicit.quietMs, 20);
  assert.equal(explicit.retryDelayMs, 7);
  assert.equal(explicit.reconnectDelayMs, 50);
  assert.equal(explicit.reconnectMaxDelayMs, 400);
  assert.equal(explicit.reconnectMaxAttempts, 2);
  assert.equal(explicit.openTimeoutMs, 777);
  assert.equal(explicit.maxLines, 5);
  assert.equal(explicit.maxBufferBytes, 256);
  assert.equal(explicit.urcLogSize, 4);
  assert.equal(explicit.lineTerminator, '\n');
  assert.equal(explicit.autoReconnect, false);
  assert.equal(explicit.retryOnError, true);
  assert.deepEqual(explicit.serialOptions, { dataBits: 7 });

  // 白名单：未知键（含疑似凭据）绝不进入配置对象。
  assert.equal(Object.prototype.hasOwnProperty.call(explicit, 'unknownKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(explicit, 'token'), false);

  // 非法端口 / 波特率区间 / 重试上限。
  assert.throws(() => resolveTransportConfig({ port: 'ttyUSB0' }), isInvalidConfig);
  assert.throws(() => resolveTransportConfig({ port: 'COM1234' }), isInvalidConfig);
  assert.throws(() => resolveTransportConfig({ baudRate: 1199 }), isInvalidConfig);
  assert.throws(() => resolveTransportConfig({ baudRate: 460801 }), isInvalidConfig);
  assert.throws(() => resolveTransportConfig({ retries: 11 }), isInvalidConfig);

  // 边界值可用；/dev 路径同样被接受。
  assert.equal(resolveTransportConfig({ baudRate: 1200 }).baudRate, 1200);
  assert.equal(resolveTransportConfig({ baudRate: 460800 }).baudRate, 460800);
  assert.equal(resolveTransportConfig({ retries: 0 }).retries, 0);
  assert.equal(resolveTransportConfig({ retries: 10 }).retries, 10);
  assert.equal(resolveTransportConfig({ port: '/dev/ttyUSB0' }).port, '/dev/ttyUSB0');

  // 端口只是默认值：显式端口胜出，并注入到串口参数（核心逻辑不写死端口）。
  const transport = new SerialTransport({ port: 'COM99' });
  assert.equal(transport.port, 'COM99');
  assert.notEqual(transport.port, DEFAULT_PORT);
  const serialOptions = defaultSerialOptions('COM99', 9600);
  assert.equal(serialOptions.path, 'COM99');
  assert.equal(serialOptions.baudRate, 9600);
  assert.equal(serialOptions.dataBits, 8);
  assert.equal(serialOptions.stopBits, 1);
  assert.equal(serialOptions.parity, 'none');
  assert.equal(serialOptions.autoOpen, false);
});

/* ------------------------------------------------------------ 2. 错误归类 */

test('classifySocketError：按 errno 归类为稳定错误码，已分类错误原样透传', () => {
  for (const code of ['ENOENT', 'EBUSY', 'EACCES']) {
    const classified = classifySocketError(Object.assign(new Error(`open ${code}`), { code }));
    assert.ok(classified instanceof SerialTransportError);
    assert.equal(classified.code, ERROR_CODES.OPEN_FAILED);
    assert.equal(classified.cause.code, code);
  }
  for (const code of ['EIO', 'ENODEV']) {
    const classified = classifySocketError(Object.assign(new Error(`gone ${code}`), { code }));
    assert.ok(classified instanceof SerialTransportError);
    assert.equal(classified.code, ERROR_CODES.DISCONNECTED);
  }
  const already = new SerialTransportError('CUSTOM_CODE', 'already classified');
  assert.equal(classifySocketError(already), already, '已分类错误必须同一对象透传');

  const unknown = classifySocketError(Object.assign(new Error('pipe'), { code: 'EPIPE' }));
  assert.equal(unknown.code, 'EPIPE');
  assert.equal(classifySocketError(new Error('no code at all')).code, ERROR_CODES.WRITE_FAILED);
});

/* ------------------------------------------------------------ 3. 打开失败 */

withHarness(
  'open 失败：稳定 OPEN_FAILED，transport 未打开且不安排重连',
  {
    factory: { openFailures: [Object.assign(new Error('cannot open COM99'), { code: 'ENOENT' })] }
  },
  async (h) => {
    const error = await h.transport.open().then(() => null, (failure) => failure);
    await flush();

    assert.ok(error instanceof SerialTransportError);
    assert.equal(error.code, ERROR_CODES.OPEN_FAILED);
    assert.equal(h.transport.isOpen, false);
    assert.equal(h.transport.stats.open, false);
    assert.equal(h.transport.stats.reconnectScheduled, false);
    assert.equal(h.events.disconnected.length, 0);
    assert.equal(h.events.scheduled.length, 0);
    // 调用方安装的 'error' 监听器必须收到分类后的错误。
    assert.ok(h.errors.some((failure) => failure.code === ERROR_CODES.OPEN_FAILED));

    h.timers.advance(0); // _safeCloseSocket 兜底定时器
    await flush();
    assert.equal(h.timers.pendingCount(), 0);
  }
);

/* ------------------------------------------------------------ 4. DTU 命令 */

withHarness(
  'DTU 命令：回显不入 lines、静默窗口收尾、写入追加 \\r\\n 终止符',
  { config: { quietMs: 250, commandTimeoutMs: 1500 } },
  async (h) => {
    await h.open();
    const socket = h.socket();
    const state = track(h.transport.request('config,get,csq'));
    await flush();

    assert.deepEqual(socket.getWritten(), ['config,get,csq\r\n'], 'lineTerminator 必须被追加');

    socket.push('config,get,csq\r\nconfig,csq,ok,26\r\n');
    await flush();
    assert.equal(state.status, 'pending', '静默窗口未到期时命令不得结束');
    assert.equal(h.transport.stats.pending, 1);

    h.timers.advance(249);
    await flush();
    assert.equal(state.status, 'pending', '静默窗口未到期前不得结算');
    h.timers.advance(1);
    await flush();

    assert.equal(state.status, 'resolved');
    assert.deepEqual(state.value.lines, ['config,csq,ok,26']);
    assert.ok(!state.value.lines.includes('config,get,csq'), '命令回显不得进入 lines');
    assert.equal(state.value.status, 'OK');
    assert.equal(state.value.attempts, 1);
    assert.equal(h.transport.stats.pending, 0);
    assert.equal(h.timers.pendingCount(), 0);
  }
);

/* ------------------------------------------------------------ 5. AT 终止符契约 */

withHarness(
  'AT 命令：OK 终止符与命令回显都不得进入 result.lines',
  { config: { quietMs: 250, commandTimeoutMs: 1500 } },
  async (h) => {
    await h.open();
    const state = track(h.transport.request('AT+CSQ'));
    await flush();

    h.socket().push('AT+CSQ\r\n+CSQ: 22,99\r\nOK\r\n');
    await flush();

    assert.equal(state.status, 'resolved');
    assert.deepEqual(state.value.lines, ['+CSQ: 22,99']);
    assert.ok(!state.value.lines.includes('AT+CSQ'), '命令回显不得作为响应行');
    assert.ok(!state.value.lines.includes('OK'), 'OK 终止符不得作为响应行');
    assert.equal(state.value.attempts, 1);
    assert.deepEqual(h.transport.urcLog, [], '响应行不得被误记为 URC');
  }
);

/* ------------------------------------------------------------ 6. ERROR 应答 */

withHarness(
  'ERROR 应答：以 COMMAND_ERROR 拒绝，绝不当作数据',
  { config: { retryOnError: false, retries: 1 } },
  async (h) => {
    await h.open();
    const state = track(h.transport.request('AT+CSQ'));
    await flush();

    h.socket().push('AT+CSQ\r\nERROR\r\n');
    await flush();

    assert.equal(state.status, 'rejected');
    assert.ok(state.error instanceof SerialTransportError);
    assert.equal(state.error.code, ERROR_CODES.COMMAND_ERROR);
    assert.equal(state.value, undefined, 'ERROR 不得解析出数据');
    assert.equal(h.transport.stats.commandsSent, 1);
    assert.equal(h.transport.stats.pending, 0);
  }
);

/* ------------------------------------------------------------ 7. retryOnError 需显式开启 */

test('retryOnError 需显式开启：关闭时单次 ERROR 即失败，开启后重发并成功', async (t) => {
  // 关闭（默认）：一次 ERROR 直接拒绝。
  const off = createHarness({ retries: 1, retryDelayMs: 100 });
  t.after(async () => off.cleanup());
  await off.open();
  const failed = track(off.transport.request('AT+CSQ'));
  await flush();
  off.socket().push('AT+CSQ\r\nERROR\r\n');
  await flush();
  assert.equal(failed.status, 'rejected');
  assert.equal(failed.error.code, ERROR_CODES.COMMAND_ERROR);
  assert.equal(off.transport.stats.commandsSent, 1);
  assert.equal(off.events.retry.length, 0, 'retryOnError 关闭时不得重发');
  assert.equal(off.timers.pendingCount(), 0);

  // 开启：重发一次并可成功。
  const on = createHarness({ retries: 1, retryDelayMs: 100, retryOnError: true });
  t.after(async () => on.cleanup());
  await on.open();
  const socket = on.socket();
  const retried = track(on.transport.request('AT+CSQ'));
  await flush();

  socket.push('AT+CSQ\r\nERROR\r\n');
  await flush();
  assert.equal(retried.status, 'pending', '第一次 ERROR 后应等待重发');
  assert.equal(on.transport.stats.commandsSent, 1);
  assert.equal(on.events.retry.length, 1);
  assert.equal(on.events.retry[0].remaining, 0);

  on.timers.advance(100);
  await flush();
  assert.equal(on.transport.stats.commandsSent, 2);
  assert.deepEqual(socket.getWritten(), ['AT+CSQ\r\n', 'AT+CSQ\r\n']);

  socket.push('AT+CSQ\r\n+CSQ: 22,99\r\nOK\r\n');
  await flush();
  assert.equal(retried.status, 'resolved');
  assert.equal(retried.value.attempts, 2);
  assert.deepEqual(retried.value.lines, ['+CSQ: 22,99']);
});

/* ------------------------------------------------------------ 8. 静默超时 */

withHarness(
  '静默命令：COMMAND_TIMEOUT + /timed out/，pending 归零且 timeouts 计数',
  { config: { retries: 0, commandTimeoutMs: 1000 } },
  async (h) => {
    await h.open();
    const state = track(h.transport.request('AT+CSQ'));
    await flush();
    assert.equal(h.transport.stats.pending, 1);
    assert.equal(h.transport.stats.commandsSent, 1);

    h.timers.advance(999);
    await flush();
    assert.equal(state.status, 'pending', '未到超时时间不得结算');

    h.timers.advance(1);
    await flush();
    assert.equal(state.status, 'rejected');
    assert.equal(state.error.code, ERROR_CODES.COMMAND_TIMEOUT);
    assert.match(state.error.message, /timed out/);
    assert.equal(h.transport.stats.pending, 0);
    assert.equal(h.transport.stats.timeouts, 1);
    assert.equal(h.transport.stats.commandsSent, 1);
  }
);

/* ------------------------------------------------------------ 9. 超时重试 */

withHarness(
  '超时按配置次数重试：retries=2 时 commandsSent 1→2→3，最终成功 attempts=3',
  { config: { retries: 2, retryDelayMs: 100, commandTimeoutMs: 1000, quietMs: 250 } },
  async (h) => {
    await h.open();
    const socket = h.socket();
    const state = track(h.transport.request('AT+CSQ'));
    await flush();
    assert.equal(h.transport.stats.commandsSent, 1);

    h.timers.advance(1000);
    await flush();
    assert.equal(h.transport.stats.timeouts, 1);
    assert.equal(h.events.retry.length, 1);
    assert.equal(state.status, 'pending');

    h.timers.advance(100);
    await flush();
    assert.equal(h.transport.stats.commandsSent, 2);

    h.timers.advance(1000);
    await flush();
    assert.equal(h.transport.stats.timeouts, 2);
    assert.equal(h.events.retry.length, 2);
    assert.equal(state.status, 'pending');

    h.timers.advance(100);
    await flush();
    assert.equal(h.transport.stats.commandsSent, 3);
    assert.equal(h.transport.stats.pending, 1);

    socket.push('AT+CSQ\r\n+CSQ: 22,99\r\nOK\r\n');
    await flush();
    assert.equal(state.status, 'resolved');
    assert.equal(state.value.attempts, 3, '三次尝试后成功');
    assert.deepEqual(state.value.lines, ['+CSQ: 22,99']);
    assert.equal(h.events.retry.length, 2, '恰好两次 retry 事件');
    assert.deepEqual(socket.getWritten(), ['AT+CSQ\r\n', 'AT+CSQ\r\n', 'AT+CSQ\r\n']);
  }
);

/* ------------------------------------------------------------ 10. 超时前的部分响应行 */

withHarness(
  '超时仍暴露已到达的部分响应行（error.lines 为主契约，line 事件为辅）',
  { config: { retries: 0, commandTimeoutMs: 1000, quietMs: 0 } },
  async (h) => {
    await h.open();
    // 机制说明：quietMs=0 关闭静默窗口，命令只能靠超时结束；
    // 部分响应行由失败错误对象的 lines 字段承载，同时公共 'line' 事件也会发出。
    const lines = [];
    h.transport.on('line', (line) => lines.push(line));

    const state = track(h.transport.request('AT+CSQ'));
    await flush();
    h.socket().push('AT+CSQ\r\n+CSQ: 22,99\r\n'); // 回显 + 一条响应行，但没有终止符
    await flush();

    assert.deepEqual(lines, ['AT+CSQ', '+CSQ: 22,99'], '部分响应行必须经 line 事件暴露');
    assert.equal(state.status, 'pending');

    h.timers.advance(1000);
    await flush();
    assert.equal(state.status, 'rejected');
    assert.equal(state.error.code, ERROR_CODES.COMMAND_TIMEOUT);
    assert.match(state.error.message, /timed out/);
    // 主契约：失败错误对象直接携带已到达的部分响应行（冻结副本）。
    assert.deepEqual(state.error.lines, ['+CSQ: 22,99']);
    assert.ok(Object.isFrozen(state.error.lines));
    // 辅助契约：部分行没有被丢弃，也没有被误判成 URC。
    assert.deepEqual(lines, ['AT+CSQ', '+CSQ: 22,99']);
    assert.equal(h.transport.urcLog.length, 0);
    assert.equal(state.error.attempts, 1);
    assert.equal(h.transport.stats.pending, 0);
  }
);

/* ------------------------------------------------------------ 11. 严格串行 */

withHarness(
  '严格串行：三条排队命令同一时刻只有一次写入，且写入顺序一致',
  { config: { commandTimeoutMs: 5000, quietMs: 250 } },
  async (h) => {
    await h.open();
    const socket = h.socket();

    const first = track(h.transport.request('AT+CSQ'));
    const second = track(h.transport.request('AT+CREG?'));
    const third = track(h.transport.request('AT+CGMR'));
    await flush();

    assert.deepEqual(socket.getWritten(), ['AT+CSQ\r\n'], '同一时刻只允许一条在途命令');
    assert.equal(h.transport.stats.pending, 1);
    assert.equal(h.transport.stats.queued, 2);

    socket.push('AT+CSQ\r\n+CSQ: 22,99\r\nOK\r\n');
    await flush();
    assert.deepEqual(socket.getWritten(), ['AT+CSQ\r\n', 'AT+CREG?\r\n']);
    assert.equal(first.status, 'resolved');
    assert.equal(second.status, 'pending');

    socket.push('AT+CREG?\r\n+CREG: 1,1\r\nOK\r\n');
    await flush();
    assert.deepEqual(socket.getWritten(), ['AT+CSQ\r\n', 'AT+CREG?\r\n', 'AT+CGMR\r\n']);
    assert.equal(second.status, 'resolved');
    assert.equal(third.status, 'pending');

    socket.push('AT+CGMR\r\nM100MG-B1\r\nOK\r\n');
    await flush();
    assert.equal(third.status, 'resolved');
    assert.deepEqual(third.value.lines, ['M100MG-B1']);
    assert.equal(h.transport.stats.queued, 0);
    assert.equal(h.transport.stats.pending, 0);
  }
);

/* ------------------------------------------------------------ 12. URC 隔离 */

withHarness(
  'URC 分离：主动行只进 urc/urcLog，绝不混入命令响应行',
  { config: { quietMs: 250 } },
  async (h) => {
    await h.open();
    const state = track(h.transport.request('config,get,ssta'));
    await flush();

    h.socket().push('RING\r\nconfig,get,ssta\r\nconfig,ssta,ok,3\r\nNO CARRIER\r\n');
    await flush();
    h.timers.advance(250);
    await flush();

    assert.equal(state.status, 'resolved');
    assert.deepEqual(state.value.lines, ['config,ssta,ok,3']);
    assert.deepEqual(h.events.urc, ['RING', 'NO CARRIER']);
    assert.deepEqual(h.transport.urcLog, ['RING', 'NO CARRIER']);
    assert.equal(h.transport.stats.urcCount, 2);
  }
);

/* ------------------------------------------------------------ 13. URC 与响应消歧 */

withHarness(
  '消歧：无在途命令时 +CREG 是 URC，有在途命令时 +CSQ 是响应且 OK 不入 lines',
  { config: { quietMs: 250 } },
  async (h) => {
    await h.open();

    // 无在途命令 -> +CREG: 1,1 是 URC。
    h.socket().push('+CREG: 1,1\r\n');
    await flush();
    assert.deepEqual(h.events.urc, ['+CREG: 1,1']);
    assert.equal(h.transport.urcLog.length, 1);

    // 有在途命令 -> +CSQ: 22,99 是响应。
    const state = track(h.transport.request('AT+CSQ'));
    await flush();
    h.socket().push('AT+CSQ\r\n+CSQ: 22,99\r\nOK\r\n');
    await flush();

    assert.equal(state.status, 'resolved');
    assert.deepEqual(state.value.lines, ['+CSQ: 22,99']);
    assert.deepEqual(h.events.urc, ['+CREG: 1,1'], '响应行不得被追加为 URC');
    assert.equal(h.transport.urcLog.length, 1);
  }
);

/* ------------------------------------------------------------ 14. 命令在途掉线 */

withHarness(
  '命令在途掉线：以 DISCONNECTED 拒绝，安排带退避的重连，重连待命期间继续排队',
  { config: { commandTimeoutMs: 5000, reconnectDelayMs: 100, reconnectMaxDelayMs: 400 } },
  async (h) => {
    await h.open();
    const state = track(h.transport.request('AT+CSQ'));
    await flush();

    h.socket().dropConnection(Object.assign(new Error('device unplugged'), { code: 'EIO' }));
    await flush();

    assert.equal(state.status, 'rejected');
    assert.equal(state.error.code, ERROR_CODES.DISCONNECTED);
    assert.equal(h.transport.isOpen, false);
    assert.equal(h.transport.stats.pending, 0);
    assert.equal(h.transport.stats.reconnectScheduled, true);
    assert.equal(h.events.disconnected.length, 1);
    assert.equal(h.events.scheduled.length, 1);
    assert.equal(h.events.scheduled[0].delayMs, 100);
    assert.equal(h.events.scheduled[0].attempt, 1);
    // 调用方监听器必须收到 socket 错误（DISCONNECTED）。
    assert.ok(h.errors.some((error) => error.code === ERROR_CODES.DISCONNECTED));

    // 已排期自动重连时，请求按设计继续排队（重连成功后发送），不报 NOT_OPEN。
    const queuedDuringReconnect = track(h.transport.request('AT+CREG?'));
    await flush();
    assert.equal(queuedDuringReconnect.status, 'pending');
    assert.equal(queuedDuringReconnect.error, undefined);
    assert.equal(h.transport.stats.queued, 1);
  }
);

/* ------------------------------------------------------------ 15. 指数退避且封顶 */

withHarness(
  '重连指数退避并被 reconnectMaxDelayMs 封顶：100,200,400,400',
  {
    config: { reconnectDelayMs: 100, reconnectMaxDelayMs: 400, reconnectMaxAttempts: 10 },
    factory: {
      openFailures: [
        null, // 首次 open 成功
        Object.assign(new Error('reopen 1 failed'), { code: 'ENOENT' }),
        Object.assign(new Error('reopen 2 failed'), { code: 'ENOENT' }),
        Object.assign(new Error('reopen 3 failed'), { code: 'ENOENT' })
      ]
    }
  },
  async (h) => {
    await h.open();
    assert.equal(h.factory.sockets.length, 1);

    // 空闲掉线 -> 第一次重连排期。
    h.socket().dropConnection(Object.assign(new Error('drop'), { code: 'EIO' }));
    await flush();
    const delays = () => h.events.scheduled.map((payload) => payload.delayMs);
    assert.deepEqual(delays(), [100]);

    h.timers.advance(100);
    await flush();
    assert.deepEqual(delays(), [100, 200]);

    h.timers.advance(200);
    await flush();
    assert.deepEqual(delays(), [100, 200, 400]);

    h.timers.advance(400);
    await flush();
    assert.deepEqual(delays(), [100, 200, 400, 400], '超过上限后必须封顶在 400');

    assert.equal(h.factory.sockets.length, 4, '1 次初始 + 3 次重连尝试');
    assert.equal(h.events.failed.length, 3);
    assert.equal(h.transport.stats.reconnectAttempts, 3);
  }
);

/* ------------------------------------------------------------ 16. disconnect 清场且不再重连 */

withHarness(
  'disconnect：清空全部定时器、以 CLOSED 拒绝在途与排队、此后永不重连',
  {
    config: {
      commandTimeoutMs: 5000,
      quietMs: 250,
      retries: 2,
      retryDelayMs: 100,
      reconnectDelayMs: 100,
      reconnectMaxDelayMs: 400
    }
  },
  async (h) => {
    await h.open();
    const inflight = track(h.transport.request('AT+CSQ'));
    const queuedFirst = track(h.transport.request('AT+CREG?'));
    const queuedSecond = track(h.transport.request('AT+CGMR'));
    await flush();
    assert.equal(h.transport.stats.pending, 1);
    assert.equal(h.transport.stats.queued, 2);
    const socketsBefore = h.factory.sockets.length;

    await h.transport.disconnect();
    await flush();
    h.timers.advance(0); // _safeCloseSocket 的 0ms 兜底定时器
    await flush();

    for (const [label, state] of [
      ['在途命令', inflight],
      ['排队命令#1', queuedFirst],
      ['排队命令#2', queuedSecond]
    ]) {
      assert.equal(state.status, 'rejected', `${label} 必须被拒绝`);
      assert.equal(state.error.code, ERROR_CODES.CLOSED, `${label} 错误码必须是 CLOSED`);
    }
    assert.equal(h.transport.isOpen, false);
    assert.equal(h.transport.stats.closedByUser, true);
    assert.equal(h.transport.stats.pending, 0);
    assert.equal(h.transport.stats.queued, 0);
    assert.equal(h.transport.stats.reconnectScheduled, false);
    assert.equal(h.transport.stats.retryScheduled, false);
    assert.equal(h.timers.pendingCount(), 0, 'disconnect 后不得残留任何定时器');

    // 主动关闭后永不再重连：推进远超退避上限的虚拟时间。
    h.timers.advance(60000);
    await flush();
    assert.equal(h.factory.sockets.length, socketsBefore, 'disconnect 后不得再创建 socket');
    assert.equal(h.events.scheduled.length, 0);
    assert.equal(h.timers.pendingCount(), 0);

    // 关闭后的新请求快速失败为 CLOSED。
    const afterClosed = track(h.transport.request('AT+CSQ'));
    await flush();
    assert.equal(afterClosed.status, 'rejected');
    assert.equal(afterClosed.error.code, ERROR_CODES.CLOSED);
  }
);

/* ------------------------------------------------------------ 17. listen */

withHarness(
  'listen：在有时限的窗口内收集行，到期后移除 line 监听并清掉定时器',
  { config: { quietMs: 250 } },
  async (h) => {
    await h.open();
    // 以本用例开始时的监听器数量为基线（harness 自己挂了 'closed' 监听器）。
    const lineListenersBefore = h.transport.listenerCount('line');
    const closedListenersBefore = h.transport.listenerCount('closed');
    assert.equal(lineListenersBefore, 0);

    const collecting = track(h.transport.listen(500));
    await flush();
    assert.equal(h.transport.listenerCount('line'), 1, 'listen 期间必须挂上 line 监听');
    assert.equal(h.timers.pendingCount(), 1);

    h.socket().push('RING\r\nNO CARRIER\r\n');
    await flush();
    assert.equal(collecting.status, 'pending');

    h.timers.advance(499);
    await flush();
    assert.equal(collecting.status, 'pending', '到期前不得结算');

    h.timers.advance(1);
    await flush();
    assert.equal(collecting.status, 'resolved');
    assert.deepEqual(collecting.value, ['RING', 'NO CARRIER']);
    assert.equal(
      h.transport.listenerCount('line'),
      lineListenersBefore,
      'listen 结束后必须移除 line 监听'
    );
    assert.equal(h.transport.listenerCount('closed'), closedListenersBefore);
    assert.equal(h.timers.pendingCount(), 0, 'listen 结束后必须清掉定时器');

    const bad = track(h.transport.listen(0));
    await flush();
    assert.equal(bad.status, 'rejected');
    assert.equal(bad.error.code, ERROR_CODES.COMMAND_ERROR);
  }
);

/* ------------------------------------------------------------ 18. 超长输入有界 */

withHarness(
  '超长无换行输入：按 maxBufferBytes / 行长度有界，不无限缓冲',
  { config: { maxBufferBytes: 128, quietMs: 250 } },
  async (h) => {
    await h.open();
    const seen = [];
    h.transport.on('line', (line) => seen.push(line));
    const socket = h.socket();

    socket.push('X'.repeat(4096)); // 远超 maxBufferBytes 且无换行
    await flush();

    assert.equal(h.transport.stats.bufferedBytes, 0, '超长行必须被强制消费，不能无限缓冲');
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'X'.repeat(512), '行长度必须有界（512 字节上限）');
    assert.ok(seen[0].length <= 512);

    socket.push('Y'.repeat(64)); // 未超阈值：缓冲区保持有界
    await flush();
    assert.equal(h.transport.stats.bufferedBytes, 64);
    assert.ok(h.transport.stats.bufferedBytes <= 128);
    assert.equal(seen.length, 1, '无换行时不应产出新行');
  }
);

/* ------------------------------------------------------------ 19. 未打开 / 空命令快速失败 */

withHarness('未打开时请求快速失败 NOT_OPEN；空命令快速失败 COMMAND_ERROR', {}, async (h) => {
  const notOpen = track(h.transport.request('AT+CSQ'));
  await flush();
  assert.equal(notOpen.status, 'rejected', '未打开时请求必须快速失败，不能排队等待');
  assert.ok(notOpen.error instanceof SerialTransportError);
  assert.equal(notOpen.error.code, ERROR_CODES.NOT_OPEN);
  assert.equal(h.transport.stats.queued, 0);

  const blank = track(h.transport.request('   '));
  await flush();
  assert.equal(blank.status, 'rejected');
  assert.equal(blank.error.code, ERROR_CODES.COMMAND_ERROR);

  const missing = track(h.transport.request(undefined));
  await flush();
  assert.equal(missing.status, 'rejected');
  assert.equal(missing.error.code, ERROR_CODES.COMMAND_ERROR);
});

/* ------------------------------------------------------------ 20. 调用方 error 监听回归护栏 */

withHarness(
  'socket 错误事件必须送达调用方安装的 error 监听器（SERIAL_DISCONNECTED）',
  { config: { commandTimeoutMs: 5000, reconnectDelayMs: 100000 } },
  async (h) => {
    await h.open();
    const received = [];
    h.transport.on('error', (error) => received.push(error));

    h.socket().emit('error', Object.assign(new Error('io failure'), { code: 'EIO' }));
    await flush();

    assert.equal(h.errors.length, 1, '辅助监听器必须收到一次 error');
    assert.ok(h.errors[0] instanceof SerialTransportError);
    assert.equal(h.errors[0].code, ERROR_CODES.DISCONNECTED);
    assert.equal(received.length, 1, '调用方监听器不得被内部兜底监听器吞掉');
    assert.equal(received[0].code, ERROR_CODES.DISCONNECTED);
  }
);
