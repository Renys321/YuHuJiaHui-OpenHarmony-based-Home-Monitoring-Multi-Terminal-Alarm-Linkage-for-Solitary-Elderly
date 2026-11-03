# 安全与隐私

## 已证明（本地源码与自动化）

| 要求 | 证据 |
| --- | --- |
| 未登录不能下载 | APP 空 token 不发请求；backend 无 Bearer 返回 401 |
| 非家庭用户不能下载 | backend 允许名单移除后 token 立即失效；证据测试中其他家庭返回 403 |
| 不同 alarmId 不串图 | backend 精确告警绑定；APP 缓存 key 和提交校验均含 alarmId |
| evidenceId 防路径遍历 | 严格 `EVIDENCE_ID_RE`；`../escape` 自动化测试拒绝 |
| private/no-store | backend 本地 HTTP 测试断言 `private, no-store` |
| URL 无 Token | APP 路径只含编码 alarmId；本地测试断言 token 不在 path/query |
| 不写公共媒体库 | 无 MediaLibrary/PhotoAccessHelper 调用；仅 ArrayBuffer/Uint8Array/PixelMap |
| 不把图片写 Asset Store | TokenVault 只保存会话；证据缓存为静态进程内 Map |
| 失败不影响告警/ACK | 证据状态只在详情页与独立 outcome；未修改 ACK 状态机 |
| 图片不进入日志 | 没有记录 response body、PixelMap、请求头或图片 URL 的代码 |

## 生命周期

- 页面离开：取消未完成请求，递增 requestId，迟到结果不能回写；释放 PixelMap。
- alarmId 切换：取消旧请求、释放旧 PixelMap、清页面状态。
- 登出/新登录/401/403：`clearBusinessData` 或 `logout` 清空全部证据内存缓存。
- 同账号同 alarmId：允许复用进程内压缩 JPEG，重新创建页面 PixelMap。

## 未证明

- 未使用真实公网会话验证生产允许名单与证据内容响应。
- 未在手机运行候选 HAP 验证平台运行时 PixelMap 释放和真实网络取消。
- 未对真实个人身份图片截图、导出或保存，交付目录不含此类内容。
