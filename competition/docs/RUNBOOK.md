# 构建、启动与诊断手册

## 1. 固定路径

```powershell
$root = '<WORKSPACE>\competition'
$hdc = '<WORKSPACE>\tools\hdc\hdc.exe'
$node = '<USER_HOME>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
```

本机默认 HDC server 曾因无法创建 `%TEMP%\.hdc.cache.log` 返回 `operation not permitted`。若再次出现，先为本轮创建独立运行目录，再在同一 PowerShell 会话设置：

```powershell
$hdcRuntime = "$root\evidence\<本轮证据目录>\hdc-runtime"
New-Item -ItemType Directory -Force -Path $hdcRuntime | Out-Null
$env:TEMP = $hdcRuntime
$env:TMP = $hdcRuntime
```

不要删除其他轮次的 HDC 运行目录，也不要用泛杀方式停止 HDC server。

## 2. 设备预检

```powershell
& $hdc list targets
& $hdc shell 'param get const.ohos.apiversion'
& $hdc shell 'param get const.product.software.version'
& $hdc shell 'uname -m'
& $hdc shell 'getconf LONG_BIT'
```

预期历史基线：API 26、OpenHarmony 7.0.0.38、`aarch64`、`LONG_BIT=32`。若 `LONG_BIT` 不是 32，不要照搬当前 ARM32 部署判断。

## 3. 构建南向程序

当前真机默认构建 ARM32：

```powershell
powershell -ExecutionPolicy Bypass -File "$root\southbound\build.ps1"
```

额外构建 ARM64：

```powershell
powershell -ExecutionPolicy Bypass -File "$root\southbound\build.ps1" -Arch arm64
```

构建后必须重新计算哈希，不要继续引用 `ARTIFACTS.md` 中旧哈希。

## 4. 构建北向 unsigned HAP

```powershell
Set-Location "$root\northbound"
$env:DEVECO_SDK_HOME = 'D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME = 'D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME = '<WORKSPACE>\.buildcache\hvigor'
$env:OHPM_HOME = '<WORKSPACE>\.buildcache\ohpm'
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' `
  assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

输出路径：

```text
northbound/entry/build/default/outputs/default/entry-default-unsigned.hap
```

当前已验证的 signed HAP 位于：

```text
northbound/signing/eldercare-signed.hap
```

重新生成签名 profile 前，必须先向当前设备核对 provision UDID。不要运行仍指向旧工程的 `northbound/signing/prepare_profile.py`。

## 5. 一键启动环境（2026-10-29 更新）

> 旧入口 `demo_start.ps1`、`demo_recover.ps1`、`start-demo-current.cmd`、旧预检
> `device-preflight.ps1` / `demo-preflight.js` 以及全部 `.bak` 文件已于 2026-10-29 删除，
> **当前只保留下面的入口，不要再找旧脚本。**

完整演示入口（推荐，P0 + 板端页面 + 视觉跌倒 + 视频 relay + 随身 mirror，一次补齐）：

```powershell
<WORKSPACE>\competition\materials\start-demo-full.cmd
```

只起 P0（分步排查或只需云同步）：

```powershell
<WORKSPACE>\competition\materials\start-demo-supervisor.cmd
```

只读预检（不启动、不修改）：

```powershell
powershell -ExecutionPolicy Bypass -File "$root\materials\start-demo-supervisor.ps1" -Preflight
```

随身 SOS 注入（可选；默认 dry-run，`-Apply` 才启动）：

```powershell
powershell -ExecutionPolicy Bypass -File "$root\materials\start-mirror-dayu.ps1" -Apply
```

常驻守护（可选；会拉起板端 ncnn 推理，注意与 PC 视觉抢 9200）：

```powershell
<WORKSPACE>\competition\materials\start-demo-all.cmd
```

`start-demo-supervisor` 实际执行：

