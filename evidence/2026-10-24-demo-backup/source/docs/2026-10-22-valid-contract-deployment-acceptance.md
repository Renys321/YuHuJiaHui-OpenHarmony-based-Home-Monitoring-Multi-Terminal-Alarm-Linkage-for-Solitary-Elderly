# 本机 gateway valid 修复部署与手机真实验收

日期：2026-10-22 23:07–23:16 CST  
状态：**本机 deployment PASS；真实手机消费端 PASS；公网后端/homemon/DAYU HAP/ESP32 NOT TOUCHED。**

本轮未部署公网后端、未替换 homemon、未烧录 ESP32、未更新 DAYU HAP；未触发 SOS/ACK/reset。

## 1. 部署前状态与快照

| 项 | 值 |
|---|---|
| public-sync 旧逻辑实例 | launcher `28172` + child `33560`，lock `28172` |
| Broker / Bridge / fport | 6540 / 13508 / 9001→9000 |
| 三节点最新 202 | 部署前仍在自然上报 |
| 部署前 gateway 源码 | 修改版 SHA-256 `64790E7C…BC990` |
| 手机候选 HAP | `competition/evidence/2026-10-23-valid-contract-local/guardian-valid-candidate.hap`，2,075,527 B，`86805DC2…F9504` |
| 手机稳定基线 HAP | `competition/evidence/2026-10-23-valid-contract-local/guardian-baseline.hap`，2,075,388 B，`94F90E21…CBFD` |

部署前手机 target 为 `127.0.0.1:5555`，bundle `com.example.program_04`；未操作 DAYU `com.dsh.eldercare`。

## 2. 回退件核对（重要）

`source-original/` 是**按本轮已知反向补丁重建的副本**，不是部署前现场复制件；证据文档已明确标注。回退差异核对结果：

```diff
仅新增/撤销：
+ rawSensorValid()
+ normalizeIncoming 中 climate/gas/smoke.valid 回填
+ gateway 合同测试
```

- 未改动 deviceTs、ACK、QoS、认证、OneNET 映射、上传限频。
- 修改后 gateway 已通过 `node --check`、153/153 onenet 测试。
- 重建原始件仅用于回退；未把重建件写成“现场原件”。
- 手机改动为 `ViewMapper` 的有效零值/缺失文案和 `Contracts` 注释；候选 HAP 内置生产映射测试，未改 HAP 之外的业务逻辑。

## 3. public-sync 部署

1. 停止旧逻辑实例 33560 / 28172，确认退出。
2. lock 文件保留旧 PID 28172；启动脚本发现 PID 已不存在，清理陈旧锁。
3. 经既有可见启动器重新启动，用户隐藏输入 INGEST_KEY；未读取其他进程环境、未发送到聊天。
4. 新实例：

```text
launcher 32584（run-public-sync.js，23:07:15）
child    30216（public-sync.js，23:07:15）
lock     32584
```

**只有一个 launcher + 一个 child，逻辑单实例；** 1883/9001/9101 正常。  
新进程加载的源码：`<WORKSPACE>\competition\cloud\onenet\gateway.js`，SHA-256 `64790E7C…BC990`。

部署后三节点继续新 202；未出现持续拒收/崩溃。

## 4. 手机候选 HAP 安装

- 目标：`127.0.0.1:5555`（手机模拟器），不是 DAYU。
- 安装包：`guardian-valid-candidate.hap`，2,075,527 B，SHA-256 `86805DC2EBAA3D39DE58F5255CFBCF924EF178EA64820BAECF8C65325DDF9504`。
- 方式：保留数据替换安装（`hdc install -r`），**未卸载、未清数据**；会话保留（首页仍显示原监护人，无需重新登录）。
- 结果：`install bundle successfully`，exit=0。
- 默认构建路径仍是恢复后的基线 HAP；本轮安装的是证据目录中的候选哈希文件，未误装基线。

### 4.1 手机行为测试

在安装前补充并执行了 `entry/src/test/ValidContract.test.ets`，覆盖：

```text
valid=true + 合法 0/0 → 有效
valid=false → 无效
valid 缺失 → 未知
厨房 gas valid=true 但仍“报警未启用”
卫生间无 MQ 卡片
离线历史读数 → offline + 上次读数
```

`hvigorw test ...` 退出 0，`ViewMapper` 函数被实际执行（测试覆盖率报告显示 `climateIsPlaceholder`/`buildClimateView`/`buildRawSensorView`/`mapDevice` 等命中）。该测试仅证明本地生产映射逻辑；真实 UI 结果见第 5 节。候选 HAP 的生产源码在测试文件加入前已补丁完成，测试文件不进入 HAP。

## 5. 真实字段链路

### 5.1 自然 202（新 public-sync）

