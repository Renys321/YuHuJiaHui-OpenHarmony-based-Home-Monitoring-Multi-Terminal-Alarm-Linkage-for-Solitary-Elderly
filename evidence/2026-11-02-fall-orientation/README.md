# 跌倒方向鲁棒性诊断与修复（2026-11-02）

> **一句话结论**：能修。根因是判定链路的**方向硬门槛** `horizontal`（要求身体在图像平面内
> 旋转到水平），竖向屈膝下坠与朝摄像头前倒永远不满足；另外 `upright` 忽略"肩必须在髋上方"
> 的方向符号，会把朝镜头前倒的投影误判成直立。本目录给出离线复现、根因逐条行号、PC 侧
> Python 补丁（含 16 条新单元测试）、受控实机验证结论和 DAYU 板端 C++ 移植建议。
>
> **证据等级**：
> - ✅ 离线验证：合成正/负例关键点序列（3 套机位配置）+ 6 个真实 DAYU 关键点会话回放 +
>   2026-10-28 现场 trace 回放 + 74 条视觉测试（含 16 条新增方向鲁棒性测试；仍 4 条历史失败）。
> - ✅ **受控实机**（2026-11-02，`evidence/2026-11-02-fall-live-verification/`）：
>   第一批：用户确认的 4 次受控跌倒（竖向屈膝/朝镜头前倒/侧倒/额外受控跌倒）**4/4 检出**，
>   快速深蹲 0 误报（旧代码）；补丁版**交替测试（跌倒→快速深蹲 ×3）= 跌倒 3/3 检出、
>   快速深蹲 0/3 误报**（MQTT 恰好 3 条 `cmd:fall`）。全部为**受控动作，不是真实跌倒**；
>   18:39–18:41 的 6 个事件归属不清，**不作误报/命中率证据**。
> - ⛔ **真实跌倒未验证**：没有真实跌倒录像；阈值（0.30/s、0.22/s、0.78 地面层）仍需
>   现场用真实跌倒标定。机位/构图不满足（下肢截断、近景）时数据无效，见 §6。
> - 本目录**没有**操作过 DAYU 板子、串口、网关或 9200 服务；实机结果来自 Lead/用户现场采集。

## 0. 用户现象 → 代码对应

用户原话：“DAYU200 的 yolo 检测有点难搞啊，只能是 180 度跌倒才行，竖着跌倒都不行。”

对照 2026-10-28 现场联调（`evidence/2026-10-28-fall-live-test/trace-live.log`）里唯一一次成功
触发：

```text
21:32:22.737 state=SUSPECTED hipY=0.552 bottom=0.982 angle=73.7 aspect=0.48 drop=0.122
21:32:24.086 state=FALLEN    hipY=0.617 bottom=0.990 angle=68.1 aspect=0.53 drop=0.139
```

成功帧的 `angle=68.1°`——身体已经侧向旋转到接近水平，`horizontal` 成立。竖向跌倒（躯干保持
竖直）与朝镜头前倒（透视压缩后投影仍近似竖直）的 `angle` 永远是 0–25°，`bbox_aspect` 也
上不去，因此**永远不会进入 `horizontal`**。这就是“只有 180° 才行”的代码原因。

## 1. 判定链路（先分清两套实现、两套阈值）

### 1.1 现网真机链路（用户看到的那条）

```text
DAYU200 APP 相机预览抓 JPEG
  → hdc rport tcp:9200 → PC 127.0.0.1:9200
  → competition/vision/yolo_pose_service.py（YOLO11n-pose，--model vision/yolo11n-pose.pt）
  → competition/vision/fall_detector.py（FallDetector 时序状态机）
  → MQTT home/dayu200-living/cmd {"cmd":"fall"} → bridge → homemon → APP/告警
```

- 视觉服务入口：`vision/yolo_pose_service.py`，HTTP JPEG ingest 在 `--listen-port`
  （`yolo_pose_service.py:454-459`），跌倒在 `process_result()`（`:579-602`）调用
  `detector.update()`；`DetectorConfig` 使用默认值（`:933-937` 构造 `FallDetector`）。
- 启动脚本：`vision/start_dayu_usb_vision.cmd`（`hdc rport tcp:9200 tcp:9200` +
  `yolo_pose_service.py --listen-port 9200`）。
- 架构文档只有一句方向性描述：`docs/ARCHITECTURE.md:36-38`
  “只有近期直立、快速髋部下落、低位水平姿态持续成立时才发出 fall”。

### 1.2 DAYU 本地实现（另一套阈值，不是现网判定）

| 位置 | 实际能力 | 跌倒判定 |
|---|---|---|
| `vision/dayu-local/src/dayu_local_yolo.cpp`（ncnn 本地推理） | 输出 person bbox + 17 关键点 JSON | **没有跌倒逻辑**：响应固定 `"fall":false,"fallEvaluated":false`（L557、L600） |
| `evidence/2026-10-25-p1b-dayu-local-fall/`（P1-B 板端候选） | 本地姿态 + 时序状态机（C++） | 有独立状态机，但同样要求 HORIZONTAL；且 APP 响应仍固定 `fall=false` |

**两套阈值对照（必须分开说，不能混用）**

