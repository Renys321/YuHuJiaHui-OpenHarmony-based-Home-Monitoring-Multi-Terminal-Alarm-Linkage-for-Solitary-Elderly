# 验证矩阵

状态定义：

- `PASS`：原始证据直接覆盖该结论。
- `PARTIAL`：仅部分层级成立，或证据存在需要复验的不一致。
- `FAIL`：原始证据明确显示未达到预期。
- `NOT TESTED`：没有足够证据，不能用其他层级日志替代。

## 1. 环境与制品

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| OpenHarmony 7.0.0.38 / API 26 | PASS | `evidence/2026-10-10-third-device-validation/00-preflight.txt` | 2026-10-10 真机预检 |
| `uname -m=aarch64` / `LONG_BIT=32` | PASS | 同上 | 真机部署使用 ARM32 |
| 第三轮 signed HAP 安装 | PASS | `00-preflight.txt`、`08-third-demo-start-retry.txt` | 仅覆盖第三轮旧哈希 |
| 当前语音版 signed HAP 离线验签 | PASS | `docs/evidence/2026-10-15-dayu-preset-voice-playback.md` | `9186C504...` 的 codesign、digest、permission sign 与 `verify-app` 通过，且不含 `rpcid.sc` |
| 当前语音版 signed HAP 真机安装 | PASS | 同上 | `hdc install -r` 和 EntryAbility 启动成功；当前语音源码、unsigned HAP 与 signed HAP 已对齐 |
| 第三轮 `demo_start.ps1 -WithWireless`（`304176...`）完整运行 | PASS | `08-third-demo-start-retry.txt` | 历史冻结版本输出“环境就绪”并以 `EXIT_CODE=0` 收尾 |
| 当前 `demo_start.ps1`（`BEE0C8...`）完整运行 | PASS | `docs/evidence/2026-10-13-dayu-final-acceptance.md` | PowerShell 7；USB、ARM32、9001、1883/9101 及当时 `89A87F...` HAP 均通过；不外推为 watchdog 当前源码的一键全流程 |
| 最新 `make_voice.ps1` 真实文件转换 | PASS | `evidence/2026-10-10-make-voice-entry-fix-and-selftest.txt`、`evidence/2026-10-10-make-voice-selftest.wav` | M4A 转 48 kHz 单声道 PCM WAV；缺失输入失败且生产 `sos.wav` 哈希不变，不代表实体扬声器验收 |

## 2. DAYU 本机能力

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| SOS 进入 `alarm_raise()` 并调用 `say.sh` | PASS | `04-dayu-sos-voice.txt`、`04d-playback-and-sim.txt` | 软件触发路径 |
| Ability 播放状态完成 | PASS | 同上 | `SPEAKER` 路由、音量 1.0、playing/completed |
| 实体声学输出效果 | PARTIAL | 2026-10-15 现场确认：未插耳机时听不到；插耳机重播 `medicine_reminder.wav` 后确认听到声音 | 裸板/未接外部音频设备的可听输出为 FAIL；耳机单条可听输出 PASS。尚未确认该句文字是否完全正确、音量/清晰度/破音，也未听测其余四句 |
| 错误 alarmId 保持 ALARM | PASS | `04c-dayu-ack-clean.txt` | DAYU 本机 |
| 正确 alarmId 进入 ACKED | PASS | 同上 | DAYU 本机 |
| 重复 alarmId 被拒绝 | PASS | 同上 | 日志与状态符合预期 |
| 重复 ACK 不增加安全日志 | PASS | `evidence/2026-10-10-third-device-validation/17-dayu-ack-line-count.txt`、`18-final-state-before-cleanup.txt` | 正确 ACK 后物理行数 3，重复 ACK 后仍为 3；最终为 3 个物理行、2 条非空记录 |
| DAYU 系统相机枚举、预览与取帧 | PASS | `docs/evidence/system-camera-hilog.txt`、`docs/evidence/2026-10-13-dayu-final-acceptance.md` | `lcam001`、`rkisp_v5`、`/dev/video0`、CaptureSession 和 `CAMERA_PREVIEW_FINISHED`；仅系统相机 |
| 自研 APP CAMERA 权限与设备枚举 | PASS | `docs/evidence/app-camera-hilog.txt`、`docs/evidence/2026-10-14-auto-fall-guard.md` | 历史探针与上一版 `914B0B47...` 自动监护 HAP 均有真机证据 |
| 自研 APP 4:3 预览、手动拍照与重开 | PASS | `docs/evidence/2026-10-13-app-camera-preview-photo.md`、`camera-aspect-open.json`、`camera-aspect-photo.json`、`camera-aspect-reopen.json`、`camera-aspect-closed.json` | 真实 DAYU；拍照/4:3 首先由历史 HAP 验收，当前自动监护版保留拍照能力 |
| DAYU 前台自动监护帧经 USB 到 PC YOLO | PASS | `docs/evidence/2026-10-14-fall-auto-evidence.md`、`fall-evidence-watchdog-online.json` | 当前 `BB994EA9...` HAP 真实来帧、推理、停止和恢复；不是 DAYU NPU |
| 跌倒事件 PC 触发帧 + DAYU 高分辨率自动抓拍 | PASS（本地真机） | `docs/evidence/2026-10-14-fall-auto-evidence.md`、`fall-evidence-final-package-ui.json` | 固定事件连续返回 126 次只拍一次；新事件可再次拍；JPEG 非空且 `ff d8 ff` |
| 告警图片上传、持久补传、家庭授权接口与小程序预览代码 | PARTIAL（本地 PASS；公网 API READY） | `docs/evidence/2026-10-14-trusted-fall-evidence.md`、`2026-10-14-evidence-outbox-photo-retention.md`、`2026-10-15-public-cloud-acceptance.md` | 本地真实 HTTP、断网/重启恢复、两种到达顺序、过期清理和授权下载已测；公网后端已部署，但真实图片尚未从家庭侧上传并由队友 APP 手机预览 |
| 未接传感器的活动计数稳定性 | PASS | `docs/evidence/2026-10-13-dayu-final-acceptance.md` | 默认不读取浮空 GPIO；真机 10 秒 `countToday 0 -> 0` |

## 3. 本地目标路由基线

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| 四段 TCP 分片重组 route | PASS | `evidence/2026-10-09-local-route-integration/` | 本地 Socket，非真机 |
| 远端 GAS、错误/正确/重复 ACK | PASS | 同目录 `results.json` 和日志 | 真实 Bridge + 真实 sim_node + 伪 homemon |
| 未知设备、普通命令、嵌套 route 拒绝 | PASS | 同上 | 本地协议层 |
| 当前 `Index.ets` 被该测试覆盖 | NOT TESTED | 测试记录哈希 `9900...`，当前为 `1D5C0E...` | 该测试本来也不含真实 APP；当前 Camera/视觉 UI 另有真机证据 |

## 4. 第二轮无线节点历史记录更正

| 项目 | 状态 | 证据 | 更正说明 |
|---|---|---|---|
| sim_node 上行状态到达 Bridge | PASS | `05b-cross-device-offline.txt`、`bridge/_test/demo-bridge.out.log` | Bridge 收到 `NORMAL` 状态 |
| MQTT 下行 GAS 被节点执行 | FAIL | `demo-bridge.out.log` / `demo-bridge.err.log` | 实际载荷是无效 JSON `{cmd:gas}`，节点始终 `NORMAL` |
| homemon route 到无线节点 | NOT TESTED | 无有效真机 route 日志 | 不能由 MQTT PUBLISH 推断 |
| Bridge 发现节点 socket 断开 | PASS | `05b-cross-device-offline.txt` | 仅传输层 |
| 同 ID 重启后 Bridge 再次收到状态 | PASS | 同上 | 仅 Bridge 层 |
| APP 显示节点离线 | NOT TESTED | 无 APP UI/Hilog | 不能由 Bridge 断开替代 |
| APP 同 ID 恢复在线 | NOT TESTED | 无 APP UI/Hilog | 不能由 Bridge 收到状态替代 |

历史 `evidence/2026-10-09-device-validation/README.md` 保持原样，因此其中相冲突的 PASS 不应再被引用为最终结论。

## 5. 最新 APP 真机闭环

