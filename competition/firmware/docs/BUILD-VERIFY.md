# 固件构建验证记录

## 2026-11-01：模块拆分后重建

环境：ESP-IDF v5.1.6（`D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6`），target `esp32s3`。
构建命令：

```powershell
Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build-node.ps1 -Node kitchen
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build-node.ps1 -Node bathroom
```

结果：两个工程都编译通过，0 错误。只有 IDF 自带的 I2S 旧 API 弃用警告。

| 节点 | 产物 | 大小 | SHA-256 |
|---|---|---|---|
| 厨房 | `kitchen/build/esp32_elder_node.bin` | 1,168,720 B | `2C0871A52F0496BE1B0D75502AF23B6ED646131764DF041308E7EAEF9F911B0C` |
| 卫生间 | `bathroom/build/esp32_elder_node.bin` | 1,157,728 B | `E9DA17FC301A85D700A967CD0609E6101C21906C1BF93D9D06B95876A6232046` |

两个工程的 app 分区都是 4 MB，当前镜像占约 28%，余量约 72%。
客厅这次没有重新构建。

**这两个 bin 没有烧录。** 板子上仍是之前的固件，源码与在板行为不完全一致。真要上板前，先按 `docs/NODES.md` 核对 MAC 和串口，再决定用整包还是只写 app。

### 本次改了什么

- 把原来 2300 多行的 `node_main.c` 拆成 `board_io.c`、`wifi_link.c`、`climate.c`、`door_monitor.c`、`announce.c`、`gw_link.c`，`node_main.c` 只保留流程编排。
- 重写了注释和部分日志以外的说明文字，删掉了“契约 §x”这类文档引用。
- 编译期检查从 9 处 `#error` 收到 3 处：台架依赖语音、电池配置合法性、语音引脚冲突。`voice_pins.h` 的 5 个条件合成 1 个。
- 串口任务名改为由调用方传入：现场是 `serial-cmd`，台架仍是 `bench-uart`。
- Kconfig 帮助文本和本目录三份文档重写，配置项名称、默认值、范围没动。

### 行为核对

拆分时对搬走的函数做了 token 级比对（忽略注释和空白），并按改名映射对齐：

- 原样搬走且一致的：`aht20_crc8`、`dht11_read`、`dht11_wait_level`、`climate_read`、`wifi_start`、`wifi_event_handler`、`wifi_time_sync_start`、`beep_init`、`key0_init`、`board_xl9555_read/write/read_ports`、`announce_*`、`door_event_enqueue`、`door_event_expire`、`door_state_load`、`door_state_save`、`gw_connect`、`gw_send`、`active_danger`、`judge`、`handle_command`、`notice_*`、`raise_alarm`、`battery_sample`、`battery_tick` 等。
- 有结构性改动、逐段核对过的：`app_main`（启动顺序改成模块初始化）、`report`（door 段交给 `door_report_json`）、`sample`（门磁交给 `door_monitor_poll`）、`sos_handle_fast`（KEY0 读取交给 `board_key0_poll`）、`gw_poll`（非语音走注册的处理函数）、`serial_command_task`（台架和现场共用，任务名参数化）。

二进制哈希和之前不同是正常的：`ESP_ERROR_CHECK` 会把 `__FILE__`/`__LINE__` 编进固件，拆分文件后行号和路径都变了。判断有没有改逻辑不能只看哈希，要看上面的函数级比对。

### 构建时注意

1. 从 Git Bash 调 PowerShell 构建脚本时，IDF 的 `export.ps1` 会因为 `MSYSTEM` 环境变量拒绝初始化。先在 PowerShell 里执行 `Remove-Item Env:MSYSTEM` 再构建。
2. 改过 `sdkconfig.defaults` 后要先删该工程的 `sdkconfig`，否则 defaults 不会覆盖旧配置。
3. `tools/sync-shared.ps1` 只同步 `*.c`、`*.h`、`Kconfig.projbuild` 和 `voice/*.adpcm`，不同步各工程自己的 `CMakeLists.txt`。新增源文件时要同时改四个 CMakeLists（common 和三个节点）。

## 历史记录（2026-10-28）

当时的构建结果用于对照，不再代表当前源码：

| 节点 | 大小 | 分区 |
|---|---|---|
| 厨房 | 1,023,440 B | 1 MB app |
| 卫生间 | 1,012,496 B | 1 MB app |
| 客厅 | 770,080 B | 默认分区 |

后来厨房和卫生间扩成 16 MB Flash + 4 MB app 分区，解决了 1 MB 分区只剩二十多 KB 的问题。旧哈希留在 git 历史里，这里不再重复。

## 复现

```powershell
cd <WORKSPACE>\competition\firmware
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue; .\tools\sync-shared.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue; .\tools\build-node.ps1 -Node kitchen"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item Env:MSYSTEM -ErrorAction SilentlyContinue; .\tools\build-node.ps1 -Node bathroom"
```

如果改了公共源码却忘了同步，构建出来的还是旧副本；先看构建日志里有没有重新编译对应模块。

## 边界

这份记录只证明“当前源码能编译、配置能生效”，不代表已经烧录或做过真机验收。客厅仍是候选板；MQ 阈值没有标定；门磁物理接线和当前 GPIO37 配置是否一致，也没有在本次构建里验证。
