# 真机验收证据 · 2026-10-09（两轮）

**执行方**：DeepSeek Harness（仅执行与取证，未修改任何源码/脚本/文档）
**制品冻结**：Codex；**首轮修复**：Claude（`demo_start.ps1` 变量改名）

## 约束遵守

未修改/新建任何源码·脚本·文档（仅本目录与 `bridge\_test` 运行日志）；未 commit/push、未视频、未 RAR、未提交、未烧 ESP32、未重新构建；未泛杀 Node；**发现缺陷只报告不修改**。

---

# 最终结果总表

| 步骤 | 内容 | 结果 | 证据 |
|---|---|---|---|
| 00 | 制品 SHA-256 核验 | **PASS** | [00](00-artifact-hashes.txt) |
| 01 | 设备状态（UDID/uname/API/版本） | **PASS** | [01](01-device-state.txt) |
| 02 | 首轮运行 `demo_start.ps1` | **FAIL**（脚本缺陷，已由 Claude 修复） | [02](02-demo-start-output.txt) · [02b](02b-sh-function-repro.txt) |
| 03 | 重跑 `demo_start.ps1` | **FAIL**（新阻塞：检测手段在本环境失效） | [03-retry](03-retry-demo-start-output.txt) · [03b](03b-fport-owner-diagnosis.txt) |
| 04 | DAYU：SOS→语音链路（say.sh/rc/onCreate/SPEAKER/playing/completed） | **PASS** | [04](04-dayu-sos-voice.txt) · [04d](04d-playback-and-sim.txt) |
| 04 | DAYU：ACK 错误ID / 正确ID / 重复ID | **PASS** | [04c](04c-dayu-ack-clean.txt)（干净重做） |
| 04 | sim_node 上行接入 + 下行命令路由 | **PASS** | [05b](05b-cross-device-offline.txt) |
| 04 | **APP UI 选「卫生间」并确认闭环** | **NOT TESTED** | — |
| 04 | `route` 错误 ID 重组证明仍 ALARM | **NOT TESTED** | — |
| 05 | 停止 sim 后离线检测（bridge 侧已确认断开） | **PASS（bridge 侧）** | [05b](05b-cross-device-offline.txt) |
| 05 | 同 ID 重启自动重新在线 | **PASS** | [05b](05b-cross-device-offline.txt) |
| 05 | **APP UI 显示卫生间离线 / 离线 ACK 被拒** | **NOT TESTED** | — |
| 06 | 结束状态 | 记录 | [06](06-final-state.txt) · [06b](06b-final-state.txt) |

> **总体**：步骤 04（DAYU 语音 + ACK 三态）**完整通过**；步骤 02 因脚本/环境问题失败；涉及 **APP 界面操作**的项一律 NOT TESTED（未用命令冒充）。

---

# 第 1 轮（22:40–22:42）

- **00 PASS**：HAP `202D74EA…1CCB` 与指定值一致；homemon-arm `8D5040F3…`、say.sh `725857B3…` 记录在案。
- **01 PASS**：UDID `4501004456343033…`；`aarch64` / Linux 6.6.101；**API 26**；**OpenHarmony 7.0.0.38**；`LONG_BIT=32`。
- **02 FAIL（缺陷①，已修复）**：`param([switch]$Stop,…)` 与 `$stop = Sh "…"` 命名冲突（PowerShell 变量名不区分大小写）→
  `Cannot convert value "System.String" to type System.Management.Automation.SwitchParameter`。
  最小复现证明 `Sh` 本身正常（[02b](02b-sh-function-repro.txt)）。**Claude 已改为 `$homemonStopOut`，3 处引用，制品哈希未变。**
- 03/04/05 全部 NOT TESTED（被缺陷①阻塞）。

# 第 2 轮（22:45–22:50）

## 步骤 03（重跑脚本）：FAIL —— 新阻塞（缺陷②）

脚本本次推进正确：**先停后推** ✓、**板端 SHA-256 与冻结制品一致** `8d5040f3…` ✓、homemon 启动 ✓，随后中止于：

```
[2/5] 建立 hdc fport tcp:9000 tcp:9000
X 127.0.0.1:9000 的监听进程不是 hdc（实际：），转发未真正生效
```

**根因（[03b](03b-fport-owner-diagnosis.txt)）**：脚本用 `Get-NetTCPConnection` 查 9000 属主，而该 cmdlet 在本执行环境抛
**「拒绝访问」** → `Get-ListenPid` 恒为空 → 脚本误判"转发未生效"。
**反证**：同次运行中脚本自己的 `Test-Port` 已连接成功，且 `netstat` 留有 `127.0.0.1:9000 TIME_WAIT` 记录 → **fport 实际是生效的**。
另注：本 harness 中 `hdc fport` 规则随该次 hdc 命令结束即回收，事后查 `fport ls` 必为空（[03b](03b-fport-owner-diagnosis.txt)）。