1. 只读预检并解析 DAYU 端点（USB `hdc fport` 优先，LAN 回退）；
2. 校验/启动板端 `homemon`（哈希必须匹配冻结版）；
3. 建立并验证 `hdc fport tcp:9001 -> tcp:9000`；
4. 启动 Broker `1883` 与 Bridge `9101`；
5. 由 supervisor 托管唯一 `public-sync` worker（输入一次 `INGEST_KEY`）。

第三轮冻结脚本（SHA-256 `304176...`）已在 2026-10-10 真机完整通过，证据为 `evidence/2026-10-10-third-device-validation/08-third-demo-start-retry.txt`，文件以 `EXIT_CODE=0` 收尾。首次运行虽然设备安装成功，但脚本把 HAP 安装的多行输出误判为失败；原始记录保留在 `07-third-demo-start.txt`。当前参数化脚本只完成了 Parser 检查，不能直接继承该轮整脚本 PASS。

每次新运行仍必须保存完整 stdout/stderr，不能只记录最后一行；脚本输出“环境就绪”也不等同于全部业务验收通过。

## 6. 手工启动 Bridge 链路

分别在独立终端中执行：

```powershell
Set-Location "$root\bridge"
& $node .\mqtt_broker.js 1883
```

```powershell
Set-Location "$root\bridge"
& $node .\mqtt_bridge.js --broker 127.0.0.1:1883 `
  --listen 9100 --relay-to 127.0.0.1:9000 `
  --cmd-out .\_test\control --status-file .\_test\status.json
```

```powershell
Set-Location "$root\bridge"
& $node .\sim_node.js --gw 127.0.0.1:9100 --id esp32-bath --room 卫生间
```

注意：`hdc fport tcp:9000 tcp:9000` 与依赖它的进程需要处于同一执行生命周期。优先使用已封装该流程的一键启动脚本。

真实 ESP32 使用独立端口时相应改为 `hdc fport tcp:9001 tcp:9000`、Bridge `--listen 9101 --relay-to 127.0.0.1:9001`。

## 7. 正确测试 MQTT 下行

不要直接把带双引号的 JSON 嵌入 PowerShell 参数。先准备 UTF-8 JSON 文件，例如 `bridge/_test/gas.json`：

```json
{"cmd":"gas"}
```

然后执行：

```powershell
Set-Location "$root\bridge"
& $node .\mqtt_tool.js pub --broker 127.0.0.1:1883 `
  --topic home/esp32-bath/cmd --msg-file .\_test\gas.json
```

验收时必须看到模拟节点从 `NORMAL` 进入 `ALARM`，并记录真实 alarmId。仅看到 Broker 接收 PUBLISH 不代表节点已经执行。

## 8. APP 离线/恢复测试

1. 确认 APP 已显示 `esp32-bath` 且持续收到状态。
2. 停止该模拟节点，记录停止时刻。
3. 等待超过 12 秒和至少一次 3 秒扫描周期。
4. 保存 APP 离线状态的 UI 或 Hilog 原始证据。
5. 在离线状态尝试 ACK，记录拒绝结果。
6. 以相同 deviceId 重启节点。
7. 保存 APP 恢复在线的 UI 或 Hilog 原始证据。

Bridge 的 socket 断开日志只能证明传输层断开，不能替代 APP 层证据。

第三轮已完成一次该流程：停止时刻和等待记录在 `14-sim-stop-and-wait.txt`，有效 APP 证据分别为 `07-app-bath-offline-layout.json`、`08b-app-offline-ack-rejected-layout.json` 和 `09-app-bath-recovered-layout.json`。

## 9. 常用诊断

```powershell
# 端口可达性
Test-NetConnection 127.0.0.1 -Port 9000
Test-NetConnection 127.0.0.1 -Port 1883
Test-NetConnection 127.0.0.1 -Port 9100

# 板端进程与日志
& $hdc shell 'ps -ef | grep [h]omemon'
& $hdc shell 'tail -n 100 /data/homemon/homemon.log'
& $hdc shell 'tail -n 100 /data/homemon/say.log'
& $hdc shell 'cat /data/homemon/status.json'
& $hdc shell 'cat /data/homemon/safety.log'

