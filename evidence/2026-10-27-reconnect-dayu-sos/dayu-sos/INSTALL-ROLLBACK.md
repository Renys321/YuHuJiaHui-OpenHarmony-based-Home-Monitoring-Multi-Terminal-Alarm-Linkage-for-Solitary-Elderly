# 安装 / 回退 / 环境恢复命令（DAYU200）

> 本文件只给命令，不执行安装。安装、启动 mirror、真机验收由 Lead 统一执行。

## 0. 前提检查

```powershell
$hdc = '<WORKSPACE>\tools\hdc\hdc.exe'
$target = '450100445634303332012847942eca00'
& $hdc list targets          # 必须看到 $target；没有则先接 USB/HDC
& $hdc -t $target shell 'bm dump -n com.dsh.eldercare | grep -m1 "versionName"'   # 当前 1.0.4
& $hdc fport ls              # 房间链路应为 tcp:9001 -> tcp:9000
```

## 1. 安装 1.0.5（覆盖安装，保留应用数据）

```powershell
$signed = '<WORKSPACE>\competition\evidence\2026-10-27-reconnect-dayu-sos\dayu-sos\build\dayu-eldercare-1.0.5-signed.hap'
& $hdc -t $target install -r $signed
# 校验
& $hdc -t $target shell 'bm dump -n com.dsh.eldercare | grep -m1 -E "versionName|versionCode"'
# 期望 versionName 1.0.5 / versionCode 1000005
```

安装后 APP 会自动重启；应用数据（本地偏好/预览调参）保留。

## 2. 恢复 DAYU 本地链路端口（安装不会删除 fport）

```powershell
& $hdc -t $target fport tcp:9001 tcp:9000        # bridge/APP 房间链路（若丢失）
```
tcp 模式的镜像还需要设备侧反向映射到 PC：
```powershell
& $hdc -t $target rport tcp:9002 tcp:9002        # DAYU APP:9002 -> PC 127.0.0.1:9002
```
（`wearable-mirror/scripts/start-mirror.ps1 -Transport tcp` 会自动检查/建立该 rport。）

## 3. 启动随身 SOS 镜像（当前批准的主路径）

```powershell
cd <WORKSPACE>\competition\cloud\wearable-mirror
.\scripts\start-mirror.ps1                        # 默认 -Source api -Transport tcp
Get-Content .\runtime\mirror-status.json          # hasData=true / source=api / phase / online
```

relay 模式（**必须等 bridge 新版本带 `--relay-ignore esp32-sos` 且 homemon MAX_CLIENTS>=8 部署后**）：
```powershell
.\scripts\start-mirror.ps1 -Transport relay        # 会检查 127.0.0.1:9001 可达
```

停止：
```powershell
.\scripts\stop-mirror.ps1
.\scripts\stop-mirror.ps1 -RemoveRport             # 同时清理 rport
```

## 4. 回退（验收失败时）

**回退到当前线上 1.0.4（推荐，覆盖安装保留数据）：**
```powershell
$rollback = '<WORKSPACE>\competition\evidence\2026-10-27-battery-video-visit\dayu-1.0.4\dayu-eldercare-video-1.0.4-signed.hap'
# 1,353,199 B  SHA-256 05230657B89B7D8AFE29C7F94AEC57639887F706725C005603E024B3DA68CF60
& $hdc -t $target install -r $rollback
& $hdc -t $target shell 'bm dump -n com.dsh.eldercare | grep -m1 -E "versionName|versionCode"'  # 期望 1.0.4/1000004
```

**回退到更早的 1.0.2（历史稳定包）：**
```powershell
& $hdc -t $target install -r '<WORKSPACE>\competition\evidence\2026-10-27-dayu200-real-capability\rollback-1.0.2-signed.hap'
```

**回退 mirror（不影响 APP）：** `.\scripts\stop-mirror.ps1` 即停止注入；若已建 rport，
`.\scripts\stop-mirror.ps1 -RemoveRport` 删除。镜像只读数据源，回退不需要后端/权限改动。

**回退源码（如需重新构建）：** `dayu-sos/source-backup/` 中 4 个文件覆盖回
`competition/experiments/dayu-eldercare-preview-integration-2026-10-25/` 对应路径后重新
`assembleHap` 即可（备份与 1.0.4 工作副本逐字节一致）。

## 5. 注意

- 不得清 DAYU 应用数据、不得卸载、不得改签名信任链；以上均为覆盖安装。
- 房间 ESP32（厨房/卫生间）的 MANUAL_SOS 是真实告警，不要在本机 ACK；随身求助的确认
  必须在手机 APP 上完成，由设备真实回执后 DAYU 才显示“设备已确认”。
- 若 DAYU 再次从 hdc 掉线，先恢复 USB/HDC，再执行 §2 的 fport/rport 恢复。
