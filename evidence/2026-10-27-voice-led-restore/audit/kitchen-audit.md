# 厨房板固件审计 + PIR 加装构建方案（2026-10-27，只读审计 + 隔离构建）

- 审计人：kitchen-fw-audit（子代理）；时间：2026-10-27 00:47–01:10 Asia/Shanghai
- 边界：**未打开任何 COM 口、未运行 esptool、未烧录/复位、未按键、未改 workspace 源码、未改 `.local` 私有文件、未重启 bridge/broker/public-sync**。允许动作仅：读文档/日志/源码、列目录、`Get-FileHash`、在证据目录 `_work/` 下做隔离构建。
- 事实分级：**[实测]** 本次命令直接得到；**[历史]** 既有证据记录；**[推断]** 由证据推理；**[未知]** 无证据。
- 范围变更说明：原任务“恢复 446A5B87（kitchen-prod-v30）”已被用户/Lead 取消。**v30 不是恢复目标**，仅为历史回滚材料（§1）。新目标 = 在**当前在板候选 43C1183A** 基础上评估加装 PIR。

## 0. 结论速览

| # | 结论 | 等级 |
|---|---|---|
| 1 | 当前在板固件 = 定向播报候选 **43C1183A**（1,019,728 B）；保留，不刷任何“恢复镜像” | [推断，强] |
| 2 | 446A5B87（v30，1,016,864 B）仍在盘且现算 SHA 一致，但**不再使用**；它只在 00:08 备份里作为“旧内容”出现 | [实测] |
| 3 | `.local/notice-20261026/kitchen-notice/` 的构建源**就是当前 workspace** `competition/esp32-node`（CMakeCache/project_description/compile_commands + 源码→目标文件 mtime 链 + 隔离重建同尺寸） | [实测] |
| 4 | PIR 加装**配置层可行**：`CONFIG_NODE_MOTION_GPIO=38` 隔离构建成功，镜像 **1,020,192 B**（比在板 +464 B），剩余 **28,384 B（2.7%）** | [实测] |
| 5 | 但没有 `MOTION_ACTIVE_HIGH` 开关（输入固定“高=有人”），且余量极小；**硬件接线/模块电平均待用户确认** | [实测+未知] |

## 1. 镜像与身份事实（全部现算）

| 对象 | 实盘路径（私有，仅路径与哈希进证据） | 大小(B) | 现在实算 SHA-256 | 等级 |
|---|---|---|---|---|
| **在板候选**（定向播报） | `.local\notice-20261026\kitchen-notice\esp32_elder_node.bin` | 1,019,728 | `43C1183A30688EAA56080BFA9C0CAB363B85839BE3FFD54FCBE19DB33F8443DD` | [实测] 与烧录记录一致 |
| 旧正式 v30（**非恢复目标**） | `.local\speech-20261026\kitchen-prod-v30\esp32_elder_node.bin` | 1,016,864 | `446A5B8700EEB721044B7223616B76F65C8BA96EBE2F2991753C3AE986E29167` | [实测] 与 FIRMWARE-MANIFEST 一致 |
| 00:08 写前 1 MiB 备份 | `.local\notice-20261026\backup\COM5-app-before-20261027-000816.bin` | 1,048,576 | `22288AB780FF1633C28F9D6BC674CEEF4AC43ADA1B2E1F8139137CA118FFFB7B` | [实测] |
| — 该备份前 1,016,864 B | 同上（前缀切片） | 1,016,864 | `446A5B87…E29167`（**与 v30 完全一致**） | [实测] ← 证明 00:08 板上还是 v30 |
| 21:22 写前 1 MiB 备份 | `.local\speech-20261026\device-backup\COM5-app-before-speech-20261026.bin` | 1,048,576 | `DB9C350A6E52A3F53F9B2DB485BD647FCFDD712399E78DE089D5B7680F512D82` | [实测] |
| — 该备份前 948,960 B | 同上（前缀切片） | 948,960 | `A66B3D7D…6A8611`（与记录一致） | [实测] |

