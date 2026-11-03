# LOCAL-ALARM-VOICE-CLOSURE: read-only device identity check + private app-partition backup.
# ASCII-only for Windows PowerShell 5.1. Does NOT write flash.
param(
    [Parameter(Mandatory = $true)][string]$Com,
    [Parameter(Mandatory = $true)][string]$ExpectedMac,
    [Parameter(Mandatory = $true)][string]$ExpectedAppSha256,
    [Parameter(Mandatory = $true)][long]$ExpectedAppSize,
    [Parameter(Mandatory = $true)][string]$PrivateDir,
    [Parameter(Mandatory = $true)][string]$OutJson,
    [string]$IdfRoot = 'D:\Espressif-5.1.6',
    [int]$Baud = 460800,
    [long]$FlashOffset = 0x10000
)
$ErrorActionPreference = 'Stop'
$python = Join-Path $IdfRoot 'python_env\idf5.1_py3.11_env\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "missing python: $python" }
if (-not (Test-Path -LiteralPath $PrivateDir)) { New-Item -ItemType Directory -Path $PrivateDir -Force | Out-Null }
$backup = Join-Path $PrivateDir ("$Com-app-before-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bin')

function Run-Esptool([string[]]$Extra, [int]$B) {
    $all = @('-m', 'esptool', '--port', $Com, '--baud', $B) + $Extra
    $out = & $python @all 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Output = ($out -join "`n"); Exit = $code }
}

# 1) Chip + MAC identity (read-only; esptool resets the board into download mode).
$chip = Run-Esptool @('chip_id') 115200
if ($chip.Exit -ne 0) { throw "chip_id failed on $Com : $($chip.Output)" }
$macMatch = [regex]::Match($chip.Output, 'MAC:\s*([0-9a-fA-F:]{17})')
if (-not $macMatch.Success) { throw "cannot parse MAC from chip_id on $Com" }
$mac = $macMatch.Groups[1].Value.ToLowerInvariant()
$chipLine = ([regex]::Match($chip.Output, 'Chip is[^\r\n]*')).Value
if ($mac -ne $ExpectedMac.ToLowerInvariant()) {
    throw "IDENTITY MISMATCH on $Com : got MAC $mac, expected $ExpectedMac. Refusing to continue."
}

# 2) Read current app partition into the private backup directory (never into evidence/).
$read = Run-Esptool @('read_flash', ('0x{0:x}' -f $FlashOffset), $ExpectedAppSize.ToString(), $backup) $Baud
if ($read.Exit -ne 0) { throw "read_flash failed on $Com : $($read.Output)" }
if (-not (Test-Path -LiteralPath $backup)) { throw "backup file missing: $backup" }
$readSize = (Get-Item -LiteralPath $backup).Length
$readHash = (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash
$matchesExpected = ($readHash -eq $ExpectedAppSha256.ToUpperInvariant())

# 3) Record sanitized identity evidence (no Wi-Fi credentials are read or written here).
$result = [ordered]@{
    recordedAt = (Get-Date).ToString('o')
    com = $Com
    chip = $chipLine.Trim()
    mac = $mac
    expectedMac = $ExpectedMac.ToLowerInvariant()
    macMatches = ($mac -eq $ExpectedMac.ToLowerInvariant())
    appFlashOffset = ('0x{0:x}' -f $FlashOffset)
    expectedAppSize = $ExpectedAppSize
    backupPathPrivate = $backup
    backupReadSize = $readSize
    backupSha256 = $readHash
    expectedDeployedAppSha256 = $ExpectedAppSha256.ToUpperInvariant()
    currentFirmwareMatchesExpectedDeployed = $matchesExpected
    writeAuthorized = $false
    note = 'Read-only identity/version check and private app-partition backup. No flash write performed.'
}
$jsonText = ($result | ConvertTo-Json -Depth 4)
[System.IO.File]::WriteAllText($OutJson, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("IDENTITY_OK com=$Com mac=$mac chipOK=$($chipLine.Length -gt 0) backup=$backup backupSha256=$readHash currentMatchesDeployed=$matchesExpected")
if (-not $matchesExpected) {
    Write-Warning "Current app partition hash differs from the previously deployed known firmware. Do not assume board version."
}
