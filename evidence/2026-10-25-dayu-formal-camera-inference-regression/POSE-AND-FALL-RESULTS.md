# POSE-AND-FALL-RESULTS

## 1. 全身关键点

用户将相机调整到可见全身后，重新运行既有 P1-B 320 / `rotate 0` 服务。

服务统计（`formal-pose-stats.jsonl`）：

```text
elapsedSec=272.7
framesReceived=606, framesInferred=436, framesDropped=169, errors=0
inferMsP50=589, p95=613, max=1051
captureFps=2.22, inferFps=1.60
RSS=63,256 KB, temp=50.0 ℃
postureCounts: UPRIGHT=126, SITTING_OR_CROUCHING=285,
               TRANSITION=2, UNKNOWN=23, HORIZONTAL=0, NO_PERSON=0
fallConfirmedEvents=0
```

事件文件 `formal-pose-events.jsonl`（414 条）中，23:18:37 之后的全身段出现：

- `validKptCount=17`（全部 17 点有效）；
- 肩 5/6、髋 11/12、膝 13/14、踝 15/16 的置信度均显著提高：
  - shoulder 5/6 最高约 0.99
  - hip 11/12 最高约 0.99
  - knee 13/14 最高约 0.99
  - ankle 15/16 最高约 0.96
- 保存帧 `pose-frame_000003.jpg`/`pose-frame_000004.jpg` 为 640×480，可见全身/坐姿全身；
  `pose-frame_000004.jpg` 为坐姿全身。

结论：**全身 17 点关键点真机可见性成立**（不是只输出人物框）。但各安全动作的人工阶段没有逐段标注时间戳，posture 输出在 UPRIGHT/SITTING_OR_CROUCHING 之间切换；因此不能把每个动作的自动分类写成全部正确。

## 2. 安全动作与姿态

用户执行：站立 → 缓慢坐下 → 站起弯腰 → 缓慢蹲下 → 站起恢复；未做危险跌倒。

事件中实际出现：

- UPRIGHT（站立）126 帧；
- SITTING_OR_CROUCHING（坐/蹲）285 帧；
- TRANSITION 2 帧；
- UNKNOWN 23 帧；
- HORIZONTAL 0 帧。

说明状态机确实接收了有效关键点并输出姿态类别；但由于没有逐动作标注，不能声称“站立/坐下/弯腰/蹲下四类逐项分类全部通过”。可确认的是：**全身关键点有效、姿态状态有真实变化、无 HORIZONTAL**。

## 3. 跌倒判断

- P1-B 离线状态机 fixture 历史 13/13 PASS（本任务不重跑）。
- 本轮真机安全动作 272.7s：`fallConfirmedEvents=0`，所有事件 `fall=false`，没有误报 FALL。
- 关键点丢失/恢复：早期 validKpt 约 7–11，后段恢复到 17；未因此产生 FALL；`reasonCodes` 包含关键点不足。
- **未执行真实危险跌倒**，也没有声称真实 FALL 正例；本任务只验证了安全动作下的无误报、关键点有效性和状态机持续运行。
- P1-B HTTP 响应固定 `fall=false/fallEvaluated=false`，未接生产告警；事件仅本地 JSONL。

## 4. 结论

```text
FULL_BODY_KEYPOINTS: PASS（17/17，安全动作段）
POSTURE_CLASSIFICATION: PARTIAL（有 UPRIGHT/SITTING 状态，缺少逐动作标注）
FALL_FALSE_POSITIVE_CHECK: PASS（安全动作 0 次误报）
REAL_FALL_POSITIVE: NOT_TESTED（按安全边界，不做危险摔倒）
```

不得写成“跌倒检测完成”或“真实跌倒正例通过”。