**在板判定链**：[历史] `build/flash-kitchen-notice-COM5.json` L2–L12：`recordedAt=2026-10-27T00:09:24`、`com=COM5`、`mac=50:78:7d:16:ed:60`、`binSha256=43C1…43DD`、`appFlashOffset=0x10000`、`esptoolReportedHashVerified=true`、`fullErase=false`；[实测] 上述 00:08 备份前缀=v30，说明写入动作真实替换了 v30；[实测] 之后 `competition` 下无更晚的厨房烧录记录（最新 00:18 的 bath 构建与本板无关）；[实测] `competition/bridge/status.json:1` 当前仍是 `deviceId=esp32-kitchen`、`state=ACKED`、`alarm.id=e-uf849b8b9-1`。→ **当前在板的极可能就是 43C1183A**；无法在只读边界内 100% 证明（唯一直接证据=板载 sha256sum，需开串口，本轮禁止）。

**身份（不变）**：端口 COM5；芯片 ESP32-S3 (QFN56) rev v0.2；MAC `50:78:7d:16:ed:60`；`deviceId=esp32-kitchen`；`room=厨房`；网关 `10.127.130.179:9101`。[历史] `build/identity-backup-COM5.json` L4–L15；`build/identity-backup-kitchen.json` L4–L9；启动日志 `verify/prod-kitchen-bootline.log:97` 有 `wifi:mode : sta (50:78:7d:16:ed:60)`。

> 注：`identity-backup-COM5.json:14` 的 `currentFirmwareMatchesExpectedDeployed=false` **不能**读作“板上不是 v30”：`device-identity-backup.ps1` 用**整段 1 MiB 读回哈希**去比**镜像哈希**（尺寸不同，必然 false）。按“前 N 字节”复核才正确，结果见上表（=v30）。

## 2. 构建源一致性（Lead 问题 1）

### 2.1 路径证据 [实测]
- `.local\notice-20261026\kitchen-notice\CMakeCache.txt:508` → `CMAKE_HOME_DIRECTORY:INTERNAL=D:/OpenHarmony/competition/esp32-node`；`:431` 缓存目录=该 build dir。
- `…\project_description.json:3/5/7/15` → `project_name=esp32_elder_node`、`project_path=D:/OpenHarmony/competition/esp32-node`、`build_dir=…/kitchen-notice`、`target=esp32s3`。
- `compile_commands.json` 中 `main/node_main.c` / `local_voice.c` / `local_led.c` 的绝对路径均为 `<WORKSPACE>\competition\esp32-node\main\*`（非副本）。

### 2.2 源码→目标文件 mtime 链 [实测]
| 事件 | 时间 | 证据 |
|---|---|---|
| sdkconfig 生成（配置定型） | 2026-10-26 23:59:58 | `…/kitchen-notice/sdkconfig` mtime |
| 源码最后修改 | `local_voice.h` 00:03:13、`local_voice.c` 00:03:20、`CMakeLists.txt` 00:03:21、`node_main.c` 00:03:27 | `competition/esp32-node/main/*` mtime |
| main 目标文件重编 | `local_voice.c.obj` 00:04:05、`node_main.c.obj` 00:04:06 | `.ninja_log:1016/1017`；`esp-idf\main\…\*.obj` mtime |
| 链接 / 出 bin | ELF 00:04:26、bin 00:04:27 | `…/esp32_elder_node.elf|.bin` mtime；`.ninja_log:1021` |
| 证据构建日志形态 | `[0/1] Re-running CMake…` 后 **11 步增量**，第 4/5 步即 `local_voice.c.obj`/`node_main.c.obj` | `build/build-kitchen-notice.log:4,59,67` |

结论：**所有 main 源文件都早于其目标文件/镜像**（源码没有晚于产物的改动）→ 镜像链接的是当前 workspace 的源码；in-image `Compile time: Oct 27 2026 00:01:27`（app 描述符，读 bin 偏移 0x20+0x50）只是 app_desc 组件先编出来的时间，**不是**链接时间，不能据此判“镜像比源码旧”。

