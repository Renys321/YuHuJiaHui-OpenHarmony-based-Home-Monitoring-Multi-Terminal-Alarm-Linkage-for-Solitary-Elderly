# FLASH —— 构建产物、备份与烧录命令

> **本文件只记录命令，交付过程未执行任何烧录，也未打开任何 COM 口。**
> 烧录由 Lead 执行：**先整片备份，再确认目标板，最后才写 flash**。

## 1. 构建环境与命令（真实构建已通过）

- ESP-IDF：`v5.1.6`（`D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6`）
- target：`esp32s3`；Flash：**16MB / DIO / 80MHz**；PSRAM 未启用（固件不使用）
- 分区表：`SINGLE_APP_LARGE`（app 分区约 1.5MB，无 OTA）
- 主任务栈：8192
- GPS 主动查询：`CONFIG_WEARABLE_QUERY_GPS_ON_SOS=n`（正式交付默认关闭；SOS 的 `gps` 固定 `null`，
  M100 自己主动上报固定格式 `经度_纬度` 由适配器解析）
- UART 成帧：`\n` 立即成帧 + **100ms 空闲超时成帧兜底**（真机 M100 下行不追加换行）
- 版本说明：本版仅修复下行无换行的 ACK 成帧，其余行为与上一版一致

```powershell
Set-Location <WORKSPACE>\competition\esp32-node-wearable
. 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1'
idf.py build
```

最后一次构建输出（增量确认）：

```
Project build complete. ...
BUILD_EXIT=0
```

## 2. 产物与 SHA256（最终构建，含“100ms 空闲成帧”修复）

| 产物 | 大小 | SHA256 |
|---|---|---|
| `build/esp32_wearable_sos.bin`（app） | **274432 字节** | `84F9819F571E6FDCBCD03D7D7AE4213786262C15B9C31E51A5A1D99FD1140207` |
| `build/bootloader/bootloader.bin` | 20960 字节 | `9AB4A5FA80FD445717073CF9A086B761213CCFF51D25173440451C1D9DD6DA35` |
| `build/partition_table/partition-table.bin` | 3072 字节 | `5295E8C42D6FB5F95E4E8A185932C6191D27CFC5078322475347E40E71AF815A` |
| `build/esp32_wearable_sos.elf`（调试用） | 4174208 字节 | `7172A521C0E6E0D0F9808FF46EF1A83502D92540A45F0CF1AC1D6A6BE6C851B9` |

烧录地址（来自 `build/flash_args`）：

```
--flash_mode dio --flash_freq 80m --flash_size 16MB
0x0      bootloader/bootloader.bin
0x8000   partition_table/partition-table.bin
0x10000  esp32_wearable_sos.bin
```

app 分区剩余约 82%（`bootloader.bin` 36% free；`esp32_wearable_sos.bin` binary size 0x43000）。

本次固件相对上一版的唯一功能修复：**M100 下行不追加 `\n` 时，UART 连续 100ms 无新字节即把当前缓冲
当作一整行处理**（仍走同一 `wb_handle_line`，`\n` 立即成帧的既有行为不变，超长仍整行丢弃）。

## 3. 烧录前必须备份（Lead 执行，未执行）

整片 16MB 备份（`0x1000000` = 16MB）。**不要覆盖已有备份**，文件名带日期：

```powershell
Set-Location <WORKSPACE>\competition\esp32-node-wearable
. 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1'
New-Item -ItemType Directory -Force -Path .\backup | Out-Null
esptool.py -p COM8 -b 460800 read_flash 0 0x1000000 .\backup\com8-full-backup-20261027.bin
Get-FileHash .\backup\com8-full-backup-20261027.bin -Algorithm SHA256
```

备份校验：文件大小必须正好 **16777216 字节**，并记录 SHA256。
（重点保留 NVS 分区 `0x9000-0xF000`：现役固件的事件/配置状态都在里面。）