# 语音 Ability 日志
& $hdc hilog | Select-String 'SosVoice|AudioRouterCenter'
```

## 10. 证据保存规则

- 每次测试使用新的编号文件。
- stdout、stderr、Hilog、板端日志和最终状态分开保存。
- 记录 PC 时间与设备时间。
- 记录参与测试的源码和制品 SHA-256。
- 不覆盖前一轮失败记录。
- UI 结论必须有 UI 或 Hilog 层证据。
- `uitest dumpLayout` 超时可能留下空文件或 1 字节文件；先检查文件大小和 JSON 可解析性，再纳入证据索引。
- 图片结论必须经项目规定的图像识别流程；识别服务不可用时，改用可解析的 UI 层级或 Hilog，不凭截图文件存在下结论。

## 11. 第三轮基线与停止状态

当前软件基线的完整验证目录为：

```text
evidence/2026-10-10-third-device-validation/
```

验收结束后已精确停止 Broker、Bridge、模拟节点、APP 和 homemon，并移除 `tcp:9000` fport；`19-cleanup-state.txt` 证明 PC 端 `1883/9000/9100` 均为 FREE。板端 `/data/homemon` 和历史安全日志保留。重新演示时从第 2 节预检开始，再执行第 5 节启动命令。

## 12. 转换语音素材

```powershell
powershell -ExecutionPolicy Bypass -File "$root\materials\make_voice.ps1" `
  -Input '<WORKSPACE>\录音机-20261009-2052.m4a'
```

`-Input` 保持为兼容别名，脚本内部使用 `$InputPath`，避免与 PowerShell 自动变量 `$input` 冲突。脚本先写同目录随机临时 WAV，只有 FFmpeg 退出码为 0、文件非空且可解析出 Duration 时才替换目标；失败时清理临时文件并保留旧 `sos.wav`。真实 M4A 成功转换、缺失输入和 FFmpeg 内部失败路径见 `evidence/2026-10-10-make-voice-entry-fix-and-selftest.txt`。

## 13. ESP32 构建与烧录

`esp32-node/flash_esp32.ps1` 已支持 `-FlashBaud`，默认使用实测稳定的 `115200`。当前真实硬件配置示例：

```powershell
powershell -ExecutionPolicy Bypass -File "$root\esp32-node\flash_esp32.ps1" `
  -Ssid '<SSID>' -Pass '<PASSWORD>' -NodeId esp32-bath -Room 卫生间 `
  -GwHost '<PC_LAN_IP>' -GwPort 9101 -Com COM9 -FlashBaud 115200 -NoMotionSec 30
```

配置中包含局域网凭据，外发日志和配置前必须脱敏。ESP32 通过原始 TCP 上报到 Bridge，MQTT 发布由 Bridge 完成。

## 14. 常驻家庭云网关

模块位置：`cloud/onenet/gateway.js`。它订阅本地 `home/+/status` 并上行 OneNET，按下行白名单执行
受限命令。设备密钥**只允许**由用户在本机用 `Read-Host -AsSecureString` 隐藏输入或由系统 Secret 注入，
不得进入命令行参数、文件或日志。

### 分层验收（不需要真实凭据）

```powershell
Set-Location "$root\cloud\onenet"

# 第 1 层：单元测试，依赖全部注入，不连 OneNET 也不连真实 Broker
& $node .\gateway.test.js

# 第 2 层：真实本地 Broker + 真实 MQTT 报文 + 伪 OneNET 传输层
& $node .\gateway-local-integration.js
```

预期：第 1 层 41/41，第 2 层 14/14 且退出码 0。第 2 层会自行拉起 `bridge/mqtt_broker.js`
并调用 `bridge/mqtt_tool.js` 发布真实报文形状，因此必须先确认 `cloud/onenet/node_modules` 已安装。

### 全目录回归

