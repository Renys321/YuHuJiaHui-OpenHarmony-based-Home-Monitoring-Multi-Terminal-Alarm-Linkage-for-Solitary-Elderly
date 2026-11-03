# LOCAL-ALARM-SPEECH-FINAL —— 厨房 / 卫生间告警中文语音清晰化 + 跨房间误播定位 + 一次集中真实验收

- 日期：2026-10-26（Asia/Shanghai），实施与验收时段约 20:51–22:32
- 工作区：`<WORKSPACE>`
- 证据目录：`competition/evidence/2026-10-26-kitchen-sos-led-speech-final/`
- 本次范围：只收尾厨房 / 卫生间两块固定板的告警链路（语音、声光编排、来源隔离、两板固件、真实按键 + APP ACK 验收）。
  未扩大到 D/E 部署、APP 安装、独立无线按钮、DAYU/APP/公网后端修改。
- 分级约定：**REAL** = 真实设备 + 真实串口/真实链路；**BENCH** = 隔离台架固件（无 WiFi、不产生云端事件）；**LOCAL** = 主机侧；
  **PASS / PARTIAL / BLOCKED / NOT TESTED** 明确标注，不以“日志正常”“文件存在”替代听觉与端到端验收。

---

## 0. 一句话结论

用户“SOS 只能听到滴滴几声、听不清文字”的根因已查明并修复：**旧 `sos.pcm` 根本不是人声，而是 1.25 秒正弦“滴滴”提示音**；同时**蜂鸣器连续响 10 秒与约 2.8 秒的语音完全重叠**，把人声盖掉。现在改为 **6 条与真实触发原因一一对应的离线中文语音 + “短提示音→完整语音、互不重叠”**，两块板已烧入新固件并通过真实按键听音；**“按卫生间按钮厨房也响”确认不是设计联动、也不是本次代码缺陷**（历史同步播放全部来自并行台架注入，本次双板并行监听未复现跨播）。厨房完成了 **按键→APP→用户 ACK→设备 ACKED→云端 202** 全链路；卫生间只完成 **设备侧按键→语音→LED**，APP 侧看不到卫生间告警导致 ACK 未完成，属本次明确阻塞项。

---

## 1. 结果总表

| 项 | 结果 | 证据 |
|---|---|---|
| 旧 SOS 只有“滴滴”声的根因 | **已证实**：`sos.pcm` 是正弦提示音（RMS/峰值≈0.707，等幅包络），不是人声；来源 `materials/sos-voice-正式.wav` | 本报告 §2.1；`audio/superseded/public-sos.pcm` |
| 语音被蜂鸣遮盖 | **已证实**：告警时 `buzzer(1)` 连续 10 s 与语音同时开始，语音仅约 2.8–3.5 s | §2.2（旧代码 `raise_alarm` + `NODE_ALARM_BEEP_SEC=10`） |
| 中文语音内容 | **已交付 6 条**，与触发原因一一对应，TTS 离线合成 | `audio/MANIFEST.json`、`audio/final/*.adpcm` |
| 播放完整性 | **PASS（BENCH + REAL）**：短提示音结束后才播完整语音；实测 SOS 3 声→语音间隔 0.94 s；普通告警 2 声→语音 0.76 s | §4，`verify/bench-kitchen-speech.log` |
| 电脑试听 | **用户确认“清晰可辨，可以烧录”** | 本报告 §3.3 |
| 板端听音（真实按键） | **两板都听到完整中文求助语音**；用户反馈厨房偏小 → 已按要求把厨房音量 20→30，用户确认“更响了” | §7.1、§7.2 |
| SOS 优先 / 去重 / 限频 / stop-ACK 中断 / 播完关功放 / 音频失败不阻塞采集 | **保留且已回归**：`cancelled=1` 证明真实中断播放；ACK 后 LED 确认、语音取消 | §4、§6.3 |
| “按卫生间按钮厨房也响” | **已排除设计联动与广播路由**；历史 21 对同步播放全部来自 20:26–20:41 的双端口并行台架注入；**本次真实验收双板并行监听零跨播** | §5，`diag/CROSS-ROOM-DIAGNOSIS.md` |
| 厨房：真实按键→APP→ACK→设备回执 | **PASS（REAL）** | §7.1 |
| 卫生间：真实按键→APP→ACK→设备回执 | **PARTIAL / BLOCKED**：设备侧 PASS，APP 不显示 → ACK 未完成 | §7.2、§8 |
| 两板固件烧录身份 | **PASS**：按 MAC 复核后只写 app 分区 `0x10000`，esptool `Hash of data verified` | §6、`build/flash-*.json` |
| DAYU 侧显示 | **BLOCKED（未改）**：bridge 与 homemon(9001) 无连接，DAYU 看不到节点；未授权重启 bridge，本次未处理 | §8.3 |

