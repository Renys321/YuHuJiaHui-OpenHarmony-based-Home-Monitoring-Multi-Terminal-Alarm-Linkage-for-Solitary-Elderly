# 真实电量检测链路 · 交付报告（2026-10-27，battery-chain）

- 工作区：`<WORKSPACE>`（Windows / PowerShell / Asia-Shanghai）
- 契约：`competition/evidence/2026-10-27-battery-video-visit/CONTRACTS/BATTERY-CHAIN-CONTRACT.md`（唯一契约）
- 边界：**未烧录任何板卡、未打开 COM4/COM5/COM8、未接电池/分压、未部署生产后端**；
  只改源码 + 本地测试 + 本地构建 + 证据文档。

## 0. 三态结论（逐层）

| 层 | 已实现 | 已测试 | 已构建/可运行 | 真实设备验收 |
|---|---|---|---|---|
| 固件采样（esp32-node / sos） | ✅ | ✅ host 单测 187 checks + 2 套固件编译 | ✅ 5 个构建（见 `FIRMWARE-BUILD.md`） | ❌ 无电池/分压硬件 |
| 固件采样（wearable hb 帧） | ✅ | ✅ host 单测 35 checks + 既有 284 回归 | ⚠️ 未构建（本期限时；源码同步完成） | ❌ 无电池/分压硬件 |
| 适配器 `adapter.js` | ✅ | ✅ 新增 20 tests，全量 184 pass | ✅ `node --check` | — |
| cloud-sync | ✅ | ✅ 新增 6 tests | ✅ `node --check` | — |
| 网关聚合 `gateway.js`（Lead 已批准 4 处加性透传） | ✅ | ✅ 新增 5 tests + 既有 49 全绿 | ✅ `node --check` | — |
| 后端 `store.js`/`persistent-store.js` | ✅ | ✅ 新增 25 tests，全量 418 pass | ✅ `npm run check` exit 0 | ❌ **未部署生产**（用户需自行在 ECS 执行） |
| APP 展示 | 由 `app-owner` 负责（本报告不评价） | — | — | — |
| **真实电量测量** | — | — | — | **❌ BLOCKED-BY-HARDWARE** |

> 一句话：**链路代码是真的、测试是真的、固件能编译，但“真实电量数字”本期不可能有**——
> 没有任何一台设备具备电池采样硬件（见 §1）。

## 1. 逐台设备结论（真实测量为什么 BLOCKED-BY-HARDWARE）

| 设备 | 供电/板卡 | 电池采样硬件 | 固件配置 | 本期输出 | 结论 |
|---|---|---|---|---|---|
| `esp32-kitchen` | 正点原子 DNESP32S3，USB/固定供电 | **无**：ADC1 仅 CH5(GPIO6 MQ-2)/CH6(GPIO7 MQ-5)，无分压/电池座 | `NODE_BATTERY_ADC_CHANNEL=-1` | **不输出 `battery` 字段**（bin 内无 `battery` 字符串） | 固定供电 → 无电池电量；APP 应显示“固定供电，无电池电量数据” |
| `esp32-bath` | DNESP32S3，USB/固定供电 | **无**（无 ADC 初始化） | `-1` | **不输出 `battery`** | 同上 |
| `dayu200-living` | DAYU200（RK3588），电源适配器 | **无**：`/sys/class/power_supply` 为空；系统 `hidumper -s BatteryService` 为模拟值（`present:0`、`capacity:11` 可用 `--capacity` 任意改写） | 不适用 | 不涉及 | **系统 11% 不是真实电量，禁止使用/展示** |
| `esp32-sos` | 独立 ESP32-S3（COM8，MAC `30:30:f9:08:76:84`），当前 USB 供电；按钮 GPIO4、蜂鸣器 GPIO5、**GPIO6=Flash 禁用** | **无**：无电池座/充电/分压。已选定可电池化引脚 **GPIO2=ADC1_CH1** | `NODE_BATTERY_ADC_CHANNEL=2`（sos profile 已设）+ `CALIBRATED=n` | 输出 `battery` 但 **`valid=false, mv=null, percent=null, reason=OUT_OF_RANGE|UNSTABLE`**（浮空引脚被三重门限拒绝） | **可电池化第一优先板；当前无实物 → 真实测量 BLOCKED-BY-HARDWARE** |
| `esp32-node-wearable` | ESP32-S3 + YED M100；ESP32 由 USB/充电宝，M100 独立 5~12V；按钮 GPIO4、蜂鸣器 GPIO5、UART1 17/18、GPIO6/19/20/26-37 禁用 | **无**：无 ADC 初始化、无电池采样 | wearable Kconfig `NODE_BATTERY_ADC_CHANNEL` 默认 **2** | hb 帧带 `battery`，同样 `valid=false/mv=null/percent=null` | **可电池化第二优先板；当前无实物 → BLOCKED-BY-HARDWARE** |
| `esp32-sos-isolated-test` 等未登记节点 | 无实物台账 | 不适用 | 不适用 | 不显示电量 | 后端对未登记设备不生成电量来源 |

