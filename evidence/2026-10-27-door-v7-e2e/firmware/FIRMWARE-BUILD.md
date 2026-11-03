# FIRMWARE-BUILD.md — 门磁扩展字段上报固件（v7，双节点）

- 任务：task-11（team 任务板）
- 时间：2026-10-27 01:41–01:52 Asia/Shanghai
- 目标：恢复门磁 **扩展 JSON**（`open` 可 `null`、`lastCloseTs`、`seq`、`events[]`）供 v7 后端/网关接收；保留各节点全部现有功能；**不带 remote_sos**；不烧录、不开串口、不碰设备、不改工作区。
- 构建主机/工具链：Windows + ESP-IDF v5.1.6（`D:\Espressif-5.1.6`），`idf.py` cmake/ninja，CCACHE 关闭。

---

## 1. 交付产物（本目录）

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `bath-v7-esp32_elder_node.bin` | **1,011,648 B** (0xF6FC0) | `56D9A8054EC6B1AA0FB19E5390D6744E55FD2B572DE722742A799F5C3A8CAA6B` |
| `kitchen-v7-esp32_elder_node.bin` | **1,022,480 B** (0xF9A10) | `0AA8144D87D76DF3E946FA81A493E67C050CEC8C86DAFC4AA1D8C3A3170E179B` |
| `bath-v7-bootloader.bin` | 20,960 B | `D2E3C2636DBF34A815845C1808709C4E6951ED733FC3CCF92F7594D6C59EBBFA` |
| `bath-v7-partition-table.bin` | 3,072 B | `7F00B6C042A89B15B0CAC534F82ED988CAF29278FF5700B0C511EB1B5BB7C820` |
| `kitchen-v7-bootloader.bin` | 20,960 B | `0F5E8DC72468A86CFC09953105EAB94F1B87E7C784208D7BF75A9885B9943AE2` |
| `kitchen-v7-partition-table.bin` | 3,072 B | `7F00B6C042A89B15B0CAC534F82ED988CAF29278FF5700B0C511EB1B5BB7C820` |
| `build-bath.log` / `build-kitchen.log` | 256,182 / 256,290 B | 完整 idf.py 构建日志副本 |
| `door-json-samples.jsonl` | 308 B | host 侧门磁 JSON 形状测试的 3 条样本输出 |
| `SHA256SUMS.txt` | — | 本目录清单校验 |

构建源码（隔离，不进入本目录）：
- 卫生间：`competition/esp32-node/.local/door-v7-20261027/bath-src`（源：`.local/voice-led-restore-20261027/bath-compat-src`）
- 厨房：`competition/esp32-node/.local/door-v7-20261027/kitchen-src`（源：`.local/kitchen-door-20261027/src`）
- 构建目录：`.local/door-v7-20261027/build-bath`、`build-kitchen`

## 2. 与在板固件的关系（只烧 app 的依据）

| 节点 | 在板 app（现有） | 本次 app | 增量 | 1 MiB 分区余量 |
|---|---|---|---|---|
| 卫生间 | 1,011,312 B `F56A5A64…258BEFC` | 1,011,648 B | **+336 B** | **36,928 B (0x9040, 4%)** |
| 厨房 | 1,022,160 B `08FD7F21…2D0D` | 1,022,480 B | **+320 B** | **26,096 B (0x65F0, 2%)** |

- 两份 **partition-table 与各自在板基线构建逐字节相同**（同一 SHA-256 `7F00B6C0…B7C820`）→ 分区表未变。
- 两份 bootloader 与各自基线同为 20,960 B，仅 **37 字节不同**（首个差异 0x15F2）：全部为 IDF 内嵌编译时间串 `compile time …`（卫生间 `01:44:25` vs `01:10:56` 基线为 `01:02:03`；厨房 `01:46:35` vs 基线 `01:30:46`）与镜像尾部校验字节 → 配置/功能等价。
- 结论：**后续只烧 app（偏移 0x10000）即可，不需要写 bootloader / 分区表。**

## 3. sdkconfig 关键项（来自各 build 目录最终 sdkconfig，均已与在板基线一致）

