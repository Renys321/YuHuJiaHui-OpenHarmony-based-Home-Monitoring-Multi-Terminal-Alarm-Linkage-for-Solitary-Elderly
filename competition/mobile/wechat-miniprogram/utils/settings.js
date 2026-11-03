const STORAGE_KEY = 'eldercare.settings.v1'

const DEFAULT_SETTINGS = Object.freeze({
  apiBaseUrl: '',
  demoMode: false
})

function getStorage() {
  if (typeof wx === 'undefined' || !wx.getStorageSync) return null
  return wx
}

function normalizeBaseUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '')
  if (!url) return ''
  if (!/^https:\/\//i.test(url)) {
    throw new Error('后端地址必须使用 HTTPS')
  }
  if (/[@?#]/.test(url.replace(/^https:\/\//i, ''))) {
    throw new Error('后端地址不能包含凭据、查询参数或片段')
  }
  return url
}

function readSettings() {
  const storage = getStorage()
  if (!storage) return { ...DEFAULT_SETTINGS }
  const saved = storage.getStorageSync(STORAGE_KEY) || {}
  let apiBaseUrl = ''
  try {
    apiBaseUrl = normalizeBaseUrl(saved.apiBaseUrl)
  } catch (error) {
    apiBaseUrl = ''
  }
  return {
    apiBaseUrl,
    demoMode: saved.demoMode === true
  }
}

function saveSettings(next) {
  const settings = {
    apiBaseUrl: normalizeBaseUrl(next.apiBaseUrl),
    demoMode: next.demoMode === true
  }
  const storage = getStorage()
  if (storage) storage.setStorageSync(STORAGE_KEY, settings)
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && app.globalData) app.globalData.settings = settings
  return settings
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeBaseUrl,
  readSettings,
  saveSettings
}
