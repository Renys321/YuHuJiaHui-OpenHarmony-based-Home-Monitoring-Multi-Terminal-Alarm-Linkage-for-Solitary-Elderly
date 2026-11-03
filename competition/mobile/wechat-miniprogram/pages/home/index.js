const { loadDashboard, connectionView } = require('../../utils/page-state')
const { readSettings, saveSettings } = require('../../utils/settings')
const { getBaseUrl, isEnvironmentLocked } = require('../../services/api')
const { stateText, stateClass, formatTime } = require('../../utils/format')
const { summarizeDashboard } = require('../../utils/validators')

Page({
  data: {
    loading: true,
    mode: 'unconfigured',
    banner: connectionView('unconfigured'),
    apiBaseUrl: '',
    backendLocked: false,
    demoMode: false,
    dashboard: null,
    summary: { roomCount: 0, onlineCount: 0, alarmCount: 0, monitorOfflineCount: 0 },
    recentAlarms: []
  },

  onLoad() {
    const settings = readSettings()
    const backendLocked = isEnvironmentLocked()
    this.setData({
      apiBaseUrl: backendLocked ? getBaseUrl() : settings.apiBaseUrl,
      backendLocked,
      demoMode: settings.demoMode
    })
    this.refresh()
  },

  /** 跳到远程留言页。tabBar 已满 5 个，因此这里用 navigateTo 作为入口。 */
  goCommunications() {
    wx.navigateTo({ url: '/pages/communications/index' })
  },

  onShow() {
    if (!this.data.loading) this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  async refresh() {
    this.setData({ loading: true })
    const result = await loadDashboard()
    const data = result.data
    const recentAlarms = data.alarms.slice(0, 3).map(item => ({
      ...item,
      stateText: stateText(item.state),
      stateClass: stateClass(item.state),
      timeText: formatTime(item.createdAt)
    }))
    this.setData({
      loading: false,
      mode: result.mode,
      banner: connectionView(result.mode, result.error),
      dashboard: data,
      recentAlarms,
      summary: summarizeDashboard(data)
    })
  },

  onApiInput(event) {
    if (this.data.backendLocked) return
    this.setData({ apiBaseUrl: event.detail.value })
  },

  onDemoChange(event) {
    try {
      const settings = saveSettings({
        apiBaseUrl: this.data.apiBaseUrl,
        demoMode: event.detail.value
      })
      this.setData({ demoMode: settings.demoMode, apiBaseUrl: settings.apiBaseUrl })
      this.refresh()
    } catch (error) {
      this.setData({ demoMode: false })
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  saveBackend() {
    if (this.data.backendLocked) {
      wx.showToast({ title: '生产后端已由构建配置锁定', icon: 'none' })
      return
    }
    try {
      const settings = saveSettings({ apiBaseUrl: this.data.apiBaseUrl, demoMode: this.data.demoMode })
      this.setData({ apiBaseUrl: settings.apiBaseUrl })
      wx.showToast({ title: settings.apiBaseUrl ? '后端地址已保存' : '已清除后端地址', icon: 'none' })
      this.refresh()
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  }
})
