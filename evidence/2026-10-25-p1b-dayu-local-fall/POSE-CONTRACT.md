# POSE 契约（P1-B）

## 1. 关键点定义

模型：Ultralytics YOLO11n-pose，17 个 COCO person keypoints，顺序固定：

```text
0 nose
1 left_eye        2 right_eye
3 left_ear        4 right_ear
5 left_shoulder   6 right_shoulder
7 left_elbow      8 right_elbow
9 left_wrist      10 right_wrist
11 left_hip       12 right_hip
13 left_knee      14 right_knee
15 left_ankle     16 right_ankle
```

每个点为 `(x, y, conf)`；坐标在**原始图像像素**坐标系（已从 320/416/640 padded 输入反变换回原图）。

## 2. 有效性

- 单点有效：`conf >= kpt_conf_min`（默认 0.30）。
- 整体有效：`valid_kpts >= min_valid_kpts`（默认 8）且**肩中点与髋中点均可计算**（至少一侧肩/髋有效）。
- 不满足时：`posture = UNKNOWN`、`fallEvaluated = false`、不输出任何“安全/无人/未跌倒”的结论。

## 3. 几何量

- 肩中点 `S`、髋中点 `H`：左右点都有效时取平均；仅一侧有效时用该侧，并在文档/事件中仍视为有效。
- 躯干角 `torsoAngle = atan2(|Sx-Hx|, |Sy-Hy|)`，单位度；0°≈竖直，90°≈水平。
- `bboxAspectRatio = bbox.w / bbox.h`。
- 髋-膝垂直间距、髋-踝垂直间距均按 bbox 高度归一化。

## 4. 姿态状态与判据

| 状态 | 判据（默认阈值） |
|---|---|
| `NO_PERSON` | 有效推理且 `personCount=0` |
| `UNKNOWN` | dataValid=false，或关键点不足，或肩/髋缺失，或主目标丢失/未稳定 |
| `HORIZONTAL` | torsoAngle ≥ 55°，或 bboxAspectRatio ≥ 1.35 且 torsoAngle ≥ 40° |
| `TRANSITION` | 40° ≤ torsoAngle < 55°（弯腰/起身过渡） |
| `SITTING_OR_CROUCHING` | torsoAngle < 40°，且髋-膝间距 < 0.18×bboxH（坐下），或髋-踝间距 < 0.45×bboxH 且髋-膝间距 < 0.35×bboxH（蹲下） |
| `UPRIGHT` | torsoAngle < 40° 且不满足坐/蹲条件 |

说明：

- **单帧 HORIZONTAL 不是跌倒**；只有“快速下降候选 + 水平姿态持续”才可能进入 FALL。
- 缓慢躺下（无快速下降）保持 `MONITORING`，输出 `HORIZONTAL_WITHOUT_DESCENT`，不会触发 FALL。
- `postureConfidence` 由有效关键点比例、平均单点 conf 和距阈值余量计算，范围 0–1；它不是跌倒置信度。

## 5. 多人/跟踪契约

- 跟踪：每帧检测与已有轨迹按 IoU（≥0.20）或中心距离（≤0.25×最大 bbox 对角线）关联；未匹配的新检测创建新 `trackId`（`tN`）。
- 主目标：
  1. 优先保持上一主目标（仍在本帧匹配到）；
  2. 主目标短暂丢失时，在 `track_grace_ms`（默认 800 ms）内保持主目标并输出 `PRIMARY_LOST_GRACE`，不切换到其他人；
  3. 超过 grace 后才按“conf + 0.2×√归一化面积”选择新主目标；此时 `track_switched=true`，**重置姿态/跌倒候选状态**，旧事件不迁移到新目标。
- 只有 `hits >= min_track_hits`（默认 2）且主目标稳定的帧才允许 `fallEvaluated=true`；单帧不会进行跌倒确认。
- 所有时间使用 `CLOCK_MONOTONIC` 毫秒；非单调帧被拒绝（`NON_MONOTONIC_TIME`）。

## 6. 真实相机关键点现状（必须如实记录）

- DAYU 相机帧为 **640×480**；经 `read_image` 人工核对，画面为**正面近景、方向正常**（无需旋转），仅头/肩在画面内。
- 真实近景帧（320 模型）示例：`validKptCount=6`，nose/eyes/ears/shoulders conf 0.79–0.97，但 hips conf 仅 0.013/0.019 → `KPT_INSUFFICIENT`、`posture=UNKNOWN`、`fallEvaluated=false`。
- 现场空间不足，用户无法后退到全身入镜（头到脚）的位置；因此**本轮无法用真实人体安全动作验证 UPRIGHT/SITTING/HORIZONTAL 的姿态语义**。
- 结论：姿态语义只在 fixture 中完成验证；真机姿态验证失败（见 `LIVE-SAFETY-ACCEPTANCE.md`）。