**BLOCKED-BY-HARDWARE 的具体缺口**（每台电池设备）：
1S 锂电（带保护板）+ USB-C TP4056 + MT3608 5V 升压 + 100kΩ×2（1%）+ 100nF + 1kΩ + 万用表 + 接线/焊接。
BOM/接线/校准/验收步骤见同目录 `BOM-WIRING.md` 与 `BENCH-CALIBRATION.md`（**步骤均未执行**）。

## 2. 契约逐条对照

| 契约条 | 要求 | 实现 | 测试/证据 |
|---|---|---|---|
| §1.1 BOM | 型号/数量/规格 | `BOM-WIRING.md` §1（9 项，含采购要点/成本） | 文档 |
| §1.2 接线表/分压/禁止项 | 100k/100k→2:1、100nF、1k、共地、禁 ADC2/禁电池直连/禁复用 MQ 通道 | `BOM-WIRING.md` §2–§4；固件编译期 `#error` 拦 ADC2(>9)/通道复用/范围倒置 | `node_main.c` 编译期断言；`grep-proof.md` |
| §1.3 换算/采样/校准/百分比 | raw→mV、分压、校准、8 样本中位数、极差>300mV→UNSTABLE、2.5–4.35V 有效、3.5V 低电、仅 calibrated 给 percent | `battery_logic.h/.c`；固件 30s 采样；固定供电设备不编译该分支 | **host 187 checks 全通过**（`evidence/host-battery-test.log`） |
| §2 固件 JSON 契约 | 顶层 `battery`（source/present/valid/mv/percent/low/calibrated/reason），固定供电不输出，无效时 mv/percent=null | `node_main.c` `report()` + `REPORT_JSON_MAX=1400` + 溢出长度断言；wearable `wb_build_hb_ex` | 编译（sos/公共树 battery-on）+ 二进制扫描（含 `battery` 段）；固定板 bin 无 `battery` |
| §3 适配器 | 严格解析 battery（0..60000 int/null、bool、reason `[A-Z_]{0,16}`、未知字段拒绝），`toPropertyPost` 兼容 | `adapter.js` `normalizeBattery` + `normalizeStatus` 返回 `battery`（缺失 `undefined`）+ `toPropertyPost` 透传 | `adapter-battery.test.js` **20 pass**；全量 184 pass |
| §4 cloud-sync / 网关 | buildIngestPayload 传递 battery；网关聚合保留 battery | `cloud-sync.js` `cloneBoundedObject(device.battery)`；`gateway.js` 5 处加性透传（Lead 已批准） | `cloud-sync-battery.test.js` 6 pass；`gateway-battery.test.js` 5 pass；**gateway 既有 49 tests 全绿** |
| §5 后端 | 接受可选 battery、缺失→不写 0、序列化透出、非法不丢整条状态、持久化兼容、393+ 全绿 | `store.js` `normalizeBattery`（严格校验但**降级为“无电量”+内部 `batteryRejectCode`**，不抛错）、`toPublicDevice` 有值才透出、`completeCommand` 保留上次电量；`persistent-store.js` 可选 `battery`（缺失=null） | `test/battery.test.js` **25 pass**；全量 **418 pass**；`npm run check` exit 0 |
| §6 APP | — | 由 `app-owner` 负责 | 不在本报告 |
| §7 真实验收 | 万用表 ≤±50mV、放电、断线、低电量 | 验收步骤写成 `BENCH-CALIBRATION.md`；**未执行** | **BLOCKED-BY-HARDWARE** |

## 3. 测试结果（全部真实执行，未跳过）