本节证据根目录均为 `evidence/2026-10-10-third-device-validation/`。

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| 合法 JSON MQTT GAS 下行 | PASS | `09-cross-device-gas-state.txt`、`bridge/_test/gas-third.json` | 节点从 NORMAL 进入 ALARM，alarmId=`sim-1791598053239-1`；不覆盖第二轮无效 `{cmd:gas}` 的历史 FAIL |
| APP 选择卫生间并显示实时状态 | PASS | `03b-app-bath-before-gas-layout.json`、`04-app-bath-alarm-layout.json`、`05-app-bath-alert-tab-layout.json` | UI 层级直接显示在线、异常告警、GAS 待处理和确认控件 |
| APP 发 route 到正确设备 | PASS | `11-app-correct-ack.txt`、`11b-app-ack-hilog.txt` | homemon、Bridge、`esp32-bath` 和 APP 回程均有对应记录 |
| 远端错误 alarmId 保持 ALARM | PASS | `10-wrong-alarmid-route.txt` | 节点拒绝 `wrong-third-001`，alarmId 不变 |
| 远端正确 alarmId 进入 ACKED | PASS | `11-app-correct-ack.txt`、`11b-app-ack-hilog.txt`、`06-app-bath-acked-layout.json` | APP Hilog 记录下发和设备确认，UI 显示“已闭环” |
| 重复 ACK 被拒绝 | PASS | `12-repeat-ack-route.txt` | 节点因 `state=ACKED` 拒绝，状态保持 ACKED |
| 切换房间后原 pending 正确结算 | PASS | `16-switch-pending-setup.txt`、`10-app-switched-to-living-during-pending-layout.json`、`11-app-bath-closed-after-switch-layout.json` | 等待期间切到客厅；返回卫生间后原告警显示已闭环 |
| 12 秒离线判定 | PASS | `14-sim-stop-and-wait.txt`、`07-app-bath-offline-layout.json` | 10:12:32 停节点，等待 18 秒后 APP 直接显示“卫生间 · 离线” |
| 离线 ACK 拒绝 | PASS | `08b-app-offline-ack-rejected-layout.json` | UI 直接显示“该节点不在线，确认未下发” |
| 同 ID 节点恢复在线 | PASS | `15-recovery-sim-start.txt`、`09-app-bath-recovered-layout.json` | 以 `esp32-bath` 重启后 APP 直接显示在线和本地 TCP 已连接 |

`03-app-bath-before-gas-layout.json` 是锁屏时的无效 APP 证明，使用其 `03b` 替代；`08-app-offline-ack-rejected-layout.json` 是超时中断产生的 1 字节无效文件，使用其 `08b` 替代。

## 6. 真实 ESP32-S3

最终证据目录：`evidence/2026-10-10-final-esp32-and-bridge-hardening/`。

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| 当前源码构建出 BIN/ELF | PASS | `final-flash-stdout.log`、`docs/ARTIFACTS.md` | BIN/ELF 生成时间晚于当前源码 |
| COM9 历史烧录及 COM12 本轮重烧与校验 | PASS | `final-flash-stdout.log`、`evidence/2026-10-13-esp32-final-ack.md` | 本轮由 ESP-ROM/项目名确认 COM12 是 ESP32-S3；bootloader、应用、分区表均 `Hash of data verified`，随后硬复位；COM 编号不是固定映射 |
| ESP32-S3 rev 0.2 启动、Wi-Fi/IP、Bridge TCP | PASS | `evidence/2026-10-10-real-esp32-validation/` 串口日志 | 连接 2.4 GHz `bgn`/BW20 热点；不可称为实际 802.11ac 链路 |
| NTP 同步前 `ts=0` | PASS | 同上 | 设计行为，不能视为回归 |
| 最终固件 13 位真实毫秒状态 | PASS | `final-firmware-status.json` | `ts=1791609077775`，`lastActiveTs=1791608769555` |
| Bridge/MQTT 上行 | PASS | `final-runtime-bridge.out.log`、`final-runtime-broker.out.log` | ESP32 使用原始 TCP；MQTT 由 Bridge 发布 |
| 同 ID 新连接替换旧连接 | PASS | `duplicate-device-results.json` | 真实 Bridge 的独立随机端口集成测试，10 项通过 |
| 最终固件 APP 下行 ACK | PASS | `evidence/2026-10-13-esp32-final-ack.md`、`evidence/esp32-final-acked-ui.json` | 真实 ESP32；错误 ACK 保持 ALARM，正确 ACK 转 ACKED，重复 ACK 被拒绝并保持 ACKED；DAYU UI 显示在线与已确认处理；不是微信手机公网链路 |
| 真实 ESP32 断连与 APP 同 ID 恢复 | NOT TESTED | 无最终硬件 UI 证据 | Bridge 连接测试不能替代 APP UI |
| PIR、门磁、蜂鸣器实物效果 | NOT TESTED | 未接线或无现场记录 | 当前一键脚本默认不启用实体 GPIO；接线后显式使用 `-UsePhysicalSensors` |

## 7. 版本边界

本地 8/8 测试在其冻结时覆盖当时的 `homemon.c`、`mqtt_bridge.js`、`sim_node.js` 和 `node_main.c`，但不覆盖当时已变化的 `Index.ets`。第三轮 `00-preflight.txt` 记录了该轮 APP、Bridge、节点源码、HAP、ARM32 ELF 和脚本指纹，因此第三轮 APP 真机结论只绑定该轮版本，不从早期 8/8 自动外推。

第三轮之后 `homemon.c`、Bridge、模拟节点、ESP32 和启动脚本均有更新，当前指纹见 `ARTIFACTS.md`。`serial-epoch-ms-final.log` 早于最终 `now_ms()` 源码和最终 BIN，只证明中间固件；最终毫秒结论以新冻结目录中的状态快照和烧录日志为准。

## 8. 仍未验收

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| 实体声学输出效果 | PARTIAL | 2026-10-15 耳机重播用药提醒，现场确认听到声音 | 耳机通道单条可听输出 PASS；裸板外放 FAIL；五句话内容、音量、清晰度与破音仍需逐条确认 |
| 最终 ESP32 固件 APP 下行 ACK | PASS | `evidence/2026-10-13-esp32-final-ack.md`、`evidence/esp32-final-acked-ui.json` | 真实 ESP32 错误/正确/重复 ACK 与 DAYU UI 已通过；不外推到微信手机公网链路 |
| 实体 ESP32 传感器/蜂鸣器 | NOT TESTED | 无接线和现场记录 | GPIO 代码存在不等于实物效果通过 |

## 9. YOLO Pose 跌倒检测基线