```powershell
cd <WORKSPACE>\competition\cloud\onenet
npm run check
# 沙箱内 `npm test` 会因测试运行器需要管道 stdio 报 spawn EPERM；
# 逐个文件执行可得到同一套用例结果：
node adapter.test.js; node token.test.js; node transport.test.js;
node live-check.test.js; node downlink-check.test.js; node gateway.test.js
```

预期：91 项全部通过（原有 37 项不得回归）。

### 常驻运行（需要真实凭据，仅由用户本机注入）

先起本地 Broker 与 Bridge（第 6 节），确认 `home/+/status` 有真实状态后，再以隐藏输入方式启动网关。
运行前记录 PC 时间、`hdc list targets` 和三个端口的监听状态；运行日志只应包含 productId、
deviceName、deviceId、命令类型和安全错误码。

`GATEWAY_RESET_MODE` 决定 `RESET` 的作用域：`local`（只复位网关聚合）、`self`（默认，复位
`ONENET_DEVICE_NAME` 对应的那台设备）、`target`（仅当恰好一台设备在线）。详细的配置表、设计要点和
第一阶段下行范围见 `cloud/onenet/README.md`。

### OneNET 8883 真实 TLS 自检（不需要密钥）

在申请/注入凭据之前，先确认链路与证书固定仍然对得上线上服务器：

```powershell
& $node "$root\cloud\onenet\tls-live-check.js"
```

用 `transport.js` 完全相同的 TLS 选项（官方 CA + 固定叶证书指纹 + `rejectUnauthorized=true`）
做一次真实握手，**不发送任何 MQTT 字节、不携带凭据**。预期 6/6、退出码 0。
2026-10-10 实测：`TLSv1.3`、`authorized=true`、`CN=OneNET MQTT`、指纹与固定值一致、
有效期至 2049-05-21（未轮换）。证据：`evidence/2026-10-10-onenet-gateway-real-device/onenet-8883-tls-live-check.txt`。

若此项失败，先解决证书轮换（从 OneNET 官方文档重新取得 CA 并同时更新指纹），
**不得**通过关闭证书校验绕过。

### 生产入口启动自检（不需要密钥）

真机分层验收走的是注入伪传输层的 harness，因此 `gateway.js` 的生产入口要单独自检一次：

```powershell
# 起真实 Broker
& $node "$root\bridge\mqtt_broker.js" 1883
# 另开一个进程，用生产入口启动（故意不设 ONENET_DEVICE_KEY）
$env:ONENET_PRODUCT_ID='I19NBBq4xe'; $env:ONENET_DEVICE_NAME='dayu200-living'
$env:GATEWAY_BROKER_URL='mqtt://127.0.0.1:1883'
& $node "$root\cloud\onenet\gateway.js"
```

预期：进程**保持存活**并打印 `[gateway] START` 与 `[gateway] LOCAL_SUBSCRIBED`；缺少设备密钥
只会让 OneNET 侧按指数退避重试并记录安全错误码，**不得**终止进程。启动失败排查用
`GATEWAY_DEBUG=1` 打印堆栈。

2026-10-10 该自检抓出两个缺陷并已修复：`createGateway` 拒绝 `process.env`（导致生产入口
一启动即 `FATAL message=env must be a plain object`），以及 `transportError` 无人监听导致云端
错误在常驻进程里完全不可见。

不得把网关分层验收的 PASS 写成“OneNET 下行已驱动真实 DAYU/ESP32 动作”：第二阶段回执由验收脚本模拟。

## 15. 真机预检与真机分层验收

### 15.1 只读预检（不安装、不启动、不写板端）

```powershell
powershell -ExecutionPolicy Bypass -File "$root\materials\start-demo-supervisor.ps1" -Preflight
```

只读检查 hdc 目标、DAYU 端点解析、板端 homemon/哈希、`hdc fport`、PC 侧端口占用与 P0 状态，
并给出 `PREFLIGHT PASS / PREFLIGHT BLOCKED`。不启动、不修改任何服务。

### 15.2 真机分层验收（本地链路 + 伪 OneNET，不需要密钥）

