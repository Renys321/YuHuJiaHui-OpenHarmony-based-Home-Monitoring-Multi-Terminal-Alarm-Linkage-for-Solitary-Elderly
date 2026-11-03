'use strict'

/**
 * pages/communications/index.js — 远程交流（远程留言）页面
 *
 * 家属在这里写一条文字留言，选择一条设备预置语音，由 DAYU200 播报，
 * 老人确认后状态变成「老人已确认」。本页只做单向留言，不采集手机麦克风。
 *
 * 硬性约束：
 *   - 发送只在用户点击按钮（bindtap）时发生，onLoad / onShow 绝不发送；
 *   - 近期留言只在用户点击「刷新」或下拉页面时加载，页面里没有任何轮询定时器；
 *   - 发送失败后保留同一个 clientMessageId，重试幂等，不会产生第二条留言。
 */

const { loadDashboard, connectionView } = require('../../utils/page-state')
const { formatTime } = require('../../utils/format')
const { cleanText } = require('../../utils/validators')
const {
  VOICE_IDS,
  voiceOptions,
  voiceLabel,
  statusLabel,
  statusClass,
  createClientMessageId,
  isValidClientMessageId,
  validateComposeInput,
  describeRequestError,
  listMessages,
  sendMessage
} = require('../../services/communications')

const RECENT_LIST_LIMIT = 20

function firstError(errors) {
  const keys = Object.keys(errors || {})
  return keys.length > 0 ? errors[keys[0]] : ''
}