证据目录：`evidence/2026-10-10-yolo-fall-baseline/`。

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| 时序规则、适配器、HTTP 接帧、发布协调、证据存储与持久补传 56 项测试 | PASS | `docs/evidence/2026-10-14-fall-auto-evidence.md`、`docs/evidence/2026-10-14-evidence-outbox-photo-retention.md` | 含原子索引、损坏隔离、有限保留、断网/重启恢复、SHA 拒绝、evidenceId 冲突规避、非阻塞上传和客户端断连降级处理 |
| YOLO 非方形输入等比例 letterbox | PASS（PC 基线） | 同上 | 当前 Ultralytics 对 1280×720 输入生成 640×384 矩形画布，缩放同为 0.5；不把 APP 控件尺寸当推理坐标 |
| `yolo11n-pose.pt` CPU 加载与推理 | PASS | `evidence/2026-10-10-yolo-fall-baseline/README.md`、`docs/evidence/2026-10-13-camera-aspect-yolo-letterbox.md` | 旧版空场景/人像样例及当前非方形截图推理均通过；当前返回 2 人、`2x17x3` 关键点 |
| MQTT `cmd=fall` 定向映射与防状态回灌 | PASS | Bridge 14 项集成测试 | 本地随机端口；`status-tcp` 不回灌、`listen` 仍 relay、目标节点精确收到一次 `fall\n` |
| homemon `FALL` 真机执行 | PASS | `docs/evidence/2026-10-14-auto-fall-guard.md` | 合成命令生成新 alarmId、ALARM、语音入口与 ACKED；不代表真人检测准确率 |
| APP `FALL` 待处理与 ACK 闭环 | PASS | `auto-guard-final-fall-alarm-tab.json`、`auto-guard-final-acked-app.json` | 真实 DAYU APP；合成 FALL，不是手机公网链路 |
| DAYU 系统摄像头帧获取 | PASS | `docs/evidence/2026-10-13-dayu-final-acceptance.md` | 系统相机真实会话与连续 Capture |
| 自研 APP Camera Kit 4:3 预览与单张 JPEG | PASS | `docs/evidence/2026-10-13-app-camera-preview-photo.md` | 真机 640×480 会话、604×453 Surface 和 931045 字节手动 JPEG |
| USB 有界采样帧 + PC CPU YOLO Pose | PASS | `docs/evidence/2026-10-14-fall-auto-evidence.md` | 当前 `BB994EA9...` HAP 实际送帧、推理、停止和恢复；不是 DAYU NPU |
| APP 前台自动相机监护 | PASS | `docs/evidence/2026-10-14-auto-fall-guard.md`、自动监护 UI dump | Surface 就绪自动启动；显式暂停、恢复、启动中立即暂停、Ability 前后台释放/恢复通过；快速失败后 60 秒慢速自恢复为源码/构建验证 |
| 应用被杀/系统重启/后台持续相机监护 | NOT TESTED | `docs/evidence/2026-10-14-monitor-offline-watchdog.md`（平台能力核对） | 未实现且当前权限下无合法路径：API 26 `BackgroundMode` 无相机类型，需受限 ACL 的类型不可用；只保证 APP 前台 |
| ByteTrack 跨逐请求连续样本 | PASS（PC 基线） | `docs/evidence/vision-tracker-continuity.json` | 6 个逐步水平移位帧的 ID 为 `[1,2]`、`[1,2]`、`[1,2]`、`[1,2]`、`[1]`、`[1,2]`；不代表复杂遮挡/交叉人物 |
| 真人跌倒与误报测试 | NOT TESTED | 无现场视频数据集 | 不宣称准确率或医学诊断能力 |
| 跌倒方向鲁棒性（竖向屈膝 / 朝镜头前倒 / 侧倒） | PASS（离线 + 受控实机） | `evidence/2026-11-02-fall-orientation/`、`evidence/2026-11-02-fall-live-verification/` | 离线：合成矩阵 **7/7 PASS**（3 方向正例全检出 + 坐/蹲/弯腰 0 误报），6 个真实安全会话回放 0 误报，21 项方向鲁棒性单测（全量 79 项，4 项历史失败与本补丁无关）；受控实机：第一批 4 次受控跌倒 4/4 检出；补丁版**交替测试（跌倒→快速深蹲 ×3，18:46:47–18:48:22）= 跌倒 3/3 检出、快速深蹲 0/3 误报**，MQTT 恰好 3 条 `cmd:fall`（`state6.csv` 5 次深蹲 0 事件、`state7.csv` 交叉印证）。**受控动作、非真实跌倒**；真实跌倒录像标定、近景构图支持、SOS/ACK 端到端仍未完成；不宣称准确率/召回率。18:39–18:41 批次归属不清，不作误报/命中率证据 |
| 跌倒机位/构图前提 | PASS（诊断字段+判据保护） / NOT TESTED（现场验收） | `evidence/2026-11-02-fall-live-verification/REAL-MACHINE-ACCEPTANCE-CHECKLIST.md`、`/v1/state` 的 `framing` 字段 | 硬前提：全身入镜、离相机≥2m、站立帧 `hipY<0.70`、`bboxBottom<0.97`；不满足时 `framing.suspectInvalid=True`，该轮数据作废。2026-11-02 两批均因此作废：18:31 批次 bboxBottom≈0.998–1.0、hipY 0.50–0.97 抖动，9 次跌倒仅 2 次检出；新补丁后 18:36:26–18:38:17 批次 45% 帧 bboxBottom≥0.98，仅 2 次 FALLEN、2 次取消——**不作性能依据**。已加保护：bottom-clip 兜底只在仍处站立高度时生效，避免下沉帧被误判直立 |
| 持续视频 FPS/CPU/内存/温升 | NOT TESTED | 仅短时送帧 | 短时约 2 FPS 和代表性耗时不能外推长时性能 |
| 跌倒触发帧原子保存、有限保留与 DAYU 自动拍照去重 | PASS（旧 HAP 本地真机）/ PARTIAL（新清理版） | `docs/evidence/2026-10-14-fall-auto-evidence.md`、`2026-10-14-evidence-outbox-photo-retention.md` | PC 默认 200 条并持久补传；旧 HAP 的 DAYU JPEG 落盘和去重已真机通过；新最多 100 张清理版仅构建通过，待签名安装与 101 张真机测试 |
| 监护失联 watchdog（PC 无帧 → `cmd=monitor` → Bridge → homemon `monitorOnline` → APP） | PASS（本地真机） | `docs/evidence/2026-10-14-fall-auto-evidence.md`、三份 `fall-evidence-watchdog-*.json` | 当前源码真实完成 `online -> no_frame -> frames_resumed`，页面显示失联并恢复；通知仍止于板载 APP，未到公网/手机 |
| Bridge monitor 映射与非法 state 拒绝（新增 2 项断言，合计 16 项） | PASS | 同上 | 本地随机端口真实 MQTT/Socket 集成；精确映射、非法 state 不下发和既有防回灌全部通过；不替代 DAYU 真机 |
| 后台相机 / 开机自启 / 被杀恢复的平台可行性 | NOT TESTED | `docs/evidence/2026-10-14-monitor-offline-watchdog.md`「平台能力核对」 | 核对结论为**未实现**：`BackgroundMode` 无相机类型；未申请 `KEEP_BACKGROUND_RUNNING`/`backgroundModes`；不得用定时器或媒体后台类型伪装 |
| RK3568 RKNN/NPU 推理 | NOT TESTED | 无 toolkit/runtime/转换产物 | 当前是 PC CPU 基线 |

