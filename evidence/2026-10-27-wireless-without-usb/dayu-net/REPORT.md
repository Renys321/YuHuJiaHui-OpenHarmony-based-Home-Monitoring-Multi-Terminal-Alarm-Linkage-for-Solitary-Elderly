# DAYU200 接入 ElderCareLab Wi-Fi 与 PC↔DAYU 可达性验收

- 任务：把 DAYU200 接入现有 Wi-Fi（SSID `ElderCareLab`，WPA2，2.4GHz），取得 `10.127.130.x` IPv4，并验证 PC（10.127.130.179）与 DAYU 之间的 TCP 可达性
- 执行人：`dayu-net`（DSH teammate）
- 采集时间窗：2026-10-27 22:20–22:35（+08:00）；22:35 起按 Lead 指令冻结对 DAYU 的主动操作，证据以冻结前采集为准
- 设备：DAYU200，hdc target `450100445634303332012847942eca00`，OpenHarmony 7.0.0.38 / API 26，`hdc shell` 为 root
- **本报告及同目录所有证据文件均不包含 Wi-Fi 密码**（已对全目录做正则扫描：密码明文、PSK 密钥值、`device_config.conf` 密文字段，均 0 命中；该文件取证时已删除 `encryptedData`/`IV` 行）

## 0. 结论摘要

| 验收项 | 结果 | 关键证据 |
|---|---|---|
| DAYU 连上 `ElderCareLab` | **通过**（在我核验前已由系统 wifi_manager 建立，我未改任何配置） | `02-dayu-wpa-status.txt`：ssid=ElderCareLab / wpa_state=COMPLETED |
| 取得 IPv4 | **通过**：`10.127.130.131/24`（前缀 24），**DHCP** | `24-dayu-wifi-device-config-dhcp-redacted.txt`：assignMethod=0 + LastDhcpResults |
| PC→DAYU 可达 | **通过**：ICMP 4/4，TCP 9000 成功 | `14-pc-ping-dayu.txt`、`15-pc-testnetconnection-9000.txt` |
| DAYU→PC 可达 | **TCP 通过**；ICMP 被 PC 防火墙拦截（非 Wi-Fi 问题） | `06-dayu-tcp-pc-9101.txt`、`21-pc-sockets-to-dayu.txt`、`17-pc-firewall-profile.txt` |
| 相机/推理未受影响 | **通过**：预览在跑、推理持续 200、UI 正常 | `10-dayu-hilog-camera.txt`、`11-dayu-hilog-inference-9200.txt`、`screenshots/dayu-app-after-wifi.jpeg` |
| 改造前 HDC 基线 | **已取证**（历史日志+fport），当前已被 Lead 迁移为 Wi-Fi | `19-hdc-fport-ls.txt`、`23-bridge-old-hdc-baseline-9001.txt`、`20-pc-bridge-current-cmdline.txt` |

一句话：**DAYU 已通过 DHCP 获得 `10.127.130.131/24`，PC↔DAYU 的 TCP 数据链双向可用；唯一“失败”是 DAYU→PC 的 ICMP 被 Windows 防火墙 Public 配置丢弃，不影响 TCP。**

## 1. Wi-Fi 连接与 IP 获取

### 1.1 连接状态（只读核验）

`hdc shell "/vendor/bin/wpa_cli -p /data/service/el1/public/wifi/sockets/wpa -i wlan0 status"`：

```
bssid=5a:fe:a0:a6:a3:d7
freq=2462                 # 2.4GHz，信道 11
ssid=ElderCareLab
id=0
mode=station
pairwise_cipher=CCMP      # WPA2
group_cipher=CCMP
key_mgmt=WPA2-PSK
wpa_state=COMPLETED
ip_address=10.127.130.131
address=54:78:c9:96:a6:b2 # wlan0 工厂 MAC
```

扫描确认该 BSSID 就是目标 AP：`5a:fe:a0:a6:a3:d7 2462 -41 [WPA2-PSK-CCMP][ESS] ElderCareLab`。

