#Requires -Version 5.1
<#
.SYNOPSIS
  同时采集厨房(默认 COM5) + 卫生间(默认 COM4) 两块 ESP32-S3 的串口控制台，
  带毫秒时间戳分别写 bath.log / kitchen.log，并写合并时间线 merged.log。

.DESCRIPTION
  验收场景：实体按键 -> 本地语音/LED -> APP/DAYU 告警 -> 用户 ACK -> 设备回执。
  本脚本只做“接收”，绝不向串口发送任何字节，不会触发固件命令。

  打开端口前把 DTR/RTS 置为 false（deasserted），避免 ESP32 自动复位电路被
  采集工具误触发；这与 2026-10-26-local-alarm-led-closure 已有串口工具口径一致。
  如需主动复位板子请显式加 -AssertDtrRts（本验收流程不应使用）。

  端口被占用时明确报“端口占用”并以退出码 2 结束；不会静默丢数据。

.PARAMETER BathCom
  卫生间板串口，默认 COM4（固件 deviceId=esp32-bath）。

.PARAMETER KitchenCom
  厨房板串口，默认 COM5（固件 deviceId=esp32-kitchen）。

.PARAMETER Baud
  波特率，默认 115200（8N1）。固定 8 数据位/无校验/1 停止位。

.PARAMETER Seconds
  采集时长（秒）。0=一直采到 Ctrl+C。验收建议 300~900。

.PARAMETER OutDir
  输出目录。默认 <本脚本目录>\logs\dual-<yyyyMMdd-HHmmss>\，
  其中写 bath.log、kitchen.log、merged.log。

.PARAMETER ListPorts
  列出当前枚举的 COM 口后退出（不打开任何端口）。

.PARAMETER SelfTest
  离线自检：参数解析、时间戳格式、UTF-8 跨块解码、行拆分、错误分类、
  日志落盘逻辑；不会打开任何真实端口，可在 COM4/COM5 被占用时安全运行。

.PARAMETER AssertDtrRts
  显式拉高 DTR/RTS（可能复位板子）。验收流程不要用。

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File dual-serial-capture.ps1 -ListPorts

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File dual-serial-capture.ps1 -Seconds 600

.EXAMPLE
  # 负向测试（不应打开 COM4/COM5）：
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File dual-serial-capture.ps1 -BathCom COM98 -KitchenCom COM99 -Seconds 2

.NOTES
  退出码：0=正常结束；2=参数/端口/占用错误（未开始采集）；1=采集中运行错误。
#>
[CmdletBinding()]
param(
    [string]$BathCom = 'COM4',
    [string]$KitchenCom = 'COM5',
    [ValidateRange(1200, 4000000)]
    [int]$Baud = 115200,
    [Alias('Duration')]
    [ValidateRange(0, 86400)]
    [int]$Seconds = 0,
    [string]$OutDir = '',
    [switch]$ListPorts,
    [switch]$SelfTest,
    [switch]$AssertDtrRts,
    [switch]$NoEcho
)

$ErrorActionPreference = 'Stop'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-Stamp {
    # 毫秒 + 本地时区，例：2026-10-26T21:03:34.446+08:00
    return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
}

function Convert-ToComName([string]$value) {
    $v = $value.Trim()
    if ($v -match '^\d+$') { return 'COM' + $v }
    return $v.ToUpperInvariant()
}

function Get-ComPortNames {
    try { return @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object) }
    catch { return @() }
}

function New-Utf8Writer([string]$path) {
    $sw = New-Object System.IO.StreamWriter($path, $false, (New-Object System.Text.UTF8Encoding($false)))
    $sw.AutoFlush = $false
    return $sw
}

function New-ReaderState([string]$name, [string]$com, [System.IO.Ports.SerialPort]$port) {
    $dec = (New-Object System.Text.UTF8Encoding($false)).GetDecoder()
    return @{
        Name    = $name
        Com     = $com
        Port    = $port
        Decoder = $dec
        Text    = ''
        Lines   = 0
        Bytes   = 0
        Overflow = 0
    }
}

