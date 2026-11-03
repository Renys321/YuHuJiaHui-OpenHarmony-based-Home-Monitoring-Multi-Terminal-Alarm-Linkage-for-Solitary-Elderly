"""Temporal fall decision logic for COCO-style pose observations.

The detector deliberately does not depend on YOLO, OpenCV, or NumPy. A model
adapter converts its output into ``PoseFrame`` values; this module owns only the
explainable temporal rules and can therefore be reused by a PC or RKNN runner.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from math import atan2, degrees
from typing import Iterable, Mapping, Optional, Sequence, Tuple


COCO_KEYPOINT_NAMES = (
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
)


@dataclass(frozen=True)
class Point:
    x: float
    y: float
    confidence: float


@dataclass(frozen=True)
class PoseFrame:
    ts_ms: int
    bbox: Tuple[float, float, float, float]
    keypoints: Mapping[str, Point]
    pose_confidence: float = 1.0
    track_id: Optional[int] = None

    @classmethod
    def from_coco(
        cls,
        ts_ms: int,
        bbox_xyxy: Sequence[float],
        keypoints_xyc: Sequence[Sequence[float]],
        image_width: int,
        image_height: int,
        pose_confidence: float = 1.0,
        track_id: Optional[int] = None,
    ) -> "PoseFrame":
        if image_width <= 0 or image_height <= 0:
            raise ValueError("image dimensions must be positive")
        if len(bbox_xyxy) != 4:
            raise ValueError("bbox_xyxy must contain four values")

        def nx(value: float) -> float:
            return max(0.0, min(1.0, float(value) / image_width))

        def ny(value: float) -> float:
            return max(0.0, min(1.0, float(value) / image_height))

        points = {}
        for index, values in enumerate(keypoints_xyc[: len(COCO_KEYPOINT_NAMES)]):
            if len(values) < 2:
                continue
            confidence = float(values[2]) if len(values) > 2 else 1.0
            points[COCO_KEYPOINT_NAMES[index]] = Point(
                nx(float(values[0])), ny(float(values[1])), confidence
            )

        return cls(
            ts_ms=int(ts_ms),
            bbox=(
                nx(float(bbox_xyxy[0])),
                ny(float(bbox_xyxy[1])),
                nx(float(bbox_xyxy[2])),
                ny(float(bbox_xyxy[3])),
            ),
            keypoints=points,
            pose_confidence=float(pose_confidence),
            track_id=track_id,
        )


@dataclass(frozen=True)
class PoseFeatures:
    valid: bool
    torso_angle_deg: float = 0.0
    bbox_aspect: float = 0.0
    hip_y: float = 0.0
    center_x: float = 0.0
    center_y: float = 0.0
    bbox_bottom: float = 0.0
    pose_confidence: float = 0.0
    # 肩中心 -> 髋中心 的**有符号**垂直分量（图像坐标 y 向下为正）。
    # 用于方向诊断：正常方向直立时为正；画面上下颠倒时为负。
    # 判定逻辑仍使用 abs(dy)（torso_angle 不变），此字段只做方向取证/看门狗输入。
    shoulder_hip_dy: float = 0.0
    # 真实髋部中点 x（左右髋关键点中点），ground-zone 判定必须用它，不得用框中心冒充
    hip_x: float = 0.0
    # 归一化人体框边界（供 ground-zone 精确相交判定；不影响既有判定）
    bbox_x1: float = 0.0
    bbox_y1: float = 0.0
    bbox_x2: float = 0.0
    bbox_y2: float = 0.0
    # 肩中心 y 与人体框高度（2026-11-02）：方向不敏感"快速塌落"判据需要它们。
    # 既有 horizontal/low 计算完全不受影响。
    shoulder_y: float = 0.0
    bbox_height: float = 0.0
    # 膝/踝中点 y（2026-11-02 收尾）：仅用于诊断与后续"髋-膝-踝几何"标定；
    # 关键点置信度不足时为 None，判定逻辑不得假设它们一定存在。
    knee_y: Optional[float] = None
    ankle_y: Optional[float] = None
    # 构图诊断（2026-11-02）：框底触底 = 下肢被画面切掉。近景/下肢截断时髋位与
    # upright/low 都不可信，必须由服务层向现场提示"无效构图"，不得据此下结论。
    bottom_clipped: bool = False


@dataclass(frozen=True)
class FallEvent:
    ts_ms: int
    score: float
    track_id: Optional[int]
    torso_angle_deg: float
    bbox_aspect: float
    hip_drop_per_sec: float


@dataclass(frozen=True)
class DetectorConfig:
    min_keypoint_confidence: float = 0.35
    upright_torso_angle_deg: float = 25.0   # 演示机位：躺姿偶尔误判直立（25°），收紧直立判定
    upright_bbox_aspect: float = 0.85
    # 配置 ground-zone 时，"人体框与地面区域相交"至少需要达到的框面积占比，
    # 避免仅边缘轻触就判定为在地面上（fail closed）。
    ground_min_overlap: float = 0.35
    # 下肢被画面底边截断时的替代判据：框底已触底（bbox_bottom 归一化），
    # 此时框会变成近方形，不能再要求"细高"；仍要求躯干竖直（见 upright 计算）。
    bottom_clip_y: float = 0.98
    # 2026-11-02 说明：曾根据 18:39–18:41 批次试收紧到 48.5°（该批次里 3 次“躺倒”确认帧
    # 49.4/71.6/58.9°、2 次“弯腰/蹲下”47.7/47.5°），但该批次的动作归属后续被用户更正为
    # **归属不清、不作误报证据**；而 18:46–18:48 交替测试（跌倒 3/3 检出、快速深蹲 0/3）是在
    # 45° 下完成的。因此**保持 45° 不变**，不引入未经真机验证的收紧；48.5° 候选分析见
    # evidence/2026-11-02-fall-orientation/data/real_machine_event_audit.md（仅离线评估）。
    horizontal_torso_angle_deg: float = 45.0
    horizontal_bbox_aspect: float = 0.95      # 演示机位：躺姿框宽高比常只到 0.9–1.0
    # 近方形框不能单独证明"水平"：bbox aspect 分支必须同时有躯干倾斜证据，
    # 否则真实机位"坐/蹲时下肢被画面截断 -> 近方形框"会被误判为 horizontal。
    horizontal_aspect_min_torso_deg: float = 35.0
    low_hip_y: float = 0.58
    low_bbox_bottom: float = 0.76
    # 校准（2026-10-16，真实安全样本：受控下降峰值 0.17/s、静止态 0.0–0.06/s）
    rapid_hip_drop_per_sec: float = 0.10     # 演示机位：实测快速侧倒峰值 0.117–0.134；原值 0.15/0.18
    recent_upright_ms: int = 6000            # 原 2500；覆盖 3–5 s 的安全受控下降
    recent_drop_ms: int = 2000            # 演示机位实测：2–4 FPS 下快速下降与横向帧可能相隔 1.2–2s
    confirm_ms: int = 0                   # 演示机位：倒地帧即确认（躺姿下一帧常丢人，无法二次确认）
    suspect_timeout_ms: int = 3500
    recover_ms: int = 2000
    lost_reset_ms: int = 1200

    # ---------------------------------------------------------------------
    # 方向不敏感"快速塌落"判据（2026-11-02，修复竖向/朝镜头方向跌倒漏检）
    # 背景：既有的 horizontal 判据要求躯干在图像平面内旋转到接近水平。
    #   竖向屈膝下坠（躯干保持竖直）与朝摄像头前倒（透视压缩、投影仍竖直）
    #   在图像上永远不会满足 torso_angle>=45 或 bbox_aspect>=0.95，因此漏检。
    # 新判据不依赖躯干朝向，只依赖"整体身体快速下沉 + 末端处于低位/地面"：
    #   body_drop = max(髋下沉, 肩下沉) 相对最近一次直立基线；
    #   peak      = 该窗口内髋/肩最大下坠速度；
    #   end       = 髋已到地面层 / 肩已很低 / 肩低于髋(投影反置) / 框高塌缩。
    # 默认开启；把 collapse_enabled 设 False 可完全回到 2026-10-28 前的行为。
    # ---------------------------------------------------------------------
    collapse_enabled: bool = True
    collapse_min_body_drop: float = 0.22   # 相对直立基线的总下沉量（归一化图像高）
    collapse_window_ms: int = 2500         # 从最近直立基线起算的时间窗
    collapse_peak_drop_per_sec: float = 0.30  # 峰值下坠速度；受控坐下实测峰值 0.17/s
    collapse_floor_hip_y: float = 0.78     # 髋部到达"地面层"的绝对门限（未配置 ground-zone 时）
    collapse_floor_shoulder_y: float = 0.72  # 肩部（≈躯干上端）到达画面低位的门限
    collapse_inversion_margin: float = 0.03  # 肩低于髋的容差（图像 y 向下）
    collapse_max_height_ratio: float = 0.55  # 人体框高度塌缩到直立基线的这个比例以下
    collapse_confirm_ms: int = 200         # 塌落判据需连续成立的时间（防单帧关键点跳变）
    # 触底"瞬时速度"门槛（2026-11-02 收尾，修离线快速深蹲误报）：
    # 受控蹲下在到达最低点前已被肌肉减速；跌倒触底那一帧身体仍在下坠。
    # 真机 2026-11-02 的 4 次受控跌倒，进入 SUSPECTED 那一帧的 dropRate 为
    # 0.281 / 0.328 / 0.461 / 0.397（见 evidence/2026-11-02-fall-live-verification），
    # 因此 0.22 保留约 28% 余量；只在"进入 SUSPECTED"时检查，确认/保持阶段不检查
    # （触底后速度必然归零）。
    collapse_terminal_drop_per_sec: float = 0.22


class FallState(str, Enum):
    NORMAL = "NORMAL"
    SUSPECTED = "SUSPECTED"
    FALLEN = "FALLEN"


Zone = Tuple[float, float, float, float]


class FallDetector:
    """Detect an upright-to-ground transition and emit once per episode."""

    def __init__(
        self,
        config: DetectorConfig = DetectorConfig(),
        excluded_zones: Iterable[Zone] = (),
        ground_zones: Iterable[Zone] = (),
    ) -> None:
        self.config = config
        self.excluded_zones = tuple(excluded_zones)
        # 可选场景地面区域（归一化）。为空时 low 完全沿用原有绝对规则（兼容默认）。
        # 非空时 ground-zone 直接定义当前机位的低位区域，不再叠加全局 hip_y 门槛。
        self.ground_zones = tuple(ground_zones)
        self.state = FallState.NORMAL
        self._last_frame: Optional[PoseFrame] = None
        self._last_features: Optional[PoseFeatures] = None
        self._last_seen_ms: Optional[int] = None
        self._last_upright_ms: Optional[int] = None
        self._last_rapid_drop_ms: Optional[int] = None
        self._suspected_since_ms: Optional[int] = None
        self._suspected_mode: Optional[str] = None
        self._recover_since_ms: Optional[int] = None
        self._latest_drop_rate = 0.0
        self._peak_drop_rate = 0.0
        # 方向不敏感塌落判据的直立基线：(ms, hip_y, shoulder_y, bbox_height)
        self._upright_baseline: Optional[Tuple[int, float, float, float]] = None
        self._peak_hip_drop_since_upright = 0.0
        self._peak_shoulder_drop_since_upright = 0.0
        self._latest_shoulder_drop_rate = 0.0

    def features(self, frame: PoseFrame) -> PoseFeatures:
        cfg = self.config

        def midpoint(left_name: str, right_name: str) -> Optional[Tuple[float, float]]:
            left = frame.keypoints.get(left_name)
            right = frame.keypoints.get(right_name)
            if left is None or right is None:
                return None
            if left.confidence < cfg.min_keypoint_confidence:
                return None
            if right.confidence < cfg.min_keypoint_confidence:
                return None
            return ((left.x + right.x) / 2.0, (left.y + right.y) / 2.0)

        shoulders = midpoint("left_shoulder", "right_shoulder")
        hips = midpoint("left_hip", "right_hip")
        knees = midpoint("left_knee", "right_knee")
        ankles = midpoint("left_ankle", "right_ankle")
        bx1, by1, bx2, by2 = frame.bbox
        # 防御：部分离线事件包的 bbox 字段可能逆序（x1>x2），统一排序后再取宽高。
        x1, x2 = min(bx1, bx2), max(bx1, bx2)
        y1, y2 = min(by1, by2), max(by1, by2)
        width = max(0.0, x2 - x1)
        height = max(0.0, y2 - y1)
        if shoulders is None or hips is None or height <= 1e-6:
            return PoseFeatures(valid=False)

        dx = hips[0] - shoulders[0]
        dy = hips[1] - shoulders[1]
        torso_angle = degrees(atan2(abs(dx), max(abs(dy), 1e-6)))
        return PoseFeatures(
            valid=True,
            torso_angle_deg=torso_angle,
            bbox_aspect=width / height,
            hip_y=hips[1],
            center_x=(x1 + x2) / 2.0,
            center_y=(y1 + y2) / 2.0,
            bbox_bottom=y2,
            pose_confidence=max(0.0, min(1.0, frame.pose_confidence)),
            shoulder_hip_dy=dy,
            hip_x=hips[0],
            bbox_x1=x1,
            bbox_y1=y1,
            bbox_x2=x2,
            bbox_y2=y2,
            shoulder_y=shoulders[1],
            bbox_height=height,
            knee_y=None if knees is None else knees[1],
            ankle_y=None if ankles is None else ankles[1],
            bottom_clipped=bool(y2 >= cfg.bottom_clip_y),
        )

    def update(
        self, frame: Optional[PoseFrame], ts_ms: Optional[int] = None
    ) -> Optional[FallEvent]:
        now_ms = frame.ts_ms if frame is not None else ts_ms
        if now_ms is None:
            raise ValueError("ts_ms is required when frame is None")
        now_ms = int(now_ms)

        if frame is None:
            if (
                self.state == FallState.SUSPECTED
                and self._last_seen_ms is not None
                and now_ms - self._last_seen_ms > self.config.lost_reset_ms
            ):
                self._reset_suspected()
            return None

        current = self.features(frame)
        if not current.valid:
            return self.update(None, now_ms)

        if self._last_seen_ms is not None and now_ms < self._last_seen_ms:
            raise ValueError("pose timestamps must be monotonic")

        explicit_track_change = (
            self._last_frame is not None
            and self._last_frame.track_id is not None
            and frame.track_id is not None
            and self._last_frame.track_id != frame.track_id
        )
        if explicit_track_change:
            self._reset_for_track_change()

        drop_rate = 0.0
        shoulder_drop_rate = 0.0
        if self._last_frame is not None and self._last_features is not None:
            elapsed_ms = now_ms - self._last_frame.ts_ms
            same_track = (
                frame.track_id is None
                or self._last_frame.track_id is None
                or frame.track_id == self._last_frame.track_id
            )
            if same_track and 50 <= elapsed_ms <= 1500:
                drop_rate = max(
                    0.0,
                    (current.hip_y - self._last_features.hip_y)
                    / (elapsed_ms / 1000.0),
                )
                shoulder_drop_rate = max(
                    0.0,
                    (current.shoulder_y - self._last_features.shoulder_y)
                    / (elapsed_ms / 1000.0),
                )

        self._latest_drop_rate = drop_rate
        self._latest_shoulder_drop_rate = shoulder_drop_rate
        self._last_seen_ms = now_ms
        self._last_frame = frame
        self._last_features = current

        # 直立判据（2026-10-16 校准；2026-11-02 增加方向符号 + 近景截断保护）：
        #   肩中心必须真的在髋中心**上方**（图像 y 向下，shoulder_hip_dy>0），
        #   躯干竖直 且（完整人体的细高框 OR 框底已触底=下肢被画面截断）。
        # 原来的 |dx|/|dy| 角度对"朝摄像头前倒"（投影后肩低于髋）同样会给出小角度，
        # 会把已经倒向镜头的人误判为直立，从而错过竖向/前向跌倒。
        upright = (
            current.shoulder_hip_dy > 0.0
            and current.torso_angle_deg <= self.config.upright_torso_angle_deg
            and (
                current.bbox_aspect <= self.config.upright_bbox_aspect
                or self._bottom_clip_upright_ok(current)
            )
        )
        horizontal = (
            current.torso_angle_deg >= self.config.horizontal_torso_angle_deg
            # near-square bbox 只有在躯干确实倾斜时才算"水平"证据：
            # 真实机位坐/蹲时下肢被截断会产生 aspect≈0.95–1.05 的方框，躯干却是竖直的。
            or (
                current.bbox_aspect >= self.config.horizontal_bbox_aspect
                and current.torso_angle_deg >= self.config.horizontal_aspect_min_torso_deg
            )
        )
        low_absolute = (
            current.hip_y >= self.config.low_hip_y
            and current.bbox_bottom >= self.config.low_bbox_bottom
        )
        # ground-zone 合同（2026-10-17 修订）：
        #   - 未配置 ground-zone：low = low_absolute（保持原有兼容行为）；
        #   - 配置 ground-zone：low = ground_hit。ground-zone 本身就是该机位
        #     "地板/安全测试垫区域"的场景定义，因此不再强制全局 hip_y>=0.58
        #     （真实水平帧可能出现 hip_y=0.231 这类投影，被全局门槛错误否决）。
        #   其余约束（水平、多帧、直立历史、快速下降、持续 1.2s、去重、track 隔离、exclude-zone）全部保留。
        if self.ground_zones:
            low = bool(self._ground_hit(current))
        else:
            low = bool(low_absolute)
        excluded = self._in_excluded_zone(current.center_x, current.center_y)

        if upright:
            self._last_upright_ms = now_ms
        # "站立高度"参照：直立姿态且髋部不高于已有基线（图像 y 越小越高）。
        # 竖向塌落的人即使仍被姿态判成 upright，髋部也只会越来越低，
        # 因此不会刷新基线；而真正站起来时髋部回到基线附近，视为恢复。
        standing_like = bool(
            upright
            and (
                self._upright_baseline is None
                or current.hip_y <= self._upright_baseline[1] + 0.02
            )
        )
        if standing_like:
            # 直立基线：塌落判据的参照点（取最近的站立高度帧）。
            self._upright_baseline = (
                now_ms,
                current.hip_y,
                current.shoulder_y,
                current.bbox_height,
            )
            self._peak_hip_drop_since_upright = 0.0
            self._peak_shoulder_drop_since_upright = 0.0
        else:
            self._peak_hip_drop_since_upright = max(
                self._peak_hip_drop_since_upright, drop_rate
            )
            self._peak_shoulder_drop_since_upright = max(
                self._peak_shoulder_drop_since_upright, shoulder_drop_rate
            )
        if drop_rate >= self.config.rapid_hip_drop_per_sec:
            self._last_rapid_drop_ms = now_ms

        # 方向不敏感"快速塌落"证据（不要求躯干在图像平面内旋转到水平）。
        # entry 版本额外要求"触底帧仍在下坠"；hold 版本只用于已 SUSPECTED 后的持续/复位判断。
        collapse_hold = self._collapse_evidence(current, now_ms, low)
        collapse_entry = self._collapse_evidence(
            current, now_ms, low, require_terminal=True
        )

        if self.state == FallState.FALLEN:
            if standing_like:
                if self._recover_since_ms is None:
                    self._recover_since_ms = now_ms
                elif now_ms - self._recover_since_ms >= self.config.recover_ms:
                    self._reset_all()
            else:
                self._recover_since_ms = None
            return None

        if self.state == FallState.NORMAL:
            recent_upright = (
                self._last_upright_ms is not None
                and now_ms - self._last_upright_ms <= self.config.recent_upright_ms
            )
            recent_drop = (
                self._last_rapid_drop_ms is not None
                and now_ms - self._last_rapid_drop_ms <= self.config.recent_drop_ms
            )
            if recent_upright and recent_drop and horizontal and low and not excluded:
                self.state = FallState.SUSPECTED
                self._suspected_since_ms = now_ms
                self._suspected_mode = "horizontal"
                self._peak_drop_rate = drop_rate
            elif recent_upright and collapse_entry and not excluded:
                # 竖向崩塌 / 朝镜头前倒：图像上永远不会 horizontal，用快速塌落 + 低位代替。
                self.state = FallState.SUSPECTED
                self._suspected_since_ms = now_ms
                self._suspected_mode = "collapse"
                self._peak_drop_rate = max(
                    drop_rate, self._latest_shoulder_drop_rate
                )
            return None

        if excluded or (upright and not collapse_hold):
            self._reset_suspected()
            return None

        if self._suspected_since_ms is None:
            self._reset_suspected()
            return None

        self._peak_drop_rate = max(
            self._peak_drop_rate, drop_rate, self._latest_shoulder_drop_rate
        )

        still_horizontal_low = bool(horizontal and low)
        if not still_horizontal_low and not collapse_hold:
            if now_ms - self._suspected_since_ms >= self.config.suspect_timeout_ms:
                self._reset_suspected()
            return None

        required_confirm_ms = (
            self.config.collapse_confirm_ms
            if self._suspected_mode == "collapse"
            else self.config.confirm_ms
        )
        if now_ms - self._suspected_since_ms < required_confirm_ms:
            return None

        self.state = FallState.FALLEN
        self._recover_since_ms = None
        score = self._evidence_score(current, self._peak_drop_rate)
        return FallEvent(
            ts_ms=now_ms,
            score=score,
            track_id=frame.track_id,
            torso_angle_deg=current.torso_angle_deg,
            bbox_aspect=current.bbox_aspect,
            hip_drop_per_sec=self._peak_drop_rate,
        )

    def _bottom_clip_upright_ok(self, features: PoseFeatures) -> bool:
        """框底触底兜底只在"仍在站立高度"时有效（2026-11-02 18:36 现场教训）。

        近景/下肢截断时 `bbox_bottom` 常 ≈1.0；若身体已明显下沉（髋比站立基线低
        >= `collapse_min_body_drop`），继续用 bottom-clip 兜底会把正在塌落的帧判成
        "直立/已恢复"，从而错误取消 collapse 疑点。此保护只影响"身体已明显下沉"的帧。
        """
        if features.bbox_bottom < self.config.bottom_clip_y:
            return False
        if self._upright_baseline is None:
            return True
        hip_drop_from_baseline = features.hip_y - self._upright_baseline[1]
        return hip_drop_from_baseline < self.config.collapse_min_body_drop

    def _collapse_evidence(
        self, features: PoseFeatures, now_ms: int, low: bool,
        require_terminal: bool = False,
    ) -> bool:
        """方向不敏感"快速塌落"证据（2026-11-02）。

        与既有 horizontal 判据的关键区别：**不使用躯干在图像平面内的朝向**。
        竖向屈膝下坠（躯干保持竖直）与朝摄像头前倒（透视压缩、投影仍近似竖直）
        在 torso_angle/bbox_aspect 上都无法达到 horizontal 阈值；但它们在物理上
        都是"整体身体快速下沉并停止在低位/地面"，因此改用：
          1) 相对最近直立基线的总下沉量 >= collapse_min_body_drop；
          2) 窗口内髋/肩最大下坠速度 >= collapse_peak_drop_per_sec；
          3) 末端证据至少一条：髋到地面层 / 肩很低 / 肩低于髋（投影反置）/
             人体框高度相对直立基线塌缩。
        受控坐下/蹲下/弯腰的实测峰值 <=0.17/s，因此速度门槛是主要区分项；
        缓慢躺倒没有快速下降，也不会进入本判据。

        require_terminal（仅 NORMAL→SUSPECTED 的"进入"判定使用，2026-11-02 收尾）：
        还要求**触底那一帧身体仍在下坠**（髋/肩瞬时速度取大 >= collapse_terminal_drop_per_sec）。
        受控快速蹲下会在到底前主动减速，触底帧速度已明显下降；跌倒触底帧速度仍高。
        真机 4 次受控跌倒的进入帧 dip 速度为 0.281–0.461/s，保留 0.22 门槛有余量。
        """
        cfg = self.config
        if not cfg.collapse_enabled or self._upright_baseline is None:
            return False
        base_ms, base_hip, base_shoulder, base_height = self._upright_baseline
        elapsed = now_ms - base_ms
        if elapsed < 0 or elapsed > cfg.collapse_window_ms:
            return False

        hip_drop = features.hip_y - base_hip
        shoulder_drop = features.shoulder_y - base_shoulder
        body_drop = max(hip_drop, shoulder_drop)
        peak = max(
            self._peak_hip_drop_since_upright,
            self._peak_shoulder_drop_since_upright,
        )
        if body_drop < cfg.collapse_min_body_drop or peak < cfg.collapse_peak_drop_per_sec:
            return False
        # low 已经包含 ground-zone 语义（配置 zone 时 low = ground_hit）。
        if not low:
            return False
        if require_terminal:
            terminal = max(self._latest_drop_rate, self._latest_shoulder_drop_rate)
            if terminal < cfg.collapse_terminal_drop_per_sec:
                return False

        ground_hit = bool(self.ground_zones and self._ground_hit(features))
        floor_hip = bool(features.hip_y >= cfg.collapse_floor_hip_y or ground_hit)
        floor_shoulder = bool(
            features.shoulder_y >= cfg.collapse_floor_shoulder_y
            and features.hip_y >= 0.62
        )
        # 朝摄像头前倒的投影特征：肩中心投影到髋下方（图像 y 向下），torso_angle 却很小。
        inverted = bool(
            features.shoulder_y >= features.hip_y - cfg.collapse_inversion_margin
            and features.hip_y >= 0.62
        )
        collapsed_height = False
        if base_height > 1e-6 and features.hip_y >= 0.70:
            collapsed_height = (
                features.bbox_height / base_height <= cfg.collapse_max_height_ratio
            )
        return bool(floor_hip or floor_shoulder or inverted or collapsed_height)

    def snapshot(self, now_ms: int) -> dict:
        """只读诊断快照：返回当前五项判定条件的实时取值，**不改变任何状态**。

        仅用于"未触发时先看真实条件值"的取证（CLI --diag-conditions）。
        这里不做任何阈值判断，也不写日志，纯函数式读取内部状态。
        """
        features = self._last_features
        valid = bool(features is not None and features.valid)
        torso = float(features.torso_angle_deg) if valid else 0.0
        aspect = float(features.bbox_aspect) if valid else 0.0
        hip_y = float(features.hip_y) if valid else 0.0
        bottom = float(features.bbox_bottom) if valid else 0.0
        center_x = float(features.center_x) if valid else 0.0
        center_y = float(features.center_y) if valid else 0.0
        now = int(now_ms)
        return {
            "state": self.state.value,
            "features_valid": valid,
            "torso_angle_deg": round(torso, 1),
            "bbox_aspect": round(aspect, 3),
            "hip_y": round(hip_y, 3),
            "bbox_bottom": round(bottom, 3),
            "drop_rate": round(float(self._latest_drop_rate), 3),
            "peak_drop_rate": round(float(self._peak_drop_rate), 3),
            "upright": bool(
                valid
                and features.shoulder_hip_dy > 0.0
                and torso <= self.config.upright_torso_angle_deg
                and (
                    aspect <= self.config.upright_bbox_aspect
                    or self._bottom_clip_upright_ok(features)
                )
            ),
            "bottom_clipped": bool(valid and bottom >= self.config.bottom_clip_y),
            "standing": bool(
                valid
                and features.shoulder_hip_dy > 0.0
                and torso <= self.config.upright_torso_angle_deg
                and (
                    aspect <= self.config.upright_bbox_aspect
                    or self._bottom_clip_upright_ok(features)
                )
                and (
                    self._upright_baseline is None
                    or hip_y <= self._upright_baseline[1] + 0.02
                )
            ),
            "shoulder_hip_dy": round(float(features.shoulder_hip_dy), 4) if valid else 0.0,
            "hip_x": round(float(features.hip_x), 4) if valid else 0.0,
            "low_absolute": bool(
                valid
                and features.hip_y >= self.config.low_hip_y
                and features.bbox_bottom >= self.config.low_bbox_bottom
            ),
            "low_mode": "ground_zone" if self.ground_zones else "absolute",
            "ground_hit": bool(valid and self._ground_hit(features)),
            "ground_zones": len(self.ground_zones),
            "horizontal": bool(
                valid
                and (
                    torso >= self.config.horizontal_torso_angle_deg
                    or (
                        aspect >= self.config.horizontal_bbox_aspect
                        and torso >= self.config.horizontal_aspect_min_torso_deg
                    )
                )
            ),
            "low": bool(
                valid
                and hip_y >= self.config.low_hip_y
                and bottom >= self.config.low_bbox_bottom
            ),
            "excluded": bool(valid and self._in_excluded_zone(center_x, center_y)),
            "since_upright_ms": None if self._last_upright_ms is None else now - int(self._last_upright_ms),
            "since_drop_ms": None if self._last_rapid_drop_ms is None else now - int(self._last_rapid_drop_ms),
            "suspected_ms": None if self._suspected_since_ms is None else now - int(self._suspected_since_ms),
            "suspected_mode": self._suspected_mode,
            # 方向不敏感塌落判据的实时取值（只读诊断，便于真机标定；不影响判定）。
            "collapse": {
                "enabled": bool(self.config.collapse_enabled),
                "baseline_age_ms": None if self._upright_baseline is None
                else now - int(self._upright_baseline[0]),
                "hip_drop_from_baseline": None if not valid or self._upright_baseline is None
                else round(float(features.hip_y - self._upright_baseline[1]), 4),
                "shoulder_drop_from_baseline": None if not valid or self._upright_baseline is None
                else round(float(features.shoulder_y - self._upright_baseline[2]), 4),
                "peak_hip_drop_per_sec": round(float(self._peak_hip_drop_since_upright), 3),
                "peak_shoulder_drop_per_sec": round(float(self._peak_shoulder_drop_since_upright), 3),
                "latest_shoulder_drop_per_sec": round(float(self._latest_shoulder_drop_rate), 3),
                "shoulder_y": round(float(features.shoulder_y), 3) if valid else 0.0,
                "bbox_height": round(float(features.bbox_height), 3) if valid else 0.0,
                "knee_y": None if not valid or features.knee_y is None
                else round(float(features.knee_y), 3),
                "ankle_y": None if not valid or features.ankle_y is None
                else round(float(features.ankle_y), 3),
                "hip_ankle_gap": None if not valid or features.ankle_y is None
                else round(float(features.hip_y - features.ankle_y), 3),
                "terminal_drop_per_sec": round(
                    float(max(self._latest_drop_rate, self._latest_shoulder_drop_rate)), 3),
                # evidence = 进入判定（含触底瞬时速度门槛）；hold_evidence = 确认/保持判定。
                "evidence": bool(valid and self._collapse_evidence(
                    features, now, self._snapshot_low(valid, hip_y, bottom),
                    require_terminal=True)),
                "hold_evidence": bool(valid and self._collapse_evidence(
                    features, now, self._snapshot_low(valid, hip_y, bottom))),
                "thresholds": {
                    "min_body_drop": self.config.collapse_min_body_drop,
                    "window_ms": self.config.collapse_window_ms,
                    "peak_drop_per_sec": self.config.collapse_peak_drop_per_sec,
                    "terminal_drop_per_sec": self.config.collapse_terminal_drop_per_sec,
                    "floor_hip_y": self.config.collapse_floor_hip_y,
                    "floor_shoulder_y": self.config.collapse_floor_shoulder_y,
                    "inversion_margin": self.config.collapse_inversion_margin,
                    "max_height_ratio": self.config.collapse_max_height_ratio,
                    "confirm_ms": self.config.collapse_confirm_ms,
                    "aspect_min_torso_deg": self.config.horizontal_aspect_min_torso_deg,
                },
            },
            "thresholds": {
                "rapid_hip_drop_per_sec": self.config.rapid_hip_drop_per_sec,
                "recent_upright_ms": self.config.recent_upright_ms,
                "recent_drop_ms": self.config.recent_drop_ms,
                "confirm_ms": self.config.confirm_ms,
                "horizontal_torso_angle_deg": self.config.horizontal_torso_angle_deg,
                "horizontal_bbox_aspect": self.config.horizontal_bbox_aspect,
                "low_hip_y": self.config.low_hip_y,
                "low_bbox_bottom": self.config.low_bbox_bottom,
                "bottom_clip_y": self.config.bottom_clip_y,
            },
        }

    def _snapshot_low(self, valid: bool, hip_y: float, bottom: float) -> bool:
        """快照用：与 update() 一致的低位语义（有 ground-zone 时以 ground_hit 为准）。"""
        if not valid:
            return False
        if self.ground_zones:
            return bool(self._last_features is not None and self._ground_hit(self._last_features))
        return (
            hip_y >= self.config.low_hip_y
            and bottom >= self.config.low_bbox_bottom
        )

    def _in_excluded_zone(self, x: float, y: float) -> bool:
        return any(x1 <= x <= x2 and y1 <= y <= y2 for x1, y1, x2, y2 in self.excluded_zones)

    @staticmethod
    def _point_in_ground(x: float, y: float, zone) -> bool:
        """zone 为 4 元素=归一化矩形；>=6 且偶数=归一化多边形（射线法）。"""
        values = tuple(float(v) for v in zone)
        if len(values) == 4:
            x1, y1, x2, y2 = values
            return x1 <= x <= x2 and y1 <= y <= y2
        if len(values) >= 6 and len(values) % 2 == 0:
            inside = False
            count = len(values) // 2
            for index in range(count):
                ax, ay = values[2 * index], values[2 * index + 1]
                bx, by = values[2 * ((index + 1) % count)], values[2 * ((index + 1) % count) + 1]
                if (ay > y) != (by > y):
                    x_cross = (bx - ax) * (y - ay) / (by - ay) + ax
                    if x < x_cross:
                        inside = not inside
            return inside
        return False

    @staticmethod
    def _zone_rect(zone) -> Tuple[float, float, float, float]:
        """把矩形/多边形区域归约为包围矩形（用于相交面积与重叠校验）。"""
        values = tuple(float(v) for v in zone)
        xs = values[0::2]
        ys = values[1::2]
        return (min(xs), min(ys), max(xs), max(ys))

    def _zone_overlap_ratio(self, features: PoseFeatures, zone) -> float:
        """人体框与区域的相交面积 / 人体框面积（归一化）。"""
        box_area = max(0.0, (features.bbox_x2 - features.bbox_x1)) * max(0.0, (features.bbox_y2 - features.bbox_y1))
        if box_area <= 1e-9:
            return 0.0
        zx1, zy1, zx2, zy2 = self._zone_rect(zone)
        ix1, iy1 = max(features.bbox_x1, zx1), max(features.bbox_y1, zy1)
        ix2, iy2 = min(features.bbox_x2, zx2), min(features.bbox_y2, zy2)
        if ix2 <= ix1 or iy2 <= iy1:
            return 0.0
        return ((ix2 - ix1) * (iy2 - iy1)) / box_area

    def _ground_hit(self, features: PoseFeatures) -> bool:
        """是否落在地面区域：以**真实髋部中点**为主判据；或人体框与区域有足够重叠（防边缘轻触误判）。"""
        if not self.ground_zones:
            return True
        for zone in self.ground_zones:
            # 1) 真实髋点（左右髋关键点中点）位于区域内 —— 主判据
            if self._point_in_ground(features.hip_x, features.hip_y, zone):
                return True
        for zone in self.ground_zones:
            # 2) 主要身体与区域相交：框中心必须在区域内，且重叠面积足够（避免微小边缘接触）
            center_in = self._point_in_ground(features.center_x, features.center_y, zone)
            if center_in and self._zone_overlap_ratio(features, zone) >= self.config.ground_min_overlap:
                return True
        return False

    @staticmethod
    def find_zone_conflicts(ground_zones: Iterable[Zone], excluded_zones: Iterable[Zone],
                            threshold: float = 0.25) -> list:
        """检查 ground-zone 与 exclude-zone 是否**明显重叠**（默认 25% 地面区域被排除）。

        返回冲突描述列表；非空表示应拒绝启动（fail closed）。
        即使未达阈值，实际判定中 exclude-zone 也始终优先（excluded 时不会进入 SUSPECTED）。
        """
        problems = []
        def rect(zone):
            values = tuple(float(v) for v in zone)
            xs, ys = values[0::2], values[1::2]
            return (min(xs), min(ys), max(xs), max(ys))
        for gi, ground in enumerate(ground_zones or ()):
            gx1, gy1, gx2, gy2 = rect(ground)
            g_area = max(0.0, gx2 - gx1) * max(0.0, gy2 - gy1)
            if g_area <= 1e-9:
                problems.append(f"ground zone {gi} has zero area")
                continue
            for ei, excluded in enumerate(excluded_zones or ()):
                ex1, ey1, ex2, ey2 = rect(excluded)
                ix1, iy1 = max(gx1, ex1), max(gy1, ey1)
                ix2, iy2 = min(gx2, ex2), min(gy2, ey2)
                if ix2 <= ix1 or iy2 <= iy1:
                    continue
                ratio = ((ix2 - ix1) * (iy2 - iy1)) / g_area
                if ratio >= threshold:
                    problems.append(
                        "ground zone %d overlaps excluded zone %d by %.0f%% (bed/sofa must not be a floor zone)"
                        % (gi, ei, ratio * 100)
                    )
        return problems

    def _evidence_score(self, features: PoseFeatures, drop_rate: float) -> float:
        angle = min(1.0, features.torso_angle_deg / 90.0)
        aspect = min(1.0, features.bbox_aspect / 2.0)
        drop = min(1.0, drop_rate / 0.50)
        return round(
            0.35 * features.pose_confidence + 0.25 * angle + 0.20 * aspect + 0.20 * drop,
            3,
        )

    def _reset_suspected(self) -> None:
        self.state = FallState.NORMAL
        self._suspected_since_ms = None
        self._suspected_mode = None
        self._last_rapid_drop_ms = None
        self._peak_drop_rate = 0.0

    def _reset_all(self) -> None:
        self.state = FallState.NORMAL
        self._suspected_since_ms = None
        self._suspected_mode = None
        self._recover_since_ms = None
        self._last_rapid_drop_ms = None
        self._peak_drop_rate = 0.0
        self._upright_baseline = None
        self._peak_hip_drop_since_upright = 0.0
        self._peak_shoulder_drop_since_upright = 0.0

    def _reset_for_track_change(self) -> None:
        self._reset_all()
        self._last_frame = None
        self._last_features = None
        self._last_upright_ms = None

