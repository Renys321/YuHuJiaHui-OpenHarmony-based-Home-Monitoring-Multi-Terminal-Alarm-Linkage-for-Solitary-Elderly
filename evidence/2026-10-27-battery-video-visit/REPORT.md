# 真实电量检测 + 手机远程视频探望 — 总交付报告（2026-10-27）

- 工作区：`<WORKSPACE>`；时区 Asia/Shanghai
- 交付目录：`competition/evidence/2026-10-27-battery-video-visit/`
- 本轮时间：2026-10-27 20:04–20:55
- 结论一句话：**手机 APP 内“视频探望”已真实跑通并能看到 DAYU200 摄像头实时画面（真机验收 PASS，本机/IP 路径）；真实电量检测的整条代码链（固件→网关→后端→APP）已实现并通过测试/构建，但因现场没有任何电池采样硬件，真实电压测量与“电池设备显示真实电量”仍 BLOCKED-BY-HARDWARE——没有伪造任何电量数值。**

---

## 0. 逐项状态总表

| # | 目标 | 已实现 | 已构建/已测试 | 已部署 | 真实设备验收 | 结论 |
|---|---|---|---|---|---|---|
| 1 | 有电池设备显示真实测得电量 | ✅ 全链路代码 | ✅ 固件 3 个变体构建、host 187/35/284、onenet 184、backend 418、APP 502 | ⚠️ 仅 APP 1.0.9 装模拟器；固件未烧录、后端/网关未部署生产 | ❌ 无电池硬件（BLOCKED） | 代码完成；真实测量待硬件 |
| 2 | 无电池/无采样硬件设备准确说明原因 | ✅ 逐台结论 + APP 文案 | ✅ APP 测试/静态守卫 | ✅ APP 1.0.9 模拟器实拍 | ✅ 真机/模拟器截图 | **PASS** |
| 3 | 手机 APP 主动打开 DAYU200 实时视频 | ✅ DAYU 1.0.4 + relay + APP 1.0.9 | ✅ relay 30/30、APP 502/502、HAP 构建、DAYU 验签 | ✅ DAYU 真机 + 模拟器 APP + 本机 relay | ✅ 端到端真机验收（≥65s 连续、逐帧变化、退出停止） | **PASS（本机/IP 路径）** |
| 4 | 手机与 DAYU 不同网络可达 | ✅ ECS 中继部署件（compose/Caddy/install/rollback + 静态校验） | ✅ `caddy validate`、幂等 patch、compose 校验 | ❌ 未部署 ECS（无 SSH，需用户一条命令） | ❌ BLOCKED-BY-DEPLOY | 公网路径待用户执行一条命令 |
| 5 | 现有账号/设备/门磁/D/E/SOS-ACK/健康/AI 回归 | ✅ 未改相关业务语义 | ✅ backend 418、onenet 184、bridge 4 文件、vision 126、APP 502 | — | ✅ DAYU 现场 UI：3/3 设备在线、摄像头 + 跌倒推理仍在跑 | **PASS（代码/测试/现场快照）** |

**“完成标准”核对**：手机 APP 内能主动打开并播放 DAYU200 实时视频 → **已达成（本机 IP 路径真机验收）**；实际电量有可信测量来源 → **未达成，现场无电池采样硬件**，按任务要求给出可采购型号、接线表、校准与验收方法，并把不依赖实物的工作全部完成。

---

## 1. 开工前核对（真实读取）

