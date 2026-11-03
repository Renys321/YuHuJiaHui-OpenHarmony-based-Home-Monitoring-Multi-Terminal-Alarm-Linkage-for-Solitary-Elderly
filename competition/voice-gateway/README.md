# 守巢 · 设备端语音问答网关

PC 侧零依赖 Node.js 服务，为 DAYU200 提供「录音/文字 → 中文识别 → DeepSeek 回答 → 中文语音」能力。
DAYU200 本身**没有扬声器**，回答语音由局域网内的 ESP32-S3 节点（厨房 / 卫生间）播放。

```
DAYU200 APP ──TCP 127.0.0.1:9302 (hdc rport)──┐
ESP32-S3 咪头 ──TCP <PC LAN IP>:9303──────────┤
                                              ├─ server.js ─ SAPI zh-CN ASR ─ DeepSeek ─ SAPI Huihui TTS
ESP32-S3 音箱 ──TCP <PC LAN IP>:9102──────────┘         │
                                                        └─ PCM 推送（16k/mono/s16le）→ 音箱节点
```

> 2026-10-31 起，语音输入主通道改为 ESP32-S3 板载咪头（9303）；DAYU200 只做显示与文字兜底，
> 不再依赖其板载麦克风。

## 1. 前置条件

- Windows 10/11，已安装 **中文（zh-CN）语音识别器** 与 **Microsoft Huihui Desktop** TTS。
- Node.js（`D:\Node\node.exe` 或 PATH 中的 `node`）。
- DAYU200 用 USB 连接 PC，`hdc list targets` 能看到设备。
- DeepSeek API Key，只放在以下两处之一：
  - 环境变量 `DEEPSEEK_API_KEY`；
  - `competition/.secrets/deepseek_api_key.txt`（单行）。
- 板端 HAP 已授予麦克风权限（`ohos.permission.MICROPHONE`）。

启动脚本：`competition/materials/start-voice-gateway.cmd`
它会先执行 `hdc rport tcp:9302 tcp:9302`，再启动网关。**板子重插或重启后必须重新执行 rport。**

## 2. 端口

| 端口 | 方向 | 用途 |
| --- | --- | --- |
| 9302 | 板端 → PC（127.0.0.1，hdc rport） | DAYU200 问答协议 v1 |
| 9303 | ESP32-S3 → PC（局域网） | S3 板载咪头采音上传 + ASR/问答回执 |
| 9102 | ESP32-S3 → PC（局域网） | 网络音箱 PCM 推送（与告警 9101 完全分离） |

## 3. 板端协议 v1（9302）

文本帧：一行 UTF-8 JSON + `\n`；二进制帧：`[u32 大端长度][WAV 字节]`。
首字节为 `{` 的行按 JSON 解析，其余按二进制帧。

板端 → 网关：

| type | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `protocol` | 握手，网关回 `ready` |
| `audio_start` | `codec=pcm_s16le`、`rate`（16000/44100/48000）、`channels=1` | 开始录音 |
| 二进制 | PCM S16LE | 紧随 `audio_start`，可多次发送 |
| `audio_end` | — | 结束录音并开始问答 |
| `text_query` | `text`（≤500 字） | 文字兜底 |
| `ping` | — | 保活 |

网关 → 板端：

| type | 字段 | 说明 |
| --- | --- | --- |
| `ready` | `protocol` | 握手成功 |
| `s3_asr` | `text`、`node`、`room`、`at` | **广播**：9303 识别完成（只读展示，不含音频） |
| `s3_safe` | `text`、`speakers`、`node`、`room`、`at` | **广播**：命中“我没事/没事”，在 TTS 合成前发出（只读展示） |
| `s3_answer` | `text`、`model`、`speakers`、`node`、`room`、`at` | **广播**：DeepSeek 回答（只读展示，不含音频） |
| `s3_error` | `code`、`message`、`node`、`room`、`at` | **广播**：ASR/TTS/服务失败，板端必须可见 |
| `asr` | `text` | 识别文本（仅本会话语音查询） |
| `elder_safe` | `text` | 命中“我没事/没事”：只记录，不 ACK 告警（`text_query` 直连会话回执；S3 走广播） |
| `answer` | `text`、`model`、`speakers` | DeepSeek 回答；`speakers` 为当时连接的音箱数（仅供参考） |
| `tts_start` | `codec=wav`、`bytes`、`speakers` | 下一帧是 WAV；`speakers` 为本次实际播报节点数 |
| 二进制 | WAV | 板端不再本地播放（无扬声器），只用于确认合成成功 |
| `tts_end` | — | 本次语音结束 |
| `error` | `code`、`message` | 明确失败原因，板端显示并允许文字兜底 |

## 3A. S3 采音协议（9303）

