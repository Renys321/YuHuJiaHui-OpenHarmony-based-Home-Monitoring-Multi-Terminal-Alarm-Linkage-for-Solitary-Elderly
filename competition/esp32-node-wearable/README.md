# esp32-node-wearable —— 随身 SOS（ESP32-S3 + M100MG-B1 4G DTU）

独立 ESP-IDF 5.1.6 工程（target `esp32s3`，16MB flash / N16R8），实现
`competition/docs/wearable-4g-map/DESIGN-CONTRACT.md` 第 3 节 UART 行协议与第 6 节固件行为。

网络层**完全不用 Wi-Fi**：ESP32 UART1 接 YED M100MG-B1 4G DTU，DTU 以 MQTT 透传把 UART 行
原样发到 `eldercare/wearable/sos-001/up`；下行 ACK 从 `.../down` 回到 UART1。
设备无 RTC，**不伪造墙钟**，所有时间只用 `uptimeMs`。

> 与现有工程的关系：`competition/esp32-node/` 与 COM8 现役工程 `D:\esp32-sos-build\` 均为**只读参考**，
> 本工程是全新独立工程，未修改上述目录。按键消抖/告警状态机/NVS 恢复等思路参考现役固件，
> 但实现按本契约重写并抽成可主机单测的纯逻辑模块。

## 1. 目录

```
competition/esp32-node-wearable/
├── CMakeLists.txt                 # 根工程
├── sdkconfig.defaults             # esp32s3 / 16MB flash / 8192 主任务栈 / 无 BT
├── main/
│   ├── CMakeLists.txt
│   ├── Kconfig.projbuild          # 引脚/波特率/设备 ID/WEARABLE_QUERY_GPS_ON_SOS
│   ├── wearable_main.c            # 硬件 I/O + 主循环（GPIO/UART1/NVS）
│   ├── wearable_logic.h           # 纯逻辑 API（无 ESP-IDF 依赖）
│   └── wearable_logic.c           # 消抖/alarmId/事件/ACK/NVS 快照/JSON/UART 分帧/GPS/蜂鸣
├── test/
│   └── host_wearable_logic_test.c # 主机 gcc 单测（254 项断言）
├── WIRING.md                      # 唯一明确接线表（按钮/蜂鸣器/UART/M100 供电）
├── FLASH.md                       # 构建产物、SHA256、备份/烧录命令（不执行烧录）
└── README.md
```

## 2. 构建（真实 xtensa 构建已通过）

```powershell
Set-Location <WORKSPACE>\competition\esp32-node-wearable
. 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1'
idf.py build
```

产物：`build/esp32_wearable_sos.bin`（另有 bootloader / partition-table / 合并镜像），
SHA256 与大小见 `FLASH.md`。本工程**没有打开任何串口、没有烧录**。

## 3. 主机单测（不依赖 ESP-IDF）

```powershell
Set-Location <WORKSPACE>\competition\esp32-node-wearable
gcc -std=c11 -Wall -Wextra -O2 -I main test/host_wearable_logic_test.c main/wearable_logic.c `
    -o test/host_wearable_logic_test.exe
.\test\host_wearable_logic_test.exe    # RESULT: PASS（284 passed, 0 failed）
```

覆盖：20ms 采样 + 60ms 消抖（含抖动/上电按住不误触发）、alarmId 格式与重试不换 ID、
ACK 匹配/不匹配/cmd 不一致/重复 ACK/cmd 缺失、NVS 快照重启恢复与损坏拒绝、
JSON 转义与 `\uXXXX`、GPS 短包/flag=0/零坐标/越界降级为 `gps:null`、
M100 固定格式 GPS（`113.9737_22.69271`）不被当作 config/JSON/ACK、
UART 分包/粘包/超长 512 字节、**无换行时 100ms 空闲成帧（含 99ms 边界、分片、CR、超长）**、
蜂鸣 3 短声与 30s 后每 30s 单短提示、心跳/启动/回执帧内容与 512 上限。

## 4. 固件行为（对照契约）

