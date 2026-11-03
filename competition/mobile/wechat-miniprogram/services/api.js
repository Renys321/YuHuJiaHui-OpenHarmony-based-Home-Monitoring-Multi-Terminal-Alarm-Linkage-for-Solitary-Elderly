const { normalizeBaseUrl, readSettings } = require('../utils/settings')

let sessionToken = ''
let authPromise = null

function getBaseUrl() {
  const environment = require('../config/environment')
  const productionUrl = normalizeBaseUrl(environment.API_BASE_URL)
  if (productionUrl) return productionUrl
  const settings = readSettings()
  return normalizeBaseUrl(settings.apiBaseUrl)
}

function isEnvironmentLocked() {
  const environment = require('../config/environment')
  return Boolean(normalizeBaseUrl(environment.API_BASE_URL))
}

function wxLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(result) {
        if (result && result.code) resolve(result.code)
        else reject(new Error('微信登录未返回有效 code'))
      },
      fail() { reject(new Error('微信登录失败')) }
    })
  })
}

function requestRaw(options) {
  const baseUrl = getBaseUrl()
  if (!baseUrl) return Promise.reject(new Error('云端未配置/未连接'))
  if (typeof wx === 'undefined' || !wx.request) return Promise.reject(new Error('微信网络能力不可用'))

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${baseUrl}${options.path}`,
      method: options.method || 'GET',
      data: options.data,
      timeout: 10000,
      header: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(sessionToken && !options.skipAuth ? { Authorization: `Bearer ${sessionToken}` } : {})
      },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data)
          return
        }
        const error = new Error(response.statusCode === 403 ? '当前微信账号未获监护授权' : `云端请求失败（${response.statusCode}）`)
        error.statusCode = response.statusCode
        reject(error)
      },
      fail(error) {
        const detail = String(error && error.errMsg ? error.errMsg : '')
        const networkError = new Error(/timeout/i.test(detail) ? '网络请求超时' : '网络不可用，请检查连接')
        networkError.code = /timeout/i.test(detail) ? 'TIMEOUT' : 'NETWORK_ERROR'
        reject(networkError)
      }
    })
  })
}

async function authenticate() {
  if (sessionToken) return
  if (!authPromise) {
    authPromise = (async () => {
      if (typeof wx === 'undefined' || !wx.login) throw new Error('微信登录能力不可用')
      const code = await wxLogin()
      const response = await requestRaw({
        path: '/api/v1/auth/wechat',
        method: 'POST',
        data: { code },
        skipAuth: true
      })
      if (!response || typeof response.sessionToken !== 'string' || response.sessionToken.length < 16) {
        throw new Error('后端未返回有效短会话')
      }
      sessionToken = response.sessionToken
    })().finally(() => { authPromise = null })
  }
  return authPromise
}

async function request(options) {
  await authenticate()
  const attemptedToken = sessionToken
  try {
    return await requestRaw(options)
  } catch (error) {
    if (error.statusCode !== 401) throw error
    if (sessionToken === attemptedToken) sessionToken = ''
    await authenticate()
    return requestRaw(options)
  }
}

function downloadRaw(options) {
  const baseUrl = getBaseUrl()
  if (!baseUrl) return Promise.reject(new Error('云端未配置/未连接'))
  if (typeof wx === 'undefined' || !wx.downloadFile) return Promise.reject(new Error('微信文件下载能力不可用'))
  const requestPath = String(options.path || '')
  if (!requestPath.startsWith('/') || /[?#]/.test(requestPath)) {
    return Promise.reject(new Error('下载地址无效'))
  }
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: `${baseUrl}${requestPath}`,
      timeout: 15000,
      header: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300 && response.tempFilePath) {
          resolve(response.tempFilePath)
          return
        }
        const error = new Error(response.statusCode === 403
          ? '当前微信账号未获监护授权'
          : response.statusCode === 404 ? '现场图片不存在或已过期' : `现场图片下载失败（${response.statusCode}）`)
        error.statusCode = response.statusCode
        reject(error)
      },
      fail(error) {
        const detail = String(error && error.errMsg ? error.errMsg : '')
        reject(new Error(/timeout/i.test(detail) ? '现场图片下载超时' : '现场图片下载失败'))
      }
    })
  })
}

async function download(options) {
  await authenticate()
  const attemptedToken = sessionToken
  try {
    return await downloadRaw(options)
  } catch (error) {
    if (error.statusCode !== 401) throw error
    if (sessionToken === attemptedToken) sessionToken = ''
    await authenticate()
    return downloadRaw(options)
  }
}

function clearSession() {
  sessionToken = ''
  authPromise = null
}

module.exports = {
  getBaseUrl,
  isEnvironmentLocked,
  request,
  requestRaw,
  download,
  downloadRaw,
  authenticate,
  clearSession
}