### 1.2 IP 与获取方式：DHCP

`ifconfig wlan0`：

```
wlan0  Link encap:Ethernet  HWaddr 54:78:c9:96:a6:b2  Driver bcmsdh_sdmmc
       inet addr:10.127.130.131  Bcast:10.127.130.255  Mask:255.255.255.0
       UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1
```

系统持久化配置 `/data/service/el1/public/wifi/device_config.conf` 中 `WifiDeviceConfig_2` 明确记录（已脱敏，见证据 24）：

| 字段 | 值 | 解读 |
|---|---|---|
| ssid | `ElderCareLab` | 目标 SSID |
| bssid | `5a:fe:a0:a6:a3:d7` | 与扫描结果一致 |
| frequency | 2462 | 2.4GHz ch11 |
| keyMgmt / keyMgmtBitset | WPA-PSK / 12 | WPA2 |
| everConnected | 1 | 系统层已成功连接过 |
| `wifiIpConfig.assignMethod` | **0** | **0 = DHCP**（静态配置字段全为空） |
| `LastDhcpResults.ipAddress` | 176128643 | **10.127.130.131** |
| `LastDhcpResults.gateway` | 176128729 | **10.127.130.217** |
| `LastDhcpResults.netmask` | 4294967040 | **255.255.255.0**（/24） |
| `LastDhcpResults.serverIp` | 10.127.130.217 | DHCP 服务器=AP |
| `LastDhcpResults.leaseDuration` | 3599 | 租期 3599 秒 |
| `lastConnectTime` | 1793110465 | **2026-10-27 22:14:25 +08:00** |
| `lastHasInternetTime` | 1793110522 | 2026-10-27 22:15:22 +08:00 |

**获取方式：DHCP（系统 wifi_manager 负责）。IP=10.127.130.131，前缀 24，网关 10.127.130.217，租期 3599s，取得时间 22:14:25。**

> 时间线说明：连接与 DHCP 在我开始核验（22:20）之前已由设备系统完成（`device_config.conf` mtime 22:15）。我**没有**执行 UI 点击、没有改 `wpa_supplicant.conf`、没有 `set_network`/`reconfigure`、没有静态 `ifconfig`；全部为只读核验。原因是 Lead 已并行把 bridge 迁到 Wi-Fi，链路正在运行，任何重连动作都会打断 demo。

### 1.3 稳定性与流量

- 22:21–22:33 多次核验，`wpa_state` 始终 `COMPLETED`，IP 始终 `10.127.130.131`，未掉线。
- wlan0 计数器增长（22:22 → 22:33）：RX 66,114 → **210,757** 字节，TX 48,539 → **416,931** 字节，TX/RX 包 341/335 → 1,771/1,721，**无 errors/dropped** → Wi-Fi 承载了 bridge 的实时轮询流量。
- 邻居表确认身份：DAYU `/proc/net/arp` 中 `10.127.130.179 → ec:91:61:6f:69:fd`；PC `arp -a` 中 `10.127.130.131 → 54-78-c9-96-a6-b2`（DAYU wlan0 MAC）。
- DAYU 经 Wi-Fi 可访问互联网：`openssl s_client -connect 223.5.5.5:443` 3/3 次 `CONNECTION ESTABLISHED`（TLSv1.3，`*.alidns.com`），见 `28-dayu-internet-tcp-ok.txt`。

## 2. PC↔DAYU 双向可达性

PC：`10.127.130.179/24`，WLAN 接口，网关 `10.127.130.217`（即 ElderCareLab AP），PC 可上网。

### 2.1 PC → DAYU：**通过**

| 测试 | 命令 | 结果 |
|---|---|---|
| ICMP | `ping -n 4 10.127.130.131` | **4/4 收到，0% 丢失**，RTT min 75 / max 241 / avg 190 ms，TTL=64 |
| TCP 9000 | `Test-NetConnection 10.127.130.131 -Port 9000` | **TcpTestSucceeded = True**（homemon 监听 0.0.0.0:9000） |
| TCP 9301 | 同上 9301 | False（**预期**：9301 只绑定 127.0.0.1，不走 Wi-Fi） |