| 契约要求 | 实现 |
|---|---|
| 按键 GPIO4 内部上拉、低电平按下、20ms 采样 + 60ms 消抖 | `wb_debounce_update()`：连续稳定 60ms 才翻转，只在按下沿报一次；上电按住不会误触发 |
| 按下立即蜂鸣（<100ms） | 主循环 20ms，`WB_BTN_EVENT_PRESS` 当次迭代先 `wb_buzzer_start` + `gpio_set_level(1)`，再做 NVS 持久化与 UART 发送 |
| 蜂鸣 GPIO5 高电平触发、3 短声循环收紧 | `wb_buzzer_level()`：3×120ms 短声，组间静默 800ms 起每组 −120ms（下限 280ms） |
| 30s 自动静音但事件仍未确认 | 30s 后停止 SOS 循环，事件保持 `ALARM`；每 30s 单 150ms 短提示直到 ACK |
| alarmId `sos-<n>-<hex>`，匹配 `^[A-Za-z0-9._:-]{1,80}$` | NVS 单调计数器 + `esp_fill_random` 4 字节，格式 `sos-<n>-<8hex>`；逻辑层再做正则校验 |
| 同一事件所有重试沿用同一 alarmId | 事件态保存 `alarm_id`，重试只改 `uptimeMs/seq`；未 ACK 前按键不生成新 ID |
| 事件 + alarmId 持久化 NVS，重启恢复并打日志 `恢复未确认事件` | 事件开始先写 NVS 再发；启动读取校验快照，未确认则打印 `恢复未确认事件 ...`、恢复蜂鸣并立即用原 ID 重发 |
| 未确认每 10s 重发；断链同样重试 | 主循环到期判断，无链路状态可感知 → 一直重试 |
| 心跳 30s 一条 `hb`（state/alarm），启动 `boot` | `wb_build_hb` / `wb_build_boot`；`csq` 仅在收到 `config,csq,ok,<0..31>` 后附带 |
| 下行 `ack` 的 alarm 必须等于当前事件；cmd 有则必须匹配 | 逻辑层匹配；不匹配只记日志、不改变状态；重复 ACK 识别为 `DUPLICATE` 并重发回执 |
| 匹配后停提示、置 IDLE、立即回 `t:"ack"` 回执 | 同一次处理内 `wb_buzzer_stop` + 清事件 + `wb_build_ack_frame` 发送 |
| ACK 后允许下一次按键产生新 alarmId（计数器递增） | 计数器只在事件开始时 +1；重启恢复不会重用 |
| 不启用 Wi-Fi | 代码不引用 esp_wifi/esp_netif，`sdkconfig.defaults` 关闭 BT；只保留组件 |
| UART1 TX=17 RX=18 115200 8N1 无流控；按行解析 ≤512 字节 | `uart_driver_install` + `wb_line_feed`（分包/粘包/CRLF/超长丢弃）；512 字节整行可接受 |
| M100 下行**不追加 `\n`**（原样字节）时也能处理 | `wb_line_idle_flush`：缓冲非空且连续 100ms 无新字节 → 当前缓冲当作一整行，复用 `wb_handle_line`；`\n` 立即成帧的既有行为不变，超长仍整行丢弃。真机已复现 ACK 无换行导致卡缓冲，此兜底修复 |
| 非 JSON 行/乱码/M100 回包/GPS 固定格式忽略 | 只处理 `config,` 前缀（本地解析、不回显）与 `{` 开头的 JSON；M100 主动上报的 GPS 固定格式 `经度_纬度`、命令回显、乱码一律记日志忽略，**不当作 ACK** |
| GPS：默认不查询，SOS 的 `gps` 固定 `null` | 真机确证 M100 自己把固定格式 GPS（WGS84 十进制 `经度_纬度`，如 `113.9737_22.69271`，无前缀/无时间字段）发到 MQTT 上行，由适配器解析成“求助时最近定位”；固件不发任何 `config,get/...` 命令，避免干扰透传 |
| 实验开关 `CONFIG_WEARABLE_QUERY_GPS_ON_SOS`（默认 n） | 仅台架实验可打开：按键后向 M100 发一次 `config,get,gpsext`（1500ms 超时），有效定位补发同 alarmId 的 SOS；所有 config 回包只本地解析、绝不回显。正式交付保持 n |

