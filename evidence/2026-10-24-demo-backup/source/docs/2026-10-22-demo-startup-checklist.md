# 演示前启动与三房间检查清单（2026-10-22）

## 当前冻结版本一键恢复入口

断电、DAYU 重启或 PC 重启后，优先使用当前冻结版本专用恢复器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  <WORKSPACE>\competition\materials\demo_recover.ps1
```

也可以双击：

```text
<WORKSPACE>\competition\materials\start-demo-current.cmd
```

该入口只恢复既有链路：核对 DAYU 原版 `/data/homemon/homemon` 哈希，缺失时启动原版，建立 `tcp:9001 -> tcp:9000`，并按单实例规则复用或启动 Broker `1883`、Bridge `9101`、public-sync。public-sync 会在可见终端提示用户隐藏输入 `INGEST_KEY`。

它不会推送或覆盖 homemon、不会写入 `homemon.conf`、不会安装或重建 HAP、不会启动模拟节点，也不操作 COM8/COM14/COM5。启动器的本次 PID 和 fport 记录在 `competition/bridge/_test/current-runtime/demo-recover.state.json`；仅停止本启动器拥有的本地进程：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  <WORKSPACE>\competition\materials\demo_recover.ps1 -Stop
```

“恢复完成”只代表进程、端口和 DAYU 通道结构检查通过；仍必须等待 `dayu200-living`、`esp32-kitchen`、`esp32-bath` 的自然新 202，不能把 retained 消息、旧 `status.json` 或旧日志当作在线证据。旧的 `demo_start.ps1` 是历史部署式脚本，不作为当前冻结版本入口。

用途：比赛现场从“上电/重连”到“三房间展示 + 真实 SOS/ACK”的可复现检查顺序。  
不包含密码、Token、INGEST_KEY 或任何密钥值；当前冻结版本的一键恢复入口见上节，必须先做结构检查再等待自然上报。

## 0. 先认清目标，禁止混用

```powershell
$hdc = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
& $hdc list targets -v
```

| 目标 | 识别 | 用途 |
|---|---|---|
| DAYU200 | USB Connected，`450100…ca00` | 主控 APP `com.dsh.eldercare`、homemon |
| 手机模拟器 | `127.0.0.1:5555` | 监护人 APP `com.example.program_04` |
| 厨房 ESP32 | 网络自然上报 `esp32-kitchen`，厨房；COM14 | 不打开串口，不重新烧录 |
| 卫生间 ESP32 | 网络自然上报 `esp32-bath`，卫生间；COM5 | 不打开串口，不重新烧录 |
| COM8 候选 ESP32-S3 | USB-Enhanced-SERIAL CH343；MAC `30:30:f9:08:76:84`；当前固件 `RGB Demo` | **不参与三节点/3-5 统计；不烧录、不绑定、不手工 MQTT** |

所有 HDC 命令显式写 `-t <目标>`；不要把 `127.0.0.1:5555` 当成 DAYU200。多目标环境中 `install`、`snapshot_display`、`file send/recv` 同样必须带 `-t`，不能依赖默认目标。HDC server 重启后必须重新执行 `fport ls`，确认 `tcp:9001 → tcp:9000` 仍存在；若丢失，按第 3 节重建。

## 1. 检查 PC IP 与节点网关

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object InterfaceAlias -eq 'WLAN'
```

当前验证值：`10.127.130.179`。  
两个 ESP32 的 Wi-Fi 网关配置必须为 `10.127.130.179:9101`；若 PC WLAN IP 改变，本轮不现场改固件，应记录“节点网关与 PC IP 不匹配”的断点，按已授权的独立配置/烧录流程处理。

不要打开 COM14/COM5，不读取/输出 Wi-Fi SSID 或密码。  
COM8 是待确认候选板（当前 `RGB Demo`，非 `elder-node`），**不参与三节点/3-5 统计、不烧录、不绑定、不手工 MQTT**；详见 [COM8 识别](2026-10-23-com8-identification.md)。

## 2. 检查 PC 服务与端口

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 1883,9001,9101 }
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'mqtt_broker\.js|mqtt_bridge\.js|public-sync\.js|run-public-sync\.js' }
```

期望：

- Broker：仅一个 1883；
- Bridge：仅一个 9101；
- public-sync：**一个逻辑实例**；launcher + child 父子进程正常，不是两套实例；
- 9001：由 hdc fport 转发持有，不是新的 Broker/Bridge。

**public-sync 启动前必须核对锁与实际进程一致：**

