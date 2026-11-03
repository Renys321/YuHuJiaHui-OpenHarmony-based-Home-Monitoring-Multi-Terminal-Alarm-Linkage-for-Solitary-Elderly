# 跌倒检测真机验收清单（2026-11-02 收尾版，给现场执行）

> 适用范围：PC 侧 `vision/fall_detector.py` 2026-11-02 收尾补丁（含
> `collapse_terminal_drop_per_sec=0.22`、`/v1/state` 诊断字段、构图告警）。
> **开始前先读 §1 构图前提**：不满足构图的数据一律作废，不得用于命中率/误报率结论。
> 全程不刷写/不重启设备、不调用串口/网关；只重启 PC 视觉服务（9200）即可。

## 0. 目标与判定口径

**2026-11-02 已完成（受控实机）**：第一批 4 次受控跌倒 4/4 检出；补丁版交替测试
（跌倒→快速深蹲 ×3）跌倒 3/3 检出、快速深蹲 0/3 误报（`state6.csv` 5 次深蹲 0 事件、
`state7.csv` 交替 3+3 印证）。**尚未完成**：真实跌倒录像、近景构图支持、SOS/ACK 端到端、
慢坐/慢蹲/弯腰负例（建议再采一轮）。

| 项 | 目标 | 口径 |
|---|---|---|
| 三方向受控跌倒 | 各 3 次，**9/9 检出** | 竖向屈膝 / 朝镜头前倒 / 侧倒；受控动作，非真实跌倒 |
| **快速深蹲/快坐到地面（独立硬指标）** | 5 次，**0 误报** | 不得用离线 7/7 PASS 代替；交替测试已达成 0/3，需持续复测 |
| 慢坐 / 慢蹲 / 弯腰 | 各 3 次，**0 误报** | 负例（建议补采） |
| 已躺卧/床/沙发（可选） | 5 次，0 误报 | 配合 `--exclude-zone` |
| 端到端 | FALL → MQTT cmd → Bridge → homemon `ALARM FALL` → APP「疑似跌倒」→ 确认闭环 ACK | 每次跌倒动作至少完整跑 1 次（2026-11-02 只验证到告警显示/用户确认，ACK 未归档） |
| FALLEN 持续/恢复 | 躺卧时持续 FALLEN；起身回到站立高度后 `recover_ms` 内回 NORMAL | 记录时长 |
| A/B（可选） | `--disable-collapse` 对照：三方向应回到漏检 | 证明改动生效，不对外发布 |

任何一条不达标即该轮 **FAIL**；若因构图/关键点不可信导致，先修构图再重测，不把无效数据计入。

## 1. 构图前提（硬前提，先确认再测）

1. 相机固定安装、方向锁定（服务启动日志出现 `frame rotation locked: 0`，`--frame-rotation 0`）。
2. 人全身入镜：头到脚完整可见，脚下留 >10% 画面余量。
3. 人离相机 **≥2 m**。
4. 站立帧：`hipY < 0.70` 且 `bboxBottom < 0.97`（用 §2 的轮询脚本看）。
5. 画面里没有大面积遮挡/反光；床/沙发等位置用 `--exclude-zone` 排除。
6. 构图确认方法：让测试者站立 10 s，轮询状态，检查 `framingSuspectInvalid` 长期为 False、
   `bottomClipped` 为 False、`hipY<0.7`、`bboxBottom<0.97`。否则**调机位重来**。

## 2. 启动与采集（由现场负责人执行）

```bat
REM 1) 启动视觉服务（沿用现有 USB 转发；不刷机）
cd /d <WORKSPACE>\competition
.venv-vision\Scripts\python.exe vision\yolo_pose_service.py --model vision\yolo11n-pose.pt --device cpu --publish --broker 127.0.0.1:1883 --target-device dayu200-living --ground-zone 0,0.55,1,1

REM 2) 另开窗口：订阅 MQTT（记录 cmd:fall 与 FALL 告警）
node bridge\mqtt_tool.js listen home/# > evidence\2026-11-02-fall-live-verification\mqtt-clean.log

REM 3) 另开窗口：轮询状态（新 poll_state.py 已带 collapse/构图字段）
.venv-vision\Scripts\python.exe evidence\2026-11-02-fall-live-verification\poll_state.py evidence\2026-11-02-fall-live-verification\state-clean.csv 1800
```

