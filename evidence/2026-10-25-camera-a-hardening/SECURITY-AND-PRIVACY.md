# 安全与隐私

## 内存与隔离

- JPEG 仅保存在 APP 进程内 `EvidenceMemoryCache` 和页面临时对象中。
- 未写入文件、公共媒体库、Preferences、数据库或 Asset Store。
- 缓存上限为 6 条、12 MiB，避免无界增长。
- key 包含 `guardianId` 和 `alarmId`，不同账号和告警不会共享条目。
- copy-in/copy-out 阻止外部 `Uint8Array` 修改缓存内部 payload。
- `clearGuardian()` 只清目标账号；登录账号切换、401、403 和登出使用 `clearAll()`。

## HTTP

- Token 只通过既有 `Authorization: Bearer ...` 请求头交给 HarmonyOS 网络 API。
- Token 不进入 URL、查询参数、错误信息或应用日志。
- 未读取、导出或输出 Asset Store Token、密码、Cookie、Authorization 或 AppSecret。
- 响应头按实际键进行 ASCII 大小写不敏感匹配，兼容字符串和字符串数组。
- 重复响应头只有在值完全相同时才接受；冲突 Content-Type/Content-Length 拒绝。
- 仅接受 `image/jpeg`（允许媒体类型参数），不接受泛化的 `image/*`。
- 非法、负数、冲突、非安全整数或超过 2 MiB 的 Content-Length 拒绝。
- 实际 payload 独立执行 2 MiB、SOI/EOI 检查，不能仅靠响应头绕过。
- 缺少 Content-Type 时拒绝；缺少 Content-Length 时仍依赖实际 payload 安全校验。

## 本轮操作边界

- 未访问公网 backend，包括匿名探测和认证请求。
- 未安装候选 HAP，未读取真机账号或证据图片。
- 未创建账号、绕过登录、制造告警或上传人工证据。
- 未修改公网 backend、DNS、生产数据、DAYU、ESP32、Wi-Fi 或 AP。
- 交付目录不含真实 Token、Cookie、个人身份图片或设备密钥。
