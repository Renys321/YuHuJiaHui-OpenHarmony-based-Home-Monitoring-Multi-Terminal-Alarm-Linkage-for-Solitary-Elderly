# API 合同

## 告警列表前置条件

`GET /api/v1/alerts` 返回的单条告警必须同时满足：

```text
type == FALL
evidence.available == true
alarmId 匹配 ^[A-Za-z0-9._:-]{1,80}$
```

仅此时 APP 显示“查看证据”。非 FALL、`available=false`、缺失或非法 alarmId 均隐藏入口。

## JPEG 下载

```http
GET /api/v1/alerts/{encodeURIComponent(alarmId)}/evidence/content
Authorization: Bearer <current-session>
Accept: image/jpeg
```

- Token 只进入请求头，不进入 URL、查询参数或日志。
- 超时 15 秒；响应上限 2 MiB；禁用 HTTP 客户端缓存。
- 仅接受 2xx、精确媒体类型 `image/jpeg`（允许参数）和 JPEG SOI/EOI 基本格式。
- `Content-Length` 或实际 payload 超过 2 MiB 均拒绝。
- 401：会话失效，不自动重试。
- 403：家庭权限失效，不自动重试。
- 404：证据暂不可用，不显示假图。
- 5xx、网络失败、超时：显示加载失败，仅允许用户主动重试。
- 页面销毁调用取消令牌，transport 销毁对应 `HttpRequest`。

## backend 本地合同

本地源码在统一 Bearer 验证和 `authorizeIdentity(identity.sub)` 家庭允许名单检查后处理证据路由。
成功响应为：

```text
Content-Type: image/jpeg
Cache-Control: private, no-store
Content-Disposition: inline; filename="fall-evidence.jpg"
X-Content-Type-Options: nosniff
```

`EvidenceStore` 使用 `deviceId + alarmId + evidenceId` 精确绑定；`evidenceId` 采用严格正则，
文件路径只能由合法 ID 构造。本轮未修改 backend 源码或公网部署。