function Read-PortLines($state) {
    # 只读：ReadExisting 会按 port.Encoding 解码，中文会乱码；这里直接读字节后增量 UTF-8 解码。
    $buf = New-Object byte[] 8192
    $out = New-Object System.Collections.ArrayList
    while ($true) {
        $n = 0
        try { $n = $state.Port.Read($buf, 0, $buf.Length) }
        catch [System.TimeoutException] { break }   # 20ms 无新字节：正常返回，不丢已解码内容
        if ($n -le 0) { break }
        $state.Bytes += $n
        $chars = New-Object char[] ($n * 2)
        $cn = $state.Decoder.GetChars($buf, 0, $n, $chars, 0)
        $state.Text += (New-Object string($chars, 0, $cn))
        if ($state.Text.Length -gt 1048576) {
            # 防御：长时间无换行的异常输出，丢弃前半段而不阻塞
            $state.Overflow++
            $state.Text = $state.Text.Substring($state.Text.Length - 4096)
        }
        while ($true) {
            $idx = $state.Text.IndexOf("`n")
            if ($idx -lt 0) { break }
            $line = $state.Text.Substring(0, $idx).TrimEnd("`r")
            $state.Text = $state.Text.Substring($idx + 1)
            if ($line.Length -gt 0) { [void]$out.Add($line) }
            elseif ($line.Length -eq 0) { [void]$out.Add('') }
        }
    }
    return $out.ToArray()
}

function Flush-PortPartial($state) {
    try {
        $tail = $state.Text
        $state.Text = ''
        if ($tail.Length -gt 0) { return @($tail.TrimEnd("`r")) }
    } catch { }
    return @()
}

function Get-PortOpenFailure($ex) {
    $msg = ''
    try {
        if ($ex -is [System.Management.Automation.ErrorRecord]) { $msg = [string]$ex.Exception.Message }
        elseif ($ex -is [System.Exception]) { $msg = [string]$ex.Message }
        else { $msg = [string]$ex }
    } catch { $msg = [string]$ex }
    if (-not $msg) { $msg = 'unknown error' }
    $kind = 'other'
    if ($ex -is [System.UnauthorizedAccessException]) { $kind = 'occupied' }
    elseif ($msg -match '拒绝访问|Access is denied|Access denied|denied') { $kind = 'occupied' }
    elseif ($msg -match 'does not exist|不存在|No such|FileNotFound|not found') { $kind = 'notfound' }
    elseif ($ex -is [System.ArgumentException] -or $msg -match 'port name|端口名') { $kind = 'invalid' }
    return @{ Kind = $kind; Message = $msg }
}

function New-SerialPort([string]$comName, [int]$baud, [bool]$assert) {
    $port = New-Object System.IO.Ports.SerialPort
    $port.PortName = $comName
    $port.BaudRate = $baud
    $port.Parity = [System.IO.Ports.Parity]::None
    $port.DataBits = 8
    $port.StopBits = [System.IO.Ports.StopBits]::One
    $port.Handshake = [System.IO.Ports.Handshake]::None
    $port.ReadTimeout = 30
    $port.WriteTimeout = 1000
    # 关键：Open() 之前 deassert DTR/RTS，避免复位 ESP32
    $port.DtrEnable = $assert
    $port.RtsEnable = $assert
    return $port
}

function Open-WithDiagnostics([string]$comName, [int]$baud, [bool]$assert) {
    $port = New-SerialPort $comName $baud $assert
    try {
        $port.Open()
    } catch {
        $info = Get-PortOpenFailure $_
        try { $port.Dispose() } catch { }
        if ($info.Kind -eq 'occupied') {
            throw ("端口占用：{0} 无法打开（{1}）。请关闭占用该串口的程序（烧录工具/串口助手/上一个采集进程）后重试。" -f $comName, $info.Message)
        } elseif ($info.Kind -eq 'notfound') {
            throw ("端口不存在：{0} 当前未被系统枚举（{1}）。请确认 USB 线/板子供电后重试；不要假设 COM 号固定。" -f $comName, $info.Message)
        } elseif ($info.Kind -eq 'invalid') {
            throw ("端口名非法：{0}（{1}）" -f $comName, $info.Message)
        } else {
            throw ("打开 {0} 失败：{1}" -f $comName, $info.Message)
        }
    }
    if (-not $port.IsOpen) { throw ("打开 {0} 后状态仍为关闭" -f $comName) }
    return $port
}