| 套件 | 结果 | 证据 |
|---|---|---|
| 固件纯逻辑 host 单测（`test/host_battery_logic_test.c`） | **PASS=187 FAIL=0**（exit 0） | `evidence/host-battery-test.log`、`evidence/host-battery-compile.log`（无警告） |
| wearable hb 帧电量 host 单测（`test/host_wearable_battery_test.c`） | **PASS=35 FAIL=0** | `evidence/host-wearable-battery-test.log` |
| wearable 既有逻辑回归（`host_wearable_logic_test.c`） | **284 passed, 0 failed**（`wb_build_hb` 签名未变） | `evidence/host-wearable-logic-regression.log` |
| onenet 全量（15 个文件逐个 `node x.test.js`） | **184 pass / 0 fail**，其中新增 battery 相关 31 条（adapter 20 + cloud-sync 6 + gateway 5） | `evidence/onenet-tests.log` |
| backend 全量（34 个文件逐个 `node test/x.js`） | **418 pass / 0 fail**，其中新增 `battery.test.js` 25 条 | `evidence/backend-tests.log` |
| `cloud/backend` `npm run check` | **exit 0** | `evidence/backend-check.log` |

host 单测覆盖（对应契约可测部分）：
raw→mV 端点/钳位、2:1 分压、3:1 分压、gain/offset 两点校准、gain=0 除零保护、
中位数（偶数取较小值）、极差、**0 raw 绝不 valid/绝不 0%**、越界→`OUT_OF_RANGE`、
单野值/两簇噪声→`UNSTABLE`、**浮动噪声偶然落在 2.5–4.35V 内也不 valid**、
2.5V/4.35V 双边界、低电阈值（含 =阈值 为 true）、未标定 percent=-1、
已标定 OCV 插值（4200→100/4000→80/3700→50/3300→5…单调）、样本不足/读失败/无配置 reason 码。

后端新增测试覆盖：合法值、缺失（不默认 0）、14 类非法值降级（负值/超上限/非整数/mv=0 却 valid/未知 source/
未知字段/布尔类型错/reason 小写/未标定给百分比/valid=false 带 mv/fixed 带电压/非对象/数组）、
非法不丢设备状态、不影响 sensors/alarm、ACK 部分回执保留电量、
**schema 保持 v7 且双向兼容**（见 §4）、`/internal/v1/device-status` 摄取路径同源（server 调用同一 `normalizeStatus`）。

## 4. 持久化 schema：**不升版（v7）** 的双向兼容证明

结论：**无需 v8**。理由：`persistent-store.js` 的快照**设备字段没有白名单**（只严格校验已知字段），
`battery` 是设备对象上的**新增可选字段**：

- **旧快照 → 新代码**：无 `battery` 键 → 加载后 `device.battery = null`，设备/告警/台账/账号全部不丢、不重置；
- **新快照 → 旧代码**：旧代码 `deviceFromDocument` 只读它认识的字段，未知 `battery` 键被忽略，不会拒绝启动；
- **非法 `battery`（新快照里被手改坏）**：加载时降级为 `null`（遥测字段不值得让整库拒绝启动），不猜值、不补 0。

测试证据（`cloud/backend/test/battery.test.js`，25 条中相关 5 条，全部 passage）：
1. `SCHEMA_VERSION === 7`（不升版断言）；
2. 有 battery 的新快照 → 重启加载后 `device.battery` 完整保留，告警不丢，对外序列化仍带 battery；
3. 手工删除 `battery` 键的旧快照 → 重启后 `battery=null`、设备数不变、序列化**不出现** battery 键；
4. 快照里 `battery.mv=-1`（非法）→ 加载成功、`battery=null`；
5. v1（远早于本功能）快照 → 正常加载、`battery=null`，下一次变更写回 v7 并带上新的 battery。

另：`store.js normalizeStatus` 对非法 battery **不抛异常** → `/internal/v1/device-status` 不会因电池字段把整条设备状态丢弃
（契约 §5），非法时设备照常入库、`battery=null`，并输出内部诊断码
`BATTERY_INVALID_SHAPE | BATTERY_OUT_OF_RANGE | BATTERY_INCONSISTENT`（只进日志/内部状态，**不进入对外设备序列化、绝不冒充电量**）。

## 5. 构建证据摘要（详见 `FIRMWARE-BUILD.md`）