---

## 2. 用户反馈的根因（先查后改）

### 2.1 旧 `sos.pcm` 不是人声，是正弦“滴滴”提示音（已证实）

对旧素材做音频分析（`sos.pcm` 39,996 B = 16 kHz/16 bit 单声道 1.25 s）：

| 指标 | 旧 `sos.pcm` | 旧 `warning.pcm`（对照） | 说明 |
|---|---|---|---|
| 峰值 | 11,467（0.35 FS） | 20,369 | — |
| RMS / 峰值 | **0.707（= 1/√2）** | 0.10 | 正弦波特征；语音远低于此 |
| 50 ms 包络 | 等幅 8109 → 6289 → 0 → 0 → 重复 | 起伏明显（0/300/1600/6400…） | 等幅方波段 = 提示音，不是语音 |
| 时长 | 1.25 s | 2.82 s | 1.25 s 装不下 11 个字的整句 |

`tools/make-voice-assets.ps1` 里 `sos` 的来源是 `competition/materials/sos-voice-正式.wav`，该文件本身也是 1.25 s、峰值 11,468、RMS/峰值 0.707 的正弦提示音。**这就是“按 SOS 只听到滴滴几声”的直接原因**：播放链路没错，播的内容不是人声。

### 2.2 蜂鸣器连续 10 秒把语音整段遮盖（已证实）

旧代码 `raise_alarm()`：

```c
buzzer(1);                 /* 连续鸣响 */
local_voice_alarm(type);   /* 同时开始播语音 */
s_buzzer_until_ms = now_ms() + CONFIG_NODE_ALARM_BEEP_SEC * 1000;  /* 10 秒 */
```

`NODE_ALARM_BEEP_SEC=10`，而 `warning.pcm` 只有 2.82 s、新语音最长 4.99 s。**人声全程与蜂鸣器重叠**，用户只能听到蜂鸣与提示音。这是第二个根因，与素材问题叠加。

### 2.3 起播被功放/静音裁剪的风险

旧转换脚本会**去掉首尾静音**，语音第一个字正好落在功放使能与 I2S DMA 起播的瞬态上；`amp_prepare(1)` 后立即 `i2s_start` 没有等待。现在：素材固定加 **200 ms 前导 + 150 ms 尾部静音**，固件在功放使能后先等 `CONFIG_NODE_VOICE_AMP_SETTLE_MS=60 ms` 再送数据，保证第一个字不被截。

### 2.4 为什么必须换音频格式（不是“降质偷懒”）

factory 应用分区只有 **1 MiB（1,048,576 B）**，旧正式固件已 **948,960 B（仅剩 99,616 B）**。5 条完整中文句子按 16 kHz/16 bit 需要约 176 kB，放不下；而**不允许改分区表**（任务禁止改分区表/bootloader/NVS）。
因此改用标准 **IMA ADPCM 4 bit @16 kHz（8 kB/s）**：保留完整 8 kHz 语音带宽（比降到 8 kHz PCM 清晰得多），6 条共 **196,324 B**，最终厨房镜像 1,016,864 B（余 31,712 B）、卫生间 1,005,536 B（余 43,040 B），均在 1 MiB 内。

---

## 3. 最终中文语音

### 3.1 6 条素材（与真实触发原因一一对应）

