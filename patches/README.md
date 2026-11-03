# 关键修复与补丁

本目录收录可复核的代码变更。`.diff` 为统一 diff，其余为文件级说明（没有 before 快照时）。

| 补丁 | 内容 | 证据 |
|---|---|---|
| `2026-11-01-speaker-clip-parse.diff` | `speaker_link.c`：`"type":"clip"` 会先命中 `"clip"` 键，`parse_int_field` 返回 0 导致本地片段静音；改为按 `"clip":` 取值 | `evidence/2026-11-01-clip-fix-and-soak/` |
| `2026-11-02-fall-direction.diff` | `vision/fall_detector.py`：新增方向不敏感“快速塌落”判据（`collapse_*`），修复竖向/朝镜头跌倒漏检；180° 判据不变 | `evidence/2026-11-02-fall-orientation/` |
| `2026-11-02-motion-heartbeat.md` | `vision/yolo_pose_service.py`：新增 `--motion-heartbeat-sec`（默认 45 s），画面内有人时发布 `{"cmd":"motion"}`，避免设备侧 `lastActiveTs` 冻结后反复误判“长时间无活动”覆盖 FALL | `evidence/2026-11-02-fall-live-verification/` |
| `2026-11-02-app-auto-switch.md` | `northbound/.../pages/Index.ets`：自动跳 AI 问答页收窄为“FALL/MANUAL_SOS 且不在预警页”，并加 30 s 节流 | `evidence/2026-11-02-fall-live-verification/` |

## 应用方式

- `.diff`：在仓库根目录 `git apply patches/<file>.diff`（路径以仓库根为基准）；
- `.md`：按说明定位对应文件手工合入；两处改动均已在当前源码中生效。
