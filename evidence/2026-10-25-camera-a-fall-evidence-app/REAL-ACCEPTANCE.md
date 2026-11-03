# 真实验收

## 状态

```text
BLOCKED - no active authenticated session and no verified real FALL evidence
```

2026-10-25 启动既有 `com.example.program_04` 后，APP 显示真实账号登录页，说明原安全会话
不可用。环境中没有 `APP_GUARDIAN_ID` / `APP_GUARDIAN_PASSWORD`，没有从 Asset Store 导出
Token，也没有要求或记录用户秘密。

因此以下项目未执行：

- 使用同一真实账号查询公网 alerts；
- 判断公网真实 FALL 是否存在、`evidenceAvailable` 是否为 true；
- `install -r` 安装 CAMERA-A 候选；
- 在 AlertDetailPage 点击“查看证据”并确认真实 JPEG；
- 返回列表后验证真实运行时资源释放，再次进入复载。

未制造生产告警、未手工上传证据、未触发 FALL/SOS/ACK/reset。也不能把匿名 401 误判为
“证据路由已部署”或“证据路由缺失”。若后续在有效会话下对一个确实存在且有证据的
alarmId 返回 404，必须结合 `/api/v1/alerts` 的真实记录区分：告警不存在、证据缺失、
部署版本缺少路由或家庭无权限；不得加假图兜底。

当前不是 `CAMERA_A_PUBLIC_BACKEND_ENDPOINT_MISSING`，因为没有经过认证得到可归因的 404。
当前也不是 `CAMERA_A_REAL_PASS`，因为未在候选 APP 中真实显示 JPEG。