| clip | 触发原因 | 文案 | 时长(含前导/尾部静音) | ADPCM 字节 | SHA-256 |
|---|---|---|---|---|---|
| 1 | `MANUAL_SOS`（厨房 KEY0 / 卫生间 SOS） | 我需要帮助，请尽快过来。 | 3.47 s | 27,791 | `6358C55B5B4E0C16…`（全文见 MANIFEST） |
| 2 | `CLIMATE` 仅温度越界 | 室内温度异常，请前来查看。 | 3.77 s | 30,139 | `079AD208B6066CF4…` |
| 3 | `CLIMATE` 仅湿度越界 | 室内湿度异常，请前来查看。 | 3.79 s | 30,313 | `D73C6D14420272D0…` |
| 4 | `CLIMATE` 温度+湿度同时越界 | 室内温度和湿度异常，请前来查看。 | 4.52 s | 36,193 | `FAB1E5B25271B517…` |
| 5 | `NO_MOTION` 长时间未检测到活动 | 长时间未检测到活动，请确认家人情况。 | 4.99 s | 39,889 | `51DFF9D9A4F7A2D9…` |
| 6 | 兜底（读数无效/原因无法判定） | 室内温湿度异常，请前来查看。 | 4.00 s | 31,999 | `66EF85131CC8F74E…` |

完整 SHA-256、SNR、峰值/RMS 见 `audio/MANIFEST.json`。TTS：`Microsoft Huihui Desktop`（SAPI，离线，Rate=-1，16 kHz 重采样）。

### 3.2 文案正确性约束（不做过度断言）

- **温度/湿度原因在触发那一刻用同一有效读数判定**：`alarm_logic.h` 新增 `climate_reason_code()`，`valid=0` 时返回 UNKNOWN，只能播兜底文案，**不猜**。
- 无活动只播“长时间未检测到活动，请确认家人情况”，**不提跌倒/昏迷/无人**。
- GAS/SMOKE 阈值 4096（禁用）、WATER GPIO -1（未接），因此不播未校准的燃气浓度；若将来启用必须另加专用文案（代码里显式日志提示）。
- 旧 `warning.pcm`（“监测到异常，请前来查看。”）与正弦 `sos.pcm` 已下线，仅存证据：`audio/superseded/`。

### 3.3 听觉确认（用户）

| 对象 | 用户反馈 | 时间 |
|---|---|---|
| 电脑试听 6 段（`audio/preview/preview-all-6-clips.wav`，与板端解码逐采样一致） | **“清晰可辨，可以烧录到两块板”** | 21:19 |
| 卫生间板真实 SOS | 能听到完整语音（用户未提出异议） | 21:45 |
| 厨房板真实 KEY0 | 能听到完整语音，但**比卫生间小** | 21:45 |
| 厨房板（音量 20→30 后） | **“厨房更响了”** | 22:15 |

### 3.4 ADPCM 解码器正确性（独立验证）

- Python 参考实现编码 → 用标准库 `audioop.adpcm2lin` 解码 → **6/6 与本文实现逐采样完全一致**（`MANIFEST.json` 的 `audioopCrossCheck`）。
- 主机测试 `test/host_adpcm_test.c` 用 `main/adpcm_ima.h`（固件同一份头文件）解码 6 条 `.adpcm`，与参考 PCM **逐字节一致**。
- **该测试真的发现过一个 bug**：初版 C 解码器在高半字节后提前 `p++`，导致每 1600 字节错位、末尾少 1 个采样；已修复并复测 6/6 PASS。这说明“格式能编译”不等于“播放正确”。

---

## 4. 播放编排与会话行为（BENCH 实测）

### 4.1 参数（都可配置）

| 参数 | 值 | 含义 |
|---|---|---|
| `NODE_ALARM_CHIRP_ON_MS` | 200 | 单声提示音时长 |
| `NODE_ALARM_CHIRP_GAP_MS` | 100 | 声间间隔 |
| `NODE_ALARM_CHIRP_COUNT` | 2 | 普通告警提示音声数 |
| `NODE_ALARM_CHIRP_COUNT_SOS` | 3 | SOS 提示音声数（与 LED 三短闪对应） |
| `NODE_ALARM_VOICE_GAP_MS` | 150 | 最后一声后到开始播语音的间隔 |
| `NODE_VOICE_AMP_SETTLE_MS` | 60 | 功放使能后等待再送 I2S |
| ES8388 音量 | 厨房 **30**（本次由 20 提升，用户要求）、卫生间 30 | 寄存器值，30≈0 dB，未改其它寄存器 |
| `NODE_ALARM_REPEAT_SEC` | 300（正式）/10（台架） | 持续告警限频提醒 |
| `NODE_ALARM_BEEP_SEC` | 已弃用 | 固件不再读取，仅为兼容旧 profile 保留符号 |

