# SIGNING-IDENTITY — `com.example.program_04` 签名身份与“同身份覆盖更新”可行性（只读）

- 采集窗口：2026-10-26 23:44 – 2026-10-27 00:10（Asia/Shanghai），工作区 `<WORKSPACE>`。
- 边界：**只读**。未执行 sign-app / sign-profile / hdc install / uninstall，未改 APP 源码或 `build-profile.json5`，未读取或输出任何口令/私钥/Token。工具：`D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar` + `D:\DevEcoStudio\DevEco Studio\jbr\bin\java.exe`。
- 事实分级：**[已证实]** = 本次命令直接观测；**[历史]** = 既有证据文件记载（非本次复测）；**[推断]** = 由证据推理；**[未知]** = 本机不可得或需授权实测。

## 0. 一句话结论

**[已证实] 该 bundle 从未以“签名包”安装过，本机也不存在任何属于 `com.example.program_04` 的签名材料。** 因此“用同一签名身份覆盖更新”在严格语义下**缺材料且无既有身份可对齐**；但“覆盖更新 + 不卸载 + 不清数据 + 不关签名校验”本身**可行**，路径是继续使用 **unsigned HAP + `hdc install -r`**——这与 2026-10-21 起该 APP 的全部历史安装方式完全一致（模拟器默认接受 unsigned debug HAP）。

## 1. 验签结果（已签名历史 HAP / unsigned 候选）

`verify-app` 命令（只读，无口令）：`java -jar hap-sign-tool.jar verify-app -inFile <HAP> -outCertChain <out.cer> -outProfile <out.p7b>`

| 对象 | 大小 / SHA-256 | verify-app 结果 | 签名块 | 证书 Subject / Issuer / 有效期 | profile（bundle/type/appId/UDID） |
| --- | --- | --- | --- | --- | --- |
| 历史“已安装”HAP `2026-10-24-app-p0-sensors-local/guardian-app-p0-sensors-autorefreshfix-2026-10-24.hap` | 2,086,949 B / `9EEBEE9A5FC9EEC5A5993DC6923F16F0BFCCCD1CD4DE64BAF36FC7197ECAD25A` | **失败：signature not found**（`No Hap Signing Block before ZIP Central Directory`） | **无** | **无证书**（无签名） | **无 profile**（也无 `META-INF/`） |
| 候选 `2026-10-26-d-e-candidate-freeze/app/guardian-d-e-candidate-2026-10-26-unsigned.hap` | 2,621,844 B / `7634A0E25FCE3E19FC9604E4CD94D6D6BAFF36CB5DE67C92DAEE0E50C1452EB5` | **失败：signature not found**（同上） | **无** | **无证书** | **无 profile** |
| 对照：本机唯一可用签名制品 `competition/northbound/signing/eldercare-signed.hap`（bundle `com.dsh.eldercare`） | 1,860,490 B | **成功**（codesign / SHA-256 digest / permission sign 全过） | 有（`<hap sign block>`，v3） | #0 `CN=OpenHarmony Application Release, OU=OpenHarmony Team, O=OpenHarmony, C=CN` ← Issuer `CN=OpenHarmony Application CA,…`，2021-02-02 ~ 2049-12-31，SHA-256 `8E:93:86:3F:…:24:B5`；链至 `OpenHarmony Application Root CA` `9A:ED:2A:79:…:80:ED` | `final-profile.p7b` 验签成功：`bundle-name=com.dsh.eldercare`、`type=debug`、`developer-id=OpenHarmony`、`device-ids=[DC3ABD05…C0D54C]`（**DAYU200 的 UDID**）、有效期 2026-10-14 ~ 2036-10-12；profile 内无 `appId` 字段，`appId` 由 bms 派生 |

**[已证实] 设备侧元数据**（`hdc -t 127.0.0.1:5555 shell "bm dump -n com.example.program_04"`，只读）：

