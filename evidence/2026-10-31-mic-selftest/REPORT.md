# ESP32-S3 板载咪头接入报告（2026-10-31）

## 1. 范围

把老人语音输入从 DAYU200 迁移到厨房/卫生间 ESP32-S3（DNESP32S3 30_music BSP）的板载咪头：

```text
S3 板载咪头 -> ES8388 ADC -> I2S RX (DIN=GPIO14) -> 9303 PCM 上传
-> Windows SAPI ASR -> 命中“我没事” -> elder_safe（不调 DeepSeek、不 ACK）
-> 9102 音箱播报确认；未命中 -> DeepSeek answer -> TTS -> 9102
```

约束：不常开麦克风；只在告警新建或串口命令时录 3–5 s；采集后必须恢复 DAC/播放；
API Key 不落板端；ASR/TTS/DeepSeek 失败必须显式报错。

## 2. 制品与回滚

目录：`firmware/`，哈希清单：`firmware/SHA256SUMS.txt`。

| 文件 | SHA-256 |
|---|---|
| `NEW-kitchen-mic-app.bin`（1,050,016 B） | `cb71afbc53b6dd02ed6a38653e38c751862919b78471c23c2ff8d23e99ec292e` |
| `NEW-bath-mic-app.bin`（1,039,008 B） | `b4ae5b50cdc3ed4cf223d9cf997e167985dfcff09461b8de4dff55bfd9de187e` |
| `ROLLBACK-kitchen-door-v7-app.bin` | `0aa8144d87d76df3e946fa81a493e67c050cec8c86dafc4aa1d8c3a3170e179b` |
| `ROLLBACK-bath-door-v7-app.bin` | `56d9a8054ec6b1aa0fb19e5390d6744e55fd2b572de722742a799f5c3a8caa6b` |

- 当前 `firmware/kitchen/build/esp32_elder_node.bin` 与 `NEW-kitchen-mic-app.bin` 哈希一致；
  `firmware/bathroom/build/esp32_elder_node.bin` 与 `NEW-bath-mic-app.bin` 哈希一致。
- 两板均只写 app 分区（`0x10000`）；bootloader/分区表备份见 `ROLLBACK-*-bootloader.bin`、
  `ROLLBACK-*-partition.bin`。
- 回滚：`write_flash 0x10000 ROLLBACK-<board>-door-v7-app.bin`。
- 注意：`partitions.csv` 的 factory 分区为 4 MiB，完整备份应 `read_flash 0x10000 0x400000`。
- 本轮未保存完整 esptool `Hash of data verified` 输出；设备串口已出现新命令与新行为，
  且构建产物哈希与证据副本一致。

## 3. 已验证

### 3.1 ES8388 ADC 根因修复

- 修复前：`logs/kitchen-mictest-speech.log`，3 s 采集 47360 样本，`rms=0 peak=0`。
- 根因（ES8388 数据手册，`ES8388.pdf`）：
  - `0x03=0x09` 保持 MICBIAS 掉电；
  - 播放收尾 `0x02=0x0A` 关闭 ADC DLL（bit3）与 ADC 参考电压（bit1）。
- 修复：采集前 `0x03=0xFF` → `0x02=0x00`、`0x0A=0x00`（LINPUT1/RINPUT1 板载 MIC1）
  → 最后 `0x03=0x00`；采集结束 uninstall RX，重跑 `codec_start` 恢复 DAC/功放。
- 立体声交织按 `(L+R)/2` 下混；3 s → 47360 样本，5 s → 79360 样本，时长正确。

### 3.2 咪头自检（近场蜂鸣）

| 板 | 安静 5 s | 蜂鸣 5 s | 日志 |
|---|---|---|---|
| 厨房 | `rms=76 peak=806` | `rms=229 peak=1247` | `logs/kitchen-mictest-silence-5s.log`、`logs/kitchen-mictest-beep-5s.log` |
| 卫生间 | `rms=11 peak=133` | `rms=881 peak=1696` | `logs/bathroom-mictest-silence-5s.log`、`logs/bathroom-mictest-beep-5s.log` |

每轮均有 `MIC end playback_restored=1`。蜂鸣只证明近场拾音通路，**不等于**语音识别率。

### 3.3 9303 协议与“我没事”

- PC 模拟（隔离端口实例，避免影响现场网关）：
  - 客户端：`logs/client-9303-sim-elder-safe.log`
  - 网关：`logs/gateway-9303-sim.log`
  - 结果：`[S3 ASR] 1186ms, text=我没事` → `[elder-safe] S3 自述安全：只记录，不 ACK 告警`
    → 合成确认语（隔离实例无音箱节点，跳过播报）。
- 真机厨房（蜂鸣器近场声源）：`logs/kitchen-micupload-beep.log`
  - `MIC_UPLOAD #1 sent rms=218 peak=830 samples=64000`（4.0 s）
  - 网关回执：`asr text=嗯` → DeepSeek `answer`（`speakers=6`，含 4 条残留连接）
  - 这是真实音频的真实结果，不是伪造回答；不能证明能识别真人语音。

### 3.4 告警自动录音

`logs/kitchen-alarm-autorecord.log`：

