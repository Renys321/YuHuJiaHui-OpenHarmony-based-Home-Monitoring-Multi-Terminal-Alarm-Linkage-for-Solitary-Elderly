Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = 'D:\OpenHarmony\competition'
$claudeCommand = 'C:\Users\<user>\AppData\Roaming\npm\claude.cmd'
$taskFile = Join-Path $projectRoot 'docs\agent-tasks\CLAUDE-CAMERA-VISION-AUDIT.md'

Set-Location -LiteralPath $projectRoot
$env:CLAUDE_CODE_EFFORT_LEVEL = 'max'

Write-Host 'Claude Code 可见协作窗口' -ForegroundColor Cyan
Write-Host "项目: $projectRoot"
Write-Host "任务: $taskFile"
Write-Host '本轮只读审计产品代码，只允许写指定的 agent-reports 报告。' -ForegroundColor Yellow
Write-Host ''

& $claudeCommand "严格执行 $taskFile。先阅读任务文件中列出的权威文档；本轮只读审计，不得修改产品源码，只把审计报告写入任务指定的 docs/agent-reports 文件，完成后停止并在终端汇报。"

Write-Host ''
Write-Host 'Claude 会话已结束。此窗口保留，便于检查完整输出。' -ForegroundColor Cyan
