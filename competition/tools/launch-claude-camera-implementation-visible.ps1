Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = 'D:\OpenHarmony\competition'
$claudeCommand = 'C:\Users\<user>\AppData\Roaming\npm\claude.cmd'
$taskFile = Join-Path $projectRoot 'docs\agent-tasks\CLAUDE-CAMERA-PROBE-IMPLEMENT.md'

Set-Location -LiteralPath $projectRoot
$env:CLAUDE_CODE_EFFORT_LEVEL = 'max'

Write-Host 'Claude Code Camera 实施窗口' -ForegroundColor Cyan
Write-Host "项目: $projectRoot"
Write-Host "任务: $taskFile"
Write-Host '严格按任务文件所有权实施；不得修改 Index.ets 或其他产品文件。' -ForegroundColor Yellow
Write-Host ''

& $claudeCommand "执行 $taskFile。先完整阅读任务文件和 docs/AI-COLLAB.md 第二轮所有权；严格限制在指定两个文件，完成实现、校验并汇报，不得修改其他文件。"

Write-Host ''
Write-Host 'Claude Camera 实施会话已结束。窗口保留供检查。' -ForegroundColor Cyan