| 配置项 | 卫生间 | 厨房 |
|---|---|---|
| `CONFIG_NODE_ID` | `esp32-bath` | `esp32-kitchen` |
| `CONFIG_NODE_ROOM` | 卫生间 | 厨房 |
| `CONFIG_NODE_DOOR_GPIO` | 14 | 14 |
| `CONFIG_NODE_DOOR_OPEN_LEVEL` | 1 | 1 |
| `CONFIG_NODE_DOOR_CONFIRM_COUNT` | 2 | 2 |
| `CONFIG_NODE_DOOR_CACHE_MAX` | 8 | 8 |
| `CONFIG_NODE_DOOR_CACHE_KEEP_SEC` | 300 | 300 |
| `CONFIG_NODE_MOTION_GPIO` | 36 | 38 |
| `CONFIG_NODE_MQ2_ADC_CHANNEL` | -1（禁用） | 5（GPIO6） |
| `CONFIG_NODE_MQ5_ADC_CHANNEL` | -1（禁用） | 6（GPIO7） |
| `CONFIG_ESP_MAIN_TASK_STACK_SIZE` | 8192 | 8192 |
| `CONFIG_NODE_VOICE_ENABLED` / `VOLUME` | y / 30 | y / 30 |
| `CONFIG_NODE_LED_GPIO` / `ACTIVE_LOW` | 1 / y | 1 / y |
| `CONFIG_NODE_SOS_GPIO` / `KEY0_ENABLED` | 15 / n | -1 / y |
| `CONFIG_NODE_ALARM_BENCH_INJECT` | n | n |
| `CONFIG_NODE_AHT20_ENABLED` | y | y |

构建方式：**直接以在板基线 sdkconfig 作为种子**（`bath-compat-sdkconfig` / `build-door-kitchen/sdkconfig` 复制为 `build-*/sdkconfig`），defaults 仅使用空文件，避免 defaults 链重新推导导致配置漂移。故上面每一项都与在板固件一致，唯一源码差异是 report() 门磁段。

## 4. 源码改动（仅 1 个文件/节点）

- 卫生间 `bath-src/main/node_main.c`：把 compat 版的“旧两键”门磁段**还原为扩展 JSON**（与 `.local/notice-20261026/bath-merged-src/main/node_main.c` **逐字节相同**，SHA-256 `8BB1BFA96AFC894E9D269C2ADEFD4D9D1466323EF111B2C2E357FBF3DD190517`）。其余文件（语音/LED/门磁采样/300s/ACK/STOP、Kconfig、profiles、语音素材）与在板源码逐文件 SHA-256 相同。
- 厨房 `kitchen-src/main/node_main.c`：同样还原扩展 JSON，并把 `json[900]→json[1600]`、`door_json[80]→door_json[700]`（与卫生间实现一致）。其余文件与 `.local/kitchen-door-20261027/src` 逐文件 SHA-256 相同。
- diff 规模（相对各自在板源码）：厨房 `+22/−10`（仅 report 段）；卫生间同段落还原。
- **未新增 remote_sos**：notice/announce 逻辑与素材未动，两树均无 remote 专属语音资源。

扩展 JSON 实际格式（report()）：

```json
"door":{"open":true|false|null,"lastOpenTs":<ms>,"lastCloseTs":<ms>,"seq":<int>,
        "events":[{"seq":<int>,"open":true|false,"ts":<ms>}, ...]}
```

- `open=null`：门磁基线未建立（上电后尚未得到连续确认读数）→ 状态未知，**不再谎报关闭**。
- `events[]`：仅当未送达缓存非空时出现（最多 `CACHE_MAX=8` 条，按 seq 升序）。
- 门磁未启用（`DOOR_GPIO<0`）时保留旧固定字段（本两节点均启用，该分支不生效）。

## 5. JSON 格式验证（3 条，均严格 JSON.parse 通过）

host 侧 `tests/host_door_json_shape_test.c`：将两树 report() 中门磁段 snprintf 块**原样复制**到 host 测试，用 `gcc -std=c11 -Wall -Wextra -Werror` 编译（零警告），由 `node JSON.parse` 严格校验：

```
{"door":{"open":null,"lastOpenTs":0,"lastCloseTs":0,"seq":0}}                      -> VALID (open=null, 无 events)
{"door":{"open":true,...,"seq":7,"events":[{"seq":6,...},{"seq":7,...}]}}          -> VALID (events=2)
{"door":{"open":false,...,"seq":8}}                                               -> VALID (closed, 无 events)
```

