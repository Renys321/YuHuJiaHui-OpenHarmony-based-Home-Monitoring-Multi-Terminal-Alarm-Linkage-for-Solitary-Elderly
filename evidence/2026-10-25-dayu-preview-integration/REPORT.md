# DAYU 正式应用：可调预览方案集成报告

日期：2026-10-25
对象：`com.dsh.eldercare`
分类：`DAYU_FORMAL_PREVIEW_INTEGRATION_PASS_WITH_CAVEATS`

## 0. 结论

```text
正式应用已真实覆盖更新：1.0.2 / 1000002
签名身份与旧版一致（同一应用证书/Profile），安装成功，数据保留
用户确认正式页面方向正向、调节/重置可用
参数已持久化，重启/缺失/无效值均已验证
拍照、暂停/恢复、Home 后台恢复通过
未完成：厨房/卫生间实机切换、正式 Surface JPEG 直接抓取、rotate=0 检测
```

正式更新是**真正安装**，不是独立测试包替代；原文件/数据保留。独立测试应用仍是不同 bundle。

## 1. 安装前状态与回滚

| 项目 | 值 |
|---|---|
| DAYU target | `450100445634303332012847942eca00` |
| 原正式包 | `com.dsh.eldercare 1.0.0/1000000` |
| 原 HAP | 1,860,490 B，SHA-256 `1F2529C1164662B64257E7F1ABA833B3232025DE06146A058F72AD4B4A9D1073` |
| 原数据目录 | `/data/app/el2/100/base/com.dsh.eldercare`（未清） |
| 回滚包 | `northbound/signing/eldercare-signed.hap`；证据副本 `rollback-original-1F2529C1.hap`，哈希同上 |

更新使用 `hdc -t ... install -r` 覆盖；未卸载、未清数据。回滚未触发（更新成功）；若失败可对回滚包执行 `install -r`。

## 2. 正式更新包与签名兼容性

- 工作副本：`<WORKSPACE>\competition\experiments\dayu-eldercare-preview-integration-2026-10-25`（未直接改 `northbound` 冻结工程/包）。
- 版本：`com.dsh.eldercare 1.0.2 / 1000002`。
- 签名：`openharmony application release` 应用密钥 + 原 `final-profile.p7b`。
- 新包应用证书 SHA-256：
  `8E:93:86:3F:C3:2E:E2:38:06:0B:F6:9A:9B:37:E2:60:8F:FF:B2:1F:93:C8:62:DD:51:1C:BA:C9:F3:00:24:B5`
- 与安装前原版 `verify-app` 打印的证书指纹**完全一致**；不是新建测试证书。
- 签名包：1,883,399 B，SHA-256 `A696698A627CFEEE1EE90D4F94A3FAF49B4A2F1BB8A2D813CA3AD245324DAFFE`。
- 实际安装 HAP：`/data/app/el1/bundle/public/com.dsh.eldercare/entry.hap`，哈希与签名包一致。
- `bm dump`：version `1.0.2`，versionCode `1000002`，`appProvisionType: debug`。
- 安装结果：`install -r` 成功；数据目录仍存在；原 preferences 保留。

## 3. 集成内容

- 删除 `CameraModel` 中实际报错的 `setPreviewRotation(ROTATION_0, true)`；不再用 Camera API 旋转。
- 显示层：3:4 外层容器 + 4:3 包裹层 `rotate(-90°)` + 高度缩放；XComponent 保持原生比例。
- 用户可调：
  - 画面宽度 30%–90%，步长 10%；
  - 高度缩放 70%–160%，步长 5%；
  - 默认 60% / 130%；
  - 重置恢复默认；
  - 参数只影响显示，不改变相机 session / Surface JPEG。
- 参数持久化：`@ohos.data.preferences`，store `eldercare_preview_tuning`，键 `widthPct`/`scalePct`；缺失或非法值归一化回 60/130。
- 调节控件只在选中客厅节点时显示；非客厅仍使用稳定遮罩，不删除 XComponent。
- 参数变化只更新布局/transform；没有 start/stop Camera，也没有条件销毁重建 XComponent。

## 4. 真机验证

### 4.1 用户屏幕确认

用户确认正式页面：**方向正向，五个调节按钮可用，重置可回默认**。

### 4.2 参数持久化

| 场景 | 结果 |
|---|---|
| 设为 70% / 135%，重启正式应用 | 70% / 135% 恢复 |
| 重置 60% / 130%，重启 | 60% / 130% 恢复 |
| 写入无效值 5% / 999%，启动 | 回退 60% / 130% |
| 删除 preference 文件（缺失），启动 | 回退 60% / 130% |

