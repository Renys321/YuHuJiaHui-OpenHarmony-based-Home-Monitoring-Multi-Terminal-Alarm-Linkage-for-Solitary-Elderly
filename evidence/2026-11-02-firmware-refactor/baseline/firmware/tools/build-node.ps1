#!/usr/bin/env powershell
<#
build-node.ps1 —— 三块 ESP32-S3 节点的构建/烧录脚本。

  -Node kitchen|bathroom|living   选工程（nodes/<name>）
  -Action build|flash|monitor|menuconfig|clean|fullclean
  -Ssid <ssid>                    首次构建写 Wi-Fi；不带 -Pass 时隐藏输入口令
  -Com COMx                       烧录/监视端口（默认取 .vscode/settings.json）
  -AllowMacMismatch               烧录前 MAC 校验不一致时放行（换板/换口才用）

烧录只写 app 分区，不整片擦除。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('kitchen', 'bathroom', 'living')][string]$Node,
    [ValidateSet('build', 'flash', 'monitor', 'menuconfig', 'clean', 'fullclean')][string]$Action = 'build',
    [string]$Com = '',
    [string]$Ssid = '',
    [string]$Pass = '',
    [switch]$AllowMacMismatch,
    [string]$IdfExport = 'D:\Espressif-5.1.6\frameworks\esp-idf-v5.1.6\export.ps1'
)

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$nodeDir = Join-Path $root $Node
$privDir = Join-Path $root '.local'
$privCfg = Join-Path $privDir "wifi.$Node.defaults"
$defs    = Join-Path $nodeDir 'sdkconfig.defaults'
$build   = Join-Path $nodeDir 'build'

# 已知节点身份：串口号会变，MAC 才是身份（与 docs/NODES.md 一致）
$expectedMac = @{
    kitchen  = '10:51:db:85:d3:e8'
    bathroom = '14:c1:9f:42:dd:b4'
    living   = '30:30:f9:08:76:84'
}

if (-not (Test-Path $nodeDir)) { throw "节点目录不存在: $nodeDir" }
if (-not (Test-Path $defs))    { throw "缺少 sdkconfig.defaults: $defs" }

# 1) 可选：注入 Wi-Fi（只写 .local，不入库；口令可隐藏输入）
if ($Ssid) {
    if (-not $Pass) {
        $sec = Read-Host -AsSecureString "Enter Wi-Fi password for '$Ssid' (hidden, not logged)"
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { $Pass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if (-not $Pass) { throw '未提供 Wi-Fi 口令' }
    New-Item -ItemType Directory -Force -Path $privDir | Out-Null
    $body = "CONFIG_NODE_WIFI_SSID=`"$Ssid`"`r`nCONFIG_NODE_WIFI_PASS=`"$Pass`"`r`n"
    [System.IO.File]::WriteAllText($privCfg, $body, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[wifi] 已写入私有覆盖: $privCfg（不入库）" -ForegroundColor Green
}
$defaultsList = $defs
if (Test-Path $privCfg) { $defaultsList = "$defs;$privCfg" }

# 2) 激活 ESP-IDF（export.ps1 会往 stderr 打警告，PS5.1 在 Stop 下会误报，临时放宽）
if (-not (Test-Path $IdfExport)) { throw "找不到 ESP-IDF 导出脚本: $IdfExport" }
$oldEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { . $IdfExport *> $null } finally { $ErrorActionPreference = $oldEap }

# 3) 串口：优先 -Com，否则读该节点 .vscode/settings.json
if (-not $Com) {
    $vs = Join-Path $nodeDir '.vscode\settings.json'
    if (Test-Path $vs) {
        try { $Com = (Get-Content $vs -Raw -Encoding UTF8 | ConvertFrom-Json).'idf.port' } catch { $Com = '' }
    }
}

$commonArgs = @('-B', $build, '-D', "SDKCONFIG_DEFAULTS=$defaultsList")
Write-Host ("[node] {0}  build={1}  port={2}" -f $Node, $build, $(if ($Com) { $Com } else { '(未指定)' })) -ForegroundColor Cyan

Push-Location $nodeDir
try {
    switch ($Action) {
        'build' {
            & idf.py @commonArgs build
            if ($LASTEXITCODE -ne 0) { throw "构建失败 exit=$LASTEXITCODE" }
            $bin = Get-ChildItem $build -Filter '*_node.bin' -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $bin) { $bin = Get-ChildItem $build -Filter *.bin -ErrorAction SilentlyContinue | Select-Object -First 1 }
            if ($bin) {
                Write-Host ("[ok] {0}  {1} B" -f $bin.Name, $bin.Length) -ForegroundColor Green
                Write-Host ("[ok] SHA256 {0}" -f (Get-FileHash $bin.FullName -Algorithm SHA256).Hash) -ForegroundColor Green
            }
        }
        'flash' {
            if (-not $Com) { throw '烧录需要 -Com COMx（或该节点 .vscode/settings.json 的 idf.port）' }

            Write-Host '[flash] 只读身份核对（chip_id / MAC）...' -ForegroundColor Yellow
            # PS5.1 下直接执行 .py 会走文件关联，stdout 抓不到（lines=0）；必须用 IDF python 显式调用。
            $pyExe = (Get-Command python -ErrorAction SilentlyContinue).Source
            if (-not $pyExe) { throw '未找到 IDF python（export 未生效）' }
            $chipOut = & $pyExe -m esptool --chip esp32s3 -p $Com chip_id 2>&1
            if ($LASTEXITCODE -ne 0) { throw "COM 口不可用或不是 ESP32-S3: $Com" }
            $macLine = ($chipOut | Select-String -Pattern 'MAC:\s*([0-9a-fA-F:]{17})' | Select-Object -Last 1)
            $mac = if ($macLine) { $macLine.Matches[0].Groups[1].Value.ToLowerInvariant() } else { '' }
            Write-Host ("[flash] 芯片 MAC = {0}；期望 {1} = {2}" -f ($(if ($mac) { $mac } else { '未知' })), $Node, $expectedMac[$Node]) -ForegroundColor Cyan
            if (-not $mac) { throw '未能从 chip_id 输出解析 MAC，拒绝烧录' }
            if ($mac -ne $expectedMac[$Node] -and -not $AllowMacMismatch) {
                throw ("MAC 不匹配：接在 {0} 上的不是 {1} 节点（期望 {2}，实际 {3}）。确属换板/换口请加 -AllowMacMismatch。" -f $Com, $Node, $expectedMac[$Node], $mac)
            }

            & idf.py @commonArgs -p $Com flash
            if ($LASTEXITCODE -ne 0) { throw "烧录失败 exit=$LASTEXITCODE" }
            Write-Host '[ok] 烧录完成（只写 app 分区，不整片擦除；NVS 门磁 seq / Wi-Fi 保留）' -ForegroundColor Green
        }
        'monitor' {
            if (-not $Com) { throw '监视需要 -Com COMx' }
            & idf.py @commonArgs -p $Com monitor
        }
        'menuconfig' { & idf.py @commonArgs menuconfig }
        'clean'      { & idf.py @commonArgs clean }
        'fullclean'  { & idf.py @commonArgs fullclean }
    }
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host "提示：本节点可调项见 $Node\sdkconfig.defaults；真实 Wi-Fi 口令在 .local\wifi.$Node.defaults。" -ForegroundColor DarkGray
Write-Host "      改过 sdkconfig.defaults 后如需重新生成配置，先删除 $Node\sdkconfig。" -ForegroundColor DarkGray