### 2.3 隔离重建（同配置、无私有凭据）[实测]
- 副本：`competition/evidence/2026-10-27-voice-led-restore/_work/src/`（仅 `CMakeLists.txt`、`main/`、`profiles/`、`sdkconfig.defaults`，31 文件 / 354,236 B；未包含 `.local`、未包含任何 build 目录）。
- defaults 链与在板构建**逐项一致**（6 层，见 §3.2）；私密 Wi-Fi 口令用**等长 8 字符占位符**、SSID 为公开值 `ElderCareLab`、`room=厨房` 按 UTF-8 保留。
- 构建结果：`_work/build-base-fixed/esp32_elder_node.bin` = **1,019,728 B**（SHA-256 `EC61950FDDC709D6490F0E86817E3AD03C2A2A3B456D08676A05473BA78CA8BB`），与在板候选**同尺寸**；日志 `0xf8f50 bytes … 0x70b0 bytes (3%) free`（与在板构建日志同值）。

### 2.4 差分结论（决定性）[实测]
第 1 次隔离构建（`build-base`）因我落盘 defaults 时用了 ASCII 编码，`room` 被写成 `???`（3 B，真实为 `厨房` 6 B），造成全局地址重排（233,185 B 差异），**该次结果作废，仅保留为口径错误记录**。修正编码后的 `build-base-fixed` 与在板候选逐字节比对（脚本 `_work/tools/compare_bins.py`，输出 `_work/logs/binediff-base-fixed-vs-onboard.txt`）：

| 指标 | 结果 |
|---|---|
| 尺寸 | 两者均 1,019,728 B |
| 差异区段数 | **6** |
| 差异总字节 | **75 B** |
| 差异位置 | `0x71/0x74/0x77`（app 描述符 time 字段的 3 个数字位）、`0xB0–0xCF`（app 描述符 `app_elf_sha256`，32 B）、`0x7C78–0x7C7E`（Wi-Fi 口令占位符 7 B）、`0xF8F2F–0xF8F4F`（镜像末尾 33 B：尾部 SHA-256 域 + 前 1 字节校验） |
| 其余 1,019,653 B | **逐字节完全一致（含全部代码、rodata、语音 ADPCM、配置字符串）** |

→ **构建源一致性成立**：`.local/notice-20261026/kitchen-notice/` 的镜像 = 当前 workspace `competition/esp32-node` + 上述 6 层 defaults 的产物；差异仅为构建时间戳/ELF 哈希/私有口令值/整镜像哈希这些“每次构建必然变化”的字段。**在板候选 43C1183A 可由当前 workspace 源码确定性复现**（除时间戳类字段外逐字节一致）。

## 3. 在板候选 43C1183A 的构建配置（Lead 问题 1 后段）

### 3.1 sdkconfig 关键项（直接读 `.local\notice-20261026\kitchen-notice\sdkconfig`）
| 项 | 值 | 行 |
|---|---|---|
| 目标 / flash | esp32s3；DIO；80 MHz；**2 MB**（`CONFIG_ESPTOOLPY_FLASHSIZE="2MB"`） | L438–458 |
| 分区表 | `SINGLE_APP`，offset 0x8000，MD5 校验 | L472–479 |
| 语音 | `VOICE_ENABLED=y`、`VOICE_VOLUME=30`、`AMP_SETTLE_MS=60` | L485–488 |
| 告警声 | CHIRP 200/100/2 声，SOS 3 声，语音间隔 150 ms | L489–493 |
| **PIR** | **`MOTION_GPIO=-1`（未启用）**、`MOTION_DEBOUNCE_CONFIRM=2` | L500–501 |
| 按键/门磁/蜂鸣 | `SOS_GPIO=-1`、`SOS_KEY0_ENABLED=y`、`DOOR_GPIO=-1`、`BUZZER_XL9555=y`、`BUZZER_GPIO=-1` | L502–511 |
| 模拟量 | AHT20 `I2C 4/5`；MQ2 `ADC1_CH5`；**MQ5 `ADC1_CH6`**（GPIO7 改线后） | L516–519 |
| LED | `LED_GPIO=1`、`LED_ACTIVE_LOW=y` | L537–538 |
| 无活动 | `NO_MOTION_REQUIRE_ARM=y`、`NO_MOTION_SEC=1800` | L535, L540 |
| 主任务栈 | `ESP_MAIN_TASK_STACK_SIZE=8192` | L1017 |

