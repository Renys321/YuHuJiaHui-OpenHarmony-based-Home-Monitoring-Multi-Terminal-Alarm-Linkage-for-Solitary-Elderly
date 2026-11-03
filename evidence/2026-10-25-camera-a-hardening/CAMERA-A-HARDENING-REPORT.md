# CAMERA-A-HARDENING 报告

## 结论

```text
CAMERA_A_LOCAL_BUILD_PASS_REAL_ACCEPTANCE_BLOCKED
```

本轮仅修复 CAMERA-A 的内存缓存上限/所有权和 HTTP 响应头兼容性。所有规定的本地测试、
ArkTS 平台编译和 HAP 构建均通过；候选未安装，未访问公网鉴权接口，未修改或部署公网
backend，未改生产数据。

本结论没有升级为 `CAMERA_A_REAL_PASS`。缺少真实账号会话、公网鉴权后接口部署确认、真实
FALL 告警及其精确绑定证据、候选真机安装和 APP 真机显示验收。

## 修复结果

### 1. EvidenceMemoryCache

- key 仍由 `guardianId + alarmId` 组成，账号和告警严格隔离。
- 最大条目数：`6`。
- 最大总 payload：`12 MiB`（`12,582,912` 字节）。
- 使用 `Map` 插入顺序实现确定性 LRU；队首为最久未使用项。
- `get()` 命中后删除并重新插入，使其成为最近使用项。
- `put()` copy-in，`get()` copy-out，调用方不能修改缓存内部数组。
- 单条超过缓存总容量时拒绝缓存；既有单 JPEG `2 MiB` 上限仍保留。
- 同 key 替换会先扣除旧字节，再写入新副本并更新 LRU。
- `clearGuardian()` 精确扣减该账号条目和字节；`clearAll()` 同时归零条目和字节。
- 登录账号切换、401、403 和登出仍调用全量内存清理。

### 2. HTTP 响应头

- 新增纯逻辑解析器，枚举实际响应头键并使用
  `key.toLowerCase() === requestedName.toLowerCase()` 匹配。
- 兼容字符串值和字符串数组值。
- 重复且相同的值可接受；空值或冲突值保守拒绝。
- `image/jpeg` 和带参数的 `image/jpeg; charset=binary` 可接受；其他 `image/*` 仍拒绝。
- `Content-Length` 缺失与无效被分别表示。
- 非十进制、负数、非安全整数或冲突长度均拒绝；超过 `2 MiB` 拒绝。
- 即使头部合法，实际 payload 仍检查 `2 MiB`、JPEG SOI 和 EOI。
- Bearer 仍只由平台传输层写入 `Authorization` 请求头，未进入 URL、查询参数或日志。

## 范围边界

- 没有新增或声称 FALL 检测。P1-A 仍只具备 DAYU 本机人物检测和 17 点 Pose 输出；当前
  `fall=false`、`fallEvaluated=false`，姿态语义、跌倒状态机和 FALL 检测仍未完成。
- 没有实现低帧率预览、MJPEG、RTSP、HLS、WebRTC 或 CAMERA-B。
- 没有把本地测试写成公网或真机验收。

## 新候选

```text
文件：guardian-camera-a-hardening-2026-10-25.hap
类型：unsigned debug HAP
大小：2,156,555 bytes
SHA-256：15126D26CD790780F90B88D405286F2038B6A61FD166329576D6EFDDB390BC35
安装：否
```

完整测试结果见 `TEST-RESULTS.md`，真实验收阻塞项见 `REAL-ACCEPTANCE.md`。
