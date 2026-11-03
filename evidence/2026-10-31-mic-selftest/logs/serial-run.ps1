param(
  [string]$Port = 'COM9',
  [string]$Command = 'micupload',
  [int]$Seconds = 15
)

$ErrorActionPreference = 'Stop'
$sp = New-Object -TypeName System.IO.Ports.SerialPort -ArgumentList $Port, 115200, 'None', 8, 'One'
$sp.Open()
$sp.ReadTimeout = 500
$sp.Encoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$sp.DiscardInBuffer()
$sp.WriteLine($Command)
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  try {
    $line = $sp.ReadLine().TrimEnd("`r")
  } catch [System.TimeoutException] {
    continue
  }
  if ($line.Length -gt 0) { Write-Output $line }
}
$sp.Close()