| 判据 | PC 侧 `fall_detector.py`（现网默认，含 10-28 演示调参） | DAYU P1-B `fall_core.h` |
|---|---|---|
| 水平躯干角 | ≥45°（原 58°，演示调低） | ≥55° |
| 水平框宽高比 | ≥0.95（原 1.05） | ≥1.35（且需躯干≥40°） |
| 快速下降阈值 | hip ≥0.10/s | hip ≥0.45/s 且 0.6s 窗口内 drop ≥0.15 |
| 下降后要求 | 水平 + 低位 | 必须出现 HORIZONTAL，再持续 800ms |
| 确认方式 | 进入 SUSPECTED 后下一帧（confirm=0） | 水平持续 2200ms → FALL_CONFIRMED |
| 输出 fall=true | PC 发 MQTT | 仅本地 JSONL；APP 固定 false |
| 关键点置信度 | 肩/髋 ≥0.35 | 全局 ≥0.30 且 ≥8 个有效点 |

结论：**两条链路都因为“必须 HORIZONTAL”而漏检竖向跌倒**，但阈值数值不同。PC 侧 10-28 的
演示调参（45°/0.95/0.10/confirm=0）是为了让**已经侧倒到 68°**的那次演示能触发，它不解决
方向问题，而且引入了新的误报敏感性（见 §3.6）。

## 2. 根因（逐条阈值 + 代码行号）

以**未修改的提交版** `vision/fall_detector.py` 为准（本目录
`repro/fall_detector_baseline.py` 是修改前快照，SHA256 与提交版一致，见 `SHA256SUMS.txt`）。
判定条件是 `update()` 中 NORMAL→SUSPECTED 的与：

```python
# fall_detector.py:316-329（baseline）
if recent_upright and recent_drop and horizontal and low and not excluded:
    self.state = FallState.SUSPECTED
```

逐条：

| # | 条件 / 行号 | 取值 | 为什么挡掉竖向跌倒 |
|---|---|---|---|
| R1 | `horizontal` `:281-284`（进入条件 `:325`，确认条件 `:341`） | `torso_angle_deg >= 45` **或** `bbox_aspect >= 0.95` | **核心根因**。竖向屈膝：torso≈0–15°、aspect 0.5–0.9；朝镜头前倒：投影 torso≈0–10°、框仍偏竖 → 两个分支都不成立，永远进不了 SUSPECTED |
| R2 | `torso_angle_deg` 定义 `:198-200` | `atan2(|dx|, |dy|)`，且 dx/图像宽、dy/图像高 | ① 取绝对值丢掉方向：肩在髋**下方**（朝镜头前倒的投影反置）仍算 0°；② 归一化坐标对 4:3 相机有透视偏置：`tan θ_norm = (H/W)·tan θ_px = 0.75·tan θ_px`，阈值 45° 实际相当于物理 53.1°，记录到的 68.1° 相当于物理 73.2° |
| R3 | `upright` `:274-280`（确认/复位用 `:331-333`） | `torso<=25°` 且（`aspect<=0.85` 或 `bottom>=0.98`） | 无方向符号。朝镜头前倒的人投影后 `shoulder_hip_dy<0`（肩低于髋）却仍 `upright=True`，会被当成“已恢复直立”直接抑制告警；基线版本也没有可绕开该门的通道 |
| R4 | `low` `:285-288`、`:295-298` | `hip_y>=0.58 且 bbox_bottom>=0.76`；配置 ground-zone 时 `low=ground_hit` | 不是漏检主因（真实躺姿/坐姿 hip 常 0.9+，低门槛几乎总成立），但**区分度差**：2026-10-16 真实机位坐/蹲 diag 记录 `hip_y=0.965, bbox_bottom=0.997, low=true`，与“跌倒后”几乎相同 |
| R5 | `rapid_hip_drop_per_sec` `:133` | 0.10/s（原 0.15/0.18） | 10-28 演示调参。受控坐下/下蹲真实峰值约 **0.17/s**（`diag-stderr.log` 真实样本；`fall_detector.py:132` 注释同源），0.10 门槛已经**低于安全动作峰值**，只靠 R1 挡误报 |
| R6 | `horizontal_bbox_aspect` `:129` | 0.95（原 1.05） | 真实机位近景坐/蹲时下肢被画面截断 → 人体框近方形（真实回放 aspect 0.96–1.02）→ 被当成“水平”。这就是 §4.3 中 baseline 在**真实安全动作**上出现 3 次误报的原因 |
| R7 | `recent_drop_ms/recent_upright_ms` `:134-135`（`:317-324`） | 6000 / 2000 ms | 只要求“快速下降”和“直立历史”出现在窗口内，**不要求与水平帧同一因果**：2s 内任一帧 horizontal 即可确认，慢躺下（0.08–0.10/s）也容易踩线（见 §4.4） |
| R8 | `drop_rate` `:251-266` | 只算髋部 | 朝镜头前倒时**肩/头下沉比髋更快**，但代码完全没用肩的下坠速度；方向不敏感的证据被丢弃 |
| R9 | DAYU P1-B `fall_core.h:66-67,73-74,78-79`；`fall_core.cpp:227-231,678-688,714-756` | 55° / 1.35 / 0.45/s / 2200ms | 板端另一套阈值，但结构同病：`DESCENT_CANDIDATE` 只能经 HORIZONTAL 进入 FALL_CONFIRMED |

