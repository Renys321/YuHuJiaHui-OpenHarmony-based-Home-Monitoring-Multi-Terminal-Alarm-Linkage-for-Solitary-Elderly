# DAYU200 三节点显示恢复报告

日期：2026-10-25
分类：`DAYU_THREE_NODE_RECOVERY_PASS`
对象：DAYU `com.dsh.eldercare` 1.0.2/1000002
证据目录：`<WORKSPACE>\competition\evidence\2026-10-25-dayu-three-node-recovery`

## 0. 结论

**三节点已真实恢复：**

```text
dayu200-living  → 客厅
esp32-kitchen   → 厨房
esp32-bath      → 卫生间
```

页面显示“全屋在线 **3/3**”，三个房间标签均出现；厨房/卫生间显示各自自然数据，客厅保留摄像头预览；厨房/卫生间遮罩客厅画面。连续 5 分钟采样中三节点的 Bridge 转发与 supervisor cloud-sync 均持续增长，无掉线。

本任务未改 HAP、未改源码、未重启 DAYU 应用；恢复的是正式演示服务与 fport。

## 1. 为什么之前只有一个节点

启动前只读检查：

- DAYU 本机 `homemon` 在 9000 LISTEN，页面能通过 **本机 127.0.0.1:9000** 看到 `dayu200-living`；
- PC `1883`（Broker）、`9101`（Bridge）、`9001` 均 **NO-LISTEN**；
- `hdc fport ls` 为 `[Empty]`；
- supervisor/worker/broker/bridge 进程均不存在；
- 因此厨房/卫生间无线节点没有 Bridge 接收与 fport 转发入口，页面只剩本机客厅节点。此前正式页布局证据也显示只有 `dayu200-living`。

这不是“硬件接上自然会送达”；根因是 **PC 侧正式演示链路未运行 + fport 缺失**，而非先改 Wi-Fi/ESP32。

## 2. 实际启动/恢复的服务与映射

用户从 Explorer 双击正式入口：

`<WORKSPACE>\competition\materials\start-demo-supervisor.cmd`

并在可见窗口本机隐藏输入 `INGEST_KEY`；密钥未进入聊天/报告/日志。

恢复后的实际状态：

| 组件 | 状态 |
|---|---|
| MQTT Broker | 1883 LISTEN，pid 8244 |
| Bridge | 9101 LISTEN，pid 33688；2 个无线连接 |
| supervisor | pid 11632，state `HEALTHY`，restartCount 0 |
| worker | pid 9908 |
| HDC fport | `tcp:9001 → tcp:9000`（DAYU） |
| DAYU homemon | 9000 LISTEN（既有冻结进程） |
| 9200 / 模型 | 未启动（本任务不需要） |
| supervisor lock | 有效，无 stale lock；未删除 |

没有重复实例；Broker/Bridge/supervisor/worker 各一个；没有强杀健康实例。

## 3. 厨房/卫生间自然接入

Bridge 9101 的 2 个自然 TCP 对端：

- `10.127.130.168:59889`
- `10.127.130.71:58810`

Bridge 日志持续出现：

```text
home/esp32-kitchen/status ...
home/esp32-bath/status ...
```

对应设备身份：

| 设备 | deviceId | 房间 | 页面数据 |
|---|---|---|---|
| 客厅 | `dayu200-living` | 客厅 | 本机摄像头、门窗/人体传感器 |
| 厨房 | `esp32-kitchen` | 厨房 | 温度 25.1 ℃、湿度 61.0%、燃气原始 ADC 4095、烟雾原始 ADC 43（页面标注“报警未启用”） |
| 卫生间 | `esp32-bath` | 卫生间 | 温度 26.6 ℃、湿度 57.4%、今日活动 2 次（PIR 历史活动，未主动触发） |

未手工发布 MQTT、未发送 HTTP ingest、未修改设备绑定；以上均来自自然报文。

## 4. 页面显示与数据独立性