## 10. OneNET、可信后端与手机端

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| 监护人 APP v1 登录与接口合同 | PASS（本地 + 公网 API） | `cloud/backend/test/app-auth.test.js`、`app-contract.test.js`；`docs/APP-API-v1.md` / `.json`；`docs/evidence/2026-10-15-public-cloud-acceptance.md` | 两小时 Bearer、错误凭据拒绝及七组只读合同已由公网入口验收；队友 APP 手机真机仍未测试 |
| APP-only 公网后端 | PASS（PUBLIC BACKEND READY） | `docs/agent-reports/deepseek-local-docker-acceptance.md`、`docs/evidence/2026-10-15-local-docker-codex-review.md`、`docs/evidence/2026-10-15-public-cloud-acceptance.md` | ECS、DNS、Let's Encrypt、80→443、容器健康与真实登录/API 合同通过；不代表家庭网关同步、队友 APP 手机真机或实体 ACK 闭环通过 |
| 家庭网关接入公网后端 | NOT TESTED（入口已实现） | `cloud/onenet/public-sync.js`、`public-sync.test.js` | 隐藏输入 `INGEST_KEY`，状态上行与 ACK 轮询不依赖 OneNET；当前本地 1883/Bridge/设备链路未运行，尚无真实公网设备数据 |
| OneJSON topic、属性/事件和受限下行适配 | PASS | `cloud/onenet/adapter.test.js`，17/17 | 纯协议单测；不代表 OneNET 已联网 |
| OneNET/家庭网关目录全套单元测试 | PASS | `cd cloud/onenet && npm test`，132/132（2026-10-15） | 含协议、Token、传输、网关、后端同步、evidenceId、命令同步和公网安全启动入口；依赖注入测试不代表实体公网闭环 |
| 常驻家庭云网关单元边界（上云限频、告警去重、下行白名单、命令同步接线、停止清理） | PASS | `cloud/onenet/gateway.test.js`，47/47 | 全部依赖注入；不代表已连接真实 OneNET |
| 网关本地分层链路（真实 Broker + 真实 MQTT 报文 + 伪 OneNET） | PASS | `cloud/onenet/gateway-local-integration.js`，14/14 | 真实 `bridge/mqtt_broker.js` 与 `bridge/mqtt_tool.js`；OneNET 侧为伪传输层 |
| DAYU200 真机在线与系统基线 | PASS | `docs/evidence/2026-10-13-dayu-final-acceptance.md` | 1 个脱敏 USB Connected 目标；API 26、OH 7.0.0.38、`aarch64`、`LONG_BIT=32` |
| 板端 homemon 与权威制品一致 | PASS | 同上 | 板端 `sha256sum` 与当前 `homemon-arm` 的 `1ADF93...` 相同 |
| 真实 DAYU 状态经 Broker 到网关并上云 | PASS | `evidence/2026-10-10-onenet-gateway-real-device/gateway-events.jsonl`、`broker.out.log` | 真实板端 `status.json`；上云保留 `deviceId=dayu200-living room=客厅` |
| 真机稳定状态限频 | PASS | 同上 | 同状态连续上报 4 次，property 事件数不增长 |
| 真实板端告警产生 `safetyAlarm` 事件 | PASS | 同上 | `control` 注入 `sos` → 板端产生 `a-1609503175-2 type=MANUAL_SOS` |
| 真机同一 alarmId 不重复告警 | PASS | 同上 | 该 alarmId 事件数 before=1 after=1；板端新产生的 `a-1609503256-3` 正确告警一次 |
| 网关生产入口启动健壮性（`npm run gateway`，无密钥） | PASS | 2026-10-10 实测：进程保持存活、打印 START/LOCAL_SUBSCRIBED，Broker 记录 SUBSCRIBE … home/+/status | 该自检抓出并修复 2 个启动期缺陷：`createGateway` 拒绝 `process.env`、`transportError` 无人监听 |
| 网关驱动真实 OneNET 常驻运行 | NOT TESTED | 未用真实设备密钥常驻运行 | 真机分层验收的 OneNET 侧为伪传输层；不能外推为真实公网常驻 PASS |
| OneNET 产品专属 8883 TLS 入口 | PASS | `evidence/2026-10-10-onenet-gateway-real-device/onenet-8883-tls-live-check.txt`（`tls-live-check.js`，6/6） | 2026-10-10 复测：`rejectUnauthorized=true` 握手成功、官方 CA 验证通过、叶证书指纹与固定值完全一致、CN=`OneNET MQTT`、TLSv1.3。未发送 MQTT CONNECT，不代表设备已激活 |
| OneNET MQTT CONNECT 带凭据 | NOT TESTED（当前） | 需用户本机隐藏输入；历史 PASS 见 `evidence/2026-10-10-onenet-activation/README.md` | 证书层已于 2026-10-10 复测通过（未轮换、未过期），阻塞点只剩凭据注入 |
| OneNET 产品、物模型和首个设备注册 | PASS | 产品 `I19NBBq4xe`；设备 `dayu200-home-gateway` | 设备已激活；一次性检查退出后当前为离线 |
| OneNET 真实设备 Token、MQTTS 认证与属性上行 | PASS | `evidence/2026-10-10-onenet-activation/README.md` | MQTT CONNECT、订阅和 `property/post` 的 OneNET `code=200` 均通过；设备列表最近在线 `2026-10-10 22:08:01` |
| 微信登录/家庭允许名单/查询/ACK 队列、证据与结果 API | PASS | `cloud/backend/test/backend.test.js`、`evidence-store.test.js` 与 `household-auth.test.js`；后端全套 47/47 | 未知 openid 登录 403、旧 token 移除后失权、图片精确绑定/授权读取；本地 HTTP，不是真实微信或公网 |
| 家庭授权隐私边界 | PASS | `backend.test.js`、`persistent-restart.integration.js` | 原始 openid/允许名单不写持久化快照；ACK 仅保存 `household-guardian`；会话 token 仍仅返回给已授权用户 |
| 可信后端原子持久化与正式启动入口 | PASS | `cloud/backend` 全套 47/47 | 单进程版本化 JSON + 独立 JPEG 索引；支持状态 v1→v2 迁移，不代表多实例数据库或公网部署 |
| HTTP 后端关闭/重启恢复与磁盘错误脱敏 | PASS | `persistent-restart.integration.js`，2/2 | 真实本地 HTTP 服务；不含 HTTPS |
| 小程序五页面、HTTPS 限制和 API 聚合 | PASS | `mobile/wechat-miniprogram/tests/run-tests.js`，59 checks | Node 静态与模拟请求；未经过开发者工具和手机真机 |
| 小程序订阅消息授权（用户点击 + 未配置显示 + 唯一调用点 + 接受后登记后端） | PASS | `mobile/wechat-miniprogram/tests/subscribe.test.js`，17/17 | wx + wx.request 打桩：接受/拒绝/禁用/未配置/能力不可用/失败/取消；接受后必须调用登记接口且**不提交 openid**；**授权成功但登记失败不算完全成功**；源码守卫证明唯一调用点在告警页按钮处理函数。**不是真实微信平台授权，也不是真机** |
| 订阅授权登记接口鉴权与幂等（允许登录 ≠ 已订阅） | PASS | `cloud/backend/test/notify-grant-api.test.js`，12/12 | 无 token 401、非名单 403、只能登记自己（请求体里的 openid/recipientRef 被忽略）、同一 grantEvent 幂等、模板不一致 409、未配置 503、reject/ban 不登记；`toRecipients(允许名单)` 只返回已登记且有额度的人 |
| 后端告警订阅消息多监护人独立投递（缺陷 2 修复） | PASS | `cloud/backend/test/notify-multirecipient.test.js`，12/12；`notify-store-e2e.test.js`，6/6 | 幂等键为 deviceId+alarmId+recipientRef：a 成功、b 临时失败时发送序列是 **a,b,b**（修复前是 a,b,a,b，重复消耗 a 的一次性额度）；a 永久失败（43101）**不阻断** b；额度只在微信确认成功后消耗，43101 用独立 `revoked` 字段把该收件人额度校正为 0 |
| 后端告警订阅消息投递（提供者接口 + 重试 + 隐私） | PASS | `cloud/backend/test/notify-delivery.test.js`，33/33 | 注入 fake provider 与内存/临时目录台账：未配置、按人幂等、临时失败退避重试、永久失败停止、token 失效刷新与过期刷新、429/5xx/超时分类、敏感字段不泄漏 |
| 订阅消息不阻塞告警主链路 | PASS | `cloud/backend/test/notify-server-integration.test.js`，7/7 | 真实本地 HTTP 服务 + fake provider：provider 抛异常、永久失败、允许名单回调抛异常时，`/internal/v1/device-status` 仍返回 202；未注入投递器时行为与之前一致 |
| 订阅投递的**启动自动恢复**（缺陷 3 修复） | PASS | `cloud/backend/test/notify-recovery.test.js`，7/7 | 重建 runtime 后**不再手工调用** notifyAlarm 也能自动补发 FAILED 任务；SENT 与 PERMANENT_FAILED 永不重发；恢复被阻塞期间 /healthz、/readyz、设备摄入仍正常返回；关闭后不再新增重试且不留在途 Promise；已移出允许名单的收件人被跳过。当前 `createRuntime` 会调用 `configureRecovery` + `recoverPending`（已用一次性脚本核实 `recoveryEnabled=true`） |
| 订阅消息投递台账与授权额度持久化（schema v4） | PASS | `cloud/backend/test/persistent-store.notifications.test.js`，15/15；`persistent-store.test.js`，11/11 | v1/v2/v3 快照仍可加载（v4 起记录必须带 recipientRef，旧的 2 字段记录被明确拒绝而不是猜测收件人）；按 recipientRef 幂等；未知字段（含 `openid`）拒绝；`recipients` 不再是合法字段；500 条上限；失败回滚；订阅额度 totalGranted/consumed/revoked |
| 真实微信订阅消息已发送成功 | NOT TESTED | 无 | 需要正式 AppID/AppSecret、已申请模板 ID、真实监护人 openid 与用户真机授权；本轮全部使用 fake provider，**不访问微信 API**、不部署公网、不在开发者工具或真机运行 |
| 远程交流：消息状态机、校验与预置语音映射（A/B 级） | PASS | `cloud/backend/test/comms-core.test.js`，24/24 | 六态状态机（QUEUED/DELIVERED/PLAYED/ACKED/FAILED/EXPIRED）；服务端 EXPIRED 是可持久化迁移；DELIVERED 保留租约直到播放结果落盘；终态不可回退、非法跳级被拒、重复回报幂等；voiceId 只允许 5 个固定 ID（路径/命令/URL 一律拒绝）；客户端提交身份字段直接被拒 |
| 远程交流：持久化、幂等与租约（B 级） | PASS | `cloud/backend/test/comms-store.test.js`，22/22 | 真实 PersistentStore：幂等键 = ownerRef+deviceId+clientMessageId；同键异载荷判冲突；并发领取只成功一次；DELIVERED 后崩溃可在租约过期后重领，新租约会拒绝旧代理迟到回报；未领取不能回报送达/播放；容量上限、写失败回滚与字段白名单 |
| 远程交流：监护人/设备 HTTP 接口（C 级） | PASS | `cloud/backend/test/comms-api.test.js`，23/23 | 真实本地 HTTP：未登录 401、非允许监护人 403、不能替别人创建、同载荷幂等重试返回 200、同键异载荷返回 409、未知设备 404；设备状态回报必须绑定当前 leaseId；非法迁移 409、非法输入 400；交流接口坏输入不影响告警摄入/ACK/健康检查 |
| 远程交流：真实快照迁移 v4 → v5（B 级） | PASS | `cloud/backend/test/comms-store.test.js`（迁移用例） | v1/v2/v3/v4 快照均可加载；首次成功变更写 v5 后 **notifications 与 subscriptions 逐字段保持不变**；communication 记录出现 openid 等未知字段时拒绝加载 |
| 远程交流：DAYU 侧代理与预置语音安全映射（B/C 级） | PASS | `southbound/comms-agent.test.js`，40/40；HDC 适配 6/6；southbound 合计 56/56 | `aa start` 参数以 argv 数组构造（无 shell 拼接）；资源名必须过设备侧白名单且**与后端白名单逐项一致**；所有播放状态回报绑定 leaseId；DELIVERED 回报失败时不播放，PLAYED 回报失败时不虚报成功；dryRun 不触碰播放器；HDC 模式只选择唯一 USB Connected 目标，并在所有路径清理 rport |
| 远程交流：播放完成回执协议（B/C 级） | PASS | `southbound/comms-agent.test.js` | 回环一次性监听器（只绑 127.0.0.1、系统分配端口）、256-bit 一次性 nonce、`crypto.timingSafeEqual` 同时核对 messageId+nonce、固定路径 `/playback-result`、重复回执 409、4 KiB 正文上限、无回执超时 `PLAYER_TIMEOUT`、每条消息独立 nonce/端口、所有路径关闭监听器；用 `fake-aa.js` 替身走真实回环 HTTP 端到端 |
| 远程交流：`aa start` 退出码**不等于**播放完成（B/C 级） | PASS | `southbound/comms-agent.test.js` | 显式反例：`aa` 正常退出但**没有回执**时判失败（`PLAYER_TIMEOUT`）；`aa` 非零退出立即 `PLAYER_FAILED`，不空等回执超时；`FAILED` 回执 → 稳定失败码；伪 nonce / 伪 messageId / 非 JSON 回执全部判失败；`completed` 之前不发送 `PLAYED` |
| 远程交流：CLI 端到端（C 级） | PASS | `southbound/comms-cli-integration.test.js`，4/4；`comms-run.test.js`，6/6 | 真实后端 + 真实 CLI 代码路径：创建→领取→PLAYED→ACKED 全链路；退出码 0/1/2/64 语义；密钥可来自环境变量且不出现在输出里；拒绝 `--watch`/`--daemon`（不提供长期驻留） |
| 远程交流：小程序入口（B 级） | PASS | `mobile/wechat-miniprogram/tests/communications.test.js`，27/27；`run-tests.js` 64 checks | 设备/预置语音选择、文本、是否要求确认、发送中状态、六种状态中文映射、失败后显式重试复用同一 clientMessageId；源码守卫证明**不在 onLoad/onShow 自动发送**，且不含"通话/录音"字样 |
| 远程交流：HAP 资源选择与回执源码守卫（A/B 级） | PASS | `northbound/tests/sosvoiceability-guard.test.js`，11/11 | 5 个预置资源白名单存在且与代理白名单一致；读 `want.parameters` 的 4 个参数；`playbackMessageId` 限定为 6-64 位 `[A-Za-z0-9._-]`；任一远程参数出现但上下文不完整时 `CALLBACK_CONTEXT_INVALID`，不误走旧 SOS；拒绝 `/ \ .. : ? # %`；**无路径拼接**；未知资源 `UNKNOWN_VOICE` 且**不回退** `sos.wav`；只有 `completed` 分支回执 `COMPLETED`；旧播放器迟到事件不会干扰当前重试；不含任何密钥或后端地址 |
| 远程交流：unsigned HAP 构建（C+ 级） | PASS | hvigor `assembleHap --mode module -p product=default -p buildMode=debug --no-daemon` | 含五段预置语音后重新构建 `BUILD SUCCESSFUL`；当前产物 `northbound/entry/build/default/outputs/default/entry-default-unsigned.hap`，**1 774 208 字节**，SHA256 `384DD3B8A1196F94BF0F065DD2A6E2D8C850BA64E384CE01692A1EA6E49BB533`；包内 `resources/rawfile/` 共 **6 个文件**（`sos.wav` + 5 个预置语音，5 个预置语音哈希互不相同）；其对应 signed HAP 已在真机安装，见下行真机证据 |
| 预置语音 WAV 校验工具（B 级） | PASS | `tools/tts/wav.test.js`，11/11 | WAV 头/fmt/data 解析、RIFF 长度自洽、仅接受 16-bit PCM、仅接受 16k/24k、时长上下限、静音与削波检测、22.05k→16k 单声道归一化；资源缺失时明确报 BLOCKED 而不是假通过；资源存在时必须全部合法且哈希互不相同 |
| **五个预置语音音频文件（A/B 级）** | **PASS** | `node tools/tts/make-assets.js --check` 退出码 0；`tools/tts/online-tts.test.js`，10/10；`tools/tts/make-assets.test.js`，2/2 | 已生成并校验：16 kHz / 单声道 / 16-bit PCM / 3.711–4.935 s / RMS 0.158–0.170 / 峰值 0.687–0.833 / 有效语音 65–77% / 削波 0.00% / 5 个 SHA-256 互不相同。来源：无密钥在线 TTS（`tools/tts/online-tts.js` 的 `ENGINE` 常量记录了名称、端点与 `requiresKey:false`）+ 系统自带 Media Foundation 解码（`mp3-to-pcm.exe`）；在线端点/解码器不可用时测试正式 `skip`，不会假绿；资源提交采用同卷临时文件、旧文件备份和失败回滚，避免半套覆盖；**未复制 `sos.wav`、未生成静音/纯音/空文件**。注意：这是**软件与文件级校验**，不是人工听觉验收 |
| **DAYU200 真机播放预置语音** | **PASS** | `docs/evidence/2026-10-15-dayu-preset-voice-playback.md` | 当前 HAP 已签名、验签并安装；五个指定资源均在真实 DAYU 上进入 `playing -> completed`，五次匹配 `COMPLETED` 回执经 HDC `rport` 到达真实 PC listener 并获 HTTP 200；未知资源正确返回 `FAILED/UNKNOWN_VOICE` |
| **真实本地后端 -> DAYU -> PLAYED** | **PASS** | `docs/evidence/2026-10-15-real-backend-dayu-played.md` | 真实 PersistentStore 和 HTTP API 创建 `QUEUED` 留言；真实代理领取并报告 `DELIVERED`；DAYU AVPlayer `completed` + nonce 回执后后端变为 `PLAYED`；二次领取 0，HDC 映射清理。首次回执断开时后端正确记 `FAILED`，没有假报。此证据不含公网、手机或实体按钮 `ACKED` |
| 五种语音的**人工听觉验收** | PARTIAL | 2026-10-15 插耳机重播 `medicine_reminder.wav`，现场确认“听到了” | 已证明耳机实际出声；用户尚未确认该句文字、音量、清晰度和破音，其余四句也未逐条听测，因此不能把五种语音整体记为 PASS |
| 老人实体按钮触发 ACKED | NOT TESTED | 无 | 后端 ACKED 接口与代理 `reportAcknowledged()` 已由测试覆盖（打桩/模拟），但 homemon 的实体按钮路径**未做任何改动**，也未在真机上验证。`PLAYED` 不自动等于 `ACKED` |
| 双向实时语音通话 / WebRTC / VoLTE / 自动电话 | 未实现 | 无 | 本工作包只做"文字 + 预置语音 + 播放完成回执"；不包含、也不得宣称包含录音上传、实时通话或自动外呼 |

