'use strict';

/**
 * tests/subscribe.test.js — 微信订阅消息授权链路的确定性测试
 *
 * 覆盖：
 *   - 用户接受 / 用户拒绝 / 用户禁用（ban）/ 未配置模板 / 能力不可用 / 请求失败；
 *   - 未配置时**绝不**调用 wx.requestSubscribeMessage；
 *   - 只在用户点击后调用（唯一调用点是告警页的按钮处理函数）；
 *   - 传入的 tmplIds 必须等于配置的模板 ID，且不使用假默认模板；
 *   - 页面加载不会请求授权，只读取「是否已配置」用于渲染。
 *
 * 全程使用 wx 打桩，不连接微信、不使用真实 AppID/AppSecret/openid。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

/* ------------------------------------------------------------ wx 打桩 */

const calls = []
const grantCalls = []
let nextImplementation = null
let lastToasts = []
let grantImplementation = null

global.wx = {
  getStorageSync() { return { apiBaseUrl: 'https://trusted.example.com', demoMode: false } },
  setStorageSync() {},
  requestSubscribeMessage(options) {
    calls.push(options)
    if (nextImplementation) {
      const run = nextImplementation
      nextImplementation = null
      run(options)
      return
    }
    options.success({})
  },
  request(options) {
    grantCalls.push(options)
    if (grantImplementation) {
      const run = grantImplementation
      grantImplementation = null
      run(options)
      return
    }
    options.success({ statusCode: 200, data: { accepted: true, duplicate: false, remaining: 1 } })
  },
  showToast(options) { lastToasts.push(options) }
}

function resetWx() {
  calls.length = 0
  grantCalls.length = 0
  lastToasts = []
  nextImplementation = null
  grantImplementation = null
}

/* ------------------------------------------------------------ 被测模块 */

const subscribeConfig = require('../config/subscribe')
const subscribe = require('../services/subscribe')
const { requestAlarmSubscribe, isConfigured } = subscribe
const api = require('../services/api')

/**
 * 用指定模板 ID 运行一个用例。
 * 占位或非法值会被规范化为空串，从而真实模拟"未配置"的生产状态。
 */
async function withTemplateId(templateId, action) {
  resetWx()
  api.clearSession()
  const normalized = subscribeConfig.isValidTemplateId(templateId) ? String(templateId) : ''
  subscribe.setTemplateIdForTest(normalized)
  try {
    return await action()
  } finally {
    subscribe.setTemplateIdForTest(null)
  }
}

/* ------------------------------------------------------------ 配置判定 */

test('the shipped config is a placeholder and therefore NOT configured', () => {
  assert.equal(subscribeConfig.isValidTemplateId(subscribeConfig.SUBSCRIBE_TEMPLATE_ID), false)
  assert.equal(subscribeConfig.isSubscribeConfigured(), false)
  assert.equal(subscribeConfig.isValidTemplateId('REPLACE_WITH_WECHAT_SUBSCRIBE_TEMPLATE_ID'), false)
  assert.equal(subscribeConfig.isValidTemplateId(''), false)
  assert.equal(subscribeConfig.isValidTemplateId('   '), false)
  assert.equal(subscribeConfig.isValidTemplateId('x'.repeat(65)), false)
  assert.equal(subscribeConfig.isValidTemplateId('bad id with spaces'), false)
  assert.equal(subscribeConfig.isValidTemplateId('4001234567890123456789012345678901'), true)
})

test('isConfigured follows the injected template id, not a fake default', () => {
  try {
    subscribe.setTemplateIdForTest('TEMPLATE_REAL_123')
    assert.equal(isConfigured(), true)
    assert.equal(subscribe.getTemplateId(), 'TEMPLATE_REAL_123')
    subscribe.setTemplateIdForTest('')
    assert.equal(isConfigured(), false)
  } finally {
    subscribe.setTemplateIdForTest(null)
  }
})

/* ------------------------------------------------------------ 未配置 */

test('an unconfigured template never calls the WeChat API', async () => {
  await withTemplateId('', async () => {
    const result = await requestAlarmSubscribe()
    assert.equal(result.configured, false)
    assert.equal(result.accepted, false)
    assert.equal(result.reason, 'not_configured')
    assert.equal(calls.length, 0, '未配置时绝不能调用 wx.requestSubscribeMessage')
  })
})

test('a placeholder template id is treated as unconfigured', async () => {
  await withTemplateId('REPLACE_WITH_WECHAT_SUBSCRIBE_TEMPLATE_ID', async () => {
    const result = await requestAlarmSubscribe()
    assert.equal(result.configured, false)
    assert.equal(result.reason, 'not_configured')
    assert.equal(calls.length, 0)
  })
})

/* ------------------------------------------------------------ 用户接受 */