节点（`firmware/common/components/elder_node/mic_link.c`）只在**告警窗口或串口命令**
触发时连接 9303，不做常开麦克风。文本帧同为一行 UTF-8 JSON + `\n`；PCM 帧为
`[u32 大端长度][PCM S16LE]`。

节点 → 网关：

| type / 帧 | 字段 | 说明 |
| --- | --- | --- |
| `hello` | `role="mic"`、`node`、`room` | 握手，网关回 `ready` |
| `audio_start` | `rate=16000`、`channels=1`、`codec="pcm_s16le"` | 仅接受 16 kHz 单声道 |
| 二进制 | PCM S16LE 16 kHz mono | 20 ms 一块（320 样本 / 640 B），边录边传 |
| `audio_end` | — | 结束录音，网关落盘并开始 ASR |

网关 → 节点：

| type | 字段 | 说明 |
| --- | --- | --- |
| `ready` | `protocol` | 握手成功 |
| `asr` | `text` | SAPI 识别文本 |
| `elder_safe` | `text`、`speakers` | 命中“我没事/没事”：只记录，不 ACK 告警 |
| `answer` | `text`、`model`、`speakers` | 未命中固定短语时走 DeepSeek |
| `error` | `code`、`message` | ASR/网络失败时如实返回，不伪造文本 |

约束：单次录音上限 12 s，空闲 120 s 断开；`audio_end` 后网关保存
`.work/recordings/<node>-<时间>.wav`（最多保留 40 个），再复用既有
`transcribe() / synthesize() / pushToSpeakers()`，不复制 ASR/TTS 实现。

## 4. 音箱协议（9102）

节点连入后先发一行：

```json
{"type":"hello","role":"speaker","node":"esp32-kitchen","room":"厨房"}
```

网关每次 TTS 完成后推送：

```json
{"type":"pcm","codec":"pcm_s16le","rate":16000,"channels":1,"bits":16,"bytes":508320}
```

紧跟 `bytes` 个原始 PCM 字节。节点播完回：

```json
{"type":"done","node":"esp32-kitchen","ok":1}
```

节点侧实现见 `firmware/common/components/elder_node/speaker_link.c`：
空闲时保持长连接（TCP keepalive），不因长时间无回答而重连；播放与本地告警共用
`local_voice` 音频锁，保证 SOS 语音与 AI 播报不会同时抢占 I2S。

## 5. 隐私与安全

- 原始音频只在系统临时目录（`eldercare-voice-*`），每次问答结束立即删除。
- **例外**：9303 的 S3 录音会保留在 `.work/recordings/`（最多 40 个，便于复盘），
  属于真实语音，演示/交付前可按需清空该目录。
- **只把转写文本发给 DeepSeek**，不上传音频。
- Key 只在内存中使用；日志与回包如出现形似 `sk-…` 的片段会被替换为 `sk-***`。
- 系统提示限定：只做生活/居家安全建议，不做诊断、不推荐药物；紧急情况建议联系家人或 120。
- ASR / DeepSeek / TTS 任一失败都会返回错误，绝不返回硬编码假回答。

调试开关（默认关闭）：

- `VOICE_GATEWAY_DEBUG_TEXT=1`：日志打印识别文本与回答（现场演示后应关闭）。
- `VOICE_KEEP_WAV=1`：把本次录音保留到 `.work/last-asr.wav`，仅用于排查声学问题。
- `VOICE_SPEAKER_PORT`：覆盖音箱端口，默认 9102。
- `VOICE_MIC_PORT`：覆盖 S3 采音端口，默认 9303。
- `CLOUD_BASE_URL`：老人自述安全上报的后端地址，默认 `https://api.luxunacc.xyz`；
  只允许 `https`（本机回环 `http://127.0.0.1` / `http://localhost` 仅用于本地联调）。
- `INGEST_KEY`：`/internal/v1/elder-safe` 的内部上报密钥；未设置时读取
  `competition/.secrets/ingest_key.txt`（单行）。**只作请求头使用，绝不打印/落盘/回包**。
  未配置时老人自述安全仍会播报并广播，但**不会**上报手机 APP，日志会明确提示。

## 6. 自测

```powershell
# 仅验证 ASR/TTS 脚本
powershell -NoProfile -File asr.ps1 -WavPath C:\tmp\q.wav
powershell -NoProfile -File tts.ps1 -Text "请慢一点起身" -OutPath C:\tmp\a.wav

# 模拟板端走完整协议（含文字查询）
node test-client.js --text "我有点头晕怎么办"

# 模拟 S3 采音上传（9303）：hello → audio_start → PCM → audio_end
node test-mic-client.js .work/sim-im-fine.wav s3-simulator 联调 127.0.0.1 9303
```

2026-10-31 PC 侧 9303 验收：`.work/sim-im-fine.wav`（TTS“我没事”）→ `asr text=我没事`
→ `elder_safe`（不 ACK）→ 两块 S3 收到播报；普通问题 → DeepSeek `answer` → 播报。
真机厨房以蜂鸣/环境声上传 4.0 s，网关 `[S3 录音]`、`[S3 ASR]` 正常；人工说“我没事”
的最终声学验收仍待补（见 KNOWN-RISKS）。

