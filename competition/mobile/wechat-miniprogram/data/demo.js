const DEMO_DASHBOARD = Object.freeze({
  generatedAt: 1791609000000,
  residentName: '演示住户',
  rooms: [
    { id: 'living', name: '客厅', location: '一层东侧', state: 'NORMAL', onlineDeviceCount: 1, deviceCount: 1 },
    { id: 'bath', name: '卫生间', location: '一层北侧', state: 'ALARM', onlineDeviceCount: 1, deviceCount: 1 }
  ],
  devices: [
    { id: 'dayu200-living', name: '客厅主控', roomId: 'living', roomName: '客厅', location: '电视柜旁', online: true, monitorOnline: 1, state: 'NORMAL', lastSeenTs: 1791608995000, sensors: { motion: { countToday: 8 } } },
    { id: 'esp32-bath', name: '卫生间节点', roomId: 'bath', roomName: '卫生间', location: '门口上方', online: true, monitorOnline: -1, state: 'ALARM', lastSeenTs: 1791608997000, sensors: { motion: { countToday: 2 } } }
  ],
  alarms: [
    { id: 'demo-alarm-001', deviceId: 'esp32-bath', roomName: '卫生间', type: 'NO_MOTION', message: '长时间未检测到活动', state: 'ALARM', createdAt: 1791608960000 }
  ],
  contacts: [
    { id: 'demo-contact-1', name: '家属（演示）', relation: '女儿', phone: '138 0000 0000', primary: true },
    { id: 'demo-contact-2', name: '社区服务（演示）', relation: '社区', phone: '020 0000 0000', primary: false }
  ]
})

module.exports = { DEMO_DASHBOARD }