```powershell
powershell -ExecutionPolicy Bypass -File "$root\cloud\onenet\real-device-acceptance.ps1" `
  -Evidence "$root\evidence\<本轮证据目录>"
```

链路为：板端 `homemon` 真实 `status.json` -> 本地真实 Broker -> `gateway.js` 真实代码，
仅 OneNET 传输层换成伪传输层。因此**不需要设备密钥**，也**不能**代表真实公网常驻已通过。

覆盖：制品一致性、真实板端状态上云、房间来源保留、稳定状态限频、真实板端告警产生
`safetyAlarm`、同一 `alarmId` 不重复告警、清理。预期 17/17、退出码 0。

### 15.2b 真机下行 RESET 闭环（真实 fport + 真实 Bridge）

```powershell
powershell -ExecutionPolicy Bypass -File "$root\cloud\onenet\real-device-reset-acceptance.ps1" `
  -Evidence "$root\evidence\<本轮证据目录>"
```

这条链路**全部真实**（含 `hdc fport` 上的真实 `mqtt_bridge.js`），只有 OneNET 传输层是伪的：

```text
板端 homemon :9000 --hdc fport--> PC 9000 --Bridge--> Broker --> gateway.js
  --RESET--> home/<deviceId>/cmd --Bridge 按 deviceId 路由--> 板端执行 reset --> 真实回执
```

预期 20/20、退出码 0。判定要点：

- 必须看到 Bridge 的 `命令已写入节点 <deviceId> 的活动连接: reset`。
  若出现 `无法解析下行命令`，说明下行负载不是 JSON（Bridge 只接受 `{"cmd":"reset"}`）。
- 必须看到板端 `homemon.log` 在告警之后出现 `状态复位 -> NORMAL`。
- 板端每 `report_every_sec`（演示配置 3 秒）才刷新 `status.json`，因此“复位是否生效”必须
  **有界等待**，不能下发后立刻读一次。

### 15.2c 不使用 node:test 运行器的语义核对

```powershell
node "$root\cloud\onenet\gateway-toctou-check.js"
```

沙箱下 `node --test` 会因管道 stdio 报 `spawn EPERM`（测试运行器要拉起子进程）。该脚本用
纯断言直接执行，覆盖三个 RESET 场景：无告警必须拒绝、有告警但无回执必须超时失败、
有告警且有新回执才成功。预期退出码 0。

编排要点：

- **必须由 PowerShell 编排**。受限沙箱下 Node 无法以管道 stdio 调用 `hdc`（`hdc` 常驻 server 持有
  管道，`spawnSync` 永不返回或直接 EPERM），因此 `hdc` 操作全部留在 PowerShell，Node 只做 MQTT。
- **绝不能用 `--msg` 传 JSON**。PowerShell 会吞掉内层双引号，把 `{"deviceId":...}` 变成
  `{deviceId:...}`，Broker 与网关都会判为非法 JSON；必须写文件后用 `--msg-file`
  （`bridge/README.md` 已记录该坑）。
- 读取 Node 写出的 UTF-8 事件文件时必须用 `Get-Content -Encoding UTF8`，否则中文房间名变乱码并产生假失败。

### 15.3 已知现场问题：板端时钟断电丢失

2026-10-10 曾实测板端重启后回到 `2021-01-01`；2026-10-13 当前会话已校准到与 PC UTC
相差 1 秒。板子无 RTC 电池时断电仍可能复发，因此每次启动继续同时记录 PC 与设备时间，
必要时在启动前校时。网关继续使用 PC 本地接收时间作为上云时间戳。

### 15.4 实体传感器必须显式启用

旧脚本的 `motion_gpio=29` 与正式映射冲突，持续高电平还会导致旧代码每秒重复计数。
2026-10-13 已改为按 PIR 激活沿计数，一键脚本默认不读取实体 GPIO、`no_motion_sec=1800`；
只有传感器接线确认后才传 `-UsePhysicalSensors`，此时使用 PIR 117/114 和门磁 29。