test('the user accepts: the API is called once and the grant is registered with the backend', async () => {
  await withTemplateId('TEMPLATE_ACCEPT_1', async () => {
    nextImplementation = (options) => {
      assert.deepEqual(options.tmplIds, ['TEMPLATE_ACCEPT_1'])
      options.success({ TEMPLATE_ACCEPT_1: 'accept' })
    }
    const result = await requestAlarmSubscribe()
    assert.equal(calls.length, 1)
    assert.equal(result.ok, true)
    assert.equal(result.accepted, true)
    assert.equal(result.configured, true)
    assert.equal(result.registered, true, '用户接受后必须把授权登记到后端');
    assert.equal(result.reason, 'accepted')
    assert.equal(result.status, 'accepted')
    // 一次性订阅文案：只说"下一次"，不说长期"已开启"。
    assert.equal(result.message, '已订阅下一次告警通知')

    // 登记请求必须打到登记接口，且**不得**提交 openid。
    assert.equal(grantCalls.length, 1, '授权成功后必须恰好登记一次')
    assert.match(grantCalls[0].url, /\/api\/v1\/notifications\/subscription$/)
    assert.equal(grantCalls[0].method, 'POST')
    assert.equal(Object.prototype.hasOwnProperty.call(grantCalls[0].data, 'openid'), false, '客户端绝不能提交 openid')
    assert.equal(grantCalls[0].data.templateId, 'TEMPLATE_ACCEPT_1')
    assert.match(String(grantCalls[0].data.grantEventId), /^grant-[a-z0-9]+-[a-z0-9]+$/)
  })
})

test('acceptWithAudio also counts as accepted and is registered', async () => {
  await withTemplateId('TEMPLATE_ACCEPT_2', async () => {
    nextImplementation = (options) => options.success({ TEMPLATE_ACCEPT_2: 'acceptWithAudio' })
    const result = await requestAlarmSubscribe()
    assert.equal(result.accepted, true)
    assert.equal(result.registered, true)
    assert.equal(grantCalls.length, 1)
  })
})

/* ------------------------------------------------------------ 用户拒绝 */

test('the user rejects: no throw, a readable message, and NO backend registration', async () => {
  await withTemplateId('TEMPLATE_REJECT_1', async () => {
    nextImplementation = (options) => options.success({ TEMPLATE_REJECT_1: 'reject' })
    const result = await requestAlarmSubscribe()
    assert.equal(result.ok, true)
    assert.equal(result.accepted, false)
    assert.equal(result.registered, false)
    assert.equal(result.reason, 'declined')
    assert.equal(result.status, 'rejected')
    assert.match(result.message, /不接收/)
    assert.equal(calls.length, 1, '拒绝后不得自动重试')
    assert.equal(grantCalls.length, 0, 'reject 绝不能登记授权')
  })
})

test('a banned authorization is reported distinctly and is never registered', async () => {
  await withTemplateId('TEMPLATE_BAN_1', async () => {
    nextImplementation = (options) => options.success({ TEMPLATE_BAN_1: 'ban' })
    const result = await requestAlarmSubscribe()
    assert.equal(result.accepted, false)
    assert.equal(result.registered, false)
    assert.equal(result.status, 'rejected')
    assert.match(result.message, /设置/)
    assert.equal(grantCalls.length, 0, 'ban 绝不能登记授权')
  })
})

test('an authorization that succeeds but fails to register is NOT reported as fully enabled', async () => {
  await withTemplateId('TEMPLATE_PARTIAL_1', async () => {
    nextImplementation = (options) => options.success({ TEMPLATE_PARTIAL_1: 'accept' })
    grantImplementation = (options) => options.fail({ errMsg: 'request:fail timeout' })

    const result = await requestAlarmSubscribe()
    assert.equal(result.accepted, true, '微信侧授权确实成功了')
    assert.equal(result.registered, false, '但后端登记失败')
    assert.equal(result.reason, 'register_failed')
    assert.match(result.message, /登记未成功/)
    assert.equal(
      /已订阅|已开启/.test(result.message), false,
      '登记失败时绝不能显示成完全成功'
    )
    assert.equal(grantCalls.length, 1, '仍然尝试过一次登记')
  })
})

test('a rejected registration (401/403) is surfaced accurately', async () => {
  await withTemplateId('TEMPLATE_PARTIAL_2', async () => {
    nextImplementation = (options) => options.success({ TEMPLATE_PARTIAL_2: 'accept' })
    grantImplementation = (options) => options.success({ statusCode: 403, data: { error: 'forbidden' } })

    const result = await requestAlarmSubscribe()
    assert.equal(result.accepted, true)
    assert.equal(result.registered, false)
    assert.equal(result.registerReason, 'unauthorized')
  })
})

/* ------------------------------------------------------------ 异常路径 */

test('a failed request resolves with an error result instead of throwing', async () => {
  await withTemplateId('TEMPLATE_FAIL_1', async () => {
    nextImplementation = (options) => options.fail({ errMsg: 'requestSubscribeMessage:fail network' })
    const result = await requestAlarmSubscribe()
    assert.equal(result.ok, false)
    assert.equal(result.accepted, false)
    assert.equal(result.reason, 'failed')
    assert.equal(result.status, 'error')
  })
})

