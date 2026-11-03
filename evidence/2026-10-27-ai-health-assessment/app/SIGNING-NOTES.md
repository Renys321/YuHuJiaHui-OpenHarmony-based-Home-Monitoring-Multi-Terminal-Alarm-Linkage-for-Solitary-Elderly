# APP 安装/签名说明（1.0.5）

## 产物

| 项 | 值 |
| --- | --- |
| HAP（unsigned） | `app/guardian-health-1.0.5-unsigned.hap` |
| 大小 | 2,980,999 B |
| SHA-256 | `935A24CCB3FC4F71B30E569E87F1DD7C5BFB31DE1A207D1C09AC7B2B1D8B7C3D` |
| bundleName | `com.example.program_04`（未改） |
| versionName / versionCode | `1.0.5` / `1000005` |
| buildMode | `debug`；`signingConfigs: []` → hvigor `skip sign`（unsigned） |
| 内容核验 | 含 `健康评估` / `第三方 AI` / `DeepSeek` / 两条固定提示；**不含** CAMERA-A（`evidence/content`、`image/jpeg`、`检查证据` 均不存在） |

## 安装现状（如实）

- `hdc install -r` 直接安装 unsigned → **失败**：`code 9568320 no signature file`。
- 用 SDK 官方开发签名身份（`OpenHarmony.p12` + Debug Profile，绑定本机 UDID）签出的包 → **失败**：
  `code 9568393 verify code signature failed`（设备只信任你们之前发布 1.0.4 所用的应用签名身份）。
- 因此本任务未能在设备上完成签名安装；**未使用别的签名身份强行安装**（遵守“不擅自换签名”）。

## 若要安装（任选其一，均保持 `com.example.program_04` 与原有签名身份）

### A. DevEco Studio（推荐）

1. 用 DevEco 打开 `<WORKSPACE>\APP\ElderlyCareGuardian`（工作区源码已包含 1.0.5 改动，与 unsigned 包同源）。
2. `File → Project Structure → Signing Configs` 勾选/沿用 1.0.4 使用的签名配置（应用证书 + Profile 不变）。
3. `Build → Build Hap(s)/APP(s)` 或直接 `Run` 到设备（`hdc` 已连接 DAYU200）。
4. 安装后核对：`hdc shell bm dump -n com.example.program_04 | grep -E "versionName|versionCode|firstInstallTime"`，
   期望 `1.0.5 / 1000005`，`firstInstallTime` 若为已有安装应保持不变。
5. 登录生产 APP（监护人账号），进入 `我的 → 健康评估`。

### B. 用你自己的签名材料签这个 unsigned HAP

把 `p12`、密码、应用证书链 PEM、`profile.p7b` 放到 `competition\.secrets\signing\`，并告知文件名；
由 Lead 执行 `hap-sign-tool sign-app`（参数同你 1.0.4 的签名流程）后 `hdc install -r`，并记录签名哈希。

### C. 若设备当前不允许该签名身份

需在 DevEco 重新配置/续期 Profile（绑定设备 UDID `DC3ABD0514880C60A274F7442EC3C068F4E3C2EE59F28D1BF2DD35CE49C0D54C`），
不要卸载旧 APP、不要清数据、不要改 bundleName。

## 安装后的验收路径（Lead 用 `hdc`/`uitest` 执行）

1. 启动：`hdc shell aa start -a EntryAbility -b com.example.program_04`，截图登录页。
2. 登录生产账号 → `我的 → 健康评估`。
3. 第 1 页填合成资料（72 岁/高血压/氨氯地平/165cm/62kg/135/82/6.1）→ 下一步。
4. 第 2 页填生活习惯 → `保存资料` → `生成健康建议` → 首次弹“健康资料将发送给第三方 AI” → 同意。
5. 等真实 DeepSeek 返回 → 截图四段结果 + 固定免责声明。
6. 返回首页再进入，确认资料仍在（服务端持久化）；断网/失败态确认显示“暂时无法生成建议，请稍后重试”且可重试。
