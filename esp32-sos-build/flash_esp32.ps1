# ============================================================================
#  flash_esp32.ps1 -- ESP32-S3 node: isolated config -> build -> unique target check -> flash
#
#  Safety (2026-10-20):
#    * Wi-Fi password ONLY from a hidden prompt in the visible console (never argv/logs/git);
#    * password is written only to .local/sdkconfig.<profile>.defaults (gitignored);
#    * -BuildOnly never enumerates or touches any serial port and prints no COM;
#    * before flashing: serial enumeration diff, read-only esptool chip_id, target summary,
#      explicit interactive confirmation;
#    * no historical COM guessing; if the target cannot be uniquely confirmed -> stop (BLOCKED).
# ============================================================================
param(
    [ValidateSet("Custom", "Kitchen", "Bathroom")][string]$Profile = "Kitchen",
    [string]$Ssid = "",
    [string]$NodeId = "",
    [string]$Room = "",
    [string]$GwHost = "",
    [int]   $GwPort = 9100,
    [string]$Com = "",
    [ValidateRange(9600, 921600)][int]$FlashBaud = 115200,
    [int]   $NoMotionSec = 1800,
    [switch]$BuildOnly,
    [switch]$Monitor,
    [string]$IdfExport = "D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1"
)

$ErrorActionPreference = "Stop"
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileName = $Profile.ToLowerInvariant()
$localDir = Join-Path $proj ".local"
$buildDir = Join-Path $proj "build-$profileName"
$cfg = Join-Path $localDir "sdkconfig.$profileName.defaults"
$sdkconfig = Join-Path $localDir "sdkconfig.$profileName"
$baselinePath = Join-Path $localDir "serial-baseline.json"

if ($Profile -eq "Kitchen") {
    $profileCfg = Join-Path $proj "profiles\kitchen.sdkconfig.defaults"
    if ([string]::IsNullOrWhiteSpace($NodeId)) { $NodeId = "esp32-kitchen" }
    if ([string]::IsNullOrWhiteSpace($Room)) { $Room = "厨房" }
} elseif ($Profile -eq "Bathroom") {
    /* 同一块板子明天要分别烧厨房/卫生间/第三块：Bathroom 使用独立的
     * build-bathroom 与 .local/sdkconfig.bathroom，绝不覆盖 kitchen 产物。 */
    $profileCfg = Join-Path $proj "profiles\bathroom.sdkconfig.defaults"
    if ([string]::IsNullOrWhiteSpace($NodeId)) { $NodeId = "esp32-bath" }
    if ([string]::IsNullOrWhiteSpace($Room)) { $Room = "卫生间" }
} else {
    $profileCfg = $null
    if ([string]::IsNullOrWhiteSpace($NodeId)) { $NodeId = "esp32-bathroom" }
    if ([string]::IsNullOrWhiteSpace($Room)) { $Room = "卫生间" }
}

function Get-SerialPorts {
    # 合并 4 个来源：Win32_SerialPort 常漏掉 CH340/CP210x 等 USB 转串口设备，
    # 必须再叠加 PnP 与注册表 SERIALCOMM，否则会误报"无新增串口"。
    $map = @{}
    try {
        Get-CimInstance Win32_SerialPort -ErrorAction Stop | ForEach-Object {
            $map[[string]$_.DeviceID] = [string]$_.Name
        }
    } catch { }
    try {
        Get-PnpDevice -Class Ports -ErrorAction Stop | ForEach-Object {
            $m = [regex]::Match([string]$_.FriendlyName, "COM\d+")
            if ($m.Success -and -not $map.ContainsKey($m.Value)) { $map[$m.Value] = [string]$_.FriendlyName }
        }
    } catch { }
    try {
        [System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object {
            if (-not $map.ContainsKey($_)) { $map[$_] = $_ }
        }
    } catch { }
    try {
        (Get-ItemProperty "HKLM:\HARDWARE\DEVICEMAP\SERIALCOMM" -ErrorAction Stop).PSObject.Properties |
            Where-Object { $_.Name -notlike "PS*" } | ForEach-Object {
                if (-not $map.ContainsKey([string]$_.Value)) { $map[[string]$_.Value] = [string]$_.Name }
            }
    } catch { }
    return @($map.GetEnumerator() | ForEach-Object {
        [pscustomobject]@{ deviceID = [string]$_.Key; name = [string]$_.Value }
    } | Sort-Object deviceID)
}

function Get-CurrentWlanIPv4 {
    try {
        $candidate = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
            $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -ne "127.0.0.1" -and
            ($_.InterfaceAlias -match "Wi-?Fi|WLAN|Ethernet|以太网")
        } | Select-Object -First 1
        if ($candidate) { return [string]$candidate.IPAddress }
    } catch { }
    try {
        $nic = Get-NetIPConfiguration -ErrorAction Stop | Where-Object {
            $_.IPv4Address -and $_.NetAdapter.Status -eq "Up"
        } | Select-Object -First 1
        if ($nic) { return [string]$nic.IPv4Address.IPAddress }
    } catch { }
    return ""
}