| 网关聚合状态同步到可信后端 /internal/v1/device-status | PASS | `cloud/onenet/cloud-sync-integration.js`，12/12 | 2026-10-10 新增：真实后端 HTTP 服务 + 真实同步客户端；小程序会话认证后可见设备与告警、ACKED 结清同一告警、错误 ingest key 401、后端不可达安全降级 |
| 家庭网关公网同步（真实 DAYU200 状态） | PASS | `docs/evidence/2026-10-15-public-cloud-acceptance.md`；公网 Caddy 访问日志 | `public-sync.js` 连接真实本地 Broker 与公网 443；43 次 `/internal/v1/device-status` 全部 202、119 次 `/internal/v1/commands` 全部 200；不外推到手机 APP、ESP32 当前在线或实体 ACK |
| Bridge 同 ID 接管/退役缺陷（2026-10-15 修复） | PASS（真机 + 自动化） | `docs/evidence/2026-10-15-bridge-multinode-recovery.md`；`bridge/bridge_multinode.test.js` 37/37 | 根因：homemon 把桥接 `relay` 注入的状态**原样广播回板端连接**，该连接因此出现第二个 deviceId，被 `bindNode()` 判为“改名”并退休；旧代码 `retired` 即永久停止重连（日志文案“已被同 ID 新连接替换，不再重连”其实是通用文案，当时并无新连接）。修复：端点/入站生命周期分离、配置端点优先、relay 回灌抑制、迟到 close 与逐 socket 解绑、3→30s 有界退避。不外推到公网或 ESP32 实体动作 |
| DAYU200 与 ESP32 同时上报 MQTT（真机 60s+ 同窗口） | PASS | 同上；只读 MQTT 订阅 | 62 秒窗口内 `home/dayu200-living/status` 21 条、`home/esp32-bath/status` 13 条，均 13 位非 0、严格递增、与 PC UTC 偏差 <1.3s；修复前同一脚本为 5 条 + 16 条（ESP 时间戳成对重复）FAIL。hdc fport 重建后 DAYU 自动恢复、ESP32 不受影响 |
| Bridge 下行按 deviceId 路由（真机） | PASS | 同上 | 发布 `{"cmd":"motion"}` 到 `home/dayu200-living/cmd` → Bridge 只写入 DAYU 连接，板端 homemon 真实执行“模拟一次人体活动”，`esp32-bath` 写入次数 0；真机未向 ESP32 下发命令 |
| 后端 ACK 命令同步器单元边界 | PASS | `cloud/onenet/command-sync.test.js`，26/26 | 精确定向、真实新回执、幂等、超时和结果 POST 失败重试；伪 MQTT/HTTP，不代表公网或真机 |
| 小程序 ACK 到后端闭环的本地端到端 | PASS | `cloud/onenet/command-sync-integration.js`，13/13 | 真实后端 HTTP 服务 + 真实同步器 + 模拟设备；不含公网 HTTPS、OneNET 公网或实体设备 |
| PENDING 跨重启到 ACKED 再重启查询 | PASS | `cloud/onenet/persistent-command-restart-integration.js`，14/14 | 三次真实本地后端进程生命周期 + 模拟设备；不含公网/实体硬件 |
| 后端 OCI/Dockerfile 本机构建与运行 | PASS（本机） | `docs/agent-reports/deepseek-local-docker-acceptance.md`、`docs/evidence/2026-10-15-local-docker-codex-review.md` | `linux/amd64` 镜像已构建，`USER=node`；容器 `healthy`，数据重启后保留；Codex 独立确认合并配置 `backend.ports=null`、Caddy 仅回环发布 8080/8443，敏感摄入头不进入日志。此 PASS 不外推到公网部署 |
| 后端响应与小程序校验器契约 | PASS | backend 测试直接调用小程序 `normalizeDashboard` | 不含真实微信登录或 OneNET 数据 |
| 正式微信 AppID、合法域名和手机预览 | NOT TESTED | 尚未提供/配置 | 不可由 Node 测试替代 |
| 手机 APP ACK -> 公网后端 -> 真实 DAYU/ESP32 -> ACKED | NOT TESTED | 公网状态上行和命令空队列轮询已真实通过；尚无手机发起命令和实体 ACKED 证据 | 必须由队友 APP 真机创建 ACK，并保存设备回执与公网结清证据 |
| OneNET 真实 `property/set` 下行与设备回复 | PASS | `evidence/2026-10-10-onenet-activation/README.md` | `RESET` 从应用模拟器下发，OneNET 外层 `code=0`、设备回复 `code=200`；一次性处理器未执行 DAYU/ESP32 动作 |
| OneNET 下行驱动真实 DAYU/ESP32 动作 | PARTIAL | `evidence/2026-10-10-onenet-gateway-real-device/`（`reset-acceptance-results.json`、`reset-bridge.out.log`） | **已证明**：网关命令经真实 Bridge 写入板端活动连接，DAYU200 真实执行 `状态复位 -> NORMAL`，网关依据真实回执回复成功。但触发源是本地伪 `property/set`，**未**经真实 OneNET 公网下行 |
| 板端系统时钟（2026-10-14 当前会话） | FAIL | `docs/evidence/2026-10-14-fall-auto-evidence.md` | 当前 DAYU `date -u` 回退到 2017 年；照片有效，但文件名时间不可信；2026-10-13 的已校时 PASS 只代表当时会话 |
| 板端时间回退根因与长期修复（2026-10-15） | PASS（热重启后自动恢复）/ NOT TESTED（真正断电保持性） | `docs/evidence/2026-10-15-dayu-time-recovery.md` | 根因：内核 `hctosys` 取 rtc0(rk808-rtc)，其值为 2017-08-04；电池 RTC rtc1(hym8563) 为 2021-01-03 且非启动时间源；板端无默认路由（`/proc/net/route` 空），`sntp` 存在但不可用。修复：`southbound/dayu-time-sync.js` 经 HDC 下发 PC UTC 并同时写 rtc0/rtc1（读回校验、失败退避、只用唯一 USB Connected 目标），`southbound/src/time_util.h` 统一可信判定，homemon 增启动可信度日志与 `--selftest`，`materials/demo_start.ps1` 增 0b 自动校时步。实测整板热重启后未做任何校时即由 rtc0 恢复正确时间（差 <1s），校时工具返回 `ALREADY_IN_SYNC` |
| 设备状态时间戳可信度与 64 位毫秒 | PASS | `docs/evidence/2026-10-15-dayu-time-recovery.md`；`southbound/dayu-time-sync.test.js` 14/14；`southbound/out/time_util_test.exe` 24/24；板端 `homemon --selftest` 11/11 | 2017 的"合法 13 位毫秒"被判为不可信，2026 有效 epoch 接受；UTC 不重复 +8 小时；ARM32(`long`=4B) 交叉编译 `-Werror` 零告警；真机 24 条采样均 13 位、非 0、单调递增、与 PC UTC 差 ≤923ms |
| DAYU200 状态经 Bridge 到 MQTT（2026-10-15 18:33 之后） | FAIL（既有缺陷，与本轮时间修复无关） | `evidence/2026-10-15-public-sync-runtime/bridge.out.log` L2112、`broker.out.log` 最后一条 `home/dayu200-living` PUBLISH 在第 2117 行 | Bridge 记录 `节点 127.0.0.1:9001 已被同 ID 新连接替换，不再重连` 后不再发布板端状态；同期板端仍在广播（本轮 24 条采样佐证）。需重启 Bridge 才能恢复，本轮按边界未重启 |
| 网关自身 RESET 的本地闭环（伪设备回执） | PASS | `cloud/onenet/gateway-local-integration.js`，14/14 | 真实本地 Broker 与真实 MQTT 报文；回执由验收脚本模拟 |
| 网关自身 RESET 的真机闭环（真实 DAYU 执行 + 真实回执） | PASS | `evidence/2026-10-10-onenet-gateway-real-device/reset-acceptance-results.json`，20/20 | 真实 hdc fport 上的真实 Bridge；板端日志 `状态复位 -> NORMAL`；Bridge 记录 `命令已写入节点 dayu200-living 的活动连接: reset` |
| YED 串口协议通信 | PASS | `evidence/2026-10-11-yed-node-serial-probe/README.md`；Node 工具 17/17；当前 `COM7 @ 115200` 两轮合法回包 | 固件 `YED_DTU4_2.0.3`；默认四项只读查询均有合法 `config,...,ok,...` 回包 |
| YED SIM 识别 | PASS | 真实 `SSTA=2` 后经现场调整转为 `SSTA=3` | 厂家枚举表证明两个状态均已识别 SIM |
| YED 移动网络注册与 CSQ | PASS | 真实两轮 `SSTA=3`、`CSQ=26/30`；厂家定义 3 = 网络正常但未连服务器，CSQ > 17 可稳定工作 | 证明蜂窝注册和有效信号质量；尚未证明数据服务器或 OneNET 连接 |
| YED GNSS 定位 | PARTIAL | 隐私探测核心/CLI 纳入 YED 目录 41/41；真实 COM7 摘要 `GNSS SETTINGS: ENABLED`、`GNSS: NO_FIX` | 已证明 GPS 开启且只读命令受支持；需把 GPS 天线朝上放到室外 60 秒以上取得 `FIXED`，不保存精确家庭坐标 |
| YED -> OneNET 安全直连 | BLOCKED | 厂家公开模板与有证书 SSL 教程均明确限定 Air780；当前为 Y100E `YED_DTU4_2.0.3` | 不允许降级明文 1883 或关闭证书校验；需厂商确认 Y100E 强制校验能力，或改用可信公网中继 |
| Wi-Fi 断开后的 4G 备链 | NOT TESTED | 无现场日志 | 需实际断网和恢复测试 |
| 小程序用户点击后一键拨号 | PARTIAL | `wx.makePhoneCall` 代码存在 | 未在手机上点击验收；不是自动外呼 |
| 自动语音电话 | NOT TESTED | 当前硬件无语音能力证据 | 需要语音蜂窝模块或呼叫服务 |