### 2.2 DAYU → PC：TCP **通过**，ICMP 被 PC 防火墙拦截

| 测试 | 命令（DAYU 上） | 结果 |
|---|---|---|
| ICMP | `ping -c 4 10.127.130.179` | **100% packet loss（0/4）** — 精确原因见下 |
| TCP 9101 | `openssl s_client -connect 10.127.130.179:9101` | **`CONNECTED(00000003)`**（bridge 监听 9101） |
| TCP 1883 | `openssl s_client -connect 10.127.130.179:1883` | **`CONNECTED(00000003)`**（MQTT broker；TLS 字节被 broker 重置属预期） |

PC 侧同步观测（DAYU 主动连接 9101 的瞬间）：

```
LocalAddress   LocalPort RemoteAddress  RemotePort State       OwningProcess
10.127.130.179 9101      10.127.130.131 36574      Established 61072
```

→ **DAYU→PC 的 TCP 双向确认**（DAYU 发起、PC 侧看到来自 `10.127.130.131` 的 ESTABLISHED 连接）。

**DAYU→PC ICMP 失败根因（已定位，非 Wi-Fi 路由问题）**：

- PC WLAN 网络类别 = **Public**（`18-pc-network-category.txt`）；Windows 防火墙三档均启用（`17-pc-firewall-profile.txt`）。
- 入站 ICMPv4 回显规则 `文件和打印机共享(回显请求 - ICMPv4-In)` **只在 Private 档启用**，Public 档对应规则为 `False`（规则清单见本报告附录 B）。
- 因此 PC 丢弃来自 DAYU 的 echo request；而 PC→DAYU 方向不受影响（DAYU 无防火墙）。
- 交叉验证：DAYU→PC 的 TCP 能通、PC→DAYU 的 ICMP/TCP 都能通 → 排除 AP 隔离、IP/掩码/ARP 问题。
- 我无管理员权限（`IsAdmin=False`），**未改动防火墙**。如需双向 ping 作为验收硬指标，需管理员执行（Lead 决定）：
  - `Set-NetFirewallRule -DisplayName '文件和打印机共享(回显请求 - ICMPv4-In)' -Profile Any -Enabled True`，或
  - `netsh advfirewall firewall add rule name="DAYU-ICMPv4-In" dir=in action=allow protocol=icmpv4:8,any remoteip=10.127.130.131`
  - 或把 WLAN 网络类别改为 Private（`Set-NetConnectionProfile -InterfaceAlias WLAN -NetworkCategory Private`）。

## 3. 相机与推理未受影响

| 项目 | 证据 |
|---|---|
| APP 存活 | `com.dsh.eldercare` PID 8411；`homemon` PID 2327（0.0.0.0:9000）；`dayu_local_fall` PID 2379（127.0.0.1:9200，yolo11n-pose-ncnn-320-static-p1b，threads=4，duration=86400s）→ `08-dayu-ps.txt` |
| 相机预览 | hilog `A03d00/JSAPP: [CameraModel] 预览已启动 640x480` **最后一次 22:14:12**（Wi-Fi 连接后），之后无 `资源已释放` → `10-dayu-hilog-camera.txt` |
| 相机出帧 | `camera_hdi_service` 于 22:33:47 仍在 `Capture()/V4L2QueueBuffer/ProvideBuffers` → `26-dayu-camera-hdi-frames.txt` |
| 推理在跑 | APP 持续 `POST` 到 `127.0.0.1:9200`，每次 `RespCode:200`，约 0.5s 一次（22:30:49–22:30:53 连续 10 条）→ `11-dayu-hilog-inference-9200.txt` |
| 事件流在写 | `evidence/demo-events.jsonl` = 180,511,661 字节，mtime 22:30 → `09-dayu-app-inference-state.txt` |
| UI 正常 | `snapshot_display` 截图 720×1280（22:30，69,897 字节）：标题“居家安全监护”、在线 3/3 台设备、温度 24.6℃ / 湿度 53.6%、门窗/燃气/烟雾实时值、预警记录、状态栏有 **Wi-Fi 图标** → `screenshots/dayu-app-after-wifi.jpeg` |

