$ErrorActionPreference = 'Stop'
$node = 'D:\Node\node.exe'
$bridgeDir = 'D:\OpenHarmony\competition\bridge'
$rt = Join-Path $bridgeDir '_test\current-runtime\supervisor'
New-Item -ItemType Directory -Force -Path $rt | Out-Null
if (-not (Get-NetTCPConnection -State Listen -LocalPort 1883 -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $node -ArgumentList @('mqtt_broker.js', '1883') -WorkingDirectory $bridgeDir -WindowStyle Hidden
    Start-Sleep -Seconds 2
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort 9101 -ErrorAction SilentlyContinue)) {
    $args = @('mqtt_bridge.js', '--broker', '127.0.0.1:1883', '--status-tcp', '127.0.0.1:9001',
        '--listen', '9101', '--relay-to', '127.0.0.1:9001',
        '--cmd-out', (Join-Path $rt 'control'), '--status-file', (Join-Path $rt 'status.json'),
        '--lock-file', (Join-Path $rt 'bridge.lock'), '--relay-ignore', 'esp32-sos')
    Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $bridgeDir -WindowStyle Hidden
    Start-Sleep -Seconds 2
}
Write-Output ('broker=' + [bool](Get-NetTCPConnection -State Listen -LocalPort 1883 -ErrorAction SilentlyContinue))
Write-Output ('bridge=' + [bool](Get-NetTCPConnection -State Listen -LocalPort 9101 -ErrorAction SilentlyContinue))
exit 0