## 11. AI 语音问答与 ESP32 音箱播报（2026-10-31）

| 内容 | 结论 | 证据 | 边界 |
|---|---|---|---|
| 文字提问 → DeepSeek → 板端显示回答 | PASS | `evidence/2026-10-31-ai-voice/rounds-10.json`、`text-answer.png` | 真实 DAYU + 真实 PC 网关 + 真实 DeepSeek；10 轮回答均为现场生成，无硬编码 |
| 连续 10 轮问答不崩溃/不卡死 | PASS | 同上；10/10 轮 `回答完成`，`total_ms` 2054–2858 ms；`rounds-01-playing.png`、`rounds-10-playing.png`、`rounds-10-final.png` | 测的是 1.0.12 已安装 HAP；每轮均经文字输入，非语音 |
| 两块 ESP32-S3 播放 AI 回答 | PASS（链路）/ NOT TESTED（人耳） | `ai-1.0.12-speaker-playing.png`、`ai-1.0.12-speaker-done.png`；网关日志每轮 `已推送 508960B PCM 到 2 个节点` + 两节点 `done ok=1` | 节点真实解码播放并回执；未做人工听觉验收，不宣称音质/音量 |
| 板端按 TTS 时刻显示“房间音箱正在播报（2 台）” | PASS | `ai-1.0.12-speaker-playing.png` | 计数来自 `tts_start.speakers`，与网关实际连接数一致 |
| 语音输入（说“我有点头晕怎么办”） | PARTIAL | `ai-1.0.12-voice-asr.png`（板端显示 ASR 文本）；`docs/KNOWN-RISKS.md` 远场章节 | 历史 DAYU 板载麦克风路径：硬件正常，但 PC 音箱远场播放时 SAPI 识别错误；S3 板载咪头新路径见第 13 节（真人语音仍未验收） |
| 端到端时延 ≤8 s | PASS | `rounds-10.json`：DeepSeek 953–1920 ms、TTS 776–977 ms、总耗时 2054–2858 ms | 不含 ESP32 播放时长（约 16 s/次，按回答长度），播放期间板端禁用再次提问 |
| HAP 与设备端不含 DeepSeek Key | PASS | 包内 18 个条目扫描 0 命中；设备 `entry.hap` 的 `grep -a -c 'sk-'`/`DEEPSEEK_API_KEY` 均为 0；网关日志 `sk-` 0 次 | 仅证明当前 1.0.12 制品；不覆盖未来构建 |
| 不破坏 SOS/跌倒/ACK/摄像头监护 | PASS（观测） | 9101 两条节点连接保持 ESTABLISHED 且状态文件持续更新；实时状态页“监护运行中 · FRONT · 640×480” | AI 播报与本地告警共用音频锁，告警会等待或经取消抢占；本轮未重复触发 SOS/跌倒 |
| 关闭调试开关后仍可问答 | PASS | `voice-gateway/.work/gateway-final.log`：无回答正文，仍 `推送 508960B PCM 到 2 个节点` 且两节点 `done ok=1` | 该日志是本地临时文件，不作为交付制品 |

