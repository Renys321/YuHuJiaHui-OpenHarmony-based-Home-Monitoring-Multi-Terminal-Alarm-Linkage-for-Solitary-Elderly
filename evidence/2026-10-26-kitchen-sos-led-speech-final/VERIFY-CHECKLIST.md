# 校验清单（LOCAL-ALARM-SPEECH-FINAL）

自查时间：2026-10-26 22:33（Asia/Shanghai）。全部命令都在本机真实执行，结果如下。
分级：REAL（真实设备/真实链路）/ BENCH（隔离台架固件）/ LOCAL（主机侧）。

## A. 音频内容与格式

| # | 检查项 | 方法 | 结果 | 证据 |
|---|---|---|---|---|
| A1 | 旧 SOS 是不是人声 | 对 `main/voice/sos.pcm` 做包络/峰值/RMS 分析 | **FAIL（这就是根因）**：RMS/峰值=0.707、等幅包络 = 正弦提示音 | `REPORT.md` §2.1、`audio/superseded/public-sos.pcm` |
| A2 | 6 条新语音时长/峰值/RMS/SNR | `tools/make-voice-assets.py` 输出 | 时长 3.47–4.99 s、峰值 0.94–0.99 FS、SNR 20.8–25.1 dB | `audio/MANIFEST.json` |
| A3 | ADPCM 编码是否符合标准 IMA | 与 Python 标准库 `audioop.adpcm2lin` 解码逐采样比对 | **6/6 完全一致** | `MANIFEST.json.audioopCrossCheck` |
| A4 | 固件解码器是否与参考实现一致 | `test/host_adpcm_test.c`（用 `main/adpcm_ima.h`）解 6 条片段 vs 参考 PCM | **6/6 PASS，0 mismatch**（首版曾发现 nibble 指针 bug，修复后复测） | `host-tests/host-tests.log` |
| A5 | 素材是否真的能被电脑播给人听 | `System.Media.SoundPlayer.PlaySync` 播放 `preview-all-6-clips.wav`（34.1 s，实际耗时 4.9 s/条验证为真实渲染） | 用户确认“清晰可辨，可以烧录” | 本报告 §3.3 |
| A6 | 文案是否对得上触发原因 | `alarm_logic.h:climate_reason_code()` 8 条断言（正常/仅高低温/仅高低湿/两者/无效不猜） | **PASS 8/8** | `host-tests/host-tests.log`、`test/host_alarm_logic_test.c` |

## B. 播放编排（台架 + 真实板）

| # | 检查项 | 方法 | 结果 | 证据 |
|---|---|---|---|---|
| B1 | 6 条片段都能被固件按编号播放 | 台架 `inj voice 1..6` | **8 次 PLAY，6 个 clip，bytes 与素材一一对应** | `verify/bench-kitchen-speech.log` |
| B2 | 提示音与语音不重叠 | 台架真实 CLIMATE 路径 | `告警提示音开始 2 声` 762 ms 后 `语音播报开始`；SOS 3 声 → 952 ms | 同上 |
| B3 | 播放中 stop 能真正中断 | 台架 `inj voice 5` 后 2.1 s 发 `stop` | `STOP clip=5 cancelled=1` | `verify/bench-kitchen-cancel.log` |
| B4 | 提示音期间 stop/ACK 能取消语音 | 提示音开始后 0.14 s / 0.45 s 发 stop / ack | 无 `语音播报开始`，ACK 转 ACKED | 同上 |
| B5 | 播完关功放 / 音频失败不阻塞 | 代码路径 + 串口 `STOP …` 后无异常、主循环继续上报 | PASS（沿用既有实现，本次未改） | `main/local_voice.c` |
| B6 | 生产固件启动不发声、不重放 | 真实板 RTS 复位后抓完整启动 | `READY … no boot alarm; clips=6`，无 PLAY；`local-led … 启动默认灭` | `verify/prod-kitchen-bootline.log`、`prod-bath-bootline.log` |

## C. 二进制/身份/写板

