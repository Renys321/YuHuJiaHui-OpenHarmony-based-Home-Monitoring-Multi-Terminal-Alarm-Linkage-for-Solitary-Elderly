# resolve-dayu-lan-ip.ps1 — DAYU200 状态/relay 端点只读解析（2026-10-28）
#
# 背景：DAYU200 的 WLAN IPv4 会漂移（现场已从 10.127.130.250 变成 10.127.130.131）。
# bridge 的 --status-tcp/--relay-to 与 mirror 的 --relay-to 如果写死旧 IP，就会表现为
# 「P0 收不到 dayu200-living 的 202」「mirror relay connected=False(ETIMEDOUT)」。
#
# 本脚本只读，不启动/停止任何服务、不创建 hdc fport、不写运行时文件、不读取任何凭据：
#   1) 用 `hdc shell ifconfig wlan0` 取板端 WLAN IPv4；
#   2) 检查该 IP:9000（homemon 端口）是否 TCP 可达；
#   3) 失败则回退 hdc fport `tcp:9001 -> tcp:9000`（127.0.0.1:9001）；
#   4) 默认优先 USB+fport（无 IP 依赖），-PreferLan 时优先局域网直连。
#      fport 尚未建立但 USB target 在线时，返回 usb-fport-pending，由启动入口负责创建。
#
# 输出（-JsonOnly）：JSON 一行/多行，字段：
#   ok, target, usbConnected, wlan0Ip, lanReachable, fportPresent, fportListening,
#   endpoint, method(usb-fport|usb-fport-pending|lan|fport|none), requiresFportCreate, checkedAt
# 退出码：0 = 得到可用端点；3 = 未找到（需人工检查 DAYU 电源/HDC/USB/WLAN）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File materials\resolve-dayu-lan-ip.ps1
#   powershell ... -File materials\resolve-dayu-lan-ip.ps1 -JsonOnly
#   powershell ... -File materials\resolve-dayu-lan-ip.ps1 -PreferLan
#   powershell ... -File materials\resolve-dayu-lan-ip.ps1 -Target <hdc target>
#
# 在启动入口中的用法（已集成，见 start-demo-supervisor.ps1 -AutoDayuEndpoint）：
#   $ep = (.\resolve-dayu-lan-ip.ps1 -JsonOnly | ConvertFrom-Json).endpoint
#   bridge: --status-tcp $ep --relay-to $ep
#   mirror: scripts\start-mirror.ps1 -Transport relay -RelayTo $ep
param(
    [string]$Target = '',
    [string]$Hdc = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe',
    [int]$DayuPort = 9000,
    [int]$FportLocalPort = 9001,
    # DAYU 在相机+推理并行时负载较高，实测 TCP 建连可能 >700ms，默认放宽到 2500ms。
    [int]$TimeoutMs = 2500,
    [switch]$PreferLan,
    [switch]$JsonOnly
)

$ErrorActionPreference = 'Stop'
$DefaultDayuTarget = '450100445634303332012847942eca00'

function Test-TcpPort([string]$HostName, [int]$Port, [int]$Timeout) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne($Timeout)) { return $false }
        $client.EndConnect($ar)
        return $true
    } catch { return $false } finally { $client.Dispose() }
}

function Test-UsableIPv4([string]$Ip) {
    if (-not $Ip) { return $false }
    $parts = $Ip.Split('.')
    if ($parts.Count -ne 4) { return $false }
    foreach ($p in $parts) {
        $n = 0
        if (-not [int]::TryParse($p, [ref]$n)) { return $false }
        if ($n -lt 0 -or $n -gt 255) { return $false }
    }
    if ($Ip -match '^127\.') { return $false }
    if ($Ip -eq '0.0.0.0') { return $false }
    if ($Ip -match '^169\.254\.') { return $false }
    return $true
}

function Resolve-DayuTarget {
    if ($Target) { return $Target }
    $lines = @(& $Hdc list targets -v 2>&1)
    $ids = @()
    foreach ($line in $lines) {
        if ($line -match '(?i)([0-9a-f]{32}).*USB.*Connected') { $ids += $Matches[1] }
    }
    $ids = @($ids | Select-Object -Unique)
    if ($ids.Count -eq 1) { return $ids[0] }
    if ($ids.Count -gt 1) { return ('__MULTIPLE__:' + ($ids -join ',')) }
    $plain = @(& $Hdc list targets 2>&1)
    foreach ($line in $plain) { if ($line -match [regex]::Escape($DefaultDayuTarget)) { return $DefaultDayuTarget } }
    return ''
}