只读确认目标芯片（不写 flash）：

```powershell
esptool.py -p COM8 -b 460800 chip_id
```

**确认输出为 `ESP32-S3` 且 flash 为 16MB 后才继续。**

## 4. 烧录命令（Lead 执行，本交付未执行）

推荐方式（使用工程内构建产物，参数与 `flash_args` 一致）：

```powershell
Set-Location <WORKSPACE>\competition\esp32-node-wearable
. 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1'
idf.py -p COM8 -b 460800 flash
```

等价 esptool 命令（显式偏移，便于留痕）：

```powershell
$env:ESPTOOL = "$env:IDF_PATH\components\esptool_py\esptool\esptool.py"
esptool.py -p COM8 -b 460800 --before default_reset --after hard_reset --chip esp32s3 `
  write_flash --flash_mode dio --flash_size 16MB --flash_freq 80m `
  0x0 build\bootloader\bootloader.bin `
  0x8000 build\partition_table\partition-table.bin `
  0x10000 build\esp32_wearable_sos.bin
```

> 不擦除整片 flash：app 覆盖写入即可，NVS（事件/计数器状态）保留在 `0x9000`。
> 如需恢复旧固件：用第 3 步的整片备份回写
> `esptool.py -p COM8 -b 460800 write_flash 0x0 .\backup\com8-full-backup-20261027.bin`。

## 5. 烧录后监控（Lead 执行）

```powershell
Set-Location <WORKSPACE>\competition\esp32-node-wearable
. 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1'
idf.py -p COM8 -b 115200 monitor
```

预期启动日志（按顺序）：

```
wearable: 随身 SOS 固件启动：dev=esp32-sos fw=wearable-1.0.0（无 Wi-Fi，M100 4G 透传）
wearable: GPIO 已初始化：按键 GPIO4（上拉，低有效），蜂鸣器 GPIO5（高电平触发，待机 0）
wearable: UART1 已初始化：TX=GPIO17 -> M100 RXD, RX=GPIO18 <- M100 TXD, 115200 8N1 无流控
wearable: NVS 无历史状态（首次启动）        # 或：恢复未确认事件 alarm=sos-<n>-<hex> ...
wearable: UART TX -> {"v":1,"dev":"esp32-sos","t":"boot","uptimeMs":...,"fw":"wearable-1.0.0"}
```

按键一次应看到：`按键按下（20ms 采样 + 60ms 消抖确认），立即起响` →
`新事件已写入 NVS` → `UART TX -> {"v":1,"dev":"esp32-sos","t":"sos","alarm":"sos-<n>-<hex>",...,"gps":null}`
→ 之后每 10s 同一 alarmId 重发、每 30s 一条 `hb`；收到匹配 ACK 后
`收到匹配 ACK ... 停止提示，事件置 IDLE` 并立即 `UART TX -> {"v":1,...,"t":"ack",...,"cmd":"..."}`。

若服务端下行 ACK 不带换行（M100 原样透传），会先看到：

```
wearable: UART 空闲 100ms 成帧（服务端下行未带换行）: {"v":1,"t":"ack","alarm":"sos-<n>-<hex>","cmd":"..."}
wearable: 收到匹配 ACK：... -> 停止提示，事件置 IDLE ...
wearable: UART TX -> {"v":1,"dev":"esp32-sos","t":"ack","alarm":"sos-<n>-<hex>","cmd":"..."}
```

## 6. 安全与边界

- 本交付**未打开 COM5/COM8/COM11 等任何串口、未烧录、未擦除**；以上命令全部由 Lead 执行。
- 烧录前必须完成第 3 步整片备份并记录 SHA256。
- 不要使用 GPIO6/19/20/26–37（Flash/USB/PSRAM 专用）；固件已做编译期 `#error` 检查。
- 接线见同目录 `WIRING.md`：ESP32 与 M100 **必须共地**，M100 独立 5~12V 供电。
