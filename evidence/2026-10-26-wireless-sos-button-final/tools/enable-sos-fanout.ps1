# WIRELESS-SOS-NOTICE: switch the live TCP bridge to the fan-out build.
#
# This is the ONLY step that touches a shared long-running service, so it is
# deliberately gated behind -Confirm. Without -Confirm it only prints what it
# would do (dry run) and exits 0.
#
# What it does:
#   1. node --check on the patched bridge (refuse to switch a syntactically bad file)
#   2. print the currently running bridge command line (evidence)
#   3. stop that one process and start mqtt_bridge.js with the same broker/listen
#      arguments plus --sos-source/--sos-targets/--sos-log
#   4. wait for TCP 9101 to listen again and show the first log lines
#
# It does NOT touch the broker (1883) or public-sync. Boards retry their TCP
# connection on their own, so the gap is a few seconds.
param(
    [switch]$Confirm,
    [string]$NodeExe = 'D:\Node\node.exe',
    [string]$BridgeDir = 'D:\OpenHarmony\competition\bridge',
    [string]$EvidenceDir = 'D:\OpenHarmony\competition\evidence\2026-10-26-wireless-sos-button-final',
    [string]$Broker = '127.0.0.1:1883',
    [int]$ListenPort = 9101,
    [string]$SosSource = 'esp32-sos',
    [string]$SosTargets = 'esp32-kitchen,esp32-bath'
)
$ErrorActionPreference = 'Stop'
$bridgeJs = Join-Path $BridgeDir 'mqtt_bridge.js'
if (-not (Test-Path -LiteralPath $bridgeJs)) { throw "missing $bridgeJs" }

& $NodeExe --check $bridgeJs
if ($LASTEXITCODE -ne 0) { throw 'bridge syntax check failed; refusing to switch' }
Write-Host 'BRIDGE_SYNTAX_OK'

$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'mqtt_bridge\.js' })
Write-Host ("RUNNING_BRIDGE_COUNT=" + $running.Count)
foreach ($p in $running) { Write-Host ("  pid=" + $p.ProcessId + " cmd=" + $p.CommandLine) }

$logDir = Join-Path $EvidenceDir 'verify'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$outLog = Join-Path $logDir 'bridge-fanout.stdout.log'
$errLog = Join-Path $logDir 'bridge-fanout.stderr.log'
$fanoutLog = Join-Path $EvidenceDir 'verify\sos-fanout.jsonl'
$args = @(
    $bridgeJs,
    '--broker', $Broker,
    '--listen', $ListenPort,
    '--sos-source', $SosSource,
    '--sos-targets', $SosTargets,
    '--sos-log', $fanoutLog
)
Write-Host ("WOULD_START: " + $NodeExe + ' ' + ($args -join ' '))

if (-not $Confirm) {
    Write-Host 'DRY_RUN_ONLY (pass -Confirm to actually switch the running bridge)'
    exit 0
}

foreach ($p in $running) {
    Write-Host ("STOPPING pid=" + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force
}
Start-Sleep -Milliseconds 800

$proc = Start-Process -FilePath $NodeExe -ArgumentList $args -WorkingDirectory $BridgeDir `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
Write-Host ("STARTED pid=" + $proc.Id)

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 300
    $conn = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue
    if ($conn) { $ok = $true; break }
}
Write-Host ("LISTEN_" + $ListenPort + "=" + $ok)
if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Tail 12 }
if (-not $ok) { throw "bridge did not listen on $ListenPort; check $errLog" }
Write-Host 'SOS_FANOUT_ENABLED'
