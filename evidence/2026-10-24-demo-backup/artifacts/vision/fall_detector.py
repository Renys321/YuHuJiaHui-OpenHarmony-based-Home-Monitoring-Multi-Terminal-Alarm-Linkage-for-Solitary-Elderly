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
    upright_torso_angle_deg: float = 32.0
    upright_bbox_aspect: float = 0.85
    # 配置 ground-zone 时，"人体框与地面区域相交"至少需要达到的框面积占比，
    # 避免仅边缘轻触就判定为在地面上（fail closed）。
    ground_min_overlap: float = 0.35
    # 下肢被画面底边截断时的替代判据：框底已触底（bbox_bottom 归一化），
    # 此时框会变成近方形，不能再要求"细高"；仍要求躯干竖直（见 upright 计算）。
    bottom_clip_y: float = 0.98
    horizontal_torso_angle_deg: float = 58.0
    horizontal_bbox_aspect: float = 1.05
    low_hip_y: float = 0.58
    low_bbox_bottom: float = 0.76
    # 校准（2026-10-16，真实安全样本：受控下降峰值 0.17/s、静止态 0.0–0.06/s）
    rapid_hip_drop_per_sec: float = 0.15     # 原 0.18；不得再降低
    recent_upright_ms: int = 6000            # 原 2500；覆盖 3–5 s 的安全受控下降
    recent_drop_ms: int = 1200
    confirm_ms: int = 1200
    suspect_timeout_ms: int = 3500
    recover_ms: int = 2000
    lost_reset_ms: int = 1200


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
        self._recover_since_ms: Optional[int] = None
        self._latest_drop_rate = 0.0
        self._peak_drop_rate = 0.0

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
        x1, y1, x2, y2 = frame.bbox
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

        self._latest_drop_rate = drop_rate
        self._last_seen_ms = now_ms
        self._last_frame = frame
        self._last_features = current

        # 直立判据（2026-10-16 校准）：
        #   躯干竖直 且（完整人体的细高框 OR 框底已触底=下肢被画面截断）
        # 只有同时看到"竖直躯干"这一姿态证据才成立；不是"只看躯干角"，也不是单帧框形状。
        upright = (
            current.torso_angle_deg <= self.config.upright_torso_angle_deg
            and (
                current.bbox_aspect <= self.config.upright_bbox_aspect
                or current.bbox_bottom >= self.config.bottom_clip_y
            )
        )
        horizontal = (
            current.torso_angle_deg >= self.config.horizontal_torso_angle_deg
            or current.bbox_aspect >= self.config.horizontal_bbox_aspect
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
        if drop_rate >= self.config.rapid_hip_drop_per_sec:
            self._last_rapid_drop_ms = now_ms

        if self.state == FallState.FALLEN:
            if upright:
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
                self._peak_drop_rate = drop_rate
            return None

        if excluded or upright:
            self._reset_suspected()
            return None

        if self._suspected_since_ms is None:
            self._reset_suspected()
            return None

        self._peak_drop_rate = max(self._peak_drop_rate, drop_rate)

        if not horizontal or not low:
            if now_ms - self._suspected_since_ms >= self.config.suspect_timeout_ms:
                self._reset_suspected()
            return None

        if now_ms - self._suspected_since_ms < self.config.confirm_ms:
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
                and torso <= self.config.upright_torso_angle_deg
                and (
                    aspect <= self.config.upright_bbox_aspect
                    or bottom >= self.config.bottom_clip_y
                )
            ),
            "bottom_clipped": bool(valid and bottom >= self.config.bottom_clip_y),
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
                    or aspect >= self.config.horizontal_bbox_aspect
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
        self._last_rapid_drop_ms = None
        self._peak_drop_rate = 0.0

    def _reset_all(self) -> None:
        self.state = FallState.NORMAL
        self._suspected_since_ms = None
        self._recover_since_ms = None
        self._last_rapid_drop_ms = None
        self._peak_drop_rate = 0.0

    def _reset_for_track_change(self) -> None:
        self._reset_all()
        self._last_frame = None
        self._last_features = None
        self._last_upright_ms = None