test('a cancelled request is reported as cancelled', async () => {
  await withTemplateId('TEMPLATE_CANCEL_1', async () => {
    nextImplementation = (options) => options.fail({ errMsg: 'requestSubscribeMessage:fail cancel' })
    const result = await requestAlarmSubscribe()
    assert.equal(result.reason, 'cancelled')
  })
})

test('an unsupported WeChat client is reported without calling anything', async () => {
  const original = global.wx.requestSubscribeMessage
  delete global.wx.requestSubscribeMessage
  try {
    await withTemplateId('TEMPLATE_UNSUPPORTED_1', async () => {
      const result = await requestAlarmSubscribe()
      assert.equal(result.configured, true)
      assert.equal(result.reason, 'unsupported')
      assert.equal(calls.length, 0)
    })
  } finally {
    global.wx.requestSubscribeMessage = original
  }
})

test('a malformed success payload is not treated as acceptance', async () => {
  await withTemplateId('TEMPLATE_MALFORMED_1', async () => {
    nextImplementation = (options) => options.success(undefined)
    const result = await requestAlarmSubscribe()
    assert.equal(result.accepted, false)
    assert.equal(result.status, 'unknown')
  })
})

/* ------------------------------------------------------------ 结果求值 */

test('evaluateSubscribeResult only accepts the documented accept statuses', () => {
  assert.deepEqual(subscribe.evaluateSubscribeResult({ T: 'accept' }, 'T'), { accepted: true, status: 'accept' })
  assert.deepEqual(subscribe.evaluateSubscribeResult({ T: 'reject' }, 'T'), { accepted: false, status: 'reject' })
  assert.deepEqual(subscribe.evaluateSubscribeResult({}, 'T'), { accepted: false, status: 'unknown' })
  assert.deepEqual(subscribe.evaluateSubscribeResult(null, 'T'), { accepted: false, status: 'unknown' })
  // 其他模板的结果不得被误判成本模板已接受。
  assert.equal(subscribe.evaluateSubscribeResult({ OTHER: 'accept' }, 'T').accepted, false)
})

/* ------------------------------------------------------------ 唯一调用点（源码守卫） */

test('the ONLY wx.requestSubscribeMessage call site is the alarms-page button handler', () => {
  const sourceFiles = []
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'tests') collect(full)
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        sourceFiles.push(full)
      }
    }
  }
  collect(ROOT)

  // 只看**真实调用**（wx.requestSubscribeMessage 后面紧跟 `(`），
  // 注释与文档里提到这个 API 名字不算调用点。
  const callSites = sourceFiles.filter((file) => /wx\s*\.\s*requestSubscribeMessage\s*\(/.test(fs.readFileSync(file, 'utf8')))
  assert.deepEqual(
    callSites.map((file) => path.relative(ROOT, file).replace(/\\/g, '/')),
    ['services/subscribe.js'],
    'wx.requestSubscribeMessage 只能被 services/subscribe.js 真正调用'
  )

  // 页面必须在按钮处理函数里调用服务，而不是在生命周期里请求授权。
  const pageSource = fs.readFileSync(path.join(ROOT, 'pages/alarms/index.js'), 'utf8')
  assert.match(pageSource, /onRequestSubscribe\s*\(/, '页面必须提供按钮处理函数')
  assert.match(pageSource, /await requestAlarmSubscribe\(\)/, '按钮处理函数必须调用订阅服务')
  assert.equal(
    /onLoad\s*\([^)]*\)\s*\{[^}]*requestAlarmSubscribe/.test(pageSource),
    false,
    'onLoad 绝不能请求订阅授权'
  )
  assert.equal(
    /onShow\s*\([^)]*\)\s*\{[^}]*requestAlarmSubscribe/.test(pageSource),
    false,
    'onShow 绝不能请求订阅授权'
  )

  const markup = fs.readFileSync(path.join(ROOT, 'pages/alarms/index.wxml'), 'utf8')
  assert.match(markup, /bindtap="onRequestSubscribe"/, '必须由用户点击按钮触发')
  assert.match(markup, /subscribeConfigured/, '未配置状态必须对用户可见')
  assert.match(markup, /订阅消息未配置/, '未配置必须有明确文案')
})

test('no miniprogram file assigns an AppSecret or access_token value', () => {
  const offenders = []
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'tests') collect(full)
      } else if (entry.isFile() && /\.(js|json|wxml|wxss)$/.test(entry.name)) {
        const content = fs.readFileSync(full, 'utf8')
        const relative = path.relative(ROOT, full).replace(/\\/g, '/')
        // 只把"赋值了非空字面量"当作泄漏；注释里提到字段名不算。
        if (/\b(app_?secret|access_?token|session_?key)\b\s*[:=]\s*['"][^'"]+['"]/i.test(content)) offenders.push(relative)
      }
    }
  }
  collect(ROOT)
  assert.deepEqual(offenders, [], '小程序文件不得给 AppSecret/access_token 赋值')
})