| 构建 | bin 大小 | SHA256 | 含 `battery` |
|---|---|---|---|
| 公共树厨房（**电池关**） | 792,080 B | `22391FA8…F8AFCAC5B` | 否 |
| 私有厨房源码（电池关，默认 profile） | 766,944 B | `14609CBB…1D338B3` | 否 |
| 私有厨房源码（**在板 sdkconfig 副本**，电池关，2% 余量） | 1,023,328 B | `123B2702…53858DF8` | 否 |
| **sos（电池开，CH2）** | 774,480 B | `33E83E47…8E6004EA` | **是** |
| 公共树（电池开，CH2，编译验证） | 794,928 B | `3843B1AE…DA9045038` | **是** |

- 固定供电固件 bin 内**没有任何 `battery` 字符串** → 证明“不输出 battery 字段”是编译期排除，不是运行时抑制；
- 电池启用固件含 `battery`/`"source":"battery"` → 协议段真的编进去了；但当前无实物，运行期只会输出 `valid=false`；
- 厨房在板配置只剩 **2%（25,248 B）** app 分区，本次电量改动对固定供电固件**零体积影响**（#3 与改动前的差异不来自电量）。

## 6. 未部署生产（必须如实写）

- 后端代码已改、测试已过，但**没有部署到 ECS、没有写生产数据、没有配置生产环境变量**。
- 部署需用户自行在 ECS 执行（备份 → 更新 `store.js`/`persistent-store.js` → `npm run check` → 重启 → 健康检查）。
- 生产设备（COM4/COM5/COM8）**在板固件未改变**：本任务未烧录；sos/wearable 的电池固件只在本地构建产物里。

## 7. 剩余风险 / 待办

1. **硬件缺口**：电池/分压/充电/升压/万用表都没到货 → 真实测量与校准无法进行（BLOCKED-BY-HARDWARE）。
2. **sos/wearable 一旦启用电池通道但未接线**：会每 30s 输出 `valid=false`；这是**诚实行为**，
   但若上线部署需确认 APP 对 `valid=false` 显示“电量未知”而不是 0%（APP 由 app-owner 保证）。
3. **厨房在板分区只剩 2%**：本次零增长；后续任何固件新增（语音/新传感器）需重新核算，不能靠这个 2% 赌。
4. **ADC 线性/温漂**：ESP32-S3 ADC 非线性明显，实际误差要等 §两点/多点校准实测；未标定前 `percent=null`。
5. **Wi-Fi/4G 发射毛刺**：已用三重门限（8 样本、极差 ≤300mV、中位数邻域一致率、范围）拒绝，
   但真实毛刺幅度未实测（NOT TESTED）。
6. **wearable 固件未构建**：本期限时收口未跑 wearable 的 `idf.py build`（其依赖与主树不同），
   已用 host 单测覆盖帧构造与共享电量逻辑；首次构建需在本机执行。
7. **bath-src 构建未完成**：component manager 准备阶段卡住，已按 Lead 要求终止；源码改动与 kitchen-src 同形。
8. **网关改动**已获 Lead 批准（5 处加性透传，不改既有 topic/命令/校验/限频/回执语义），既有 49 tests 全绿。

## 8. 证据索引（本目录）

| 文件 | 内容 |
|---|---|
| `BOM-WIRING.md` | BOM（型号/数量/规格）、接线表、分压/ADC 计算、禁止项、逐台结论、上电自检 |
| `BENCH-CALIBRATION.md` | 两点/多点校准步骤与公式、放电验收、断线/缺失/过期验收、通过标准 |
| `FIRMWARE-BUILD.md` | 构建命令/目录/大小/SHA256/二进制扫描/未烧录声明/改动文件清单 |
| `REPORT.md` | 本文件：三态结论、逐台结论、契约对照、测试/构建汇总、schema 兼容证明、未部署说明、风险 |
| `evidence/onenet-tests.log` | onenet 15 个测试文件逐个结果（184 pass） |
| `evidence/backend-tests.log` / `backend-check.log` | backend 34 个测试文件（418 pass）/ `npm run check` exit 0 |
| `evidence/host-battery-test.log` 等 | 固件 host 单测 187 / wearable 35 / wearable 回归 284 |
| `evidence/binary-scan*.md` | 4 个 bin 的 SHA256 与字符串扫描（`battery` 有无） |
| `evidence/build-*.log` | 5 个构建的完整 idf.py 输出 |
| `evidence/grep-proof.md` | 六层链路 battery 关键代码位置（带行号） |
| `evidence/gateway-diff.md` | gateway.js 5 处加性透传的前后对照（Lead 审批要求） |
