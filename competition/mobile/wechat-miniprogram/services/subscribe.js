const { SUBSCRIBE_TEMPLATE_ID, SUBSCRIBE_PAGE, isValidTemplateId } = require('../config/subscribe')
const { requestRaw } = require('./api')

/** 微信订阅消息授权结果的合法取值。 */
const ACCEPT_STATUSES = ['accept', 'acceptWithAudio']
const REJECT_STATUSES = ['reject', 'ban', 'filter']

/** 授权登记接口路径（后端只登记当前登录人自己）。 */
const GRANT_PATH = '/api/v1/notifications/subscription'

let cachedTemplateId = null

/**
 * 返回当前可用的模板 ID；未配置或为占位值时返回空串。
 * @returns {string}
 */
function getTemplateId() {
  if (cachedTemplateId !== null) return cachedTemplateId
  return isValidTemplateId(SUBSCRIBE_TEMPLATE_ID) ? String(SUBSCRIBE_TEMPLATE_ID).trim() : ''
}

/** 供测试替换模板 ID；传 null 恢复真实配置。 */
function setTemplateIdForTest(value) {
  cachedTemplateId = value === null ? null : String(value)
}

/**
 * 订阅消息是否已配置。未配置时调用方必须显示「未配置」，且**不得**发起授权请求。
 * @returns {boolean}
 */
function isConfigured() {
  return getTemplateId() !== ''
}

/** 微信订阅消息能力是否可用。 */
function hasSubscribeCapability() {
  return typeof wx !== 'undefined' && typeof wx.requestSubscribeMessage === 'function'
}

/**
 * 生成一次授权事件的幂等 ID。
 *
 * 为什么需要它：后端按 `(recipientRef, grantEventId)` 幂等。用户一次点击只应记一次额度，
 * 但网络重试可能重复提交，因此用同一个 ID 重试是安全的。
 * 只使用时间戳与随机后缀，不含任何个人信息。
 */
function createGrantEventId() {
  const random = Math.random().toString(36).slice(2, 10)
  return `grant-${Date.now().toString(36)}-${random}`
}

/**
 * 把一次授权登记到后端。
 *
 * 这是"用户 accept 之后必须通知后端"的落点：后端不知道谁真的接受了订阅，
 * 只有登记过的人才会成为告警收件人。客户端**不提交 openid**，
 * 后端从会话 token 的 sub 判断身份，因此无法替别人登记。
 *
 * 不抛异常：失败返回结构化结果，供页面显示准确提示。
 */
async function registerGrant(grantEventId) {
  if (typeof grantEventId !== 'string' || grantEventId === '') {
    return { ok: false, reason: 'invalid_grant_event' }
  }
  try {
    const response = await requestRaw({
      path: GRANT_PATH,
      method: 'POST',
      data: { grantEventId, templateId: getTemplateId() }
    })
    if (!response || response.accepted !== true) return { ok: false, reason: 'not_accepted' }
    return {
      ok: true,
      duplicate: response.duplicate === true,
      remaining: Number.isInteger(response.remaining) ? response.remaining : null
    }
  } catch (error) {
    const status = error && error.statusCode
    return {
      ok: false,
      reason: status === 401 || status === 403 ? 'unauthorized' : 'backend_unavailable',
      statusCode: Number.isInteger(status) ? status : null
    }
  }
}

/**
 * 判断一次订阅授权的结果：是否至少有一个模板被接受。
 * @param {object} result wx.requestSubscribeMessage 的 success 回调参数
 * @param {string} templateId
 * @returns {{ accepted: boolean, status: string }}
 */
function evaluateSubscribeResult(result, templateId) {
  if (!result || typeof result !== 'object') return { accepted: false, status: 'unknown' }
  const status = String(result[templateId] == null ? '' : result[templateId])
  return { accepted: ACCEPT_STATUSES.includes(status), status: status || 'unknown' }
}