New-Item -ItemType Directory -Path $localDir -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($GwHost)) {
    $GwHost = Get-CurrentWlanIPv4
    if ([string]::IsNullOrWhiteSpace($GwHost)) { $GwHost = "0.0.0.0" }
}

Write-Host "==== ESP32-S3 node: config -> build -> target check -> flash ====" -ForegroundColor Cyan
Write-Host "  profile  : $Profile"
Write-Host "  deviceId : $NodeId"
Write-Host "  room     : $Room"
Write-Host "  gateway  : $GwHost : $GwPort  (current PC IPv4, not a historical value)"
Write-Host "  buildOnly: $($BuildOnly.IsPresent)"
Write-Host ""

if ([string]::IsNullOrWhiteSpace($Ssid)) {
    $Ssid = Read-Host "Enter the 2.4GHz Wi-Fi SSID"
}
if ([string]::IsNullOrWhiteSpace($Ssid)) { Write-Host "[ABORT] empty SSID" -ForegroundColor Red; exit 2 }

$sec = Read-Host -AsSecureString "Enter the Wi-Fi password (hidden input, never logged)"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $passPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ([string]::IsNullOrEmpty($passPlain)) { Write-Host "[ABORT] empty password (nothing written)" -ForegroundColor Red; exit 2 }

$lines = @()
if ($profileCfg) { $lines += Get-Content -LiteralPath $profileCfg }
else { $lines += 'CONFIG_IDF_TARGET="esp32s3"' }
$lines += ("CONFIG_NODE_WIFI_SSID=" + [char]34 + $Ssid + [char]34)
$lines += ("CONFIG_NODE_WIFI_PASS=" + [char]34 + $passPlain + [char]34)
$lines += ("CONFIG_NODE_ID=" + [char]34 + $NodeId + [char]34)
$lines += ("CONFIG_NODE_ROOM=" + [char]34 + $Room + [char]34)
$lines += ("CONFIG_NODE_GW_HOST=" + [char]34 + $GwHost + [char]34)
$lines += "CONFIG_NODE_GW_PORT=$GwPort"
$lines += "CONFIG_NODE_NO_MOTION_SEC=$NoMotionSec"
[System.IO.File]::WriteAllLines($cfg, $lines, (New-Object System.Text.UTF8Encoding($false)))
$passPlain = $null
Write-Host "[1/5] isolated config written: $cfg (secrets not printed)" -ForegroundColor Yellow

if (Test-Path -LiteralPath $sdkconfig) { Remove-Item -LiteralPath $sdkconfig -Force }

$ps = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"

$innerBuild = @"
. '$IdfExport' | Out-Null
Set-Location '$proj'
Write-Host '[2/5] building...' -ForegroundColor Yellow
idf.py -B '$buildDir' -D "SDKCONFIG=$sdkconfig" -D "SDKCONFIG_DEFAULTS=$cfg" build
exit $LASTEXITCODE
"@
& $ps -NoProfile -ExecutionPolicy Bypass -Command $innerBuild
if ($LASTEXITCODE -ne 0) { Write-Host "[ABORT] build failed" -ForegroundColor Red; exit 1 }

$binPath = Join-Path $buildDir "esp32_elder_node.bin"
if (Test-Path -LiteralPath $binPath) {
    $bin = Get-Item -LiteralPath $binPath
    $sha = (Get-FileHash -LiteralPath $binPath -Algorithm SHA256).Hash
    Write-Host ("[2/5] artifact: {0}  size={1} B  SHA-256={2}" -f $binPath, $bin.Length, $sha) -ForegroundColor Green
}

if ($BuildOnly.IsPresent) {
    Write-Host "[DONE] build-only mode: no serial port enumerated, no serial access, no flash." -ForegroundColor Green
    exit 0
}

$ports = Get-SerialPorts
$ids = @($ports | ForEach-Object { $_.deviceID })
$baseline = $null
$newPorts = @()
if (Test-Path -LiteralPath $baselinePath) {
    $baseline = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json
    $baseIds = @($baseline.ports)
    $newPorts = @($ports | Where-Object { $baseIds -notcontains $_.deviceID })
}

