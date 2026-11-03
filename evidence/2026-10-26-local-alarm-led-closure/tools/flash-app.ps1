# LOCAL-ALARM-VOICE-CLOSURE: flash ONLY the app partition (0x10000) after re-verifying MAC.
# ASCII-only for Windows PowerShell 5.1. No full-chip erase, no bootloader/NVS/partition writes,
# no Wi-Fi or device-identity changes.
param(
    [Parameter(Mandatory = $true)][string]$Com,
    [Parameter(Mandatory = $true)][string]$ExpectedMac,
    [Parameter(Mandatory = $true)][string]$Bin,
    [Parameter(Mandatory = $true)][string]$OutJson,
    [string]$IdfRoot = 'D:\Espressif-5.1.6',
    [int]$Baud = 460800,
    [long]$FlashOffset = 0x10000
)
$ErrorActionPreference = 'Stop'
$python = Join-Path $IdfRoot 'python_env\idf5.1_py3.11_env\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "missing python: $python" }
if (-not (Test-Path -LiteralPath $Bin)) { throw "missing bin: $Bin" }
$binHash = (Get-FileHash -LiteralPath $Bin -Algorithm SHA256).Hash
$binSize = (Get-Item -LiteralPath $Bin).Length

function Run-Esptool([string[]]$Extra, [int]$B) {
    $all = @('-m', 'esptool', '--port', $Com, '--baud', $B) + $Extra
    $out = & $python @all 2>&1 | ForEach-Object { $_.ToString() }
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Output = ($out -join "`n"); Exit = $code }
}

# Re-verify identity immediately before writing (never trust COM port alone).
$chip = Run-Esptool @('chip_id') 115200
if ($chip.Exit -ne 0) { throw "chip_id failed on $Com : $($chip.Output)" }
$macMatch = [regex]::Match($chip.Output, 'MAC:\s*([0-9a-fA-F:]{17})')
if (-not $macMatch.Success) { throw "cannot parse MAC from chip_id on $Com" }
$mac = $macMatch.Groups[1].Value.ToLowerInvariant()
if ($mac -ne $ExpectedMac.ToLowerInvariant()) {
    throw "IDENTITY MISMATCH on $Com : got MAC $mac, expected $ExpectedMac. Refusing to write flash."
}

# App partition only. esptool verifies the written hash unless --no-verify is passed.
$write = Run-Esptool @('write_flash', ('0x{0:x}' -f $FlashOffset), $Bin) $Baud
$verified = ($write.Output -match 'Hash of data verified') -or ($write.Output -match 'Hash of data verified.')
$result = [ordered]@{
    recordedAt = (Get-Date).ToString('o')
    com = $Com
    mac = $mac
    expectedMac = $ExpectedMac.ToLowerInvariant()
    binPath = $Bin
    binSize = $binSize
    binSha256 = $binHash
    appFlashOffset = ('0x{0:x}' -f $FlashOffset)
    esptoolExit = $write.Exit
    esptoolReportedHashVerified = $verified
    fullErase = $false
    wrotePartitions = @('factory app only (0x10000)')
    note = 'App-partition-only update; bootloader/NVS/partition table untouched.'
}
[System.IO.File]::WriteAllText($OutJson, ($result | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "FLASH_EXIT=$($write.Exit) HASH_VERIFIED=$verified BIN_SHA256=$binHash"
if ($write.Exit -ne 0) { Write-Host $write.Output; throw "write_flash failed on $Com" }
if (-not $verified) { Write-Warning "esptool did not report hash verification; treat write as unverified." }
# Keep only the tail of the esptool output for the record.
Write-Host (($write.Output -split "`n" | Select-Object -Last 8) -join "`n")
