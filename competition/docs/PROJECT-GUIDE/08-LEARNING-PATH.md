# 08 · 学习路径：怎么从零读懂/改懂这个项目

> 这个项目横跨嵌入式、系统、网络、云、前端、算法六块，**不要按目录顺序读**。
> 下面是按"能跑 → 能读 → 能改 → 能讲"设计的四阶段路线。

---

## 阶段 0 · 先把环境装对（半天）

| 需要 | 版本/路径（本项目实测） | 用途 |
|---|---|---|
| ESP-IDF | v5.1.6，`D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6` | 编译三块 ESP32-S3 |
| Node.js | `D:\Node\node.exe`（v24 亦可） | bridge/云/视频 |
| DevEco Studio | `D:\DevEcoStudio`（含 hvigor、jdk、模拟器、hdc） | 两个 ArkTS APP |
| hdc | `<WORKSPACE>\tools\hdc\hdc.exe`（或 DevEco 自带） | 板端/模拟器调试 |
| Python | 3.10+（视觉基线用 `.venv-vision`） | YOLO/NCNN |
| Docker（可选） | ECS 侧 compose | 云后端 |

**先验证工具链**（不碰业务）：
```powershell
idf.py --version                      # 期望 ESP-IDF v5.1.6
D:\Node\node.exe -v                   # v20+
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' --version
& <WORKSPACE>\tools\hdc\hdc.exe list targets
```

---

## 阶段 1 · 先跑通，再读代码（1 天）

按 `materials/BOOT-RUNBOOK.md` 走一遍冷启动，并**逐段验证**：
1. `watcher-state.json` 出现 `p0=healthy / nodes=4/4`；
2. MQTT 订阅 `home/#` 能看到 3 个 `status` 主题（客厅/厨房/卫生间）；
3. 手机 APP 看到 4 个房间、实时监测页有燃气/烟雾 ADC；
4. 手机 APP 对一条告警点"确认闭环"，看到状态转 `ACKED`。

> 为什么要先跑通：本项目大量"状态语义"（在线 12s、4/4 口径、ACK 闭环）只有看到实物才好理解。

---

## 阶段 2 · 按数据流读代码（3–5 天）

**顺序：一条链读到底，不要按目录读。**

### 路线 A（推荐）：一条告警的完整旅程
```
ESP32 采样判定 → homemon/bridge → MQTT → public-sync → ECS → APP 展示 → ACK 回流
```
| 步骤 | 读什么 | 读到什么程度 |
|---|---|---|
| ① 采样/判定 | `firmware/common/components/elder_node/alarm_logic.h`（先读这个纯逻辑 header） | 能说清"连续 N 次 + 回差"如何防抖 |
| ② 上报 | `node_main.c` 的 `report_status()` / `gw_send()`（用 `firmware/docs/CODE-WALKTHROUGH.md` 定位行号） | 能画出 JSON 字段与 5s 节拍 |
| ③ 桥接 | `bridge/mqtt_bridge.js`：`attachNode` / `publishStatus` / `tcp_broadcast` | 能说清 deviceId 绑定与 `relay-ignore` |
| ④ 上云 | `cloud/onenet/cloud-sync.js` + `public-sync-worker.js` | 能说清 202/失败重试/限频 |
| ⑤ 后端 | `cloud/backend/src/server.js` 的 `/internal/v1/device-status` 与 `/api/v1/devices` | 能说清存储与鉴权 |
| ⑥ APP | `APP/.../core/api/ApiClient.ts` → `ViewMapper.ts` → `pages/MonitorPage.ets` | 能说清 DTO→ViewModel→组件 |
| ⑦ ACK | APP 的 `pendingAckId` + `homemon.c` 的 `ack` 分支 | 能说清"为什么 HTTP 成功≠闭环" |

### 路线 B：一条命令的旅程（route/relay）
APP 下发 → `route <deviceId> <cmd>` → homemon（本机执行 or 广播）→ bridge 转发 → 节点执行 → 状态回流。

### 路线 C：视频/视觉（可选）
`vision/fall_detector.py` 的规则状态机 → `fall` 受限事件 → `homemon` 告警；
`video/relay/src/relay.js` + `dayu-link.js` 的会话与帧流转。

> 每读完一段，回到 `01-ARCHITECTURE.md` 的对应数据流图，确认自己能复述。

---

## 阶段 3 · 动手练习（按难度递增）