## 4. “仍走 HDC”改造前基线 与 当前迁移状态

### 4.1 改造前基线（HDC fport）：已取证

- `hdc fport ls`：
  ```
  450100445634303332012847942eca00  tcp:9001 tcp:9000  [Forward]
  450100445634303332012847942eca00  tcp:9301 tcp:9301  [Forward]
  ```
- 旧 bridge 日志 `bridge/_test/current-runtime/supervisor/bridge.out.log`（最后写入 22:25:08）：
  ```
  [bridge] 节点 127.0.0.1:9001 30000 毫秒后重连（连续失败 376 次）
  [bridge] 已连接转发目标 127.0.0.1:9001
  [bridge] 已接入节点 127.0.0.1:9001
  ```
  → 改造前 `home/dayu200-living/status` 来自 **`127.0.0.1:9001` 的 hdc fport**（PC 本地 → hdc → DAYU 9000），即“仍走 HDC”基线成立。

### 4.2 当前状态：Lead 已在 22:25:23 切到 Wi-Fi（我核验时已生效）

- PC 进程：PID 61072，启动 **22:25:23**
  ```
  node mqtt_bridge.js --broker 127.0.0.1:1883 \
    --status-tcp 10.127.130.131:9000 --listen 9101 \
    --relay-to 10.127.130.131:9000 ...
  ```
- 实时 socket（PC 主动连 DAYU Wi-Fi）：
  ```
  10.127.130.179:55331 → 10.127.130.131:9000  Established  PID 61072
  10.127.130.179:55332 → 10.127.130.131:9000  Established  PID 61072
  ```
- `status.json` 在 22:32:39 仍刷新（`ts=1793111559079`），supervisor 侧 `[cloud-sync] OK device=dayu200-living deviceTs=1793111559079 ... status=202`，与 status.json 时间戳逐条对齐 → **DAYU 状态现在经 Wi-Fi 采集并已同步到云**（`22-bridge-status-json.txt`、`27-pc-cloud-sync-dayu-over-wifi.txt`）。
- 期间 22:34:27 出现一次 `[cloud-sync] FAIL code=SYNC_TIMEOUT device=dayu200-living`，22:34:49 后恢复 `OK`（另有 esp32-bath 偶发 FAIL）→ 属云链路瞬时抖动，与 DAYU Wi-Fi 数据链无关。

## 5. 失败项、错误码与下一步

| 现象 | 精确错误/证据 | 判定 | 下一步 |
|---|---|---|---|
| `ping -c 4 10.127.130.179`（DAYU→PC） | 0 received，**100% packet loss** | PC 防火墙 Public 档禁用入站 ICMPv4 echo | 需管理员加规则（见 2.2），或验收改用 TCP |
| `ping 10.127.130.217` / `223.5.5.5`（DAYU） | 100% loss，但同目标 **TCP 可通**（TLS 3/3 成功；AP:80 返回 `errno=111` 连接被拒=可达） | AP/上游对部分 ICMP 不应答，非路由故障 | 无需处理 |
| 1883 探测 | `CONNECTED(00000003)` 后 `write:errno=104`（首次）/`unexpected eof` | MQTT broker 收到 TLS ClientHello 后重置，属预期 | 用 9101 复测即可 |

## 6. 剩余风险（请 Lead 决策）