**可量化证据（帧级）**：在合成的竖向/前向跌倒序列里，baseline 有 **67% / 60%** 的帧满足
“近期直立 + 快速下降 + 低位 + 未排除”，**唯独 `horizontal=False`**（见
`data/RESULTS.md` 第 4 节“帧级根因”表）。同一张表里，正常坐下/蹲下也有 58–63% 的帧处在这
同一条“只差 horizontal”的边缘——所以**不能简单删掉 horizontal**，必须补一个能区分“受控
坐下”和“失控塌落”的方向不敏感判据。

## 3. 修复方案（方向不敏感判据）

### 3.1 思路：用“动力学 + 末端落地证据”代替“姿势朝向”

| 维度 | 旧判据（方向敏感） | 新判据（方向不敏感） |
|---|---|---|
| 身体是否倒下 | 躯干在图像平面内转 ≥45° | 相对最近**站立基线**，`body_drop = max(髋下沉, 肩下沉) ≥ 0.22` |
| 倒地速度 | hip 速率 ≥0.10/s（与 sit 重叠） | 窗口内 `peak ≥ 0.30/s`（受控坐下实测 0.17/s，留 1.7× 余量） |
| 触底那一帧 | 不检查 | **触底瞬时速度 ≥0.22/s**（受控蹲下在到底前已减速；真机 4 次受控跌倒进入帧为 0.281–0.461/s） |
| 是否到地面 | hip_y≥0.58 且框底≥0.76（sit 也满足） | 至少一条末端证据：髋到地面层 `≥0.78` / 肩很低 `≥0.72` / **肩低于髋**（投影反置）/ 框高塌缩 ≤站立基线的 55% |
| 单帧抖动 | 靠 horizontal 顺带过滤 | `collapse_confirm_ms=200`：判据需连续成立才确认 |

### 3.2 同时修正的两处方向语义

1. `upright` 增加 `shoulder_hip_dy > 0`（肩中心必须在髋中心上方）。否则朝镜头前倒的
   投影反置会被判成直立，既抑制告警又会在塌落路径里刷新站立基线。
2. `horizontal` 的 `bbox_aspect` 分支增加 `torso_angle >= 35°`。近方形框只在躯干确实倾斜
   时才算“水平”，修掉真实坐/蹲近方框误报（R6）。
3. **水平角阈值保持 45°**（未应用收紧）：曾根据 18:39–18:41 批次（3 次“躺倒”49.4/71.6/58.9°
   vs 2 次“弯腰/蹲下”47.7/47.5°）离线评估过把 `horizontal_torso_angle_deg` 提到 48.5°；但该
   批次动作归属后续被用户更正为“归属不清、不作误报证据”，而 18:46–18:48 交替测试（跌倒 3/3、
   快速深蹲 0/3）是在 **45°** 下完成的。因此**不引入未经真机验证的收紧**；48.5° 仅作为离线
   候选记录在 `data/real_machine_event_audit.md`。

### 3.3 不改的东西（保持 180° 演示行为）

- `horizontal_torso_angle_deg`、`horizontal_bbox_aspect`、`rapid_hip_drop_per_sec`、
  `recent_*_ms`、`confirm_ms` **全部保持 10-28 演示值不变**。180° 用例继续走旧路径，
  行为不变；`collapse_enabled=False` 可完全回到修改前。
- `ground-zone` / `exclude-zone` / track 隔离 / 恢复逻辑的合同不变。

### 3.4 参数表（补丁默认值，已写入 `DetectorConfig`）

| 参数 | 默认 | 含义 | 依据 / 风险 |
|---|---|---|---|
| `collapse_enabled` | `True` | 总开关（A/B 用） | 设 False = 2026-10-28 前行为 |
| `collapse_min_body_drop` | `0.22` | 相对站立基线的总下沉（归一化图像高） | 坐/蹲总下沉约 0.16–0.18，跌倒 ≥0.30；贴近 0.22 的边界需真机复核 |
| `collapse_window_ms` | `2500` | 从最近站立基线起算 | 覆盖 2 FPS 下 2–4 帧 |
| `collapse_peak_drop_per_sec` | `0.30` | 峰值下坠速度 | 真机受控坐下 0.17/s；**真实跌倒录像缺失，此值最需要真机标定** |
| `collapse_floor_hip_y` | `0.78` | 髋到“地面层” | 演示机位躺姿 hip 只有 0.617（10-28 trace），可能需 ground-zone 或 shoulder 通道兜底 |
| `collapse_floor_shoulder_y` | `0.72` | 肩到画面低位 | 朝镜头前倒时肩/头先落地 |
| `collapse_inversion_margin` | `0.03` | 肩低于髋的容差 | 投影反置判据 |
| `collapse_max_height_ratio` | `0.55` | 框高 / 站立基线框高 | 仅当 hip≥0.70 时参与，防弯腰捡物误报 |
| `collapse_confirm_ms` | `200` | 连续成立时间 | 防单帧关键点跳变（见 `test_8`） |
| `collapse_terminal_drop_per_sec` | `0.22` | **触底帧**（进入 SUSPECTED 那一帧）髋/肩瞬时下坠速度下限 | 受控蹲下触底前已减速 → 拒绝；真机 4 次受控跌倒进入帧 0.281/0.328/0.461/0.397/s，留 ≥28% 余量；只在进入时检查，确认/保持阶段不查 |
| `horizontal_torso_angle_deg` | 45.0（**保持**） | `horizontal` 的躯干角阈值 | 真机交替测试在 45° 下完成（跌倒 3/3、深蹲 0/3）；曾离线评估 48.5°（依据批次归属不清）**未应用**，10-28 trace 68.1° 在两种取值下都通过 |
| `horizontal_aspect_min_torso_deg` | `35.0` | 近方框分支的最小躯干角 | 修 R6；35° 以下躯干视为直立/坐姿 |

