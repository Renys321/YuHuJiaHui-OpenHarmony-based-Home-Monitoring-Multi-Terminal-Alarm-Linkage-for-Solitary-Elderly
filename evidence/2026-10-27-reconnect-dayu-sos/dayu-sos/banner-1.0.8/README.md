# DAYU200 APP 1.0.8 — 随身求助横幅可收起/关闭（用户反馈修复）

构建时间：2026-10-27 23:39–23:42（Asia/Shanghai）
构建源：`competition/experiments/dayu-eldercare-preview-integration-2026-10-25`
（**活树，含 1.0.7 视频 Wi-Fi/帧率改动**；本轮只做横幅局部改动，未改 `VideoStreamServer.ets` 与任何视频代码）
版本：**1.0.8 / 1000008**（`module.json` 已核验）
隔离副本（仅备份、非构建源）：`competition/experiments/dayu-banner-1.0.8-2026-10-27/`，已与活树逐字节同步。

## 1. 用户反馈与修复

> 原话：“DAYU200 求助放在上面，但是不能关闭很难看的，改掉。”

1.0.5 的顶部横幅：只要 esp32-sos 有历史事件就常驻，一整块浅红卡片、无关闭入口、占地方。
1.0.8 改为**事件驱动 + 可交互**：

| 状态 | 显示 | 交互 |
|---|---|---|
| 无事件（NORMAL 且无近期事件） | **完全不显示**（不留占位、不占高度） | — |
| 待处理（ALARM） | 细长告警条（44px）：红色 `!` 图标 + `随身求助 · 待处理 HH:MM` + `查看` + `收起` | `查看`→跳到随身求助 tab；`收起`→折叠成 40px 小胶囊（`!` + 文字 + `展开`），**不整条消失**；随身求助 tab 显示红点 `●` |
| 已确认（ACKED） | 浅绿细条（44px）：`✓` + `随身求助 · 已确认 HH:MM` + 关闭 `×` | `×`→完全关闭；同一 alarmId 不再出现 |

补充规则：

- **持久化**：关闭/收起状态写入 preferences（store `eldercare_wearable_banner`，键
  `wb_alarm_<alarmId>` / `wb_acked_<alarmId>`，值 `collapsed` / `dismissed` / `shown`），
  重启 APP 后仍保持；仅存 UI 偏好，不含告警内容/时间/位置/设备数据。
- **新事件重显**：新 alarmId（新键）一定重新显示；同一 alarmId 若从 ACKED 变回 ALARM，
  会清除关闭/收起状态并重新显示。
- **ACKED 保留窗口**：已确认事件最多再显示 10 分钟（更早视为“无近期事件”，完全不显示），
  避免历史已确认事件长期占位。
- **绝不藏匿未处理告警**：ALARM 只能收起、不能彻底关闭；preferences 读失败时按“显示”处理。
- 视觉：圆角 12（胶囊 20）、低饱和浅红 `#FDECEA`/浅绿 `#EDF5EE`、高度 44/40、
  与现有卡片左右 16 间距一致；`查看/收起/×` 点击区均 ≥40px；不遮挡房间内容。
- 保留 1.0.5 已交付内容：随身求助 tab/设备卡全部字段（来源/事件时间/告警状态/GPS 状态与
  定位时间/ACK 状态）、无定位“暂无定位”、“未配置 PIR 无活动监测”文案、告警房间归属修复、
  摄像头/语音/房间 ACK 路径（本轮均未改动）。

## 2. 改动文件

| 文件 | 改动 |
|---|---|
| `entry/src/main/ets/model/WearableBannerPrefs.ets` | **新增**：preferences 读写封装 + 键规则 + ACKED 保留窗口常量 |
| `entry/src/main/ets/pages/Index.ets` | 局部改动：import；`@State` 横幅显示状态与偏好缓存；`refreshWearableBanner()` 末尾接入 `bannerUpdateDisplay()`；新增 `ensureBannerPref/persistBannerPref/bannerUpdateDisplay/collapse/expand/dismiss/view`；替换顶部横幅 UI 为细条/胶囊；设备 tab 增加随身求助未处理红点；设备信息卡版本行改为 1.0.8 |
| `AppScope/app.json5` | versionCode 1000007→1000008，versionName 1.0.7→1.0.8 |

diff：`changes-Index.ets-1.0.7-to-1.0.8.diff`（8 hunks）、`changes-app.json5-1.0.7-to-1.0.8.diff`；
新增文件全文见 `entry/src/main/ets/model/WearableBannerPrefs.ets`（活树）。
**未改**：`VideoStreamServer.ets`（视频 Wi-Fi/帧率）、`CameraModel.ets`、`VisionFrameStreamer.ets`、
`SosVoiceAbility.ets`、`DeviceModel.ets`、`DeviceCapabilities.ts`、mirror 服务、后端。

## 3. 构建 / 签名 / 验签