1. **DHCP 租期风险**：`10.127.130.131` 为 DHCP 租约（3599s，自 22:14:25 起算，约 23:14:25 到期）。bridge 当前硬编码该 IP；若租约未续或 AP 重新分配，bridge 将断。建议在 AP 侧做 MAC 静态绑定（MAC `54:78:c9:96:a6:b2`），或到期前复查 `wpa_cli status`/`ifconfig` 的 IP 是否变化；变化时只需重启 bridge 指向新 IP。
2. **DAYU→PC ICMP 被防火墙拦截**：若验收要求“双向 ping 成功”，必须管理员改防火墙（上文命令）；TCP 层面已双向验证通过。
3. **`wpa_supplicant.conf` 是陈旧文件、不可作为判据**：`/data/service/el1/public/wifi/wpa_supplicant/wpa_supplicant.conf`（mtime 22:12）只含一个无关的开放网络 `nyist-stu`，与运行时实际连接不一致；权威状态在 `wifi_cli status` 与 `device_config.conf`。切勿据此判断“未连上 ElderCareLab”。
4. **拔 USB 后 HDC 路径消失**：本报告所有证据均在 USB 仍连接时采集；拔线后 `hdc`/fport 9001 回滚通道不可用，但 Wi-Fi 数据链（bridge↔10.127.130.131:9000）已独立验证可用。若需回滚到 HDC，须插回 USB 并重建 fport。
5. **屏幕一直保持 APP 前台**：拔线窗口请勿清后台/重启 APP，否则相机预览与推理需重新拉起。
6. **冻结状态**：22:35 起我未再对 DAYU 执行任何操作；如拔线后需要复核，需 Lead 明确解除冻结。

## 7. 证据清单（同目录）

```
dayu-net/
├─ REPORT.md                                  # 本文件
├─ logs/
│  ├─ 01-dayu-ifconfig-wlan0.txt              # inet 10.127.130.131/24 + 计数器
│  ├─ 02-dayu-wpa-status.txt                  # ssid/wpa_state/ip/key_mgmt
│  ├─ 03-dayu-wpa-networks-scan.txt           # list_networks + scan_results(含 ElderCareLab)
│  ├─ 04-dayu-route-arp-wireless.txt          # 路由/ARP/无线状态
│  ├─ 05-dayu-ping-pc-10.127.130.179.txt      # DAYU→PC ICMP 100% loss
│  ├─ 06-dayu-tcp-pc-9101.txt                 # DAYU→PC TCP CONNECTED(00000003)
│  ├─ 07-dayu-tcp-pc-1883.txt                 # DAYU→PC MQTT 端口 TCP CONNECTED
│  ├─ 08-dayu-ps.txt                          # eldercare/homemon/dayu_local_fall 进程
│  ├─ 09-dayu-app-inference-state.txt         # demo-server.log + events 文件大小
│  ├─ 10-dayu-hilog-camera.txt                # [CameraModel] 预览已启动
│  ├─ 11-dayu-hilog-inference-9200.txt        # 持续 POST 9200 RespCode 200
│  ├─ 12-dayu-netstat-listen.txt              # 端口监听
│  ├─ 13-pc-ipconfig-wlan.txt                 # PC 10.127.130.179/24 网关 .217
│  ├─ 14-pc-ping-dayu.txt                     # PC→DAYU 4/4
│  ├─ 15-pc-testnetconnection-9000.txt        # TcpTestSucceeded True
│  ├─ 16-pc-arp-dayu.txt                      # .131→54-78-c9-96-a6-b2
│  ├─ 17-pc-firewall-profile.txt              # 三档防火墙启用
│  ├─ 18-pc-network-category.txt              # WLAN=Public（ICMP 被拦根因）
│  ├─ 19-hdc-fport-ls.txt                     # tcp:9001 tcp:9000 [Forward]（HDC 基线）
│  ├─ 20-pc-bridge-current-cmdline.txt        # bridge 已指向 10.127.130.131:9000
│  ├─ 21-pc-sockets-to-dayu.txt               # PC↔DAYU ESTABLISHED 双向 socket
│  ├─ 22-bridge-status-json.txt               # status.json 实时刷新
│  ├─ 23-bridge-old-hdc-baseline-9001.txt     # 旧 bridge 经 127.0.0.1:9001
│  ├─ 24-dayu-wifi-device-config-dhcp-redacted.txt # DHCP 结果（已脱敏）
│  ├─ 25-dayu-final-state.txt                 # 冻结前最终状态
│  ├─ 26-dayu-camera-hdi-frames.txt           # camera_hdi 出帧
│  ├─ 27-pc-cloud-sync-dayu-over-wifi.txt     # 云同步 deviceTs 对齐
│  ├─ 28-dayu-internet-tcp-ok.txt             # DAYU 经 Wi-Fi 上外网 + ICMP 异常说明
│  └─ 29-pc-firewall-inbound-icmpv4-rules.txt # 入站 ICMPv4 回显规则原始清单（ICMP 被拦根因）
├─ screenshots/
│  └─ dayu-app-after-wifi.jpeg                # 720×1280 APP 正常截图
├─ raw/
│  ├─ wifi_history_record.db / wifi_pro.db    # 设备 Wi-Fi 数据库副本（不含明文密码）
│  └─ decode_wifi_db.py                       # 时间戳/uint32 IP 解码脚本
└─ tools/
   └─ capture-evidence.ps1                    # 证据采集脚本（可复跑）
```

