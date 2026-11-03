# 电量链路 · 固件构建证据（2026-10-27，battery-chain）

- 环境：**ESP-IDF v5.1.6**（`D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6`），target `esp32s3`，
  Python 环境 `D:\Espressif-5.1.6\python_env\idf5.1_py3.11_env`，XTensa GCC 12.2.0。
- 所有构建都用**全新构建目录**（`-B`），`sdkconfig` 写在各自新目录里，**没有覆盖任何既有构建目录/在板 sdkconfig**。
- 结论：**只构建，未烧录、未打开串口、未接线、未改在板固件**。COM4/COM5/COM8 未被本任务打开或写入。

## 1. 构建结果总表

| # | 构建 | 工程目录 | 构建目录（新） | battery 配置 | bin 大小 | app 分区余量 | SHA256（bin） | 二进制含 `battery` |
|---|---|---|---|---|---|---|---|---|
| 1 | 公共树 · 厨房 profile（**电池关闭**） | `competition/esp32-node` | `.local/build-battery-kitchen-20261027` | `CHANNEL=-1` | **792,080 B** | 24%（0x3e9f0） | `22391FA8A36F87227D25C2EEAD5B43211349D3C560F3BCCB4E1AD95F8AFCAC5B` | **否** |
| 2 | 私有上板源码 · 厨房（**电池关闭**，叠加默认 profile） | `.local/door-v7-20261027/kitchen-src` | `.local/door-v7-20261027/build-battery-kitchen-src-20261027` | `CHANNEL=-1` | 766,944 B | 27% | `14609CBBBD0F0AE60FF1ACFE7E932640DB589D4D81FEFAB469F31C67D1D338B3` | **否** |
| 3 | 私有上板源码 · 厨房（**在板 sdkconfig 副本**，电池关闭） | `.local/door-v7-20261027/kitchen-src` | `.local/door-v7-20261027/build-battery-kitchen-onboardcfg-20261027` | `CHANNEL=-1` | **1,023,328 B** | **2%（仅 25,248 B）** | `123B270201011D344D93D974D04839AE93ECE902EBB2200ADDBA491053858DF8` | **否** |
| 4 | `esp32-sos` · SOS profile（**电池启用 GPIO2**） | `D:\esp32-sos-build` | `D:\esp32-sos-build\.local\build-sos-battery-20261027` | `CHANNEL=2`、`CALIBRATED=n` | **774,480 B** | 26% | `33E83E4796EC84193AF27CE631B1D44CED0289C534D85FCB3C900E8C8E6004EA` | **是** |
| 5 | 公共树 · 电池启用验证 profile（**电池启用 GPIO2**） | `competition/esp32-node` | `.local/build-battery-node-batt-20261027` | `CHANNEL=2`、`CALIBRATED=n` | 794,928 B | 24% | `3843B1AE80FB97E138975ACDAB3CAE7D9E8BC6582E0AEB4F18D026EDA9045038` | **是** |

> 构建 #3 用**在板厨房 sdkconfig 的副本**（`.local/door-v7-20261027/build-kitchen/sdkconfig` → 新构建目录）
> 编译同步后的厨房源码：**app 分区只剩 2%（25,248 B）**，但 bin 里**没有** `battery` 字符串——
> 证明“固定供电厨房节点启用不了电量、也不会因电量代码变大”，分区余量问题与本次改动无关。
> 构建 #4/#5 是 `NODE_BATTERY_ADC_CHANNEL=2` 的编译验证：`report()` 的 battery 段、`battery_sample/tick`、
> 长度断言全部真正参与编译并通过；sdkconfig 里 `# CONFIG_NODE_BATTERY_CALIBRATED is not set`（未标定 → `percent=null`）。

### 复现命令（PowerShell）

```powershell
& 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1'
cd '<WORKSPACE>\competition\esp32-node'
idf.py -B .local\build-battery-kitchen-20261027 `
  -D SDKCONFIG="$PWD/.local/build-battery-kitchen-20261027/sdkconfig" `
  -D SDKCONFIG_DEFAULTS="profiles/kitchen.sdkconfig.defaults" build

cd 'D:\esp32-sos-build'
idf.py -B .local\build-sos-battery-20261027 `
  -D SDKCONFIG="$PWD/.local/build-sos-battery-20261027/sdkconfig" `
  -D SDKCONFIG_DEFAULTS="profiles/sos-node.sdkconfig.defaults" build

# 电池启用分支验证（公共树）
cd '<WORKSPACE>\competition\esp32-node'
idf.py -B .local\build-battery-node-batt-20261027 `
  -D SDKCONFIG="$PWD/.local/build-battery-node-batt-20261027/sdkconfig" `
  -D SDKCONFIG_DEFAULTS="profiles/kitchen.sdkconfig.defaults;profiles/battery-bench.sdkconfig.defaults" build
```

