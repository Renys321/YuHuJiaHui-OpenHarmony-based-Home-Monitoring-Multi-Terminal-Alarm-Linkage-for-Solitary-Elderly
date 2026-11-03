<#
.SYNOPSIS
  offline-synth.ps1 — 用 Windows **OneCore (WinRT)** 语音合成把文本写成 WAV（完全离线）。

.DESCRIPTION
  为什么不用 SAPI：本机 SAPI 路径（ISpVoice::Speak / System.Speech）会以
  0xC0000005 崩进程。Windows.Media.SpeechSynthesis.SpeechSynthesizer（OneCore）
  是另一条实现路径，实测可用，且不需要账号、密钥、付费，也不联网。

  本脚本只负责"文本 -> WAV 字节"。格式归一化与质量校验由 Node 侧
  tools/tts/wav.js 完成；不要把校验逻辑写在这里。

  实现要点（都是踩过的坑）：
   1. 本文件必须存成 **UTF-8 with BOM**，否则 PowerShell 5.1 按 ANSI 解码，
      中文会被破坏（make-assets.js 会自动补齐 BOM）。
   2. PS 5.1 不投影 System.Runtime.WindowsRuntime；泛型 AsTask 重载也无法用
      反射调用（open generic + ContainsGenericParameters）。
   3. WinRT 异步对象是 __ComObject：既不能 cast 到自定义 ComImport 接口，
      GetType().GetInterfaces() 也是空的。
   4. 因此异步等待交给 winrt-bridge.dll（原生 vtable 调用，不需要 WinMD），
      本脚本只负责调用它、读流、写文件。
   5. 用 Assembly::LoadFrom + 反射调用桥接方法，避免 Add-Type -Path 报
      "operation is not supported"（文件带下载来源标记时会发生）。

.PARAMETER ListVoices
  只列出可用语音后退出（退出码 0）。

.PARAMETER Language
  语言前缀过滤，默认 zh。

.PARAMETER Voice
  指定语音显示名（如 "Microsoft Yaoyao"）；默认取第一个匹配语言的语音。

.PARAMETER TextB64
  待合成文本的 UTF-8 Base64（避免命令行传中文的编码问题）。

.PARAMETER OutFile
  输出 WAV 路径。

.NOTES
  退出码：0 成功；64 参数错误；69 无可用语音或桥接不可用；70 合成失败。
#>
[CmdletBinding()]
param(
    [switch]$ListVoices,
    [string]$Language = 'zh',
    [string]$Voice = '',
    [string]$TextB64 = '',
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

function Exit-With([int]$Code) { exit $Code }

# ---- 加载 WinRT 异步桥接 --------------------------------------------------
$bridgeMethod = $null
$bridgeError = ''
try {
    $bridgePath = Join-Path $PSScriptRoot 'winrt-bridge.dll'
    if (-not (Test-Path $bridgePath)) {
        throw ('bridge assembly missing: ' + $bridgePath + ' (先运行 node tools/tts/make-assets.js --build)')
    }
    $bridgeAssembly = [System.Reflection.Assembly]::LoadFrom($bridgePath)
    $bridgeType = $bridgeAssembly.GetType('WinRtAsyncVtable')
    if ($null -eq $bridgeType) { throw 'WinRtAsyncVtable type not found in bridge assembly' }
    $bridgeMethod = $bridgeType.GetMethod('GetResults')
    if ($null -eq $bridgeMethod) { throw 'GetResults method not found' }
} catch {
    $bridgeError = $_.Exception.Message
}

function Invoke-WinRtAsync([object]$operation) {
    if ($null -eq $bridgeMethod) {
        throw ('WinRT async bridge unavailable: ' + $bridgeError)
    }
    return $bridgeMethod.Invoke($null, @($operation))
}

function Get-OneCoreVoices {
    [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
    return [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
}

# ---- 列出语音 -------------------------------------------------------------
if ($ListVoices) {
    try {
        $all = Get-OneCoreVoices
        if ($null -eq $all -or $all.Count -eq 0) {
            Write-Error 'no OneCore voices installed'
            Exit-With 69
        }
        foreach ($v in $all) {
            Write-Output ('{0}|{1}|{2}' -f $v.DisplayName, $v.Language, $v.Gender)
        }
        Exit-With 0
    } catch {
        Write-Error ('ONECORE_LIST_FAILED: ' + $_.Exception.Message)
        Exit-With 69
    }
}

# ---- 参数校验 -------------------------------------------------------------
if ([string]::IsNullOrEmpty($TextB64) -or [string]::IsNullOrEmpty($OutFile)) {
    Write-Error 'usage: offline-synth.ps1 -TextB64 <b64> -OutFile <path> [-Voice <name>] [-Language zh]'
    Exit-With 64
}

try {
    $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TextB64))
} catch {
    Write-Error 'TextB64 is not valid Base64'
    Exit-With 64
}
if ([string]::IsNullOrWhiteSpace($text)) {
    Write-Error 'text is empty'
    Exit-With 64
}

if ($null -eq $bridgeMethod) {
    Write-Error ('ONECORE_BRIDGE_UNAVAILABLE: ' + $bridgeError)
    Exit-With 69
}

# ---- 合成 -----------------------------------------------------------------
try {
    $all = Get-OneCoreVoices
    if ($null -eq $all -or $all.Count -eq 0) {
        Write-Error 'no OneCore voices installed'
        Exit-With 69
    }

    $chosen = $null
    if (-not [string]::IsNullOrEmpty($Voice)) {
        foreach ($v in $all) {
            if ($v.DisplayName -eq $Voice -or $v.DisplayName -like ('*' + $Voice + '*')) { $chosen = $v; break }
        }
        if ($null -eq $chosen) {
            Write-Error ('voice not found: ' + $Voice)
            Exit-With 69
        }
    } else {
        foreach ($v in $all) {
            if ($v.Language -like ($Language + '*')) { $chosen = $v; break }
        }
        if ($null -eq $chosen) {
            Write-Error ('no voice for language prefix: ' + $Language)
            Exit-With 69
        }
    }

    $synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::new()
    $synth.Voice = $chosen

    [void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $stream = Invoke-WinRtAsync ($synth.SynthesizeTextToStreamAsync($text))
    $size = [int]$stream.Size
    if ($size -le 0) {
        Write-Error 'synthesizer returned an empty stream'
        Exit-With 70
    }

    $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
    [void](Invoke-WinRtAsync ($reader.LoadAsync([uint32]$size)))
    $bytes = New-Object 'byte[]' $size
    $reader.ReadBytes($bytes)
    $reader.Dispose()

    $dir = Split-Path -Parent $OutFile
    if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path $dir)) {
        [void][System.IO.Directory]::CreateDirectory($dir)
    }
    [System.IO.File]::WriteAllBytes($OutFile, $bytes)

    Write-Output ('OK voice={0} language={1} bytes={2}' -f $chosen.DisplayName, $chosen.Language, $bytes.Length)
    Exit-With 0
} catch {
    Write-Error ('ONECORE_SYNTH_FAILED: ' + $_.Exception.GetType().Name + ' :: ' + $_.Exception.Message)
    Exit-With 70
}