```text
esp32-kitchen deviceTs=1792682074723 202 at=2026-10-22T15:14:34.704Z
esp32-kitchen deviceTs=1792682107603 202 at=2026-10-22T15:15:07.475Z
esp32-kitchen deviceTs=1792682140483 202 at=2026-10-22T15:15:40.361Z

esp32-bath    deviceTs=1792682051940 202 at=2026-10-22T15:14:19.094Z
esp32-bath    deviceTs=1792682090300 202 at=2026-10-22T15:14:50.558Z
esp32-bath    deviceTs=1792682123180 202 at=2026-10-22T15:15:23.085Z
```

至少两个连续周期均有新 202；手机监测页“上次更新 23:15 · 数据已同步”。

### 5.2 手机实际展示

| 来源 | 手机实际 |
|---|---|
| 厨房 climate.valid=true | **读数有效**；`24.6℃ · 50%RH`；`AHT20 读数有效` |
| 卫生间 climate.valid=true | **读数有效**；`25.1℃ · 49%RH`；`AHT20 读数有效` |
| 厨房 gas/smoke.valid=true | `报警未启用`；`原始 ADC 266`；没有正常/ppm 误导 |
| 卫生间未配置 MQ | 仅温湿度 + PIR；**无燃气/烟雾卡片** |
| 客厅缺少 valid | `温湿度（待确认）` / `待确认`；没有猜测有效 |
| 离线卡片 | 保留`离线`+历史/暂无数据表达，不显示为当前有效 |

上述为**手机实际消费端展示**；测试不是靠 HTTP 202 或本地 mock 替代。

### 5.3 可观察边界

- 未直接读取 Authorization/Cookie/Token 或完整后端响应；手机正常流程已能显示有效/无效/未知，足够证明字段到达消费者。
- 未部署公网后端；当前 backend 为既有线上版本。字段在本地 gateway 的 backend 旁路上传，经线上服务后被手机正常读取。
- 未制造传感器故障；`valid=false`/缺失/离线历史由移动端行为测试覆盖，标记为 LOCAL TEST，不是真机故障。

## 6. 回归

- 三节点自然上报继续：dayu/kitchen/bath 202 均在 23:15 左右，单逻辑实例持续。
- DAYU：`全屋在线 3/3 台设备`；三房间标题/能力不变；卫生间 25.2℃/48.7%；摄像头切回仍运行。
- 手机首页/监测页均 `3/5`，首页统计一致；候选 HAP 安装未清会话。
- 未触发 SOS/ACK/PIR/蜂鸣器/燃气报警；ACK 相关代码未改。
- 未混入演示数据；真实模式数据来自自然上报。
- HDC server 因安装挂起被重启一次；已重建 `tcp:9001 → tcp:9000`，三节点 202 未中断。

## 7. PASS / BLOCKED / NOT TESTED

| 项目 | 结果 |
|---|---|
| gateway 本地部署/单实例 | **PASS** |
| 三节点新 202 | **PASS REAL** |
| 手机候选 HAP 安装（目标/哈希/保留数据） | **PASS** |
| 厨房 climate valid=true → 手机“读数有效” | **PASS REAL** |
| 卫生间 climate valid=true → 手机“读数有效” | **PASS REAL** |
| 厨房 gas 报警禁用展示 | **PASS REAL** |
| 卫生间未配置 MQ 卡片隐藏 | **PASS REAL** |
| 客厅缺 valid 保守展示 | **PASS REAL** |
| DAYU 3/3 / 三房间 | **PASS REAL** |
| 手机首页/监测 3/5 一致 | **PASS** |
| `valid=false`/缺失/离线历史行为测试 | **PASS LOCAL TEST**（非真机故障） |
| 公网后端部署 | **NOT DEPLOYED（未触碰）** |
| homemon 替换 | **NOT PERFORMED** |
| DAYU HAP / ESP32 | **NOT TOUCHED** |
| SOS/ACK/reset | **NOT TESTED（本轮未触发）** |

## 8. 回退方案

若需回退：

1. 结束 public-sync launcher 32584 及 child 30216，清理 lock（确认 PID 不再存活）。
2. 用 `source-original/gateway.js.original` 覆盖 `cloud/onenet/gateway.js`（重建件，差异仅撤销本轮 valid 保留），重启 public-sync 并隐藏输入 key。
3. 手机重装 `guardian-baseline.hap`（`94F90E21…CBFD`），保留数据；不卸载。
4. 本轮回退不涉及 backend、homemon、ESP32、DAYU。

## 9. 结论

字段从 natural MQTT 经本机 gateway、线上 backend 到手机已真实呈现：厨房/卫生间 `valid=true` 显示“读数有效”，厨房 MQ 仍“报警未启用”，卫生间无 MQ 卡片，客厅缺 valid 继续“待确认”。三节点和现有演示链路保持正常。  
**本机 deployment 与真实手机消费端 PASS；公网后端本轮未部署，故不能把它写成“后端部署完成”。**
