const { loadDashboard, connectionView } = require('../../utils/page-state')

Page({
  data: { loading: true, mode: 'unconfigured', banner: connectionView('unconfigured'), contacts: [] },
  onShow() { this.refresh() },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()) },
  async refresh() {
    this.setData({ loading: true })
    const result = await loadDashboard()
    this.setData({ loading: false, mode: result.mode, banner: connectionView(result.mode, result.error), contacts: result.data.contacts })
  },
  callContact(event) {
    const phoneNumber = String(event.currentTarget.dataset.phone || '').replace(/[ -]/g, '')
    if (!/^\+?\d{5,20}$/.test(phoneNumber)) {
      wx.showToast({ title: '电话号码无效', icon: 'none' })
      return
    }
    wx.makePhoneCall({
      phoneNumber,
      fail(error) {
        if (!error || !/cancel/i.test(error.errMsg || '')) wx.showToast({ title: '未能发起拨号', icon: 'none' })
      }
    })
  }
})
