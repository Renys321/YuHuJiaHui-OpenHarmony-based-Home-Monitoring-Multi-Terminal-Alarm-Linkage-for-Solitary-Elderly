# Offline verification for P0 backup ZIPs (read-only, no business services started).
# Prints no secret values: only path / hit type / excluded decision.
param(
    [string]$BackupRoot = 'D:\OpenHarmony\competition\evidence\2026-10-24-p0-final-demo-backup'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$work = Join-Path $BackupRoot '_work\verify'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work -Force | Out-Null
$zips = @{
    demo   = Join-Path $BackupRoot 'OpenHarmony-P0-DEMO-DELIVERY-2026-10-24.zip'
    source = Join-Path $BackupRoot 'OpenHarmony-P0-SOURCE-EVIDENCE-2026-10-24.zip'
}
$report = [ordered]@{}
foreach ($name in $zips.Keys) {
    $zipPath = $zips[$name]
    $dest = Join-Path $work $name
    $r = [ordered]@{ zip = $zipPath; dest = $dest }
    # 1. extract
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $dest)
    $r.extract = 'OK'
    # 2. path traversal check
    $za = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    $bad = @()
    foreach ($e in $za.Entries) {
        $n = $e.FullName
        if ($n -match '(^/|^\\|^[A-Za-z]:)' -or $n -match '(^|/)\.\.(/|$)') { $bad += $n }
    }
    $r.entryCount = $za.Entries.Count
    $r.entries = @($za.Entries | ForEach-Object { $_.FullName })
    $r.uncompressed = ($za.Entries | Measure-Object -Property Length -Sum).Sum
    $za.Dispose()
    $r.pathTraversal = if ($bad.Count -eq 0) { 'OK' } else { 'FAIL: ' + ($bad -join ',') }
    # 3. SHA256SUMS verification
    $sums = Join-Path $dest 'SHA256SUMS.txt'
    $lines = Get-Content $sums | Where-Object { $_.Trim().Length -gt 0 }
    $mismatch = @(); $checked = 0
    foreach ($line in $lines) {
        if ($line -notmatch '^([0-9a-fA-F]{64})\s\s(.+)$') { $mismatch += "badline:$line"; continue }
        $want = $Matches[1].ToUpperInvariant(); $rel = $Matches[2]
        $full = Join-Path $dest ($rel -replace '/', '\')
        if (-not (Test-Path $full)) { $mismatch += "missing:$rel"; continue }
        $got = (Get-FileHash $full -Algorithm SHA256).Hash
        $checked++
        if ($got -ne $want) { $mismatch += "mismatch:$rel" }
    }
    $r.sumsChecked = $checked
    $r.sumsLines = $lines.Count
    $r.sums = if ($mismatch.Count -eq 0) { 'OK' } else { 'FAIL: ' + ($mismatch -join ';') }
    # 4. HAP checks
    $hap = @{}
    $cur = Get-ChildItem $dest -Recurse -File -Filter 'guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap' |
        Select-Object -First 1
    $fb = Get-ChildItem $dest -Recurse -File -Filter 'guardian-inline-summary-formal.hap' | Select-Object -First 1
    $hap.current = if ($cur) { (Get-FileHash $cur.FullName -Algorithm SHA256).Hash } else { 'MISSING' }
    $hap.fallback = if ($fb) { (Get-FileHash $fb.FullName -Algorithm SHA256).Hash } else { 'MISSING' }
    $r.haps = $hap
    # 5. required formal entry/supervisor/worker
    $need = @('public-sync-supervisor.js', 'public-sync-worker.js', 'start-demo-supervisor.cmd', 'start-demo-supervisor.ps1')
    $found = @{}
    foreach ($n in $need) {
        $found[$n] = [bool](Get-ChildItem $dest -Recurse -File -Filter $n | Select-Object -First 1)
    }
    $r.requiredFiles = $found
    # 6. markdown relative link resolution
    $missing = @(); $totalLinks = 0
    foreach ($md in (Get-ChildItem $dest -Recurse -File -Filter '*.md')) {
        $text = Get-Content $md.FullName -Raw
        foreach ($m in [regex]::Matches($text, '\]\(([^)\s]+)\)')) {
            $t = $m.Groups[1].Value
            if ($t -match '^(https?:|mailto:|#)') { continue }
            $t = ($t -split '#')[0]
            if ($t.Length -eq 0) { continue }
            $totalLinks++
            $cand1 = Join-Path (Split-Path $md.FullName -Parent) ($t -replace '/', '\')
            $cand2 = Join-Path $dest ($t -replace '/', '\')
            if (-not (Test-Path $cand1) -and -not (Test-Path $cand2)) {
                $rel = $md.FullName.Substring($dest.Length).TrimStart('\')
                $missing += "$rel -> $t"
            }
        }
    }
    $r.linksTotal = $totalLinks
    $r.linksMissing = $missing
    # 7. syntax checks
    $psErrors = @(); $psCount = 0; $psEncodings = @()
    foreach ($p in (Get-ChildItem $dest -Recurse -File -Filter '*.ps1')) {
        $psCount++
        $raw = [System.IO.File]::ReadAllBytes($p.FullName)
        $hasBom = ($raw.Length -ge 3 -and $raw[0] -eq 239 -and $raw[1] -eq 187 -and $raw[2] -eq 191)
        $ok = $false; $enc = ''
        $e = $null; $t = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($p.FullName, [ref]$t, [ref]$e)
        if (-not ($e -and $e.Count -gt 0)) { $ok = $true; $enc = if ($hasBom) { 'utf8-bom(default)' } else { 'default' } }
        else {
            foreach ($cand in @(@{ n = 'utf8'; t = [System.Text.Encoding]::UTF8 }, @{ n = 'gbk'; t = [System.Text.Encoding]::GetEncoding(936) })) {
                $txt = $cand.t.GetString($raw)
                $e2 = $null; $t2 = $null
                [void][System.Management.Automation.Language.Parser]::ParseInput($txt, [ref]$t2, [ref]$e2)
                if (-not ($e2 -and $e2.Count -gt 0)) { $ok = $true; $enc = $cand.n; break }
            }
        }
        if ($ok) { $psEncodings += "$($p.Name)=$enc" } else { $psErrors += "$($p.Name): parse failed under default/utf8/gbk" }
    }
    $r.ps1Checked = $psCount
    $r.ps1Errors = $psErrors
    $r.ps1Encodings = $psEncodings
    $nodeErrors = @(); $nodeCount = 0
    foreach ($j in (Get-ChildItem $dest -Recurse -File -Filter '*.js')) {
        $nodeCount++
        $out = & 'D:\Node\node.exe' --check $j.FullName 2>&1
        if ($LASTEXITCODE -ne 0) { $nodeErrors += "$($j.Name): $($out -join ' ')" }
    }
    $r.jsChecked = $nodeCount
    $r.jsErrors = $nodeErrors
    # 8. secret scan (value-level only; never print matched values)
    $patterns = @(
        @{ n = 'env_ingest_key_assignment'; r = '(?i)(INGEST_KEY|BACKEND_INGEST_KEY)\s*=\s*["''][^"''\r\n]{12,}' },
        @{ n = 'authorization_bearer_literal'; r = '(?i)Authorization\s*:\s*["'']Bearer\s+[A-Za-z0-9._\-]{20,}' },
        @{ n = 'bearer_long_literal'; r = '(?i)\bBearer\s+[A-Za-z0-9._\-]{40,}' },
        @{ n = 'cookie_literal'; r = '(?i)Cookie\s*:\s*["''][^"''\r\n]{12,}' },
        @{ n = 'session_token_literal'; r = '(?i)sessionToken\s*[:=]\s*["''][A-Za-z0-9._\-]{20,}' },
        @{ n = 'app_secret_literal'; r = '(?i)(AppSecret|APP_SECRET)\s*=\s*["''][^"''\r\n]{8,}' },
        @{ n = 'private_key_block'; r = '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
        @{ n = 'wifi_password_literal'; r = '(?i)(wifi|WIFI)[^\r\n]{0,40}(password|passwd|pwd)\s*[:=]\s*["''][^"''\r\n]{6,}' }
    )
    $textExt = @('.txt', '.md', '.log', '.json', '.js', '.ts', '.ets', '.ps1', '.cmd', '.json5', '.yml', '.yaml', '.ini', '.conf', '.properties', '.css', '.html')
    $hits = @(); $scanned = 0; $excluded = @()
    foreach ($f in (Get-ChildItem $dest -Recurse -File)) {
        if ($f.Extension.ToLowerInvariant() -notin $textExt) { continue }
        $scanned++
        $text = [System.IO.File]::ReadAllText($f.FullName)
        foreach ($p in $patterns) {
            if ($text -match $p.r) {
                $rel = $f.FullName.Substring($dest.Length).TrimStart('\')
                $hits += "$rel | $($p.n) | excluded=yes"
                $excluded += $rel
                break
            }
        }
        if ($f.Name -match '^\.env' -or $f.Name -match '^id_rsa' -or $f.Extension -match '^\.(p12|pfx|keystore|jks|pem)$') {
            $rel = $f.FullName.Substring($dest.Length).TrimStart('\')
            $hits += "$rel | sensitive_filename | excluded=yes"
            $excluded += $rel
        }
    }
    $r.secretScanned = $scanned
    $r.secretHits = $hits
    $report[$name] = $r
}
$report | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $work 'verify-result.json') -Encoding UTF8
foreach ($name in $report.Keys) {
    $r = $report[$name]
    "=== $name ==="
    "zip=$($r.zip)"
    "extract=$($r.extract) entryCount=$($r.entryCount) uncompressed=$($r.uncompressed)"
    "pathTraversal=$($r.pathTraversal)"
    "sums=$($r.sums) checked=$($r.sumsChecked)/$($r.sumsLines)"
    "hap.current=$($r.haps.current)"
    "hap.fallback=$($r.haps.fallback)"
    "required=" + (($r.requiredFiles.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', ')
    "linksTotal=$($r.linksTotal) linksMissing=$($r.linksMissing.Count)"
    $r.linksMissing | ForEach-Object { "  missing: $_" }
    "ps1Checked=$($r.ps1Checked) errors=$($r.ps1Errors.Count) encodings=" + (($r.ps1Encodings) -join '; ')
    $r.ps1Errors | ForEach-Object { "  ps1err: $_" }
    "jsChecked=$($r.jsChecked) errors=$($r.jsErrors.Count)"
    $r.jsErrors | ForEach-Object { "  jserr: $_" }
    "secretScanned=$($r.secretScanned) hits=$($r.secretHits.Count)"
    $r.secretHits | ForEach-Object { "  sechit: $_" }
    ""
}
