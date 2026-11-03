# 模拟器（手机 APP 验收环境）UI 自动化辅助函数
# 用法：. .\emu-ui.ps1  然后调用 Save-EmuShot / Get-EmuLayoutText / Find-TextCenter / Tap-Emu
$ErrorActionPreference = 'Stop'
$script:HDC = 'D:\OpenHarmony\tools\hdc\hdc.exe'
$script:EMU = '127.0.0.1:5555'

function Invoke-HdcEmu([string[]]$Args) {
  & $script:HDC -t $script:EMU @Args
}

function Save-EmuShot([string]$Path) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $remote = '/data/local/tmp/emu-shot-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.jpeg'
  Invoke-HdcEmu @('shell', "snapshot_display -f $remote") | Out-Null
  Invoke-HdcEmu @('file', 'recv', $remote, $Path) | Out-Null
  Invoke-HdcEmu @('shell', "rm -f $remote") | Out-Null
  return (Get-Item $Path).Length
}

function Get-EmuLayoutText([string]$OutFile = '') {
  $remote = '/data/local/tmp/emu-layout.json'
  Invoke-HdcEmu @('shell', "uitest dumpLayout -p $remote") | Out-Null
  $target = if ($OutFile) { $OutFile } else { Join-Path $env:TEMP ('emu-layout-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json') }
  Invoke-HdcEmu @('file', 'recv', $remote, $target) | Out-Null
  return (Get-Content $target -Raw -Encoding UTF8)
}

# 在 layout JSON 文本中按 text/originalText 精确匹配，返回 bounds 中心坐标（真实像素）
function Find-TextCenter([string]$LayoutRaw, [string]$Text) {
  $escaped = [regex]::Escape($Text)
  $pattern = '"bounds":"\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^{}]*?"(?:originalText|text)":"' + $escaped + '"'
  $m = [regex]::Match($LayoutRaw, $pattern)
  if (-not $m.Success) { return $null }
  $x1 = [int]$m.Groups[1].Value; $y1 = [int]$m.Groups[2].Value
  $x2 = [int]$m.Groups[3].Value; $y2 = [int]$m.Groups[4].Value
  return [pscustomobject]@{ X = [int](($x1 + $x2) / 2); Y = [int](($y1 + $y2) / 2); Bounds = $m.Value }
}

function Tap-Emu([int]$X, [int]$Y) {
  Invoke-HdcEmu @('shell', "uitest uiInput click $X $Y") | Out-Null
}

function Back-Emu() {
  Invoke-HdcEmu @('shell', 'uitest uiInput key CR') | Out-Null
}

function Start-EmuApp([string]$Bundle = 'com.example.program_04', [string]$Ability = 'EntryAbility') {
  Invoke-HdcEmu @('shell', "aa start -a $Ability -b $Bundle") | Out-Null
}

function Get-EmuAppVersion([string]$Bundle = 'com.example.program_04') {
  $dump = Invoke-HdcEmu @('shell', "bm dump -n $Bundle") | Out-String
  $m = [regex]::Match($dump, '"versionName": "([^"]+)"')
  return if ($m.Success) { $m.Groups[1].Value } else { '' }
}
