const api = require('./api')
const { normalizeDashboard, normalizeAlarm, validateAckInput, validateAlarmId } = require('../utils/validators')

async function fetchDashboard() {
  const endpoints = [
    ['overview', '总览', '/api/v1/overview'],
    ['rooms', '房间', '/api/v1/rooms'],
    ['alerts', '告警', '/api/v1/alerts'],
    ['devices', '设备', '/api/v1/devices'],
    ['location', '位置', '/api/v1/location'],
    ['contacts', '联系人', '/api/v1/contacts']
  ]
  const results = await Promise.all(endpoints.map(item => (
    api.request({ path: item[2] })
      .then(value => ({ ok: true, value }))
      .catch(error => ({ ok: false, error }))
  )))
  const fulfilledCount = results.filter(item => item.ok).length
  if (fulfilledCount === 0) throw results[0].error

  const responses = {}
  const unavailable = []
  results.forEach((result, index) => {
    const [key, label] = endpoints[index]
    if (result.ok) responses[key] = result.value
    else unavailable.push(label)
  })

  const overviewResponse = responses.overview
  const roomsResponse = responses.rooms
  const alertsResponse = responses.alerts
  const devicesResponse = responses.devices
  const locationResponse = responses.location
  const contactsResponse = responses.contacts

  const overview = overviewResponse && overviewResponse.overview ? overviewResponse.overview : overviewResponse || {}
  const list = (response, key) => Array.isArray(response) ? response : (response && Array.isArray(response[key]) ? response[key] : [])
  const locations = list(locationResponse, 'locations')
  const locationByDevice = locations.reduce((result, item) => {
    if (item && item.deviceId) result[String(item.deviceId)] = item
    return result
  }, {})
  const devices = list(devicesResponse, 'devices').map(item => ({
    ...item,
    location: item.location || (locationByDevice[item.id || item.deviceId] || {}).location || ''
  }))

  const dashboard = normalizeDashboard({
    generatedAt: overview.generatedAt,
    residentName: overview.residentName,
    rooms: list(roomsResponse, 'rooms'),
    devices,
    alarms: list(alertsResponse, 'alerts'),
    contacts: list(contactsResponse, 'contacts')
  })
  dashboard.partialError = unavailable.length > 0 ? `部分数据暂不可用：${unavailable.join('、')}` : ''
  return dashboard
}

async function acknowledgeAlarm(alarmId, note) {
  const input = validateAckInput(alarmId, note)
  const payload = await api.request({
    path: `/api/v1/alerts/${encodeURIComponent(input.id)}/ack`,
    method: 'POST',
    data: { note: input.note }
  })
  if (payload && payload.accepted === true && payload.status === 'PENDING' && payload.commandId) {
    return { pending: true, commandId: String(payload.commandId) }
  }
  const alarm = normalizeAlarm(payload && payload.alarm ? payload.alarm : payload)
  if (!alarm || alarm.state !== 'ACKED') throw new Error('设备尚未返回确认结果')
  return { pending: false, alarm }
}

async function downloadAlarmEvidence(alarmId) {
  const id = validateAlarmId(alarmId)
  return api.download({
    path: `/api/v1/alerts/${encodeURIComponent(id)}/evidence/content`
  })
}

module.exports = { fetchDashboard, acknowledgeAlarm, downloadAlarmEvidence }