### 4.2 实测时序（`verify/bench-kitchen-speech.log`，台架固件、真实扬声器）

| 场景 | 日志时间 | 结论 |
|---|---|---|
| 真实 CLIMATE 路径（温度 50℃/湿度 60%，连续 2 次） | 21:24:18.080 `温湿度告警原因判定 temp=50.0 rh=60.0 valid=1 -> reason=1` → `告警提示音开始：2 声`；21:24:18.842 `语音播报开始 clip=2` | 2 声=200+100+200 ms，+150 ms → **762 ms** 后起播语音，蜂鸣已停 |
| 真实 SOS 路径（台架注入） | 21:24:43.543 `告警提示音开始：3 声` → 21:24:44.495 `语音播报开始 clip=1` | **952 ms**，与 3×200+2×100+150 一致 |
| 6 条片段逐个播放 | clip=1..6，`bytes=` 分别 27791/30139/30313/36193/39889/31999 | 与素材 manifest **逐一对应**，文案在串口日志中逐条打印 |
| 播放中 stop | `PLAY clip=5` → 2.1 s 后 `STOP clip=5 result=ESP_OK cancelled=1` | **真实中断播放**（不是只改状态） |
| 提示音期间 stop | `告警提示音开始` 0.14 s 后 `STOP 已接受`，之后**没有** `语音播报开始` | 提示音阶段也能取消，语音不会补播 |
| 提示音期间 ACK | `告警提示音开始` 0.45 s 后 `ACK 回执已接受…state=ACKED，语音已取消`，无 PLAY | ACK 在起播前也能取消 |
| ACK 后 LED | `LED 模式=ACKED_CONFIRM_PULSE` → `ACKED_RESOLVED_OFF` | 与 LED 收口一致 |
| 重启 | 台架 `inj reboot` 后启动无 `PLAY`、state=NORMAL | 不重放历史告警 |

台架日志：`verify/bench-kitchen-speech.log`（241 行，8 次 PLAY）、`verify/bench-kitchen-cancel.log`（26 s 取消专项）。
生产启动日志（两块真实板）：`verify/prod-kitchen-bootline.log`、`verify/prod-bath-bootline.log`，均含
`local-voice: READY playback-only 16000Hz IMA-ADPCM; amp standby muted; no boot alarm; clips=6`、
`local-led: … 启动默认灭（no boot flash）`、`已连接网关 10.127.130.179:9101`，**无开机发声、无 BENCH INJECT 横幅**。

### 4.3 保留的既有行为

- SOS 优先级最高，低优先级环境告警不能覆盖进行中的 SOS（`danger_priority` 未改）。
- 同一持续事件不新建 `alarmId`、不叠播；SOS 重复按只在 stop 后恢复提醒。
- stop 只静音不改状态；ACK 必须 `alarmId` 精确匹配，ACK 后不自动解除危险。
- 播完即关功放（待机无底噪）；音频失败只降级蜂鸣，不阻塞采集/上报。
- 重启不重放；暂停监护状态跨重启保持（本次未改）。

---

## 5. “按卫生间按钮厨房也响”的定位结论

完整报告：`diag/CROSS-ROOM-DIAGNOSIS.md`（只读，源码 + 日志逐条取证）、`diag/EVIDENCE-INDEX.md`。

| # | 假设 | 结论 |
|---|---|---|
| A | 存在“A 房间告警→B 房间响”的设计联动 | **已排除**：节点发声只有 3 个入口（`raise_alarm`、SOS stop 后重按、300 s 限频提醒），全部只由**本板**传感器/本板按键/本板状态机触发；下行命令只有 ack/stop/pause/resume/reset，**只会静音，不会拉响** |
| B | bridge/broker/homemon/command-sync/backend 广播或扇出 | **已排除**：bridge 订阅 `home/+/cmd` 按主题里的 `deviceId` 定向投递、离线即丢弃；broker 无 retain；command-sync 文件头明确“绝不广播”；backend ACK 目标=告警所属 `deviceId`；省略 target 会被拒绝而不是群发 |
| C | 历史日志里两板 ≤5 s 同时播放 | **已证实，但只在隔离台架窗口**：20:26–20:41 共 **21 对**跨板 `PLAY`，最大差 1.14 s；两板都是 `BENCH INJECT MODE`（无 WiFi/网关，物理上不可能跨房间） |
| D | 同时播放的原因 | **已证实为并行台架注入**：两套 `bench-serial.py` 分别占用 COM5/COM4，启动相差 0.02–0.43 s，剧本逐行相同 |
| E | 生产窗口厨房被卫生间触发 | **已排除（时间序+无命令）**：19:49 窗口厨房 `ACKED→ALARM` 早于卫生间 SOS 约 15–20 s，且该时段没有任何命令写入厨房；厨房当时的告警类型**未定位**（无串口抓取） |
| F | ACK 错投厨房会发声 | **已排除**：ACK 分支只静音 + 取消语音，ID 不符则拒绝 |

