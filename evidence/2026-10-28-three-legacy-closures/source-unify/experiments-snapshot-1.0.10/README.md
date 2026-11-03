# northbound — 监护人侧 APP（ArkTS / DevEco）

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

## 构建 unsigned HAP

```powershell
Set-Location <WORKSPACE>\competition\northbound
$env:DEVECO_SDK_HOME = 'D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME       = 'D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME = '<WORKSPACE>\.buildcache\hvigor'
$env:OHPM_HOME       = '<WORKSPACE>\.buildcache\ohpm'
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' `
  assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

产物：`northbound/entry/build/default/outputs/default/entry-default-unsigned.hap`

> **不要在没重新构建的情况下引用旧哈希。** 每次构建后重新计算 SHA256 并更新
> `docs/ARTIFACTS.md`。

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
