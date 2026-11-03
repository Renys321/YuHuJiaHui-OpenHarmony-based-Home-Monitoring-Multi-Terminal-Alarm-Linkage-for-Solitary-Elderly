const { readSettings } = require('./utils/settings')

App({
  globalData: {
    settings: {
      apiBaseUrl: '',
      demoMode: false
    }
  },

  onLaunch() {
    this.globalData.settings = readSettings()
  }
})