```powershell
Set-Location <WORKSPACE>\competition\experiments\dayu-eldercare-preview-integration-2026-10-25
$env:DEVECO_SDK_HOME='D:\DevEcoStudio\DevEco Studio\sdk'
$env:JAVA_HOME='D:\DevEcoStudio\DevEco Studio\jbr'
$env:HVIGOR_USER_HOME='<WORKSPACE>\.buildcache\hvigor'
$env:OHPM_HOME='<WORKSPACE>\.buildcache\ohpm'
& 'D:\DevEcoStudio\DevEco Studio\tools\hvigor\bin\hvigorw.bat' assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

- 结果：`BUILD SUCCESSFUL`（日志 `build-1.0.8.log`；既有的 SosVoiceAbility 系统能力告警不变）
- 剔除 SDK26 `rpcid.sc`：`experiments/.../signing/strip_rpcid.py`
- 签名：`hap-sign-tool sign-app`，`-keyAlias "openharmony application release"`、
  `-signAlg SHA256withECDSA -mode localSign`、`-appCertFile northbound/signing/app-chain.pem`、
  `-profileFile northbound/signing/final-profile.p7b`、SDK `OpenHarmony.p12`（与 1.0.5 同身份）；
  口令按项目纪律不写入证据文件/脚本/日志。
- `verify-app`：**success**（`Digest verify result: true`、`verify permission sign success`），
  证书链/profile：`verify-app-chain.cer`、`verify-app-profile.p7b`。

## 4. 制品与 SHA-256

| 制品 | 大小 | SHA-256 |
|---|---|---|
| `dayu-eldercare-1.0.8-unsigned.hap` | 2,022,587 B | `99FF93789DF8DEFD918BEC970E409EB9B21B20C00040427666FED5068D604FFA` |
| `dayu-eldercare-1.0.8-norpc.hap` | 1,367,584 B | `AA37534D2481C9309ED5871471DD23A358C54CD8FA6F6622794AEBD006D9E452` |
| **`dayu-eldercare-1.0.8-signed.hap`（安装用）** | **1,385,967 B** | **`31261D17F4F43F17F3E188D6A84B907D35DEE71FAE941C9E835D3058A19EE33E`** |

包内校验：`versionName=1.0.8`、`versionCode=1000008`、`debug=true`、bundle `com.dsh.eldercare`；
`ets/modules.abc` 含 `随身求助 · `、`收起`、`展开`、`wb_alarm_`、`wb_acked_`、`0.0.0.0`、`LAN_ONLY`
（后者证明 1.0.7 视频 Wi-Fi 改动仍在包内）；无 `.bak`/临时文件（18 entries）。

## 5. 安装 / 回退（由 Lead 执行，本轮不安装）

前提：DAYU 当前 hdc 掉线（`hdc list targets` 只有手机模拟器）；恢复 USB/HDC 后：

```powershell
$hdc='<WORKSPACE>\tools\hdc\hdc.exe'; $t='450100445634303332012847942eca00'
$signed='<WORKSPACE>\competition\evidence\2026-10-27-reconnect-dayu-sos\dayu-sos\banner-1.0.8\dayu-eldercare-1.0.8-signed.hap'
& $hdc -t $t install -r $signed        # 覆盖安装，保留应用数据
& $hdc -t $t shell 'bm dump -n com.dsh.eldercare | grep version'   # 期望 1.0.8/1000008
```

**回退包（优先当前线上 1.0.6，覆盖安装保留数据）**：
`competition/evidence/2026-10-27-video-wifi/dayu-video-wifi-1.0.6-signed.hap`
（1,377,775 B / SHA-256 `D1E7D934D00C2D28206E8F5963EA9BB8F5AB2FCCADDED6F32547A40D1D832B04`）
```powershell
& $hdc -t $t install -r '<WORKSPACE>\competition\evidence\2026-10-27-video-wifi\dayu-video-wifi-1.0.6-signed.hap'
```
**回退到 1.0.5**（手持态/固定横幅旧版，若需对比）：
`dayu-sos/build/dayu-eldercare-1.0.5-signed.hap`（1,373,680 B / `7EE16A97E9D761A5B6BD74DFDE638B958A522962ECD1E621E3DCE0868849FDFF`）。
> 若你已在 1.0.7 上做过其它安装/验收，请优先用你手上的 1.0.7 signed 包回退；本目录未见 1.0.7 制品。

## 6. 回归风险 / 边界

- 本轮只改 Index.ets 的横幅相关代码与新增 preferences 封装：横幅数据仍只由 esp32-sos 真实状态行驱动，**不伪造告警、不改变 ACKED 判定**（ACKED 仍只来自设备真实回执/后端 ACKED）。
- preferences 读写失败 → 按“显示”处理并 `console.warn`，不会因偏好问题隐藏未处理告警；不会阻塞主数据链路（异步、异常已捕获）。
- `getUIContext().getHostContext()` 在页面生命周期内使用（与既有 `loadPreviewTuning/aboutToDisappear` 相同 API）；若宿主上下文异常会走 catch 分支。
- 视觉仅影响顶部横幅（高度 40/44），不改变页面其他卡片布局；设备 tab 只增加一个 9px 红点字符。
- 构建已验证 1.0.7 视频 Wi-Fi 代码仍编译进包（`0.0.0.0`/`LAN_ONLY` 在 abc 中）；相机/语音/房间 ACK 未改。
- 未安装、未清数据、未改签名信任链、未改 mirror/后端。

## 7. 本目录文件

| 文件 | 内容 |
|---|---|
| `dayu-eldercare-1.0.8-{unsigned,norpc,signed}.hap` | 三件套 |
| `SHA256SUMS.txt` | 三件套哈希/大小 |
| `build-1.0.8.log` / `clean-1.0.8.log` / `sign-1.0.8.log` / `verify-1.0.8.log` | 构建/清理/签名/验签日志 |
| `verify-app-chain.cer` / `verify-app-profile.p7b` | verify-app 输出 |
| `changes-Index.ets-1.0.7-to-1.0.8.diff` / `changes-app.json5-1.0.7-to-1.0.8.diff` | 相对 1.0.7 源码快照的改动 |
| `SCREENSHOT-CHECKLIST-1.0.8.md` | 安装后真机截图验收清单 |