2026-11-01 复测（隔离端口实例，避免影响现场网关）：`../evidence/2026-10-31-mic-selftest/logs/`
下 `gateway-9303-sim.log` 记录 ASR 1186 ms → `elder_safe`；`gateway-regression-3q1safe.log`
记录 3 轮文字问答（DeepSeek）与 1 轮“我没事”（`elder_safe`，返回确认 WAV）。

2026-10-31 真机验收：连续 10 轮文字问答 10/10 完成，总耗时 2.054–2.858 s；每轮两块
ESP32-S3 都收到 PCM 并回 `done ok=1`。原始记录见
`../evidence/2026-10-31-ai-voice/rounds-10.json`，截图同目录 `rounds-*.png`。

## 7. 已知限制

- DAYU200 板载麦克风对**远场/外放回放**的语音识别率有限：现场用 PC 音箱在桌面距离播放
  清晰 TTS 问题，SAPI 仍可能识别成无关短句（同一 WAV 直接送 ASR 可 100% 识别，说明
  识别器与链路正常，瓶颈在声学拾音）。建议真人靠近板子（约 0.5 m 内）正常音量说话；
  识别不准时使用页面下方文字输入。
- 音箱播报依赖 9102 与局域网；没有节点连接时板端会明确提示“未连接音箱”，回答文本仍正常显示。
- SAPI 为 Windows 本机离线能力，换机器需确认 zh-CN 识别器与 Huihui 语音已安装。
- S3 咪头通路已用板载蜂鸣器做近场对比（厨房 rms 76→229，卫生间 11→881），但**真人
  说“我没事”的 ASR 命中仍待现场补测**；PC 外放声源在桌面距离不一定能被 S3 咪头拾到。
- 门磁已从 GPIO14 改到 GPIO2（GPIO14 让给 ES8388 ASDOUT）；**实物线仍接在 IO14 时，
  上报会显示 door.open=true**，必须先按 `docs/WIRING-ALL.md` 改线。

## 8. 回答限长与“我没事”自述安全（2026-10-31 晚）

- DeepSeek System Prompt 限制“尽量不超过 45 个汉字”，`max_tokens` 从 240 降到 120；
- 播报前对回答做 60 字上限截断（优先按句号/问号截断），降低 TTS 音频长度；
- 实测 3 轮：总耗时 **2160 / 1957 / 1872 ms**，回答 43 / 29 / 32 字（改前 3222 ms / 57 字）；
- 命中固定短语“我没事/没事”时返回 `elder_safe` 事件，不调用 DeepSeek、不 ACK 告警，
  仅让音箱播报“好的，已记录，家属会看到。”；日志见
  `../evidence/2026-10-31-elder-safe/gateway-elder-safe.log`；
- 板端 `northbound` 1.0.12 已解析该事件，并加入“告警触发自动开麦 8 秒”逻辑；
  S3 固件改为告警时自动录音 4 秒上传 9303（`mic_link_trigger`），2026-10-31 用
  NO_MOTION=30 s 测试配置验证：`MIC_UPLOAD start reason=NO_MOTION` → 4.0 s 上传 →
  ASR 失败时网关如实回 `ASR_FAILED`，告警保持 pending。

## 9. 老人自述安全：云端上报 + 9302 只读广播（2026-11-01）

S3 命中“我没事/没事”后，网关按顺序做三件事，任何一步失败都不影响前面已完成的部分：

1. **音箱播报**（原有能力，不依赖网络）；
2. **上报云端**：`POST /internal/v1/elder-safe`，带 `x-ingest-key`，5 s 超时，
   失败只写脱敏日志，不阻塞 S3 会话；
3. **广播 9302**：在 TTS 合成前发 `s3_safe`，让 DAYU200 在 2 s 内显示；
   ASR/回答/错误分别广播 `s3_asr` / `s3_answer` / `s3_error`。

约束与实现细节：

- 广播只发文本 JSON，**不发音频**；板端不接受、也不转发录音。
- 广播对象是 9302 上所有已完成握手的连接；连接关闭或写缓冲超过 256 KiB 时
  会被移出广播集合，慢客户端不会拖住语音主链路。
- `s3_*` 广播不带 `alarmId`：网关不掌握云端告警 ID；手机 APP 里点击跳转
  “原预警”仅在事件本身带 `alarmId` 时生效。
- 未配置 `INGEST_KEY` 时，云端上报步骤会被跳过并打印明确日志，
  不影响播报、广播与板端显示。
- 本地联调证据：`../../evidence/2026-11-01-elder-safe-app/`（网关广播日志、
  DAYU200 截图、手机 APP 截图、原告警仍 pending 的截图）。
