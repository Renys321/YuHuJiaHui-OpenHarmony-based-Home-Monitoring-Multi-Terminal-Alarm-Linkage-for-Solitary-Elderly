'use strict'

/**
 * services/communications.js — 远程留言（家属 → DAYU200）客户端服务
 *
 * 后端契约（唯一事实来源）：
 *   POST /api/v1/communications/messages
 *        { clientMessageId, deviceId, text, voiceId, requestAck }
 *   GET  /api/v1/communications/messages?limit=20   -> { messages: [...] }
 *   GET  /api/v1/communications/messages/{messageId} -> { message: {...} }
 *
 * 身份完全来自 services/api.js 维护的 Bearer 短会话：客户端**绝不**提交
 * openid、recipientRef、令牌、手机号或坐标。
 *
 * 本阶段语义：文字留言 + 设备预置语音播报 + 老人在设备上确认。
 * 页面不采集手机麦克风，只是一种单向留言。
 *
 * 幂等：重试必须复用同一个 clientMessageId，后端据此去重，不会产生第二条留言。
 */

const api = require('./api')

const MESSAGES_PATH = '/api/v1/communications/messages'

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 50

const TEXT_MIN_LENGTH = 1
const TEXT_MAX_LENGTH = 120

/** 服务端语音白名单，大小写敏感；顺序即界面上「预置语音播报」的展示顺序。 */
const VOICE_IDS = Object.freeze([
  'CHECK_IN',
  'PLEASE_RESPOND',
  'MEDICINE_REMINDER',
  'FAMILY_MESSAGE',
  'EMERGENCY_CONTACTING'
])

const VOICE_LABELS = Object.freeze({
  CHECK_IN: '平安问候',
  PLEASE_RESPOND: '请回应一声',
  MEDICINE_REMINDER: '用药提醒',
  FAMILY_MESSAGE: '家人留言',
  EMERGENCY_CONTACTING: '紧急联系家人'
})

/** status 只允许这六个值；未知状态显示为「未知」，不猜测后端语义。 */
const STATUS_LABELS = Object.freeze({
  QUEUED: '排队中',
  DELIVERED: '已送达',
  PLAYED: '已播放',
  ACKED: '老人已确认',
  FAILED: '失败',
  EXPIRED: '已过期'
})

const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,96}$/

/** 状态码 → 面向家属的可读中文；不把后端堆栈或内部细节展示给用户。 */
const REQUEST_ERROR_MESSAGES = Object.freeze({
  400: '提交内容不符合要求，请检查后重试',
  401: '登录状态已失效，请退出后重新进入小程序',
  403: '当前微信账号未获监护授权',
  404: '目标留言或设备不存在',
  413: '内容过长，请精简后重试',
  429: '操作过于频繁，请稍后再试'
})

function voiceOptions() {
  return VOICE_IDS.map(id => ({ id, label: VOICE_LABELS[id] }))
}

function voiceLabel(voiceId) {
  const key = typeof voiceId === 'string' ? voiceId : ''
  return VOICE_LABELS[key] || '未知语音'
}

function statusLabel(status) {
  const key = typeof status === 'string' ? status : ''
  return STATUS_LABELS[key] || '未知'
}

function statusClass(status) {
  const key = typeof status === 'string' ? status : ''
  return STATUS_LABELS[key] ? `status-${key.toLowerCase()}` : 'status-unknown'
}

function randomToken(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let index = 0; index < length; index += 1) {
    token += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return token
}

/**
 * 生成幂等键：`cmsg-<base36 时间>-<8 位随机>`，满足 /^[A-Za-z0-9._-]{8,64}$/。
 * 纯函数（只用 Date.now / Math.random），不依赖 wx，可在 node 中直接测试。
 */
function createClientMessageId() {
  const candidate = `cmsg-${Date.now().toString(36)}-${randomToken(8)}`
  return CLIENT_MESSAGE_ID_PATTERN.test(candidate) ? candidate : `cmsg-${randomToken(16)}`
}

function isValidClientMessageId(value) {
  return typeof value === 'string' && CLIENT_MESSAGE_ID_PATTERN.test(value)
}

/**
 * 归一化输入：text 去掉首尾空白并把换行/制表符压成空格；requestAck 只认严格 true。
 */
function normalizeComposeInput(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    deviceId: String(source.deviceId == null ? '' : source.deviceId).trim(),
    text: String(source.text == null ? '' : source.text).replace(/[\r\n\t]/g, ' ').trim(),
    voiceId: typeof source.voiceId === 'string' ? source.voiceId : '',
    requestAck: source.requestAck === true
  }
}

