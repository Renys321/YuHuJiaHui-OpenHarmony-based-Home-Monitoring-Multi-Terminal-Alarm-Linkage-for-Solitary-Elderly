# APP 更新方式决策（基于签名事实核验，2026-10-27 00:12 +08:00）

## 事实（证据见 `baseline/SIGNING-IDENTITY.md`）

| 项 | 结论 |
|---|---|
| 已安装包 `com.example.program_04`（模拟器 127.0.0.1:5555） | `bm dump`：`appSignType=none`、`signatureKey=""`、`appIdentifier=""`、`appProvisionType=debug` ⇒ **设备上这个包没有签名身份** |
| 历史 HAP（`2026-10-24-app-p0-sensors-local/guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap`） | `hap-sign-tool verify-app` → **signature not found**（无签名块）；即历史安装本身就是 unsigned |
| 候选 HAP（D+E+CAMERA-A） | 同样 verify-app → signature not found（unsigned） |
| program_04 签名材料 | 全盘扫描：0 个属于 `com.example.program_04` 的签名 HAP / 证书 / profile；`<USER_HOME>\.ohos` 不存在；工程 `signingConfigs` 为空 |
| 现存签名材料 | 仅 `com.dsh.eldercare*`（DAYU，绑 DAYU UDID）与 SDK `OpenHarmony.p12`；**都不匹配本 bundle** |
| 模拟器对 unsigned debug HAP | 历史 2026-10-21/22/23/24/26 多轮 `hdc install -r` 均成功，保留数据/会话 |

## 决策（用户已确认）

**按 unsigned 覆盖更新执行**：用 D/E-only unsigned HAP 直接 `hdc -t 127.0.0.1:5555 install -r`，
不新建证书、不卸载、不清数据、不关闭（本来也未开启的）签名校验。

## 理由

1. 任务要求“使用现有签名身份、不能更换签名、不能卸载清数据”。本 bundle 的“现有签名身份”事实层面是**无签名**；保持不改即是满足“不更换”。
2. 若现在新建证书/Profile 去“签名”，签名身份从 none → 新身份，属于**更换签名身份**，且 HarmonyOS 对签名不一致的覆盖安装可能要求卸载，直接违反任务约束。
3. unsigned 覆盖安装正是该 APP 自 2026-10-21 起的全部历史安装方式，不改变既有身份、不触发卸载、数据保留。

## 待验收时要核对

- 安装前后 `bm dump -n com.example.program_04`：versionCode 1000000 → **1000001**、versionName 1.0.0 → 1.0.1、`firstInstallTime` 不变（未卸载）、`appSignType` 仍为 `none`；
- 登录会话/数据保留（不要求重新注册）；
- D/E 页面可打开并与后端一致。

## 仍在待办的签名相关项

- 无需用户提供签名材料；之前“在 DevEco 手工签名”的计划**取消**（会引入新身份）。
- `hap-sign-tool` 仅用于**只读验签**核验（已有结果）。
