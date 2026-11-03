# living 链路恢复与 8A722 手机候选最终验收（2026-10-23）

状态：**PASS（真实自动恢复）**。本轮未修改手机代码；只恢复 DAYU 既有 homemon/HDC forward，随后安装已平台通过的 `8A722…` 并完成同进程真实断电/恢复。

## 1. living 第一个断点

只读检查顺序与结果：

| 检查点 | 结果 |
|---|---|
| DAYU 目标/时钟 | 可达；`01:03 CST 2026`，时间正确；uptime 当时约 200s |
| DAYU 原版 homemon | **未运行**；`ps` 无 `homemon` |
| DAYU 9000 | **未监听** |
| 原程序身份 | `/data/homemon/homemon`，164,276 B，SHA-256 `0D243539…42881E6`，与既有原版一致 |
| HDC forward | **`fport ls` 为空**，PC 无 9001 监听 |
| Bridge | 进程在，但 status-tcp `127.0.0.1:9001` 持续连接失败 |
| kitchen/bath | MQTT/202 持续正常（走 Bridge 9101） |

**第一断点：DAYU 重启后既有 homemon 没有运行，同时 HDC `tcp:9001→tcp:9000` forward 丢失。**  
不是 living 数据本身停更，也不是 Bridge 或 public-sync 主动断流。DAYU 为什么重启/为何没有自启，本轮未完全确定；只确认恢复动作有效。

## 2. 最小恢复动作

- 只使用原程序、原配置启动：
  `cd /data/homemon && ./homemon homemon.conf`
- 只重建既有 forward：
  `hdc -t 450100… fport tcp:9001 tcp:9000`
- 未重启 Broker；未重启 Bridge；未重启 public-sync；未修改 homemon 二进制/配置。
- 恢复后 Bridge 自动接入 `127.0.0.1:9001`，living 开始产生新 202。

恢复时间线（public-sync）：

```text
16:54:50Z  dayu200-living 新 202（恢复后第一条）
16:55:20Z / 16:55:50Z / 16:56:21Z  living 连续新 202
16:55/16:56 kitchen、bath 同期持续新 202
17:02:12Z / 17:02:45Z  bath 在手机恢复验收期间继续新 202
17:03:33Z living 最新 202
```

三节点均连续至少三个自然周期；无重复 public-sync 实例。

## 3. 8A722 候选与基线

```text
guardian-inline-summary-formal.hap
2,077,912 B
SHA-256 8A722EB6FDA7BB73EE58F3BDA3D95B5D238401DA8E3CC9179F1286FD5253A985
```

- 源码无测试按钮、无 revision、无 liveDevices；只保留“在线设备”摘要 `build()` 内联绑定。
- `install -r` 成功，保留数据/会话；手机 APP PID `13326`。
- 安装后首页/监测页均 3/5。
- 平台 A→B→C 已通过，保留在上一份证据中。

## 4. 真实断电/恢复（同一 APP 进程）

| 阶段 | 手机监测页 | 首页 | 说明 |
|---|---|---|---|
| 基线 | 3/5 | 3/5 | 三节点 202 正常，PID 13326 |
| 只断卫生间 | **2/5** | **2/5** | bath 离线；living/kitchen 在线 |
| 恢复卫生间供电 | **自动 3/5** | 3/5 | 未手动刷新/跳转/重启；PID 不变 |
| 切页返回 | 3/5 | 3/5 | 一致 |
| 手动刷新后 | 3/5 | — | 刷新成功 |

恢复后 card 证据：

```text
卫生间 · 刚刚  24.2°C · 51%RH
```

- 自动恢复采样时间：约 01:02 CST；PID 始终 `13326`。
- bath 恢复期间新 202：16:57:49Z、16:58:25Z、17:02:12Z、17:02:45Z；更晚仍有新 202。
- 离线时为 2/5（living/kitchen 在线、bath 离线），符合实际在线集合；不是此前的 1/5 混杂状态。
- 本轮未发生 APP 重启；未用重启后的正确值替代自动恢复。

## 5. 服务与最终状态

```text
Broker PID 6540 / 1883
Bridge PID 13508 / 9101
public-sync 32584 + 30216（一个逻辑实例）
fport tcp:9001 -> tcp:9000
DAYU homemon PID 2442，0.0.0.0:9000 LISTEN
手机 HAP 8A722…，APP PID 13326
```

- 当前手机：首页 3/5、监测页 3/5；bath 最新自然读数 24.2°C/51%RH。
- 回退包：8F `8F8925…F769F` 保留。
- 未修改 backend/gateway/Broker/Bridge/public-sync/homemon/ESP32/Wi-Fi/AP/绑定；未部署 homemon 新候选；未触发 SOS/ACK/reset。

## 6. PASS / FAIL / BLOCKED / NOT TESTED

| 项目 | 结果 |
|---|---|
| living 第一断点定位 | **PASS**：DAYU 重启后 homemon 未运行 + fport 丢失 |
| 最小恢复（原 homemon + forward） | **PASS** |
| 三节点连续自然上报 | **PASS** |
| 8A722 安装/会话保留 | **PASS** |
| 同进程自动离线 2/5 | **PASS** |
| 同进程自动恢复 3/5 | **PASS** |
| 切页/手动刷新 | **PASS** |
| 平台 A→B→C | **PASS（SIMULATED，保留）** |
| DAYU 摄像头切换 | **NOT TESTED（本轮未重测）** |
| SOS/ACK | **NOT TESTED** |
| 后端/设备/固件修改 | **未修改** |

## 7. 结论

living 中断由 DAYU 重启后的既有 homemon 未运行与 HDC forward 丢失共同造成；局部恢复后三节点自然上报稳定。  
`8A722…` 在真实、同一 APP 进程内完成 `3/5 → 2/5 → 自动 3/5`，摘要与卡片同步，切页/手动刷新一致，因此可由平台 PASS 升级为最终手机候选。  
未确定 DAYU 重启触发原因，不做超出“恢复动作有效”的归因。
