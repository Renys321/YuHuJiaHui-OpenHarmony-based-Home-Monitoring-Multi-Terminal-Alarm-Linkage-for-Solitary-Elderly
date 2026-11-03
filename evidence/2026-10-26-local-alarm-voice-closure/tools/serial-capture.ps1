<#
.SYNOPSIS
  Capture an ESP32 node serial console to a timestamped log WITHOUT triggering auto-reset.

.DESCRIPTION
  Opens the COM port with DTR and RTS DEASSERTED before Open() so the board's
  auto-reset circuit is not toggled by the capture tool.  Reads raw text, splits it
  into lines, prefixes every line with a local wall-clock timestamp, writes the log
  and prints a live copy + summary.

  Ctrl+C stops the capture cleanly (port is closed in a finally block).

.PARAMETER Com
  COM port, e.g. COM4 or 4.  Required unless -ListPorts.

.PARAMETER Seconds
  Capture duration.  0 (default) = run until Ctrl+C.

.PARAMETER OutFile
  Log path.  Default: <evidence>/verify/serial-<COM>-<yyyyMMdd-HHmmss>.log

.PARAMETER Baud
  Baud rate.  Default 115200 (8N1).

.PARAMETER ListPorts
  Print available COM ports and exit 0.  No port is opened.

.PARAMETER AssertDtrRts
  Opt-in escape hatch: assert DTR/RTS (will likely reset the board).  Off by default.

.EXAMPLE
  pwsh -NoProfile -File tools/serial-capture.ps1 -ListPorts

.EXAMPLE
  pwsh -NoProfile -File tools/serial-capture.ps1 -Com COM4 -Seconds 120
#>
[CmdletBinding()]
param(
    [Alias('Port')]
    [string]$Com = '',
    [Alias('Duration')]
    [ValidateRange(0, 86400)]
    [int]$Seconds = 0,
    [string]$OutFile = '',
    [ValidateRange(1200, 4000000)]
    [int]$Baud = 115200,
    [ValidateSet('None', 'Odd', 'Even', 'Mark', 'Space')]
    [string]$Parity = 'None',
    [ValidateRange(5, 8)]
    [int]$DataBits = 8,
    [ValidateSet('One', 'Two', 'OnePointFive')]
    [string]$StopBits = 'One',
    [switch]$ListPorts,
    [switch]$AssertDtrRts
)

$ErrorActionPreference = 'Stop'
$script:exitCode = 0
$toolsDir = $PSScriptRoot
$evidenceDir = Split-Path -Parent $toolsDir

function Get-ComPortNames {
    try {
        return @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object)
    } catch {
        return @()
    }
}

function Convert-ToComName([string]$value) {
    $v = $value.Trim()
    if ($v -match '^\d+$') { return "COM$v" }
    return $v.ToUpperInvariant()
}

function Get-Timestamp {
    return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
}

# ---------------- -ListPorts: no port is opened ----------------
if ($ListPorts) {
    $names = Get-ComPortNames
    Write-Host 'SERIAL_CAPTURE list-ports'
    if ($names.Count -eq 0) {
        Write-Host '  (no COM ports detected)'
    } else {
        Write-Host ('  {0} port(s): {1}' -f $names.Count, ($names -join ', '))
        foreach ($n in $names) {
            try {
                $pnp = Get-CimInstance -ClassName Win32_PnPEntity -Filter "Name LIKE '%($n)%'" -ErrorAction SilentlyContinue |
                    Select-Object -First 1 -ExpandProperty Name
            } catch { $pnp = $null }
            if ($pnp) { Write-Host ("  {0}  {1}" -f $n, $pnp) } else { Write-Host ("  {0}" -f $n) }
        }
    }
    Write-Host 'SERIAL_CAPTURE list-ports OK (no port opened, DTR/RTS untouched)'
    exit 0
}

if (-not $Com) {
    [Console]::Error.WriteLine('ERROR: Missing -Com.  Use -Com COM4 (or -ListPorts to enumerate ports).')
    exit 2
}

$comName = Convert-ToComName $Com
$available = Get-ComPortNames
if ($available -notcontains $comName) {
    Write-Warning ("{0} is not currently enumerated (available: {1}); attempting open anyway..." -f $comName, ($(if ($available.Count) { $available -join ', ' } else { 'none' })))
}