### 3.5 为什么坐/蹲不误报（合成 + 真实验证）

- 坐下：髋总下沉 0.177、峰值 0.18/s → `collapse_min_body_drop` 与 `peak` 两条都不过；
- 蹲下：髋总下沉 0.17、峰值 0.17/s → 同样不过；且末端证据（髋 0.73 < 0.78、肩 0.53 < 0.72、无投影反置、框高比 0.71 > 0.55）也不成立；
- 弯腰：髋几乎不降，`body_drop≈0.19 < 0.22`；
- **快速深蹲/快坐到地面**（离线合成，受控减速曲线）：整体下沉与峰值速度可以越过前两道门，
  但触底帧速度已降到 <0.22/s → 被 `collapse_terminal_drop_per_sec` 拒绝（`test_14`）；
  把该门槛关掉后同一序列会误报（`test_15` A/B），证明是它起作用；
- 真机 2026-11-02 快速深蹲/快坐到地面：全程 NORMAL、0 误报（旧代码，有效负例）；
- 缓慢躺下：峰值 <0.10/s、无快速下降 → 新判据不触发（旧路径的误报见 §4.5，属历史问题）；
- 真实 DAYU 安全动作回放：baseline **3 次误报 → patched 0 次**（§4.3）。

### 3.6 明确风险

1. **阈值未经真实跌倒标定**：0.30/s、0.22/s、0.78 都来自“受控动作实测 + 自由落体推算”，
   仓库内没有真实跌倒录像；DAYU 只有 2–4 FPS，采样会平滑峰值。2026-11-02 的 4 次是
   **受控跌倒**（垫子、受控倒），不能当作真实跌倒分布。
2. **快速深蹲/快坐到地面（离线已修、真机交替测试 0/3）**：离线经“触底瞬时速度”门槛后
   `stress_fast_deep_crouch` 0 误报；真机补丁版**交替测试（跌倒→快速深蹲 ×3）跌倒 3/3 检出、
   快速深蹲 0/3 误报**。18:39–18:41 的 6 个事件归属不清（用户当时未做完整负例），
   **不作误报证据**。残余：`horizontal` 45° 对“深弯腰恰好 >45°”理论上仍可能误报（离线评估过
   48.5° 候选但未应用）；恒速自由落体式塌落仍是已知边界。**`真机快速深蹲 0 误报` 作为
   独立硬指标需持续复测，不能用离线 PASS 代替。**
3. **恒速自由落体式塌落仍是边界**：离线 `boundary_constant_speed_collapse`（恒速 0.58/s 到地面）
   仍会触发 1 次。恒速下坠与自由落体在物理上不可区分，检测器不能同时拒绝一切快速蹲坐；
   该场景只记录、不作为验收项。
4. **旧路径的慢躺下误报仍在**：`rapid_hip_drop_per_sec=0.10` + `confirm_ms=0` 使 0.08–0.10/s 的
   缓慢躺下也可能触发（baseline 与 patched 相同，非本补丁引入；列为 legacy 边界）。
5. **竖向跌倒在低处仍呈直立姿态**：patched 的恢复条件改为“回到站立基线高度”，若老人跌坐在地上
   后自己坐直，状态会保持 FALLEN 直到起身（符合预期，但会让 `fall=true` 持续更久，MQTT 侧注意 TTL/去重）。
6. **机位/构图是硬前提**：2026-11-02 18:31 批次因整段 `bboxBottom≈0.998–1.0`（腿被切）、
   `hipY 0.50–0.97` 抖动而作废（9 次跌倒只检出 2 次）；18:36 新补丁批次仍有 45% 帧
   `bboxBottom≥0.98`，只检出 2 次且 2 次疑点被取消（同样作废）。已加保护：
   **框底触底兜底只在“仍在站立高度”时生效**——若髋已比站立基线低 `collapse_min_body_drop`，
   不再用 bottom-clip 判 upright（`_bottom_clip_upright_ok`），避免下沉帧被误判“已恢复”而取消
   疑点；`/v1/state` 已暴露 `features.bottomClipped` 与 `framing.suspectInvalid`，构图无效期间
   的数据不得用于结论。**验收必须全身入镜、离相机≥2m、站立帧 `hipY<0.70`、`bboxBottom<0.97`。**
7. 朝镜头前倒的“投影反置”依赖肩/髋关键点可靠；近景遮挡时关键点置信度 <0.35 会直接
   `features_valid=False`，此时任何判据都无解（需机位/跟踪层面解决）。

## 4. 复现实验

### 4.1 数据与脚本

