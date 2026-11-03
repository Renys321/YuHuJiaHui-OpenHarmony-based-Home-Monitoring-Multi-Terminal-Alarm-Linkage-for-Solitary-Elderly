# CAMERA-A：手机 APP 查看 FALL 告警证据 JPEG

日期：2026-10-25（Asia/Shanghai）

## 结论

```text
CAMERA_A_LOCAL_BUILD_PASS_REAL_ACCEPTANCE_BLOCKED
```

本轮完成手机 APP 的私有 FALL 证据 JPEG 下载、内存解码、详情页显示、取消、释放、
错误分类、主动重试和账号隔离缓存；生成了独立候选 HAP。未部署公网 backend，未安装
候选 HAP，未制造告警、上传证据或触发 FALL/SOS/ACK/reset。

真实验收受阻：既有正式 APP 启动后停在登录页，安全会话已经失效；当前环境没有可用
监护人账号口令，因而不能使用项目既有认证方式读取公网 `/api/v1/alerts`，也无法确认
公网是否已有真实 FALL + `evidenceAvailable=true` 数据。匿名请求只能证明 HTTPS 和统一
鉴权门存在，不能证明证据路由已部署。

## 事实边界

- P1-A 仅完成 DAYU 本机人物检测和 17 点 Pose 输出。
- P1-A 响应仍为 `fall=false`、`fallEvaluated=false`；姿态语义、跌倒状态机和 FALL 检测未实现。
- 本任务消费 backend 已有的 FALL 证据合同，不实现或宣称新的 FALL 检测。
- 本任务不包含实时视频、低帧率预览、WebRTC、HLS、RTSP、MJPEG、4G 或 OneNET 改造。

## 四级证据

| 证据等级 | 结果 | 依据 |
| --- | --- | --- |
| 本地源码存在 | PASS | backend `server.js` / `evidence-store.js` 含私有元数据和 JPEG content 路由 |
| 本地自动化测试通过 | PASS | APP Node 198/198、Hypium 21/21、backend 215/215、restart 2/2 |
| 公网接口已部署 | NOT PROVEN | 公网健康 200；匿名 alerts/content 均 401；无有效会话，不能区分路由版本 |
| APP 真实显示 | BLOCKED | 未安装候选；无真实会话与真实 FALL 证据，未做手机端 JPEG 实显 |

## 十四项回答

1. 公网 backend 是否真实提供证据接口：**未能证明**。只证明公网 HTTPS 服务和鉴权门在线。
2. 使用的是本地测试还是真实公网接口：实现验收使用本地自动化；公网仅做无秘密只读匿名探测。
3. APP 是否使用现有 Bearer 会话：**是**，由 `GuardianService` 捕获当前 `SessionCore` ticket。
4. Token 是否完全不进入 URL 和日志：**是**；仅由 transport 写入 `Authorization` 请求头，代码不打印头或正文。
5. 图片是否只在 APP 内存显示：**是**；压缩 JPEG 仅进程内缓存，PixelMap 仅页面持有；不写文件、相册或 Asset Store。
6. 非 FALL 和无证据告警是否隐藏入口：**是**；另要求 alarmId 通过白名单格式校验。
7. 401/403/404/超时：401 提示会话过期；403 提示无家庭权限；404 显示“证据暂不可用”；超时显示失败并允许主动重试；均不无限重试。
8. 是否发生跨告警串图：本地测试未发生；缓存 key 含 alarmId，响应提交前再次核对 alarmId/requestId。
9. 是否发生跨账号缓存：本地测试未发生；缓存 key 含 guardianId，登录切换、401/403、登出均清缓存。
10. 是否修改或部署公网 backend：**否**。
11. 是否真实安装候选 HAP：**否**；不具备真实验收前提，保留 P0 安装不动。
12. 是否在手机 APP 真实看到证据 JPEG：**否**。
13. P0 是否保持正常：P0 源码/正式 HAP/回退包/DAYU 制品均未覆盖；公网健康仍为 200。
14. 当前结论：`CAMERA_A_LOCAL_BUILD_PASS_REAL_ACCEPTANCE_BLOCKED`。

候选 HAP：`guardian-camera-a-fall-evidence-2026-10-25.hap`

```text
size=2,143,369 bytes
sha256=BCAA21B2452D545611E7198FB5CE8C58B27D7863BC799C1BB5D1DB2ADEA54F7C
```