| 项 | 核对结果 |
|---|---|
| APP（手机/模拟器） | 安装版本 **1.0.8 / 1000008**（`com.example.program_04`），登录态存在；实体手机无对应签名材料 |
| DAYU200 板端 APP | 安装版本 **1.0.3 / 1000003**（`com.dsh.eldercare`），签名身份 debug，覆盖安装可保留数据 |
| DAYU200 系统 | OpenHarmony 7.0.0.38 / API 26，720×1280；`com.dsh.eldercare` 前台，相机预览 `640x480 FRONT` 运行中；本机 NCNN 跌倒推理 `dayu_local_fall --serve 127.0.0.1:9200` 运行中；homemon :9000 运行中 |
| DAYU200 网络 | `wlan0/eth0` **均无 IPv4**；只有 USB/HDC；`hdc fport` 已有 `tcp:9001 tcp:9000` |
| PC | WLAN `10.127.130.179`；可访问 `api.luxunacc.xyz:443`；模拟器 `127.0.0.1:5555`（eth0 `10.0.2.15`，QEMU NAT） |
| 电量硬件 | 全部设备无电池采样：厨房/卫生间 ESP32 固定 USB 供电（厨房 ADC 仅 MQ2/MQ5）；随身 SOS 无电池座/充电/分压；DAYU200 适配器供电且 `/sys/class/power_supply` 为空、BatteryService 为模拟值（`present:0`）；4G wearable 无 ADC 初始化 |
| 视频现状 | 仓库内无任何 RTSP/MJPEG/HLS/WebRTC 实现；`127.0.0.1:9200` 只是 DAYU 本机 JPEG 推理入口；手机“视频探望”原为 `enabled=false` 未开放占位 |

---

## 2. 电量检测（真实链路实现 + 硬件缺口）

### 2.1 硬件核验结论（详见 `battery/LEAD-HARDWARE-VERIFICATION.md`、`battery/BOM-WIRING.md`）

| 设备 | 供电 | 电池采样硬件 | APP 展示（本轮实拍） |
|---|---|---|---|
| esp32-kitchen | USB/固定 | 无 | 固定供电，无电池电量数据 |
| esp32-bath | USB/固定 | 无 | 固定供电，无电池电量数据 |
| dayu200-living | 电源适配器 | 无（BatteryService 为模拟值） | 固定供电，无电池电量数据（并说明 11% 是模拟值） |
| esp32-sos | 当前 USB | 无（方案就绪、未接线） | 电量未知（设备未上报电量）+ 未接入说明 + 补齐条件 |
| esp32-node-wearable | USB/充电宝 | 无 | 电量未知（未上报） |
| 隔离测试记录 | — | 无实物 | 不在监护范围，不显示电量 |

**明确不伪造**：不把 USB 5V、电源在线、`csq` 信号、固定百分比或系统 BatteryService 模拟容量当电量；固定供电设备只显示“固定供电，无电池电量数据”；无数据/过期显示未知/过期，不保留旧百分比。

### 2.2 已实现的数据链路

```text
电池分压 → ESP32 ADC（ADC1_CH2 等）→ battery_logic（中位数/稳定性/范围/校准/低电/可选OCV百分比）
  → 固件上报 JSON 顶层 "battery"（仅 battery 设备输出；固定设备不输出）
  → bridge/MQTT（原有链路）→ onenet adapter 严格校验 → gateway 聚合透传 → cloud-sync ingest
  → 后端 store 校验/序列化（非法 battery 降级为“无电量”，不丢整条状态；不升 schema，旧快照兼容）
  → APP BatteryDto → BatteryView 五态（fixed/real/stale/missing/offline）→ 设备管理页逐台显示
```

具体文件：

| 层 | 变更 |
|---|---|
| 固件 | `esp32-node/main/battery_logic.h/.c`（新增纯逻辑：raw→mV、2:1 分压、两点校准、8 样本中位数、极差 ≤300mV、2.5–4.35V 有效、0mV 永不有效、低电 3500mV、百分比仅 calibrated）；`Kconfig.projbuild` 新增 `NODE_BATTERY_*`；`node_main.c` ADC 初始化/30s 采样/上报 JSON/长度断言/引脚冲突编译期检查；`D:\esp32-sos-build\main`、`esp32-node/.local` 私有副本、`esp32-node-wearable/main`（心跳可选 battery 字段，旧 `wb_build_hb` 签名不变） |
| 网关 | `cloud/onenet/adapter.js` 严格解析 battery（source/present/valid/mv/percent/low/calibrated/reason，0–60000、0–100、短码白名单）；`gateway.js` 4 处加性透传；`cloud-sync.js` ingest payload 透传 |
| 后端 | `store.js` 校验 + 设备序列化透出 + 非法降级 `BATTERY_INVALID_SHAPE/OUT_OF_RANGE`（不丢状态）；`persistent-store.js` 不升 schema，旧快照缺 battery→null、新快照旧代码忽略未知键；重启加载双向兼容测试 |
| APP | `Contracts.ts` BatteryDto 严格解析（缺失→null、mv=0 不有效、未知 source 不猜）；`DeviceInventory.ts` fixed/battery-capable；`ViewMapper.ts`/`Models.ts` BatteryView 五态与文案；`DevicePage.ets` 逐台渲染；静态守卫禁止伪造百分比 |
| 测试 | `esp32-node/test/host_battery_logic_test.c`（187 项）、wearable（35 项 + 既有 284 项回归）、`cloud/onenet`（184/184，含 battery 31 项）、`cloud/backend`（418/418，含 battery 25 项）、APP（502/502） |

