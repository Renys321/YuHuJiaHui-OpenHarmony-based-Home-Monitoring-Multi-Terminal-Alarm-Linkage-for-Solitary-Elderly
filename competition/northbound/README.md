# northbound — 监护人侧 APP（ArkTS / DevEco）

> **源码主线与版本策略（2026-10-28 起，重要）**
>
> 本目录已与 `competition/experiments/dayu-eldercare-preview-integration-2026-10-25` 统一。
> **experiments 线是唯一维护主线（canonical）**，本目录是它的**发布快照 + 构建/签名入口**：
> 源码、资源、`AppScope/app.json5`、测试与构建脚手架由 experiments 当前快照同步而来；
> `signing/` 保留为本项目签名资产（`app-chain.pem`、`final-profile.p7b`、`eldercare.p7b` 等），
> 同步脚本不写 `signing/`。
>
> - 同步/快照/校验脚本（带 dry-run、备份与 SHA-256 校验）：
>   `competition/evidence/2026-10-28-three-legacy-closures/source-unify/scripts/00-snapshot-archive-sync.ps1`
> - 旧 1.0.0 源码归档（含事故恢复说明）：
>   `competition/evidence/2026-10-28-three-legacy-closures/source-unify/northbound-1.0.0-archive/`
> - 构建/签名/验签脚本：
>   `.../source-unify/scripts/01-build-verify-sign-1.0.10.ps1`；发布记录见 [`RELEASE.md`](RELEASE.md)
> - 版本策略：`bundleName` 固定 `com.dsh.eldercare`；版本号只递增、不重复；当前
>   **1.0.12 / 1000012**（2026-10-31 增加 AI 语音问答与房间音箱播报）。
>   1.0.10 是合并等价基线，1.0.11 为 AI 页首版。
> - `signing/eldercare-signed.hap` 是 **1.0.0 历史回退包**（1,860,490 B），不是当前版本，勿默认安装。
> - **安装脚本历史指向风险**：`materials/demo_start.ps1`、`demo-preflight.js`、`device-preflight.ps1`
>   仍指向上述 1.0.0 包；修正由 watcher-recover 在 materials 写域执行（Lead 已授权）。在那之前安装请
>   显式使用 `RELEASE.md` 中的 1.0.10 signed HAP。
> - 本轮**未安装**重建的 1.0.10 HAP（Lead 裁决：与已安装版字节码等价，非必需）；安装验收与回滚由 Lead 决定。

DAYU200 上的 OpenHarmony APP。本目录包含两类东西：

1. **主界面 APP**（`entry/src/main/ets/entryability/`、`pages/` 等）：监护状态、告警、相机、看护页面。
2. **`SosVoiceAbility`**（`entry/src/main/ets/sosvoiceability/`）：现场语音播报 Ability。

## SosVoiceAbility：两种用法

### 用法一 —— 告警求助（旧行为，保持不变）

```bash
aa start -a SosVoiceAbility -b com.dsh.eldercare
```

播放随包携带的资源（候选列表 `sos.wav` / `sos.m4a` / `sos.mp3` / `sos.aac` / `sos.ogg`，
取第一个存在的），播完自动退出。来源是 `southbound` 的 `homemon`（`say_cmd`）。
**不带任何 `--ps` 参数时就是这个路径，行为与之前完全一致。**

### 用法二 —— 远程留言（新增）

```bash
aa start -a SosVoiceAbility -b com.dsh.eldercare \
  --ps voiceResource medicine_reminder.wav \
  --ps playbackMessageId cmsg-xxxxxxxx \
  --ps callbackPort 45123 \
  --ps callbackNonce <一次性随机串>
```

行为：
1. 从 `want.parameters` 读取并**严格校验**参数；
2. 只从 HAP 内置 `resources/rawfile/` 播放 `voiceResource` 指定的资源；
3. AVPlayer **真正进入 `completed`** 后，POST 回执到
   `http://127.0.0.1:<callbackPort>/playback-result`；
4. 然后退出 Ability。

只有 `southbound` 收到这条回执，才会向后端回报 `PLAYED`。

### 资源白名单

`voiceResource` 只允许（精确匹配、大小写敏感）：

| 资源 | 语义 |
|---|---|
| `check_in.wav` | 家里在问候您，请回应一下 |
| `please_respond.wav` | 请按一下按钮回应家人 |
| `medicine_reminder.wav` | 该吃药了，请按时服药 |
| `family_message.wav` | 家人给您留了一句话 |
| `emergency_contacting.wav` | 正在联系家人，请稍等 |

拒绝 `/`、`\`、`..`、`:`、`?`、`#`、`%`、空格、URL 与任意扩展名变形；
**参数绝不参与文件系统路径拼接**（沙箱路径只能由"已通过白名单的资源名"构成）。
未知资源 → 回报 `UNKNOWN_VOICE` 失败，**绝不回退播放 `sos.wav`**。

> **五个预置语音资源已生成并随 HAP 打包**（16 kHz / 单声道 / 16-bit PCM，3.7–4.9 s，
> 五个哈希互不相同）。生成路线与参数见 [`tools/tts/README.md`](../tools/tts/README.md)。
> 但**未签名、未安装、未上板**：真机播放仍为 **NOT TESTED**，人工听觉验收也未进行。
> 资源缺失时真机仍会走到 `RESOURCE_MISSING`，不会伪装成播放成功。

