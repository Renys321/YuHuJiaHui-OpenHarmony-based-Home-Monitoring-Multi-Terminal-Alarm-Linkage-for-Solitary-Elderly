﻿# 域护家徽项目源码包（2026-11-02）

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
