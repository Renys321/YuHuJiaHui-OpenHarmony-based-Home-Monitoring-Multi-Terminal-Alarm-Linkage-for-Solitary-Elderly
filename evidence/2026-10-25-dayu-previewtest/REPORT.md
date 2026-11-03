# DAYU 摄像头方向独立测试应用：真机验收报告

日期：2026-10-25
分类：`DAYU_PREVIEWTEST_REAL_ACCEPTANCE_PASS`
范围：独立测试应用 `com.dsh.eldercare.previewtest`；原版 `com.dsh.eldercare` 未改。

## 0. 结论

```text
独立签名路径成立
独立测试应用已安装并通过真机方向/比例验收
最终显示方案：显示层 -90° + 画面大小/比例用户可调（默认 60% / 130%）
Surface JPEG：640×480，方向正常，未被显示旋转改变
原版应用与数据保留，已恢复运行
```

`setPreviewRotation(ROTATION_0, true)` 在本机运行时报
`7400201 Invalid Session Configuration`，**不是可用修复**；最终没有使用任何
Camera API 旋转，只做显示层变换，Surface JPEG/推理坐标系保持原样。

## 1. 官方签名路径核查

### 1.1 SDK 材料是否为原厂

| 项目 | 结果 |
|---|---|
| SDK | OpenHarmony SDK API 26；`native/oh-uni-package.json` 版本 `26.0.0.105` |
| `OpenHarmony.p12` | 8,252 B；SHA-256 `7A5EFC3EA9245596D157F6CCBBDC5B8AE7CD714E7086C3C1645986C9D495D071` |
| 第二份 SDK 副本 | `D:\DevEcoStudio\OpenHarmony\Sdk\26.0.0\toolchains\lib\OpenHarmony.p12`，**大小与 SHA-256 完全相同** |
| 文件时间 | 两份均为 2026-08-27 23:36:51，与同目录 `hap-sign-tool.jar`、Profile 证书一致 |
| 使用后哈希 | 仍为 `7A5EFC…D071`，**未被修改** |

判断：这是 DevEco/OpenHarmony SDK 随包的开发签名材料，**没有发现项目替换证据**。两份独立安装副本逐字节一致、时间戳与 SDK 安装一致，且位于 SDK 目录内。

严格限定：官方未提供该文件的可公开比对哈希，因此不能仅凭哈希做“绝对官方发布”的密码学证明；能确认的是**本机所有 SDK 副本一致、无项目替换痕迹、与官方文档描述的材料/别名/用途一致**。

### 1.2 官方开发签名说明

官方来源：