```text
MIC_UPLOAD #1 start reason=NO_MOTION seconds=4
MIC end playback_restored=1
MIC_UPLOAD #1 sent rms=74 peak=1926 samples=64000 bytes=128000
```

使用 `NO_MOTION=30 s` 测试配置人为触发，验后已恢复 1800 s 并重刷。ASR 失败时网关如实返回
`ASR_FAILED`，告警保持 pending，没有假回答。

### 3.5 刷机后网关回归

`logs/gateway-regression-3q1safe.log`（PC 模拟板端 9302，非 DAYU 屏幕）：

- 3 轮文字问答均返回 DeepSeek 回答与 WAV：头晕、起夜、煤气关阀；
- 1 轮“我没事”返回 `elder_safe`（“老人自述安全：我没事”），不 ACK，并返回确认 WAV；
- 音箱推送沿用同日 10 轮证据（两节点 `done ok=1`）；本轮未采集音箱回执，也未做人耳验收。

## 4. 未验证（不得外推）

1. **真人对着 S3 板载咪头说“我没事”**：未做。蜂鸣器与 PC 模拟不能替代。
   现场需 0.5 m 内正常音量说话，确认网关出现 `[S3 ASR]` 正确文本、`[elder-safe]`、
   音箱播报确认，且告警未被 ACK。
2. **门磁实物改线**：固件已把厨房/卫生间门磁从 IO14 改到 GPIO2，`voice_pins.h` 编译期检查通过；
   现场线仍在 IO14，因此两板上报 `door.open=true`。必须按 `docs/WIRING-ALL.md` 改线后重测开/关门。
3. **卫生间温湿度**：日志出现 `tempC=0.0 / rh=0.0 / valid=false`。该路径（I2C1 AHT20）本轮未改，
   需单独排查，不能计入通过项。
4. **音箱人耳听感**：链路回执不等于音质、音量、清晰度验收。
5. **自然超时的 NO_MOTION 告警**：只验证了 30 s 测试配置下的自动录音，未等待 1800 s 自然触发。
6. **长时间连续录放压力**：未做高频 mictest/micupload 的稳定性测试。

## 5. 复现

```powershell
# 咪头自检（串口 115200；COM 号会变，按 MAC 核对）
beep on
mictest 5
beep off
micupload

# 9303 协议（PC 模拟）
node test-mic-client.js .work/sim-im-fine.wav s3-simulator 联调 127.0.0.1 9303

# 板端协议回归
node test-client.js --text "我没事"
```

隔离网关实例（不占用现场 9302/9303/9102）：

```powershell
node -r .\evidence\2026-10-31-mic-selftest\tools\port-shift.js voice-gateway\server.js
```

端口映射：9302→19302、9303→19303、9102→19102。网关日志里的 9302/9303/9102
是代码中的常量文案，实际绑定端口以 `netstat` 看到的 19302/19303/19102 为准。

## 6. “我没事”二次识别（2026-11-01 补测，现场 PASS）

### 问题

真人近场说“我没事”时，SAPI 自由听写容易识别成“我们是/我只是”（confidence 0.16–0.20），
直接按 ASR 文本判断会失败；但安全语法单独识别该 WAV 会返回“我没事”（confidence 0.99）。
安全语法对任意语音都会强制给“我没事”，不能盲信。

### 策略

仅当自由听写结果形似安全短语（以“我”开头、以“是/事”结尾、长度 2–4）时，
再用 `asr.ps1 -Mode safe` 复识别一次；两次都命中才进入 `elder_safe`。
普通问题（如“今天天气怎么样”）不满足候选条件，不会触发二次识别，也不会误判。

### 实测（用真人录音 WAV 回放，S3 9303 协议）

```text
[S3 ASR] 安全短语二次识别: 我们是 -> 我没事（conf=0.99）
[elder-safe] S3 自述安全：只记录，不 ACK 告警
音箱播报：已推送 127360B PCM 到 2 个节点
音箱播报完成: esp32-kitchen ok=1 / esp32-bath ok=1
```

普通问题对照：

```text
[S3 ASR] 1249ms, text=今天天气怎么样
[S3 问答] 完成: 总耗时 3123ms
（无 elder-safe）
```

原始日志：`logs/safe-retry-e2e.log`。

### 现场实时结果（2026-11-01 00:54）

```text
MIC_UPLOAD #5 sent rms=52 peak=468 samples=64000 bytes=128000
[S3 ASR] 安全短语二次识别: 我们是 -> 我没事（conf=0.99）
[elder-safe] S3 自述安全：只记录，不 ACK 告警
音箱播报：已推送 127360B PCM 到 2 个节点
音箱播报完成: esp32-kitchen ok=1 / esp32-bath ok=1
```

原始日志：`logs/safe-retry-live.log`。这是现场真人近场说话，不是回放。

### 边界

- 这是**固定短语的工程兜底**，不是通用语义理解；不能外推为“任何说法都能识别”；
- 候选条件可能把“我是不是…”等短句纳入二次识别，但最终仍需安全语法命中，且只影响 S3 采音；
- 真人现场仍需复测：说“我没事” → 日志出现二次识别 → 两台音箱播报 → 告警仍 pending。
