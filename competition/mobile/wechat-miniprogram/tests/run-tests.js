const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let storedSettings = { apiBaseUrl: '', demoMode: false }
const calls = []
const downloadCalls = []
const downloadStatusQueue = []
const failedPaths = new Set()
const forcedStatusByPath = new Map()

global.getApp = () => ({ globalData: { settings: storedSettings } })
global.wx = {
  getStorageSync() { return storedSettings },
  setStorageSync(key, value) { storedSettings = value },
  login(options) { options.success({ code: 'single-use-wechat-code' }) },
  request(options) {
    calls.push(options)
    const pathname = new URL(options.url).pathname
    if (failedPaths.has(pathname)) {
      options.fail({ errMsg: 'request:fail timeout' })
      return
    }
    if (forcedStatusByPath.has(pathname)) {
      options.success({ statusCode: forcedStatusByPath.get(pathname), data: {} })
      return
    }
    const payloads = {
      '/api/v1/auth/wechat': { sessionToken: 'runtime-session-token-12345', expiresIn: 3600 },
      '/api/v1/overview': { overview: { generatedAt: 1791609000123, residentName: '测试住户' } },
      '/api/v1/rooms': { rooms: [{ id: 'bath', name: '卫生间', state: 'ALARM', deviceCount: 1, onlineDeviceCount: 1 }] },
      '/api/v1/alerts': { alerts: [{ id: 'alarm:001', deviceId: 'esp32-bath', roomName: '卫生间', type: 'FALL', message: '测试告警', state: 'ALARM', createdAt: 1791609000123, evidence: { available: true, evidenceId: 'fall-1791609000123-7', bytes: 1234, capturedAt: 1791609000123 } }] },
      '/api/v1/devices': { devices: [{ id: 'esp32-bath', name: '节点', roomId: 'bath', roomName: '卫生间', online: true, monitorOnline: 0, state: 'ALARM', lastSeenTs: 1791609000123, sensors: { motion: { countToday: 3 }, door: { open: false }, climate: { tempC: 24.6, rh: 41.2 }, gas: { ok: true }, smoke: { ok: false } } }] },
      '/api/v1/location': { locations: [{ deviceId: 'esp32-bath', location: '门口上方' }] },
      '/api/v1/contacts': { contacts: [{ id: 'c1', name: '家属', relation: '女儿', phone: '13800000000', primary: true }] },
      '/api/v1/alerts/alarm%3A001/ack': { accepted: true, status: 'PENDING', commandId: '1' }
    }
    const data = payloads[pathname]
    if (!data) return options.success({ statusCode: 404, data: {} })
    options.success({ statusCode: 200, data })
  },
  downloadFile(options) {
    downloadCalls.push(options)
    const statusCode = downloadStatusQueue.length ? downloadStatusQueue.shift() : 200
    options.success({ statusCode, tempFilePath: statusCode === 200 ? 'wxfile://tmp/fall.jpg' : '' })
  }
}

const { normalizeBaseUrl, saveSettings } = require('../utils/settings')
const { normalizeDashboard, summarizeDashboard, validateAckInput } = require('../utils/validators')
const { monitorView, sensorRows } = require('../utils/format')
const { DEMO_DASHBOARD } = require('../data/demo')
const api = require('../services/api')
const eldercare = require('../services/eldercare')

async function rejects(action, pattern) {
  let error
  try { await action() } catch (caught) { error = caught }
  assert(error, 'Expected action to reject')
  assert(pattern.test(error.message), `Unexpected error: ${error.message}`)
}

