# 任务：给「域护家徽」项目加“设备端语音问答（ASR + DeepSeek + TTS）”

## 0. 背景与现状（先读）

项目：`<WORKSPACE>\competition`，独居老人居家安全监测（赛题四）。
当前链路：ESP32-S3 节点（厨房/卫生间）→ PC bridge/broker → public-sync → ECS 后端 → 手机 ArkTS APP；DAYU200（OpenHarmony 7.0.0.38 / API26，32 位用户态）运行板载 APP（bundle `com.dsh.eldercare`）与 homemon（C）。

已确认可用：
- DeepSeek API 可用：key 在 `<WORKSPACE>\competition\.secrets\deepseek_api_key.txt`（**只允许 PC 读取，禁止写入 HAP/固件/日志/聊天**）；端点为 `https://api.deepseek.com/chat/completions`，模型 `deepseek-chat`。
- Windows 已装 **zh-CN SAPI 语音识别器**（`MS-2052-80-DESK`）和 **TTS 语音 Huihui**（`Microsoft Huihui Desktop`），可离线做 ASR/TTS。
- DAYU200 可播放音频（板载 APP 的 `SosVoiceAbility` 已有 AVPlayer 播放实现，参考 `northbound/entry/src/main/ets/sosvoiceability/SosVoiceAbility.ets`）。
- 板载 APP 源码：`competition/northbound`，页面 `entry/src/main/ets/pages/Index.ets`，权限在 `entry/src/main/module.json5`（目前只有 INTERNET/CAMERA，**没有 MICROPHONE**）。
- PC 有 Node、Python（`competition\.venv-vision\Scripts\python.exe`）、hdc（`<WORKSPACE>\tools\hdc\hdc.exe`）。

尚缺：设备端麦克风采集、任意文本 TTS、语音问答 UI/协议。本任务补齐这三块，实现“对着 DAYU200 说话 → 板端显示并语音回答”。

## 1. 目标（Definition of Done）

在 DAYU200 板载 APP 上新增「AI 语音问答」入口：
1. 用户按住/点按录音按钮说一句话（≤10 秒）；
2. 音频经本机 TCP 发到 PC 网关；
3. PC 用 SAPI 做中文 ASR → 文本；
4. 文本发给 DeepSeek（`deepseek-chat`），系统提示限制为“居家安全/生活建议，不做医疗诊断”；
5. 回答文本回传板端显示；
6. PC 用 SAPI Huihui 合成 WAV 回传，板端播放（从板载扬声器/耳机出）；
7. 提供文字输入兜底（麦克风不可用/识别失败时）；
8. 全流程不把 key 写入设备；音频只在 PC 临时目录，问答结束后删除。

验收：
- 说“我有点头晕怎么办” → 板端显示 ASR 文本 → 显示 DeepSeek 回答 → 听到中文语音回答；端到端 ≤ 8 秒；
- 文字输入同样可用；
- 连续 10 轮问答不崩溃、不卡死；
- 不影响原有 SOS/跌倒/ACK/摄像头监护链路；
- HAP 与设备端 grep 不到 DeepSeek key。

## 2. 架构（本任务采用）

```
[DAYU200 板载 APP (ArkTS)]
  录音 AudioCapturer(16k/16bit/mono PCM)
        │  TCP 127.0.0.1:9302（hdc rport 到 PC）
        ▼
[PC 语音网关 voice-gateway (Node.js，零依赖)]
  收 PCM → 存临时 WAV → PowerShell ASR.ps1(SAPI zh-CN) → 文本
        → DeepSeek chat/completions → 回答文本
        → PowerShell TTS.ps1(SAPI Huihui) → WAV
        → 回传板端（文本 + WAV）
        ▼
[DAYU200 板载 APP] 显示文本 + AVPlayer 播放 WAV
```

为什么不放板端：OpenHarmony API26 没有可用的 ASR/TTS API（`@ohos.ai.tts` 不存在；HMS SpeechKit 不适用于 OpenHarmony），板端只做采集/播放最稳。

## 3. 交付物与文件

### A. PC 网关 `competition/voice-gateway/`（新建）