```text
appId=com.example.program_04_   appIdentifier=""   appSignType="none"   signatureKey=""   fingerprint=""
appProvisionType=debug          appDistributionType="none"   debug=true
versionCode=1000000  versionName=1.0.0  uid=20020063
firstInstallTime=1792597207955 (2026-10-21 23:40:07)  updateTime=1793026431876 (2026-10-26 22:53:51)
codePath=/data/app/el1/bundle/public/com.example.program_04  (ls/read => Permission denied)
设备 UDID (bm get -u) = 454D55057494E05838360C75AE20A24C248DA93C64C02AB0F2A9E00000000000（与 DAYU 的 DC3ABD…C0D54C 不同）
```

`appSignType=none`、`signatureKey` 空、`appId` 后缀为空 ⇒ **该安装不带签名身份** [已证实]（`appProvisionType=debug` 与之并存，属该模拟器 unsigned debug 安装的既有表现 [历史] `docs/evidence/2026-10-22-guardian-app-emulator-acceptance.md:14,113-114`）。设备内 HAP 只读拉取被拒，无法直接复算设备副本哈希 [未知]。

**[已证实] 全库 HAP 签名扫描**：`<WORKSPACE>` 下 97 个 `.hap`，53 个含 `<hap sign block>`（**全部**属 `com.dsh.eldercare`/`com.dsh.eldercare.previewtest`/hello 系列），44 个 unsigned，**属于 `com.example.program_04` 的签名 HAP 数量 = 0**。清单：`baseline/signing-audit-2026-10-26/hap-signed-sweep-2026-10-26.txt`。

## 2. 上次签名材料的定位结果：**未找到（program_04 专属材料不存在）**

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| `<USER_HOME>\.ohos`、`.harmony` | **不存在** | 本机路径检查 |
| DevEco 26.0 `options\*.xml`（`%APPDATA%\Huawei\DevEcoStudio26.0`） | 无 `signingConfig`/keystore/profileFile 引用 | 全量 grep 无命中 |
| 三份工程 `AppScope/../build-profile.json5`（`APP\Program_04`、`ElderlyCareGuardian`、`ElderlyCareGuardian2`）及候选归档源 | `"signingConfigs": []` | 内容读取 |
| `*.p12/*.p7b/*.cer/*.jks/*.csr` 检索（`<USER_HOME>` 全部可读目录；`<WORKSPACE>` 工作区与 `D:\DevEcoStudio` 定向检索。**范围限制**：全 D: 通配枚举超时未跑完，`<USER_HOME>` 个别受限目录枚举被拒） | 仅下列材料，**均非 program_04** | 见下 |
| 材料内容扫描（94,563 个文件，含 p7b/pem/cer/p12 与全部文本） | **无任何证书/profile 提及 `program_04`** | 命中均为报告 md/json 或 unsigned HAP |