### 3.2 构建 defaults 叠加顺序（与在板构建逐项相同）[实测]
`profiles/kitchen.sdkconfig.defaults` → `.local/sdkconfig.kitchen.defaults`（私有，Wi-Fi）→ `profiles/voice-candidate` → `profiles/voice-volume30` → `profiles/kitchen-voice-rewire`（MQ5→CH6）→ `profiles/alarm-closure`；证据：`build/build-kitchen-notice.log:10,12,14,16,18,20`。

### 3.3 体积与分区 [实测]
- 在板候选 1,019,728 B；分区 `factory` = `0x10000` 长度 `0x100000`（1 MiB）；**剩余 28,848 B（0x70B0，2.75%）**；IDF 打印 `0x70b0 bytes (3%) free` + “nearly full”。
- 证据：`build/build-kitchen-notice.log:99,102`；隔离构建实测分区表 `nvs 24K@0x9000 / phy_init 4K@0xf000 / factory 1M@0x10000`。

## 4. PIR 加装方案（Lead 问题 2）

### 4.1 代码/配置层现状 [实测]
- 代码用 `#if CONFIG_NODE_MOTION_GPIO >= 0` 条件编译：状态 `s_pir_db/s_pir_armed`、GPIO 初始化、1 s 采样 `pir_update()`、无活动判定 `no_motion_enabled()`、恢复判定等（`main/node_main.c` 中 `s_pir_armed`、`pir_update`、`no_motion_enabled` 相关块）。
- Kconfig：`NODE_MOTION_GPIO`（`main/Kconfig.projbuild`，`-1`=不用；help 明确“**高电平=有人**”）；`NODE_MOTION_DEBOUNCE_CONFIRM`（默认 2 次连续确认）；`NODE_NO_MOTION_SEC`（默认 1800 s）与 `NODE_NO_MOTION_REQUIRE_ARM`（默认 y）。
- **不存在** `NODE_MOTION_ACTIVE_HIGH`/`_ACTIVE_LOW` 之类的极性开关（Kconfig 全文无 `ACTIVE_HIGH`）；PIR 只能是“高=有人”。HC-SR501 类模块默认输出高脉冲，匹配；若用低有效输出模块，**必须外加反相或改代码**（不在本方案内）。
- `main/voice_pins.h` 只拦截 PIR 与 ES8388 I2S 引脚（GPIO 3/9/10/46）冲突；38 不冲突（编译期 `#error` 未触发，构建通过）。

### 4.2 GPIO 候选与占用 [实测配置 + 未知实物]
| GPIO | 现状 |
|---|---|
| 1 | 板载 LED（`LED_GPIO=1`） |
| 4 / 5 | AHT20 I2C |
| 6 / 7 | MQ-2 / MQ-5（ADC1_CH5 / CH6） |
| 3 / 9 / 10 / 46 | ES8388 I2S（MCLK/BCLK/LRCK/DOUT） |
| 41 / 42 | 板载 I2C0：XL9555（蜂鸣器、KEY0）、ES8388 控制 |
| **38 / 39 / 40 / 47 / 48** | **配置层空闲**（避开 strapping 0/3/45/46、UART 43/44、USB 19/20） |

**推荐 GPIO38**；备选 39/40/47/48。实物板是否另有占用、以及用户接 5 V 供电与 GND，**[未知，需用户确认]**。PIR 输出需 3.3 V 兼容（HC-SR501 一般为 3.3 V 输出；5 V 供电时信号仍为 3.3 V 轨）。

### 4.3 已完成的隔离构建 [实测]
- 副本：`_work/src`（同上，不改 workspace）；新增 overlay `_work/defaults/pir-gpio38.sdkconfig.defaults`：`CONFIG_NODE_MOTION_GPIO=38`、`CONFIG_NODE_MOTION_DEBOUNCE_CONFIRM=2`，作为最后一层 defaults。
- 构建命令（可复现，**不要直接用于烧录**，因 Wi-Fi 口令为占位符）：

```powershell
$W='<WORKSPACE>\competition\evidence\2026-10-27-voice-led-restore\_work'
$D="$W\src\profiles\kitchen.sdkconfig.defaults;$W\defaults\sdkconfig.kitchen.local.defaults;$W\src\profiles\voice-candidate.sdkconfig.defaults;$W\src\profiles\voice-volume30.sdkconfig.defaults;$W\src\profiles\kitchen-voice-rewire.sdkconfig.defaults;$W\src\profiles\alarm-closure.sdkconfig.defaults;$W\defaults\pir-gpio38.sdkconfig.defaults"
powershell -NoProfile -ExecutionPolicy Bypass -File `
  <WORKSPACE>\competition\evidence\2026-10-26-kitchen-sos-led-speech-final\tools\build-firmware.ps1 `
  -ProjectDir "$W\src" -BuildDir "$W\build-pir38" -Defaults $D -LogPath "$W\logs\build-pir38.log"
```

