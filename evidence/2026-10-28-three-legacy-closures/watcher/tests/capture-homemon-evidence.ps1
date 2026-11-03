# capture-homemon-evidence.ps1 — 只读采集 homemon 部署态 vs 源码态证据（2026-10-28）
$ErrorActionPreference = 'Stop'
$ev = 'D:\OpenHarmony\competition\evidence\2026-10-28-three-legacy-closures\watcher'
$log = Join-Path $ev ('logs/10-homemon-deployed-vs-source-' + (Get-Date -Format 'HHmmss') + '.log')
$hdc = 'D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$t = '450100445634303332012847942eca00'
$L = New-Object System.Collections.Generic.List[string]
$L.Add('# homemon deployed vs source (' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ', read-only)')
$L.Add('## board deployed homemon startup log (still 4 clients)')
$L.Add((((& $hdc -t $t shell 'head -n 6 /data/homemon/homemon.stdout' 2>&1) | Select-Object -First 6) -join "`n"))
$L.Add('## board homemon process')
$L.Add((((& $hdc -t $t shell 'ps -ef' 2>&1) | Select-String -Pattern 'homemon' | ForEach-Object { $_.Line }) -join "`n"))
$L.Add('## board homemon sha256 (compare with P0 entry frozen hash f6f4497c...)')
$L.Add((((& $hdc -t $t shell 'sha256sum /data/homemon/homemon' 2>&1) -join "`n")))
$src = 'D:\OpenHarmony\competition\southbound\src\homemon.c'
$L.Add('## source state (Lead source fix: MAX_CLIENTS 4->8 + TCP keepalive)')
$L.Add(('  file: {0}  mtime={1}  sha256={2}' -f $src, (Get-Item $src).LastWriteTime, (Get-FileHash $src -Algorithm SHA256).Hash.ToLowerInvariant()))
$L.Add(((Get-Content $src | Select-String -Pattern 'MAX_CLIENTS|SO_KEEPALIVE|TCP_KEEPIDLE|TCP_KEEPINTVL|TCP_KEEPCNT' | Select-Object -First 14 | ForEach-Object { ('homemon.c:{0}: {1}' -f $_.LineNumber, $_.Line.Trim()) }) -join "`n"))
$L.Add('## board port 9000 connections (PC .179 zombie ESTABLISHED + local loopback clients; new SYN_RECV)')
$L.Add((((& $hdc -t $t shell 'netstat -lntp' 2>&1) | Select-String -Pattern ':9000\s') -join "`n"))
$L.Add('## PC side processes for the zombie local ports (expected empty = old bridge/mirror exited)')
$L.Add(((& netstat.exe -ano 2>&1 | Select-String -Pattern ':55852\s|:55853\s|:57067\s') -join "`n"))
$L.Add('## conclusion')
$L.Add('- deployed homemon (started 00:17:36) still logs "max 4 clients": old binary with MAX_CLIENTS=4')
$L.Add('- 3 stale PC connections hold slots; board Send-Q grows ~988B/3s => homemon keeps broadcasting to dead sockets')
$L.Add('- new connections (bridge status/relay, mirror relay) queue/are closed => dayu200-living 202 stop, mirror relay flap')
$L.Add('- source already has 8 clients + keepalive fix, but arm32 binary must be rebuilt/replaced and homemon restarted')
$L.Add('- after replacement, P0 entry $HomemonSha must be updated (currently f6f4497c...)')
$txt = ($L -join "`n")
[System.IO.File]::WriteAllText($log, $txt, (New-Object System.Text.UTF8Encoding($false)))
Write-Output $txt
Write-Output ('SAVED=' + $log)
