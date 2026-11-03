# 节点层体检 · 结论（FINDINGS）

- 体检窗口：2026-10-28 01:41–01:48 CST（演示在线、**全程只读**）
- 原始证据：同目录 `RAWMEMO.md`（命令输出/日志原文/时间戳）、`mqtt-sub-home.log`、`mqtt-tsprobe.log`
- 体检对象：supervisor 上报 `nodes=4/4` 的 4 个节点

---

## 一、先回答口径问题：`nodes=4/4` 数的是哪 4 个？

**4 个 deviceId = `dayu200-living` / `esp32-kitchen` / `esp32-bath` / `esp32-sos`。**

| 核查项 | 证据 |
|---|---|
| 4/4 从哪来 | **不是 MQTT、不是 bridge 连接计数**，而是 watcher 每 30s 从板端 APP 的 `uitest dumpLayout` 文本里正则抠 `全屋在线 N/M 台设备`（`demo-autostart.ps1:273-275`、`:554-561`），取不到就沿用上一次（`$script:lastUi`）→ **该指标是“APP 显示值”，最多可陈旧 ≥30s，不能当作独立在线探针** |
| 4 台是谁 | APP UI 文本列出 4 个房间：客厅 / 厨房 / 随身求助 / 卫生间；设备信息栏 `随身求助 / esp32-sos` → 对应 `dayu200-living`、`esp32-kitchen`、`esp32-bath`、`esp32-sos` |
| 交叉验证 | bridge 全量日志里去重只出现这 4 个 deviceId，无第 5 个；MQTT 只出现前 3 个主题 |

**是否包含 esp32-sos：包含。** 但它的“在线”不走 bridge/MQTT，而是走**板外旁路**（见第三节）。

---

## 二、逐节点结论表

| # | deviceId | 物理通道 | 在线判定 | 最近上报距今 | 上报间隔（中位 / 抖动σ / p95） | 当前 state / alarm | 断线恢复行为 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 1 | `esp32-kitchen`（厨房） | Wi-Fi，TCP 客户端 `10.127.130.168` → 本机 `10.127.130.179:9101`（bridge 监听） | **在线**：socket ESTABLISHED，绑定 01:01:13；01:44:00.7 重连后源端口 59409 | **3.3s**（17:46:20 基准） | 5.50s / σ 0.28s / 5.73s | **ALARM** / `NO_MOTION`（e-1793122274-1，countToday=1） | 固件自动重连：01:43:48.945 掉 → **01:44:00.687 重新绑定**（11.74s），无需人工，数据 31.8s 后恢复 | **PASS**（含 1 次已自愈共同断连；另见数据质量⚠） |
| 2 | `esp32-bath`（卫生间） | Wi-Fi，TCP 客户端 `10.127.130.71` → `10.127.130.179:9101` | **在线**：ESTABLISHED，绑定 01:01:13；01:44:01.9 重连后源端口 50040 | **3.2s**（17:46:20 基准） | 5.50s / σ 0.28s / 5.71s | **NORMAL** / 无告警 | 同上：01:43:48.231 掉 → **01:44:01.893 重新绑定**（13.66s），数据 33.8s 后恢复 | **PASS** |
| 3 | `dayu200-living`（客厅，板端 homemon） | `DAYU200 homemon`（PID 23655）→ hdc fport `127.0.0.1:9001` → 板端 `tcp:9000`；bridge 作为 ENDPOINT 接入 | **在线**：bridge↔9001 长连接自 01:01:12 未断；46 分钟 **0 错误 / 0 重连**；板端时钟与主机一致 | **2.4s**（17:46:20 基准） | 3.01s / σ 0.05s / 3.04s（最稳） | **ALARM** / `FALL`（a-1793120863-1，countToday=1，自 01:07:43 持续未清） | 自带 3s→30s 退避重连（`endpointReconnectDelay`），本次窗口**未触发** | **PASS**（FALL 长时间 ALARM 属业务态，见风险 R4） |
| 4 | `esp32-sos`（随身求助） | **非 bridge 网络节点**：`wearable-mirror`(PID 61116, source=api) → relay `127.0.0.1:9001` → 板端 homemon；bridge 在板端连接上收到其回灌后按 `--relay-ignore` 丢弃 | **在线（旁路判定）**：mirror relay `connected=true, connects=1, disconnects=0`，`linesSent=551`；`sourceStatus.online=true`；APP 显示“在线（本地 TCP 已连接）” | **≈2.5s**（mirror lastSentAt 01:46:32.9） | mirror 心跳 5s；bridge 收到 sos 回灌 ≈9 条/分（6–7s 节奏，逐分钟 7–11 条无空洞） | **NORMAL** / 无告警（`online=true`，gps=none） | relay 侧 0 断连；但 **01:46:17.7–01:46:27.6 出现约 9.9s `online=false` 抖动后自愈** | **DEGRADED**（旁路+外部 API 依赖；MQTT 可见性按指定口径记 **FAIL**，见第三节） |

