# 修改文件清单（LOCAL-ALARM-LED-CLOSURE）

修改前快照在 `source-before/`，修改后快照在 `source-after/`。SHA-256 大写。

## 1. 公共树 `competition/esp32-node/`

| 文件 | 修改前 | 修改后 | 说明 |
|---|---|---|---|
| `main/local_led.c` | 新增 | `C7F6A3C636F14A6999B6FFDFAC141AB1446B5D255CB107C5F63B866AB40077DD` | 新增单色 LED 非阻塞告警灯效模块 |
| `main/local_led.h` | 新增 | `3E4B9E69BB59B3477FCD4A2A2FEE0993A877A7A0027BC1111D897A8102212F4C` | 模块接口 |
| `main/node_main.c` | `25863709CC03270675AF25D86A552B10D7EBFD15FACFD7D88F1BDD5DCB21A1A1`（含 KEY0 SOS 最新版） | `6D5CC5A149244CCCBBC41F83A5E9CC479ADB03F957B49BF55421AB62615FF4D0` | 仅新增：include、`local_led_start()`、主循环 `local_led_tick()`、台架 `inj led` 命令；**未改 KEY0/语音/告警逻辑** |
| `main/Kconfig.projbuild` | `4F5940CDF062CC737EAA05BA16E4D3B1117DDA0A3A128915FA5985DD011CAA44` | `B491D0FDD72857C5EA192C18284FB426DBC7DDF23BB74DAB55ACBE5AA3B4B0D9` | 新增 `NODE_LED_GPIO` / `NODE_LED_ACTIVE_LOW` |
| `main/CMakeLists.txt` | `4BDC5FCE5105A4A1E1F7CA3F630E48F01B170269E55A9EF8C69EB7464AD8FE5B` | `21A145D88DA3B10BC97D4454DDFEBF1BD2361085CA4D28107DE193AEBB4BAECD` | SRCS 增加 `local_led.c` |
| `profiles/alarm-closure.sdkconfig.defaults` | `551A50A18A973849762827251D11E1D687064051BBD52095F1AE33388E7BB491` | `D29DAA070E6E49DBD192BF6AC00788D6F5A9176C0FB06027EA4D500D0C45C30B` | 正式启用 LED：GPIO1、低电平有效 |
| `profiles/alarm-bench.sdkconfig.defaults` | `1C97179A43B16112F2A7D809C34C500F9B54E108EB403B56B64E51BB960EEE65` | `997F992B478B8298DE0F036FCE0EB456594FD3A2AD7B45D03EBB3C8D45D13A71` | 台架启用 LED |

未改动：`main/local_voice.c`（含 KEY0 任务 19:07 的 amp standby）、`local_voice.h`、`voice_pins.h`、`alarm_logic.h`、`jlink`/分区/网络配置。

## 2. 卫生间私有树 `.local/bathroom-voice-20261026/src/`

| 文件 | 修改前 | 修改后 | 说明 |
|---|---|---|---|
| `main/local_led.c` | 新增 | 同公共树 `C7F6A3C6…77DD` | 同一模块 |
| `main/local_led.h` | 新增 | 同公共树 `3E4B9E69…2F4C` | 同一接口 |
| `main/node_main.c` | `895785F9FCD08898F796CF90EBAA5DDA8D949ED409751ACA43DD5947EFAB9EF3` | `B2DA25E13F24E4A7CC5784B70AA23B8D4E70879D8519F4213A33C34FB853E2D2` | 仅 LED 4 处接入（include/init/tick/台架命令）；保留卫生间满幅 PCM、音量 30 |
| `main/Kconfig.projbuild` | `34647AD6FFDC4112C3AA96FDC6ED6C89A5AB19854FD7463B9E7E2B87F68880C0` | `FF77B93BF238E81E10703D0ECBFD2C663C123264B457BA5CB7FFB8D954D9E9D9` | 新增 LED 配置；保留音量 0..33 |
| `main/CMakeLists.txt` | `4BDC5FCE…FE5B` | `21A145D8…4ECD` | 增加 `local_led.c` |
| `profiles/alarm-closure.sdkconfig.defaults` | `551A50A1…7B491` | `D29DAA07…C30B` | 同公共树 |
| `profiles/alarm-bench.sdkconfig.defaults` | `1C97179A…B250` | `997F992B…3A71` | 同公共树 |

注：卫生间 `node_main.c` 在编辑过程中曾被一次 PowerShell 管道按 GBK 误读写；已用 `source-before/bath-node_main.c` 完整恢复后，重新用 UTF-8 安全编辑器施加全部 LED 改动，并重新编译通过（见 `source-after/bath-node_main.c` 与构建日志）。

## 3. 证据目录新增（不涉及固件源码）

`LED-SCHEMATIC-EVIDENCE.md`、`REPORT.md`、`CHANGES.md`、`build/`（4 个构建日志 + 2 个身份 JSON + 写板 JSON）、`verify/`（台架 LED 演示日志、正式固件启动日志）、`tools/`（构建/烧录/身份/串口场景工具）、`source-before/`、`source-after/`。

## 4. 明确未改

- bridge / command-sync / homemon / DAYU / 手机 APP / D/E backend：未改。
- 烧录仅 app 分区（0x10000），未全片擦除、未写 bootloader/分区表/NVS，未改 Wi-Fi/deviceId/引脚接线。
- 厨房 KEY0 SOS 任务的最新源码与逻辑完整保留（正式固件同源，`CONFIG_NODE_SOS_KEY0_ENABLED=y`，启动日志 `SOS 按键就绪：板载 KEY0 = XL9555 P1_7`）。
- 厨房 MQ-5 仍在 GPIO7/ADC1_CH6、音频 LRCK 仍在 GPIO9、音量 20；卫生间音量 30、满幅 PCM。