### 2.3 固件构建（5 个，均新目录；未烧录）

详细构建命令/分区余量/二进制扫描见 `battery/FIRMWARE-BUILD.md`；逐台结论与契约逐条对照见 `battery/REPORT.md`。

| # | 构建 | 用途 | bin 大小 | SHA-256 | 二进制含 battery |
|---|---|---|---|---|---|
| 1 | `esp32-node/.local/build-battery-kitchen-20261027` | 公共树厨房（battery 关闭，固定供电） | 792,080 B | `22391FA8A36F87227D25C2EEAD5B43211349D3C560F3BCCB4E1AD95F8AFCAC5B` | 否 |
| 2 | `...door-v7-20261027/build-battery-kitchen-src-20261027` | 私有厨房源码（battery 关闭） | 766,944 B | `14609CBBBD0F0AE60FF1ACFE7E932640DB589D4D81FEFAB469F31C67D1D338B3` | 否 |
| 3 | `...door-v7-20261027/build-battery-kitchen-onboardcfg-20261027` | 私有厨房 + **在板 sdkconfig 副本**（battery 关闭；app 分区仅余 2%） | 1,023,328 B | `123B270201011D344D93D974D04839AE93ECE902EBB2200ADDBA491053858DF8` | 否 |
| 4 | `D:\esp32-sos-build\.local\build-sos-battery-20261027` | 随身 SOS（battery CH2 启用，未标定） | 774,480 B | `33E83E4796EC84193AF27CE631B1D44CED0289C534D85FCB3C900E8C8E6004EA` | 是 |
| 5 | `esp32-node/.local/build-battery-node-batt-20261027` | 公共树 battery 启用编译验证（CH2） | 794,928 B | `3843B1AE80FB97E138975ACDAB3CAE7D9E8BC6582E0AEB4F18D026EDA9045038` | 是 |

- 固定供电固件里出现的 `OUT_OF_RANGE` 字符串来自 ESP-IDF 自身错误名（非电量逻辑），`battery` 段在编译期被完全排除，电量改动对固定供电固件**零体积影响**。
- `bath-src`（卫生间，固定供电）构建卡在 ESP-IDF component manager 准备阶段，已按限时要求终止、未纳入通过证据；其改动与 kitchen-src 同形且 battery 分支编译期排除。
- wearable 只做了 host 测试（35 项新增 + 284 项既有回归），**未跑 idf.py build**（限时收口），报告如实标注。

**未烧录任何板卡、未打开 COM4/COM5/COM8、未改在板固件**；三块在板节点保持原固件。所有构建都写在新目录，未覆盖既有构建目录或在板 sdkconfig。

### 2.4 真实测量为何未完成 / 用户需要做什么

现场没有任何 1S 锂电池、分压电阻、充电/升压模块或电池座（SOS 板当前还是 USB 线供电），也没有实体电池可供万用表比对，所以“真实测得的电量”在本轮物理上无法产生。补齐清单（`battery/BOM-WIRING.md`）：

- 1S 锂电（3.7V，带保护板，1000–2000mAh）×1；USB-C TP4056 充电保护模块 ×1；MT3608 5V 升压 ×1；100kΩ 1% ×2（分压）；100nF ×1；1kΩ ×1（ADC 串联限流）；万用表 ×1。
- 接线：电池 OUT+ → 100k → 分压点 → 100k → GND；分压点 → 100nF→GND、1kΩ→**GPIO2（ADC1_CH1）**；电池经 MT3608 升 5V 给板供电；**必须共地**；分压后 1.5–2.1V（12dB 衰减量程内），分压电流约 21µA；禁止电池正极直连 ADC、禁止 ADC2、禁止复用 MQ 通道。
- 固件已预留 `NODE_BATTERY_ADC_CHANNEL=2` 与校准参数；接线后用万用表做 ≥2 点校准、烧录、按 `battery/BENCH-CALIBRATION.md` 做 4.1→3.4V 放电验收（APP mV 误差 ≤±50mV；断开分压显示“未知”而非 0%/旧值；低电量阈值触发）。
- 若要“云端/手机”看到电量：还需把本轮 `cloud/onenet`+`cloud/backend` 变更部署到生产（本轮未部署，见 §6）。

