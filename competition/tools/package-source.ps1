# 生成"可复现源码包"（去编译产物/缓存/凭据）
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-source.ps1
#   powershell ... -File tools\package-source.ps1 -OutRoot D:\OpenHarmony\submission -Name "赛题四+...rar"
#
# 说明：本脚本只做"复制 + 过滤 + 压缩"，不修改原工程；staging 目录可反复重建。
[CmdletBinding()]
param(
    [string]$OutRoot = 'D:\OpenHarmony\submission',
    [string]$Name    = '赛题四+独居老人居家安全监测与应急辅助系统+XX学校+团队名称',
    [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'
$competition = Split-Path -Parent $PSScriptRoot
$workspace   = Split-Path -Parent $competition          # D:\OpenHarmony
$staging     = Join-Path $OutRoot 'source'
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# 需要纳入的源码根（相对路径，"" 表示 competition 本目录散文件）
$include = @(
    'APP\ElderlyCareGuardian',
    'competition\README.md',
    'competition\docs',
    'competition\firmware',
    'competition\northbound',
    'competition\southbound',
    'competition\bridge',
    'competition\cloud',
    'competition\video',
    'competition\vision',
    'competition\mobile',
    'competition\hardware',
    'competition\deploy',
    'competition\materials',
    'competition\tools',
    'competition\esp32-node-wearable'
)

# 目录排除（robocopy 支持通配）
$exDirs = @(
    'build','build-*','.local','node_modules','oh_modules','.hvigor','.venv','.venv-*',
    '__pycache__','.preview','.test','.playwright-cli','.verify-tmp','.tts-work',
    'torchinductor*','.secrets','dist','out','.buildcache','archive','.idea','preview','backup-*','.git'
)
# 文件排除（构建产物/缓存/凭据/交付二进制；模型权重保留以保证可运行）
$exFiles = @(
    'sdkconfig','*.hap','*.elf','*.zip','*.rar','*.7z','*.log','*.pyc','*.pyo',
    '*.o','*.obj','*.a','*.so','*.dll','*.exe','local.properties','*.iml','*.whl','*.caffemodel','*.param',
    '*.docx','*.pptx','*.pdf','*.wav','*.m4a','*.mp4'
)

function Copy-Tree([string]$rel) {
    $src = Join-Path $workspace $rel
    if (-not (Test-Path $src)) { Write-Warning "跳过（不存在）: $rel"; return }
    $dst = Join-Path $staging $rel
    if (Test-Path $src -PathType Leaf) {
        New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
        Copy-Item $src $dst -Force
        return
    }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    $rcArgs = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1',
                '/XD') + $exDirs + @('/XF') + $exFiles
    & robocopy @rcArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败($LASTEXITCODE): $rel" }
}

foreach ($i in $include) { Copy-Tree $i }

# 额外裁剪：第三方缓存/编译示例/重复导出模型/内部证据/预编译二进制
$prune = @(
    'competition\vision\dayu-local\third_party\pip-cache',
    'competition\vision\dayu-local\third_party\ncnn\examples',
    'competition\vision\dayu-local\evidence',
    'competition\vision\yolo11n-pose_ncnn_model',
    'competition\materials\demo-autostart\dayu\models',
    'competition\materials\demo-autostart\dayu\dayu_local_fall',
    'competition\docs\evidence',
    'competition\docs\agent-tasks',
    'competition\docs\agent-reports',
    'competition\docs\PROMPT-DOCX-PPT.md',
    'competition\docs\_submission-requirements.txt',
    'competition\bridge\_test\current-runtime',
    'competition\cloud\wearable-mirror\runtime',
    'competition\vision\_runtime_ui'
)
foreach ($p in $prune) {
    $full = Join-Path $staging $p
    if (Test-Path $full) { Remove-Item $full -Recurse -Force }
}

# 顶层补一份构建说明与参赛材料说明
$guide = @'
# 源码包说明（提交用）

作品名：域护家徽：OpenHarmony 驱动的独居老人居家安全监测与多端告警闭环系统
赛题：赛题四 · 独居老人居家安全监测与应急辅助系统

本包只包含可编译/可运行的源码与构建配置，已剔除编译产物、缓存、凭据与内部证据。

推荐演示入口：`competition/materials/start-demo-full.cmd`（双击后按提示输入一次 INGEST_KEY）。

## 目录

| 目录 | 内容 | 构建方式 |
|---|---|---|
| `APP/ElderlyCareGuardian/` | 手机监护人 APP（ArkTS/ArkUI，bundle `com.example.program_04`） | DevEco Studio / hvigor：`hvigorw assembleHap` |
| `competition/northbound/` | DAYU200 板端 APP（ArkTS，bundle `com.dsh.eldercare`） | 同上 |
| `competition/southbound/` | 板端守护进程 homemon（C，OH NDK） | `powershell -File build.ps1`（需 OH NDK + clang） |
| `competition/firmware/` | 三块 ESP32-S3 节点工程（kitchen / bathroom / living） | ESP-IDF v5.1.6：进入工程目录 `idf.py build` |
| `competition/esp32-node-wearable/` | 穿戴求助固件（ESP32-S3） | ESP-IDF v5.1.6 |
| `competition/bridge/` | PC 桥接 + 自包含 MQTT Broker（Node.js） | 无需 `npm install`（零依赖）；`node mqtt_bridge.js --help` |
| `competition/cloud/` | 云端同步、后端 API、穿戴镜像/MQTT（Node.js） | `npm install` 后按各目录 README 启动 |
| `competition/video/` | 视频中继（Node.js + vendored ws） | `node server.js`（见 README） |
| `competition/vision/` | YOLO Pose 跌倒判定（Python + NCNN） | `pip install -r requirements-pc.txt`；模型权重已随包 |
| `competition/mobile/` | 微信小程序骨架（可选，非演示主路径） | 微信开发者工具导入 |
| `competition/deploy/` | Docker Compose / Caddy 部署文件 | `docker compose -f compose.public.yaml up -d` |
| `competition/hardware/` | 4G/GNSS 等硬件探测工具与说明 | 见各 README |
| `competition/docs/` | 设计/架构/接口/验证文档与 PROJECT-GUIDE | 直接阅读 |
| `competition/materials/` | 演示启动器、预检脚本、素材脚本 | 见 README |

## 环境版本（验收用）

- OpenHarmony：DAYU200，OH 7.0.0.38 / API 26（32 位用户态）
- DevEco Studio：`D:\DevEcoStudio`（含 hvigor/jdk/模拟器）
- ESP-IDF：**v5.1.6**
- Node.js：20+（项目在 Node 24 下验证）
- Python：3.10+（视觉基线）
- Docker：ECS 部署用

## 未随包提供（需自行准备）

- Wi-Fi 口令、监护人测试账号、OneNET/后端密钥：按 README 用环境变量/本地隐藏输入注入，不写入源码。
- 演示用的 `.local/wifi.<node>.defaults`（ESP32）：用 `firmware/tools/build-node.ps1 -Ssid ... -Pass ...` 生成。
- ECS 服务器与域名：公网链路为可选增强，缺省可用局域网闭环运行。

## 盲审口径

包内文档均为技术说明，不含任何院校与成员身份信息。
'@
[System.IO.File]::WriteAllText((Join-Path $staging 'README-SOURCE.md'), $guide, (New-Object System.Text.UTF8Encoding($false)))

# 打包（zip；官方要求 rar，若本机有 WinRAR 可再转 rar）
$zip = Join-Path $OutRoot ($Name + '.zip')
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal

$files = Get-ChildItem $staging -Recurse -File
$sizeMB = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host ''
Write-Host ("[ok] staging: {0}" -f $staging) -ForegroundColor Green
Write-Host ("[ok] files: {0} 个，{1} MB" -f $files.Count, $sizeMB) -ForegroundColor Green
Write-Host ("[ok] zip: {0} ({1} MB)" -f $zip, [math]::Round((Get-Item $zip).Length/1MB,1)) -ForegroundColor Green
if (-not $KeepStaging) { Write-Host '[info] 保留 staging 便于核对；加 -KeepStaging 时行为相同，删除请手动。' -ForegroundColor DarkGray }