| 文件 | 说明 |
|---|---|
| `server.js` | Node TCP 服务，监听 `127.0.0.1:9302`；协议见 §4；读 key 仅从 `.secrets/deepseek_api_key.txt` 或环境变量 `DEEPSEEK_API_KEY` |
| `asr.ps1` | 入参 WAV 路径；用 `System.Speech.Recognition.SpeechRecognitionEngine` zh-CN + `DictationGrammar` 识别，stdout 输出 JSON `{text}` 或 `{error}`；超时 8s |
| `tts.ps1` | 入参文本+输出 WAV 路径；`SpeechSynthesizer` 选 `Microsoft Huihui Desktop`，输出 16kHz/16bit/mono WAV |
| `README.md` | 启动/测试/故障排查 |
| `test-client.js` | 不带板子也能测：读一个 WAV 发协议、打印 ASR/回答、保存回答 WAV |

启动脚本：`competition/materials/start-voice-gateway.cmd`
```
hdc rport tcp:9302 tcp:9302
node <WORKSPACE>\competition\voice-gateway\server.js
```
（`hdc rport` 使板端连 `127.0.0.1:9302` 转到 PC 9302；板子重插后需重跑。）

### B. 板载 APP 改动 `competition/northbound/`

| 文件 | 改动 |
|---|---|
| `entry/src/main/module.json5` | 增加 `ohos.permission.MICROPHONE`（user_grant）并加入 requestPermissions |
| `entry/src/main/ets/model/AiVoiceClient.ets`（新建） | TCP 客户端：连接 `127.0.0.1:9302`、握手、发送 PCM、接收 JSON/WAV、重连与超时 |
| `entry/src/main/ets/pages/AiVoicePage.ets`（新建） | 录音按钮、状态机（idle/recording/uploading/thinking/playing/error）、显示 ASR/回答、文字输入兜底、权限申请 |
| `entry/src/main/ets/pages/Index.ets` | 首页增加「AI 语音问答」入口（按钮/卡片），跳转新页 |
| `entry/src/main/resources/base/element/string.json` | 新增文案（如需要） |

音频播放可复用 `SosVoiceAbility` 的 AVPlayer 模式：把收到的 WAV 写入 `cacheDir/ai_answer.wav` 后播放；播放完删除。

## 4. 协议（必须按此实现，方便联调）

TCP，小端无关；控制消息为 **一行 JSON（UTF-8，`\n` 结尾）**，二进制帧为 **4 字节大端长度 + 数据**。

板端 → PC：
```json
{"type":"hello","protocol":1}
{"type":"audio_start","codec":"pcm_s16le","rate":16000,"channels":1}
<binary: [u32be len][pcm bytes]> ...（可多帧）
{"type":"audio_end"}
{"type":"text_query","text":"..."}        // 文字兜底
{"type":"ping"}
```
PC → 板端：
```json
{"type":"ready","protocol":1}
{"type":"asr","text":"..."}
{"type":"answer","text":"...","model":"deepseek-chat"}
{"type":"tts_start","codec":"wav","bytes":12345}
<binary: [u32be len][wav file bytes]>
{"type":"tts_end"}
{"type":"error","code":"ASR_FAILED|DEEPSEEK_FAILED|TTS_FAILED|TIMEOUT","message":"..."}
```

要求：单条连接一次问答；服务端 15s 无数据关闭；板端连接失败自动重试 1 次；任何失败都要在 UI 显示可读错误，不能白屏/崩溃。

## 5. 实现步骤（按顺序）

1. **先验证 DAYU200 麦克风**（30 分钟）：
   - 在板载 APP 加最小 `AudioCapturer` 测试（16k/mono/S16LE，录 3s，统计 RMS/最大幅值）；
   - 若幅值接近 0：可能无板载麦克风或权限/路由不对 → 改用 USB 麦克风（OH USB Audio）或改走 ESP32 卫生间板路径（见 §7 备选）；
   - 把结论写进 README。
2. **PC 网关**（半天）：
   - 先单独验证 `asr.ps1`（用 SAPI 自带的 WAV 或手机录一段）与 `tts.ps1`（生成中文 WAV 能播放）；
   - `server.js` 实现协议、DeepSeek 调用、错误码；日志脱敏（key 不出现）；
   - 用 `test-client.js` 端到端跑通（不接板子）。
3. **板端客户端/页面**（1 天）：
   - `AiVoiceClient.ets` 连接/发送/接收；
   - 录音权限、AudioCapturer、PCM 分帧发送；
   - 接收 ASR/回答文本显示；接收 WAV 播放；
   - 文字输入兜底；状态与错误提示。
4. **联调**（半天）：
   - `hdc rport tcp:9302 tcp:9302` → 起网关 → 板端问答；
   - 测 10 轮、断网、网关重启、板端重连；
   - 检查 key 不在 HAP（`grep -r "sk-"`）、音频临时文件清理。
