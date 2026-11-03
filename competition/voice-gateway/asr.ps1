#Requires -Version 5.1
<#
用本机 SAPI 的 zh-CN 识别器转写一个 WAV 文件，不联网、不写文件。

用法:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File asr.ps1 -WavPath C:\tmp\a.wav

识别超时返回 {"error":"ASR_TIMEOUT"}，无结果返回 {"error":"ASR_EMPTY"}，
识别器异常返回 {"error":"ASR_FAILED"}；stdout 只有一行 JSON。

识别放在 Add-Type 的 C# 里同步执行：PowerShell 的 RecognizeCompleted 回调依赖
runspace，主线程阻塞等待会死锁（表现是一直超时）。C# 里 Recognize + Task 超时
最稳，走的仍然是本地 SAPI。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$WavPath,
  [int]$TimeoutSeconds = 8,
  [ValidateSet('auto','safe','health')][string]$Mode = 'auto'
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

function Write-Json($obj) {
  [Console]::Out.Write(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

if (-not (Test-Path -LiteralPath $WavPath)) {
  Write-Json @{ error = 'ASR_FAILED'; message = 'wav not found' }
  exit 2
}

try {
  Add-Type -AssemblyName System.Speech
  if (-not ('SapiAsr' -as [type])) {
    $code = @'
using System;
using System.Globalization;
using System.Threading.Tasks;
using System.Speech.Recognition;

public static class SapiAsr {
    // 返回 "文本|置信度"；超时返回 "__TIMEOUT__"；无结果返回空串。
    public static string Recognize(string wavPath, int timeoutMs, string mode) {
        using (SpeechRecognitionEngine engine =
               new SpeechRecognitionEngine(new CultureInfo("zh-CN"))) {
            Choices safeChoices = new Choices(new string[] { "我没事", "没事" });
            GrammarBuilder safeBuilder = new GrammarBuilder(safeChoices);
            safeBuilder.Culture = new CultureInfo("zh-CN");
            Choices healthChoices = new Choices(new string[] {
                "我不舒服", "我难受", "我头晕", "我胸闷", "我疼"
            });
            GrammarBuilder healthBuilder = new GrammarBuilder(healthChoices);
            healthBuilder.Culture = new CultureInfo("zh-CN");
            if (mode == "safe") {
                engine.LoadGrammar(new Grammar(safeBuilder));
            } else if (mode == "health") {
                engine.LoadGrammar(new Grammar(healthBuilder));
            } else {
                engine.LoadGrammar(new Grammar(safeBuilder));
                engine.LoadGrammar(new DictationGrammar());
            }
            engine.SetInputToWaveFile(wavPath);
            Task<RecognitionResult> task = Task.Run(() => engine.Recognize());
            if (!task.Wait(timeoutMs)) {
                try { engine.RecognizeAsyncCancel(); } catch { }
                return "__TIMEOUT__";
            }
            RecognitionResult result = task.Result;
            return result == null ? "" : ((result.Text ?? "") + "|" + result.Confidence.ToString("F2", CultureInfo.InvariantCulture));
        }
    }
}
'@
    Add-Type -TypeDefinition $code -ReferencedAssemblies 'System.Speech'
  }
} catch {
  Write-Json @{ error = 'ASR_FAILED'; message = 'System.Speech unavailable: ' + $_.Exception.Message }
  exit 2
}

try {
  $raw = [SapiAsr]::Recognize((Resolve-Path -LiteralPath $WavPath).Path, [Math]::Max(1, $TimeoutSeconds) * 1000, $Mode)
  $parts = $raw.Split('|')
  $text = $parts[0]
  $confidence = if ($parts.Length -gt 1) { $parts[1] } else { '' }
  if ($text -eq '__TIMEOUT__') {
    Write-Json @{ error = 'ASR_TIMEOUT'; message = 'no result in time' }
    exit 3
  }
  if ([string]::IsNullOrWhiteSpace($text)) {
    Write-Json @{ error = 'ASR_EMPTY'; message = 'speech not recognized' }
    exit 4
  }
  Write-Json @{ text = $text.Trim(); confidence = $confidence; mode = $Mode }
  exit 0
} catch {
  Write-Json @{ error = 'ASR_FAILED'; message = $_.Exception.Message }
  exit 5
}
