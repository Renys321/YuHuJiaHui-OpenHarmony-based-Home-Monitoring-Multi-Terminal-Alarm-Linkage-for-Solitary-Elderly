# 工程材料目录

本目录只保留当前开发和验证阶段仍在使用的内容。

| 文件 | 作用 |
|---|---|
| `start-demo-supervisor.cmd` | **2026-10-24 起推荐的正式演示一键入口**；双击后先只读预检，再恢复 DAYU 原版 homemon、HDC fport、Broker、Bridge，并由 public-sync supervisor 托管唯一 worker；隐藏输入一次 INGEST_KEY |
| `start-demo-supervisor.ps1` | `start-demo-supervisor.cmd` 调用的入口实现；支持 `-Preflight` 只读预检与 `-Target` 显式指定 HDC 目标；拒绝第二个 supervisor |
| `verify-supervisor-acceptance.ps1` | supervisor 只读验收取证；支持 `-WatchMinutes 15 -MinPerDevice 10` 三设备稳定性观察 |
| `start-demo-current.cmd` | 旧冻结演示版本一键恢复入口（保留为回退路径）；恢复 DAYU 原版 homemon、HDC fport、Broker、Bridge、旧 public-sync，不安装 HAP、不烧录固件 |
| `demo_recover.ps1` | `start-demo-current.cmd` 调用的旧版链路恢复器；支持 `-Stop` 只停止本次启动器实际创建的进程 |
| `demo_start.ps1` | 历史部署式脚本，会覆盖/部署组件；**当前冻结演示不要运行** |
| `make_voice.ps1` | 将录音转换为应用 rawfile 使用的 WAV |
| `make_design_doc.py` | 生成设计说明文档 |
| `make_ppt.py` | 生成讲解文稿 |
| `设计方案.docx` | 当前设计说明产物；功能结论需与验证矩阵同步 |
| `讲解PPT.pptx` | 当前讲解文稿；功能结论需与验证矩阵同步 |
| `sos-voice-整段.wav` | 原始音频素材之一，不是 HAP 当前入包文件 |
| `sos-voice-正式.wav` | 音频中间素材，不是 HAP 当前入包文件 |

HAP 当前实际使用的音频是：

```text
northbound/entry/src/main/resources/rawfile/sos.wav
```

其状态与 SHA-256 见 `../docs/ARTIFACTS.md`。

不再处于当前工作范围的旧阶段说明与工具已经保存在 `../docs/archive/2026-10-09/inactive-delivery-tools/`，默认不要运行。