- 编译器字符串验证：两份 bin 中均含 `"door":{"open":%s,"lastOpenTs":%lld,"lastCloseTs":%lld,"seq":%d`、`,"events":[`、`{"seq":%d,"open":%s,"ts":%lld}`（从镜像字节按 ASCII 检索命中）。
- 缓冲安全（最坏情况）：门磁段 583 B / 700 B；整条上报 JSON 1,062 B / 1,600 B，均不截断。
- 栈影响：report() 局部缓冲从 900+80 增至 1600+700+80（**+780 B**）；主任务栈 8192 B（与卫生间在板同配置，卫生间此前已使用 1600/700 布局运行）。
- host 单测（gcc 12.2.0 `-Wall -Wextra -Werror`，全部零警告）：
  - 卫生间：`host_alarm_logic` PASS=141/0、`host_bathroom_logic` PASS=54/0、`host_door_logic` ALL PASS、adpcm 6/6 PASS。
  - 厨房：`host_alarm_logic` PASS=141/0、`host_door_logic` ALL PASS、`host_notice_logic` 42/0、adpcm 6/6 PASS。

## 6. 编译警告（两节点均仅 2 条，无新增）

1. `driver/i2s.h:27:2: warning: #warning "This set of I2S APIs has been deprecated…"` —— IDF 既有 deprecated 提示（门磁移植前即存在）。
2. `Warning: The smallest app partition is nearly full (4% / 2% free space left)!` —— 分区余量提示（见风险）。

除以上两条外，两节点构建日志中无 `warning:` 记录。

## 7. 复现命令

```powershell
$t='<WORKSPACE>\competition\esp32-node\.local\door-v7-20261027'
# 卫生间（以在板 sdkconfig 为种子）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$t\tools\build-v7.ps1" `
  -ProjectDir "$t\bath-src" -BuildDir "$t\build-bath" `
  -SeedSdkconfig '<WORKSPACE>\competition\esp32-node\.local\voice-led-restore-20261027\build-bath-compat\sdkconfig' `
  -DefaultsFile "$t\tools\empty.sdkconfig.defaults" -LogPath "$t\logs\build-bath.log"
# 厨房
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$t\tools\build-v7.ps1" `
  -ProjectDir "$t\kitchen-src" -BuildDir "$t\build-kitchen" `
  -SeedSdkconfig '<WORKSPACE>\competition\esp32-node\.local\kitchen-door-20261027\build-door-kitchen\sdkconfig' `
  -DefaultsFile "$t\tools\empty.sdkconfig.defaults" -LogPath "$t\logs\build-kitchen.log"
```

## 8. 风险与上线注意

1. **厨房分区余量仅 26,096 B（2%，0x65F0）**：本次扩展字段只占 +320 B，已低于 30 KB 安全线；再叠加任何功能/素材会非常接近 1 MiB 上限（>20 KB 阈值仍未触发强制停止，但必须限制后续增量）。卫生间 36,928 B（4%）相对宽裕。
2. **上线顺序**：`open:null`/`lastCloseTs`/`seq`/`events` 需 v7 后端与网关 adapter 白名单同时就绪；若先烧固件而后端仍是 v6 schema，可能出现字段白名单告警或事件表未识别（本任务不含后端/网关改动，由其他任务负责）。
3. **`open=null` 语义**：表示“基线未建立（未知）”，后端/APP 需按未知处理，不得当作“关闭”。
4. **事件补传依赖 seq 幂等**：后端须按 `(deviceId, seq)` 去重；重启后 seq 从 NVS 继续单调递增。事件缓存上限 8 条 / 保留 300 s，超出覆盖最旧。
5. **bootloader/分区表不烧**：两份 partition-table 与在板基线逐字节一致；bootloader 仅编译时间戳差异，无需更新。只烧 `*-v7-esp32_elder_node.bin` 到 0x10000。
6. **门磁极性**：两节点 `OPEN_LEVEL=1`（高=开）。上板后仍需确认开/关门方向与上报相反时改 overlay 为 0 重建。
7. **`lastOpenTs/lastCloseTs` 不跨重启恢复**：仅 `seq` 与事件 FIFO 持久化；重启后无新事件时时间戳为 0（旧合同既有语义）。

## 9. 边界声明

- 未烧录、未开串口、未按设备按键、未重启任何服务、未部署后端。
- 未修改 workspace `competition/esp32-node` 源码，未修改 `.local` 下既有目录（仅新增 `.local/door-v7-20261027/`，并只读取既有构建基线 sdkconfig 副本）。
- 本交付只写入 `competition/evidence/2026-10-27-door-v7-e2e/firmware/`。