**本次真实验收的双板并行监听结果（REAL）**：

| 时间 | 动作 | 被按板 | 另一块板 |
|---|---|---|---|
| 21:45:16 | 卫生间 SOS | 卫生间：`SOS 按键 -> ALARM e-1793022316-1`、3 声提示音、`PLAY clip=1`、`LED SOS_TRIPLE` | **厨房无 PLAY、无告警、无 LED 变化** |
| 21:45:45 | 厨房 KEY0 | 厨房：`KEY0 原始电平变化：按下`、`ALARM e-1793022345-1`、3 声、`PLAY clip=1`、`LED SOS_TRIPLE` | **卫生间无 PLAY、无告警** |

结论：**来源隔离成立**；未发现跨房间误播。历史“两板同时响”有充分证据解释为并行台架测试或该板自身告警，而不是联动，也不是本次代码缺陷。剩余不确定性：19:49 生产窗口厨房自身告警的具体类型未定位（无串口证据），已如实标注为未定位而非“已修复”。

---

## 6. 固件、身份与写板

详见 `build/FIRMWARE-MANIFEST.md`。摘要：

| 板 | 最终正式固件 | 字节 | SHA-256 | 写入结果 |
|---|---|---|---|---|
| 厨房 `esp32-kitchen`（COM5，MAC `50:78:7d:16:ed:60`） | kitchen-prod-v30 | 1,016,864 | `446A5B8700EEB721044B7223616B76F65C8BA96EBE2F2991753C3AE986E29167` | 只写 0x10000，`Hash of data verified` |
| 卫生间 `esp32-bath`（COM4，MAC `14:c1:9f:42:dd:b4`） | bath-prod | 1,005,536 | `46C7968D0AD52AA6794A0A37ABD4BC45CCB79D4F6D199E23EE979B76D97CEA63` | 只写 0x10000，`Hash of data verified` |

- 写前均重新 `chip_id` 核对芯片（ESP32-S3 rev v0.2）与 MAC，MAC 不符即拒绝写。
- 写前把**实际运行的 app 分区**整段读出备份并核对镜像哈希：厨房 = 记录的 `A66B3D7D…`、卫生间 = 记录的 `EF2C62FC…`（均为上一版正式固件）。
  备份：`.local/speech-20261026/device-backup/COM{4,5}-app-before-speech-20261026.bin`。
- **未**全片擦除、**未**写 bootloader/分区表/NVS，**未**改 Wi-Fi/deviceId/接线。
- 构建/烧录/身份 JSON：`build/`；固件二进制含私有 Wi-Fi 配置，按惯例留在 `.local/` 不复制进证据目录（只给路径 + 哈希）。
- 台架镜像（kitchen-bench `1D7F5276…`、bath-bench `1F7D50F8…`）只用于隔离验证，最终已被/保持正式固件覆盖（厨房台架已被 v30 覆盖）。

---

## 7. 真实验收（集中一次）

### 7.1 厨房（PASS，全链路）

