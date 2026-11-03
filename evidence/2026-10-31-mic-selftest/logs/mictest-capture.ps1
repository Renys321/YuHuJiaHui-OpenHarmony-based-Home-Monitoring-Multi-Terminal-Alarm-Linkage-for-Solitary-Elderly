param(
  [string]$Port = 'COM9',
  [int]$Seconds = 3,
  [string]$SpeakWav = '',
  [string]$OutFile = '',
  [switch]$Beep
)

$ErrorActionPreference = 'Stop'
$sp = New-Object -TypeName System.IO.Ports.SerialPort -ArgumentList $Port, 115200, 'None', 8, 'One'
$sp.Open()
$sp.ReadTimeout = 500
$sp.WriteTimeout = 2000
$sp.Encoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$sp.DiscardInBuffer()
$sp.DiscardOutBuffer()

$job = $null
try {
  if ($SpeakWav) {
    $job = Start-Job -ScriptBlock {
      param($w)
      $p = New-Object System.Media.SoundPlayer $w
      $p.PlaySync()
    } -ArgumentList $SpeakWav
    Start-Sleep -Milliseconds 1200
  }

  if ($Beep) {
    $sp.WriteLine('beep on')
    Start-Sleep -Milliseconds 300
  }
  $sp.WriteLine("mictest $Seconds")
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    try {
      $line = $sp.ReadLine()
    } catch [System.TimeoutException] {
      continue
    }
    $line = $line.TrimEnd("`r")
    if ($line.Length -gt 0) {
      Write-Output $line
    }
    if ($line -match 'MIC_TEST (rms=|FAIL)') {
      Start-Sleep -Milliseconds 400
      break
    }
  }
} finally {
  if ($job) {
    try { Wait-Job $job -Timeout 20 | Out-Null } catch { }
    try { Remove-Job $job -Force } catch { }
  }
  if ($Beep) {
    try { $sp.WriteLine('beep off') } catch { }
    Start-Sleep -Milliseconds 200
  }
  $sp.Close()
}