## 附录 A：使用的关键命令

```powershell
$hdc='D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$T='450100445634303332012847942eca00'
& $hdc -t $T shell "ifconfig wlan0"
& $hdc -t $T shell "/vendor/bin/wpa_cli -p /data/service/el1/public/wifi/sockets/wpa -i wlan0 status"
& $hdc -t $T shell "cat /data/service/el1/public/wifi/device_config.conf"
& $hdc -t $T shell "cat /proc/net/arp"
& $hdc -t $T shell "ping -c 4 10.127.130.179"
& $hdc -t $T shell "toybox timeout 10 /system/bin/openssl s_client -connect 10.127.130.179:9101 2>&1 < /dev/null"
& $hdc -t $T shell "snapshot_display -f /data/local/tmp/dayu-net-shot.jpeg"
& $hdc -t $T fport ls
ping -n 4 10.127.130.131
Test-NetConnection 10.127.130.131 -Port 9000 -InformationLevel Detailed
Get-NetTCPConnection | Where-Object { $_.RemoteAddress -eq '10.127.130.131' }
```

## 附录 B：PC 防火墙中与 ICMP 回显相关的入站规则

原始输出：`logs/29-pc-firewall-inbound-icmpv4-rules.txt`（2026-10-27 22:36:34 采集）

```
核心网络 - 需要目标不可访问的碎片(ICMPv4-In)                     Enabled=True   Profile=Any
核心网络诊断 - ICMP 回显请求(ICMPv4-In)                          Enabled=False  Profile=Domain
核心网络诊断 - ICMP 回显请求(ICMPv4-In)                          Enabled=False  Profile=Private, Public
文件和打印机共享 (限制性) (回显请求 - ICMPv4-In)                  Enabled=False  Profile=Domain, Public
文件和打印机共享 (限制性) (回显请求 - ICMPv4-In)                  Enabled=True   Profile=Private
文件和打印机共享(回显请求 - ICMPv4-In)                            Enabled=True   Profile=Private   <- 仅 Private 生效
文件和打印机共享(回显请求 - ICMPv4-In)                            Enabled=False  Profile=Public    <- Public 档关闭
文件和打印机共享(回显请求 - ICMPv4-In)                            Enabled=False  Profile=Domain
虚拟机监控(回显请求- ICMPv4-In)                                   Enabled=False  Profile=Any
```

（PC WLAN 网络类别为 Public，故所有仅 Private 启用的 echo 规则不生效；`核心网络诊断 - ICMP 回显请求` 在 Private, Public 档也是 `Enabled=False`。）