- 结果：`BUILD_OK … size=1020192 sha256=2C0E60848CD063EF1BC959D8E2D702C9B959B8E27FAEFB90D8FE4BCD16923CD2`；日志 `0xf9120 bytes … 0x6ee0 bytes (3%) free`。
- **PIR 增量 = +464 B**（1,020,192 − 1,019,728）；PIR 后剩余 **28,384 B（0x6EE0，2.7%）**。编译警告中不再出现 `s_pir_armed defined but not used`（基线有），说明 motion 代码路径已真正编入。
- 说明：该镜像 `room=厨房`、口令为等长占位符，**仅用于体积/配置可行性证明，不可烧录**；正式镜像须在私有目录用真实 defaults 重建（体积预计 1,020,192 B ±16 B，即 ±一个 16 B 对齐块）。

### 4.4 可行性判定
- **配置层：可行**（`MOTION_GPIO` 是纯 Kconfig 开关，无需改源码/分区表）。
- **体积：可行但极紧**：+464 B 后仅剩 28.4 KB；IDF 已对“分区接近满”告警。**任何再加功能的改动都应该先算余量。**
- **行为层（未验证）**：PIR 接上后，`NO_MOTION_REQUIRE_ARM=y` 意味着上电后必须先检测到**一次有效活动**才开始无活动计时；`NO_MOTION_SEC=1800`（30 min）才告警。演示验收若想缩短，应显式改 profile（例如 60–120 s）并写进证据，**不要**改源码。

### 4.5 空间/冲突选项（若后续还要加东西）
| 选项 | 效果 | 代价 |
|---|---|---|
| A. 保持现候选 + PIR（推荐） | 余 28,384 B | 几乎无余量，后续不能再加语音/功能 |
| B. 退到 v30 源（去 notice 逻辑）+ PIR | 理论余 ≈32,176 B（1,016,864+464） | **会丢定向播报**，与当前在板功能相反，需用户明确同意 |
| C. 去掉 1 条最不常用语音（如 `climate_generic.adpcm` 31,999 B） | 余约 60 KB | 丢一条兜底文案 |
| D. 改分区表（扩大 factory） | 可彻底解决 | **禁止**（既有任务边界：不改分区表/bootloader/NVS） |

## 5. 命令清单（精确、**本轮未执行**，烧录前需用户批准）

> 全部动作一律**只写 app 分区 `0x10000`**；禁止 `erase_flash`、禁止写 0x0/0x8000/0x9000，禁止 `--no-stub`。
> 工具：`D:\Espressif-5.1.6\python_env\idf5.1_py3.11_env\Scripts\python.exe -m esptool`（实测 esptool **4.7.0**，支持 `read_mac/read_flash/write_flash/verify_flash`）。

```powershell
$py = 'D:\Espressif-5.1.6\python_env\idf5.1_py3.11_env\Scripts\python.exe'

# 1) 读芯片/MAC（只读）
& $py -m esptool --port COM5 --baud 115200 read_mac

# 2) 备份当前 app 分区（1 MiB，= 0x100000），写入 .local 私有目录
& $py -m esptool --port COM5 --baud 460800 read_flash 0x10000 0x100000 `
  <WORKSPACE>\competition\esp32-node\.local\pir-20261027\COM5-app-before-pir.bin
Get-FileHash <WORKSPACE>\competition\esp32-node\.local\pir-20261027\COM5-app-before-pir.bin -Algorithm SHA256