现存材料（可读，不含口令）：
1. SDK 开发材料：`sdk\default\openharmony\toolchains\lib\OpenHarmony.p12`（8,252 B，SHA-256 `7A5EFC3EA9245596D157F6CCBBDC5B8AE7CD714E7086C3C1645986C9D495D071`；`D:\DevEcoStudio\OpenHarmony\Sdk\26.0.0\…` 副本逐字节相同）、`OpenHarmonyProfileDebug.pem`、`OpenHarmonyProfileRelease.pem`、`UnsgnedDebugProfileTemplate.json`。
2. `competition\northbound\signing\`：`app-chain.pem`、`leaf.pem`、`ca.pem`、`rootca.pem`、`eldercare.p7b`、`final-profile.p7b`、`profile-debug.json` → **bundle `com.dsh.eldercare` + DAYU UDID**。
3. `competition\experiments\dayu-previewtest-2026-10-25\signing\`：`previewtest.p12`(1,014 B)、`previewtest-app.pem`、`previewtest.p7b` → **bundle `com.dsh.eldercare.previewtest` + DAYU UDID**（2026-10-25 新建身份的完整签名链路 [历史] `evidence/2026-10-25-dayu-previewtest/REPORT.md:52-76`）。

**[推断]** 本 bundle 的历次安装未使用任何签名材料（与 §1 的 0 签名 HAP、`appSignType=none` 一致）；“上次用什么签的”这一问题在事实层面**不成立**（没有“上次签名”）。
**[未知]** SDK `OpenHarmony.p12` 口令可得性存在冲突记载：`2026-10-25-dayu-previewtest/REPORT.md:52` 称使用“官方文档默认开发口令”完成全链路，而 `2026-10-25-dayu-preview-rotation-candidate/ACCEPTANCE-BLOCKED-2026-10-25.md:13` 称“旧口令不可得”。本报告不猜测、不读取口令。

## 3. 同身份覆盖更新可行性结论

**结论：缺材料（严格“同一签名身份”不可行）＋ 但 unsigned 覆盖更新可行。**

- **[已证实] 不存在可复用的同一身份**：已安装包无签名（§1），全库无 program_04 签名件（§1/§2）⇒ 无“原签名身份”可保持。
- **[已证实] 可行替代路径（与历史完全一致）**：继续用 unsigned HAP 覆盖安装。该 HarmonyOS 模拟器（`Mate 90 Pro`，HarmonyOS 7.0.0(26.0.0)，x86_64）**默认接受 unsigned debug HAP**，`hdc -t 127.0.0.1:5555 install -r` 已在 2026-10-21/22/23/24/26 多轮实测成功且保留数据/会话：[历史] `docs/evidence/2026-10-22-guardian-app-emulator-acceptance.md:14,96-114`、`evidence/2026-10-24-app-p0-sensors-local/FINAL-2026-10-24.md:8,17,24`、`evidence/2026-10-24-app-device-identity-diag/IDENTITY-DIAG-CONCLUSION-2026-10-24.md:9-12`。此路径**不切换身份、不卸载、不清数据**；也未修改模拟器签名校验配置（本 APP 自始未被验签）。
- **若必须“有签名”（追加路径，当前缺材料）**，需同时具备并缺：
  1. 应用私钥 + 与之绑定的应用证书链（设备信任根为 `OpenHarmony Application CA/Root CA`）→ **缺 program_04 专属证书材料**（可复用 SDK 材料新建，但那是**新身份**，违反“不能换签名”；若重生成则签名身份必然不同）；
  2. 由设备信任的 Profile CA 签发、`bundle-name=com.example.program_04`、`type=debug`、`device-ids=[454D55057494E05838360C75AE20A24C248DA93C64C02AB0F2A9E00000000000]`（该模拟器 UDID，本次 `bm get -u` 读取）的 `p7b` → **缺**；现有 p7b 全部绑定 `com.dsh.eldercare*` + DAYU UDID，不可用；
  3. 上述 keystore 的口令 → **未知/需用户提供**（只能本机隐藏输入）；
  4. “无签名 → 有签名”的覆盖安装是否被 bms 接受 → **未知**，本轮禁止安装，无法实测；存在被判定为签名不一致而要求卸载的风险。
- **由谁提供**：路径 A 无需任何人提供材料（现有 unsigned 候选即可）；路径 B 的签名材料与口令须由**用户本人**（或持有历史上签名材料的机器/账号方）提供，不得由代理生成后声称“同身份”。

## 4. 命令模板（口令仅本机隐藏输入）

```powershell
$java = "D:\DevEcoStudio\DevEco Studio\jbr\bin\java.exe"
$tool = "D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\lib\hap-sign-tool.jar"

# 4.1 只读校验（无口令；本轮已执行，用于复核任意 HAP/Profile）
& $java -jar $tool verify-app     -inFile <HAP>            -outCertChain <out.cer> -outProfile <out.p7b>
& $java -jar $tool verify-profile -inFile <signed.p7b>     -outFile <verify-result.json>

# 4.2 若走“签名”路径（需用户提供材料与口令；本轮未执行）
& $java -jar $tool sign-profile -mode localSign -keyAlias <PROFILE_KEY_ALIAS> `
  -profileCertFile <profile-cert-chain.pem> -inFile <profile.json> `
  -signAlg SHA256withECDSA -keystoreFile <profile-keystore.p12> -pwdInputMode 1 -outFile <signed.p7b>

& $java -jar $tool sign-app -mode localSign -keyAlias <APP_KEY_ALIAS> `
  -appCertFile <app-cert-chain.pem> -profileFile <signed.p7b> `
  -inFile <unsigned.hap> -signAlg SHA256withECDSA -keystoreFile <app-keystore.p12> `
  -pwdInputMode 1 -compatibleVersion 16 -signCode 1 -permSign 1 -outFile <signed.hap>

# 4.3 覆盖安装（本轮未执行；路径 A 用 unsigned 候选）
hdc -t 127.0.0.1:5555 install -r <HAP>
```

