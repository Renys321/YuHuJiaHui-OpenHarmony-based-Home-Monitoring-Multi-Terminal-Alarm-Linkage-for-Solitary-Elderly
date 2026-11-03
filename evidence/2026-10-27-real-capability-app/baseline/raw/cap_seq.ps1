param(
  [Parameter(Mandatory=$true)][string]$Prefix,
  [int]$Steps = 1,
  [string]$Dir = "up",
  [int]$Start = 1,
  [switch]$NoShot
)
$hdc='D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$base='D:\OpenHarmony\competition\evidence\2026-10-27-real-capability-app\baseline'
$sw = if($Dir -eq 'up'){'uitest uiInput swipe 640 900 640 2500 300'}else{'uitest uiInput swipe 640 2400 640 900 300'}
$names = @()
for($s=0;$s -lt $Steps;$s++){
  $i = $Start + $s
  $n = ("{0}_{1:d2}" -f $Prefix,$i)
  $cmds = @($sw, "snapshot_display -f /data/local/tmp/s.jpeg", "uitest dumpLayout -p /data/local/tmp/l.json")
  & $hdc -t 127.0.0.1:5555 shell ($cmds -join '; ') | Out-Null
  & $hdc -t 127.0.0.1:5555 file recv /data/local/tmp/l.json "$base\layout\$n.json" | Out-Null
  if(-not $NoShot){ & $hdc -t 127.0.0.1:5555 file recv /data/local/tmp/s.jpeg "$base\screenshots\$n.jpeg" | Out-Null }
  $names += $n
  Write-Output "step $n"
}
Write-Output ("done: " + ($names -join ', '))