执行前检查 `/healthz` 与 `/v1/state` 正常；每个动作前后在 CSV 里能对得上时间戳。
建议：每个动作前由测试者口述编号（“竖向 1”），负责人在 CSV/MQTT 日志旁记一行时刻，
便于事后把“动作序号 ↔ FALLEN 时刻”对齐。

## 3. 动作清单（按顺序，动作之间站起并静置 ≥5 s）

| 组 | 动作 | 次数 | 备注 |
|---|---|---|---|
| A | 竖向屈膝下坠（保护垫） | 3 | 躯干尽量保持竖直，膝先屈 |
| B | 朝镜头方向前倒（保护垫） | 3 | 手撑/垫子保护 |
| C | 侧倒/躺平（保护垫） | 3 | 侧向旋转到接近水平 |
| D | 快速深蹲 / 快坐到地面 | 5 | 本次重点负例；每次坐稳 3–5 s 再起身 |
| E | 慢坐（椅子） | 3 | 慢速、可停留 |
| F | 慢蹲（不碰地） | 3 | |
| G | 弯腰捡东西 | 3 | 髋部基本不下降 |
| H | 已躺卧/床上（可选） | 5 | 需 `--exclude-zone` |

每组之间可暂停 10–20 s，避免 track 混叠；**不要在同一次 FALLEN 未恢复时做下一动作**。

## 4. 通过标准（逐条勾选）

- [ ] 构图检查通过（§1.6 全部满足）。
- [ ] A/B/C 共 9 次：9/9 出现 `SUSPECTED→FALLEN`，MQTT 每次 1 条 `cmd:fall`，
      APP 每次都出现「疑似跌倒」；至少完成 1 次 APP 确认闭环 ACK。
- [ ] D 共 5 次：0 次 FALLEN（若出现，记录 `SUSPECTED` 时刻的 collapse 字段：
      terminal_drop、peak、body_drop、hipY/bboxBottom，用于判断是否真跌倒式的曲线）。
- [ ] E/F/G 共 9 次：0 次 FALLEN。
- [ ] 每次动作后能正常回到 NORMAL（记录恢复耗时）。
- [ ] 长时间保持躺卧：FALLEN 持续且不重复告警（每次 episode 只 1 条 `cmd:fall`）。
- [ ] 没有出现“构图有效但 9 次动作只检出 2 次”这类系统性漏检。
- [ ] （可选）`--disable-collapse` 对照 A/B/C 应漏检，证明判据路径生效。

## 5. 记录与归档

采集结束后把以下文件交给负责归档的人（Lead）：
1. `state-clean.csv`（新 `poll_state.py` 输出，含 `framingSuspectInvalid`、`collapse*` 列）；
2. `mqtt-clean.log`（含每条 `cmd:fall` 与 FALL 告警状态）；
3. 手机 APP 告警截图 / ACK 截图各 1–2 张（若条件允许）；
4. 动作序号 ↔ 时刻的对照记录（手写/聊天记录均可）；
5. 本清单勾选结果。

归档负责人应：
- 先检查 `framingSuspectInvalid=True` 的比例；若 >20% 或长时间连续 True，判该轮构图无效、作废；
- 再按“三方向/快速深蹲/慢动作/端到端”分组统计，更新
  `evidence/2026-11-02-fall-live-verification/README.md` 与 `SHA256SUMS.txt`；
- 对外只写“受控实机 N/N 检出、0 误报（受控动作，非真实跌倒）”，不宣称准确率/召回率。

## 6. 已知边界（不要当成失败条件）

- **真实跌倒**（非受控、无保护、速度更快、可能出画/遮挡）本轮仍不测，阈值未用真实跌倒标定。
- 恒速“自由落体式”塌落与快速蹲坐在物理上不可区分：离线 `boundary_constant_speed_collapse`
  会触发，属已知边界；现场 D 组若出现**恒速**下坠曲线触发，应记录而不是简单判失败。
- 人倒地后若始终不站起，FALLEN 会持续；这是保守锁存，不是告警闭环失败。
- 手机/公网链路（4G、微信通知）不在本清单范围。
