<#
.SYNOPSIS
  Recursively SHA256-hash an evidence directory into a sorted SHA256SUMS.txt.

.DESCRIPTION
  Produces lines in the canonical sha256sum format, sorted by relative path:

      <64-hex-lowercase-hash>  <relative/path/with/forward/slashes>

  Every regular file under -Root is included (hidden files too; nothing is excluded
  by policy -- private backups live outside the evidence dir).  The only implicit
  exclusion is the output file itself when it is located inside -Root, so repeated
  runs stay stable.

  -Verify recomputes hashes from an existing SHA256SUMS file and reports missing,
  extra, changed and format-invalid entries; exit 1 on any mismatch.

  Files that are locked because another bench/build job is still appending are opened with
  ReadWrite sharing (read-only for us) and retried (-Retries 5 x 400ms); a file still
  growing is hashed at its current bytes.  If a file cannot be read at all, no manifest is
  written and the script exits 3.  For a stable FINAL manifest, run it after build/flash
  jobs are quiet and then run -Verify.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/hash-evidence.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/hash-evidence.ps1 -Root D:\OpenHarmony\competition\evidence\2026-10-26-local-alarm-voice-closure

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/hash-evidence.ps1 -Verify
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$OutFile = '',
    [ValidateRange(0, 20)]
    [int]$Retries = 5,
    [ValidateRange(50, 5000)]
    [int]$RetryDelayMs = 400,
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $scriptDir }
if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    [Console]::Error.WriteLine("ERROR: -Root not found: $Root")
    exit 2
}
$rootFull = [System.IO.Path]::GetFullPath($Root)
if (-not $OutFile) { $OutFile = Join-Path $rootFull 'SHA256SUMS.txt' }
$outFull = [System.IO.Path]::GetFullPath($OutFile)
$outDir = Split-Path -Parent $outFull
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

function Get-RelativePosixPath([string]$fullPath) {
    # .NET Framework (Windows PowerShell 5.1) has no Path.GetRelativePath; strip the
    # resolved root prefix instead.  Case-insensitive because this is Windows.
    $base = $rootFull
    if (-not $base.EndsWith('\')) { $base += '\' }
    if (-not $fullPath.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "file is outside root: $fullPath"
    }
    return ($fullPath.Substring($base.Length) -replace '\\', '/')
}

function Get-Sha256Hex([string]$fullPath) {
    # Evidence can be hashed while another bench/build job is still appending a log.
    # Open sharing ReadWrite so an existing writer is not blocked/blocking; retry transient
    # failures.  A file that is still growing is hashed at its current bytes (snapshot).
    $last = $null
    for ($attempt = 1; $attempt -le ($Retries + 1); $attempt++) {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $stream = $null
        try {
            $stream = New-Object -TypeName System.IO.FileStream -ArgumentList @(
                $fullPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite)
            $hash = $sha.ComputeHash($stream)
            return ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
        } catch {
            $last = $_
            if ($attempt -le $Retries) {
                Write-Warning ("retry {0}/{1} {2}: {3}" -f $attempt, $Retries, $fullPath, $_.Exception.Message)
                Start-Sleep -Milliseconds $RetryDelayMs
            }
        } finally {
            if ($stream) { $stream.Dispose() }
            $sha.Dispose()
        }
    }
    throw $last
}

if ($Verify) {
    if (-not (Test-Path -LiteralPath $outFull -PathType Leaf)) {
        [Console]::Error.WriteLine("ERROR: SHA256SUMS file not found: $outFull")
        exit 2
    }
    $entries = @{}
    $badFormat = 0
    $lineNo = 0
    foreach ($line in [System.IO.File]::ReadAllLines($outFull, [System.Text.Encoding]::UTF8)) {
        $lineNo++
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([0-9a-f]{64})  (.+)$') {
            Write-Warning ("line {0}: bad format: {1}" -f $lineNo, $line)
            $badFormat++
            continue
        }
        $entries[$Matches[2]] = $Matches[1]
    }
    $mismatch = 0
    $missing = 0
    $present = @{}
    foreach ($file in Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force | Sort-Object FullName) {
        if ($file.FullName -eq $outFull) { continue }
        $rel = Get-RelativePosixPath $file.FullName
        $present[$rel] = $true
        if (-not $entries.ContainsKey($rel)) {
            Write-Warning ("MISSING-FROM-SUMS {0}" -f $rel)
            $missing++
            continue
        }
        $actual = Get-Sha256Hex $file.FullName
        if ($actual -ne $entries[$rel]) {
            Write-Warning ("HASH-MISMATCH {0} expected={1} actual={2}" -f $rel, $entries[$rel], $actual)
            $mismatch++
        }
    }
    $extra = 0
    foreach ($rel in $entries.Keys) {
        if (-not $present.ContainsKey($rel)) {
            Write-Warning ("EXTRA-IN-SUMS {0}" -f $rel)
            $extra++
        }
    }
    $ok = ($mismatch -eq 0 -and $missing -eq 0 -and $extra -eq 0 -and $badFormat -eq 0)
    $verdict = if ($ok) { 'OK' } else { 'FAIL' }
    Write-Host ("HASH_VERIFY {0} entries={1} files={2} mismatch={3} missing={4} extra={5} badFormat={6} file={7}" -f `
            $verdict, $entries.Count, $present.Count, $mismatch, $missing, $extra, $badFormat, $outFull)
    if (-not $ok) { exit 1 }
    exit 0
}

$files = @(Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force |
        Where-Object { $_.FullName -ne $outFull } |
        Sort-Object FullName)
if ($files.Count -eq 0) {
    [Console]::Error.WriteLine("ERROR: no files found under $rootFull")
    exit 1
}

$entriesOut = New-Object 'System.Collections.Generic.SortedDictionary[string,object]' -ArgumentList ([System.StringComparer]::Ordinal)
$totalBytes = 0L
$started = Get-Date
$failures = New-Object System.Collections.Generic.List[string]
foreach ($file in $files) {
    $rel = Get-RelativePosixPath $file.FullName
    try {
        $hash = Get-Sha256Hex $file.FullName
    } catch {
        $failures.Add(('{0}: {1}' -f $rel, $_.Exception.Message))
        continue
    }
    # Ordinal-sorted dictionary => byte/code-point ordering, reproducible across runs and hosts
    $entriesOut.Add($rel, [pscustomobject]@{ Rel = $rel; Hash = $hash })
    $totalBytes += $file.Length
}
if ($failures.Count -gt 0) {
    [Console]::Error.WriteLine(("HASH_FAIL files={0} unreadable={1} (no SHA256SUMS.txt written; a build/flash job is probably still writing -- re-run when quiet)" -f $files.Count, $failures.Count))
    foreach ($f in $failures) { [Console]::Error.WriteLine("  LOCKED " + $f) }
    exit 3
}
$text = (($entriesOut.Values | ForEach-Object { '{0}  {1}' -f $_.Hash, $_.Rel }) -join "`n") + "`n"
[System.IO.File]::WriteAllText($outFull, $text, (New-Object System.Text.UTF8Encoding($false)))
$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
Write-Host ("HASH_OK files={0} bytes={1} elapsed={2}s file={3}" -f $files.Count, $totalBytes, $elapsed, $outFull)
exit 0
