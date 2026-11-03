# 生成可编译源码提交包：剔除 build/依赖/证书/证据/日志
$ErrorActionPreference = 'Stop'
$Root = 'D:\OpenHarmony'
$Competition = Join-Path $Root 'competition'
$App = Join-Path $Root 'APP\ElderlyCareGuardian-v2'
$Stage = 'D:\OpenHarmonyBackup\_source-pkg-20261102'
$Zip = 'D:\OpenHarmonyBackup\shouchao-source-20261102.zip'

if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

function Copy-Tree([string]$src, [string]$dst, [string[]]$xd) {
    $args = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
    if ($xd.Count -gt 0) { $args += '/XD'; $args += $xd }
    $args += @('/XF', '*.log', '*.hap', '*.bin', '*.elf', '*.map', '*.o', '*.a', '*.so', '*.dll', '*.lib', '*.pptx', '*.docx', '*.pdf', '*.tar.gz', '*.zip', '*.p12', '*.pem', '*.p7b', '*.cer', '*.jks', 'shot-*.jpg')
    & robocopy @args | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "robocopy failed $src exit=$LASTEXITCODE" }
}

$xd = @('build','node_modules','oh_modules','.git','.hvigor','.venv','.venv-vision','__pycache__','logs','.secrets','.work','runtime','evidence','archive','dist','_test','signing','dayu-local','yolo11n-pose_ncnn_model','_runtime_ui','out','managed_components','torchinductor_LENOVO')
Write-Host '[*] competition source'
Copy-Tree $Competition (Join-Path $Stage 'competition') $xd
Write-Host '[*] phone app source'
Copy-Tree $App (Join-Path $Stage 'app-v2') $xd

# 顶层辅助文档
@'
# 守巢项目源码包（2026-11-02）

本包只保留可编译源码、配置、资源与文档：

- 已剔除：build、node_modules/oh_modules、.venv、.hvigor、证书/签名、证据、日志、HAP/BIN/ELF 等编译产物。
- 保留：ESP32-S3 固件源码与 voice 资源、DAYU200 ArkTS、手机 ArkTS、Node 网关/后端/桥接、脚本、文档。
- 模型文件：vision/yolo11n-pose.pt 作为运行资源保留。

## 构建

### 手机 APP
```bat
cd app-v2
hvigorw assembleHap --no-daemon
```

### DAYU200
```bat
cd competition\northbound
hvigorw assembleHap --no-daemon
```

### ESP32-S3
```bat
cd competition\firmware
powershell -File tools\_build_kitchen.ps1
powershell -File tools\_build_bathroom.ps1
```

### 云后端/网关
```bat
cd competition\cloud\backend
npm install
npm test
cd competition\voice-gateway
node server.js
```

## 说明

- 本包不含 `.secrets`、`INGEST_KEY`、DeepSeek Key、签名密钥。
- 运行前需自行配置环境、账号与云端 `.env`。
- 完整交接说明见原备份目录的 `README-HANDOFF.md` / `CODE-MAP.md`。
'@ | Set-Content (Join-Path $Stage 'README-SOURCE.md') -Encoding UTF8

"source package 2026-11-02" | Set-Content (Join-Path $Stage 'VERSION.txt') -Encoding UTF8

Write-Host '[*] zip'
if (Test-Path $Zip) { Remove-Item $Zip -Force }
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Zip -CompressionLevel Optimal
Write-Host "[OK] $Zip"