Page({
  data: {
    loading: true,
    mode: 'unconfigured',
    banner: connectionView('unconfigured'),
    devices: [],
    deviceNames: [],
    deviceIndex: -1,
    voices: [],
    voiceId: '',
    text: '',
    requestAck: true,
    sending: false,
    clientMessageId: '',
    canRetry: false,
    fieldErrors: {},
    messages: [],
    messagesLoading: false,
    listError: ''
  },
  onLoad() {
    // 只做本地初始化：准备预置语音选项。绝不在这里发送留言。
    const voices = voiceOptions()
    this.setData({
      ...this.composeReset(),
      voices,
      voiceId: voices.length > 0 ? voices[0].id : ''
    })
  },
  onShow() {
    // 只刷新设备选择器需要的数据；近期留言必须由用户点击或下拉刷新。
    return this.refresh()
  },
  onPullDownRefresh() {
    return Promise.all([this.refresh(), this.refreshMessages()])
      .finally(() => wx.stopPullDownRefresh())
  },
  /** 修改草稿即视为新留言：清掉旧的幂等键，避免误去重。 */
  composeReset() {
    return { clientMessageId: '', canRetry: false, fieldErrors: {} }
  },
  async refresh() {
    this.setData({ loading: true })
    const result = await loadDashboard()
    const devices = result.data.devices
    const previous = this.data.devices[this.data.deviceIndex]
    let deviceIndex = previous ? devices.findIndex(item => item.id === previous.id) : -1
    if (deviceIndex < 0 && devices.length > 0) deviceIndex = 0
    this.setData({
      loading: false,
      mode: result.mode,
      banner: connectionView(result.mode, result.error),
      devices,
      deviceNames: devices.map(item => (item.roomName ? `${item.name}（${item.roomName}）` : item.name)),
      deviceIndex
    })
  },
  onDeviceChange(event) {
    if (this.data.sending === true) return
    const index = Number(event.detail.value)
    const valid = Number.isSafeInteger(index) && index >= 0 && index < this.data.devices.length
    this.setData({ ...this.composeReset(), deviceIndex: valid ? index : -1 })
  },
  onVoiceChange(event) {
    if (this.data.sending === true) return
    const voiceId = String(event.currentTarget.dataset.id || '')
    if (!VOICE_IDS.includes(voiceId)) return
    this.setData({ ...this.composeReset(), voiceId })
  },
  onTextInput(event) {
    if (this.data.sending === true) return
    const text = cleanText(event.detail.value, 120)
    this.setData({ ...this.composeReset(), text })
  },
  onAckChange(event) {
    if (this.data.sending === true) return
    this.setData({ ...this.composeReset(), requestAck: event.detail.value === true })
  },
  onSendTap() {
    return this.submitMessage()
  },
  onRetryTap() {
    return this.submitMessage()
  },
  onRefreshTap() {
    if (this.data.mode !== 'connected') {
      wx.showToast({ title: '云端未配置/未连接，无法加载近期留言', icon: 'none' })
      return Promise.resolve()
    }
    return this.refreshMessages()
  },
  /**
   * 唯一的发送入口，只由 onSendTap / onRetryTap 这两个 bindtap 处理函数调用。
   * 失败时保留 clientMessageId 并把 canRetry 置为 true，重试走同一个编号。
   */
  async submitMessage() {
    if (this.data.sending === true) return
    if (this.data.mode !== 'connected') {
      wx.showToast({
        title: this.data.mode === 'demo' ? '演示数据不能发送远程留言' : '云端未配置/未连接，无法发送留言',
        icon: 'none'
      })
      return
    }
    const device = this.data.devices[this.data.deviceIndex] || null
    const draft = {
      deviceId: device ? device.id : '',
      text: this.data.text,
      voiceId: this.data.voiceId,
      requestAck: this.data.requestAck === true
    }
    const check = validateComposeInput(draft)
    if (check.ok !== true) {
      this.setData({ fieldErrors: check.errors })
      wx.showToast({ title: firstError(check.errors) || '请先补全留言内容', icon: 'none' })
      return
    }

    // 已经有编号就复用（重试幂等）；没有才生成新编号。
    const clientMessageId = isValidClientMessageId(this.data.clientMessageId)
      ? this.data.clientMessageId
      : createClientMessageId()
    this.setData({ sending: true, clientMessageId, canRetry: false, fieldErrors: {} })
    try {
      await sendMessage({ ...draft, clientMessageId })
      this.setData({ sending: false, clientMessageId: '', canRetry: false, text: '' })
      wx.showToast({ title: '留言已提交，等待设备播报', icon: 'success' })
      await this.refreshMessages()
    } catch (error) {
      // 失败也要保住同一个 clientMessageId：重试不会创建第二条留言。
      this.setData({ sending: false, canRetry: true })
      wx.showToast({ title: describeRequestError(error) || '发送失败，请点击重试', icon: 'none' })
    }
  },
  async refreshMessages() {
    if (this.data.mode !== 'connected') {
      this.setData({
        messages: [],
        messagesLoading: false,
        listError: this.data.mode === 'demo' ? '演示模式不提供远程留言数据。' : ''
      })
      return
    }
    this.setData({ messagesLoading: true, listError: '' })
    try {
      const list = await listMessages(RECENT_LIST_LIMIT)
      this.setData({ messagesLoading: false, messages: list.map(item => this.toMessageView(item)) })
    } catch (error) {
      this.setData({ messagesLoading: false, listError: describeRequestError(error) || '近期留言加载失败' })
    }
  },
  toMessageView(message) {
    const raw = message && typeof message === 'object' ? message : {}
    const status = typeof raw.status === 'string' ? raw.status : ''
    const device = this.data.devices.find(item => item.id === String(raw.deviceId || ''))
    const failureCode = typeof raw.failureCode === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(raw.failureCode)
      ? raw.failureCode
      : ''
    return {
      messageId: String(raw.messageId || ''),
      text: String(raw.text || ''),
      voiceLabel: voiceLabel(raw.voiceId),
      statusText: statusLabel(status),
      statusClass: statusClass(status),
      requestAck: raw.requestAck === true,
      deviceName: device ? device.name : String(raw.deviceId || ''),
      timeText: formatTime(raw.createdAt),
      ackText: raw.acknowledgedAt ? `老人已确认：${formatTime(raw.acknowledgedAt)}` : '',
      failureText: status === 'FAILED'
        ? (failureCode ? `未能播报（${failureCode}）` : '未能播报，请重试')
        : ''
    }
  }
})
