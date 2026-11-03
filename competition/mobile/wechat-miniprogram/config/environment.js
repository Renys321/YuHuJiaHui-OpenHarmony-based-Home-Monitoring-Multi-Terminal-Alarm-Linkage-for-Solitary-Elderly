// Production builds should set this to the trusted HTTPS API origin only.
// Never put OneNET access_key, token, cookie, password, or other secrets here.
//
// 微信订阅消息的模板 ID 属于**非敏感**配置，单独放在 ./subscribe.js：
// 它既不是密钥，也不是账号凭据；AppSecret / access_token / openid 只允许在服务端 Secret 中。
module.exports = {
  API_BASE_URL: ''
}
