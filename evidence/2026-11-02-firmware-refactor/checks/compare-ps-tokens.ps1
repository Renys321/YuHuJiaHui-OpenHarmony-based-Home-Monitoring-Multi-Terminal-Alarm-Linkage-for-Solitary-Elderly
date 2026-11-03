param(
    [Parameter(Mandatory = $true)][string]$Old,
    [Parameter(Mandatory = $true)][string]$New
)

$ErrorActionPreference = 'Stop'

function Get-CodeTokens([string]$Path) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        throw ("语法错误 {0}: {1}" -f $Path, $errors[0].Message)
    }
    $skip = @(
        [System.Management.Automation.Language.TokenKind]::Comment,
        [System.Management.Automation.Language.TokenKind]::NewLine,
        [System.Management.Automation.Language.TokenKind]::LineContinuation,
        [System.Management.Automation.Language.TokenKind]::EndOfInput
    )
    return @($tokens | Where-Object { $skip -notcontains $_.Kind } | ForEach-Object { $_.Text })
}

$oldTokens = Get-CodeTokens $Old
$newTokens = Get-CodeTokens $New
if ($oldTokens.Count -ne $newTokens.Count) {
    Write-Output ("TOKEN_COUNT_DIFF old={0} new={1}" -f $oldTokens.Count, $newTokens.Count)
    exit 1
}
for ($i = 0; $i -lt $oldTokens.Count; $i++) {
    if ($oldTokens[$i] -cne $newTokens[$i]) {
        Write-Output ("TOKEN_DIFF at {0}: old=<{1}> new=<{2}>" -f $i, $oldTokens[$i], $newTokens[$i])
        exit 1
    }
}
Write-Output ("TOKENS_MATCH count={0}" -f $oldTokens.Count)
exit 0
