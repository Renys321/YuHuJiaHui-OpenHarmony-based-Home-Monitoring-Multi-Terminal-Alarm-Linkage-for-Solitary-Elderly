const { loadDashboard, connectionView } = require('../../utils/page-state')
const { stateText, stateClass } = require('../../utils/format')

Page({
  data: { loading: true, mode: 'unconfigured', banner: connectionView('unconfigured'), rooms: [] },
  onShow() { this.refresh() },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()) },
  async refresh() {
    this.setData({ loading: true })
    const result = await loadDashboard()
    const rooms = result.data.rooms.map(room => ({ ...room, stateText: stateText(room.state), stateClass: stateClass(room.state) }))
    this.setData({ loading: false, mode: result.mode, banner: connectionView(result.mode, result.error), rooms })
  }
})