| 文件 | 作用 |
|---|---|
| `repro/fall_detector_baseline.py` | 修改前 `vision/fall_detector.py` 的**只读快照**（SHA256 与提交版一致），用于公平 A/B |
| `repro/scenarios.py` | 合成 COCO-17 关键点序列（3 类正例 + 4 类负例 + 3 类边界），帧率/分辨率/噪声可配 |
| `repro/run_matrix.py` | 3 套机位配置 × 10 个场景 × baseline/patched，输出帧级与事件级结果；并回放 6 个真实会话 |
| `repro/analyze_real.py` | 真实 DAYU 关键点事件盘点/特征统计（`data/real_features.csv`） |
| `repro/replay_demo_trace.py` | 回放 2026-10-28 现场唯一成功触发的 trace（特征级反推），验证 180° 用例不回归 |
| `repro/audit_live_events.py` | 18:39–18:41 归属不清批次的路径/角度分析（48.5° 候选评估，未应用） |
| `data/real_machine_event_audit.md` / `.json` | 该批次 8 个 FALL 事件的路径与新/旧阈值对照（仅分析，不作误报证据） |
| `repro/dayu-p1b-collapse-patch-proposal.md` | 板端 C++ 移植建议（设计说明） |
| `repro/make_draft.py` + `repro/dayu-p1b-collapse-draft/` | **可编译 C++ 草案**：从 P1-B `fall_core` 只读复制并打补丁，含主机单测（已用 g++ 编译跑通 6/6） |
| `data/draft_host_selftest.log` | C++ 草案主机单测输出 |
| `data/results_frames.csv` | 逐帧判定链路取值（含“被 horizontal 单独挡掉”标记） |
| `data/results_events.csv` / `data/RESULTS.md` | 事件级通过/失败、首事件延迟（含 3 套配置硬指标） |
| `data/real_replay_compare.json` | 真实安全动作回放 baseline vs patched 事件数 |
| `data/demo_trace_replay.json` | 10-28 现场演示 trace 的 baseline/patched 再生结果 |
| `data/unittest_baseline.log` / `data/unittest_patched.log` | 单元测试前后日志 |
| `evidence/2026-11-02-fall-live-verification/` | 2026-11-02 受控实机：4 次受控跌倒 4/4 检出、快速深蹲 0 误报、作废批次与构图前提 |

复现命令（Windows，仓库自带 venv；全部离线，不需要板子/相机/9200）：

```bash
cd competition
.venv-vision/Scripts/python.exe evidence/2026-11-02-fall-orientation/repro/run_matrix.py
.venv-vision/Scripts/python.exe evidence/2026-11-02-fall-orientation/repro/analyze_real.py
cd vision && ../../competition/.venv-vision/Scripts/python.exe -m unittest \
  test_fall_orientation test_fall_detector test_fall_calibration test_ground_zone \
  test_diag_snapshot test_yolo_pose_service
```

说明：合成场景是**手工构造的关键点时间曲线**（站立→动作→保持），人体框由关键点外接框
+按分辨率缩放的边距生成；它验证的是**判定链路逻辑**，不是检测器在真实画面上的关键点质量。
真实数据只用于负例回放（6 个会话全部为已记录的安全动作，无真实跌倒）。

### 4.2 事件级结果（3 套机位配置；`data/RESULTS.md` 全文）

**默认配置 `absolute_4fps`（当前 `start_dayu_usb_vision.cmd` 的绝对低位模式）**

| 场景 | 类别 | 期望 | baseline | patched | patched 首事件延迟 |
|---|---|---|---|---|---|
| `side_fall_180` | positive | 跌倒 | ✅ 1 次 | ✅ 1 次 | 750 ms |
| `vertical_buckle`（竖向屈膝） | positive | 跌倒 | ❌ 0 次 | ✅ 1 次 | 1000 ms |
| `forward_camera_fall`（朝镜头前倒） | positive | 跌倒 | ❌ 0 次 | ✅ 1 次 | 1000 ms |
| `negative_sit_down` | negative | 不跌倒 | ✅ 0 | ✅ 0 | — |
| `negative_crouch_down` | negative | 不跌倒 | ✅ 0 | ✅ 0 | — |
| `negative_bend_over` | negative | 不跌倒 | ✅ 0 | ✅ 0 | — |
| `negative_already_lying` | negative | 不跌倒 | ✅ 0 | ✅ 0 | — |
| `stress_fast_deep_crouch`（受控减速快速深蹲，**硬指标 0 误报**） | boundary（硬指标） | 不跌倒 | ✅ 0（旧场景未覆盖该路径） | ✅ **0** | — |
| `boundary_constant_speed_collapse`（恒速≈自由落体，只记录） | boundary | 不跌倒 | ✅ 0 | ⚠️ 1（已知边界） | 750 ms |
| `negative_slow_lie_down`（legacy，只记录） | boundary | 不跌倒 | ❌ 1（历史误报） | ❌ 1（历史误报） | 3250 ms |

> 2026-11-02 晚：`stress_fast_deep_crouch` 由“恒速 0.58/s 到地面”改为**受控减速**的物理合理
> 曲线（旧曲线物理上等于自由落体，已单独保留为 `boundary_constant_speed_collapse` 只记录），
> 并新增 `collapse_terminal_drop_per_sec=0.22` 后，该负例在 3 套机位配置下均 **0 误报**；
> required 场景（3 正例 + 4 负例）**7/7 PASS**。

**`groundzone_4fps`（演示机位 `--ground-zone 0,0.55,1,1`，320×240）**：与上表相同；
竖向/前向各 750ms 检出；坐/蹲/弯腰 0 误报；快速深蹲 0 误报；恒速边界 1 次（只记录）。

**`absolute_2fps`（低帧率鲁棒性）**：竖向/前向 1500ms 检出、180° 1000ms 检出；坐/蹲/弯腰/
快速深蹲 0 误报；恒速边界 1 次（只记录）。三套配置 required 均 **7/7 PASS**。

