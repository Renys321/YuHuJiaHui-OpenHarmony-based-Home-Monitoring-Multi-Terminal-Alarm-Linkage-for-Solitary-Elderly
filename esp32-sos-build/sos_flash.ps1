# ============================================================================
#  sos_flash.ps1 -- 独立无线随身求助按钮 (esp32-sos) 一键构建+烧录
#  位置：D:\esp32-sos-build（D:\OpenHarmony 外部副本，原目录保持只读）
#  用法示例：
#    .\sos_flash.ps1 -BuildOnly                    # 仅构建，不碰串口
#    .\sos_flash.ps1 -Com COM9                     # 构建+烧录到指定新端口
#    .\sos_flash.ps1 -Monitor                      # 烧录后开串口监视
#  安全机制（沿用原工程 flash_esp32.ps1）：
#    * WiFi 密码隐藏输入，只写入 .local\sdkconfig.sos.defaults（gitignore）；
#    * 烧录前 esptool chip_id 只读确认目标为 ESP32-S3；
#    * 必须输入 COM 号确认；不做历史 COM 猜测，防止误刷现有节点。
# ============================================================================
param(
    [string]$Ssid = "",
    [string]$NodeId = "esp32-sos",
    [string]$Room = "随身求助",
    [string]$GwHost = "",
    [int]   $GwPort = 9101,
    [string]$Com = "",
    [ValidateRange(9600, 921600)][int]$FlashBaud = 115200,
    [switch]$BuildOnly,
    [switch]$Monitor,
    [string]$IdfExport = "D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1"
)

$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$hwCfg = Join-Path $proj "profiles\sos-node.sdkconfig.defaults"
$localDir = Join-Path $proj ".local"
$cfg = Join-Path $localDir "sdkconfig.sos.defaults"
$sdkconfig = Join-Path $localDir "sdkconfig.sos"
$buildDir = Join-Path $proj "build-sos-node"
$baselinePath = Join-Path $localDir "serial-baseline.json"
New-Item -ItemType Directory -Path $localDir -Force | Out-Null

function Get-SerialPorts {
    $map = @{}
    try { Get-CimInstance Win32_SerialPort -ErrorAction Stop | ForEach-Object { $map[[string]$_.DeviceID] = [string]$_.Name } } catch { }
    try { Get-PnpDevice -Class Ports -ErrorAction Stop | ForEach-Object { $m = [regex]::Match([string]$_.FriendlyName, "COM\d+"); if ($m.Success -and -not $map.ContainsKey($m.Value)) { $map[$m.Value] = [string]$_.FriendlyName } } } catch { }
    try { [System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { if (-not $map.ContainsKey($_)) { $map[$_] = $_ } } } catch { }
    try { (Get-ItemProperty "HKLM:\HARDWARE\DEVICEMAP\SERIALCOMM" -ErrorAction Stop).PSObject.Properties | Where-Object { $_.Name -notlike "PS*" } | ForEach-Object { if (-not $map.ContainsKey([string]$_.Value)) { $map[[string]$_.Value] = [string]$_.Name } } } catch { }
    return @($map.GetEnumerator() | ForEach-Object { [pscustomobject]@{ deviceID = [string]$_.Key; name = [string]$_.Value } } | Sort-Object deviceID)
}
function Get-CurrentWlanIPv4 {
    try {
        $candidate = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
            $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -ne "127.0.0.1" -and
            ($_.InterfaceAlias -match "Wi-?Fi|WLAN|Ethernet|以太网")
        } | Select-Object -First 1
        if ($candidate) { return [string]$candidate.IPAddress }
    } catch { }
    return ""
}

if ([string]::IsNullOrWhiteSpace($GwHost)) { $GwHost = Get-CurrentWlanIPv4; if ([string]::IsNullOrWhiteSpace($GwHost)) { $GwHost = "0.0.0.0" } }
Write-Host "==== esp32-sos 求助按钮: 构建 -> 目标确认 -> 烧录 ====" -ForegroundColor Cyan
Write-Host "  deviceId : $NodeId / room : $Room / gateway : $GwHost`:$GwPort"
Write-Host "  buildOnly: $($BuildOnly.IsPresent)"

