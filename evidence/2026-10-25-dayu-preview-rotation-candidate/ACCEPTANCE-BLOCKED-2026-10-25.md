# DAYU 客厅预览方向修复：真机验收阻塞报告

日期：2026-10-25
分类：`DAYU_PREVIEW_ROTATION_LOCAL_BUILD_PASS_REAL_ACCEPTANCE_PENDING`
（按用户分类：**仅本地构建通过；真机验收待签名**）

## 0. 一句话结论

候选代码/构建已完成，**但 `OpenHarmony.p12` 签名口令无法恢复，无法生成 signed HAP，因此没有安装、没有真机预览验收**。当前 DAYU 上仍是原版 HAP，应用数据/运行状态未被本任务改变。

## 1. 现场预检（只读）

- HDC target：`450100445634303332012847942eca00`（仅此一个 target；未使用模拟器 5555 作 DAYU 安装目标）。
- 当前 DAYU 应用：`com.dsh.eldercare`，versionName `1.0.0`，versionCode `1000000`，运行 PID `2239`。
- 当前安装 HAP：`/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap`，大小 **1,860,490 B**，SHA-256 **`1F2529C1164662B64257E7F1ABA833B3232025DE06146A058F72AD4B4A9D1073`**。
- 可信原版回滚包：`northbound/signing/eldercare-signed.hap`，大小/哈希与安装包完全一致；已复制到候选 `rollback/DAYU-eldercare-signed-original-1F2529C1.hap`。
- P0 当前：1883/9001/9101/9200/5555 **均无监听**；supervisor/worker PID 11872/50580 **进程不存在**；homemon 进程不存在；fport 为空。P0 在本次任务开始时已未运行；本任务未启动/停止/修改任何 P0 组件。
- 9200：无监听；无 P1-B 候选进程。

## 2. 候选与源码

- 原始候选（保留）：`dayu-preview-rotation0-2026-10-25-unsigned.hap`，1,823,686 B，SHA-256 `CAA07EE4...B84D42A`。
- 注释修正后 v2 候选：`dayu-preview-rotation0-commentcorrected-2026-10-25-unsigned.hap`，1,823,686 B，SHA-256 `27423737A9B7D77DF17FE757B1639636646797E04C5D82CF9800FD2C99A94BCF`。
- 源码：`northbound/entry/src/main/ets/model/CameraModel.ets`，SHA-256 `71F5DAE41B9B7BF00261A556950541C14E94D40A0BC5AD05C400F31146160C59`。
- 修改点：`createPreviewOutput` 后调用
  `this.previewOutput.setPreviewRotation(camera.ImageRotation.ROTATION_0, true);`
- 注释已改为**未证实假设**：不再声称 compositor 必然附加旋转，也不再假定 JPEG/推理不受影响；这些必须真机验证。
- `assembleHap`：**BUILD SUCCESSFUL**，33 tasks（16 executed/17 up-to-date）；HAP 仍未签名（日志 WARN: skip sign）。
- 本轮未重跑 33 项本地测试（修改为注释/既有候选，不重复跑已通过测试）；此前候选记录为 33/33 PASS。

## 3. 签名尝试（失败）

使用既有合法流程：

```text
java -jar hap-sign-tool.jar sign-app
  -keyAlias "openharmony application release"
  -appCertFile northbound/signing/app-chain.pem
  -profileFile northbound/signing/final-profile.p7b
  -keystoreFile SDK/.../OpenHarmony.p12
  -pwdInputMode 1   (交互隐藏输入)
```

- `final-profile.p7b` 已验签成功：debug profile，bundle `com.dsh.eldercare`，UDID `DC3ABD...C0D54C`（DAYU），有效期至 2036。
- 两次打开签名窗口均未在 30 秒内取得有效口令；工具返回 `No password input` / `keystore password was incorrect`，**未生成 signed HAP**。
- 用户确认不记得签名口令；按边界**没有读取/导出/猜测口令，没有重建 keystore**。
- 结果：无 signed HAP、无安装、无真机验收。

## 4. 十个必答问题

| # | 问题 | 回答 |
|---|---|---|
| 1 | 最终使用哪种方向修正，修改了哪里？ | 候选使用 `PreviewOutput.setPreviewRotation(ROTATION_0, true)`（`CameraModel.ets` L140 后）；**未真机验证**，不能称为已修复。 |
| 2 | ROTATION_0 候选实际是否有效？ | **未验证**。没有 signed HAP/安装，无法观察屏幕。 |
| 3 | 用户是否在 DAYU 屏幕确认预览正向？ | **否**；没有安装候选。 |
| 4 | Surface/JPEG 方向和尺寸有无变化？ | **未改变**：本任务未安装、未运行新代码；历史 P1-B 证据仍为 640×480 方向正常，但不能代替本次验证。 |
| 5 | rotate=0 本机人物检测是否回归通过？ | **本轮未执行**；不能写成 PASS（历史 P1-B 结果只作背景）。 |
| 6 | 房间归属、拍照、相机生命周期是否正常？ | **未测试**（未安装）。 |
| 7 | P0 当前链路有无受影响？ | **无本任务修改**；但 P0 在任务开始时已未运行（端口/PID/ homemon/ fport 均不在），无法做 live 202 冒烟；未重启 P0。 |
| 8 | 真正安装的 HAP 路径/大小/SHA-256？ | **没有安装新 HAP**；当前仍是原版 `entry.hap`，1,860,490 B，`1F2529C1...D1073`。 |
| 9 | 原 DAYU 回滚包在哪里，失败时是否恢复？ | `northbound/signing/eldercare-signed.hap` 与候选 `rollback/DAYU-eldercare-signed-original-1F2529C1.hap`；因未安装，无需回滚，未发生恢复操作。 |
| 10 | 尚未验证项目？ | 真实屏幕方向、预览拉伸/裁切、房间未配置摄像头、JPEG 方向/尺寸、rotate=0 检测、拍照、前后台/切房/释放相机、P0 live 冒烟；全部待签名后验收。 |

## 5. 继续所需的最小条件

1. 取得 `OpenHarmony.p12` 的签名口令（上一轮签名操作者/密码管理器/本机 SDK 默认开发口令）。  
2. 运行 `sign-candidate-ready-v2.cmd`（交互隐藏输入，不写口令），生成
   `dayu-preview-rotation0-commentcorrected-2026-10-25-signed.hap`。
3. `hap-sign-tool verify-app` 验签；`hdc -t 450100445634303332012847942eca00 install -r <signed.hap>`。
4. 启动 APP，请用户确认预览正向；再做 JPEG/rotate=0/拍照/生命周期/P0 冒烟。

## 6. 回滚（签名后如需要）

```powershell
$hdc='D:\DevEcoStudio\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$t='450100445634303332012847942eca00'
& $hdc -t $t install -r '<WORKSPACE>\competition\northbound\signing\eldercare-signed.hap'
& $hdc -t $t shell 'aa start -a EntryAbility -b com.dsh.eldercare'
```

覆盖安装保留应用数据；不卸载、不清数据。原包哈希已核对 `1F2529C1...D1073`。

## 7. 边界

未改 DAYU 已安装 HAP、未安装候选、未启动/停止 P0、未操作串口、未改 backend/Wi-Fi/DNS、未读/写任何口令或 Token、未触发 SOS/ACK/FALL。候选 HAP 与回滚包保留在独立目录。