**帧级根因（baseline，`data/RESULTS.md` §4）**

| 配置 | 场景 | 帧数 | 仅被 `horizontal` 挡掉 | 占比 |
|---|---|---|---|---|
| absolute_4fps | vertical_buckle | 30 | 20 | 67% |
| absolute_4fps | forward_camera_fall | 30 | 18 | 60% |
| absolute_4fps | side_fall_180 | 30 | 2 | 7%（成功帧靠 horizontal 通过） |
| absolute_4fps | negative_sit_down | 38 | 22 | 58%（说明不能简单删门） |

### 4.3 真实 DAYU 关键点回放（安全动作，期望 0 事件）

数据：`evidence/2026-10-25-dayu-formal-camera-inference-regression/*.jsonl`（640×480 真实
相机帧的 17 关键点，`primaryKeypoints` 像素坐标）与 `2026-10-26-demo-autostart`；全部会话
在原始证据中记录为**安全动作、无真实跌倒**。

| 真实会话 | 帧数 | baseline 事件 | patched 事件 |
|---|---|---|---|
| formal-pose-events | 436 | **2** | 0 |
| formal-live-events | 1288 | 0 | 0 |
| formal-redo-events | 495 | 0 | 0 |
| formal-redo3-events | 646 | **1** | 0 |
| formal-capture-events | 142 | 0 | 0 |
| demo-events-mid | 1396 | 0 | 0 |

baseline 的 3 次误报都发生在真实安全动作上，触发参数与根因一一对应：

```text
torso=0.5°  aspect=1.00  drop=0.134   ← R6：近方框被当 horizontal
torso=2.0°  aspect=1.02  drop=0.077   ← R6
torso=9.8°  aspect=0.96  drop=0.055   ← R6
```

patched 的 `horizontal` 近方框分支要求躯干 ≥35°，这 3 次全部消失；同时新的塌落判据在
真实数据最高峰值 0.134/s（<0.30）上没有触发 → **真实数据上 0 误报**。

### 4.4 现场演示 trace 回归（180° 用例必须保持）

用 2026-10-28 现场**唯一一次**真实成功触发（`evidence/2026-10-28-fall-live-test/trace-live.log`，
437 帧逐帧记录）做特征级反推回放（由 trace 的 `hipY/bottom/angle/aspect` 反推等价 PoseFrame，
不是逐像素真机复现），结果：

```json
{
  "baseline": {"events": [{"ts": 18127, "torso": 68.1, "aspect": 0.53}], "final_state": "NORMAL"},
  "patched":  {"events": [{"ts": 18127, "torso": 68.1, "aspect": 0.53}], "final_state": "NORMAL"},
  "same_event_timing": true
}
```

即：**180° 用例在补丁前后的事件时刻与触发姿态完全一致**（相对时间 18127ms，
`torso=68.1° aspect=0.53`），补丁没有改变旧路径行为。该相对时间对应 trace 里 21:32:24.284
那一行，比 trace 记录的首个 `FALLEN` 行（21:32:24.086）晚 1 帧——这是反推回放与当时实际
运行参数（ground-zone/确认窗口）差异造成的，**baseline 与 patched 之间没有任何差异**，
A/B 结论不受影响。完整输出见 `data/demo_trace_replay.json`。

### 4.5 受控实机验证（2026-11-02，详见 `evidence/2026-11-02-fall-live-verification/`）

**第一批（白天版补丁，用户确认）**：

| 项 | 结果 |
|---|---|
| 受控跌倒 | **4/4 正确检出**：18:22:04（竖向屈膝）、18:22:27（朝镜头前倒）、18:22:39（侧倒）、18:25:08（额外受控跌倒）；全部经 collapse 路径（FALLEN 帧 torso 0.1–13.5°、aspect 0.34–0.41） |
| 进入帧下坠速度 | 0.281 / 0.328 / 0.461 / 0.397 /s（`collapse_terminal_drop_per_sec=0.22` 的标定依据） |
| 快速深蹲/快坐到地面 | 18:26:06–18:26:41 全程 NORMAL，**0 误报**（旧代码，有效负例） |
| 告警链路 | MQTT 4 条 `cmd:fall`；手机/板端告警正常（用户现场确认；ACK/手机截图未归档） |
| 构图无效批次 | 18:31:18–18:34:17、18:36:26–18:38:17 因腿/脚被切（bboxBottom≈0.998–1.0、hipY 抖动）**作废** |

**第二批（收尾版补丁：terminal 门槛 + 构图保护 + `/v1/state` 诊断）—— 两种口径要分开**：

1) **决定性：交替测试（18:46:47–18:48:22）**：用户按“跌倒 → 快速深蹲”交替 3 轮，
   结果 **跌倒 3/3 检出**（18:47:09 torso 55.6° horizontal；18:47:44 collapse，terminal 0.185；
   18:48:01 torso 61.5° horizontal）、**快速深蹲 0/3 误报**，MQTT 恰好 3 条 `cmd:fall`；
   `state6.csv`（5 次深蹲 0 事件）与 `state7.csv`（交替 3+3）互相印证。

2) **归属不清、不作证据**：18:39–18:41 的 6 个事件（3 次“躺地/腾空”+ 3 次“弯腰/蹲跪/蹲坐”）
   用户当时未做完整负例，动作归属后续被更正为**归属不清**，因此**不能作为“快速深蹲误报”
   证据**。仅把它当作角度分布与路径分析素材：