## 12. 回答限长 / 老人“我没事”（2026-10-31 晚）

| 内容 | 结论 | 证据 | 边界 |
|---|---|---|---|
| 回答限长后时延下降 | PASS | 网关日志：3 轮总耗时 2160/1957/1872 ms，回答 43/29/32 字（改前 3222 ms/57 字） | 仍为“ASR→DeepSeek→TTS”串行；未做流式 TTS |
| 固定短语“我没事”不调 DeepSeek、不 ACK | PASS | `evidence/2026-10-31-elder-safe/gateway-elder-safe.log`：`elder_safe`、`已记录，不改变告警状态` | 只做本地记录；未新增家属手机事件接口 |
| 两台 ESP32 播报“好的，已记录” | PASS（链路） | 同上：`已推送 127360B PCM 到 2 个节点`，两节点 `done ok=1` | 未做人耳音质验收 |
| 板端解析 `elder_safe` 事件 | PASS（构建/安装） | northbound 1.0.12 signed HAP 已安装；代码含事件分支 | 板端 UI 自动化受输入法/rport 影响，未截图闭环 |
| 告警触发自动开麦 8 秒（旧 HAP 路径） | SUPERSEDED | `northbound/Index.ets` 新告警检测 + `AiVoicePage` 自动录音代码已加 | 已由 S3 `mic_link` 告警后 4 s 录音上传替代（见第 13 节）；旧路径不再是主路径，未整机复验 |

## 13. ESP32-S3 板载咪头与 9303 上传（2026-10-31）

证据根目录：`evidence/2026-10-31-mic-selftest/`。两板新 BIN 与回滚 BIN 及其 SHA-256
见 `firmware/SHA256SUMS.txt`；2026-11-02 13:17 冻结版已刷写并回读校验，旧固件备份在 `evidence/2026-11-02-firmware-refactor/ab/`。
烧录已执行且设备日志显示新命令/新行为，但未保存完整 esptool 校验输出。

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| 厨房 mictest 安静 vs 近场蜂鸣（5 s） | PASS | `logs/kitchen-mictest-silence-5s.log` rms=76 peak=806 → `logs/kitchen-mictest-beep-5s.log` rms=229 peak=1247；均 79360 样本 | 证明近场拾音通路；蜂鸣不是人声，不能外推语音识别率 |
| 卫生间 mictest 安静 vs 近场蜂鸣（5 s） | PASS | `logs/bathroom-mictest-silence-5s.log` rms=11 peak=133 → `logs/bathroom-mictest-beep-5s.log` rms=881 peak=1696；均 79360 样本 | 同上；同期 `climate.valid=false` |
| ES8388 ADC 全 0 根因修复 | PASS | 修复前 `logs/kitchen-mictest-speech.log` rms=0/47360 样本；修复后上述日志；寄存器依据 `ES8388.pdf` | 修复点为 0x02 ADC DLL/Vref、0x03 MICBIAS、0x0A 输入选择；不是靠软件增益掩盖 |
| 立体声下混与时长正确 | PASS | 3 s→47360 样本（≈2.96 s），5 s→79360 样本（≈4.96 s） | 只证明采样与下混；不证明频响/信噪比达标 |
| 采集后播放恢复 | PASS | 每轮 `MIC end playback_restored=1`；`logs/kitchen-alarm-autorecord.log` 与 `logs/bathroom-regression.log` 告警/播报继续工作 | 未做高频连续录放压力测试 |
| 生产固件串口可用 mictest / beep / micupload | PASS | COM9、COM6 日志 | 依赖 USB 串口；不是板端 UI |
| 9303 PC 模拟“我没事” | PASS | `logs/client-9303-sim-elder-safe.log`、`logs/gateway-9303-sim.log`：ASR=我没事（1186 ms）、`elder_safe`、不调 DeepSeek、不 ACK | 隔离实例无音箱节点，未证明实体播报；使用 `.work/sim-im-fine.wav` |
| 真机 S3 4 s 上传 → ASR → DeepSeek → 音箱 | PASS（链路） | `logs/kitchen-micupload-beep.log`：rms=218 peak=830、64000 样本；网关回 `asr 嗯`、DeepSeek `answer`、`speakers=6`，厨房节点收到 228480 B PCM | 声源是板载蜂鸣器近场，ASR 只识别出“嗯”；这是真实音频的真实结果，不是伪造回答；本日志未采集两节点 `done` 回执，`speakers=6` 含残留连接 |
| 告警触发自动录音 4 s | PASS（触发/上传） | `logs/kitchen-alarm-autorecord.log`：`MIC_UPLOAD start reason=NO_MOTION`、64000 样本、`MIC end playback_restored=1` | 用 `NO_MOTION=30 s` 测试配置触发，验后已恢复 1800 s 并重刷；未用真人现场告警复验 |
| 刷机后 3 轮文字问答 + 1 轮“我没事”（PC 模拟板端 9302） | PASS（网关/推送） | `logs/gateway-regression-3q1safe.log`：3 轮 DeepSeek 回答 + 1 轮 `elder_safe`，均返回 WAV | 非 DAYU 屏幕验收、非真人语音；9302 的 `elder_safe` 不带 `speakers` 字段 |
| 真人对着 S3 咪头说“我没事” | NOT TESTED | 无现场人声 | 必须现场补测；不得用蜂鸣器/PC 模拟替代 |
| 门磁 IO37 接线与开合事件 | NOT TESTED（当前读数不可用） | 两板状态均 `door.open=true`、`lastOpenTs=0`；`seq` 增长但无事件 | 固件为 `CONFIG_NODE_DOOR_GPIO=37`；读数说明输入未生效（悬空或未接到 IO37），重接后需重测开/关门 |
| 卫生间温湿度 | FAIL（观测） | `logs/bathroom-mictest-*.log`、`bathroom-regression.log`：`tempC=0.0`、`rh=0.0`、`valid=false` | 本轮未改 I2C1/AHT20 路径；需单独排查，不得计入通过项 |
| 音箱实体可听度 | NOT TESTED | 节点回执 `done ok=1`（历史） | 链路通过不等于人耳音质/音量通过 |

| S3 真人现场“我没事”二次识别 | PASS（现场真人） | `logs/safe-retry-live.log`：`我们是 -> 我没事（conf=0.99）`、`elder-safe`、两台音箱 `done ok=1` | 现场真人近场（rms=52/peak=468）已通过；远场/其他口音未测 |
| 普通问题不误判 safe | PASS（回放证据） | 同日志：`今天天气怎么样` → 正常回答，无 `elder-safe` | 仅测一条普通问题 |

## 14. 老人自述安全：云端记录 + 手机 APP + DAYU200 只读广播（2026-11-01）

证据根目录：`competition/evidence/2026-11-01-elder-safe-app/`。2026-11-01 13:54 公网后端已重新部署，
`GET /api/v1/elder-safe` 返回 200；生产网关已加载 INGEST_KEY；手机 APP 生产构建已显示
“厨房 · 我没事 · 未确认”的成功态截图（`phone-11-production-kitchen.jpg`）；2026-11-01 14:02
进一步完成 **S3 现场真人 + 公网 + 手机 APP 同刻**：`es-3 / esp32-kitchen / 厨房`，截图
`phone-12-production-s3-live.jpg`。

