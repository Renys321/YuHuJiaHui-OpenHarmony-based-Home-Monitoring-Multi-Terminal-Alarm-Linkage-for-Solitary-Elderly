# 2026-10-28 跌倒检测现场联调记录

## 结论
- 演示机位（DAYU200 板载摄像头 → PC YOLO）首次完整触发：`NORMAL → SUSPECTED → FALLEN`。
- 端到端链路验证通过：视觉发布 `fall` → MQTT `home/dayu200-living/cmd` → bridge → homemon `ALARM FALL` → 板载 APP 显示「疑似跌倒」→ 点「确认闭环」→ `ACKED`。

## 关键证据
- 触发帧：`hipY=0.617 bottom=0.99 angle=68.1 aspect=0.53 drop=0.139`
- MQTT：`{"cmd":"fall","score":0.611,"source":"yolo-pose","evidenceId":"fall-1793194343081-5"}`
- homemon：`ALARM id=a-1793194343-1 type=FALL ... 证据已关联`
- ACK：`ACK 已接受：id=a-1793194343-1 处置=已确认，老人一切正常`，状态 `ACKED`
- 原始记录：`trace-live.log`、`mqtt-fall-cmd.log`、`board-ui-alarm.json`、`board-ui-acked.json`

## 演示机位参数适配（重要）
现场机位为 320×240、约 4 FPS，默认校准参数无法稳定触发；本轮按实测轨迹调整如下（仅用于演示机位，不代表默认验收）：

| 参数 | 默认 | 演示机位 | 原因 |
|---|---|---|---|
| `rapid_hip_drop_per_sec` | 0.15（原 0.18） | 0.10 | 实测快速侧倒峰值 0.117–0.139 |
| `horizontal_torso_angle_deg` | 58° | 45° | 倒地帧角度抖动 |
| `horizontal_bbox_aspect` | 1.05 | 0.95 | 躺姿框比常 0.9–1.0 |
| `upright_torso_angle_deg` | 32° | 25° | 躺姿偶尔误判直立 |
| `recent_drop_ms` | 1200 | 2000 | 帧间隔约 250–400ms，快速下降与横向帧可能隔 1.2–2s |
| `confirm_ms` | 1200 | 0 | 倒地帧后常丢人/换 track，无法二次确认 |
| ground-zone | 无 | `0,0.55,1,1` | 用画面下方地面区替代绝对髋高判据 |

## 风险与边界
- 上述调整降低了触发门槛，误报敏感性上升；演示可用，**不得对外宣称"跌倒检测已验收/准确率"**。
- 正式产品应回到默认参数 + 合适机位/更高帧率，或训练专用分类器。
- 演示启动必须带 `--ground-zone 0,0.55,1,1`，否则用默认脚本可能触发不了。