| # | 练习 | 改哪里 | 验证 |
|---|---|---|---|
| 1 | 给节点状态加一个字段（如 `rssi`） | `node_main.c` 的 JSON 拼装 + APP `Models.ts` | MQTT 报文与 APP 都能看到 |
| 2 | 改上报周期 5s→2s | `<node>/sdkconfig.defaults`（删 `sdkconfig` 重建） | 报文间隔变化、云端限频仍生效 |
| 3 | 加一种告警（如水漏） | `alarm_logic.h` 判定 + 优先级两处 + 语音片段 + APP 映射 | 触发后声/光/语音/APP 卡片 |
| 4 | 写一个 bridge 订阅者（第二终端） | `bridge/mqtt_tool.js` | 同一条告警两个订阅端都收到 |
| 5 | 给后端加一个只读 API | `cloud/backend/src/server.js` + `docs/APP-API-v1.md` | curl 通过、APP 调通 |
| 6 | 给 APP 加一张统计卡 | `pages/StatsPage.ets` + `GuardianService.ets` | 页面渲染 + 空态正确 |
| 7 | 为 `alarm_logic.h` 补一个单测 | `esp32-node/test/host_alarm_logic_test.c` | 主机 gcc 跑过 |
| 8 | 把 `route` 做成带签名 | `bridge/mqtt_bridge.js` + 节点校验 | 伪造命令被拒 |
| 9 | 把主通道从 USB 切到 LAN | bridge `--status-tcp` 指板端 IP | 拔 USB 仍 4/4 |
| 10 | 视觉误报评估 | `vision/test_fall_*.py` 样本集 | 给出召回/误报表 |

> 练习 1–3 需要烧板；4–6 只动 PC/APP；7–8 纯代码+测试；9 是本周最值得做的可靠性改造。

---

## 阶段 4 · 分角色最短路径

| 角色 | 必读 | 可跳过 | 上手任务 |
|---|---|---|---|
| 嵌入式/物联网 | `02-DEVICE.md` + `firmware/docs/CODE-WALKTHROUGH.md` + `NODES.md` | 云后端内部实现 | 练习 1/2/3 |
| 后端/云 | `04-TRANSPORT-CLOUD.md` + `docs/APP-API-v1.md` | ESP-IDF 细节 | 练习 5/8 |
| 前端/鸿蒙 | `03-APP.md` + `APP/.../core/*` | C 固件 | 练习 6 |
| 算法/视觉 | `05-VISION-VIDEO.md` 视觉章节 + `vision/README.md` | 云/设备 | 练习 10 |
| 测试/答辩 | `01-ARCHITECTURE.md` + `docs/VALIDATION-MATRIX.md` + `KNOWN-RISKS.md` | 具体实现 | 复述 6 条数据流与故障域 |

---

## 阶段 5 · 怎么讲（答辩/汇报用）

- **一句话**：设备层采集 → 边缘层判定/声光 → 桥接/云 → 多端告警 + 设备级 ACK 闭环。
- **三个技术亮点**：①设备无 MQTT、行协议统一（易扩展多节点）；②视觉只提交受限事件（误报不污染告警）；
  ③ACK 必须设备确认（HTTP 成功≠闭环）。
- **三个已知边界**（主动说）：局域网无 TLS/设备鉴权；fport/Wi-Fi/ECS 三个单点；传感器未标定。
- **不要说的话**：AI 跌倒已验收、燃气 ppm/安全、三节点同时在线、消息不丢。

---

## 常见误区（新手最容易踩）

1. 把 `evidence/` 里旧报告当"当前状态"——它以 `docs/VALIDATION-MATRIX.md` 为准，且带日期。
2. 把 APP 的 `4/4` 当在线探针——它是板载 APP UI 文本正则，最坏陈旧 30s。
3. 把 `HTTP 202` 当告警已处置——必须等设备回报 `ACKED`。
4. 把 `node:test`/mock 测试当"真机已验收"——测试只证明协议与逻辑。
5. 改了 `sdkconfig.defaults` 就以为生效——必须先删 `<node>/sdkconfig` 再构建。
6. `.ps1` 存成无 BOM 的 UTF-8 → PowerShell 5.1 解析中文注释报错。

---

## 学习资源（按主题）

- **ESP-IDF/FreeRTOS**：ESP-IDF Programming Guide（Build System、FreeRTOS、ADC oneshot、I2S、NVS）、《Mastering the FreeRTOS Real Time Kernel》
- **网络协议**：MQTT 3.1.1 规范（OASIS）、TCP 粘包/半包与分帧、WebSocket RFC6455
- **OpenHarmony**：ArkTS/ArkUI 官方文档、`@ohos.net.http` / `@ohos.net.webSocket`、HAP 签名与 hdc
- **云与安全**：OneJSON 物模型、MQTT over TLS、证书指纹固定、token 与幂等设计
- **视觉**：Ultralytics YOLO-Pose 文档、NCNN/RKNN 部署、时序动作判定（比单帧分类更稳）
- **工程化**：Docker Compose、Caddy 自动 TLS、`node:test`、PowerShell 脚本健壮性