```powershell
Get-Content <public-sync.lock>          # 只用于核对 PID，不输出密钥
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'public-sync\.js|run-public-sync\.js' }
```

判定：

- 锁 PID 应对应一个 `run-public-sync.js` 父进程；
- 只能有一个 launcher + 一个 `public-sync.js` child；
- 若出现两套父子进程，先确认活动锁/日志，再停掉旧实例；parent-child 不是两个实例；
- 启动器退出但子进程仍在时，以实际进程和锁为准，不重复启动第三套。

当前已运行（仅作现场参考，重启后会变化）：

```text
Broker PID 6540 / 1883
Bridge PID 13508 / 9101
public-sync PID 32584 (launcher) + 30216 (sync)，锁 PID=32584
HDC fport: tcp:9001 -> tcp:9000
```

历史踩坑：曾同时存在旧 public-sync 31380/32136 和新 28172/33560 两套实例，导致同一 deviceTs 出现两条 202；旧实例已停止。不要只看可见窗口判断实例数。

当前手机唯一推荐包为 `guardian-inline-summary-formal.hap`（SHA-256 `8A722EB6…3A985`，模拟器目标 5555）；8F `8F8925BD…F769F` 是含已知缺陷的回退版本。安装前按完整哈希核对证据目录中的候选文件。

若 public-sync 缺失：使用项目既有可见启动方式（`start-public-sync-visible.cmd` 或 `npm run public-sync`），由用户在隐藏提示输入 INGEST_KEY；不要把密钥发到聊天、命令行或文件。

## 3. 检查 DAYU 时钟、homemon、9000、Forward

```powershell
$d = '450100445634303332012847942eca00'
& $hdc -t $d shell "date; cat /proc/uptime; ps -ef | grep '[h]omemon'; netstat -lntp 2>/dev/null | grep ':9000'"
& $hdc fport ls
```

期望：

- 板端时间为 2026 年当前时间，不是 2017；
- 仅一个 `homemon homemon.conf`；
- 板端 `0.0.0.0:9000 LISTEN`；
- `PC tcp:9001 -> DAYU tcp:9000 [Forward]`。

若 DAYU 重启后 homemon 缺失：只启动板端现有程序（不改二进制/配置）：

```powershell
& $hdc -t $d shell "cd /data/homemon && (./homemon homemon.conf > homemon.stdout 2>&1 &)"
```

若 fport 丢失：重建 `9001→9000`，然后等待 Bridge 自动重连；不要重启已经正常运行的 Bridge。  
已知环境限制：HDC 服务重启/执行会话结束可能丢 fport，本项目未新增自动守护机制，必须人工复查。

### 3.1 DAYU 重启后的恢复（2026-10-23 实际验证）

已确认的断点链是：

```text
DAYU 重启
→ 原版 homemon 未运行
→ 9000 未监听
→ HDC fport 缺失
→ Bridge 无法连 PC 9001
→ living 停止上报
```

只读检查：

```powershell
$hdc = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$d = '450100445634303332012847942eca00'

& $hdc -t $d shell "date; cat /proc/uptime; ps -ef | grep '[h]omemon'; netstat -lntp 2>/dev/null | grep ':9000'"
& $hdc -t $d shell "ls -l /data/homemon/homemon; sha256sum /data/homemon/homemon"
& $hdc fport ls
```

原版 homemon 身份应保持：

```text
/data/homemon/homemon
164,276 B
SHA-256 0D243539403DE89C547DEFACF43C86A4980142EF8EC686B277BE7133C42881E6
```

仅当 homemon 确实未运行，才启动板端原有程序/配置；运行正常时不要重复启动：

```powershell
& $hdc -t $d shell "cd /data/homemon && (./homemon homemon.conf > homemon.stdout 2>&1 &)"
& $hdc -t $d shell "sleep 2; ps -ef | grep '[h]omemon'; netstat -lntp 2>/dev/null | grep ':9000'"
```

恢复既有 forward（不要重启正常的 Bridge）：

```powershell
& $hdc -t $d fport tcp:9001 tcp:9000
& $hdc fport ls
```

然后：

1. 确认 Bridge 日志出现接入 `127.0.0.1:9001`；
2. 等待 **新的** `home/dayu200-living/status` 和 public-sync 新 202，不能把 retained 旧状态当恢复；
3. 再核对 kitchen/bath 同期 202；
4. 区分 DAYU `3/3`（三个已接入目标）与手机 `3/5`（账号下 5 台设备，含 2 台历史离线）的统计口径。

不新增开机自启、计划任务、看门狗或循环重启脚本。  
DAYU 此次为何重启：**未确定**；本清单只记录“homemon + fport 缺失”的恢复动作，不把重启成功当作重启根因已查清。

