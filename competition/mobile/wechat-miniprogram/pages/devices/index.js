const { loadDashboard, connectionView } = require('../../utils/page-state')
const { stateText, stateClass, formatTime, monitorView, sensorRows } = require('../../utils/format')

Page({
  data: { loading: true, mode: 'unconfigured', banner: connectionView('unconfigured'), devices: [] },
  onShow() { this.refresh() },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()) },
  async refresh() {
    this.setData({ loading: true })
    const result = await loadDashboard()
    const devices = result.data.devices.map(device => {
      const monitor = monitorView(device.monitorOnline)
      return {
        ...device,
        monitorText: monitor.text,
        monitorClass: monitor.className,
        sensorRows: sensorRows(device.sensors),
        stateText: stateText(device.state),
        stateClass: stateClass(device.state),
        lastSeenText: formatTime(device.lastSeenTs)
      }
    })
    this.setData({ loading: false, mode: result.mode, banner: connectionView(result.mode, result.error), devices })
  }
})