- [Hap 包签名工具指导（OpenHarmony docs 镜像）](https://openi.pcl.ac.cn/openihu/openharmony-docs/raw/commit/d2713e573e66044418159421f317e19c3ad4b530/zh-cn/application-dev/security/hapsigntool-guidelines.md)
- [OpenHarmony docs](https://gitee.com/openharmony/docs)
- [developtools_hapsigner](https://gitee.com/openharmony/developtools_hapsigner)

文档明确：

- SDK 内置 `OpenHarmony.p12`，包含根 CA、中间 CA、应用签名和 Profile 签名材料；
- 可用官方工具生成新的应用密钥对、由 `OpenHarmony Application CA` 签发应用证书；
- 用 `OpenHarmony Application Profile Debug` 签发 debug profile；
- Profile 必须绑定应用证书、包名、设备 UDID，再签 HAP。

官方文档中的默认开发口令仅用于本机签名，**未写入本报告、日志或证据目录**。本轮实际完成了“新建 app 密钥 + 官方 CA 签发证书 + 独立包名 profile + 签 HAP + 安装”的全链路。

### 1.3 实际证书指纹与设备可信根

| 对象 | SHA-256 指纹 |
|---|---|
| 新应用证书（`previewtest-app.pem` 第 1 张） | `98:C3:67:67:AE:A9:12:4C:7F:9D:7B:C8:90:80:BA:6E:D4:AE:C6:28:72:45:2C:AA:72:CE:3C:1C:5E:9B:D1:5E` |
| OpenHarmony Application CA | `EE:B0:0E:63:40:1C:85:85:3F:67:7A:73:C6:F1:2C:CB:7C:53:69:2D:44:CA:F4:59:99:4B:B2:CE:5A:47:A9:4D` |
| OpenHarmony Application Root CA | `9A:ED:2A:79:92:5E:CA:05:0C:D2:BB:9D:2A:7F:69:4E:49:E5:E1:35:D2:8E:BD:CE:53:83:6D:E7:6B:50:80:ED` |
| Profile Debug 最终证书 | `8F:6E:AB:DB:9E:D8:9D:86:C5:AF:68:84:E6:AF:83:45:69:C1:96:2D:D9:FC:14:5B:D3:39:22:60:9A:A5:AD:43` |

设备 `/system/etc/security/trusted_root_ca.json` 中的 OpenHarmony 根证书指纹同为 `9A:ED…80:ED`；`trusted_apps_sources.json`/`trusted_cert_path.json` 要求 app/profile 由 OpenHarmony Application CA 链签发。

**设备实际安装成功**（不仅本地 `verify-app` 通过），证明该证书/profile 被 DAYU 固件接受。证据：`dayu-previewtest-configurable-signed.hap`，安装时间 2026-10-25；`bm dump` 显示 `appProvisionType: debug`，版本 `1.0.0/1000001`。

### 1.4 一个可用开发签名所需完整材料

本次实际使用并验证：

1. 新 app 私钥及匹配应用证书链：`experiments\dayu-previewtest-2026-10-25\signing\previewtest.p12`、`previewtest-app.pem`；
2. 受设备认可的 Profile 签名：`OpenHarmony Application Profile Debug`，输出 `previewtest.p7b`；
3. Profile 内正确绑定：应用证书指纹 `98:C3…D15E`、包名 `com.dsh.eldercare.previewtest`、设备 UDID `DC3ABD…C0D54C`、`type: debug`；
4. HAP 签名：新 app 私钥签名，`sign-app` 成功，`verify-app` 通过，设备安装成功。

这四项是**同时满足**的，不是任意一项即可；本轮全部满足，故独立测试包可用。

## 2. 独立测试应用

- 工程：`<WORKSPACE>\competition\experiments\dayu-previewtest-2026-10-25`
- 包名：`com.dsh.eldercare.previewtest`
- 应用名：`摄像头方向测试`
- 版本：`1.0.0` / `1000001`
- 权限：仅 `ohos.permission.CAMERA`
- 无 backend / MQTT / homemon / SOS / ACK / 自动上传 / 远程预览；相机由用户主动开始/停止。
- 最终 HAP：`evidence\2026-10-25-dayu-previewtest\dayu-previewtest-configurable-signed.hap`
  - 311,923 B
  - SHA-256 `39391DB0C76B7F2CD5958AC47314BE797C548667F64CD19E05CBD114147489C8`
  - 设备安装路径：`/data/app/el1/bundle/public/com.dsh.eldercare.previewtest/entry.hap`，哈希与上述一致。
- 测试页提供：开始/停止、当前预览尺寸、当前旋转方案、Surface JPEG 抓拍、**画面宽度 30–90% 可调、高度缩放 70–160% 可调**；默认 60% / 130%，一键重置。

## 3. 方向与比例实测

### 3.1 页面方向

页面文字、按钮方向正常；测试页明确标识“摄像头方向测试”。

### 3.2 预览方向

- 初始尝试 `PreviewOutput.setPreviewRotation(ROTATION_0, true)`：页面能启动，但相机会话失败
  `7400201 Invalid Session Configuration`。该调用不是有效修复。
- 去掉该调用后，预览可启动，但画面仍旋转 90°。
- 最终采用**显示层**：
  - 外层 3:4 容器；
  - 内部 4:3 包裹层 `rotate({ angle: -90 })`；
  - XComponent 保持原始比例，不直接旋转 XComponent；
  - 高度缩放：默认 `1.30`（130%），用户可按 5% 步进调整。
- 画面宽度：默认 60%，用户可按 10% 步进调整（30–90%）。
- 可配置版本截图（用户测试时调到 70%/130%）：`pv-config-screen.jpeg`。
- 未同时叠加 Camera API 旋转与显示旋转；最终只用一种显示旋转 + 比例修正。
- 用户确认：**方向正向；画面宽度/比例可自定义且正常**（默认 60%/130%，测试时使用 70%/130%），验收通过。
- 截图：`pv-final-screen.jpeg`。

### 3.3 Surface JPEG

- 抓拍成功，PIL 读取：**640×480，RGB，无 EXIF orientation**，人物/房间方向正常。
- 文件：
  - `surface_final_1501841873439.jpg`，SHA-256 `B7E412027D78FC2E36490BECFF0D7CEEAD94FC9B6477BE9B5ED61401E2D26743`
  - `surface_final_1501841681330.jpg`，SHA-256 `A8BC531F04411AE5159AFF91ED009DE93790B900B38B6424B5E04F6ABCA60A62`
- 显示层旋转/缩放**不改变** Surface JPEG；未旋转 JPEG、未改推理坐标。
- 说明：直接旋转 XComponent 时抓拍曾报 `62980178 Failed to create PixelMap`；改成旋转外层包裹层后抓拍恢复，进一步支持“只动显示层”的方案。

## 4. 生命周期

- 停止 → 再开始：通过（页面“已停止”→“运行中”，尺寸 640×480）。
- Home 后台：通过 `EntryAbility.onBackground` 经 eventHub 通知页面释放相机；重新打开测试页显示“已停止”，再次开始预览成功。
- 页面退出/force-stop：通过 `aboutToDisappear`/`onPageHide` 释放。
- 收尾时测试应用已 force-stop；没有继续占用相机。

## 5. 原版应用与数据

| 项目 | 状态 |
|---|---|
| 原版包名 | `com.dsh.eldercare` |
| 原版 HAP | `/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap` |
| 原版 HAP SHA-256 | `1F2529C1164662B64257E7F1ABA833B3232025DE06146A058F72AD4B4A9D1073`（未变） |
| 原版 HAP 大小 | 1,860,490 B |
| 收尾运行状态 | 已重新启动，PID 7121 |
| 是否覆盖/卸载/清数据 | **否** |
| 测试包 | 已安装但停止；未替换原版 |

`com.dsh.eldercare.previewtest` 与 `com.dsh.eldercare` 是不同 bundle；安装测试包未覆盖原版。

## 6. P0 链路

- 1883/9001/9101/9200/5555 均 **NO-LISTEN**；
- supervisor/worker 进程不存在；homemon 不存在；fport 为空。
- P0 在任务开始时已未运行；本任务**未启动/停止/修改**任何 P0 组件。
- 因此本轮没有 P0 live 冒烟，也不能声称 P0 链路通过；与本任务改动无关。

## 7. 未完成/未验证

1. **P1-B rotate=0 本机人物检测回归未执行**：测试应用不接 9200/推理，没有相应服务；不能写 PASS。
2. **原版应用没有换签名、没有改代码、没有数据迁移**；本任务只验证独立测试应用。若要修正式应用，需要另行走原版签名/发布流程，不能把本轮测试成功表述为正式应用修复成功。
3. 默认 130% 高度缩放/60% 宽度是实测调参结果；正式集成时应保留用户可调设置（或按屏幕分辨率预设），不要仅硬编码 130%。
4. P0 当前未运行，无法做端到端 202 冒烟。
5. 测试应用仍保留安装（已停止），便于复现；未卸载。

## 8. 签名材料安全

- 新测试 keystore `previewtest.p12` 仅保存在实验工程 signing 目录，**未复制到证据目录**；不输出私钥/口令。
- 证据目录只包含：已签名 HAP、公开应用证书、已签名 profile、信任配置、截图/JPEG、报告/日志。
- SDK `OpenHarmony.p12` 未被修改，使用后哈希仍为 `7A5EFC…D071`。
- 官方默认开发口令仅在本机签名流程使用，未写入报告/日志/证据。

## 9. 最终分类

```text
DAYU_PREVIEWTEST_REAL_ACCEPTANCE_PASS
```

独立测试应用：**真机方向/比例验收通过（用户确认可自定义，默认 60%/130%）**；原版应用及数据保留并恢复运行。

相关报告/证据：

- `REPORT.md`（本文件）
- `REPORT-TRUST-BLOCKED-2026-10-25.md`（前一阶段信任链阻塞记录，已被本报告取代）
- `pv-final-screen.jpeg`、`surface_final_1501841873439.jpg`
- `dayu-previewtest-configurable-signed.hap`
- `device-trusted_*.json`
- `verify-app-final.log`、`verify-app-final-chain.cer`、`verify-app-final-profile.p7b`
- `final-state.txt`