### 4.1 GPS 策略（默认关闭查询）

真机资料已确证：M100 主动上报的 GPS 报文是 **WGS84 十进制 `经度_纬度`**（例如
`113.9737_22.69271`，无前缀、无时间字段），由 M100 自己发布到 MQTT 上行主题，适配器解析后
作为“求助时最近定位”。因此正式固件：

- **不向 M100 发送任何 `config,get/...` 命令**，避免查询/配置回包与透传业务互相干扰；
- SOS 上行 JSON 的 `gps` **固定为 `null`**，不伪造、不缓存定位；
- 收到的非 JSON 行（M100 回包、GPS 固定格式、命令回显、乱码）只记日志：
  **不当作 ACK、不改变告警状态、绝不再回显上行**。

`sdkconfig.defaults` 中 `CONFIG_WEARABLE_QUERY_GPS_ON_SOS=n`。代码仍保留该编译开关与
`config,gps` 解析逻辑（主机单测覆盖）供台架实验；打开后按“先发 gps:null 的 SOS、再查询、
有效定位补发同 alarmId SOS”执行，求助永不被 GPS 拖慢。

### 4.2 关键默认值

| 项 | 值 |
|---|---|
| 设备 ID / 上行 `dev` | `esp32-sos`（`CONFIG_WEARABLE_DEV_ID`） |
| 固件版本 | `wearable-1.0.0`（`CONFIG_WEARABLE_FW_VERSION`） |
| 按键 / 蜂鸣器 | GPIO4 / GPIO5 |
| UART1 | TX=GPIO17，RX=GPIO18，115200 8N1，无流控 |
| SOS 重试 / 心跳 / 静音 | 10s / 30s / 30s |
| SOS `gps` | 固定 `null`（M100 主动上报由适配器处理） |
| GPS 实验开关 / 超时 | `n` / 1500ms（仅打开时使用） |
| Flash / 分区 | 16MB，DIO 80MHz，`SINGLE_APP_LARGE`（约 1.5MB app，无 OTA） |
| 主任务栈 | 8192（参考 COM8 现役固件已验证值） |

**PSRAM 说明**：N16R8 板载 8MB PSRAM，但本固件不使用 PSRAM，`sdkconfig.defaults` 未开启
`CONFIG_SPIRAM`，避免 PSRAM 模式与实板不符时初始化失败影响启动；16MB flash 已按板配置。

## 5. 剩余风险（需实机/联调验证）

1. M100 的 UART 电平是否为 3.3V TTL、以及透传下行 ACK 的完整性（分包/超长）需实机抓包确认；
   固件已按行缓冲 + 512 字节上限做防护，且只有 `{` 开头的 JSON `t:"ack"` 会改变告警状态。
2. M100 主动上报的 GPS 固定格式（`经度_纬度`）由 ECS 适配器解析；需确认适配器已按此格式
   出“求助时最近定位”，本固件不参与 GPS。
3. 蜂鸣器模块触发极性为“高电平触发”（与 COM8 现场实测一致）；若换模块需确认，否则会常响/不响。
4. 适配器对同一 alarmId 的 SOS 重复帧须按 alarm 去重（契约要求）；本固件重试复用同一 ID。
5. 实体按键、蜂鸣、4G 上云、APP 告警/地图/ACK、断电恢复、脱离电脑供电等**验收项尚未真机执行**
   （本任务明确不打开 COM 口、不烧录）；烧录与真机取证由 Lead 执行。

## 6. 安全边界

- 本工程交付过程**未打开任何 COM 口、未烧录**，未修改 `competition/esp32-node/` 或 `D:\esp32-sos-build\`。
- 烧录命令只写在 `FLASH.md` 中；烧录前必须先整片备份（`read_flash` 16MB），由 Lead 执行。
