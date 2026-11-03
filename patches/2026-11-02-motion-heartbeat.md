# 2026-11-02 · 视觉活动心跳（motion heartbeat）

## 问题

设备侧（DAYU homemon）用 `motion.lastActiveTs` 判断“是否长时间无活动”。视觉服务只发布
`fall`/`monitor`，**从未发布过 `motion`**，导致该时间戳冻结；设备侧随后反复生成
`NO_MOTION` 告警，并抢占活动告警槽位，把 `FALL` 覆盖掉，APP 只能看到“长时间无活动”。

## 改动（`vision/yolo_pose_service.py`）

1. `MqttCommandSink` 新增：

```python
def publish_motion(self) -> None:
    payload = json.dumps(
        {"cmd": "motion", "source": "yolo-pose"},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    self._publish(payload)
```

2. 参数新增 `--motion-heartbeat-sec`（默认 45，0 关闭）。

3. 帧处理里，画面内检测到人且特征有效时，按间隔发布：

```python
if (args.publish and args.motion_heartbeat_sec > 0
        and _LAST_STATE.get("personDetected") and _LAST_STATE.get("features")):
    last_motion = int(motion_state.get("ts", 0))
    if now_ms - last_motion >= args.motion_heartbeat_sec * 1000:
        motion_state["ts"] = now_ms
        sink.publish_motion()
```

## 验证

- `cmd:motion` 每约 45 s 一条；设备 `motion.lastActiveTs` 持续更新；
- `NO_MOTION.countToday` 停止增长；
- 随后跌倒事件生成 `type=FALL` 告警，APP 显示“疑似跌倒”（不再被覆盖）。

证据：`evidence/2026-11-02-fall-live-verification/`（`no-motion-source.log`、`state6/7/10.csv`、截图）。