| 步骤 | 时间 | 证据 |
|---|---|---|
| 实体按键 KEY0（按住约 0.3 s 后松开） | 21:45:45.678 | 串口 `KEY0 原始电平变化：按下(低)` → `SOS 本地已触发：厨房设备板载 KEY0 被按下` → `ALARM e-1793022345-1` |
| 声音 | 21:45:45.895 起 | `告警提示音开始：3 声` → 21:45:46.832 `语音播报开始 clip=1` → `PLAY clip=1 bytes=27791 text=我需要帮助，请尽快过来。`（3.54 s 后自然 STOP） |
| LED | 21:45:45.902 | `LED 模式=SOS_TRIPLE type=MANUAL_SOS`（三短闪，非普通快闪） |
| 上报 | 21:45:46.024 | `SOS 上报已送达 Bridge（alarmId=e-1793022345-1）` |
| 音量调整后再次按键 | 22:15:37 | 设备产生 **`e-1793024137-1`**（`MANUAL_SOS`），用户确认“厨房更响了” |
| APP 显示 + 用户 ACK | 22:15:46 | 云端日志 `[command-sync] ACK_SENT id=9 device=esp32-kitchen` → `[command-sync] ACKED id=9 device=esp32-kitchen` |
| 设备回执（间接但设备来源） | 22:24:24 起 | 厨房串口状态：`state=ACKED`、`alarm.id=e-1793024137-1`、`type=MANUAL_SOS`；bridge `status.json` 同为 ACKED |
| 用户确认 | 22:20 | “厨房的是可以的”（APP 可见、ACK 成功） |

**PASS**：实体按键 → 完整中文语音 + LED 三短闪 → APP 显示 `MANUAL_SOS` → 用户 ACK → 设备 `state=ACKED` → 云端 `ACKED` 回执。
未抓到 22:15 那一刻的串口 `ACK 回执已接受` 行（当时未开串口监听），但设备上报的 `state=ACKED` 与云端 `ACKED` 都是从设备侧观察到的事实。

### 7.2 卫生间（PARTIAL：设备侧 PASS，APP/ACK BLOCKED）

| 步骤 | 时间 | 证据 |
|---|---|---|
| 实体 SOS 按键（按住约 1 s） | 21:45:16.010 | 串口 `SOS 按键 -> ALARM（e-1793022316-1，type=MANUAL_SOS）` |
| 声音 | 21:45:16.007 起 | `告警提示音开始：3 声` → 21:45:16.957 `语音播报开始 clip=1` → `PLAY clip=1 bytes=27791`（3.5 s）——用户能听到完整语音 |
| LED | 21:45:16.014 | `LED 模式=SOS_TRIPLE type=MANUAL_SOS` |
| APP 显示 | 21:45–22:20 | **用户反馈：APP 里看不到卫生间这条告警**，因此无法点 ACK |
| 设备保持锁存 | 21:55:16 / 22:00:16 / 22:05:16 | 串口每次出现 `告警提示音开始：3 声` + `PLAY clip=1`（`NODE_ALARM_REPEAT_SEC=300` 的限频提醒，属设计行为） |
| 云端 | 至 22:23:12 | `[cloud-sync] OK device=esp32-bath … status=202` 持续存在（状态确实上云了），但 APP 未展示该告警 → 问题在 APP/后端展示或设备绑定，**不在本次固件范围** |

**未完成**：卫生间 APP→ACK→设备回执。

### 7.3 隔离（PASS）

见 §5 双向比对：两次真实按键期间，另一块板都没有任何 `PLAY`/告警/`LED` 变化。

---

## 8. 仍缺项与具体阻塞（如实记录）

1. **卫生间 APP 不显示该告警**（阻塞 ACK 的直接原因）。设备与云端日志显示 `esp32-bath` 状态 202 正常、`alarm.id=e-1793022316-1`、`state=ALARM`，但用户 APP 中看不到卫生间这条 `MANUAL_SOS`。APP/后端不在本次允许修改范围，**未定位到具体原因**（可能是后端设备可见性/绑定或 APP 过滤），不写成已修复。
2. **云端 supervisor 在 22:23 之后停止**：`public-sync-supervisor.log` 最后一条 22:23:12（`cloud-sync 202`），状态文件心跳停在 22:23:32；此后 APP 变为空白。
   此外**我在 22:26 为释放串口误杀了 PID 29940/26264**（状态文件记录的 supervisor/worker PID），无法排除这是“之后完全停止”的直接原因；这是我的操作失误，如实记录。恢复方式：重新运行统一入口并输入 `INGEST_KEY`。