| 项目 | 状态 | 证据 | 边界 |
|---|---|---|---|
| 后端 `POST /internal/v1/elder-safe` + `GET /api/v1/elder-safe` | PASS（单元测试） | `cloud/backend/test/elder-safe-api.test.js` 9 项：正常写入/读回、401、非法输入、手机号脱敏、容量淘汰、跨重启持久化、保留期、limit 夹取、告警不变 | 单元测试用内存/临时文件；未在生产数据卷上复验 |
| 上报不改变原告警/ACK | PASS（本地实例） | 本地后端先注入 `alarm-live-1`（`state=ALARM`），S3 说“没事”后 `acknowledgedAt=0`、`state=ALARM`、`/internal/v1/commands` 无新命令 | 单户本地实例；未在生产库复验 |
| 网关 `elder_safe` 上报云端 | PASS（生产） | `gateway-production-elder-safe.log`：`[elder-safe] 云端已记录 eventId=es-2 room=厨房`；公网 GET 返回 `es-1/es-2` | 事件由 9303 回放真人 WAV 触发，不是 S3 咪头现场实时；S3 现场已在其他项验证 |
| 网关 9302 广播 `s3_asr` / `s3_safe` | PASS | `gateway-board-broadcast.log`：ASR 完成 +1 ms 收到 `s3_safe`；仅文本 JSON，无音频 | 广播订阅端为测试脚本与 DAYU200；未做多客户端压力测试 |
| DAYU200 只读 AI 页 | PASS（1.0.13 实机） | `dayu-01-ai-page-connected.jpeg`、`dayu-02-elder-safe.jpeg`：无录音/输入控件，显示“语音网关已连接”、来源 `s3-sim-test · 测试`、音箱 2 台、绿色“老人自述安全：我没事”、`13:03:39` | 语音输入为 PC 回放 PCM，不是 S3 咪头现场人声 |
| 2 秒内板端可见 | PASS（观测） | 网关 `[S3 ASR] 05:03:38.459` → `s3_safe 05:03:38.460`；板端截图时间 13:03:39 | 不含网络/渲染极端抖动；rport 依赖 USB 连接 |
| 手机 APP 展示“未 ACK”卡片 | PASS（生产） | `phone-11-production-kitchen.jpg`（回放）、`phone-12-production-s3-live.jpg`（现场）：厨房 / 我没事 / 未确认（不影响原告警 ACK） | `phone-11` 为 9303 回放；`phone-12` 为 S3 现场真人 `es-3`，告警仍待确认 |
| 点击卡片跳原告警详情 | PASS（本地联调） | `phone-10-alarm-detail-pending-localstaging.png`：跳转 `alarm-live-1`，状态“待确认” | 仅当事件带 `alarmId`；S3 实采事件当前不带 `alarmId` |
| 失败必须可见 | PASS | `phone-07.png`（部署前生产地址 404 时显示“老人自述安全加载失败”，不伪造数据）；网关未配置 `INGEST_KEY` 时日志明确提示 | 部署后成功态已由 `phone-11` 覆盖 |
| 未配置 INGEST_KEY 时降级 | PASS | `dayu-03-elder-safe-production-mode.jpeg`、`gateway-production-mode.log`：ASR“没事” → 两台音箱 `done ok=1`、板端显示绿色卡片；云端上报被明确跳过 | 手机 APP 收不到该事件，属预期；现已配置 key，生产上报正常 |
| 公网后端部署 | PASS | 2026-11-01 13:54 在 Workbench 上传 5 个后端文件、`build --no-cache`、`up -d`；登录后 `GET /api/v1/elder-safe` 返回 200 与事件 | 只验证当前镜像；重启/回滚需重复部署 |
| 生产 `INGEST_KEY` | PASS | 网关日志“云端上报已启用（INGEST_KEY 已加载）”；未把 key 写入任何证据/日志 | 密钥仍只在 `.secrets` 与本机环境；提交包不得包含 |
| ACK 后自述安全卡隐藏 | PASS | `phone-13-production-after-ack.jpg`：对 `e-1793512949-2` 发起 ACK 后绿卡消失；`ElderSafeLogic` 只看最新一条，最新已闭环则整卡隐藏，不回退旧记录 | 旧事件无 `alarmId` 时仍按同房间+时间兜底；新固件已带 `alarmId` |
| 演示分工：卫生间 AI 问答 / 厨房 KEY1 | PASS（配置） | `dayu-target-bathroom-persisted-1.0.17.jpeg`：重启后“卫生间”仍选中；DAYU 快捷提问文字可靠，卫生间负责网络播报；厨房仅 KEY1 本地健康语音 | 厨房网络 AI 播报不作为验收项 |
| DAYU200 播放音箱选择（1.0.17） | PASS（网关日志） | `dayu-speaker-target-1.0.17.jpeg`：全部/厨房/卫生间；选厨房后日志 `已推送 382720B PCM 到 1 个节点（仅 esp32-kitchen）` | 目标路由已验证；PCM 实机仍可能无声 |
| DAYU200 快捷提问可设置（1.0.16） | PASS（实机） | `dayu-quick-questions-settings-1.0.16.jpeg`：AI 页“设置”进入 4 个输入框，保存到 Preferences；`dayu-quick-qa-1.0.16.jpeg` 为按钮态 | 板载键盘输入较慢；编辑面板需下滑到保存按钮 |
| DAYU200 快捷提问（1.0.15） | PASS（实机） | `dayu-quick-qa-1.0.15.jpeg`：点“我头晕” → 网关 `文字查询` → DeepSeek 43 字 → DAYU 显示回答 | 普通回答 PCM 播报仍无声；仅文字确认 |
| KEY1 一键健康语音（短按） | PASS（人耳） | `gateway-key1-onekey-health.log`：短按 → reason=question → ASR 我不舒服 → 网关先发 `clip=9` 再发 answer → S3 本板播放；卫生间/厨房已确认有声 | 普通问题仍只保证文字，PCM 播报未修复 |
| KEY1 健康语音本地播放 | PASS（人耳） | 两板 `healthtest` 均本地播放 clip=9（93,488B）；卫生间/厨房用户确认有声 | 普通 AI 问答的 PCM 仍无声；本地健康片段为固定文案 |
| KEY1 语音提问 + 房间定向播报 | PASS（日志） | `gateway-key1-health-room-target.log`：`reason=question` → ASR“我不舒服” → 健康建议 → `仅 esp32-kitchen` 1 节点、`done ok=1`；卫生间不播 | 未做人耳双问连续测试 |
| 麦克风底噪 | PASS（实测） | `mic-noise-fix.log`：PGA 0x88→0x44 + 75Hz 高通；安静环境厨房 RMS=9（此前 76~229）；用户确认可用 | 降增益后极端远场识别可能变弱，需现场复测 |
| 提示后强制安全识别 | PASS | `gateway-prompt-forced-safe.log`：`reason=prompt`、ASR 直接“我没事”（此前同一录音自由听写成“我们是老二儿子而”）、云端 `es-12`、两台音箱 `done ok=1`；APP `phone-19` 显示“刚刚” | 仅 prompt 窗口强制；手动 `micupload`/普通提问仍走自由听写 |
| 回执语音实际可听 | PASS（人耳确认） | `gateway-ack-audio-retry.log`：录音结束延迟 600ms 后推 123520B 到 2 节点；厨房/卫生间 `done ok=1`；用户确认“已通知家人”可听 | 音量配置 30；单次现场确认 |
| 提示/回执文案 | PASS（代码+日志） | 固件提示改为“如果您没事，请说没事。”；网关播报“好的，已记录，已通知家人。” | 未做人耳听音验收 |
| 三态展示：未确认 / 等待设备回执 / 已闭环 | PASS | `phone-16`（未确认）、`phone-17`（等待设备回执）、`phone-18-acked-final.jpg`（关联告警已 ACKED，绿卡消失） | `phone-18` 使用已 ACKED 告警 `e-1793516084-3` + 新自述事件；设备回执由厨房节点实际状态验证 |
| S3 上传带 `alarmId`，精确闭环 | PASS | 网关日志 `hello ... alarmId=e-1793515466-2`；云事件 `es-6` 带 `alarmId`；`phone-14` 未 ACK 时显示，`phone-15` ACK 后消失 | 现场硬件已刷带 `alarmId` 固件；旧事件 `es-4/es-5` 仍为空，属历史记录 |
| S3 现场真人“我没事” + 公网事件 | PASS（同刻） | `gateway-production-s3-live.log`：`[S3 录音] esp32-kitchen`、`二次识别 我们是->我没事(conf=0.97)`、`云端已记录 eventId=es-3`；手机 `phone-12` 显示厨房卡片 | 单次现场；远场/口音/连续多轮未覆盖 |
| 本地 clip 经 9102 定向播放（健康问题） | PASS（板端播放）/ 人耳待复验 | `logs/com6-clip-fix.log`：`RX local clip=9 (key-parse)`、`PLAY clip=9 bytes=93488`、11.75s 后 `STOP result=ESP_OK` | 修复前永远解析成 0（静音）；已刷两板，现场听感待确认 |

## 15. 稳定性基线（2026-11-01 晚）

| 项目 | 结果 | 证据 | 边界 |
|---|---|---|---|
| 30 轮稳定性浸泡（7 项/轮） | PASS | `logs/soak-30.txt`：`cycles=30 pass=210 fail=0`，窗口 22:23:30–22:30:36 | 单机单目标 `esp32-bath`；未覆盖多目标并发与小时级 |
| 问答时延 | PASS | 同上：663–1321 ms，均值 924 ms，n=30 | 不含 S3 播放时长（约 7–9 s） |
| 浸泡期推送/回执 | PASS | 同窗口 62 条 push/done，0 断连 / 0 未回执 / 0 错误 | 网关日志口径 |
| 自愈入口 | PASS | `core-supervisor -Once` → `core-start exit=0` | 演示时需让 supervisor 常驻 |
| 自检工具在受限环境 | PASS | Test-Port 改纯 TCP、cloud 走 node fetch、hdc 双次重试 | 改动后 `core-start -CheckOnly`=11/11、`stability -Cycles 1`=7/7 |
| 本地 clip 经 9102 定向播放（修复后） | PASS（板端+串口） | `evidence/2026-11-01-clip-fix-and-soak/`：`RX local clip=9 (key-parse)` → `PLAY 93488B` → 11.75 s → `STOP ESP_OK` | 两板均验证；未单独做人耳记录 |
| 双板固件一致性 | PASS | 两板均刷冻结版并回读校验；`firmware/SHA256SUMS.txt` | 只覆盖本次两个 BIN |