---

## 3. 手机远程视频探望（真实跑通）

### 3.1 方案与组件（实际协议/地址/端口）

```text
DAYU200 摄像头（640×480 MIPI，真实画面）
 → DAYU200 板端 APP 1.0.4 内 VideoStreamServer：127.0.0.1:9301（TCP；只板内回环；按需取相机预览 Surface + JPEG q60）
 → USB/HDC：hdc fport tcp:9301 tcp:9301（PC 127.0.0.1:9301）
 → PC/ECS relay（Node，本机 0.0.0.0:9443）：Bearer token 调生产后端 /api/v1/overview 复核 → 一次性 ticket(60s,64hex)
     → WS /video/stream?ticket=…（首条文本 ready，之后每条二进制=一张 JPEG）；空闲 3s 停；并发上限 2；断线退避重连
 → 手机 APP 1.0.9 VideoVisitPage（模拟器经 QEMU NAT 访问 10.0.2.2:9443）
     → @ohos.net.webSocket 收帧 → image.createImageSource→PixelMap→Image 连续渲染
```

- 复用现有登录/监护权限；token 不进 URL、不进日志；relay 无免 token 入口；未复用/未改变 9200 推理口。
- 未打开视频页面时：DAYU 板端**只有监听、不取帧/不编码/不发帧**；relay 无 viewer 时 `dayuLink=down`；用户离开页面后 APP 关 WS + POST `/video/session/end`，relay 3 秒内令 DAYU 停止取帧。

### 3.2 端到端真机验收（PASS，证据 `video-ip/REPORT.md`）

| 验收项 | 结果 |
|---|---|
| 手机 APP 主动进入“视频探望” | 首页入口由“未接入”改为“可用”，点击进入 `VideoVisitPage`（无假的“正在直播”文案） |
| 真实实时画面 | 模拟器截图中显示 DAYU200 房间真实画面：`第 12→281 帧`、`3.3–4.0 fps`、`640×480`、`最近帧 20:38–20:45`；6 张整屏截图 SHA-256 全部不同（非静态图/旧帧循环） |
| 连续播放 | **连续 65s**：relay `framesReceived 182→438`（+256 帧），APP `第 281 帧 · 3.6 fps`，无中断 |
| 与既有 AI 链路并行 | DAYU UI 同一时刻显示 `远程探望：推流中 · 23 帧 · 3 fps` 与 `检测到人体 · 2479 帧 · 271 ms`（跌倒推理未因推流停止） |
| 加载中 | 首帧前显示“正在申请视频会话…”（不显示画面） |
| 连接失败 | 停 relay 后打开：显示“连接视频服务超时，请检查网络后重试”、`未连接`、`错误类型: timeout`、重试按钮，**无假画面** |
| 手动重试 | 重启 relay 点“重新连接” → 恢复真实画面（第 48 帧、3.8 fps） |
| 断线自动恢复 | 播放中重启 relay → 页面加载/重试 → relay 恢复后自动继续播放至第 188 帧 |
| 主动结束 | 点“结束探望” → 返回首页；relay `viewer left viewers=0`、`session/end 200`、`3.0s idle stop`；DAYU `停止取帧（已发送 368 帧）` |
| 鉴权 | 无 token→401；伪造 token→后端 401→relay 401；APP 无 token 直接提示登录失效、不发请求 |

实测帧参数：640×480 JPEG，27.8–29 KB/帧，3.2–4.0 fps，relay 首帧 331–512 ms；设备端每帧取帧 130–280 ms + 编码 60–223 ms + 发送 2–19 ms（瓶颈在板端 Surface 读取/JPEG 编码，非网络）。

### 3.3 公网/跨网络

