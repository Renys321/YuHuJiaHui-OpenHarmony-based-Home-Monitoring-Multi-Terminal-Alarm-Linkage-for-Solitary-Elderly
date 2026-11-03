# Capture all DAYU Wi-Fi evidence into the dayu-net evidence folder.
# NOTE: never write the Wi-Fi credential. Redact encrypted blobs.
$ErrorActionPreference = 'Continue'
$hdc = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$T   = '450100445634303332012847942eca00'
$dir = 'D:\OpenHarmony\competition\evidence\2026-10-27-wireless-without-usb\dayu-net'
$log = Join-Path $dir 'logs'
$raw = Join-Path $dir 'raw'
New-Item -ItemType Directory -Force -Path $log, $raw | Out-Null

function Save-Device([string]$name, [string]$cmd, [string]$file) {
  $out = & $hdc -t $T shell $cmd 2>&1 | Out-String
  $out = $out -replace "`r`n", "`n"
  $hdr = "`$ hdc -t $T shell `"$cmd`"`n# captured: " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz') + "`n" + ('-' * 70) + "`n"
  ($hdr + $out) | Set-Content -Path (Join-Path $log $file) -Encoding utf8
  Write-Host "[ok] $file"
}

Write-Host '--- dayu device captures ---'
Save-Device 'ifconfig'      'ifconfig wlan0'                                                                     '01-dayu-ifconfig-wlan0.txt'
Save-Device 'wpa status'    '/vendor/bin/wpa_cli -p /data/service/el1/public/wifi/sockets/wpa -i wlan0 status'    '02-dayu-wpa-status.txt'
Save-Device 'wpa nets'      '/vendor/bin/wpa_cli -p /data/service/el1/public/wifi/sockets/wpa -i wlan0 list_networks; /vendor/bin/wpa_cli -p /data/service/el1/public/wifi/sockets/wpa -i wlan0 scan_results' '03-dayu-wpa-networks-scan.txt'
Save-Device 'route'         'cat /proc/net/route; echo ---ARP---; cat /proc/net/arp; echo ---WIRELESS---; cat /proc/net/wireless' '04-dayu-route-arp-wireless.txt'
Save-Device 'ping pc'       'ping -c 4 10.127.130.179'                                                           '05-dayu-ping-pc-10.127.130.179.txt'
Save-Device 'tcp pc 9101'   'toybox timeout 10 /system/bin/openssl s_client -connect 10.127.130.179:9101 2>&1 < /dev/null' '06-dayu-tcp-pc-9101.txt'
Save-Device 'tcp pc 1883'   'toybox timeout 10 /system/bin/openssl s_client -connect 10.127.130.179:1883 2>&1 < /dev/null' '07-dayu-tcp-pc-1883.txt'
Save-Device 'ps'            "ps -A -o PID,ARGS | grep -E 'eldercare|dayu_local_fall|homemon|wifi|wpa'"            '08-dayu-ps.txt'
Save-Device 'app state'     'ls -l /data/local/tmp/dayu-demo-autostart-2026-10-26/evidence/; echo ---SERVERLOG---; cat /data/local/tmp/dayu-demo-autostart-2026-10-26/evidence/demo-server.log' '09-dayu-app-inference-state.txt'
Save-Device 'camera hilog'  "hilog -x 2>&1 | grep -iE 'CameraModel' | tail -15"                                  '10-dayu-hilog-camera.txt'
Save-Device 'infer hilog'   "hilog -x 2>&1 | grep -iE 'dport:9200' | tail -6"                                    '11-dayu-hilog-inference-9200.txt'
Save-Device 'netstat'       'netstat -tln 2>/dev/null | head -25'                                               '12-dayu-netstat-listen.txt'