# 3) 写入（仅 app 分区）：优先用权威脚本（写前重核 MAC，不符即拒绝）
powershell -NoProfile -ExecutionPolicy Bypass -File `
  <WORKSPACE>\competition\evidence\2026-10-26-kitchen-sos-led-speech-final\tools\flash-app.ps1 `
  -Com COM5 -ExpectedMac 50:78:7d:16:ed:60 `
  -Bin   <WORKSPACE>\competition\esp32-node\.local\pir-20261027\kitchen-pir38\esp32_elder_node.bin `
  -OutJson <WORKSPACE>\competition\esp32-node\.local\pir-20261027\flash-kitchen-pir38-COM5.json

# 4) 写后校验（脚本已记录 esptool 的 "Hash of data verified"）；再独立回读比对
#    <候选bin大小> 用实际字节数替换（本轮 PIR 实测 1020192；正式构建可能 ±16 B）
& $py -m esptool --port COM5 --baud 460800 read_flash 0x10000 <候选bin大小> `
  <WORKSPACE>\competition\esp32-node\.local\pir-20261027\COM5-app-after-pir.bin
# 回读文件 SHA-256 必须 == 候选镜像 SHA-256（若分区尾部有旧残留，按“前 <bin大小> 字节”比对）
```

**写后启动日志必须出现（否则按 STOP 处理）**：
- `Loaded app from partition at offset 0x10000`、`已连接网关 10.127.130.179:9101`；
- `local-voice: READY playback-only 16000Hz IMA-ADPCM; amp standby muted; no boot alarm; clips=6`（原文见 `verify/prod-kitchen-bootline.log:69`）；
- `local-led: 板载 LED 就绪：GPIO1 单色，低电平有效，启动默认灭（no boot flash）`（同文件 `:66`）；
- `wifi:mode : sta (50:78:7d:16:ed:60)`（同文件 `:97`，MAC 复核）；
- PIR 相关：代码在 bench 模式才打印 `PIR GPIO%d`/`PIR raw` 日志（`node_main.c` 中 `LOCAL BENCH` 分支）；**正式固件不会逐次打印 PIR**，因此验收应看上报 JSON 里 `sensors.motion` 的 `lastActiveTs/countToday` 变化 + 触发无活动告警时的 `告警提示音开始`/`语音播报开始 clip=5`。

## 6. 风险与 STOP 条件

### 6.1 风险
1. **空间**：仅剩 28,384 B（PIR 版），IDF 已告警“nearly full”；任何后续新增语音/功能都可能直接构建失败。若将来 `free ≤ 0`，构建会失败 → 按 STOP 处理，改用 §4.5 选项。
2. **构建产物含私有 Wi-Fi**：正式构建必须在 `.local` 私有目录完成；`_work/` 内的是**等长占位符版本，不可烧录**。本报告不含 SSID 之外任何凭据（本报告不含口令值）。
3. **口令说明（已核实，无新增泄露）**：在板候选的最终 `sdkconfig` 中 Wi-Fi 口令值与**公开**的 `competition/esp32-node/sdkconfig.defaults:3` 演示默认值相同（该文件本就在仓库里）；审计中作 sdkconfig 比对时该值曾回显到本机终端一次，但未写入任何证据文件。若该口令是真实在用口令，仍建议轮换（它显然是弱口令）。`_work/` 内的构建只使用等长占位符。
4. **当前告警状态**：`competition/bridge/status.json:1` 显示厨房 `state=ACKED`、`alarm.id=e-uf849b8b9-1`；另有同目录 `ALARM-PROTECTION-STATUS.md` 记录 00:33 的真实 SOS `e-1793032428-2`、00:47 疑似重启、00:48 ACK 重试。**烧录=复位/重刷 app**，会重置设备时钟盐与告警序号；若云端仍有无法再确认的陈旧告警，先查清再动（沿用该文件的 STOP 意见）。
5. **定向播报链路未核实**：`notice` 派发依赖 bridge 以 `--sos-source/--sos-targets` 启动；本轮**未核对** 9101 当前命令行（只读进程信息受限/未做），故“定向播报是否真的在生效”记为 **[未知]**。PIR 镜像不会影响该逻辑，但验收时不要把它当成已闭环。
6. **并发修改**：workspace 是共享目录，其他会话可能改动 `competition/esp32-node/main/*`；本次隔离副本取的是 00:55 快照，与 00:03 构建态一致（§2.2）。**正式构建前重新核对 `main/*.c` 的 SHA-256 / mtime**，若与本次不一致，先重新审计再构建。
7. **PIR 电气/安装**：5 V 供电、信号 3.3 V、GND 共地、镜头朝向/延时电位器、上电预热 30–60 s 都会影响验收；HC-SR501 输出为高脉冲（与固件“高=有人”匹配）。**实物是否占用 GPIO38 未知**。
8. **误报语义**：`NO_MOTION` 只表示“长时间未检测到活动”，不能表述为跌倒/昏迷/无人（沿用既有文案与边界）。

