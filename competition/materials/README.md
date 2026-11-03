# 工程材料目录

> 作品名（建议）：**域护家徽：OpenHarmony 驱动的独居老人居家安全监测与多端告警闭环系统**（赛题四）。

本目录只保留**当前在用**的启动入口、校验脚本和素材。
2026-10-29 已清理：删除 `demo_start.ps1`、`demo_recover.ps1`、`start-demo-current.cmd`、
`device-preflight.ps1`、`demo-preflight.js` 及全部 `.bak-*` 备份，避免和现行入口混淆。

## 当前演示栈一键入口（2026-11-01 新增）

| 文件 | 用途 |
|---|---|
| `core-start.cmd` | 检查 Node/hdc/密钥 → 重启/复用网关 → 恢复 hdc 映射 → 拉起 DAYU APP → 检查 1883/9101/9302/9303/9102 |
| `core-supervisor.cmd` | 每 15 秒自检并自愈网关端口、hdc 映射、DAYU APP |
| `stability-test.cmd` | 多轮稳定性测试：端口、hdc、9302 文本问答、回答≤40字、云端 healthz |
| `voice-chain-test.cmd` | 9303 语音链路回归：ASR→健康分支→clip/answer（不验证喇叭出声） |
| `voice-chain-sim.js` | 用 WAV 模拟 S3 9303 上传，供脚本调用 |

## 启动入口（只认这几个）

| 顺序 | 文件 | 用途 |
|---|---|---|
| 1（完整演示，推荐） | `start-demo-full.cmd` | **一次补齐全套**：P0（broker/bridge/public-sync，需输 `INGEST_KEY`）+ 板端解锁/拉起 APP/切客厅监护页 + PC 视觉（带 `--ground-zone`）+ 视频 relay + 随身 mirror，最后做验收汇总。仍不会替你给 ESP32 上电 |
| 2（只起 P0） | `start-demo-supervisor.cmd` | 只启动 broker/bridge/public-sync 与板端 homemon/fport；分步排查或只需云同步时用 |
| 2（可选） | `start-mirror-dayu.ps1 -Apply` | 随身求助 mirror（4G/GPS）：自动解析 DAYU 端点并注入板端 9001；默认 dry-run，`-Apply` 才启动 |
| 3（可选） | `start-demo-all.cmd` | watcher 常驻守护（自动拉起板载 APP/推理、重建 fport）。**注意**：它的 `Ensure-Inference` 会拉起板端 ncnn 推理占用 9200，与 PC 视觉冲突；用 PC YOLO 时不要开 |

体检/校验（只读，不启动）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-demo-supervisor.ps1 -Preflight   # 启动前预检
powershell -NoProfile -ExecutionPolicy Bypass -File .\public-sync-health.ps1                 # P0 健康（HEALTHY/exit 0）
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-p0-health.ps1                   # P0 判定回归
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-supervisor-acceptance.ps1       # supervisor 只读验收取证
```

`start-demo-supervisor.ps1` 是 `start-demo-supervisor.cmd` 的实现，支持：
`-Preflight`（只读预检）、`-Target`（显式 hdc 目标）、`-StatusTcp`/`-RelayTo`（直连非 fport 拓扑）、
`-RelayIgnore`（默认 `esp32-sos`，防 mirror 回灌误退休）、`-AutoDayuEndpoint`/`-PreferLanEndpoint`
（自动解析 DAYU 端点，USB 在线优先 fport，否则回退板端 LAN IPv4:9000）；拒绝第二个 supervisor。

## 辅助工具与素材

| 文件 | 作用 |
|---|---|
| `resolve-dayu-lan-ip.ps1` | 只读解析 DAYU 状态/relay 端点（USB fport 优先，LAN 回退），输出 JSON；被 supervisor 与 mirror 封装调用 |
| `make_voice.ps1` | 将录音转成应用 rawfile 使用的 WAV |
| `make_design_doc.py` | 生成设计说明文档（`设计方案.docx`） |
| `make_ppt.py` | 生成讲解文稿（`讲解PPT.pptx`） |
| `render_docx_with_word.js` | 用本机 Word 渲染 docx（校验用） |
| `build_status_and_requirements_docs.py` | 生成状态/需求类文档 |
| `BOOT-RUNBOOK.md` | 从开机到演示就绪的完整流程（与本文互补） |
| `设计方案.docx` / `讲解PPT.pptx` | 当前交付产物；功能结论需与验证矩阵同步 |
| `sos-voice-整段.wav` / `sos-voice-正式.wav` | 音频素材（HAP 实际入包的是 `northbound/.../rawfile/sos.wav`） |

## DAYU WLAN IP 漂移与自动端点

现场 DAYU200 的 `wlan0` IPv4 曾从 `10.127.130.250` 漂移为 `10.127.130.131`。bridge 的
`--status-tcp/--relay-to` 与 mirror 的 `--relay-to` 若写死旧 IP，表现为：

- P0 收不到 `dayu200-living` 的 `202`（手机 APP 客厅数据停在旧值；kitchen/bath 不受影响，因为走 ESP32→MQTT）；
- mirror `relay connected=false(ETIMEDOUT)`，DAYU 收不到随身 SOS 镜像。

只读解析（不启动/停止服务、不建 fport、不读密钥）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\resolve-dayu-lan-ip.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\resolve-dayu-lan-ip.ps1 -JsonOnly
```

正式入口已集成：`start-demo-supervisor.cmd` 默认带 `-AutoDayuEndpoint`。

## 已知上限

> ⚠️ `southbound` homemon 的 `MAX_CLIENTS` 目前是 4：bridge 占 2 路、DAYU APP 占 1 路、mirror 占 1 路，
> 已到上限。反复强杀 bridge/mirror 会让板端留下僵尸连接占满槽位，导致 dayu200-living 状态中断、
> mirror relay 反复断连。现场诊断与恢复步骤见
> `../evidence/2026-10-28-three-legacy-closures/watcher/`（重启 DAYU homemon 可清槽位；根治需提高
> `MAX_CLIENTS` 并加死客户端回收，属 homemon 源码/二进制改动，须同步更新 P0 入口的 `$HomemonSha`）。

## 2026-10-31 一键启动更新

- `start-demo-full.cmd` 现在会重建四条 hdc 映射：
  `9001->9000`、`rport 9200`、`9301->9301`、`rport 9302`；
  并在 9302 未监听时自动启动 `voice-gateway/server.js`，同时检查 9102 音箱服务。
- 新增 `restore-hdc-mappings.cmd`：板子重插/重启或 `hdc fport ls` 为空时，
  双击即可恢复板端 9001/9200/9301/9302 映射，不需要重启任何服务。
- 典型“全掉线”原因不是设备离线，而是 hdc 映射丢失；先跑 restore 脚本再排查设备。
