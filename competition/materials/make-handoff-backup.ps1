# 生成提交/交接备份（不移动、不删除原项目）
$ErrorActionPreference = 'Stop'
$Dest = 'D:\OpenHarmonyBackup\shouchao-handoff-20261102'
$Root = 'D:\OpenHarmony'
$Competition = Join-Path $Root 'competition'
$App = Join-Path $Root 'APP\ElderlyCareGuardian-v2'

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$dirs = @('source','source\competition','source\app-v2','artifacts','evidence','debug')
foreach ($d in $dirs) { New-Item -ItemType Directory -Force -Path (Join-Path $Dest $d) | Out-Null }

function Copy-Tree([string]$src, [string]$dst, [string[]]$xd) {
    if (-not (Test-Path $src)) { Write-Host "SKIP missing $src"; return }
    $args = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
    if ($xd.Count -gt 0) { $args += '/XD'; $args += $xd }
    & robocopy @args | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "robocopy failed $src -> $dst exit=$LASTEXITCODE" }
}

Write-Host '[*] competition source'
Copy-Tree $Competition (Join-Path $Dest 'source\competition') @(
    'build','node_modules','oh_modules','.venv','__pycache__','.git','logs','.secrets','.work','runtime','evidence','archive','dist','.hvigor'
)

Write-Host '[*] phone app source'
Copy-Tree $App (Join-Path $Dest 'source\app-v2') @(
    'build','oh_modules','node_modules','.git','.hvigor','.idea','logs'
)

Write-Host '[*] evidence'
Copy-Tree (Join-Path $Competition 'evidence') (Join-Path $Dest 'evidence') @()

Write-Host '[*] artifacts'
$copies = @(
    @{ s = Join-Path $Competition 'northbound\signing\dayu-1.0.17-signed.hap'; d = 'dayu-1.0.17-signed.hap' },
    @{ s = Join-Path $App 'entry\build\default\outputs\default\entry-default-unsigned.hap'; d = 'phone-eldercare-production-unsigned.hap' },
    @{ s = Join-Path $Competition 'firmware\kitchen\build\esp32_elder_node.bin'; d = 'kitchen-esp32_elder_node.bin' },
    @{ s = Join-Path $Competition 'firmware\bathroom\build\esp32_elder_node.bin'; d = 'bathroom-esp32_elder_node.bin' },
    @{ s = Join-Path $Competition 'eldercare-public-deploy.tar.gz'; d = 'eldercare-public-deploy.tar.gz' },
    @{ s = Join-Path $Competition 'materials\讲解PPT.pptx'; d = '讲解PPT.pptx' },
    @{ s = Join-Path $Competition 'materials\设计方案.docx'; d = '设计方案.docx' }
)
foreach ($c in $copies) {
    if (Test-Path $c.s) {
        Copy-Item $c.s (Join-Path $Dest ('artifacts\' + $c.d)) -Force
        Write-Host "  + $($c.d)"
    } else { Write-Host "  ! missing $($c.s)" }
}

Write-Host '[*] logs for debugging (selected)'
$debugFiles = @(
    @{ s = Join-Path $Competition 'voice-gateway\gateway.out.log'; d = 'gateway.out.log' },
    @{ s = Join-Path $Competition 'logs\stability-report.log'; d = 'stability-report.log' },
    @{ s = Join-Path $Competition 'logs\voice-chain-report.log'; d = 'voice-chain-report.log' }
)
foreach ($f in $debugFiles) {
    if (Test-Path $f.s) { Copy-Item $f.s (Join-Path $Dest ('debug\' + $f.d)) -Force }
}

Write-Host '[*] metadata'
$meta = @()
$meta += "backup: $(Get-Date -Format o)"
$meta += "source: $Competition"
$meta += "app: $App"
$meta += "note: 不包含 build/node_modules/.venv/.secrets/logs/evidence(单独目录)"
$meta += "dayu: 1.0.17 signed"
$meta += "phone: unsigned HAP"
$meta | Set-Content (Join-Path $Dest 'BACKUP-META.txt') -Encoding UTF8

Write-Host '[*] checksums'
Get-ChildItem (Join-Path $Dest 'artifacts') -File | ForEach-Object {
    $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    "$h  artifacts/$($_.Name)"
} | Set-Content (Join-Path $Dest 'SHA256SUMS.txt') -Encoding ASCII

Write-Host "[OK] $Dest"