**报告建议（未实施）**：属主校验改为不依赖 `Get-NetTCPConnection` 的方式（如 `Test-Port` 通过即视为生效，或读 `hdc fport ls` 输出）。

## 步骤 04：DAYU 语音链路 **PASS**

`homemon.log` / `say.log`：
```
[1791585986] ALARM id=a-1791585986-1 type=MANUAL_SOS detail=老人主动按下随身求助按钮
[1791585986] SAY: 我需要帮助，请尽快联系我
2026-10-10 06:46:26  say.sh 被调用，文本:
2026-10-10 06:46:26  aa start 结果(rc=0): start ability successfully.
```
`hilog` 播放全序列（本次 06:47）：
```
06:47:33.861 SosVoiceAbility onCreate：开始播放求助语音
06:47:33.948 语音已就绪: …/sos.wav (574286 字节, fd=47)
06:47:33.968 音频流已设为 STREAM_USAGE_ALARM（强制扬声器）
06:47:33.979 AVPlayer state = initialized
06:47:34.093 AVPlayer state = prepared
06:47:34.094 播放音量已设为 1.0
06:47:34.119 AudioRouterCenter: 1st device:[SPEAKER], id:[1]
06:47:34.154 AVPlayer state = playing → 开始播报…
06:47:39.890 AVPlayer state = completed     ← 历时 5.736 秒（音频 5.98 秒）
```

## 步骤 04：ACK 三态 **PASS**（[04c](04c-dayu-ack-clean.txt) 干净重做）

| 用例 | 日志 | 状态 | safety.log |
|---|---|---|---|
| A 错误 ID | `ACK 被拒绝：告警 ID 不匹配（当前=a-1791586031-2，收到=a-WRONG-ID-999）` | 仍 `ALARM` ✓ | 0 行 ✓ |
| B 正确 ID | `ACK 已接受：id=a-1791586031-2 处置=本机正确ID处置` | `ACKED` ✓ | 写入 1 行 ✓ |
| C 重复 ID | `ACK 被拒绝：该告警已被确认过（当前状态=ACKED，id=a-1791586031-2）` | `ACKED` ✓ | **未增加**（终态实测 1 行）✓ |

> 首轮 [04b](04b-dayu-ack-three-state.txt) 曾受**外部 ACK 干扰**（1791586006 有一条我未发起的成功 ACK，文本为 APP 默认处置语），故 B 项重做；干扰来源未查明，如实记录。

## 步骤 04/05：跨设备与离线（[05b](05b-cross-device-offline.txt)）

```
[bridge] → home/esp32-bath/status  state=NORMAL room=卫生间 countToday=0     ← 上行接入 ✓
[MQTT] ← home/esp32-bath/cmd: {cmd:gas}                                      ← 下行路由 ✓
[bridge] 无线节点 esp32-bath 断开                                            ← 停止 sim 后离线 ✓
（同 ID 重启后）home/esp32-bath/status 持续上报                                ← 自动重新在线 ✓
```

## 未测项与原因（不得以命令冒充 UI）

| 未测项 | 原因 |
|---|---|
| APP UI 选「卫生间」并确认闭环 | 需在开发板界面点击/输入，本执行方式无法可靠、可复现地操作 UI |
| APP UI 显示卫生间离线 / 离线时 ACK 被拒 | 同上（属 APP 交互层） |
| `route` 错误 ID 重组 → 仍 ALARM | 该 `route` 协议为 Codex 新增机制，本轮未取得其协议定义与用法，未擅自构造 |

---

# 结束状态（[06b](06b-final-state.txt)）

| 对象 | 状态 |
|---|---|
| 板端 homemon | **运行中**（PID 30278，`/data/local/tmp/demo.conf`），状态 `ALARM` |
| 板端 `/data/homemon/` | **保留**：`control`(空)、`daily.txt`、`homemon.log`、`safety.log`(1 行)、`say.log`、`say.sh`(1521B，与冻结制品一致) |
| PC 侧 broker(1883)/bridge(9100)/fport(9000) | **均已结束**（随命令进程树回收） |
| 本轮 sim_node | **已精确停止**（PID 25316 / 2980），未动其他 Node |
| 安全日志 | **未删除** ✓ |

---

# 阻塞汇总

1. **`demo_start.ps1` 步骤 2 的属主校验在本环境恒失败**（`Get-NetTCPConnection` 拒绝访问）→ 脚本无法自动跑通；步骤 04/05 的证据是在**手工建立等价环境**（同一进程树内 fport+broker+bridge）下取得的。
2. **APP UI 相关验收项无法由本执行方式完成** → 按指令记 NOT TESTED。

等待 Codex/Claude 处理阻塞 1 后，可原样重跑步骤 02；UI 项需人工在板上操作并另行取证。