async function run() {
  assert.strictEqual(normalizeBaseUrl('https://api.example.com/'), 'https://api.example.com')
  assert.throws(() => normalizeBaseUrl('http://api.example.com'), /HTTPS/)
  assert.throws(() => normalizeBaseUrl('https://user:pass@example.com'), /凭据/)
  assert.throws(() => normalizeBaseUrl('https://api.example.com?token=secret'), /查询参数/)

  const demo = normalizeDashboard(DEMO_DASHBOARD)
  assert.strictEqual(demo.rooms.length, 2)
  assert.strictEqual(demo.alarms[0].id, 'demo-alarm-001')
  assert(/演示/.test(demo.residentName))

  const dirty = normalizeDashboard({
    devices: [
      { id: 'valid-device', online: true, state: 'INVALID' },
      { id: 'bad device id', online: true, state: 'NORMAL' }
    ],
    contacts: [{ id: 'c1', name: 'A', phone: 'not-a-number' }]
  })
  assert.strictEqual(dirty.devices.length, 1)
  assert.strictEqual(dirty.devices[0].state, 'OFFLINE')
  assert.strictEqual(dirty.devices[0].monitorOnline, -1)
  assert.strictEqual(normalizeDashboard({ devices: [{ id: 'strict-monitor', online: true, state: 'NORMAL', monitorOnline: '0' }] }).devices[0].monitorOnline, -1)
  assert.strictEqual(dirty.contacts.length, 0)
  assert.deepStrictEqual(monitorView(1), { text: '监护在线', className: 'monitor-online' })
  assert.deepStrictEqual(monitorView(0), { text: '监护失联', className: 'monitor-offline' })
  assert.deepStrictEqual(monitorView(-1), { text: '监护未启用', className: 'monitor-disabled' })
  assert.deepStrictEqual(sensorRows({
    motion: { countToday: 3 }, door: { open: false }, climate: { tempC: 24.6, rh: 41.2 },
    gas: { ok: true }, smoke: { ok: false }
  }), [
    { key: 'motion', label: '人体活动', value: '今日 3 次', alert: false },
    { key: 'door', label: '门磁', value: '已关闭', alert: false },
    { key: 'climate', label: '温湿度', value: '24.6℃ / 41.2% RH', alert: false },
    { key: 'gas', label: '燃气', value: '正常', alert: false },
    { key: 'smoke', label: '烟雾', value: '异常', alert: true }
  ])
  assert.deepStrictEqual(sensorRows(null), [])
  assert.deepStrictEqual(sensorRows({ climate: { tempC: '24.6', rh: null } }), [])
  assert.deepStrictEqual(summarizeDashboard({
    rooms: [{ id: 'r1' }],
    devices: [{ online: true, monitorOnline: 0 }, { online: true, monitorOnline: -1 }],
    alarms: [{ state: 'ALARM' }, { state: 'ACKED' }]
  }), { roomCount: 1, onlineCount: 2, alarmCount: 1, monitorOfflineCount: 1 })

  const pendingDashboard = normalizeDashboard({
    alarms: [{ id: 'pending-1', deviceId: 'esp32-bath', state: 'ALARM', ackPending: true }]
  })
  assert.strictEqual(pendingDashboard.alarms[0].ackPending, true)

  const safeEvidence = normalizeDashboard({
    alarms: [{ id: 'fall-1', deviceId: 'dayu200-living', state: 'ALARM', evidence: {
      available: true,
      evidenceId: 'fall-1791609000123-na',
      url: 'https://evil.example/steal.jpg'
    } }]
  }).alarms[0]
  assert.strictEqual(safeEvidence.evidence.available, true)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(safeEvidence.evidence, 'url'), false)
  const invalidEvidence = normalizeDashboard({
    alarms: [{ id: 'fall-2', deviceId: 'dayu200-living', state: 'ALARM', evidence: {
      available: true, evidenceId: '../../escape'
    } }]
  }).alarms[0]
  assert.strictEqual(invalidEvidence.evidence.available, false)

  assert.deepStrictEqual(validateAckInput('alarm:001', '已确认\r\n安全'), { id: 'alarm:001', note: '已确认  安全' })
  assert.throws(() => validateAckInput('../alarm', 'ok'), /告警编号无效/)
  assert.throws(() => validateAckInput('alarm-1', ''), /处置说明/)

  await rejects(() => api.request({ path: '/api/v1/overview' }), /云端未配置/)

  saveSettings({ apiBaseUrl: 'https://trusted.example.com', demoMode: false })
  const dashboard = await eldercare.fetchDashboard()
  assert.strictEqual(dashboard.residentName, '测试住户')
  assert.strictEqual(dashboard.devices[0].location, '门口上方')
  assert.strictEqual(dashboard.devices[0].monitorOnline, 0)
  assert.strictEqual(dashboard.devices[0].sensors.smoke.ok, false)
  assert.strictEqual(dashboard.alarms[0].state, 'ALARM')
  assert.strictEqual(dashboard.alarms[0].evidence.available, true)

  failedPaths.add('/api/v1/contacts')
  const partialDashboard = await eldercare.fetchDashboard()
  failedPaths.delete('/api/v1/contacts')
  assert.strictEqual(partialDashboard.devices.length, 1)
  assert.strictEqual(partialDashboard.contacts.length, 0)
  assert(/联系人/.test(partialDashboard.partialError))

  const authCall = calls.find(call => call.url.endsWith('/api/v1/auth/wechat'))
  assert(authCall, '微信认证端点未调用')
  assert.strictEqual(calls.filter(call => call.url.endsWith('/api/v1/auth/wechat')).length, 1, '并行 API 请求必须共用一次认证')
  assert.strictEqual(authCall.data.code, 'single-use-wechat-code')
  assert(!authCall.header.Authorization, '登录请求不应带会话令牌')

  const overviewCall = calls.find(call => call.url.endsWith('/api/v1/overview'))
  assert.strictEqual(overviewCall.header.Authorization, 'Bearer runtime-session-token-12345')
  assert(calls.every(call => call.url.startsWith('https://trusted.example.com/')))

  const ack = await eldercare.acknowledgeAlarm('alarm:001', '已电话确认')
  assert.strictEqual(ack.pending, true)
  assert.strictEqual(ack.commandId, '1')
  const ackCall = calls.find(call => call.url.includes('/api/v1/alerts/alarm%3A001/ack'))
  assert.strictEqual(ackCall.method, 'POST')
  assert.deepStrictEqual(ackCall.data, { note: '已电话确认' })

  const evidencePath = await eldercare.downloadAlarmEvidence('alarm:001')
  assert.strictEqual(evidencePath, 'wxfile://tmp/fall.jpg')
  const evidenceDownload = downloadCalls.at(-1)
  assert.strictEqual(evidenceDownload.url, 'https://trusted.example.com/api/v1/alerts/alarm%3A001/evidence/content')
  assert.strictEqual(evidenceDownload.header.Authorization, 'Bearer runtime-session-token-12345')
  assert(!/[?&](?:token|authorization)=/i.test(evidenceDownload.url), '会话令牌不得进入 URL')

  api.clearSession()
  downloadStatusQueue.push(401, 200)
  const beforeRetry = downloadCalls.length
  assert.strictEqual(await eldercare.downloadAlarmEvidence('alarm:001'), 'wxfile://tmp/fall.jpg')
  assert.strictEqual(downloadCalls.length - beforeRetry, 2, '401 只能重新认证并重试一次')
  await rejects(() => eldercare.downloadAlarmEvidence('../bad'), /告警编号无效/)

  downloadStatusQueue.push(401, 401)
  const beforeFailedRetry = downloadCalls.length
  await rejects(() => eldercare.downloadAlarmEvidence('alarm:001'), /401/)
  assert.strictEqual(downloadCalls.length - beforeFailedRetry, 2, '不能无限重认证下载')
  downloadStatusQueue.push(403)
  const beforeForbidden = downloadCalls.length
  await rejects(() => eldercare.downloadAlarmEvidence('alarm:001'), /未获监护授权/)
  assert.strictEqual(downloadCalls.length - beforeForbidden, 1, '403 不得降级为公开图片链接')

  let previewed
  global.Page = definition => { global.alarmPageDefinition = definition }
  wx.previewImage = options => { previewed = options; options.success({}) }
  wx.showToast = options => { throw new Error(`Unexpected toast: ${options.title}`) }
  require('../pages/alarms/index')
  const page = {
    ...global.alarmPageDefinition,
    data: { ...global.alarmPageDefinition.data, mode: 'connected' },
    setData(value) { Object.assign(this.data, value) }
  }
  await page.previewEvidence({ currentTarget: { dataset: { id: 'alarm:001' } } })
  assert.deepStrictEqual(previewed.urls, ['wxfile://tmp/fall.jpg'])
  assert.strictEqual(page.data.previewingEvidenceId, '')

  const environment = require('../config/environment')
  storedSettings = { apiBaseUrl: 'https://local-override.example.com', demoMode: false }
  environment.API_BASE_URL = 'https://production.example.com/'
  assert.strictEqual(api.getBaseUrl(), 'https://production.example.com')
  assert.strictEqual(api.isEnvironmentLocked(), true)
  environment.API_BASE_URL = ''
  assert.strictEqual(api.getBaseUrl(), 'https://local-override.example.com')

  forcedStatusByPath.set('/api/v1/overview', 403)
  await rejects(() => api.requestRaw({ path: '/api/v1/overview' }), /未获监护授权/)
  forcedStatusByPath.delete('/api/v1/overview')

  const alarmPageSource = fs.readFileSync(path.join(ROOT, 'pages/alarms/index.js'), 'utf8')
  const alarmMarkup = fs.readFileSync(path.join(ROOT, 'pages/alarms/index.wxml'), 'utf8')
  const devicePageSource = fs.readFileSync(path.join(ROOT, 'pages/devices/index.js'), 'utf8')
  const deviceMarkup = fs.readFileSync(path.join(ROOT, 'pages/devices/index.wxml'), 'utf8')
  assert(/onUnload\(\).*stopAckPolling/.test(alarmPageSource), '页面卸载时必须停止 ACK 轮询')
  assert(/ACK_POLL_TIMEOUT_MS/.test(alarmPageSource), 'ACK 轮询必须有超时边界')
  assert(/ackNotes\[item\.id\]/.test(alarmMarkup), '每条告警必须使用独立备注')
  assert(/item\.ackPending/.test(alarmMarkup), '等待设备回执状态必须可见')
  assert(/item\.evidence\.available/.test(alarmMarkup), '只有存在证据时才显示查看入口')
  assert(/previewEvidence/.test(alarmPageSource), '告警页必须通过授权下载后预览证据')
  assert(/wx\.previewImage/.test(alarmPageSource), '现场图片必须使用微信临时文件预览')
  assert(/monitorView/.test(devicePageSource), '设备页必须应用经过行为测试的监护状态映射')
  assert(/item\.monitorText/.test(deviceMarkup), '设备页必须显示监护链路状态')
  assert(/item\.sensorRows/.test(deviceMarkup), '设备页必须显示后端返回的已知传感器状态')
  assert(/sensorRows\(device\.sensors\)/.test(devicePageSource), '设备页必须使用经过行为测试的传感器映射')

  const sourceFiles = []
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory() && entry.name !== 'tests') collect(fullPath)
      else if (entry.isFile() && /\.(js|json|wxml|wxss)$/.test(entry.name)) sourceFiles.push(fullPath)
    }
  }
  collect(ROOT)
  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, 'utf8')
    assert(!/https?:\/\/[^\s"']+@/i.test(content), `${file} contains URL credentials`)
    assert(!/\b(access_key|appsecret|device[_-]?secret)\b\s*[:=]\s*["'][^"']+/i.test(content), `${file} contains a hard-coded secret`)
  }

  console.log(`PASS ${24 + sourceFiles.length} checks`)
  console.log(`Validated ${sourceFiles.length} source/config files and ${calls.length} mocked HTTPS requests`)
}

run().catch(error => {
  console.error(error.stack || error)
  process.exitCode = 1
})
