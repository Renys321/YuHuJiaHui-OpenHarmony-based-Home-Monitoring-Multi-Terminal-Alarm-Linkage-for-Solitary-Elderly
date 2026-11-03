param(
    [string]$Base = 'C:\Users\<user>\AppData\Local\Temp\shouchao-polish\baseline',
    [string]$Root = 'D:\OpenHarmony\competition'
)
$ErrorActionPreference = 'Stop'
$work = 'C:\Users\<user>\AppData\Local\Temp\shouchao-polish'
$node = 'D:\Node\node.exe'
$jsCmp = Join-Path $work 'compare-js-tokens.js'
$psCmp = Join-Path $work 'compare-ps-tokens.ps1'

$changed = New-Object System.Collections.Generic.List[string]
$sourceExts = @('.c', '.h', '.js', '.ets', '.ts', '.ps1')
Get-ChildItem -LiteralPath $Base -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($Base.Length + 1)
    if ($sourceExts -notcontains [IO.Path]::GetExtension($rel).ToLowerInvariant()) { return }
    if ($rel -like 'bridge\_test\*') { return }
    $cur = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $cur)) {
        $changed.Add("MISSING`t$rel")
        return
    }
    $h1 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    $h2 = (Get-FileHash -LiteralPath $cur -Algorithm SHA256).Hash
    if ($h1 -ne $h2) { $changed.Add($rel) }
}

Write-Output ("CHANGED {0}" -f $changed.Count)
$fail = 0
foreach ($item in $changed) {
    if ($item.StartsWith('MISSING')) { Write-Output $item; $fail++; continue }
    $rel = $item
    $old = Join-Path $Base $rel
    $new = Join-Path $Root $rel
    $ext = [IO.Path]::GetExtension($rel).ToLowerInvariant()
    $result = ''
    if ($ext -eq '.ps1') {
        $result = (& powershell -NoProfile -ExecutionPolicy Bypass -File $psCmp -Old $old -New $new 2>&1) -join ' '
    } elseif ($ext -eq '.js' -or $ext -eq '.ets' -or $ext -eq '.ts') {
        $result = (& $node $jsCmp $old $new 2>&1) -join ' '
    } else {
        $result = 'SKIP_BINARY_CHECK'
    }
    if ($result -match 'TOKENS_MATCH|SKIP_BINARY_CHECK') {
        Write-Output ("OK`t{0}`t{1}" -f $rel, $result)
    } else {
        Write-Output ("DIFF`t{0}`t{1}" -f $rel, $result)
        $fail++
    }
}
Write-Output ("RESULT changed={0} token_fail={1}" -f $changed.Count, $fail)
if ($fail -gt 0) { exit 1 } else { exit 0 }
