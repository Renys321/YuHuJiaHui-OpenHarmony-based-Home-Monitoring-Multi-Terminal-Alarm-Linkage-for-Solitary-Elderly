param(
  [Parameter(Mandatory=$true)][string]$Name,
  [int]$SwipeUp = 0,
  [int]$SwipeDown = 0,
  [int]$Back = 0,
  [string]$Tap = "",
  [string]$Extra = "",
  [switch]$NoShot
)
$hdc='D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$base='D:\OpenHarmony\competition\evidence\2026-10-27-real-capability-app\baseline'
$cmds = @()
for($i=0;$i -lt $SwipeUp;$i++){ $cmds += 'uitest uiInput swipe 640 900 640 2500 300' }
for($i=0;$i -lt $SwipeDown;$i++){ $cmds += 'uitest uiInput swipe 640 2500 640 900 300' }
for($i=0;$i -lt $Back;$i++){ $cmds += 'uitest uiInput keyEvent Back' }
if($Tap -ne ''){ $cmds += "uitest uiInput click $Tap" }
if($Extra -ne ''){ $cmds += $Extra }
$cmds += 'snapshot_display -f /data/local/tmp/snap.jpeg'
$cmds += 'uitest dumpLayout -p /data/local/tmp/lay.json'
$shell = $cmds -join '; '
& $hdc -t 127.0.0.1:5555 shell $shell | Out-Null
& $hdc -t 127.0.0.1:5555 file recv /data/local/tmp/lay.json "$base\layout\$Name.json" | Out-Null
if(-not $NoShot){ & $hdc -t 127.0.0.1:5555 file recv /data/local/tmp/snap.jpeg "$base\screenshots\$Name.jpeg" | Out-Null }
Write-Output "captured $Name"
