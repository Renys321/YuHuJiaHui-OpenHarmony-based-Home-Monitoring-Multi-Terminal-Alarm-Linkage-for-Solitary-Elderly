# 真实验收

## 当前状态

```text
CAMERA_A_LOCAL_BUILD_PASS_REAL_ACCEPTANCE_BLOCKED
```

本轮明确禁止安装候选、访问公网鉴权接口和执行真实验收，因此没有声称 APP 已在手机上显示
真实证据 JPEG。匿名 401 也没有在本轮执行，更不会被用来推断公网 route 存在或缺失。

## 未执行

- 未使用有效真实监护人账号会话。
- 未确认公网 backend 的鉴权后证据接口部署版本。
- 未查询或制造真实 FALL 告警。
- 未确认真实告警 `evidenceAvailable=true`。
- 未读取与该 `alarmId` 精确绑定的真实 JPEG。
- 未执行 `install -r`，候选 HAP 未安装。
- 未在手机 AlertDetailPage 打开并显示真实证据。
- 未做 401/403/404、退出释放、重新打开和账号隔离的真机验收。

## 升级为 REAL PASS 的必要条件

只有同时完成以下条件才可升级为 `CAMERA_A_REAL_PASS`：有效真实会话、公网鉴权后接口已部署、
真实 FALL 告警、`evidenceAvailable=true`、与 alarmId 精确绑定的真实 JPEG、候选真实安装、
手机真实显示该 JPEG，以及权限错误、资源释放与账号隔离的真机验证。

当前也不能分类为 `CAMERA_A_PUBLIC_BACKEND_ENDPOINT_MISSING`，因为本轮没有在有效会话和真实
告警上下文中获得可归因的公网结果。