量化补充（来自 65s 带到达时刻的只读订阅，01:46:23–01:47:28）：

| deviceId | 端到端延迟 min/中位/max | 相邻到达间隔中位 | 帧数 |
|---|---|---|---|
| dayu200-living | 204 / **211** / 229 ms | 3012 ms | 22 |
| esp32-kitchen | -86 / **-30** / 312 ms | 5502 ms | 12 |
| esp32-bath | -179 / **-95** / 330 ms | 5499 ms | 12 |
| esp32-sos | 无 MQTT 帧 | — | **0** |

> kitchen/bath 的中位为负 = ESP32 本地时钟略快于主机（kitchen≈+15ms、bath≈+130ms），非乱序；扣掉时钟差后无线段真实延迟 < 50ms。

---

## 三、esp32-sos 专节（Lead 指定核查项）

### 3.1 在哪个环节、用什么证据判“在线”

- **不在 MQTT / 不在 bridge**。sos 由 `cloud\wearable-mirror`（PID 61116）从公网 API `https://api.luxunacc.xyz`
  拉快照（`source=api`），再经 relay 长连接 `127.0.0.1:9001` 直接注入板端 homemon；APP 从 homemon 侧读到它。
- 在线证据链：`mirror-status.json` → `transports[relay].connected=true, connects=1, disconnects=0, linesSent=551`、
  `sourceStatus.online=true, polls=1016/ok=1015/errors=0`；APP UI “随身求助 · 已选设备在线 · esp32-sos”“最近上报 刚刚”。
- 板端侧连续收到注入帧：bridge 在板端连接上**成功解析后按设计丢弃**的 sos 帧 398 条（约 9 条/分，末条 01:47:07）。

### 3.2 最近一次“成功被系统接受”的状态

| 判据层 | 时刻 | 说明 |
|---|---|---|
| MQTT 主题 `home/esp32-sos/status` | **从未出现** | 两次订阅 104 条 status 中 0 条 sos；bridge publish 计数 0 |
| bridge 成功解析（随即按 `--relay-ignore` 丢弃） | **01:47:07.107** | 说明板端→bridge 的 sos 帧确实在流动 |
| 板端注入链路 mirror→9001→homemon | **01:46:32.875** | `lastSentAt`，disconnects=0 |
| APP 展示 | **01:46:46 的 UI dump** | “随身求助设备 · 在线”“在线状态 在线（本地 TCP 已连接）” |

### 3.3 “`home/esp32-sos/status` 收不到” → 按指定口径记 **FAIL**，但要说清根因

- **事实：MQTT 上确实没有 `home/esp32-sos/status`，两次订阅均为 0。**
- **根因不是故障，是 `--relay-ignore esp32-sos` 的有意设计**：sos 由板外 mirror 直连 homemon，若 bridge 再把它当节点接管/重发，
  会触发“改名冲突”事故（bridge 注释与 `bridge_auto_recovery.test.js:307` 记录了该旧缺陷），因此 bridge 只“看到并丢弃”。
- **对“随身求助”演示功能的真实影响 = 低**：演示链路是 `按钮 → mirror/API → homemon → APP`，不依赖 MQTT 的 sos 主题；
  本次观测到 APP 侧 sos 在线、最近上报“刚刚”，功能可用。
- **但存在三个真实缺口**（据此给节点 DEGRADED 而非 PASS）：
  1. **无法用 MQTT 独立验证 4/4 中的 sos**（节点层只能看到 3/4）；
  2. sos 的 online 来自**公网 API + mirror**，**单点且外部**——本次 01:46:17.7–01:46:27.6 实测掉线约 9.9s；
  3. bridge 对 sos 回灌帧**解析失败 54 次（1.2 次/分，100% 是 sos，其他节点 0 次）**——今天因“反正要忽略”而无害，
     但说明 homemon→bridge 的该路帧**偶发不成行**（最可能是多帧被拼成一行/被截断）；若同类问题发生在 kitchen/bath
     的板端回灌上会丢状态（当前 only sos 命中该路，风险受控）。

---

## 四、量化汇总（节点层稳定性）

| 指标 | 数值 |
|---|---|
| 节点在线数 | MQTT 侧 **3/4**（sos 无主题）；旁路 + APP 口径 **4/4** |
| 最近上报距今（体检时） | kitchen 3.3s / bath 3.2s / dayu200-living 2.4s / sos ≈2.5s（均远小于各自的 5s/3s/5s 节拍阈值） |
| 采样间隔抖动 | kitchen/bath：5.50s ±0.28s（p95 5.73s）；dayu200-living：3.01s ±0.05s → **节拍很稳** |
| 端到端延迟 | 无线段扣时钟差 <50ms；板端段 204–229ms |
| 断连/重连次数 | ESP32 ×2 节点：**各 1 次**（同一时刻，01:43:48）；dayu200-living：**0 次**；sos relay：**0 次** |
| 断连持续时间 | kitchen 11.74s / bath 13.66s；数据面空档 31.8s / 33.8s；**均自愈** |
| 错误日志 | bridge.err.log 共 **54 条，100% esp32-sos 解析失败**；非 sos 错误 **0 条**；bridge→板端端点错误 **0 条** |
| 健康探针误报 | 42 条探测连接被正确忽略，未污染节点计数 |