if (-not $baseline) {
    [pscustomobject]@{ ports = $ids; createdAt = (Get-Date).ToString("o"); lastFlashedCom = "" } | ConvertTo-Json | Set-Content -LiteralPath $baselinePath -Encoding UTF8
    Write-Host "[3/5] serial baseline recorded ($($ids.Count) ports). Disconnect the kitchen ESP32, then run again to detect a NEW port." -ForegroundColor Yellow
    Write-Host "      Nothing flashed, no serial port was touched." -ForegroundColor Yellow
    exit 2
}

$lastCom = [string]$baseline.lastFlashedCom
if ($Com) {
    $isNew = [bool](@($newPorts | Where-Object { $_.deviceID -eq $Com }).Count -gt 0)
    $allowed = ($ids -contains $Com) -and ($isNew -or ($lastCom -eq $Com))
    if (-not $allowed) {
        Write-Host "[ABORT] requested port $Com is not in the newly-added list (no historical COM guessing)." -ForegroundColor Red
        exit 3
    }
} else {
    if ($newPorts.Count -eq 0) {
        Write-Host "[3/5] no NEW serial port: waiting for the kitchen ESP32. No existing port is touched." -ForegroundColor Yellow
        exit 2
    }
    if ($newPorts.Count -gt 1) {
        Write-Host "[ABORT] multiple new ports; cannot uniquely identify the target board:" -ForegroundColor Red
        $newPorts | ForEach-Object { Write-Host ("        " + $_.deviceID + "  " + $_.name) -ForegroundColor Red }
        Write-Host "        Keep only the kitchen ESP32 connected and retry." -ForegroundColor Red
        exit 3
    }
    $Com = [string]$newPorts[0].deviceID
}
Write-Host "[3/5] new serial port: $Com (baseline $($ids.Count), new $($newPorts.Count))" -ForegroundColor Green

$innerChip = @"
. '$IdfExport' | Out-Null
Set-Location '$proj'
esptool.py --chip esp32s3 -p $Com chip_id
exit $LASTEXITCODE
"@
$chipOut = (& $ps -NoProfile -ExecutionPolicy Bypass -Command $innerChip) 2>&1 | Out-String
$chipLines = [regex]::Split($chipOut, "\r?\n") | Where-Object { $_ -match "Chip is|Detected|Chip ID|MAC" } | Select-Object -First 4
$chipLine = ($chipLines -join " ; ")
$chipOk = ($chipOut -match "ESP32-S3")
Write-Host "[4/5] read-only chip_id check: $chipLine" -ForegroundColor $(if ($chipOk) { "Green" } else { "Red" })
if (-not $chipOk) {
    Write-Host "[ABORT] target is not confirmed as ESP32-S3; nothing was written." -ForegroundColor Red
    exit 4
}

Write-Host ""
Write-Host "==== about to flash (verify and confirm) ====" -ForegroundColor Cyan
Write-Host "  COM      : $Com"
Write-Host "  chip     : ESP32-S3 (confirmed read-only via esptool chip_id)"
Write-Host "  deviceId : $NodeId"
Write-Host "  room     : $Room"
Write-Host "  profile  : $Profile (build-$profileName / .local/sdkconfig.$profileName)"
Write-Host "  gateway  : $GwHost : $GwPort"
Write-Host ""
$confirm = Read-Host "Type the COM port name ($Com) to confirm flashing; anything else aborts"
if ($confirm -ne $Com) { Write-Host "[ABORT] not confirmed; nothing flashed." -ForegroundColor Red; exit 5 }

$innerFlash = @"
. '$IdfExport' | Out-Null
Set-Location '$proj'
Write-Host '[5/5] flashing...' -ForegroundColor Yellow
idf.py -B '$buildDir' -D "SDKCONFIG=$sdkconfig" -D "SDKCONFIG_DEFAULTS=$cfg" -p $Com -b $FlashBaud flash
exit $LASTEXITCODE
"@
& $ps -NoProfile -ExecutionPolicy Bypass -Command $innerFlash
if ($LASTEXITCODE -ne 0) { Write-Host "[ABORT] flash failed" -ForegroundColor Red; exit 1 }

$allIds = @($ids + $Com | Select-Object -Unique)
[pscustomobject]@{ ports = $allIds; createdAt = (Get-Date).ToString("o"); lastFlashedCom = $Com } | ConvertTo-Json | Set-Content -LiteralPath $baselinePath -Encoding UTF8
Write-Host "[DONE] flashed: $Com -> $NodeId / $Room" -ForegroundColor Green

if ($Monitor.IsPresent) {
    $innerMon = @"
. '$IdfExport' | Out-Null
Set-Location '$proj'
idf.py -B '$buildDir' -D "SDKCONFIG=$sdkconfig" -D "SDKCONFIG_DEFAULTS=$cfg" -p $Com monitor
"@
    & $ps -NoProfile -ExecutionPolicy Bypass -Command $innerMon
}
