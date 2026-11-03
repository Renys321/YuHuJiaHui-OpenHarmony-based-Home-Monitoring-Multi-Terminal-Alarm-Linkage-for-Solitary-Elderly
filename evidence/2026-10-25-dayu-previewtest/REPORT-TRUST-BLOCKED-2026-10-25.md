# DAYU 摄像头方向测试应用：独立签名/安装阻塞报告

日期：2026-10-25
目录：`<WORKSPACE>\competition\evidence\2026-10-25-dayu-previewtest`
状态：**独立测试应用未创建、未安装；原版应用和数据保留**
分类：`DAYU_PREVIEWTEST_BLOCKED_TRUST_CHAIN`

## 0. 结论

用户已授权“新建独立 keystore + 独立包名测试应用”，但 DAYU 的设备信任策略只接受由 **OpenHarmony Application CA / OpenHarmony Application Profile Debug CA** 签发并链到 **OpenHarmony Application Root CA** 的应用证书和调试 profile。

- 仓库/SDK 中没有这些 CA 的私钥；
- SDK 自带 `OpenHarmony.p12` 的旧口令无人记得，无法用它作为 app key；
- 自建根 CA、自签 app 证书、自签 debug profile 不在设备信任链内，安装会被拒绝；
- 修改 `/system/etc/security` 信任库、关闭签名校验或用 root 注入配置均被任务边界禁止。

因此**无法在当前授权边界内生成一个 DAYU 会接受的独立测试 HAP**。为了避免制造注定被拒绝的包，**没有创建新 keystore、没有构建/签名/安装独立测试应用**；原 `com.dsh.eldercare` 和原数据未被覆盖。

## 1. 设备信任链证据（只读）

保存的设备配置：

- `device-trusted_apps_sources.json`
- `device-trusted_cert_path.json`
- `device-trusted_root_ca.json`

关键条目：

```text
OpenHarmony apps:
  app-signing-cert: CN=OpenHarmony Application Release
  profile-debug-signing-certificate: CN=OpenHarmony Application Profile Debug
  issuer-ca: CN=OpenHarmony Application CA
  root-ca: CN=OpenHarmony Application Root CA

trust-profile-path (debug):
  subject: CN=OpenHarmony Application Profile Debug
  issuer: CN=OpenHarmony Application CA

trust-cert-path:
  CN=OpenHarmony Application Release (issuer OpenHarmony Application CA)
  CN=ide_demo_app (issuer OpenHarmony Application CA)
```

不含任何上述 CA/Profile Debug 私钥；`ide_demo_app` 也只 trusted if issuer 是 OpenHarmony Application CA，不能靠改 subject 伪造。

## 2. 新建签名可用路径判定

| 前置条件 | 实际 | 结论 |
|---|---|---|
| 新 app 证书需由设备信任的 CA 签发 | 设备只信任 OpenHarmony Application CA | 无该 CA 私钥 |
| debug profile 需由信任的 Profile Debug 证书签发 | 只信 OpenHarmony Application Profile Debug | 无该私钥 |
| 使用 SDK `OpenHarmony.p12` | 旧口令不可得，用户确认不记得 | 不可用 |
| 自建根 CA | 设备信任库无该根，禁止修改 | 不可安装 |
| 自签 app 证书 + 自签 profile | 链不匹配 | 会被校验拒绝 |
| 修改信任库/关闭校验/root 注入 | 任务明确禁止 | 放弃 |

因此：**“新 keystore 尚未创建”**——不是生成失败，而是在创建前就确认了后续证书/profile 不可能被设备接受。

## 3. 当前现场（只读）

- HDC target：`450100445634303332012847942eca00`（仅此一个）。
- 原应用：`com.dsh.eldercare`，versionName `1.0.0`，versionCode `1000000`，运行 PID **2239**。
- 当前安装 HAP：`/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap`，1,860,490 B，SHA-256 `1F2529C1164662B64257E7F1ABA833B3232025DE06146A058F72AD4B4A9D1073`。
- 独立包 `com.dsh.eldercare.previewtest`：**未安装**（`bm dump` 无此包）。
- P0 当前：1883/9001/9101/9200/5555 均 NO-LISTEN；supervisor/worker 进程不存在；homemon 不存在；fport 空。P0 在本任务前已经未运行；本任务未启动/停止/修改任何 P0 组件。
- 9200：无监听。

## 4. 复用候选（未安装）

`<WORKSPACE>\competition\evidence\2026-10-25-dayu-preview-rotation-candidate\`

- v2 未签名候选（包名仍是原 `com.dsh.eldercare`，不是独立测试包）：
  `dayu-preview-rotation0-commentcorrected-2026-10-25-unsigned.hap`
  1,823,686 B，SHA-256 `27423737A9B7D77DF17FE757B1639636646797E04C5D82CF9800FD2C99A94BCF`
- 候选假设：`PreviewOutput.setPreviewRotation(ROTATION_0, true)`；**未真机验证**。
- 原版回滚包：
  `...\rollback\DAYU-eldercare-signed-original-1F2529C1.hap`
  1,860,490 B，SHA-256 `1F2529C1...D1073`。
- 本任务未安装任何 HAP，因此未发生覆盖、未需要回滚。

## 5. 报告必答

| 问题 | 回答 |
|---|---|
| 新签名是否创建，证书/profile 是否被设备认可？ | 新 keystore **未创建**；自建证书/profile 不会被设备认可（信任链不匹配）。 |
| 独立包名和实际安装结果？ | `com.dsh.eldercare.previewtest` 未安装；无实际安装结果。 |
| ROTATION_0 实测是否有效，最终采用哪种修正？ | **未安装/未实测**；无最终结论，仍是候选假设。 |
| 用户是否确认屏幕预览正向？ | **否**（没有测试应用）。 |
| JPEG 尺寸/方向？ | 未变、未验证；历史 P1-B 640×480 方向正常只作背景。 |
| 生命周期/相机释放结果？ | 未测试（没有测试应用）。 |
| 本机人物检测回归？ | 未执行，不能写 PASS。 |
| 原版应用及数据是否保留，运行状态是否恢复？ | **保留**：原 HAP 哈希未变、进程 PID 2239 运行；未安装/卸载/清数据/停止原应用，无需恢复。 |
| 新 HAP 路径/大小/SHA-256？ | 没有新安装 HAP；当前仍为原版 `entry.hap`，1,860,490 B，`1F2529C1...D1073`。 |
| 未完成项/具体阻塞？ | 独立测试应用、签名、安装、方向验收、JPEG/生命周期/检测回归全部未完成；阻塞=设备只信任 OpenHarmony CA/Profile Debug 证书，而无私钥/可用 profile 签发材料。 |

## 6. 解除阻塞的最小条件

1. 提供由 **OpenHarmony Application CA** 签发的 app 证书及对应私钥，或
2. 提供可用的 **OpenHarmony Application Profile Debug** 签名私钥/受认可 debug profile（bundle 可为 `com.dsh.eldercare.previewtest`，device UDID 为 `DC3ABD...C0D54C`），或
3. 由具备 OpenHarmony 签名链的开发者用其工具签发独立测试 HAP（不共享私钥/口令），再把 signed HAP 交给本机安装。

满足任一条后，才能构建/签名/安装独立测试应用并做真实方向验收。

## 7. 边界

未创建/修改 keystore；未读取或输出任何口令；未修改设备信任库、系统文件、签名校验；未覆盖/卸载原应用；未操作 COM/串口、Wi-Fi/AP、backend、DNS、MQTT、SOS/ACK/reset；未启动 P0。