function classifyStatus(status) {
  if (ACCEPT_STATUSES.includes(status)) return 'accepted'
  if (REJECT_STATUSES.includes(status)) return 'rejected'
  return 'unknown'
}

/**
 * 请求订阅消息授权，并在用户接受后把授权登记到后端。
 *
 * **只能在用户点击按钮之后调用**。本函数自身不做任何页面生命周期或定时触发，
 * 因此"不得在后台、页面加载时或未经用户操作时请求授权"由调用点保证：
 * 唯一的调用点是告警页的 `onRequestSubscribe` 按钮处理函数。
 *
 * 一次性订阅语义：一次 accept 通常只对应一条告警通知，发送后额度即消耗，
 * 用户需要再次点击订阅。因此成功文案是"已订阅下一次告警通知"，
 * 绝不显示成"已开启"这种长期有效的说法。
 *
 * 关键边界：**授权已成功但后端登记失败**时，不能显示成完全成功，
 * 必须返回 `registered: false` 并给出准确提示。
 *
 * 不抛异常：所有失败都返回结构化结果。
 *
 * @returns {Promise<{
 *   ok: boolean, accepted: boolean, configured: boolean, registered: boolean,
 *   reason: string, status: string, message: string, remaining: (number|null)
 * }>}
 */
async function requestAlarmSubscribe() {
  const templateId = getTemplateId()
  if (templateId === '') {
    // 未配置：绝不调用微信接口，也绝不使用假模板。
    return {
      ok: false, accepted: false, configured: false, registered: false,
      reason: 'not_configured', status: 'unconfigured', message: '订阅消息未配置', remaining: null
    }
  }
  if (!hasSubscribeCapability()) {
    return {
      ok: false, accepted: false, configured: true, registered: false,
      reason: 'unsupported', status: 'unsupported', message: '当前微信版本不支持订阅消息', remaining: null
    }
  }

  let result
  try {
    result = await new Promise((resolve, reject) => {
      wx.requestSubscribeMessage({
        tmplIds: [templateId],
        success: resolve,
        fail: reject
      })
    })
  } catch (error) {
    const detail = String(error && error.errMsg ? error.errMsg : '')
    return {
      ok: false, accepted: false, configured: true, registered: false,
      reason: /cancel/i.test(detail) ? 'cancelled' : 'failed',
      status: 'error', message: '订阅请求未完成，请稍后重试', remaining: null
    }
  }

  const { accepted, status } = evaluateSubscribeResult(result, templateId)
  if (!accepted) {
    // reject / ban / cancel：**绝不登记**到后端。
    return {
      ok: true, accepted: false, configured: true, registered: false,
      reason: 'declined', status: classifyStatus(status),
      message: status === 'ban' ? '订阅授权已被禁用，请在设置中开启' : '您选择了不接收告警通知',
      remaining: null
    }
  }

  // 授权成功：必须登记到后端，否则后端不知道谁真的接受了订阅。
  const grantEventId = createGrantEventId()
  const recorded = await registerGrant(grantEventId)
  if (!recorded.ok) {
    return {
      ok: true, accepted: true, configured: true, registered: false,
      reason: 'register_failed', status: classifyStatus(status),
      registerReason: recorded.reason,
      message: '已授权，但登记未成功；请检查网络后再次点击订阅',
      remaining: null
    }
  }

  return {
    ok: true, accepted: true, configured: true, registered: true,
    reason: 'accepted', status: classifyStatus(status),
    message: '已订阅下一次告警通知',
    duplicate: recorded.duplicate === true,
    remaining: recorded.remaining
  }
}

module.exports = {
  SUBSCRIBE_PAGE,
  GRANT_PATH,
  ACCEPT_STATUSES,
  REJECT_STATUSES,
  getTemplateId,
  setTemplateIdForTest,
  isConfigured,
  hasSubscribeCapability,
  createGrantEventId,
  registerGrant,
  evaluateSubscribeResult,
  classifyStatus,
  requestAlarmSubscribe
}
