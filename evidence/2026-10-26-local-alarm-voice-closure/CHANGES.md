# 修改文件清单与哈希（LOCAL-ALARM-VOICE-CLOSURE）

所有“修改前”内容已快照在 `source-before/`，修改后快照在 `source-after/`。哈希均为 SHA-256（大写）。

## 1. 公共树 `competition/esp32-node/`（厨房正式/台架构建源）

| 文件 | 修改前 SHA-256 | 修改后 SHA-256 | 说明 |
|---|---|---|---|
| `main/node_main.c` | `657092E6B0C2184A293088C8FE719F638313852B7CB6A872231DF7834CD593B0` | `895785F9FCD08898F796CF90EBAA5DDA8D949ED409751ACA43DD5947EFAB9EF3` | 温湿度稳定器、stop/pause/resume、ACK 回执、限频提醒、SOS 重复/优先级、恢复、台架 UART 注入（条件编译） |
| `main/alarm_logic.h` | `A54FBE499A4A70CD7E92181A5CAF8D889BF546F9EBD1509BEFC3A00A84C5F372` | `548601CBA785FAA57E19965846324B9849FE57ABFB08C0C98FB0A8E0B3F431D2` | 新增 `climate_stab_update` / `alarm_repeat_due` / `no_motion_enabled`（纯逻辑，主机可测） |
| `main/Kconfig.projbuild` | `F66AE357F6545222C4D97F7A76B2E3014A575C783DA68AEB456A189439B4860A` | `5FD86D11C05ECC9C569D91BFCFB608EE481EB1ABA73DAAB4D4255C3316D6350E` | 新增确认/回差/限频/无活动武装/台架注入配置 |
| `test/host_alarm_logic_test.c` | `B58D0BB9C80FEE525F1CFB2F5FE3DC54017673A0FE94D29DDD32DF25A26EC0E5` | `E6E93607B3216A79E9217C5C541A1652D7274E9A44C52E8B75C7DE257E615617` | 新增温湿度确认/回差、限频、无活动门槛断言（85 通过） |
| `profiles/alarm-closure.sdkconfig.defaults` | 新增 | `551A50A18A973849762827251D11E1D687064051BBD52095F1AE33388E7BB491` | 正式参数叠加层 |
| `profiles/alarm-bench.sdkconfig.defaults` | 新增 | `1C97179A43B16112F2A7D809C34C500F9B54E108EB403B56B64E51BB960EEE65` | 仅隔离台架参数叠加层 |
| `main/local_voice.c` / `local_voice.h` / `voice_pins.h` / `main/CMakeLists.txt` | 未修改 | 未修改 | 厨房保持既有 PCM /2 与音量 20 |

## 2. 卫生间私有树 `.local/bathroom-voice-20261026/src/`

| 文件 | 修改前 SHA-256 | 修改后 SHA-256 | 说明 |
|---|---|---|---|
| `main/node_main.c` | `657092E6…93B0` | `895785F9…9EF3` | 与公共树同逻辑 |
| `main/alarm_logic.h` | `A54FBE49…F372` | `548601CB…31D2` | 与公共树同逻辑 |
| `main/Kconfig.projbuild` | `941DAA4C8F9E383353FCAFE422158806C16A84FFF8644A973901ED57C40B6D34` | `34647AD6FFDC4112C3AA96FDC6ED6C89A5AB19854FD7463B9E7E2B87F68880C0` | 与公共树的差异仅为保留卫生间既有的 `NODE_VOICE_VOLUME range 0..33`（音量 30=0 dB）说明；本轮把该差异恢复，避免 30 被 Kconfig 钳制成 15 |
| `main/local_voice.c` | `B89B88B2…5999` | 未修改 | 保留 2026-10-26 已部署的满幅 PCM 播放改动 |
| `profiles/alarm-closure.sdkconfig.defaults` | 新增 | `551A50A1…7B491` | 同公共树 |
| `profiles/alarm-bench.sdkconfig.defaults` | 新增 | `1C97179A…B250` | 同公共树 |
| `profiles/voice-volume30.sdkconfig.defaults` | `832A7FC0…C948` | 未修改 | 音量 30 |

## 3. 证据目录新增工具/记录（不涉及设备固件源码）

`tools/`：`bench-serial.py`（主串口场景验收器，含动态 `{lastAlarm}` ACK）、`reset-capture.py`（RTS 复位+完整启动日志）、`serial-capture.py/.ps1`、`bench-server.js`（隔离 TCP 链路备用，自检 47/47）、`selftest-bench-server.js`、`build-firmware.ps1`、`flash-app.ps1`、`device-identity-backup.ps1`、`hash-evidence.ps1`、`scenarios/*.json`、`README.md`。  
`verify/`：台架场景串口日志（`kitchen-0*`、`bath-0*`）、正式固件正常/重启日志、主机测试日志、live 在线/202 记录。  
`build/`：构建日志、设备身份 JSON、每次写板 JSON。  
`source-before/`、`source-after/`：修改前后源码快照。

## 4. 未改动（明确边界）

- bridge / command-sync / homemon / DAYU 正式 APP / 手机 APP / D/E backend：**未改**。
- `local_voice.c` 声学参数（厨房 /2、卫生间满幅）：未改。
- 分区表、bootloader、NVS 内容、Wi-Fi SSID/密码、deviceId/room/GPIO 接线：未改（写板仅 app 分区）。
- 同一工作区并行 D/E 会话的文件与证据目录：未触碰（`chain-audit.md` 记录边界）。
