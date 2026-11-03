# 变更清单（2026-10-26 / v4 · WIRELESS-SOS-NOTICE）

仅列本轮改动。所有改动都是**增量**，未重写任何既有功能。

## 1. 公共源码（`competition/`）

### 1.1 `competition/bridge/mqtt_bridge.js`

| 变更 | 位置 | 说明 |
|---|---|---|
| 新增参数 `--sos-source` / `--sos-targets` / `--sos-log` | 参数区（`RELAY_TO` 之后） | 三者都为空时功能**完全关闭** |
| 新增 `sosDispatched` 表与 `SOS_DISPATCH_MAX=64` | 同上 | 内存去重，超出按插入顺序淘汰最旧 |
| 新增 `sosFanoutObserve(deviceId, obj)` | `routeCommand()` 之后 | 只有 `deviceId===--sos-source` 且 `state=ALARM ∧ alarm.type=MANUAL_SOS` 才派发；`state=ACKED` 时收口 |
| 新增 `sosLogRecord()` / `sosAlarmId()` | 同上 | 逐目标 `delivered` / `failed_offline` 追加到 JSONL；`alarmId` 只接受 `[A-Za-z0-9._-]{1,32}` |
| `publishStatus()` 末尾加一行 `sosFanoutObserve(dev, obj)` | `publishStatus()` | 该校验后的状态既已发布，也用于编排 |
| 启动横幅增加“求助播报”开关状态 | `=== mqtt_bridge 启动 ===` | 便于现场一眼确认是否启用 |

**未改**：`ack/reset/motion/sos/gas/smoke/fall/monitor` 翻译表、节点绑定/抢占/回灌逻辑、MQTT 编解码。

### 1.2 `competition/esp32-node/main/notice_logic.h`（新增，约 130 行）

纯逻辑状态机：`notice_state_t{active_id, source, last_id}`、`notice_begin()`、`notice_end()`、`notice_yield()`、`notice_reset()`、`notice_id_valid()`。不含任何 I/O 与 FreeRTOS 依赖。

### 1.3 `competition/esp32-node/main/node_main.c`

| 变更 | 说明 |
|---|---|
| `#include "notice_logic.h"` | |
| 新增 `static notice_state_t s_notice;` | 与 `s_alarm_id/s_alarm_type` 并列，互不影响 |
| `announce_start()`：`VOICE_CLIP_REMOTE_SOS` 用 `CHIRP_COUNT_SOS + 2` 声 | 用提示音次数区分“本板求助 3 声 / 外部求助 5 声”，不占额外 flash |
| 新增 `next_token()` / `notice_yield_local()` / `notice_start()` / `notice_ack()` | 只做协议解析与日志翻译，判定全在 `notice_logic.h` |
| `handle_command()` 新增两个分支：`noticeack <id>`、`notice <id> <src>` | 插在 `ack` 与 `stop` 之间，两个前缀都带边界判定 |
| `reset` 分支：清 `s_notice.active_id/source`（**不动** `last_id`） | 重置后同一外部事件可再播一次，符合“reset=回到未知” |
| `raise_alarm()` 首行 `notice_yield_local()` | 本地告警优先，先停外来播报 |

**未改**：`ack`/`stop`/`pause`/`resume`/`reset`/`inj` 的判定与状态迁移；`report()` 的 JSON 结构（字段一个没加）；WiFi/网关/采样/告警状态机/`alarm_logic.h`。

### 1.4 `competition/esp32-node/main/local_voice.h` / `local_voice.c`

- `VOICE_CLIP_REMOTE_SOS = 7`，`VOICE_CLIP_MAX` 随之更新。
- `s_clips[7] = { sos_start, sos_end, "（随身求助）我需要帮助，请尽快过来。" }` —— **复用** `sos.adpcm`，不新增资源。
- `main/CMakeLists.txt`：**未改**（曾短暂加入 `voice/remote_sos.adpcm`，因分区余量只有 4.8 KB 已回退并删除该素材）。

### 1.5 `competition/esp32-node/test/host_notice_logic_test.c`（新增）

42 条断言，`gcc -std=c11 -Wall -Wextra -Werror` 零警告，`ALL PASS`。

## 2. 隔离副本（`.local/`，不进公共树）

| 路径 | 内容 |
|---|---|
| `.local/notice-20261026/kitchen-notice/` | 厨房候选构建目录（已烧录 `43C1183A…`） |
| `.local/notice-20261026/bath-merged-src/` | **门磁分支源码的副本** + `notice_logic.h` + `voice/*.adpcm`；`node_main.c` 打了同样的 5 处 notice 补丁；`Kconfig.projbuild` 音量上限 20→33 |
| `.local/notice-20261026/bath-merged2/` | 三合一卫生间候选构建目录（`42F24D5F…`，**未烧录**） |
| `.local/notice-20261026/bath-notice/` | 仅语音+notice 的卫生间构建（`2C0C7217…`，已被三合一取代） |
| `.local/notice-20261026/backup/` | 厨房 app 分区备份（1,048,576 B） |

## 3. 证据与工具（本目录）

新增：`REPORT.md`、`CHANGELOG.md`、`WIRING.md`、`CHECKLIST.md`；
`tools/` 新增 `sos-fanout-isolated-test.js`、`bridge-regression-smoke.js`、`enable-sos-fanout.ps1`、`make-remote-voice.ps1`、`make-remote-clip.py`；
`voice/` 三档语速的专属文案产物与测量（未启用，留作后续升级）；
`verify/` 新增 `com8-net-verify.log`、`kitchen-notice-boot.log`、`fanout-isolated/`、`bridge-regression/`；
`build/` 新增 `build-kitchen-notice.log`、`build-bath-notice.log`、`build-bath-merged.log`、`build-bath-merged2.log`、`flash-kitchen-notice-COM5.json`、`identity-backup-COM5.json`。

## 4. 明确“没有做”的事

- 未重启/替换运行中的 `broker(1883)`、`bridge(9101)`、`public-sync`。
- 未改 APP（`APP/ElderlyCareGuardian`）、未改后端（`cloud/backend`）、未改 `cloud/onenet`。
- 未烧录卫生间（COM4）、未打开 COM4。
- 未烧录/未改动 COM8 固件。
- 未改门磁工程目录 `.local/door-contact-20261026/**`（只读复制派生出 `bath-merged-src`）。
- 未改路由器、未换网络、未部署 D/E / CAMERA-A / 门磁功能、未安装 APP。
