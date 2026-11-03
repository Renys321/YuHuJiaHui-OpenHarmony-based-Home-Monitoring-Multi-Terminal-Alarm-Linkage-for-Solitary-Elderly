# APP 实现

## 调用链

```text
AlertDto.evidence
  -> ViewMapper.mapAlert
  -> AlertView
  -> AlertDetailPage.canViewEvidence
  -> GuardianService.loadEvidence
  -> ApiClient.evidence
  -> HarmonyHttpTransport (Authorization header, ARRAY_BUFFER)
  -> ImageSource.createPixelMap
  -> AlertDetailPage Image(PixelMap)
```

## 关键行为

- `EvidenceCore.ts`：入口资格、alarmId 白名单、JPEG/媒体类型/2 MiB 校验、取消令牌、账号隔离内存缓存。
- `HttpTransport.ts`：增加二进制响应、Content-Type/Length、取消和响应大小合同。
- `HarmonyHttpTransport.ets`：`Accept: image/jpeg`、`ARRAY_BUFFER`、`maxLimit=2 MiB`、取消时 `destroy()`。
- `ApiClient.ts`：构造受保护路径，分类 HTTP/超时/取消，拒绝非 JPEG 和超限 payload。
- `GuardianService.ets`：复用当前会话 ticket，防止旧账号迟到响应回写；登出/切换/鉴权失效清缓存。
- `AlertDetailPage.ets`：显式“查看证据”、加载/成功/失败/重试状态；页面退出取消请求并释放 PixelMap。

图片不会进入 TokenVault/Asset Store、Preferences、数据库、普通文件或公共媒体库。
证据失败状态独立于 `gv.alerts` 和 ACK 状态机，不会清空告警文本，也不会提交 ACK。

## 修改文件

```text
APP/ElderlyCareGuardian/entry/src/main/ets/core/evidence/EvidenceCore.ts (new)
APP/ElderlyCareGuardian/entry/src/main/ets/core/api/HttpTransport.ts
APP/ElderlyCareGuardian/entry/src/main/ets/core/api/Errors.ts
APP/ElderlyCareGuardian/entry/src/main/ets/core/api/ApiClient.ts
APP/ElderlyCareGuardian/entry/src/main/ets/core/service/Outcomes.ts
APP/ElderlyCareGuardian/entry/src/main/ets/net/HarmonyHttpTransport.ets
APP/ElderlyCareGuardian/entry/src/main/ets/service/GuardianService.ets
APP/ElderlyCareGuardian/entry/src/main/ets/pages/AlertDetailPage.ets
APP/ElderlyCareGuardian/tests/fake-transport.mjs
APP/ElderlyCareGuardian/tests/evidence.test.mjs (new)
```