### 6.2 STOP（出现任一项立即停手，不得烧录/复位）
1. 当前在板镜像无法确认是 43C1183A（例如读了 `app` 分区哈希不符）→ 先查清，不得覆盖。
2. 候选 PIR 镜像构建 `free ≤ 0` 或出现 `region ... overflowed` / `partition too small`。
3. GPIO38（或所选候选脚）与实物接线冲突、或用户未确认接线/供电。
4. PIR 模块为低有效输出（与固件固定“高=有人”相反）且未加反相/未改代码。
5. 云端仍存在无法确认的陈旧告警、或 `ALARM-PROTECTION-STATUS.md` 的待确认项未闭环。
6. workspace 源码在正式构建前与本次审计快照不一致且未重新评审。
7. 任何要求“全片擦除/写 bootloader/写分区表/改 NVS/改 Wi-Fi 配置”的方案。

## 7. 证据索引（路径 : 行）
| 用途 | 路径:行 |
|---|---|
| 在板候选烧录记录 | `competition/evidence/2026-10-26-wireless-sos-button-final/build/flash-kitchen-notice-COM5.json:2-16` |
| 00:08 身份/备份记录 | `…/2026-10-26-wireless-sos-button-final/build/identity-backup-COM5.json:2-16` |
| 21:22 身份/备份记录 | `competition/evidence/2026-10-26-kitchen-sos-led-speech-final/build/identity-backup-kitchen.json:2-10` |
| v30 清单（非恢复目标） | `…/2026-10-26-kitchen-sos-led-speech-final/build/FIRMWARE-MANIFEST.md:16,22,52,56` |
| 候选构建配置来源 | `.local/notice-20261026/kitchen-notice/{CMakeCache.txt:431,508; project_description.json:3,5,7}` |
| 候选构建日志（defaults/体积） | `…/2026-10-26-wireless-sos-button-final/build/build-kitchen-notice.log:4,10-20,59,67,99,102` |
| 当前板启动/联网日志（**注意：该日志是在板 v20 版**，见 §2.2 说明） | `…/2026-10-26-kitchen-sos-led-speech-final/verify/prod-kitchen-bootline.log:23,31,42,43,63,66,69,97,124` |
| 候选烧录后启动日志（缺 init 行） | `…/2026-10-26-wireless-sos-button-final/verify/kitchen-notice-boot.log:3,21` |
| 身份/端口约定 | `competition/docs/evidence/2026-10-26-new-chat-handoff.md:44-50,63-64` |
| 烧录脚本保护行为 | `…/2026-10-26-kitchen-sos-led-speech-final/tools/flash-app.ps1:4-12,27-39,51-58` |
| 身份备份脚本行为 | 同目录 `tools/device-identity-backup.ps1:27-45` |
| 构建脚本行为 | 同目录 `tools/build-firmware.ps1:37-60`；`tools/build-kitchen-v30.ps1:10-18` |
| 告警保护状态 | `competition/evidence/2026-10-27-voice-led-restore/ALARM-PROTECTION-STATUS.md:5-20` |
| 隔离构建产物/日志 | `competition/evidence/2026-10-27-voice-led-restore/_work/{build-base-fixed,build-pir38}/`、`_work/logs/*.log` |

> 日志/JSON 行号与工具一致；`main/*.c`、`main/Kconfig.projbuild` 为 UTF-8 中文文件，不同工具（rg/编辑器）行号偶有偏移，引用时以符号名/配置名为准。

## 8. 本轮明确未做
未开 COM、未跑 esptool、未烧录/复位、未按键；未改 workspace 源码/`.local` 私有文件；未重启或替换 broker/bridge/public-sync；未部署/安装 APP；未验证 PIR 实物；未核对 9101 bridge 当前参数；未把任何“构建成功”写成“真机验收通过”。