5. **文档**：更新 `voice-gateway/README.md`、`northbound/README.md`、`docs/KNOWN-RISKS.md`（新增语音链路风险）。

## 6. 构建 / 安装 / 运行命令

```powershell
# 板载 APP 构建
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'
cd <WORKSPACE>\competition\northbound
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' assembleHap --no-daemon
# 签名：沿用现有 signing 流程生成 eldercare-signed.hap（或让同事按 RELEASE.md 操作）
# 安装（DAYU200 通过 USB 连接，SN 450100445634303332012847942eca00）
<WORKSPACE>\tools\hdc\hdc.exe install -r entry\build\default\outputs\default\entry-default-unsigned.hap
<WORKSPACE>\tools\hdc\hdc.exe shell "aa force-stop com.dsh.eldercare; aa start -a EntryAbility -b com.dsh.eldercare"

# PC 网关
cd <WORKSPACE>\competition
<WORKSPACE>\tools\hdc\hdc.exe rport tcp:9302 tcp:9302
D:\Node\node.exe voice-gateway\server.js
```

hdc 映射是内存态，**板子重插/重启后必须重新 `rport`**；这个坑已在项目里踩过（9001/9200/9301 同理）。

## 7. 备选路径（只有在板载麦克风不可用时才做）

用**卫生间 ESP32-S3**（已扩 16MB flash / 4MB app，见 `firmware/bathroom/partitions.csv`）：
- 固件加 I2S RX（ES8388 麦克风）+ 通过 WiFi TCP 把 PCM 发到 PC 9302；
- 接收 PC 回的 WAV/PCM 用 I2S TX 播放；
- 其余（ASR/DeepSeek/TTS/协议）复用同一 PC 网关；
- 需改 `firmware/bathroom/main/node_main.c`、`local_voice.c`（ES8388 已初始化），并做音频回归。

## 8. 约束与红线

- **密钥**：只从 `competition\.secrets\deepseek_api_key.txt` 或环境变量读取；禁止写入源码、HAP、固件、日志、聊天；日志里不得出现 key 前缀 `sk-`。
- **隐私**：音频只在 PC 临时目录，问答结束后删除；不把原始音频上传第三方；只把转写文本发给 DeepSeek。
- **医疗红线**：系统提示明确“只做生活/安全建议，不做诊断、不推荐药物”；回答里不得出现诊断结论。
- **不破坏现有链路**：SOS、跌倒、ACK、摄像头监护、public-sync 必须保持可用；新页面不能抢占摄像头/音频导致监护中断。
- **不假装**：ASR/TTS 失败时显示错误并允许文字兜底，不允许返回硬编码假回答。

## 9. 风险与应对（提前告知）

| 风险 | 应对 |
|---|---|
| DAYU200 无板载麦克风/录音无声 | 先用 AudioCapturer RMS 验证；不行换 USB 麦克风或走 ESP32 卫生间路径 |
| SAPI 中文识别率一般 | 5–8 秒短句、安静环境；失败提示重说/文字输入；后续可换 Vosk/Whisper |
| Huihui 音质机械 | 可接受；后续可换 edge-tts（需联网）或更高音质语音包 |
| 延迟 >8s | 网关并行化：ASR 完成后立刻请求 DeepSeek，TTS 流式返回；限制回答 ≤80 字 |
| hdc rport 丢失 | 启动脚本先做 rport；板端连接失败提示“检查网关/映射” |
| 音频与摄像头/告警抢占 | 录音/播放串行，AI 页面不启动相机；SOS 优先级高于 AI |

## 10. 参考代码位置

- 板端音频播放：`northbound/entry/src/main/ets/sosvoiceability/SosVoiceAbility.ets`（AVPlayer/权限/错误处理）
- 板端首页 UI：`northbound/entry/src/main/ets/pages/Index.ets`
- 权限声明：`northbound/entry/src/main/module.json5`
- DeepSeek 客户端参考：`cloud/backend/src/deepseek-client.js`（PC 端 Node 可参考其提示词/超时/错误码）
- 现有 hdc 映射/启动脚本：`materials/start-demo-full.ps1`、`materials/start-demo-supervisor.ps1`

## 11. 完成后请回报

1. 板载麦克风验证结论（有/无、RMS）；
2. 改动文件清单与关键代码位置；
3. 端到端演示命令与 10 轮测试结果；
4. HAP 内无 key 的证据（grep 输出）；
5. 已知问题与后续建议。