实际 preference 文件：
`/data/app/el2/100/base/com.dsh.eldercare/haps/entry/preferences/eldercare_preview_tuning`
内容示例：`scalePct=130.000000, widthPct=60.000000`。测试用的无效/缺失文件已恢复。

### 4.3 拍照/生命周期

- 拍照：成功保存 `eldercare-1501843048504.jpg`，960×1280，925 KB；证明 PhotoOutput 可用。
- 暂停监护：状态“自动监护已暂停”，相机停止；恢复后“监护运行中”。
- Home 后台：日志 `guard foreground event=false`，恢复前台后自动重新启动监护，页面显示“监护运行中”。
- 参数调节期间状态一直保持“监护运行中”，没有因调节重启相机。

### 4.4 Surface JPEG

- 独立测试包（同一 CameraModel/Surface 路径）实测 Surface JPEG：**640×480，RGB，无 EXIF orientation，方向正常**。
- 正式包的显示层旋转不修改 JPEG/推理，`VisionFrameStreamer` 代码路径未改。
- **正式包未直接抓取 Surface JPEG**：当前 P0 视觉 sink/9200 未运行，正式页面只有拍照输出；因此正式 Surface JPEG 的本次直接测量标记为“未直接验证”，不能把测试包结果写成正式包实测。
- 正式拍照文件为 960×1280（旧 PhotoOutput 行为，方向侧向），不是 Surface JPEG；拍照功能通过，但不把照片方向当作预览/推理方向。

### 4.5 厨房/卫生间隔离

- 当前 P0 仅启动冻结 homemon，只上报 `dayu200-living` 客厅节点；没有厨房/卫生间节点可切换。
- 因此**未能实机验证**厨房/卫生间页面不显示客厅画面；代码仍保留原稳定遮罩逻辑（`hasCameraSelected()` 不满足时遮罩），但本轮不作为已验证项。
- 没有修改 P0 设备配置或绑定。

### 4.6 推理回归

- `rotate=0` 本机人物检测**未执行**：P0 视觉服务/9200 未运行，本轮不启动模型性能测试；标记为未验证，不写 PASS。

## 5. P0 状态（准确记录）

- 任务开始时：1883/9001/9101/9200/5555 均无监听，supervisor/worker/homemon 均不存在。
- 为让正式页出现客厅节点，按正式脚本中的冻结原版命令临时启动 `/data/homemon/homemon homemon.conf`：
  - 当前进程 PID 7844，9000 LISTEN；正式应用 `com.dsh.eldercare` 与 9000 有本地 ESTABLISHED 连接。
- supervisor、worker、Broker、Bridge、fport、9200 均未运行；**不是完整 P0 链路**。
- 未使用 INGEST_KEY，未启动 MQTT/HTTP ingest，未触发 FALL/SOS/ACK/reset。

## 6. 回滚结果

更新未失败，未执行回滚。可信回滚包：

`northbound/signing/eldercare-signed.hap`
1,860,490 B
`1F2529C1164662B64257E7F1ABA833B3232025DE06146A058F72AD4B4A9D1073`

若需要恢复：`hdc -t <DAYU> install -r <回滚包>`；覆盖安装保留数据，不卸载、不清数据。

## 7. 未完成/未验证摘要

1. 厨房/卫生间实机切换：无节点，未验证。
2. 正式 Surface JPEG 直接抓取：无 9200 sink，未直接验证（独立测试包 640×480 已验）。
3. rotate=0 人物检测：P0 不完整，未执行。
4. 完整 P0 链路：仅 homemon 运行，supervisor/worker/broker/fport 未运行。
5. 照片方向仍为旧 PhotoOutput 侧向行为；本轮只验证“能拍照”，未修照片方向。
6. 原版正式应用已更新到 1.0.2；独立测试包仍安装但已停止，不影响正式包。

## 8. 证据

- `dayu-eldercare-preview-integration-1.0.2-signed.hap`
- `rollback-original-1F2529C1.hap`
- `app-chain.pem`、`final-profile.p7b`、`formal-verify-app.log`
- `formal-102-screen.jpeg`（正式页控制区/预览）
- `formal-photo-latest.jpg`（正式拍照）
- `formal-persist-*.json`（70/135 重启、重置）
- `formal-invalid2.json`、`formal-missing.json`（无效/缺失回退）
- `testapp-surface-640x480.jpg`（独立测试包 Surface JPEG）
- `final-state.txt`
- `SHA256SUMS.txt`
