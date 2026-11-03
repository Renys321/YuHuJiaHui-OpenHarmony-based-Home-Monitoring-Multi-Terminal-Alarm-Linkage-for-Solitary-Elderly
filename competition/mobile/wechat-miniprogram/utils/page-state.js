const { readSettings } = require('./settings')
const { normalizeDashboard } = require('./validators')
const { DEMO_DASHBOARD } = require('../data/demo')
const { fetchDashboard } = require('../services/eldercare')

async function loadDashboard() {
  const settings = readSettings()
  if (settings.demoMode) {
    return { mode: 'demo', data: normalizeDashboard(DEMO_DASHBOARD), error: '' }
  }
  if (!settings.apiBaseUrl && !require('../config/environment').API_BASE_URL) {
    return { mode: 'unconfigured', data: normalizeDashboard({}), error: '请先配置受信 HTTPS 后端，或主动开启本地演示数据。' }
  }
  try {
    const data = await fetchDashboard()
    return { mode: 'connected', data, error: data.partialError || '' }
  } catch (error) {
    const message = error.message || '云端未配置/未连接'
    const mode = error.statusCode === 403 || /未获.*授权|登录/.test(message)
      ? 'unauthorized'
      : (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR' || /超时|网络不可用/.test(message) ? 'offline' : 'error')
    return { mode, data: normalizeDashboard({}), error: message }
  }
}

function connectionView(mode, error) {
  if (mode === 'demo') return { bannerClass: 'demo', title: '演示数据', detail: '当前内容来自本地样例，不代表真实设备状态。' }
  if (mode === 'connected' && error) return { bannerClass: 'partial', title: '云端部分可用', detail: error }
  if (mode === 'connected') return { bannerClass: 'connected', title: '云端已连接', detail: '数据来自已配置的受信 HTTPS 后端。' }
  if (mode === 'unauthorized') return { bannerClass: 'unauthorized', title: '账号未获授权', detail: error || '请由系统管理员将当前微信账号加入监护人允许名单。' }
  if (mode === 'offline') return { bannerClass: 'offline', title: '网络暂不可用', detail: error || '请检查手机网络后重试。' }
  return { bannerClass: '', title: '云端未配置/未连接', detail: error || '暂无可用的实时数据。' }
}

module.exports = { loadDashboard, connectionView }