| 时间 | 快照内容 | 事件 torso | 路径 |
|---|---|---|---|
| 18:39:25 | 人躺在地上 | 49.4° | horizontal |
| 18:39:34 | 深弯腰 | 47.7° | horizontal |
| 18:40:00 | 蹲/跪地 | 47.5° | horizontal |
| 18:40:13 | 侧向腾空 | 71.6° | horizontal/collapse |
| 18:40:23 | 人躺在地上 | 58.9° | horizontal |
| 18:41:56 | 蹲坐在地 | 35.7° / drop 1.37/s | collapse |

3) **离线候选分析（未应用）**：基于上表曾评估 `horizontal_torso_angle_deg` 45°→48.5°
   （horizontal 路径：3 次“躺倒”49.4/71.6/58.9° 仍接受、2 次“弯腰/蹲下”47.7/47.5° 被拒绝；
   10-28 trace 68.1° 不受影响）。因依据批次归属不清、且交替测试是在 45° 下完成的，
   **该收紧未应用**，仅记录在 `data/real_machine_event_audit.md` 作为后续真机候选项。

4) **补充负例窗口（18:49:12–18:51:10，`state8.csv`）**：535 个 5 Hz 样本全程 NORMAL、
   `mqtt-negatives-app.log` 中 `cmd:fall`=0；现场标注为“坐/蹲/弯腰”类安全动作
   （逐动作语义以 Lead/用户记录为准）。完整慢动作逐项验收仍需后续补齐。

### 4.6 已知历史问题（不是本补丁引入，但必须记录）

1. `negative_slow_lie_down`（legacy 边界）：baseline 与 patched 都误报。原因是 R5/R7：
   `rapid_hip_drop_per_sec=0.10` + `confirm_ms=0`，0.08–0.10/s 的缓慢躺下也会踩线。
   该场景已从“必须 0 误报”移出为 legacy 边界（与补丁无关）。
2. 提交版单元测试本身已有 **4 条失败**（修改前后完全相同：baseline 44 条 / patched 74 条，
   失败都是同 4 条；见 `data/unittest_baseline.log` 与 `data/unittest_patched.log`）：
   - `test_fall_detector.test_bending_is_not_a_fall`：45° 弯腰 + 0.30/s 髋速即触发（10-28 调参副作用）；
   - `test_fall_detector.test_quick_drop_and_sustained_horizontal_pose_emits_once`：确认提前（confirm 0 vs 测试期望 1200ms）；
   - `test_fall_calibration.test_7_slow_drop_010_per_sec_never_fires`：0.10/s 恰好等于新阈值；
   - `test_fall_calibration.test_13_calibrated_defaults_are_exact`：测试仍锁定旧值 0.15/1200ms。
3. 这些失败说明：**10-28 的“演示机位调参”是未同步测试/文档的临时改动**。生产环境应回到
   58°/1.05/0.15/1200ms，并用本补丁的塌落判据补方向；演示机位可继续用现参数。

## 5. 补丁实现与前后对比

### 5.1 改动文件

| 文件 | 改动 |
|---|---|
| `vision/fall_detector.py` | 新增 `collapse_*` 配置（含 `collapse_terminal_drop_per_sec`）与 `horizontal_aspect_min_torso_deg`；`PoseFeatures` 增加 `shoulder_y/bbox_height/knee_y/ankle_y/bottom_clipped`；`upright` 增加方向符号与**近景 bottom-clip 兜底保护**（`_bottom_clip_upright_ok`）；新增 `_collapse_evidence(require_terminal=...)`；状态机新分支与恢复语义；`snapshot()` 增加 `collapse`/`baseline`/`terminal`/膝踝诊断；bbox 逆序防御。**`horizontal_torso_angle_deg` 保持 45°**（48.5° 仅离线评估、未应用） |
| `vision/yolo_pose_service.py` | 新增 `--disable-collapse`（A/B）；`/v1/state` 增加 `features.shoulderY/bboxHeight/kneeY/ankleY/bottomClipped`、`collapse` 诊断块、`suspectedMode`、`framing`（构图告警） |
| `vision/test_fall_orientation.py` | 新增 **21 条**单元测试（方向不敏感判据、180° 保持、坐蹲不误报、单帧跳变、投影反置、ground-zone、恢复、快照、参数锁定、terminal 门槛正反例/A-B、近景 bottom-clip 保护、45° 阈值锁定、10-28 trace 68.1° 回归） |
| `repro/make_draft.py` + `repro/dayu-p1b-collapse-draft/` | 板端 C++ 可编译草案（主机 g++ 编译 + 6 用例单测通过），未改 P1-B 原件 |
| `evidence/2026-11-02-fall-live-verification/poll_state.py` | 轮询列同步扩展（collapse/terminal/膝踝/构图告警） |

### 5.2 测试结果

```text
修改前（baseline 快照 + 原测试）：Ran 44 tests … FAILED (failures=4)
修改后（补丁 + 21 条新测试 + 服务测试）：Ran 79 tests … FAILED (failures=4)
```