## 4. 验证三个节点的自然新上报

只做只读观察，不手工发 SOS/FALL/ACK/reset：

```powershell
# Bridge 日志应连续出现三行主题
Get-Content <WORKSPACE>\competition\evidence\2026-10-22-live-chain-restore\bridge.out.log -Tail 30

# public-sync 应出现三个 deviceId 的新 202
Get-Content <WORKSPACE>\competition\evidence\2026-10-15-public-sync-dual-device\public-sync.out.log -Tail 30
```

期望按 `deviceId` 分别看到：

```text
dayu200-living  → 客厅
esp32-kitchen   → 厨房
esp32-bath      → 卫生间
```

至少等待两个自然上报周期；不要把 retained 旧消息、旧 `status.json` 或历史截图单独当在线证据。  
若缺少某台：依次检查该节点网络/Bridge 入站、public-sync 202、后台、APP，不要直接重启全部服务。

**统计口径说明：**

- DAYU 的 `全屋在线 3/3 台设备` 指三个已接入目标节点（客厅、厨房、卫生间）；
- 手机首页/监测页的 `3/5` 指账号下 5 台设备中 3 台在线，另外 2 台是保留的历史离线设备；
- 两个数字不矛盾；不能把手机删除旧设备或伪造第 4/5 台在线来“对齐 3/3”。

## 5. 打开两个客户端

### DAYU200 主控 APP

- 打开 `com.dsh.eldercare`；
- 确认底部/顶部房间入口：厨房、客厅、卫生间；
- 逐一切换，核对标题、`deviceId`、温度和湿度；
- 厨房/卫生间应显示“未配置摄像头”；客厅若已有摄像头，切换出去再回来应恢复；
- 厨房/卫生间能力字段的已知 UI 缺口见本轮证据，不在演示前临时改代码。

### 手机监护人 APP

- 真实账号登录（会话过期时用户自己输入已保存密码；不要发到聊天）；
- 确认“我的家”、4 个房间/5 台设备，以及监测页三个已接入节点；
- 厨房显示 MQ ADC 且明确“报警未启用”；卫生间显示温湿度和 PIR 活动；
- 厨房/卫生间温湿度显示“读数有效”时，表示本次 `valid=true`；客厅旧合同缺少 valid，继续“待确认/未知”，不能猜成有效；
- 不以首页概览 `--` 代替监测页在线数；首页与监测页最终都应为 `3/5`。

## 6. 演示前一天/现场保留状态

- 保留 Broker、Bridge、public-sync、DAYU homemon 和模拟器；
- 不启动第二套 Broker/Bridge/public-sync；
- 不关闭 public-sync 的可见终端，除非准备重新隐藏输入密钥；
- 不把临时 observer、测试脚本或 MQTT 订阅进程留在后台。

安全退出临时只读观察者：

```powershell
# 只结束自己启动的临时 observer 进程；不要结束 Broker/Bridge/public-sync
Stop-Process -Id <observer_pid> -Force
```

保留正常服务，不清理 1883/9101/9001。

## 7. 常见断点定位顺序

| 现象 | 先检查 |
|---|---|
| PC APP 完全没有数据 | 1883/9101 是否监听；Broker/Bridge 是否单实例 |
| Bridge 有状态但公网无 202 | public-sync 是否运行、ingest 是否已设置、public-sync 日志 |
| 某节点不出现 | 该 ESP32 是否连到 PC 9101；Bridge 是否出现该 `deviceId` |
| 只有客厅正常 | fport `9001→9000`、DAYU homemon、Bridge relay 连接 |
| APP 在线数与 202 不一致 | 依次检查后台 device 记录、APP 刷新时间、最后更新/在线窗口 |
| 房间读数串线 | 对照 Bridge 主题里的 `deviceId` 与 room，不要只信旧标题 |
| fport 突然消失 | HDC 服务是否重启；重建 `9001→9000` 后等 Bridge 自动重连 |

## 8. 明确不宣称

- 不宣称“重启后自动恢复”：本项目没有开机自启/计划任务；
- 不宣称“QoS0 必然可靠”或“202=设备确认”：202 只是受理，ACKED 必须由同一 `deviceId+alarmId` 的设备回执证明；
- 不宣称厨房 MQ 已标定/报警已启用；当前阈值禁用；
- 不宣称 PIR/蜂鸣器/水漏已通过，除非有对应实体测试记录；
- 不把 5 台设备总数强求成 3 台；按 `deviceId` 逐台判断，历史设备保留。