function collectComposeErrors(normalized) {
  const errors = {}
  if (!normalized.deviceId) errors.deviceId = '请选择要发送的设备'
  else if (!DEVICE_ID_PATTERN.test(normalized.deviceId)) errors.deviceId = '设备编号无效，请重新选择'

  if (!normalized.text) errors.text = '请输入留言内容'
  else if (normalized.text.length > TEXT_MAX_LENGTH) errors.text = '留言内容不能超过 120 个字'

  if (!VOICE_IDS.includes(normalized.voiceId)) errors.voiceId = '请选择预置语音播报'

  return errors
}

/**
 * 校验发送草稿。voiceId 走白名单精确匹配，因此 `../../etc/passwd`、
 * `CHECK_IN; rm -rf /` 这类注入串会直接被拒绝。
 */
function validateComposeInput(input) {
  const errors = collectComposeErrors(normalizeComposeInput(input))
  return { ok: Object.keys(errors).length === 0, errors }
}

function describeRequestError(error) {
  const statusCode = error && Number.isFinite(Number(error.statusCode)) ? Number(error.statusCode) : 0
  if (statusCode && REQUEST_ERROR_MESSAGES[statusCode]) return REQUEST_ERROR_MESSAGES[statusCode]
  const message = error && error.message ? String(error.message) : ''
  return message || '云端请求失败，请稍后重试'
}

/** 把 api.js 抛出的错误换成可读中文，同时保留 statusCode/code 供上层判断。 */
function toReadableError(error) {
  if (error && error.code === 'VALIDATION') return error
  const readable = new Error(describeRequestError(error))
  if (error && error.statusCode) readable.statusCode = error.statusCode
  if (error && error.code) readable.code = error.code
  return readable
}

function buildSendBody(input) {
  const source = input && typeof input === 'object' ? input : {}
  const normalized = normalizeComposeInput(source)
  const errors = collectComposeErrors(normalized)
  const errorFields = Object.keys(errors)
  if (errorFields.length > 0) {
    const error = new Error(errors[errorFields[0]])
    error.code = 'VALIDATION'
    error.errors = errors
    throw error
  }

  // 调用方给了编号就必须原样复用（重试幂等）；给了非法编号直接报错，
  // 绝不悄悄换一个——否则重试会变成第二条留言。
  const provided = source.clientMessageId
  if (provided != null && provided !== '') {
    if (!isValidClientMessageId(provided)) {
      const error = new Error('客户端留言编号无效')
      error.code = 'VALIDATION'
      error.errors = { clientMessageId: '客户端留言编号无效' }
      throw error
    }
  }
  const clientMessageId = isValidClientMessageId(provided) ? provided : createClientMessageId()

  return {
    clientMessageId,
    deviceId: normalized.deviceId,
    text: normalized.text,
    voiceId: normalized.voiceId,
    requestAck: normalized.requestAck
  }
}

function normalizeMessage(payload) {
  const message = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.message : null
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    const error = new Error('后端未返回留言状态')
    error.code = 'BAD_RESPONSE'
    throw error
  }
  return message
}

/**
 * 发送（或重试）一条远程留言。返回后端返回的 message 对象。
 * 传入同一个 clientMessageId 时，后端幂等去重，不会产生第二条留言。
 */
async function sendMessage(input) {
  const body = buildSendBody(input)
  let payload
  try {
    payload = await api.request({ path: MESSAGES_PATH, method: 'POST', data: body })
  } catch (error) {
    throw toReadableError(error)
  }
  return normalizeMessage(payload)
}

function normalizeListLimit(limit) {
  const value = Number(limit)
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_LIST_LIMIT
  return Math.min(value, MAX_LIST_LIMIT)
}

/** 最近留言（服务端按时间倒序返回）。 */
async function listMessages(limit) {
  const safeLimit = normalizeListLimit(limit)
  let payload
  try {
    payload = await api.request({ path: `${MESSAGES_PATH}?limit=${safeLimit}` })
  } catch (error) {
    throw toReadableError(error)
  }
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.messages)) return payload.messages
  return []
}

/** 单条留言状态。 */
async function getMessage(messageId) {
  const id = String(messageId == null ? '' : messageId).trim()
  if (!MESSAGE_ID_PATTERN.test(id)) {
    const error = new Error('留言编号无效')
    error.code = 'VALIDATION'
    throw error
  }
  let payload
  try {
    payload = await api.request({ path: `${MESSAGES_PATH}/${encodeURIComponent(id)}` })
  } catch (error) {
    throw toReadableError(error)
  }
  return normalizeMessage(payload)
}

module.exports = {
  MESSAGES_PATH,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  TEXT_MIN_LENGTH,
  TEXT_MAX_LENGTH,
  VOICE_IDS,
  VOICE_LABELS,
  STATUS_LABELS,
  voiceOptions,
  voiceLabel,
  statusLabel,
  statusClass,
  createClientMessageId,
  isValidClientMessageId,
  validateComposeInput,
  describeRequestError,
  sendMessage,
  listMessages,
  getMessage
}