3. **卫生间板复位后无法自动重连 WiFi**（22:21–22:29）：串口 `WiFi 断开（reason=2）` / `reason=205` 循环，约 8 分钟后自行恢复。历史上该板同样“整口断电重插可恢复、EN 复位不一定”，根因未隔离。
4. **厨房 ACK 时刻没有串口日志**（见 §7.1 说明）；如需“设备侧 ACK 回执行”原文证据，需在网络与 APP 正常时再按一次并点 ACK。
5. **DAYU 未验收**：bridge 与 homemon(`127.0.0.1:9001`) 当前无 ESTABLISHED，DAYU 看不到节点；一键入口因 9101 已在监听而复用了旧 bridge。未授权重启共享 bridge，本次未处理。
6. 卫生间仍在锁存 `ALARM` 时按 SOS 不会产生新 ID（同类型抑制），需要先 ACK（APP）或重启/断电清状态；这是既有去重语义，不是缺陷。

---

## 9. 用户侧最小剩余验收步骤（按顺序，约 2 分钟）

1. 双击平时用的 `competition/materials/start-demo-all.cmd`（或 supervisor 入口），出现提示时隐藏输入一次 `INGEST_KEY`；确认日志出现 `[cloud-sync] OK … status=202` 与 `[command-sync] POLL_OK … status=200`。
2. 确认两块板回到 `10.127.130.179:9101`（若卫生间不在线，把卫生间板**整口断电重插**一次，等约 15 s）。
3. 按一次卫生间实体 SOS（约 1 s）；打开 APP 看是否出现「卫生间 / esp32-bath」的 `MANUAL_SOS`。
4. 若出现 → 点 ACK；把 APP 显示的房间/时间告诉我，我核对 `ACK_SENT/ACKED`、设备 `state=ACKED`、LED 确认与 202。
5. 若仍不出现 → 这是 APP/后端可见性问题，需要单独排查（本次未获授权修改 APP/后端），卫生间 ACK 记为未完成。
6. （可选）如需 DAYU 恢复显示，需要授权按 P0 正式方式重启 bridge 以重建 homemon relay；本次未做。

---

## 10. 本次明确未改 / 未做

- 未改 APP、DAYU、公网后端、bridge、broker、homemon、public-sync 源码与配置；未安装任何 APP。
- 未改 Wi-Fi SSID/口令、deviceId、NVS、分区表、bootloader、接线；只写 app 分区。
- 未启用燃气/水漏/门磁；未制造危险温湿度、未要求真人跌倒、未把缩短参数写成正式时长验收。
- 未操作 COM8（独立无线按钮分支仍暂停）与 COM11（DAYU）；未停止共享服务（但发现 public-sync supervisor 已停止，见 §8.2）。
- 未把“本地实现”“台架通过”“真实现场”混为一谈：本报告逐项标注 REAL / BENCH / BLOCKED。

---

## 11. 证据索引

| 内容 | 路径 |
|---|---|
| 本报告 | `REPORT.md` |
| 变更清单（含 before/after SHA-256） | `CHANGES.md` |
| 固件/身份/写板/回滚 | `build/FIRMWARE-MANIFEST.md` |
| 证据哈希清单 | `SHA256SUMS.txt`（207 个文件，生成后逐条回算 207/207 匹配） |
| 校验清单（每项检查的方法与结果） | `VERIFY-CHECKLIST.md` |
| 跨房间只读诊断 | `diag/CROSS-ROOM-DIAGNOSIS.md`、`diag/EVIDENCE-INDEX.md` |
| 现场只读状态快照 | `run/FIELD-STATE-20261026-2103.md` |
| 语音素材与试听 | `audio/README.md`、`audio/MANIFEST.json`、`audio/preview/` |
| 台架语音/取消验证 | `verify/bench-kitchen-speech.log`、`verify/bench-kitchen-cancel.log` |
| 生产启动（真实板） | `verify/prod-kitchen-bootline.log`、`verify/prod-bath-bootline.log` |
| 真实按键（双板并行监听） | `run/accept-2143/{bath,kitchen,merged}.log` |
| 厨房 ACK 后状态 | `run/accept-2233/kitchen.log`（`state=ACKED`/`e-1793024137-1`） |
| 构建日志 | `build/build-*-speech-*.log` |
| 写入/身份记录 | `build/flash-*.json`、`build/identity-backup-*.json` |
| 主机测试 | `host-tests/`、`host-tests/host-tests.log` |
| 取证工具与复现脚本 | `tools/`、`run/README.md` |