---

## 五、节点层单点故障与对演示的影响

| # | 单点 | 影响面 | 演示中的表现 | 现状/概率 |
|---|---|---|---|---|
| **SPOF-1** | **两路 ESP32 共用同一个 Wi-Fi/AP（+ 本机无线网卡）** | kitchen + bath **同时**掉 | 厨房/卫生间两块数据同时停更（本次实测空档 32–34s），若此刻发生跌倒/燃气报警则**上报丢失**；`nodes=4/4` 可能掉到 2/4 | **已实际发生 1 次**（01:43:48，自愈）；这是节点层**最大的真实风险** |
| **SPOF-2** | **hdc fport `tcp:9001→tcp:9000` 隧道 + hdc 服务（PID 31928）** | dayu200-living 状态 + sos 注入**同时**断 | 客厅节点停更 + 随身求助离线，4/4 掉 2 个；APP 侧“客厅/随身求助”同时变灰 | 稳定 46 分钟（0 断连），但一旦 hdc 掉 fport 需重建 |
| **SPOF-3** | **wearable-mirror(61116) + 公网 API api.luxunacc.xyz** | esp32-sos 的 online/状态**唯一来源** | 随身求助显示离线；“已选设备在线”横幅失效 | **已实测 9.9s online 抖动**（01:46:17.7）；API polls 1016/ok 1015，丢 1 次 |
| **SPOF-4** | `bridge`(46720) 进程 | 3 个网络节点全部汇聚于此 | 全部节点在 MQTT 侧消失（bridge 层问题，非节点自身故障） | 46 分钟稳定，0 重连 |
| **SPOF-5** | kitchen 燃气通道 | 厨房 gas 传感器读数 **raw=4095 恒满量程**（15/15 帧一致，`valid=true`） | 若演示“燃气报警”，厨房大概率无法给出可信变化；“一切正常”时也可能被误判为超限 | 数据质量缺陷，当前 `state=ALARM` 由 `NO_MOTION` 驱动，**暂不影响** |
| **观察** | dayu200-living 长期 `ALARM/FALL`（a-1793120863-1，自 01:07:43 未清除） | 客厅长期处于告警态 | 若演示脚本预期“解除后一切正常”，该未清除告警会与之矛盾 | 属业务/APP 层，节点层如实上报，未丢帧 |

---

## 六、最终判断

**节点层是否稳定：可用，但不是“无抖动”的稳定——3 个网络节点（厨房/卫生间/客厅）在线且上报新鲜、节拍抖动很小（σ≤0.28s），并在 01:43:48 两路 ESP32 同时断连 12–14s 后全部自动恢复；第 4 个节点 esp32-sos 走板外旁路、MQTT 上根本没有 `home/esp32-sos/status`（按指定口径 FAIL），其“在线”仅由 mirror+公网 API 旁路证明且已实测约 10s 掉线抖动。因此节点层判定：PASS with DEGRADED（演示可继续，但 Wi-Fi 共同故障与 sos 旁路是两处必须盯防的单点）。**

---

## 七、证据索引（便于复核）

| 结论 | 证据位置 |
|---|---|
| 4/4 口径 = APP UI 文本 | `materials\demo-autostart\demo-autostart.ps1:273-275, 554-561`；`evidence\2026-10-26-demo-autostart\runtime\ui-last.json`（01:44:25 / 01:46:46） |
| 4 个 deviceId 全集 | `bridge\_test\current-runtime\supervisor\bridge.out.log`（deviceId 去重）；`RAWMEMO.md §1.3` |
| 两节点同时断连/重连 | `bridge.out.log` 17:43:48.231/945、17:44:00.687、17:44:01.893；`RAWMEMO.md §2.2/§4` |
| 上报间隔/抖动 | `bridge.out.log` 发布时刻统计；`RAWMEMO.md §3` |
| MQTT 3 个主题、无 sos | `nodes\mqtt-sub-home.log`（01:42:08–01:43:33）、`nodes\mqtt-tsprobe.log`（01:46:23–01:47:28） |
| sos 旁路在线证据 | `cloud\wearable-mirror\runtime\mirror-status.json`（01:46:35）、`...\mirror.log`（01:46:17/19/27） |
| sos 解析失败 54 条 | `bridge.err.log` 全文（100% esp32-sos）；`bridge\mqtt_bridge.js:809` |
| 板端 homemon 存活 | `hdc -t 4501... shell ps`（PID 23655，00:44:46 起）；`hdc fport ls`（tcp:9001→tcp:9000） |
| 探针不计节点 | `bridge\mqtt_bridge.js:878-881`；`bridge.out.log` 42 条“忽略未识别的探测连接” |
| 只读约束 | `RAWMEMO.md §9` |