if (-not $OutFile) {
    $logName = 'serial-{0}-{1}.log' -f ($comName -replace '[^A-Za-z0-9]', ''), (Get-Date -Format 'yyyyMMdd-HHmmss')
    $OutFile = Join-Path (Join-Path $evidenceDir 'verify') $logName
}
$outFull = [System.IO.Path]::GetFullPath($OutFile)
$outDir = Split-Path -Parent $outFull
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$stopBitsEnum = switch ($StopBits) {
    'One' { [System.IO.Ports.StopBits]::One }
    'Two' { [System.IO.Ports.StopBits]::Two }
    'OnePointFive' { [System.IO.Ports.StopBits]::OnePointFive }
}
$parityEnum = [Enum]::Parse([System.IO.Ports.Parity], $Parity)

$port = New-Object System.IO.Ports.SerialPort
$port.PortName = $comName
$port.BaudRate = $Baud
$port.Parity = $parityEnum
$port.DataBits = $DataBits
$port.StopBits = $stopBitsEnum
$port.Handshake = [System.IO.Ports.Handshake]::None
$port.ReadTimeout = 200
$port.WriteTimeout = 1000
# CRITICAL: deassert DTR/RTS BEFORE Open so the ESP32 auto-reset circuit is not toggled.
$port.DtrEnable = [bool]$AssertDtrRts
$port.RtsEnable = [bool]$AssertDtrRts

$timestamp = Get-Timestamp
$header = @(
    "# serial-capture.ps1 $timestamp",
    "# com=$comName baud=$Baud parity=$Parity databits=$DataBits stopbits=$StopBits dtr=$($port.DtrEnable) rts=$($port.RtsEnable) handshake=None",
    "# note: DTR/RTS deasserted before Open to avoid ESP32 auto-reset (AssertDtrRts=$([bool]$AssertDtrRts))",
    "# log-format: [yyyy-MM-ddTHH:mm:ss.fff+08:00] <raw line>"
)
$bytesRead = 0
$lineCount = 0
$buffer = ''
$started = Get-Date

try {
    $port.Open()
} catch {
    [Console]::Error.WriteLine(("ERROR: Failed to open {0}: {1}" -f $comName, $_.Exception.Message))
    if ($available.Count) { [Console]::Error.WriteLine(("Available ports: {0}" -f ($available -join ', '))) }
    exit 2
}

try {
    Write-Host ("SERIAL_CAPTURE start com={0} baud={1} dtr={2} rts={3}" -f $comName, $Baud, $port.DtrEnable, $port.RtsEnable)
    Write-Host ("SERIAL_CAPTURE log={0}" -f $outFull)
    Write-Host ("SERIAL_CAPTURE duration={0}" -f $(if ($Seconds -gt 0) { "$Seconds s" } else { 'until Ctrl+C' }))
    foreach ($h in $header) {
        Add-Content -LiteralPath $outFull -Value $h -Encoding utf8
        Write-Host $h
    }

    while ($true) {
        $elapsed = ((Get-Date) - $started).TotalSeconds
        if ($Seconds -gt 0 -and $elapsed -ge $Seconds) { break }
        Start-Sleep -Milliseconds 30
        $chunk = $port.ReadExisting()
        if ([string]::IsNullOrEmpty($chunk)) { continue }
        $bytesRead += [System.Text.Encoding]::UTF8.GetByteCount($chunk)
        $buffer += $chunk
        while ($buffer.Contains("`n")) {
            $idx = $buffer.IndexOf("`n")
            $line = $buffer.Substring(0, $idx).TrimEnd("`r")
            $buffer = $buffer.Substring($idx + 1)
            $lineCount++
            $entry = '[' + (Get-Timestamp) + '] ' + $line
            Add-Content -LiteralPath $outFull -Value $entry -Encoding utf8
            Write-Host $entry
        }
    }
    if ($buffer.Length -gt 0) {
        # flush a trailing partial line so nothing is lost
        $lineCount++
        $entry = '[' + (Get-Timestamp) + '] ' + $buffer.TrimEnd("`r")
        Add-Content -LiteralPath $outFull -Value $entry -Encoding utf8
        Write-Host $entry
        $buffer = ''
    }
} finally {
    $ended = Get-Date
    $durationSec = [math]::Round(($ended - $started).TotalSeconds, 3)
    try { if ($port.IsOpen) { $port.Close() } } catch { }
    try { $port.Dispose() } catch { }
    $summary = ("SERIAL_CAPTURE stop com={0} lines={1} bytes={2} duration={3}s log={4}" -f $comName, $lineCount, $bytesRead, $durationSec, $outFull)
    Write-Host $summary
    try { Add-Content -LiteralPath $outFull -Value ('# ' + $summary) -Encoding utf8 } catch { }
    if ($lineCount -eq 0) {
        Write-Warning ("No serial lines captured on {0} in {1}s. Check wiring, baud ({2}), and that the board is powered." -f $comName, $durationSec, $Baud)
    }
}

exit 0