Write-Host '--- pc captures ---'
$pc = @(
  @('13-pc-ipconfig-wlan.txt',     'ipconfig /all'),
  @('14-pc-ping-dayu.txt',         'ping -n 4 10.127.130.131'),
  @('15-pc-testnetconnection-9000.txt', 'Test-NetConnection 10.127.130.131 -Port 9000 -InformationLevel Detailed'),
  @('16-pc-arp-dayu.txt',          'arp -a'),
  @('17-pc-firewall-profile.txt',  'Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction | Format-Table -AutoSize'),
  @('18-pc-network-category.txt',  'Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory,Name | Format-Table -AutoSize'),
  @('19-hdc-fport-ls.txt',         'HDCFPORT'),
  @('20-pc-bridge-current-cmdline.txt', 'BRIDGECMD'),
  @('21-pc-sockets-to-dayu.txt',   'SOCKETS')
)
foreach ($p in $pc) {
  $name = $p[0]; $cmd = $p[1]; $out = ''
  switch ($cmd) {
    'HDCFPORT'  { $out = (& $hdc -t $T fport ls 2>&1 | Out-String) }
    'BRIDGECMD' { $out = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'mqtt_bridge' } | ForEach-Object { "PID=$($_.ProcessId) START=$($_.CreationDate)`n$($_.CommandLine)" } | Out-String) }
    'SOCKETS'   { $out = (Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -eq '10.127.130.131' -or $_.LocalAddress -eq '10.127.130.131' } | Format-Table -AutoSize | Out-String) }
    default     { $out = (Invoke-Expression $cmd 2>&1 | Out-String) }
  }
  $hdr = "# cmd: $cmd`n# captured: " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz') + "`n" + ('-' * 70) + "`n"
  ($hdr + $out) | Set-Content -Path (Join-Path $log $name) -Encoding utf8
  Write-Host "[ok] $name"
}

Write-Host '--- bridge status / baseline ---'
$statusPath = 'D:\OpenHarmony\competition\bridge\_test\current-runtime\supervisor\status.json'
if (Test-Path $statusPath) { Get-Content $statusPath -Raw | Set-Content (Join-Path $log '22-bridge-status-json.txt') -Encoding utf8 }
$oldLog = 'D:\OpenHarmony\competition\bridge\_test\current-runtime\supervisor\bridge.out.log'
if (Test-Path $oldLog) {
  (Select-String -Path $oldLog -Pattern '9001' | Select-Object -Last 12 | ForEach-Object { $_.Line }) | Set-Content (Join-Path $log '23-bridge-old-hdc-baseline-9001.txt') -Encoding utf8
}

Write-Host '--- device_config redacted (DHCP + ElderCareLab) ---'
$cfg = (& $hdc -t $T shell 'cat /data/service/el1/public/wifi/device_config.conf' 2>&1 | Out-String) -replace "`r`n", "`n"
$cfg = ($cfg -split "`n" | Where-Object { $_ -notmatch 'encryptedData|IV=|wep|Wep|encry' }) -join "`n"
$hdrc = "# device_config.conf (redacted: encryptedData/IV/wep lines removed; no plaintext credential present in file)`n# captured: " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz') + "`n" + ('-'*70) + "`n"
($hdrc + $cfg) | Set-Content (Join-Path $log '24-fake.txt') -Encoding utf8
# keep only WifiDeviceConfig_2 (ElderCareLab) section
$lines = $cfg -split "`n"
$start = ($lines | Select-String -Pattern 'WifiDeviceConfig_2' -SimpleMatch | Select-Object -First 1).LineNumber
if ($start) {
  $shdr = "# Extract of device_config.conf: WifiDeviceConfig_2 (ElderCareLab), redacted`n# captured: " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz') + "`n" + ('-'*70) + "`n"
  ($shdr + ($lines[($start-1)..($lines.Count-1)] -join "`n")) | Set-Content (Join-Path $log '24-dayu-wifi-device-config-dhcp-redacted.txt') -Encoding utf8
}
Remove-Item (Join-Path $log '24-fake.txt') -ErrorAction SilentlyContinue
Write-Host 'DONE'

