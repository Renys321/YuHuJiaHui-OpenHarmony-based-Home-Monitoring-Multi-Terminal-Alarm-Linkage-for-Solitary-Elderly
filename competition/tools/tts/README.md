# tools/tts — 预置语音生成与校验

本目录负责生成 `northbound/entry/src/main/resources/rawfile/` 下的五段**真实普通话**预置语音。

> **当前状态：五段资源已生成、已校验、已随 unsigned HAP 打包。**
> SAPI 路线在本机不可用（见下文历史记录），实际采用**无密钥在线 TTS + Media Foundation 解码**路线。
> **仍未签名、未安装、未上板**，DAYU200 真机播放仍为 NOT TESTED。

## 交付要求（硬性）

| 文件 | 语义 | 文本 |
|---|---|---|
| `check_in.wav` | 日常问候 | 家里在问候您，请回应一下。 |
| `please_respond.wav` | 请回应 | 请按一下按钮回应家人。 |
| `medicine_reminder.wav` | 用药提醒 | 该吃药了，请按时服药。 |
| `family_message.wav` | 家人留言 | 家人给您留了一句话，请注意收听。 |
| `emergency_contacting.wav` | 正在联系家人 | 正在联系家人，请稍等。 |

- 单声道 / 16-bit PCM / 16 kHz
- 必须是通过校验的**真实语音**：不允许复制 `sos.wav`、不允许静音/纯音/空文件
- 五个文件哈希必须互不相同（`--check` 会显式拒绝重复）

## 快速使用

```bash
# 1) 编译本地工具（Media Foundation 解码器）
node tools/tts/make-assets.js --build

# 2) 生成五段资源（无密钥在线引擎 -> 解码 -> 校验 -> 写入）
node tools/tts/make-assets.js --synth-online

# 3) 校验（CI 友好；打印大小、时长、RMS 与 SHA-256）
node tools/tts/make-assets.js --check

# 覆盖已存在的资源
node tools/tts/make-assets.js --synth-online --force
```

`--synth-online` 是**全有或全无**：任何一段失败都不会写入任何文件。

## 实际采用的路线（三个环节）

| 环节 | 组件 | 说明 |
|---|---|---|
| 1. 引擎 | `tools/tts/online-tts.js` → **Baidu Fanyi web TTS (`gettts`)** | 记录在 `ENGINE` 常量里：名称、端点 `https://fanyi.baidu.com/gettts`、`requiresKey: false`、来源与用途说明。请求只带文本，**不含任何账号、密钥或令牌**。返回 `audio/mpeg`。 |
| 2. 解码 | `tools/tts/mp3-to-pcm.exe`（由 `mp3-to-pcm.cs` 编译） | 用**系统自带**的 Windows Media Foundation Source Reader 把 MP3 解码为 16-bit PCM WAV（目标 16 kHz 单声道）。本机没有 ffmpeg / sox，因此不引入任何第三方依赖。 |
| 3. 校验 | `tools/tts/wav.js`（既有实现，复用） | RIFF/WAVE 解析、fmt 参数自洽、采样率/声道/位深、时长 0.8–20 s、静音与削波检测。**没有第二套标准**；`--check` 与生成流程共用同一份校验器。 |

失败语义全部 fail closed：引擎不可达 / 超时 / HTTP 非 2xx / 内容类型非音频 / 解码失败 /
解出空数据 / 校验不通过 → **明确失败，不写文件、不复制 `sos.wav`、不生成占位音频**。

## 文件清单

| 文件 | 作用 |
|---|---|
| `make-assets.js` | 一键流程：`--build` / `--check` / `--synth-online` / `--synth`（旧 SAPI） |
| `online-tts.js` | 在线引擎请求、失败语义、单段/全量合成 |
| `online-tts.test.js` | 引擎常量、URL 构造、失败语义、可达性探测、端到端校验（离线时明确 skip） |
| `make-assets.test.js` | 资源事务提交与失败回滚；确保中途写入失败不会留下半套新资源 |
| `mp3-to-pcm.cs` / `.exe` | Media Foundation MP3→PCM WAV 解码器 |
| `wav.js` | WAV 解析 / 归一化 / 质量校验（无第三方依赖） |
| `wav.test.js` | 校验工具单测 + "五段资源必须存在、合法且哈希互不相同" |
| `synth-wav.cs` / `.exe` | 旧 SAPI 合成器（本机不可用，保留供其他机器使用） |
| `offline-synth.ps1` | PowerShell 版 OneCore 驱动（本机 WinRT 异步桥接受阻，未采用；需 UTF-8 BOM） |

## 五段资源的实测参数

| 文件 | 采样率 | 声道 | 位深 | 时长 | 大小 | RMS | 峰值 | 有效语音 | 削波 |
|---|---|---|---|---|---|---|---|---|---|
| `check_in.wav` | 16000 | 1 | 16 | 4.467 s | 142988 | 0.1695 | 0.830 | 72.5% | 0.00% |
| `please_respond.wav` | 16000 | 1 | 16 | 3.819 s | 122252 | 0.1580 | 0.687 | 76.8% | 0.00% |
| `medicine_reminder.wav` | 16000 | 1 | 16 | 3.711 s | 118796 | 0.1623 | 0.765 | 65.0% | 0.00% |
| `family_message.wav` | 16000 | 1 | 16 | 4.935 s | 157964 | 0.1652 | 0.833 | 73.6% | 0.00% |
| `emergency_contacting.wav` | 16000 | 1 | 16 | 3.783 s | 121100 | 0.1648 | 0.814 | 69.1% | 0.00% |

SHA-256 见 `docs/ARTIFACTS.md`；五个哈希互不相同。

## 历史记录：为什么不用 Windows SAPI

本机 SAPI 路线**失败**，已排除的排查路径（不要重复）：

- `SAPI.SpVoice` / `SAPI.SpFileStream` PROGID 可创建、语音可枚举
  （`Microsoft Huihui Desktop - Chinese (Simplified)` 可见）
- 但 `ISpVoice::Speak` 在 `SpFileStream`、`SpMemoryStream`、默认音频设备三条路径下
  都以 **0xC0000005** 崩进程，且不可捕获
- 显式 `[STAThread]` 与显式 `Thread.SetApartmentState(STA)` 无效
- `BindToFile` 的 packed / padded / WAVEFORMATEXTENSIBLE 三种格式布局全部返回
  `0x80045001 SPERR_UNSUPPORTED_FORMAT`
- `SpFileStream.Open` 晚绑定与 vtable 两种写法分别返回 `E_INVALIDARG` / `SPERR_UNSUPPORTED_FORMAT`
- `System.Speech`（.NET Framework 4.0）同样崩进程
- 音频渲染端点与 `Audiosrv` 均存在且 Running（不是无声卡）
- WinRT `SpeechSynthesizer` 可创建、中文语音可枚举，但 PS 5.1 无法等待其
  `IAsyncOperation<T>`（泛型信息丢失），自建 vtable 桥接被本机程序集加载策略拒绝

结论：本机没有可用的 SAPI 合成能力，因此改用上面的在线引擎路线。

## 安全边界

- 不使用任何需要账号、密钥或付费的 TTS；请求中不携带任何凭据。
- 生成的音频只含上表中的中文提示语，不含姓名、手机号、地址或其他个人信息。
- `*.exe` / `*.dll` 为本地构建产物，可由 `--build` 重新生成；如仓库不提交二进制请删除后重建。
