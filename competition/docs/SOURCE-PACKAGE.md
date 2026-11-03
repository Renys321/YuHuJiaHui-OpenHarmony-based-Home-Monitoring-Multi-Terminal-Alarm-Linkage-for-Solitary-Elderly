# 源码交付包（按参赛要点整理）

依据《开源鸿蒙大赛作品提交要求》3.2/3.5 与评审原则 4.1/4.3：
- 源码为必交材料，需**去除编译产物与中间缓存**，保证组委会可复现编译运行；
- 全部材料盲审，**不得出现院校与成员身份信息**；
- AI 只能作辅助工具，核心代码需团队理解、修改、验证（本包按"可读、可查、可复现"整理）。

## 1. 生成命令

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <WORKSPACE>\competition\tools\package-source.ps1 `
  -OutRoot D:\BaiduNetdiskDownload `
  -Name "域护家徽-OpenHarmony-独居老人居家安全监测与多端告警闭环系统-源码"
```

脚本只做"复制 + 过滤 + 压缩"，不改动原工程；产物：

- `D:\BaiduNetdiskDownload\域护家徽-源码\` —— 清洗后的源码目录（可直接核对）
- `D:\BaiduNetdiskDownload\域护家徽-OpenHarmony-独居老人居家安全监测与多端告警闭环系统-源码.zip` —— 压缩包（官方要求 rar，提交前用 WinRAR 另存为 `.rar`）

> 命名：官方规则要求"赛题序号+名称+院校+团队"，但同一份材料又要求**盲审不得出现身份信息**。对外/平台提交用官方命名；需要盲审的副本使用上面的中性名。

## 2. 包含 / 排除

| 类别 | 内容 |
|---|---|
| 纳入 | `APP/ElderlyCareGuardian`（手机 APP，bundle `com.example.program_04`）、`northbound`（板端 APP）、`southbound`（homemon）、`firmware/{kitchen,bathroom,living}`（三块 ESP32 工程）、`esp32-node-wearable`、`bridge`、`cloud`、`video`、`vision`、`mobile`（小程序骨架）、`hardware`、`deploy`、`materials`（脚本）、`tools`、`docs`（含 PROJECT-GUIDE） |
| 排除目录 | `build`、`build-*`、`.local`、`node_modules`、`oh_modules`、`.hvigor`、`.venv*`、`__pycache__`、`.preview`、`preview`、`backup-*`、`.secrets`、`dist`、`out`、`.buildcache`、`docs/archive`、`docs/evidence`、`.idea`；历史目录 `evidence/`、`experiments/`、旧 `esp32-node/` |
| 额外裁剪 | `vision/dayu-local/third_party/{pip-cache,ncnn/examples}`、`vision/yolo11n-pose_ncnn_model`（重复导出）、`vision/dayu-local/evidence`、`materials/demo-autostart/dayu/{models,dayu_local_fall}`（预编译 aarch64 二进制） |
| 排除文件 | `sdkconfig`（生成物）、`*.hap/elf/zip/rar/log/pyc/o/a/so/dll/exe/whl/caffemodel`、`*.docx/pptx/pdf/wav/m4a/mp4`、`local.properties` |

保留的二进制只有运行必需的两份模型：`vision/yolo11n-pose.pt`（6 MB）与 `vision/dayu-local/model/model.ncnn.bin`（11 MB）；其余模型/预编译产物按 `vision/README.md` 重新导出。

## 3. 各模块构建入口

| 模块 | 命令 | 环境 |
|---|---|---|
| `APP/ElderlyCareGuardian/` | DevEco Studio 打开 → Build HAP；或 `hvigorw assembleHap` | DevEco Studio（API 26） |
| `competition/northbound/` | 同上 | DevEco Studio |
| `competition/southbound/` | `powershell -File build.ps1` | OpenHarmony NDK（clang，`--target=arm-linux-ohos`） |
| `competition/firmware/kitchen`（bathroom/living 同理） | 进目录 `idf.py build`；或 `tools/build-node.ps1 -Node kitchen` | ESP-IDF v5.1.6 |
| `competition/esp32-node-wearable/` | 同上 | ESP-IDF v5.1.6 |
| `competition/bridge/` | `node mqtt_broker.js 1883`、`node mqtt_bridge.js ...` | Node 20+（零依赖） |
| `competition/cloud/*` | `npm install` 后按各 README 启动 | Node 20+ |
| `competition/video/relay/` | `node server.js`（vendored `ws`） | Node 20+ |
| `competition/vision/` | `pip install -r requirements-pc.txt`；`python yolo_pose_service.py ...` | Python 3.10+ |
| `competition/deploy/` | `docker compose -f compose.public.yaml up -d` | Docker |

已在本机验证：ESP32 三工程构建（`firmware/docs/BUILD-VERIFY.md`）、手机/板端 HAP、bridge/OneNET/后端单元测试、视觉规则测试。
另从清洗后的源码包内重新构建了厨房工程（见 §6），证明"去掉产物的包"仍可编译。

## 4. 凭据与盲审

- 不含 `.secrets/`（监护人测试账号、DeepSeek key、穿戴 MQTT env）。
- 不含 Wi-Fi 口令：`sdkconfig.defaults` 是占位符，构建时用 `tools/build-node.ps1 -Ssid -Pass` 注入本地文件。
- 不含 `.local/`（真实 Wi-Fi 配置、构建缓存）。
- 文档正文无院校/成员身份信息；`docs/archive`（历史材料骨架）未随包。

## 5. 提交前自检清单

- [ ] 运行 `tools/package-source.ps1`，确认输出无 `build/`、`node_modules/`、`.secrets/`
- [ ] 抽查解压后源码：`firmware/kitchen` 能 `idf.py build`；APP 能在 DevEco 打开
- [ ] 包名改为 `赛题四+独居老人居家安全监测与应急辅助系统+<院校>+<团队>`（命名格式要求）
- [ ] 转成 `.rar`（WinRAR：右键 → 添加到压缩文件）
- [ ] 另外三份材料（设计方案 docx、演示视频 mp4 ≤100MB/≤5min、答辩 PPT ≤7min）分别做盲审检查
- [ ] 提交窗口 **2026-11-04 ～ 11-06**，以平台接收时间为准；提交后原则上不可替换

## 6. 包体复核

- 规模：约 5.2k 文件、79 MB（zip 约 30 MB）。
- 包内 `competition/firmware/kitchen` 复制到临时目录后 `idf.py build` 通过，产物 1,023,440 B。
- 包内无 `build/`、`node_modules/`、`.secrets/`、`sdkconfig`、`.hap`；盲审关键词扫描 0 命中。

## 7. 与原工程的关系

源码包来自 `<WORKSPACE>\competition` 与 `<WORKSPACE>\APP\ElderlyCareGuardian` 的当前工作副本；
原工程中的 `evidence/`（内部验证证据）、`experiments/`、旧 `esp32-node/`（历史构建）不属于源码交付物，未纳入。