if ([string]::IsNullOrWhiteSpace($Ssid)) { $Ssid = Read-Host "Enter the 2.4GHz Wi-Fi SSID" }
if ([string]::IsNullOrWhiteSpace($Ssid)) { Write-Host "[ABORT] empty SSID" -ForegroundColor Red; exit 2 }
$sec = Read-Host -AsSecureString "Enter the Wi-Fi password (hidden input, never logged)"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $passPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ([string]::IsNullOrEmpty($passPlain)) { Write-Host "[ABORT] empty password" -ForegroundColor Red; exit 2 }

$lines = @(Get-Content -LiteralPath $hwCfg)
$lines += ("CONFIG_NODE_WIFI_SSID=" + [char]34 + $Ssid + [char]34)
$lines += ("CONFIG_NODE_WIFI_PASS=" + [char]34 + $passPlain + [char]34)
$lines += ("CONFIG_NODE_ID=" + [char]34 + $NodeId + [char]34)
$lines += ("CONFIG_NODE_ROOM=" + [char]34 + $Room + [char]34)
$lines += ("CONFIG_NODE_GW_HOST=" + [char]34 + $GwHost + [char]34)
$lines += "CONFIG_NODE_GW_PORT=$GwPort"
[System.IO.File]::WriteAllLines($cfg, $lines, (New-Object System.Text.UTF8Encoding($false)))
$passPlain = $null
Write-Host "[1/5] 合并配置已写入: $cfg (密码不回显)" -ForegroundColor Yellow

