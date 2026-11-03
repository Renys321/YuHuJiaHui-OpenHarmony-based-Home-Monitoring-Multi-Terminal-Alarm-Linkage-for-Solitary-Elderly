const STATES = ['NORMAL', 'WARN', 'ALARM', 'ACKED', 'OFFLINE']

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\r\n\t]/g, ' ').trim().slice(0, maxLength)
}

function normalizeState(value) {
  const state = String(value || '').toUpperCase()
  return STATES.includes(state) ? state : 'OFFLINE'
}

function normalizeTimestamp(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? Math.trunc(timestamp) : 0
}

function normalizeMonitorOnline(value) {
  return Number.isSafeInteger(value) && [-1, 0, 1].includes(value) ? value : -1
}

function normalizeDevice(raw) {
  if (!isObject(raw)) return null
  const id = cleanText(raw.id || raw.deviceId, 64)
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) return null
  return {
    id,
    name: cleanText(raw.name || id, 40),
    roomId: cleanText(raw.roomId, 64),
    roomName: cleanText(raw.roomName || raw.room, 40),
    location: cleanText(raw.location, 80),
    online: raw.online === true,
    monitorOnline: normalizeMonitorOnline(raw.monitorOnline),
    state: normalizeState(raw.online === false ? 'OFFLINE' : raw.state),
    lastSeenTs: normalizeTimestamp(raw.lastSeenTs || raw.ts),
    sensors: isObject(raw.sensors) ? raw.sensors : {}
  }
}

function normalizeRoom(raw) {
  if (!isObject(raw)) return null
  const id = cleanText(raw.id, 64)
  if (!id) return null
  const devices = Array.isArray(raw.devices) ? raw.devices.map(normalizeDevice).filter(Boolean) : []
  return {
    id,
    name: cleanText(raw.name, 40) || '未命名房间',
    location: cleanText(raw.location, 80),
    state: normalizeState(raw.state),
    onlineDeviceCount: Number.isFinite(Number(raw.onlineDeviceCount)) ? Number(raw.onlineDeviceCount) : devices.filter(item => item.online).length,
    deviceCount: Number.isFinite(Number(raw.deviceCount)) ? Number(raw.deviceCount) : devices.length,
    devices
  }
}

function normalizeAlarm(raw) {
  if (!isObject(raw)) return null
  const id = cleanText(raw.id || raw.alarmId, 96)
  const deviceId = cleanText(raw.deviceId, 64)
  if (!id || !deviceId) return null
  const rawEvidence = isObject(raw.evidence) ? raw.evidence : {}
  const evidenceId = cleanText(rawEvidence.evidenceId, 95)
  const evidenceAvailable = rawEvidence.available === true &&
    /^fall-[0-9]{1,16}-(?:na|[0-9]{1,12})$/.test(evidenceId)
  return {
    id,
    deviceId,
    roomName: cleanText(raw.roomName || raw.room, 40),
    type: cleanText(raw.type, 40) || 'UNKNOWN',
    message: cleanText(raw.message, 160) || '检测到异常',
    state: normalizeState(raw.state),
    ackPending: raw.ackPending === true,
    createdAt: normalizeTimestamp(raw.createdAt || raw.ts),
    acknowledgedAt: normalizeTimestamp(raw.acknowledgedAt),
    acknowledgedBy: cleanText(raw.acknowledgedBy, 40),
    evidence: evidenceAvailable ? {
      available: true,
      evidenceId,
      bytes: normalizeTimestamp(rawEvidence.bytes),
      capturedAt: normalizeTimestamp(rawEvidence.capturedAt)
    } : { available: false }
  }
}

function validateAlarmId(alarmId) {
  const id = cleanText(alarmId, 96)
  if (!id || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('告警编号无效')
  return id
}

function normalizeContact(raw) {
  if (!isObject(raw)) return null
  const id = cleanText(raw.id, 64)
  const name = cleanText(raw.name, 40)
  const phone = cleanText(raw.phone, 30)
  if (!id || !name || !/^\+?[0-9 -]{5,30}$/.test(phone)) return null
  return {
    id,
    name,
    relation: cleanText(raw.relation, 30),
    phone,
    primary: raw.primary === true
  }
}

function normalizeDashboard(raw) {
  if (!isObject(raw)) throw new Error('后端返回格式无效')
  const rooms = Array.isArray(raw.rooms) ? raw.rooms.map(normalizeRoom).filter(Boolean) : []
  const devices = Array.isArray(raw.devices) ? raw.devices.map(normalizeDevice).filter(Boolean) : []
  const alarms = Array.isArray(raw.alarms) ? raw.alarms.map(normalizeAlarm).filter(Boolean) : []
  const contacts = Array.isArray(raw.contacts) ? raw.contacts.map(normalizeContact).filter(Boolean) : []
  return {
    generatedAt: normalizeTimestamp(raw.generatedAt),
    residentName: cleanText(raw.residentName, 40),
    rooms,
    devices,
    alarms,
    contacts
  }
}

function summarizeDashboard(data) {
  const rooms = data && Array.isArray(data.rooms) ? data.rooms : []
  const devices = data && Array.isArray(data.devices) ? data.devices : []
  const alarms = data && Array.isArray(data.alarms) ? data.alarms : []
  return {
    roomCount: rooms.length,
    onlineCount: devices.filter(item => item.online).length,
    alarmCount: alarms.filter(item => item.state === 'ALARM').length,
    monitorOfflineCount: devices.filter(item => item.monitorOnline === 0).length
  }
}

function validateAckInput(alarmId, note) {
  const id = validateAlarmId(alarmId)
  const safeNote = cleanText(note, 120)
  if (!safeNote) throw new Error('请填写处置说明')
  return { id, note: safeNote }
}

module.exports = {
  STATES,
  cleanText,
  normalizeMonitorOnline,
  normalizeDashboard,
  summarizeDashboard,
  normalizeDevice,
  normalizeRoom,
  normalizeAlarm,
  normalizeContact,
  validateAlarmId,
  validateAckInput
}
