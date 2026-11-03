[CmdletBinding()]
param(
    [ValidateSet('activate', 'downlink')]
    [string]$Mode = 'activate'
)

$ErrorActionPreference = 'Stop'
$secureKey = $null
$keyBstr = [IntPtr]::Zero
$plainKey = $null
$startInfo = $null
$child = $null
$exitCode = 1

try {
    $secureKey = Read-Host 'Enter OneNET device key (input hidden)' -AsSecureString
    $keyBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyBstr)
    if ([string]::IsNullOrWhiteSpace($plainKey)) {
        throw 'The OneNET device key cannot be empty.'
    }

    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $scriptName = if ($Mode -eq 'downlink') { 'downlink-check.js' } else { 'live-check.js' }
    $scriptPath = Join-Path $PSScriptRoot $scriptName
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nodePath
    $startInfo.UseShellExecute = $false
    $startInfo.WorkingDirectory = $PSScriptRoot
    $startInfo.Arguments = '"' + $scriptPath + '"'
    $startInfo.Environment['ONENET_PRODUCT_ID'] = 'I19NBBq4xe'
    $startInfo.Environment['ONENET_DEVICE_NAME'] = 'dayu200-home-gateway'
    $startInfo.Environment['ONENET_DEVICE_KEY'] = $plainKey

    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $startInfo
    if (-not $child.Start()) {
        throw 'Unable to start the OneNET activation check.'
    }

    $startInfo.Environment.Remove('ONENET_DEVICE_KEY') | Out-Null
    $plainKey = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyBstr)
    $keyBstr = [IntPtr]::Zero

    $child.WaitForExit()
    $exitCode = $child.ExitCode
}
finally {
    if ($null -ne $startInfo) {
        $startInfo.Environment.Remove('ONENET_DEVICE_KEY') | Out-Null
    }
    $plainKey = $null
    if ($keyBstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyBstr)
    }
    if ($null -ne $secureKey) {
        $secureKey.Dispose()
    }
    if ($null -ne $child) {
        $child.Dispose()
    }
}

exit $exitCode
