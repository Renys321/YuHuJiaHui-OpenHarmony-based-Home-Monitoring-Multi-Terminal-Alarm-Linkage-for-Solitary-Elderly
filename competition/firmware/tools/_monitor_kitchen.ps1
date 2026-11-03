param([string]$Com = 'COM14', [int]$Seconds = 12)
$sp = New-Object System.IO.Ports.SerialPort $Com,115200,'None',8,'One'
$sp.ReadTimeout = 300
$sp.Open()
Start-Sleep -Milliseconds 300
$sb = New-Object System.Text.StringBuilder
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
    try { $c = $sp.ReadExisting(); if ($c.Length -gt 0) { [void]$sb.Append($c) } } catch {}
    Start-Sleep -Milliseconds 100
}
$sp.Close(); $sp.Dispose()
$sb.ToString()