| # | 检查项 | 方法 | 结果 |
|---|---|---|---|
| C1 | 两板芯片与 MAC | 写前 `esptool chip_id` | ESP32-S3 v0.2；`50:78:7d:16:ed:60` / `14:c1:9f:42:dd:b4` ✔ |
| C2 | 写前运行镜像 = 记录固件 | 读 app 分区前 N 字节算 SHA-256 | `A66B3D7D…` / `EF2C62FC…` ✔ |
| C3 | 只写 app 分区 | `flash-app.ps1` 记录 | offset `0x10000`，`Hash of data verified`，`fullErase=false` ✔ |
| C4 | 固件里嵌入的是新片段 | `.map` 符号检索 | 6 个 `_binary_*_adpcm_*`，无 `_binary_sos_pcm/_warning_pcm/_test_pcm` ✔ |
| C5 | 分区容量 | bin 大小 vs 1 MiB | 厨房 1,016,864（余 31,712）、卫生间 1,005,536（余 43,040）✔ |
| C6 | 证据目录不含二进制/密钥 | 目录内无 `.bin`；未发现 Wi-Fi 口令字段 | ✔ |

## D. 真实验收（REAL）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| D1 | 厨房 KEY0 → 完整语音 + LED 三短闪 | **PASS**（21:45:45，`e-1793022345-1`，`PLAY clip=1 bytes=27791`，`LED SOS_TRIPLE`） | `run/accept-2143/kitchen.log` |
| D2 | 厨房 → APP → 用户 ACK → 云端回执 | **PASS**（22:15:46 `ACK_SENT id=9 device=esp32-kitchen` → `ACKED`） | `public-sync-supervisor.log` |
| D3 | 厨房 ACK 后设备状态 | **PASS**（`state=ACKED`，`alarm.id=e-1793024137-1`，`type=MANUAL_SOS`） | `run/accept-2233/kitchen.log` |
| D4 | 厨房音量提升到与卫生间一致 | **PASS**（用户：“厨房更响了”） | 报告 §3.3 |
| D5 | 卫生间 SOS → 完整语音 + LED 三短闪 | **PASS**（21:45:16，`e-1793022316-1`，`PLAY clip=1 bytes=27791`，`LED SOS_TRIPLE`） | `run/accept-2143/bath.log` |
| D6 | 卫生间 → APP → ACK → 设备回执 | **BLOCKED**：用户 APP 中看不到卫生间这条 `MANUAL_SOS`，无法 ACK；设备保持 ALARM 并按 300 s 限频重复提醒（21:55/22:00/22:05 有串口证据） | 报告 §7.2、§8 |
| D7 | 跨房间隔离（按卫生间时厨房不响） | **PASS**：卫生间按键期间厨房无 PLAY/无告警/无 LED 变化 | `run/accept-2143/` 双份日志 |
| D8 | 跨房间隔离（按厨房时卫生间不响） | **PASS**：厨房按键期间卫生间无 PLAY/无告警 | 同上 |
| D9 | APP/云端链路当下可用 | **PASS（21:51–22:23）**：`cloud-sync 202` + `POLL_OK 200`；**22:23 后停止**（见报告 §8.2） | `public-sync-supervisor.log` |
| D10 | DAYU 显示 | **BLOCKED**：bridge 与 homemon(9001) 无连接；未重启共享 bridge | 报告 §8.3 |

## E. 主机测试汇总

```
alarm_logic(public)          PASS=141 FAIL=0
alarm_logic(bath)            PASS=54  FAIL=0
bathroom_logic(bath, +8 new) PASS=62  FAIL=0
bathroom_logic(public)       PASS=54  FAIL=0
adpcm decoder vs audioop     6/6 PASS (0 mismatch)
node profile tests           kitchen 1/1 pass; bathroom 3/3 pass
```
完整输出：`host-tests/host-tests.log`。

## F. 证据完整性

`SHA256SUMS.txt`：207 个文件，**自查 207/207 匹配，0 缺失/0 不一致**（生成后立即逐条回算）。
