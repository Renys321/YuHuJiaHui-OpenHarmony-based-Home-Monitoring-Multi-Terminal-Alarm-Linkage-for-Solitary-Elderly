const { loadDashboard, connectionView } = require('../../utils/page-state')
const { acknowledgeAlarm, downloadAlarmEvidence } = require('../../services/eldercare')
const { cleanText } = require('../../utils/validators')
const { stateText, stateClass, formatTime } = require('../../utils/format')
const { requestAlarmSubscribe, isConfigured: isSubscribeConfigured } = require('../../services/subscribe')

const ACK_POLL_INTERVAL_MS = 3000
const ACK_POLL_TIMEOUT_MS = 30000

Page({
  data: {
    loading: true,
    ackingId: '',
    previewingEvidenceId: '',
    ackNotes: {},
    mode: 'unconfigured',
    banner: connectionView('unconfigured'),
    subscribeConfigured: false,
    subscribeBusy: false,
    subscribeText: '订阅下一次告警通知',
    subscribeNote: '',
    alarms: []
  },
  onLoad() {
    // 只读取「是否已配置」用于渲染，绝不在这里请求订阅授权。
    this.setData({
      subscribeConfigured: isSubscribeConfigured() === true,
      subscribeText: isSubscribeConfigured() === true ? '订阅下一次告警通知' : '告警通知未配置'
    })
  },
  onShow() { this.refresh() },
  onHide() { this.stopAckPolling() },
  onUnload() { this.stopAckPolling() },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()) },
  async refresh(showLoading = true) {
    if (showLoading === true) this.setData({ loading: true })
    const result = await loadDashboard()
    const now = Date.now()
    const activePendingIds = new Set()
    if (!this.ackWaitStartedAt) this.ackWaitStartedAt = {}
    const alarms = result.data.alarms.map(alarm => ({
      ...alarm,
      timeText: formatTime(alarm.createdAt),
      stateText: stateText(alarm.state),
      stateClass: stateClass(alarm.state),
      ackTimedOut: this.isAckTimedOut(alarm, now, activePendingIds)
    }))
    Object.keys(this.ackWaitStartedAt).forEach(id => {
      if (!activePendingIds.has(id)) delete this.ackWaitStartedAt[id]
    })
    this.setData({ loading: false, mode: result.mode, banner: connectionView(result.mode, result.error), alarms })
    const shouldPoll = result.mode === 'connected' && alarms.some(item => item.ackPending && !item.ackTimedOut)
    if (shouldPoll) this.scheduleAckPoll()
    else this.stopAckPolling()
  },
  isAckTimedOut(alarm, now, activePendingIds) {
    if (alarm.state !== 'ALARM' || !alarm.ackPending) return false
    activePendingIds.add(alarm.id)
    if (!this.ackWaitStartedAt[alarm.id]) this.ackWaitStartedAt[alarm.id] = now
    return now - this.ackWaitStartedAt[alarm.id] >= ACK_POLL_TIMEOUT_MS
  },
  scheduleAckPoll() {
    this.stopAckPolling()
    this.ackPollTimer = setTimeout(() => {
      this.ackPollTimer = null
      this.refresh(false)
    }, ACK_POLL_INTERVAL_MS)
  },
  stopAckPolling() {
    if (this.ackPollTimer) clearTimeout(this.ackPollTimer)
    this.ackPollTimer = null
  },
  onNoteInput(event) {
    const alarmId = String(event.currentTarget.dataset.id || '')
    const ackNotes = { ...this.data.ackNotes, [alarmId]: cleanText(event.detail.value, 120) }
    this.setData({ ackNotes })
  },
  async acknowledge(event) {
    if (this.data.mode !== 'connected') {
      wx.showToast({ title: this.data.mode === 'demo' ? '演示数据不能提交 ACK' : '云端未配置/未连接', icon: 'none' })
      return
    }
    const alarmId = event.currentTarget.dataset.id
    const note = this.data.ackNotes[alarmId] || ''
    this.setData({ ackingId: alarmId })
    try {
      const result = await acknowledgeAlarm(alarmId, note)
      if (result.pending) {
        if (!this.ackWaitStartedAt) this.ackWaitStartedAt = {}
        this.ackWaitStartedAt[alarmId] = Date.now()
      }
      wx.showToast({
        title: result.pending ? '已下发，等待设备回执' : '告警已确认',
        icon: result.pending ? 'none' : 'success'
      })
      const ackNotes = { ...this.data.ackNotes, [alarmId]: '' }
      this.setData({ ackNotes })
      await this.refresh(false)
    } catch (error) {
      wx.showToast({ title: error.message || '确认失败', icon: 'none' })
    } finally {
      this.setData({ ackingId: '' })
    }
  },
  /**
   * 订阅下一次告警通知。
   *
   * 这是整个小程序里**唯一**调用 wx.requestSubscribeMessage 的地方，并且只由
   * 用户点击按钮（bindtap）触发。不得在 onLoad / onShow / 定时器或后台调用。
   *
   * 一次性订阅：accept 之后必须把授权登记到后端，否则后端不知道谁真的接受了订阅。
   * 登记失败时**不能**显示成完全成功。
   */
  async onRequestSubscribe() {
    if (this.data.subscribeBusy === true) return
    if (isSubscribeConfigured() !== true) {
      wx.showToast({ title: '订阅消息未配置', icon: 'none' })
      return
    }
    this.setData({ subscribeBusy: true })
    try {
      const result = await requestAlarmSubscribe()
      if (result.configured !== true) {
        this.setData({ subscribeConfigured: false, subscribeText: '告警通知未配置', subscribeNote: result.message || '' })
        wx.showToast({ title: result.message || '订阅消息未配置', icon: 'none' })
        return
      }
      if (result.accepted === true && result.registered === true) {
        // 一次性订阅：只说"下一次"，不说长期"已开启"。
        this.setData({ subscribeText: '已订阅下一次告警通知', subscribeNote: '' })
      } else if (result.accepted === true && result.registered !== true) {
        // 授权成功但后端登记失败：明确告诉用户没登记成功，可以重试。
        this.setData({ subscribeNote: result.message || '登记未成功，请再次点击订阅' })
      } else if (result.reason === 'declined') {
        this.setData({ subscribeNote: '' })
      }
      wx.showToast({ title: result.message || '订阅请求已提交', icon: result.accepted === true && result.registered === true ? 'success' : 'none' })
    } catch (error) {
      wx.showToast({ title: error.message || '订阅请求失败', icon: 'none' })
    } finally {
      this.setData({ subscribeBusy: false })
    }
  },
  async previewEvidence(event) {
    if (this.data.mode !== 'connected') {
      wx.showToast({ title: '云端未连接，无法查看现场图片', icon: 'none' })
      return
    }
    const alarmId = String(event.currentTarget.dataset.id || '')
    this.setData({ previewingEvidenceId: alarmId })
    try {
      const tempFilePath = await downloadAlarmEvidence(alarmId)
      await new Promise((resolve, reject) => wx.previewImage({
        current: tempFilePath,
        urls: [tempFilePath],
        success: resolve,
        fail: () => reject(new Error('图片预览失败'))
      }))
    } catch (error) {
      wx.showToast({ title: error.message || '现场图片查看失败', icon: 'none' })
    } finally {
      this.setData({ previewingEvidenceId: '' })
    }
  }
})