## 2. 二进制字符串扫描（逐 build）

| build | `battery` | `"source":"battery"` | `UNSTABLE` | `percent` |
|---|---|---|---|---|
| #1 公共树厨房（电池关） | 否 | 否 | 否 | 否 |
| #2 私有厨房（电池关） | 否 | 否 | 否 | 否 |
| #3 私有厨房（在板 cfg，电池关） | 否 | 否 | 否 | 否 |
| #4 sos（电池开 CH2） | **是** | **是** | **是** | **是** |
| #5 公共树（电池开 CH2） | **是** | **是** | **是** | **是** |

> 说明：固定供电固件里出现的 `OUT_OF_RANGE` 来自 ESP-IDF 自身错误名
> `ESP_ERR_MEMPROT_SPLIT_ADDR_OUT_OF_RANGE`（已定位 offset 24143 上下文），不是电量逻辑。
> 电池启用固件包含 `battery` 段与判定码，但**当前没有实物电池/分压**：
> 采样只会得到浮空/悬空噪声 → 三重门限判 `valid=false`、`mv=null`、`percent=null`、`reason=OUT_OF_RANGE|UNSTABLE`。
> 这是**设计如此**（宁可报“电量未知”，也绝不写 0%/假电压）。

证据文件：
- `evidence/binary-scan.md`（#1/#2/#4 扫描，含 SHA256）
- `evidence/binary-scan-onboardcfg.md`（#3）
- `evidence/binary-scan-node-battery-on.md`（#5）
- `evidence/build-kitchen-batteryoff.log`、`evidence/build-sos-batteryon.log`、
  `evidence/build-kitchen-src-defaults.log`、`evidence/build-kitchen-src-onboardcfg.log`、`evidence/build-node-batteryon.log`

## 3. 未完成的构建（如实记录）

- `bath-src`（卫生间私有上板源码，电池关闭）构建**启动后**卡在 ESP-IDF component manager 的准备阶段
  （长时间无进展，疑似等待网络/重复 prepare），按 Lead 要求**已终止**，不纳入通过证据。
  该源码树的改动与 kitchen-src**完全同形**（同一迁移脚本、同样编译期 `#if` 排除），
  且 bathroom 是固定供电设备（`CHANNEL=-1`），不输出 `battery` 字段。
- 未执行 `idf.py flash` / `esptool.py write_flash` / 任何串口操作（COM4/COM5/COM8 零接触）。

## 4. 改动文件清单（仅源码，未烧录）

| 文件 | 改动 |
|---|---|
| `competition/esp32-node/main/battery_logic.h` / `.c` | **新增**（纯逻辑：raw→mV、分压、两点校准、8 样本中位数/极差/一致率/范围三重门限、低电量、仅标定时百分比） |
| `competition/esp32-node/main/Kconfig.projbuild` | 新增 `NODE_BATTERY_*` 配置段（ADC_CHANNEL 默认 -1 等 10 项） |
| `competition/esp32-node/main/node_main.c` | include、编译期约束（ADC1/通道不冲突/范围合法）、`REPORT_JSON_MAX`、电池状态/初始化/采样、`report()` battery 段 + 长度断言、日志 |
| `competition/esp32-node/main/CMakeLists.txt` | SRCS 增加 `battery_logic.c` |
| `competition/esp32-node/test/host_battery_logic_test.c` | **新增** host 单测（187 checks） |
| `competition/esp32-node/profiles/battery-bench.sdkconfig.defaults` | **新增**（仅编译验证用，禁止烧到固定供电设备） |
| `.local/door-v7-20261027/kitchen-src/main/*` | **仅源码同步**：battery_logic.h/.c 新增、node_main.c/Kconfig.projbuild/CMakeLists.txt 同上；**未覆盖其 sdkconfig、未烧录** |
| `.local/door-v7-20261027/bath-src/main/*` | 同上（**未烧录**） |
| `D:\esp32-sos-build\main\*` | **仅源码同步**：battery_logic.h/.c 新增 + node_main.c/Kconfig.projbuild/CMakeLists.txt；profile `profiles/sos-node.sdkconfig.defaults` 增加 `NODE_BATTERY_ADC_CHANNEL=2` 等；**未烧录** |
| `competition/esp32-node-wearable/main/*` | battery_logic.h/.c 新增；`wearable_logic.c/.h` 新增 `wb_build_hb_ex`（`wb_build_hb` 签名/行为不变）；`wearable_main.c` 新增 ADC 初始化+30s 采样；Kconfig/CMakeLists 更新；**未构建、未烧录** |
| `competition/esp32-node-wearable/test/host_wearable_battery_test.c` | **新增** host 单测（35 checks） |

**声明**：以上全部是**本地源码/构建目录改动**；没有烧录任何板卡、没有打开 COM4/COM5/COM8、
没有改设备在板固件、没有接电池、没有部署后端。
