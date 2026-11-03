# DAYU 客厅预览方向候选

```text
DAYU_PREVIEW_ROTATION_LOCAL_BUILD_PASS_REAL_ACCEPTANCE_PENDING
```

## 问题与修复

- 现场确认：DAYU 页面方向正常，只有客厅摄像头预览顺时针偏转 90 度；手持设备顶部朝屏幕右侧。
- P1-B 已确认从 Surface 抽取的 640x480 JPEG 方向正常，推理必须继续使用 `rotate=0`。
- `CameraModel.ets` 在创建 `PreviewOutput` 后显式调用
  `setPreviewRotation(camera.ImageRotation.ROTATION_0, true)`，停止显示合成阶段附加旋转。
- 未给 `XComponent` 添加几何旋转，现有 4:3 容器不会因宽高交换而裁切。
- 未修改 `VisionFrameStreamer.ets`、P1-B 模型、推理坐标、APP、homemon、Broker、Bridge 或后端。

## 本地验证

- northbound Node 回归：33/33 PASS。
- `assembleHap`：BUILD SUCCESSFUL，33 tasks（16 executed / 17 up-to-date）。
- 编译产物已确认包含 `setPreviewRotation(ROTATION_0, true)`。
- HAP 未签名、未安装、未做真机验收。

## 候选

```text
dayu-preview-rotation0-2026-10-25-unsigned.hap
size=1,823,686 B
SHA-256=CAA07EE4D29504CEAB916C25F9AF672B9E8F53C5E51C73D006636D776B84D42A
```

## 真机验收门槛

安装前保留当前正式 DAYU HAP 和回滚路径。安装候选后必须同时验证：

1. DAYU 页面文字、按钮和导航方向正常；
2. 客厅预览中的人物与物体方向正常；
3. 预览不拉伸、不裁切；
4. 厨房和卫生间仍显示“该房间未配置摄像头”；
5. Surface JPEG 仍为方向正常的 640x480 图像；
6. P1-B 继续使用 `rotate=0`，人物检测不回归为 `NO_PERSON`；
7. 拍照、自动监护、页面前后台恢复和相机释放无回归。

任一关键项失败，恢复原 DAYU HAP；不得写成 REAL PASS。

## 2026-10-25 真机验收状态（追加）

```text
LOCAL BUILD PASS / SIGNING BLOCKED / NOT INSTALLED
```

- v2 unsigned（注释已改为未证实假设）:
  `dayu-preview-rotation0-commentcorrected-2026-10-25-unsigned.hap`
  size=1,823,686 B
  SHA-256=27423737A9B7D77DF17FE757B1639636646797E04C5D82CF9800FD2C99A94BCF
- 当前 DAYU 仍安装原版 HAP（1,860,490 B，`1F2529C1...D1073`）。
- `OpenHarmony.p12` 签名口令不可得，无法生成 signed HAP / 安装；详见 `ACCEPTANCE-BLOCKED-2026-10-25.md`。
- 获取口令后运行 `sign-candidate-ready-v2.cmd`。