function Get-Wlan0IPv4([string]$DayuTarget) {
    $out = @(& $Hdc -t $DayuTarget shell 'ifconfig wlan0' 2>&1)
    $text = ($out -join "`n")
    $m = [regex]::Match($text, 'inet addr:\s*(\d{1,3}(?:\.\d{1,3}){3})')
    if (-not $m.Success) { $m = [regex]::Match($text, '(?m)^\s*inet\s+(\d{1,3}(?:\.\d{1,3}){3})') }
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Get-FportState {
    $text = (@(& $Hdc fport ls 2>&1) -join "`n")
    $local = $FportLocalPort
    $remote = $DayuPort
    # 兼容 "tcp:9001 tcp:9000" / "tcp:9001 -> tcp:9000" / 带 [Reverse] 的 rport 行
    $pattern = 'tcp:' + $local + '\s+(?:->\s+)?tcp:' + $remote + '\b'
    $present = ($text -match $pattern)
    return [pscustomobject]@{
        Present   = [bool]$present
        Listening = (Test-TcpPort '127.0.0.1' $local $TimeoutMs)
        Text      = $text
    }
}

$result = [ordered]@{
    checkedAt           = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    ok                  = $false
    target              = ''
    usbConnected        = $false
    wlan0Ip             = ''
    lanReachable        = $false
    fportPresent        = $false
    fportListening      = $false
    endpoint            = ''
    method              = 'none'
    requiresFportCreate = $false
    reason              = ''
}

if (-not (Test-Path $Hdc)) {
    $result.reason = 'HDC_MISSING'
} else {
    $dayuTarget = Resolve-DayuTarget
    if ($dayuTarget -like '__MULTIPLE__:*') {
        $result.reason = 'MULTIPLE_USB_TARGETS（请用 -Target 明确指定）: ' + $dayuTarget.Substring(14)
    } elseif (-not $dayuTarget) {
        $result.reason = 'NO_USB_TARGET'
    } else {
        $result.target = $dayuTarget
        $result.usbConnected = $true
        $result.wlan0Ip = Get-Wlan0IPv4 $dayuTarget
        if (Test-UsableIPv4 $result.wlan0Ip) {
            # DAYU 高负载时单次 TCP 建连可能 >2.5s；重试两次，任一成功即认为可达。
            for ($attempt = 0; $attempt -lt 2 -and -not $result.lanReachable; $attempt++) {
                if ($attempt -gt 0) { Start-Sleep -Milliseconds 300 }
                $result.lanReachable = Test-TcpPort $result.wlan0Ip $DayuPort $TimeoutMs
            }
        }
        $fport = Get-FportState
        $result.fportPresent = $fport.Present
        $result.fportListening = $fport.Listening

        if ($PreferLan) {
            if ($result.lanReachable) {
                $result.endpoint = ($result.wlan0Ip + ':' + $DayuPort)
                $result.method = 'lan'
            } elseif ($fport.Present -and $fport.Listening) {
                $result.endpoint = ('127.0.0.1:' + $FportLocalPort)
                $result.method = 'fport'
            } else {
                $result.endpoint = ('127.0.0.1:' + $FportLocalPort)
                $result.method = 'usb-fport-pending'
                $result.requiresFportCreate = $true
            }
        } else {
            # 默认：USB 在线优先走 fport（不依赖板端 IP，天然免疫 IP 漂移）
            if ($fport.Present -and $fport.Listening) {
                $result.endpoint = ('127.0.0.1:' + $FportLocalPort)
                $result.method = 'usb-fport'
            } elseif ($result.usbConnected) {
                $result.endpoint = ('127.0.0.1:' + $FportLocalPort)
                $result.method = 'usb-fport-pending'
                $result.requiresFportCreate = $true
            } elseif ($result.lanReachable) {
                $result.endpoint = ($result.wlan0Ip + ':' + $DayuPort)
                $result.method = 'lan'
            } elseif ($fport.Present) {
                $result.endpoint = ('127.0.0.1:' + $FportLocalPort)
                $result.method = 'fport'
            }
        }
        if ($result.endpoint) {
            $result.ok = $true
            $result.reason = 'OK'
        } else {
            $result.reason = 'ENDPOINT_UNREACHABLE（WLAN 不可达且 fport 不可用）'
        }
    }
}

$jsonText = ($result | ConvertTo-Json -Depth 4)
if ($JsonOnly) {
    Write-Output $jsonText
} else {
    Write-Host '=== DAYU200 状态/relay 端点只读解析（不启动/不停止/不建 fport）===' -ForegroundColor Cyan
    Write-Host ("  时间        : {0}" -f $result.checkedAt)
    Write-Host ("  HDC target  : {0}" -f $(if ($result.target) { $result.target } else { '(未找到)' }))
    Write-Host ("  wlan0 IPv4  : {0}" -f $(if ($result.wlan0Ip) { $result.wlan0Ip } else { '(未取到)' }))
    Write-Host ("  LAN {0}   : {1}" -f $DayuPort, $(if ($result.lanReachable) { '可达' } else { '不可达' }))
    Write-Host ("  hdc fport   : present={0} 127.0.0.1:{1} listening={2}" -f $result.fportPresent, $FportLocalPort, $result.fportListening)
    if ($result.ok) {
        Write-Host ("  结论        : endpoint={0} method={1}{2}" -f $result.endpoint, $result.method,
            $(if ($result.requiresFportCreate) { '（启动入口会创建 fport）' } else { '' })) -ForegroundColor Green
        if ($result.method -eq 'usb-fport-pending') {
            Write-Host '  注意        : 当前无 fport，但 USB target 在线；start-demo-supervisor.ps1 -AutoDayuEndpoint 会创建 tcp:9001->tcp:9000。' -ForegroundColor Yellow
        }
        if ($result.method -eq 'lan') {
            Write-Host '  注意        : 走局域网直连，DAYU WLAN IP 再次漂移后需重新解析并重启 bridge/mirror。' -ForegroundColor Yellow
        }
    } else {
        Write-Host ("  结论        : 失败（{0}）" -f $result.reason) -ForegroundColor Red
    }
}
exit $(if ($result.ok) { 0 } else { 3 })