if (Test-Path -LiteralPath $sdkconfig) { Remove-Item -LiteralPath $sdkconfig -Force }
$ps = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
$innerBuild = @"
. '$IdfExport' | Out-Null
Set-Location '$proj'
idf.py -B '$buildDir' -D "SDKCONFIG=$sdkconfig" -D "SDKCONFIG_DEFAULTS=$cfg" build
exit `$LASTEXITCODE
"@
Write-Host "[2/5] 构建中..." -ForegroundColor Yellow
& $ps -NoProfile -ExecutionPolicy Bypass -Command $innerBuild
if ($LASTEXITCODE -ne 0) { Write-Host "[ABORT] build failed" -ForegroundColor Red; exit 1 }
$binPath = Join-Path $buildDir "esp32_elder_node.bin"
if (Test-Path -LiteralPath $binPath) {
    $bin = Get-Item -LiteralPath $binPath
    $sha = (Get-FileHash -LiteralPath $binPath -Algorithm SHA256).Hash
    Write-Host ("[2/5] 产物: {0}  size={1} B  SHA-256={2}" -f $binPath, $bin.Length, $sha) -ForegroundColor Green
}
if ($BuildOnly.IsPresent) { Write-Host "[DONE] 仅构建模式，未触碰串口" -ForegroundColor Green; exit 0 }

$ports = Get-SerialPorts
$ids = @($ports | ForEach-Object { $_.deviceID })
$baseline = $null; $newPorts = @()
if (Test-Path -LiteralPath $baselinePath) {
    $baseline = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json
    $newPorts = @($ports | Where-Object { @($baseline.ports) -notcontains $_.deviceID })
}
if (-not $baseline) {
    [pscustomobject]@{ ports = $ids; createdAt = (Get-Date).ToString("o"); lastFlashedCom = "" } | ConvertTo-Json | Set-Content -LiteralPath $baselinePath -Encoding UTF8
    Write-Host "[3/5] 首次运行：已记录当前串口基线。请只连接目标板（拔掉其它 ESP32）后重跑。" -ForegroundColor Yellow
    exit 2
}
$lastCom = [string]$baseline.lastFlashedCom
if ($Com) {
    $isNew = [bool](@($newPorts | Where-Object { $_.deviceID -eq $Com }).Count -gt 0)
    $allowed = ($ids -contains $Com) -and ($isNew -or ($lastCom -eq $Com))
    if (-not $allowed) { Write-Host "[ABORT] 端口 $Com 不在新增列表（禁止历史 COM 猜测）" -ForegroundColor Red; exit 3 }
} else {
    if ($newPorts.Count -eq 0) { Write-Host "[3/5] 未发现新增串口：请只连接目标板后重跑。" -ForegroundColor Yellow; exit 2 }
    if ($newPorts.Count -gt 1) { Write-Host "[ABORT] 新增多个串口，无法唯一识别目标板：只保留目标板连接后重试。" -ForegroundColor Red; $newPorts | ForEach-Object { Write-Host ("    " + $_.deviceID + "  " + $_.name) }; exit 3 }
    $Com = [string]$newPorts[0].deviceID
}
Write-Host "[3/5] 新增串口: $Com" -ForegroundColor Green
$innerChip = @"
. '$IdfExport' | Out-Null
Set-Location '$proj'
esptool.py --chip esp32s3 -p $Com chip_id
exit `$LASTEXITCODE
"@
$chipOut = (& $ps -NoProfile -ExecutionPolicy Bypass -Command $innerChip) 2>&1 | Out-String
$chipLine = ([regex]::Split($chipOut, "\r?\n") | Where-Object { $_ -match "Chip is|Detected|Chip ID|MAC" } | Select-Object -First 4) -join " ; "
$chipOk = ($chipOut -match "ESP32-S3")
Write-Host "[4/5] chip_id 只读确认: $chipLine" -ForegroundColor $(if ($chipOk) { "Green" } else { "Red" })
if (-not $chipOk) { Write-Host "[ABORT] 目标不是 ESP32-S3，未写入任何内容" -ForegroundColor Red; exit 4 }
Write-Host ""
Write-Host "==== 即将烧录，请确认 ====" -ForegroundColor Cyan
Write-Host "  COM      : $Com   chip: ESP32-S3 (chip_id 已确认)"
Write-Host "  deviceId : $NodeId / room : $Room"
Write-Host "  gateway  : $GwHost`:$GwPort"
Write-Host ""
$confirm = Read-Host "输入 COM 端口号 ($Com) 以确认烧录；其他输入则中止"
if ($confirm -ne $Com) { Write-Host "[ABORT] 未确认，未烧录" -ForegroundColor Red; exit 5 }
$innerFlash = @"
. '$IdfExport' | Out-Null
Set-Location '$proj'
idf.py -B '$buildDir' -D "SDKCONFIG=$sdkconfig" -D "SDKCONFIG_DEFAULTS=$cfg" -p $Com -b $FlashBaud flash
exit `$LASTEXITCODE
"@
Write-Host "[5/5] 烧录中..." -ForegroundColor Yellow
& $ps -NoProfile -ExecutionPolicy Bypass -Command $innerFlash
if ($LASTEXITCODE -ne 0) { Write-Host "[ABORT] flash failed" -ForegroundColor Red; exit 1 }
$allIds = @($ids + $Com | Select-Object -Unique)
[pscustomobject]@{ ports = $allIds; createdAt = (Get-Date).ToString("o"); lastFlashedCom = $Com } | ConvertTo-Json | Set-Content -LiteralPath $baselinePath -Encoding UTF8
Write-Host "[DONE] 已烧录: $Com -> $NodeId / $Room" -ForegroundColor Green
if ($Monitor.IsPresent) {
    $innerMon = @"
. '$IdfExport' | Out-Null
Set-Location '$proj'
idf.py -B '$buildDir' -D "SDKCONFIG=$sdkconfig" -D "SDKCONFIG_DEFAULTS=$cfg" -p $Com monitor
"@
    & $ps -NoProfile -ExecutionPolicy Bypass -Command $innerMon
}
