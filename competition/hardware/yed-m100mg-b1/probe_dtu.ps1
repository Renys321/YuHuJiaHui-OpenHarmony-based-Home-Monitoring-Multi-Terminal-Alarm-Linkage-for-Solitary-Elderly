[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^COM\d+$')]
    [string]$Port,

    [ValidateRange(1200, 460800)]
    [int]$BaudRate = 115200,

    [ValidateRange(200, 10000)]
    [int]$ResponseTimeoutMs = 1800,

    [switch]$IncludeIdentifiers
)

$ErrorActionPreference = 'Stop'

function Protect-Identifier {
    param([string]$Line)

    if ($Line -match '^(config,(?:imei|iccid),ok,)([^\r\n]+)$') {
        $value = $Matches[2].Trim()
        $lastFour = if ($value.Length -ge 4) { $value.Substring($value.Length - 4) } else { '****' }
        return "$($Matches[1])<redacted,last4=$lastFour>"
    }
    return $Line
}

$commands = @(
    'config,get,firmwarever',
    'config,get,csq',
    'config,get,ssta',
    'config,get,paramver'
)

if ($IncludeIdentifiers) {
    $commands += @('config,get,imei', 'config,get,iccid')
}

$serial = [System.IO.Ports.SerialPort]::new(
    $Port,
    $BaudRate,
    [System.IO.Ports.Parity]::None,
    8,
    [System.IO.Ports.StopBits]::One
)
$serial.NewLine = "`r`n"
$serial.ReadTimeout = 200
$serial.WriteTimeout = 1000
$serial.DtrEnable = $false
$serial.RtsEnable = $false

try {
    $serial.Open()
    $serial.DiscardInBuffer()
    $serial.DiscardOutBuffer()
    Write-Host "DTU serial probe: $Port @ $BaudRate baud"
    Write-Host 'Sensitive identifiers are not persisted and are redacted on screen.'

    foreach ($command in $commands) {
        Write-Host "`n> $command"
        $serial.Write("$command`r`n")
        $deadline = [DateTime]::UtcNow.AddMilliseconds($ResponseTimeoutMs)
        $received = [System.Collections.Generic.List[string]]::new()

        while ([DateTime]::UtcNow -lt $deadline) {
            try {
                $line = $serial.ReadLine().Trim()
                if ($line.Length -gt 0) {
                    $received.Add((Protect-Identifier $line))
                }
            }
            catch [System.TimeoutException] {
                Start-Sleep -Milliseconds 50
            }
        }

        if ($received.Count -eq 0) {
            Write-Warning 'No response. Check power, common ground, TX/RX direction and baud rate.'
        }
        else {
            $received | Select-Object -Unique | ForEach-Object { Write-Host $_ }
        }
    }
}
finally {
    if ($serial.IsOpen) {
        $serial.Close()
    }
    $serial.Dispose()
}