- 4 条失败为**同 4 条历史失败**，修改前后完全一致 → 无回归（10-28 演示调参遗留）；
- 新增 21 条全部通过；`test_4_collapse_disabled_matches_legacy` 证明关闭开关后行为回到原状；
- `test_14`/`test_15` 证明快速深蹲（离线受控减速）0 误报是 terminal 门槛在起作用；
- `test_16` 证明触底仍在下坠的跌倒不被误伤；
- `test_17`/`test_18` 锁定近景构图保护；
- `test_19`/`test_20` 锁定 49.4° 与 10-28 trace 68.1° 正例不能回归；`test_21` 锁定 45° 阈值
  （48.5° 候选未应用）。

### 5.3 回滚 / A-B

```bash
# 行为回滚（不 revert 代码）：
vision/yolo_pose_service.py --disable-collapse ...
# 完全回滚：用 repro/fall_detector_baseline.py 覆盖 vision/fall_detector.py（SHA256 见清单）
```

## 6. 真机验证清单

**已部分执行**：2026-11-02 受控实机 4 次受控跌倒 4/4 检出、快速深蹲 0 误报（§4.5）。
**尚未执行**（收尾版补丁加载后 / 真实跌倒）：

0. **先验构图**（硬前提）：全身入镜、离相机 ≥2 m、站立帧 `hipY<0.70`、`bboxBottom<0.97`；
   轮询 `/v1/state.framing.suspectInvalid` 长期为 False 才开测。2026-11-02 18:31 批次就是
   反面案例（腿被切 → 9 次跌倒只检出 2 次，作废）。
1. **采集真实跌倒录像**：侧倒/躺平、竖向屈膝下坠、朝镜头前倒各 ≥3 次（安全垫、有人保护），
   坐下/蹲下/弯腰/俯身捡物/快速坐到地上各 ≥5 次；采集时用新版 `poll_state.py` 记录
   `collapse`/`terminalDrop`/`kneeY`/`ankleY`/`bottomClipped`/`framingSuspectInvalid`。
2. **复核 `collapse_terminal_drop_per_sec=0.22`**：看真实跌倒“进入 SUSPECTED 那一帧”的
   terminal 速度分布；真机 4 次受控跌倒为 0.281–0.461/s。若真实跌倒出现 <0.22 的样本，
   说明该门槛会 fail-closed 漏检，需要重定（但不能低于受控蹲下的触底速度）。
3. **标定 `collapse_peak_drop_per_sec`**：真机受控坐下峰值 0.17/s；若真实跌倒峰值 <0.30，
   优先用 `--ground-zone` + 肩/框高通道，而**不要**把阈值降到 0.17 以下（会与坐下重叠）。
4. **标定末端证据**：确认该机位躺姿的 `hip_y`（10-28 记录仅 0.617，低于默认 0.78）；若确实
   到不了 0.78，配置 `--ground-zone 0,0.55,1,1` 或调低 `collapse_floor_hip_y`，并同时确认
   ground-zone 不覆盖床/沙发（`--exclude-zone`）。
5. **误报回归**：用 `--disable-collapse` 做 A/B，统计 30 分钟安全动作的 FALL 次数；要求
   patched 不高于 baseline，且快速坐到地上场景用新 `terminalDrop` 列单独评估（§3.6 风险 3）。
6. **端到端**：FALL → MQTT → bridge → homemon → APP 显示 → 确认闭环 ACK 全链路重跑一次；
   检查 `fall=true` 持续时长与恢复（§3.6 风险 5）。
7. **只有通过后**，才考虑把 `rapid_hip_drop_per_sec` 等生产默认恢复为 0.15/58°/1.05/1200ms。

完整可执行清单见 `evidence/2026-11-02-fall-live-verification/REAL-MACHINE-ACCEPTANCE-CHECKLIST.md`。

## 7. 未验证 / 不适用范围

- ⛔ **没有真实跌倒录像**；“竖向/前向检出”结论来自合成序列 + **受控跌倒**（第一批 4/4、
  交替测试 3/3），真实跌倒的冲击速度、遮挡、出画、丢点、ByteTrack 换 ID 未覆盖；
  不得宣称准确率/召回率。
- ✅ 收尾版（terminal 门槛 + 构图保护）已由 18:46–18:48 交替实机测试验证：
  跌倒 3/3 检出、快速深蹲 0/3 误报；但**慢坐/慢蹲/弯腰负例、真实跌倒录像仍未验证**。
- ⛔ 机位/构图不满足时（下肢截断、近景、`hipY≥0.7`、`bboxBottom≥0.97`）结论无效；已有
  两批采集作废记录（18:31、18:36–18:38）。
- ⛔ 没有修改、编译、烧录、运行 DAYU 端 C++/ncnn；`repro/dayu-p1b-collapse-draft/` 只是
  主机可编译草案与单测，未在 ARM32/ncnn/板上验证，板端 APP 目前仍固定 `fall=false`。
- ⛔ 本目录未操作 9200/板子/串口/网关；实机采集由 Lead/用户执行，本目录只做离线分析与归档。
- 本补丁不改变视觉模型本身；若 YOLO 在竖向跌倒场景频繁丢人/关键点置信度 <0.35，任何规则
  都救不回来（属于机位/帧率/模型问题）。

## 8. 文件清单与 SHA256

见同目录 `SHA256SUMS.txt`（含本目录全部文件 + 本次修改的 vision 文件 + 修改前
`fall_detector.py` 基线快照哈希）。实机归档的 SHA 见
`evidence/2026-11-02-fall-live-verification/SHA256SUMS.txt`。