# ---------------------------------------------------------------- 自检（不打开端口）
function Invoke-SelfTest {
    $checks = New-Object System.Collections.ArrayList
    function Add-Check([string]$name, [bool]$ok, [string]$detail) {
        [void]$checks.Add(@{ Name = $name; Ok = $ok; Detail = $detail })
        $tag = 'PASS'
        if (-not $ok) { $tag = 'FAIL' }
        Write-Host ("CHECK {0} {1}{2}" -f $tag, $name, $(if ($detail) { ' :: ' + $detail } else { '' }))
    }

    Add-Check 'convert-com-numeric' ((Convert-ToComName '4') -eq 'COM4') (Convert-ToComName '4')
    Add-Check 'convert-com-case' ((Convert-ToComName 'com5') -eq 'COM5') (Convert-ToComName 'com5')
    Add-Check 'convert-com-trim' ((Convert-ToComName ' COM11 ') -eq 'COM11') (Convert-ToComName ' COM11 ')

    $stamp = Get-Stamp
    Add-Check 'timestamp-format' ($stamp -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$') $stamp

    # UTF-8 跨块解码：把“ACK 回执已接受并生效”按 1 字节切块喂给同一 Decoder
    $marker = 'ACK 回执已接受并生效：id=e-1793015347-1 -> state=ACKED'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($marker + "`r`n")
    $dec = (New-Object System.Text.UTF8Encoding($false)).GetDecoder()
    $text = ''
    foreach ($b in $bytes) {
        $one = New-Object byte[] 1
        $one[0] = $b
        $chars = New-Object char[] 4
        $cn = $dec.GetChars($one, 0, 1, $chars, 0)
        $text += (New-Object string($chars, 0, $cn))
    }
    $lines = @($text -split "`n" | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_.Length -gt 0 })
    Add-Check 'utf8-split-chinese' ($lines.Count -eq 1 -and $lines[0] -eq $marker) ('lines=' + $lines.Count)

    # 行拆分：CRLF/LF 混合 + 末尾半行
    $t = "line1`r`nline2`n`nline3"
    $split = @($t -split "`n" | ForEach-Object { $_.TrimEnd("`r") })
    Add-Check 'line-split-crlf-lf' ($split.Count -eq 4 -and $split[0] -eq 'line1' -and $split[2] -eq '') ($split -join '|')
    $fakeState = @{ Text = 'partial-no-newline' }
    $flushed = @(Flush-PortPartial $fakeState)
    Add-Check 'partial-line-flush' ($flushed.Count -eq 1 -and $flushed[0] -eq 'partial-no-newline' -and $fakeState.Text -eq '') ($flushed -join '|')

    # 错误分类：占用 / 不存在 / 非法
    $eOcc = New-Object System.UnauthorizedAccessException('Access to the port ''COM5'' is denied.')
    Add-Check 'error-classify-occupied' ((Get-PortOpenFailure $eOcc).Kind -eq 'occupied') (Get-PortOpenFailure $eOcc).Kind
    $eNF = New-Object System.IO.IOException('The port ''COM98'' does not exist.')
    Add-Check 'error-classify-notfound' ((Get-PortOpenFailure $eNF).Kind -eq 'notfound') (Get-PortOpenFailure $eNF).Kind
    $eInv = New-Object System.ArgumentException('port name')
    Add-Check 'error-classify-invalid' ((Get-PortOpenFailure $eInv).Kind -eq 'invalid') (Get-PortOpenFailure $eInv).Kind

    # 日志写入逻辑（临时目录，不碰 COM）
    $td = Join-Path $env:TEMP ('dual-serial-selftest-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $td -Force | Out-Null
    try {
        $w = New-Utf8Writer (Join-Path $td 'bath.log')
        $w.WriteLine('[' + (Get-Stamp) + '] hello')
        $w.Close()
        $raw = [System.IO.File]::ReadAllText((Join-Path $td 'bath.log'), [System.Text.Encoding]::UTF8)
        Add-Check 'log-write-millis' ($raw -match '^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\] hello') $raw.Trim()

        $m = Join-Path $td 'merged.log'
        $mw = New-Utf8Writer $m
        $mw.WriteLine('[x] [bath] a')
        $mw.WriteLine('[x] [kitchen] b')
        $mw.Close()
        $ml = [System.IO.File]::ReadAllLines($m, [System.Text.Encoding]::UTF8)
        Add-Check 'merged-tags' ($ml.Count -eq 2 -and $ml[0] -match '\[bath\]' -and $ml[1] -match '\[kitchen\]') ($ml -join '|')
    } finally {
        try { Remove-Item -LiteralPath $td -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }

    $failed = @($checks | Where-Object { -not $_.Ok })
    $okCount = $checks.Count - $failed.Count
    Write-Host ("DUAL_SERIAL SELFTEST {0} {1}/{2} checks passed" -f $(if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' }), $okCount, $checks.Count)
    foreach ($f in $failed) { Write-Host ("  FAILED {0} :: {1}" -f $f.Name, $f.Detail) }
    if ($failed.Count -eq 0) { return 0 } else { return 1 }
}

# ---------------------------------------------------------------- 主流程
if ($ListPorts) {
    $names = Get-ComPortNames
    Write-Host 'DUAL_SERIAL list-ports'
    if ($names.Count -eq 0) { Write-Host '  (未检测到任何 COM 口)' }
    else {
        Write-Host ("  {0} 个端口: {1}" -f $names.Count, ($names -join ', '))
        foreach ($n in $names) {
            try {
                $pnp = Get-CimInstance -ClassName Win32_PnPEntity -Filter "Name LIKE '%($n)%'" -ErrorAction SilentlyContinue |
                    Select-Object -First 1 -ExpandProperty Name
            } catch { $pnp = $null }
            if ($pnp) { Write-Host ("  {0}  {1}" -f $n, $pnp) } else { Write-Host ("  {0}" -f $n) }
        }
    }
    Write-Host 'DUAL_SERIAL list-ports OK（未打开端口，DTR/RTS 未触碰）'
    exit 0
}

if ($SelfTest) { exit (Invoke-SelfTest) }

$bathName = Convert-ToComName $BathCom
$kitchenName = Convert-ToComName $KitchenCom
if ($bathName -eq $kitchenName) {
    [Console]::Error.WriteLine("ERROR: BathCom 与 KitchenCom 不能是同一个端口（$bathName）")
    exit 2
}
if (-not $bathName -or -not $kitchenName) {
    [Console]::Error.WriteLine('ERROR: 需要同时给出 -BathCom 与 -KitchenCom')
    exit 2
}

$scriptDir = $PSScriptRoot
if (-not $OutDir) {
    $OutDir = Join-Path (Join-Path $scriptDir 'logs') ('dual-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$outFull = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path -LiteralPath $outFull)) { New-Item -ItemType Directory -Path $outFull -Force | Out-Null }
$bathLog = Join-Path $outFull 'bath.log'
$kitchenLog = Join-Path $outFull 'kitchen.log'
$mergedLog = Join-Path $outFull 'merged.log'

$available = Get-ComPortNames
Write-Host ("DUAL_SERIAL ports available: {0}" -f $(if ($available.Count) { $available -join ', ' } else { 'none' }))

$bathPort = $null
$kitchenPort = $null
$exitCode = 0
$started = $null
$bathWriter = $null
$kitchenWriter = $null
$mergedWriter = $null
$bathState = $null
$kitchenState = $null

try {
    # 先打开卫生间；失败直接退出。成功后再打开厨房；若厨房失败则关闭卫生间后退出，避免半开状态。
    $bathPort = Open-WithDiagnostics $bathName $Baud ([bool]$AssertDtrRts)
    Write-Host ("DUAL_SERIAL open bath={0} baud={1} dtr={2} rts={3}" -f $bathName, $Baud, $bathPort.DtrEnable, $bathPort.RtsEnable)
    try {
        $kitchenPort = Open-WithDiagnostics $kitchenName $Baud ([bool]$AssertDtrRts)
    } catch {
        try { if ($bathPort.IsOpen) { $bathPort.Close() } } catch { }
        try { $bathPort.Dispose() } catch { }
        throw ("厨房端口打开失败，已关闭卫生间端口。原因：{0}" -f $_.Exception.Message)
    }
    Write-Host ("DUAL_SERIAL open kitchen={0} baud={1} dtr={2} rts={3}" -f $kitchenName, $Baud, $kitchenPort.DtrEnable, $kitchenPort.RtsEnable)

    $bathState = New-ReaderState 'bath' $bathName $bathPort
    $kitchenState = New-ReaderState 'kitchen' $kitchenName $kitchenPort
    $bathWriter = New-Utf8Writer $bathLog
    $kitchenWriter = New-Utf8Writer $kitchenLog
    $mergedWriter = New-Utf8Writer $mergedLog

    $bathWriter.WriteLine("# dual-serial-capture.ps1 start $(Get-Stamp)")
    $bathWriter.WriteLine("# serial=$bathName baud=$Baud 8N1 dtr=$($bathPort.DtrEnable) rts=$($bathPort.RtsEnable) expect deviceId=esp32-bath")
    $kitchenWriter.WriteLine("# dual-serial-capture.ps1 start $(Get-Stamp)")
    $kitchenWriter.WriteLine("# serial=$kitchenName baud=$Baud 8N1 dtr=$($kitchenPort.DtrEnable) rts=$($kitchenPort.RtsEnable) expect deviceId=esp32-kitchen")
    $mergedWriter.WriteLine("# dual-serial-capture.ps1 merged timeline start $(Get-Stamp)")
    $mergedWriter.WriteLine("# bath=$bathName (COM4, esp32-bath) / kitchen=$kitchenName (COM5, esp32-kitchen) / $Baud 8N1 / no TX")
    $mergedWriter.WriteLine("# line-format: [yyyy-MM-ddTHH:mm:ss.fff+08:00] [bath|kitchen] <console line>")
    $bathWriter.Flush(); $kitchenWriter.Flush(); $mergedWriter.Flush()
    Write-Host ("DUAL_SERIAL log bath={0}" -f $bathLog)
    Write-Host ("DUAL_SERIAL log kitchen={0}" -f $kitchenLog)
    Write-Host ("DUAL_SERIAL log merged={0}" -f $mergedLog)
    Write-Host ("DUAL_SERIAL duration={0}" -f $(if ($Seconds -gt 0) { "$Seconds s" } else { 'until Ctrl+C' }))
    Write-Host 'DUAL_SERIAL 只接收不发送；两板保持供电，按键/ACK 由操作者执行。'

    $started = Get-Date
    while ($true) {
        $elapsed = ((Get-Date) - $started).TotalSeconds
        if ($Seconds -gt 0 -and $elapsed -ge $Seconds) { break }
        foreach ($st in @($bathState, $kitchenState)) {
            $lines = Read-PortLines $st
            foreach ($line in $lines) {
                $ts = Get-Stamp
                if ($st.Name -eq 'bath') { $bathWriter.WriteLine("[$ts] $line") }
                else { $kitchenWriter.WriteLine("[$ts] $line") }
                $mergedWriter.WriteLine("[$ts] [$($st.Name)] $line")
                $st.Lines++
                if (-not $NoEcho) { Write-Host ("[$ts] [$($st.Name)] $line") }
            }
        }
        $bathWriter.Flush(); $kitchenWriter.Flush(); $mergedWriter.Flush()
        Start-Sleep -Milliseconds 20
    }
} catch {
    $msg = $_.Exception.Message
    [Console]::Error.WriteLine("ERROR: $msg")
    if ($msg -match '端口占用') { $exitCode = 2 } elseif ($msg -match '端口不存在|端口名非法|打开 .* 失败') { $exitCode = 2 }
    else { $exitCode = 1 }
} finally {
    $ended = Get-Date
    $durationSec = 0
    if ($started) { $durationSec = [math]::Round(($ended - $started).TotalSeconds, 3) }
    foreach ($st in @($bathState, $kitchenState)) {
        if ($st -ne $null) {
            try {
                $tail = Flush-PortPartial $st
                foreach ($line in $tail) {
                    $ts = Get-Stamp
                    if ($st.Name -eq 'bath' -and $bathWriter -ne $null) { $bathWriter.WriteLine("[$ts] $line") }
                    elseif ($st.Name -eq 'kitchen' -and $kitchenWriter -ne $null) { $kitchenWriter.WriteLine("[$ts] $line") }
                    if ($mergedWriter -ne $null) { $mergedWriter.WriteLine("[$ts] [$($st.Name)] $line") }
                }
            } catch { }
        }
    }
    foreach ($p in @($bathPort, $kitchenPort)) {
        if ($p -ne $null) { try { if ($p.IsOpen) { $p.Close() } } catch { }; try { $p.Dispose() } catch { } }
    }
    $summary = ("DUAL_SERIAL stop duration={0}s bathLines={1} bathBytes={2} kitchenLines={3} kitchenBytes={4} out={5}" -f `
            $durationSec, $(if ($bathState) { $bathState.Lines } else { 0 }), $(if ($bathState) { $bathState.Bytes } else { 0 }), `
        $(if ($kitchenState) { $kitchenState.Lines } else { 0 }), $(if ($kitchenState) { $kitchenState.Bytes } else { 0 }), $outFull)
    Write-Host $summary
    foreach ($w in @($bathWriter, $kitchenWriter, $mergedWriter)) {
        if ($w -ne $null) { try { $w.WriteLine('# ' + $summary); $w.Flush(); $w.Close() } catch { } }
    }
    if ($exitCode -eq 0 -and $started -ne $null) {
        $total = 0
        if ($bathState) { $total += $bathState.Lines }
        if ($kitchenState) { $total += $kitchenState.Lines }
        if ($total -eq 0) { Write-Warning '本次未采集到任何串口行：请检查板子是否上电、固件是否在跑、BAUD 与接线。' }
    }
    # 端口打开失败时不要在证据目录留下空壳目录（成功采集时保留全部日志）
    if ($exitCode -ne 0 -and $started -eq $null) {
        try {
            if ((Test-Path -LiteralPath $outFull) -and @(Get-ChildItem -LiteralPath $outFull -ErrorAction SilentlyContinue).Count -eq 0) {
                Remove-Item -LiteralPath $outFull -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
}

exit $exitCode