- 占位符 `<PROFILE_KEY_ALIAS>`、`<APP_KEY_ALIAS>`、keystore/证书路径、`<signed.p7b>`、`<signed.hap>` 由用户按实际材料填写；**口令不是参数**。
- **口令规则**：`-pwdInputMode 1` 使 `hap-sign-tool` 以交互方式索取 `-keystorePwd`/`-keyPwd`，用户只在本机可见终端**隐藏输入**；禁止写进命令行（会进 PowerShell 历史）、日志、聊天、报告或任何证据文件。本报告与 `baseline/signing-audit-2026-10-26/` 内文件均不含口令或私钥。
- `-compatibleVersion 16` 取自 HAP 内 `module.json` 的 `minAPIVersion=50004016` [已证实]。

## 5. 版本字段对比与“是否需要提升 versionCode”

| 对象 | versionCode | versionName | 备注 |
| --- | ---: | --- | --- |
| 设备已安装 | **1000000** | 1.0.0 | `bm dump`；`minCompatibleVersionCode=1000000` |
| 候选 HAP（D+E+CAMERA-A） | **1000000** | 1.0.0 | HAP 内 `module.json`、`AppScope/app.json5` 一致 |
| 2026-10-24 已安装历史 HAP | 1000000 | 1.0.0 | 同上 |

- **候选与已安装 versionCode 相同（1000000）**[已证实]。
- **[历史 + 推断]** 该模拟器上“同 versionCode 覆盖”已被反复实测：`install -r` 在 10-21~10-24 多次以 1000000 覆盖 1000000 成功（`firstInstallTime` 保持、`updateTime` 前进，如 2026-10-22 21:10）。因此**提升 versionCode 不是本模拟器覆盖更新的硬前提**；但为规避非 `-r` 安装/DevEco Run/未来降级校验的差异，发布前**建议**把 `AppScope/app.json5` 的 `versionCode` 提升（例如 1000001）**并重新构建**——这会改 APP 源码字段，须由用户/Lead 授权，且产物哈希随构建改变，归档时必须另记新哈希（不得沿用 `7634A0E2…`）。
- 若走“签名”路径，HAP 字节与哈希同样改变（签名块追加），必须重新记录整体 SHA-256 并以 HAP 内 payload 哈希核对内容 [历史] `2026-10-26-d-e-candidate-freeze/BUILD-MANIFEST.md:20,64-70`。

## 6. 仍未关闭的未知项（发布前需用户确认）

1. 设备内 HAP 只读拉取被系统拒绝 ⇒ 设备副本与归档哈希的一致性只能间接推断。
2. 模拟器 bms 对“unsigned → signed”升级的策略（是否要求签名一致/卸载）未实测，本轮按边界不安装。
3. SDK `OpenHarmony.p12` 口令是否可得（两处历史记载冲突），及若可得，用它生成的**新身份**是否可被接受为“同一签名身份”——事实层面不可能（密钥不同）。
4. 是否存在**其它机器**曾为 program_04 签名（本机无任何痕迹；跨机事实本机不可证）。

## 7. 本次只读执行的原始证据

目录：`competition/evidence/2026-10-26-d-e-production-release/baseline/signing-audit-2026-10-26/`

| 文件 | 内容 |
| --- | --- |
| `verify-app-2026-10-24-hap.log` | 历史 HAP 验签：`signature not found` |
| `verify-app-candidate-unsigned.log` | 候选 HAP 验签：`signature not found` |
| `verify-app-reference-eldercare-signed.log` | 工具链正例：`verify-app success` + 3 级证书 Subject/Issuer/有效期/指纹 |
| `verify-profile-reference-eldercare.{log,json}` | 现存 p7b 的 bundle/type/UDID/有效期（`com.dsh.eldercare` + DAYU UDID） |
| `hap-signed-sweep-2026-10-26.txt` | 97 个 HAP 逐个 SIGNED/UNSIGNED（53/44；program_04 签名件 0） |