### 回执安全设计

| 约束 | 实现 |
|---|---|
| 只回调本机 | 地址固定 `http://127.0.0.1:<port>/playback-result`，端口必须 1–65535 |
| 不接受任意 URL | 地址由端口拼接，**不来自** `want` 参数 |
| 关联性 | 回执正文含 `playbackMessageId` + `callbackNonce`，南向代理两者都核对（常量时间比较） |
| 有界正文 | 只 4 个字段；`errorCode` 清洗为 `[A-Z0-9_]`，≤48 字符 |
| 不泄露密钥 | Ability 不接触 ingest key / 后端 URL / 微信凭据 |
| 失败可退出 | 回执超时（4s）或异常都会走到 `terminateSelf()`，不会挂住 |
| 只声明必要权限 | 复用 `module.json5` 已有的 `ohos.permission.INTERNET`（本地回环通信所需） |

### 与告警链路的边界（本轮未改）

- `PLAYED` = HAP 报告预置音频**播放完成**；
- `ACKED` = 老人**后续主动确认**（本工作包未接入实体按钮，未真机验证）；
- `PLAYED` **不自动等于** `ACKED`；`requestAck=false` 也不允许伪造确认。

## AI 语音问答页（1.0.11 起，1.0.12 增加音箱播报）

入口：主界面底部 **AI 问答** 标签（`pages/AiVoicePage.ets`），客户端在
`model/AiVoiceClient.ets`，协议与服务端见 [`../voice-gateway/README.md`](../voice-gateway/README.md)。

- 录音：`AudioCapturer` 44.1 kHz / 单声道 / S16LE，最长 10 秒，自动停止；
- 通道：TCP `127.0.0.1:9302`（依赖 PC 侧 `hdc rport tcp:9302 tcp:9302`）；
- 回答：板端显示 DeepSeek 文本；DAYU200 **无扬声器**，语音由 ESP32-S3 节点经
  网关 9102 通道播报，页面显示“房间音箱正在播报（N 台）”；
- 兜底：语音失败或识别不准时使用文字输入，链路与语音相同（只上传文字）；
- 权限：`ohos.permission.MICROPHONE`（`module.json5`）；
- 安全：不包含任何 API Key；音频不落盘，只在 PC 临时目录并在问答后删除。

| 版本 | 变更 |
| --- | --- |
| 1.0.11 | 新增 AI 语音问答页、44.1 kHz 录音、文字兜底 |
| 1.0.12 | 板端无扬声器 → 交给 ESP32-S3 音箱；`tts_start` 带实际音箱数；音箱空闲不再 15 秒重连 |

## 构建 unsigned HAP

```powershell
Set-Location <WORKSPACE>\competition\northbound
$env:DEVECO_SDK_HOME = 'D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME       = 'D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME = '<WORKSPACE>\.buildcache\hvigor'
$env:OHPM_HOME       = '<WORKSPACE>\.buildcache\ohpm'
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' clean --no-daemon
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' `
  assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

产物：`northbound/entry/build/default/outputs/default/entry-default-unsigned.hap`

打包与签名（OH 7.0 板端可安装变体）：
1. 剔除 SDK26 的 `rpcid.sc`：`python signing/strip_rpcid.py <unsigned.hap> <norpc.hap>`
2. `hap-sign-tool sign-app`：keystore 用 SDK 自带 `OpenHarmony.p12`（alias
   `openharmony application release`），`-appCertFile signing/app-chain.pem`，
   `-profileFile signing/final-profile.p7b`，`-compatibleVersion 12`
3. `hap-sign-tool verify-app` 必须 `Digest verify result: true`
4. 签名口令只从环境变量/交互注入，**不得写入脚本、日志或证据文件**

> 完整的一键脚本（clean → build → strip rpcid → sign → verify → 静态核对）：
> `competition/evidence/2026-10-28-three-legacy-closures/source-unify/scripts/01-build-verify-sign-1.0.10.ps1`。
> 当前版本 1.0.10/1000010 的制品哈希、回滚包与等价性说明见 [`RELEASE.md`](RELEASE.md)。

> **不要在没重新构建的情况下引用旧哈希。** 每次构建后重新计算 SHA256 并更新
> `docs/ARTIFACTS.md` 或本目录 `RELEASE.md`。

## 测试

ArkTS 很难在当前工作机做运行时单测（需要真机/模拟器），因此用来源码守卫 +
**真实编译**双重验证：

```bash
# 源码守卫（白名单、参数读取、无路径拼接、completed 回调、失败不回退 sos.wav、回执字段）
node --test northbound/tests/sosvoiceability-guard.test.js

# 真实编译（语法与 ArkTS 类型规则；守卫不能替代它）
<上面的 hvigor 命令>
```

> 实测教训：ArkTS 的类型规则比 TypeScript 更严（例如 `arkts-no-any-unknown`
> 禁止 `any`/`unknown`，且 `Record<string, Object>` 不能赋给更窄的 Record）。
> 只有真实编译能发现这类问题。