- 页面顶部：`客厅 · 全屋在线 3/3 台设备`；
- 三个房间标签：**客厅 / 卫生间 / 厨房**；
- 切换后标题分别变为：
  - `客厅 · 已选设备在线 · dayu200-living`
  - `卫生间 · 已选设备在线 · esp32-bath`
  - `厨房 · 已选设备在线 · esp32-kitchen`
- 各房间数据不同，未出现客厅数据复制到其他房间：
  - 卫生间温湿度/活动次数与厨房不同；
  - 厨房显示自己的燃气/烟雾原始 ADC；
  - 客厅显示自己的门窗/人体传感器和摄像头。

## 5. 摄像头遮罩

- 选中 **卫生间**：显示“该房间未配置摄像头”，无客厅画面；
- 选中 **厨房**：显示“该房间未配置摄像头”，无客厅画面；
- 选中 **客厅**：客厅摄像头预览正常；预览 1.0.2 的可调宽度/高度与持久化设置仍在（当前 preference `widthPct=60, scalePct=130`）。

## 6. 5 分钟持续更新

从 2026-10-25T22:29:15 到 22:34:15，共 **10 个 30 秒样本**，日志文件 `stability-5min.log`：

| 节点 | Bridge 行数起→止 | supervisor cloud-sync 起→止 |
|---|---|---|
| dayu200-living | 36 → 126 | 3 → 12 |
| esp32-kitchen | 19 → 69 | 3 → 11 |
| esp32-bath | 19 → 70 | 3 → 12 |

每 30 秒三节点都有新增转发；没有节点掉线。期间页面数据也发生自然变化（卫生间 26.8→26.6 ℃、厨房 25.0→25.1 ℃、烟雾 ADC 44→43），证明不是 retained 固定快照。

## 7. 正式 HAP 与数据保持

- 正式 HAP：`/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap`
- 版本：`1.0.2 / 1000002`
- 大小：**1,883,399 B**
- SHA-256：**`A696698A627CFEEE1EE90D4F94A3FAF49B4A2F1BB8A2D813CA3AD245324DAFFE`**
- 与任务要求的正式 1.0.2 完全一致；本任务未重新安装、未替换 HAP。
- 应用进程 PID 9392，未重启；预览设置 preference 仍为 `scalePct=130, widthPct=60`。
- 独立 previewtest 应用仍停止，未抢相机。
- 原 ALARM 保留（页面“异常告警”），未自动 ACK。

## 8. 公网同步

- supervisor `HEALTHY`；
- cloud-sync 对三个节点均返回 `status=202`：
  - `dayu200-living`
  - `esp32-bath`
  - `esp32-kitchen`
- 最新日志持续有新 `deviceTs`，无独立公网同步阻塞。
- 未操作 backend/DNS/Wi-Fi/AP/设备绑定。

## 9. 修改、重启与恢复操作

- **未修改应用源码，未重新安装/替换 DAYU HAP，未重启 DAYU 应用**。
- 执行了正式入口启动（Broker/Bridge/supervisor/worker）与既有 HDC fport 恢复。
- 未删除有效 lock，未强杀健康实例。
- 未操作串口/COM，未烧录 ESP32，未触发 SOS/FALL/ACK/reset。
- 无代码级最小修复需求；根因是服务/映射未运行。

## 10. 仍需用户处理

当前请**保持 `start-demo-supervisor.cmd` 可见窗口打开**；supervisor 依赖该窗口/进程。若关闭窗口，厨房/卫生间链路会再次停止。

除此之外无现场阻塞；三节点已恢复。

## 11. 证据

- `three-node-final2.jpeg`、`three-node-overview.jpeg`
- `before-only-living-layout.json`
- `room-kitchen2.json`、`room-bath.json`、`final-kitchen.json`、`final-bath.json`
- `kitchen-camera.json`、`living-camera-check.json`
- `stability-5min.log`
- `bridge-final.log`、`broker-final.log`、`supervisor-final.log`
- `supervisor-final-state.json`
- `formal-1.0.2-current.hap`
- `final-state.txt`
- `SHA256SUMS.txt`
