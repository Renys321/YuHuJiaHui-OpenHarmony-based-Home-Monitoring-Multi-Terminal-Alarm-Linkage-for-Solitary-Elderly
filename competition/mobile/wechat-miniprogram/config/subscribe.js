/**
 * config/subscribe.js — 微信订阅消息的**非敏感**配置
 *
 * 这里只放「模板 ID」和「跳转页」这类非敏感标识，因此它不属于密钥文件。
 *
 * 明确边界：
 *   - AppSecret、access_token、openid、手机号**绝不能**出现在小程序任何文件里；
 *     它们只存在于服务端 Secret。
 *   - 模板 ID 必须从非敏感生产配置读取，未配置时功能显示为「未配置」，
 *     绝不使用假的默认模板去调用 wx.requestSubscribeMessage。
 *   - 发布前把 SUBSCRIBE_TEMPLATE_ID 换成在微信公众平台申请到的真实模板 ID；
 *     下面的占位串会被识别为「未配置」，不会发起任何授权请求。
 */

/** 占位/示例值：一律视为「未配置」，禁止用于授权请求。 */
const PLACEHOLDER_PATTERN = /(replace|placeholder|changeme|change-me|your[-_]?template|template[-_]?id[-_]?here|xxx+|todo|example|demo)/i

const SUBSCRIBE_TEMPLATE_ID = 'REPLACE_WITH_WECHAT_SUBSCRIBE_TEMPLATE_ID'

const SUBSCRIBE_PAGE = 'pages/alarms/index'

/**
 * 判断一个模板 ID 是否可用于真实请求。
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidTemplateId(value) {
  const text = String(value == null ? '' : value).trim()
  if (text.length === 0 || text.length > 64) return false
  if (PLACEHOLDER_PATTERN.test(text)) return false
  return /^[A-Za-z0-9._-]+$/.test(text)
}

/**
 * 当前构建是否配置了可用的订阅消息模板。
 * @returns {boolean}
 */
function isSubscribeConfigured() {
  return isValidTemplateId(SUBSCRIBE_TEMPLATE_ID)
}

module.exports = {
  PLACEHOLDER_PATTERN,
  SUBSCRIBE_TEMPLATE_ID,
  SUBSCRIBE_PAGE,
  isValidTemplateId,
  isSubscribeConfigured
}