- 本机验收路径已跨网络命名空间：模拟器（`10.0.2.0/24` NAT）↔ 宿主 relay（`0.0.0.0:9443`）；DAYU 侧只有 USB/HDC（设备无 IP）。
- **公网 ECS 中继尚未部署**：`competition/deploy/video/` 已产出 compose/Caddy 片段/幂等 install/rollback，本机 `caddy validate` 通过、Caddyfile patch 幂等（保留原 `reverse_proxy backend:8080`、删除 `ticket/key` query 日志），无主机端口暴露；因无 ECS SSH，需用户在阿里云 Workbench 执行一条命令（见 §6）。未执行前，公网视频标记 **BLOCKED-BY-DEPLOY**。

---

## 4. 测试、构建与回归（本轮实际执行）

| 套件/构件 | 命令（摘要） | 结果 |
|---|---|---|
| APP tsc | `tsc -p tests/tsconfig.json` | exit 0（`app/logs/app-tsc.log`） |
| APP 行为测试 | tests/*.test.mjs | **502/502 PASS**（`app/logs/app-node-test.log`） |
| APP HAP 构建 | `hvigorw assembleHap` | **BUILD SUCCESSFUL**；HAP 3,579,813 B，SHA-256 `31C5634E0653AFCEC1D2F435AC3A10B6629178A3AAAC23DEF6268B741B9A5A87`（`app/assembleHap-1.0.9.log`） |
| APP 安装 | `hdc -t 127.0.0.1:5555 install -r` | success；`versionName 1.0.9 / versionCode 1000009`，覆盖安装未清数据（`app/bm-dump-1.0.9.txt`） |
| 后端 check | `npm run check` | exit 0 |
| 后端测试 | `npm test` | **418/418 PASS**（含 battery 25 项） |
| OneNET/网关 | `npm test`（cloud/onenet） | **184/184 PASS**（含 adapter/gateway/cloud-sync battery 31 项） |
| Bridge | 4 个 test 文件逐个 `node` | 全部 exit 0 |
| Vision（跌倒/AI） | `python -m unittest discover -s vision` | **126 tests OK** |
| 固件 host 测试 | `host_battery_logic_test` | **187 PASS / 0 FAIL** |
| wearable host 测试 | 新增 battery 35 + 既有逻辑 284 | 0 FAIL |
| DAYU 板端 HAP | hvigor build + `hap-sign-tool sign-app/verify-app` | BUILD SUCCESSFUL；**验签 success**；1,353,199 B，SHA-256 `05230657B89B7D8AFE29C7F94AEC57639887F706725C005603E024B3DA68CF60`；安装成功，`1.0.4 / 1000004`，数据保留 |
| relay | `npm test` | **30/30 PASS**；真实 DAYU 探针/冒烟、真实 token WS 44 帧、idle stop 3.0s、401 全部有日志 |
| ECS 部署件 | `bash -n`、Caddyfile patch 幂等、`caddy validate`、compose config | 全部通过（未部署） |

**既有功能回归（未改动业务语义）**：本轮未改 ACK/处置状态机、门磁事件、SOS/ACK 命令链、健康档案/AI 健康评估、生产账号与数据；DAYU 现场 UI 显示 3/3 设备在线、厨房今日活动/门窗、摄像头 + 跌倒推理正常；生产后端未写入（仅登录 + GET）。D/E、门磁、SOS/ACK、健康与 AI 数据均保留在后端/生产记录（未删除、未重置）。

---

## 5. 变更清单（按层）

### 5.1 DAYU200 板端（`competition/experiments/dayu-eldercare-preview-integration-2026-10-25`）
- 新增 `entry/src/main/ets/model/VideoStreamServer.ets`（TCP 127.0.0.1:9301、按需取帧、JPEG 帧、控制行、单客户端、失败隔离）；
- `pages/Index.ets`：启动/停止服务、相机 Surface/预览状态回调、“远程探望：就绪/推流中 N 帧 M fps”真实状态行、版本行；
- `AppScope/app.json5`：1.0.3→1.0.4 / 1000003→1000004；
- 未改 CameraModel/VisionFrameStreamer/告警/ACK/语音逻辑。

### 5.2 手机 APP（`<WORKSPACE>\APP\ElderlyCareGuardian`）
- 新增：`core/video/{VideoConfig,FrameDecodeCore,VideoRelay,VideoSessionCore,VideoVisitController}.ts`、`net/HarmonyVideoSocket.ets`、`service/VideoVisitService.ets`、`pages/VideoVisitPage.ets`、`main_pages.json` 注册；
- 修改：`core/api/Contracts.ts`（BatteryDto + DeviceDto.battery）、`core/inventory/DeviceInventory.ts`、`core/view/{Models,ViewMapper}.ts`、`pages/DevicePage.ets`、`pages/HomePage.ets`（视频入口“可用”、删旧未接入弹窗）、`service/GuardianService.ets`（requestVideoTicket/endVideoSession）、`AppScope/app.json5`（1.0.9 / 1000009）、`tests/*`；
- 未改：登录/会话安全存储、ACK/处置、健康资料、告警证据、后端接口契约。

### 5.3 网关/后端（本仓库代码，已测试，**未部署生产**）
- `cloud/onenet/adapter.js`、`gateway.js`、`cloud-sync.js`；
- `cloud/backend/src/store.js`、`persistent-store.js`；
- 对应新增/更新测试。

### 5.4 固件（源码已改，**未烧录**）
- `esp32-node/main/battery_logic.h/.c`（新）、`Kconfig.projbuild`、`node_main.c`；
- `D:\esp32-sos-build\main\node_main.c`、`profiles/`、私有构建配置；`esp32-node-wearable/main/wearable_logic.c`（可选 battery 心跳字段）；
- 三份构建产物/哈希见 §2.3。

### 5.5 视频中继与部署件（新）
- `competition/video/relay/`（server/agent/src/tests/vendor ws/README/.env.example）；
- `competition/deploy/video/`（compose.video.yaml、Caddyfile 片段、install-on-ecs.sh、rollback.sh、video.env.example、README）；
- 工具：`competition/video/tools/{dayu-frame-client.js,relay-ws-client.js,emu-ui.ps1}`。

---

## 6. 部署 / 安装 / 回滚

### 6.1 已完成部署
- DAYU200 板端 APP 1.0.4：签名身份与原包一致（debug profile，`verify-app` success），`hdc install -r` 覆盖安装，数据保留。
- 手机模拟器 APP 1.0.9：unsigned HAP 覆盖安装（模拟器允许），会话恢复、未清数据。
- relay：本机 local 模式运行（`0.0.0.0:9443` → DAYU `127.0.0.1:9301` → 生产后端鉴权）。本轮验收结束后可随时停止（无状态）。

### 6.2 未部署（需要用户配合，逐条具体）
1. **公网视频中继（ECS，需一条命令）**：把 `competition/deploy/video/` 及 `competition/video/relay/` 上传到 ECS `/root/eldercare-upload/competition/` 后执行：
   ```bash
   sudo bash /root/eldercare-upload/competition/deploy/video/install-on-ecs.sh
   ```
   预期输出/验证/回滚见 `competition/deploy/video/README.md`；执行后 APP 需把中继地址注入 `video.relayBase=https://api.luxunacc.xyz`（当前模拟器默认 `http://10.0.2.2:9443`）。
2. **电量硬件（需要采购/接线/烧录/校准）**：按 `battery/BOM-WIRING.md` 采购与接线，烧录 `D:\esp32-sos-build\.local\build-sos-battery-20261027\esp32_elder_node.bin`（**或**先在台架验证），按 `battery/BENCH-CALIBRATION.md` 完成 2 点校准 + 放电验收；并把 `cloud/onenet`+`cloud/backend` 变更部署生产以打通云端显示。
3. **实体手机（可选）**：提供 `com.example.program_04` 实体机签名材料后可安装验收（当前仅模拟器）。
4. **（可选）DAYU200 Wi-Fi/4G**：当前 DAYU 无 IP，视频必须经 USB/HDC；如需真正脱离 PC，需配置 Wi-Fi 或 4G 并让 relay 公网可达。
5. **（可选）第二家庭账号**：跨家庭越权真实测试需要第二个监护账号；当前 relay 已对无 token/伪造 token 返回 401。

### 6.3 回滚
- APP：`hdc -t 127.0.0.1:5555 install -r competition/evidence/2026-10-27-real-capability-app/app/guardian-real-capability-1.0.8-unsigned.hap`（覆盖安装，保留数据）。改造前源码快照见 `app/source-before/`。
- DAYU：`hdc -t 450100… install -r competition/evidence/2026-10-27-dayu200-real-capability/rollback-1.0.2-signed.hap`（或重装 1.0.3），覆盖安装保留数据。
- 固件：本轮未烧录，无需回滚；在板固件未变。
- 后端/网关：本轮生产零改动（未部署），无需回滚；仓库代码回退用上一轮基线。
- relay：独立进程，停止即回滚，无持久化数据。

---

## 7. 未完成 / 限制 / 风险（如实）

1. **真实电量测量 BLOCKED-BY-HARDWARE**：现场无电池/分压/ADC/万用表，无法产生真实电压；因此“有电池设备显示真实电量”尚未真机验收。不得把 host 单测、固件构建、固定设备显示当成真实电量验收。
2. **固件未烧录**：三份构建只证明可编译/含字段；未改动任何在板节点固件（COM4/COM5/COM8 未打开）。
3. **网关/后端未部署生产**：电量字段目前不会出现在生产数据里；APP 对固定设备与未知电量按台账显示，行为准确但不等于“云端电量已上线”。
4. **视频公网路径 BLOCKED-BY-DEPLOY**：ECS 未部署；当前 PASS 是本机/IP 路径（模拟器↔宿主 relay↔USB/HDC↔DAYU）。PC 关机/拔线即断。
5. **手机为模拟器**，实体手机 NOT TESTED；APP 中继地址生产需 AppStorage 注入（无页面内编辑入口）。
6. **低帧率**：3.2–4.0 fps，不是 30fps 视频；未做 AVCodec H.264 硬编码、音频、录像/回放；多观看者上限 2。
7. **跨家庭越权**：只有 1 个生产账号，NOT TESTED；relay 鉴权链路已用无/伪造 token 验证 401。
8. 生产数据：未删除/重置账号、告警、门磁、健康档案；只做了登录与 GET 页面刷新；未执行 ACK/处置/保存等写操作。

---

## 8. 证据索引

| 路径 | 内容 |
|---|---|
| `CONTRACTS/VIDEO-VISIT-CONTRACT.md` | 视频协议/端口/鉴权/验收契约（含实测 fps 基线） |
| `CONTRACTS/BATTERY-CHAIN-CONTRACT.md` | 电量字段/范围/换算/六层改动契约 |
| `dayu-1.0.4/REPORT.md` | DAYU 1.0.4 实现 + 真机帧测试 + 签名/验签/安装 |
| `dayu-1.0.4/live-frames/` | 从 DAYU 相机收到的 5 张原始实时帧 |
| `video-ip/REPORT.md` | 手机 APP 端到端视频验收（本报告 §3 的原始截图/日志索引） |
| `video-ip/app-video-*.jpeg` | 实时画面序列、加载、失败、重试、重连、结束截图 |
| `video-ip/relay-owned.log`、`dayu-video-*.txt` | relay/DAYU 原始运行日志 |
| `video-relay/REPORT.md` + logs | relay 30/30、真实 DAYU 探针/冒烟、鉴权、部署件校验 |
| `app/REPORT.md`、`app/logs/`、`app/*.jpeg` | APP 1.0.9 实现、测试、HAP、安装、电量/视频页面截图 |
| `battery/LEAD-HARDWARE-VERIFICATION.md` | Lead 现场只读硬件核验（DAYU BatteryService 模拟值、各板供电/ADC/缺失证据） |
| `battery/REPORT.md` | 电量链路交付报告：三态结论、逐台结论、契约 §1–§7 对照、schema 不升版双向兼容重启证明、未部署说明、风险 |
| `battery/FIRMWARE-BUILD.md` | 固件 5 个构建：命令/目录/大小/SHA256/二进制字符串扫描/未烧录声明/改动文件清单 |
| `battery/BOM-WIRING.md` / `BENCH-CALIBRATION.md` | 可采购型号、接线表、校准与真实验收步骤 |
| `battery/evidence/` | host 187/35/284、onenet 184、backend 418 + check、二进制扫描、gateway 透传前后对照 |
| `battery/app-battery-ui/` | APP 1.0.9 设备管理页电量文案实拍（固定供电/未知） |
| `regression-bridge.log`、`regression-vision.log` | bridge 4 文件 exit 0、vision 126 tests OK |
