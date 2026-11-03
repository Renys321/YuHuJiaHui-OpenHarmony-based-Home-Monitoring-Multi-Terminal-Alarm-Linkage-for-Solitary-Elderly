function formatTime(timestamp) {
  const value = Number(timestamp)
  if (!value) return '暂无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间无效'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function stateText(state) {
  return ({
    NORMAL: '正常',
    WARN: '需关注',
    ALARM: '告警',
    ACKED: '已闭环',
    OFFLINE: '离线'
  })[state] || '未知'
}

function stateClass(state) {
  return `status-${String(state || 'OFFLINE').toLowerCase()}`
}

function monitorView(value) {
  if (value === 1) return { text: '监护在线', className: 'monitor-online' }
  if (value === 0) return { text: '监护失联', className: 'monitor-offline' }
  return { text: '监护未启用', className: 'monitor-disabled' }
}

function sensorRows(sensors) {
  if (!sensors || typeof sensors !== 'object' || Array.isArray(sensors)) return []
  const rows = []
  const add = (key, label, value, alert = false) => rows.push({ key, label, value, alert })

  const motion = sensors.motion
  if (motion && typeof motion === 'object' && Number.isSafeInteger(motion.countToday) && motion.countToday >= 0) {
    add('motion', '人体活动', `今日 ${motion.countToday} 次`)
  }

  const door = sensors.door
  if (door && typeof door === 'object' && typeof door.open === 'boolean') {
    add('door', '门磁', door.open ? '已打开' : '已关闭', door.open)
  }

  const climate = sensors.climate
  if (climate && typeof climate === 'object') {
    const temp = climate.tempC
    const humidity = climate.rh
    const parts = []
    if (typeof temp === 'number' && Number.isFinite(temp) && temp >= -50 && temp <= 100) parts.push(`${temp.toFixed(1)}℃`)
    if (typeof humidity === 'number' && Number.isFinite(humidity) && humidity >= 0 && humidity <= 100) parts.push(`${humidity.toFixed(1)}% RH`)
    if (parts.length) add('climate', '温湿度', parts.join(' / '))
  }

  for (const [key, label] of [['gas', '燃气'], ['smoke', '烟雾']]) {
    const sensor = sensors[key]
    if (sensor && typeof sensor === 'object' && typeof sensor.ok === 'boolean') {
      add(key, label, sensor.ok ? '正常' : '异常', !sensor.ok)
    }
  }
  return rows
}

module.exports = { formatTime, stateText, stateClass, monitorView, sensorRows }
