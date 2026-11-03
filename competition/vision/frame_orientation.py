"""frame_orientation.py — 视觉帧方向的唯一权威合同（PC 侧）。

背景（真实机位）：DAYU 是类手机设备，应用未锁定显示方向，倾斜设备会触发系统旋转，
于是同一路 USB 采样帧的"图像方向"可能变化。方向不确定时，髋部/肩部的垂直关系会翻转，
任何"水平/低位"判定都会失真。

本模块只做三件事，全部是纯逻辑（可确定性单测）：
  1) 显式旋转合同：rotate_image() 在**推理之前**把图像转到统一坐标系，
     因此 result.orig_shape / bbox / 关键点天然同系，无需再做坐标映射；
  2) 启动期一次性方向解析：只依据"连续多帧可靠站立姿态"的有符号肩→髋垂直向量，
     以及帧宽高是否被交换；无法可靠确定时**拒绝**并要求显式参数（绝不逐帧自动切换）；
  3) 运行期方向看门狗：锁定后若方向发生变化（宽高交换或可靠站立姿态的垂直符号持续反转），
     产生一次性告警事件，调用方据此**停止 FALL 发布**，不再用错误坐标继续判定。

禁止：按每帧人体姿态自动切换角度；任意角度（只允许 0/90/180/270）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional, Sequence, Tuple

ALLOWED_ROTATIONS: Tuple[int, ...] = (0, 90, 180, 270)
# 运行期方向变化所需的连续可靠样本数（迟滞，避免单帧抖动误报方向变化）
DEFAULT_CHANGE_STREAK = 5


class FrameRotationError(ValueError):
    """非法的旋转参数。"""


def parse_rotation(value) -> int:
    """把 CLI 值解析为 0/90/180/270；不接受任意角度。"""
    if isinstance(value, bool):
        raise FrameRotationError("frame rotation must be 0/90/180/270")
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        raise FrameRotationError("frame rotation must be 0/90/180/270 (got %r)" % (value,))
    if number == 360:
        number = 0
    if number not in ALLOWED_ROTATIONS:
        raise FrameRotationError("frame rotation must be 0/90/180/270 (got %r)" % (value,))
    return number


def rotate_image(image, rotation: int):
    """在推理前旋转图像；0 为恒等。返回新数组，不修改入参。

    90/270 使用转置+翻转（与 numpy.rot90 语义一致）；180 上下左右同时翻转。
    """
    rotation = parse_rotation(rotation)
    if rotation == 0:
        return image
    import numpy as np  # 局部导入：测试不需要图像时也能用纯逻辑
    array = np.asarray(image)
    if rotation == 90:
        return np.ascontiguousarray(np.rot90(array, k=1))
    if rotation == 180:
        return np.ascontiguousarray(np.rot90(array, k=2))
    return np.ascontiguousarray(np.rot90(array, k=3))


@dataclass(frozen=True)
class OrientationObservation:
    """单帧方向观测（只含非敏感几何量）。"""

    frame_width: int
    frame_height: int
    # 肩中心 -> 髋中心 的**有符号**垂直分量（图像坐标向下为正）：
    #   正常方向、直立人：hip_y > shoulder_y -> 正值
    #   画面上下颠倒：hip_y < shoulder_y -> 负值
    shoulder_hip_dy: float
    # 该观测是否来自"可靠站立姿态"（关键点有效且躯干竖直）
    reliable_standing: bool


@dataclass(frozen=True)
class StartupResolution:
    rotation: Optional[int]
    reason: str
    samples: int
    reliable_samples: int


def resolve_startup_rotation(
    observations: Sequence[OrientationObservation],
    min_reliable: int = 5,
    expected_landscape: bool = True,
) -> StartupResolution:
    """启动期一次性方向解析。

    - 只用**可靠站立**样本的 shoulder_hip_dy 符号：稳定为负 -> 需要 180°；稳定为正 -> 0°。
    - 该机位真实预览为 4:3 横向（如 640x480），故 expected_landscape 默认 True。
      若观测到的是竖向宽高（height>width），说明可能存在 90/270 类旋转：
      只能判定"存在 90/270 类旋转"而**无法区分 90 与 270** -> 拒绝自动选择。
    - 可靠样本不足或符号互相矛盾 -> 拒绝自动选择（要求显式 --frame-rotation）。
    """
    samples = list(observations or [])
    if not samples:
        return StartupResolution(None, "no_frames", 0, 0)
    dims = {(int(o.frame_width), int(o.frame_height)) for o in samples}
    if len(dims) > 1:
        return StartupResolution(None, "frame_dimensions_changed", len(samples), 0)
    reliable = [o for o in samples if o.reliable_standing]
    if len(reliable) < int(min_reliable):
        return StartupResolution(None, "insufficient_reliable_standing_samples", len(samples), len(reliable))
    signs = {1 if o.shoulder_hip_dy > 0 else (-1 if o.shoulder_hip_dy < 0 else 0) for o in reliable}
    if 0 in signs or len(signs) != 1:
        return StartupResolution(None, "ambiguous_vertical_sign", len(samples), len(reliable))
    sign = signs.pop()
    width, height = next(iter(dims))
    swapped = (width > height) != bool(expected_landscape)
    if swapped:
        # 宽高关系与"常规朝向"不符：可能是 90/270，光靠几何无法区分，拒绝自动选择
        return StartupResolution(None, "possible_90_270_rotation_needs_explicit_value", len(samples), len(reliable))
    return StartupResolution(180 if sign < 0 else 0, "reliable_standing_vertical_sign", len(samples), len(reliable))


@dataclass(frozen=True)
class OrientationChange:
    detected: bool
    kind: str = ""
    detail: str = ""


class OrientationWatchdog:
    """锁定方向后监测方向变化；只产生一次事件，且需要连续可靠样本（迟滞）。"""

    def __init__(self, locked_rotation: int, change_streak: int = DEFAULT_CHANGE_STREAK) -> None:
        self.locked_rotation = parse_rotation(locked_rotation)
        if int(change_streak) < 1:
            raise FrameRotationError("change_streak must be >= 1")
        self.change_streak = int(change_streak)
        self._dimensions: Optional[Tuple[int, int]] = None
        self._sign_streak = 0
        self.changed = False

    def observe(self, observation: OrientationObservation) -> OrientationChange:
        if self.changed:
            return OrientationChange(False)
        dims = (int(observation.frame_width), int(observation.frame_height))
        if self._dimensions is None:
            self._dimensions = dims
        elif dims != self._dimensions:
            self.changed = True
            return OrientationChange(True, "frame_dimensions_changed", "%dx%d -> %dx%d" % (self._dimensions + dims))
        # 观测来自 rotate_image() 之后的推理结果，所以无论启动时锁定了
        # 0/90/180/270，归一化后的可靠站立都应为肩->髋 dy > 0。
        # 横卧/坐姿一律不参与，避免把姿态变化误判成画面方向变化。
        if observation.reliable_standing:
            sign = 1 if observation.shoulder_hip_dy > 0 else (-1 if observation.shoulder_hip_dy < 0 else 0)
            expect_sign = 1
            if sign != 0 and sign != expect_sign:
                self._sign_streak += 1
                if self._sign_streak >= self.change_streak:
                    self.changed = True
                    return OrientationChange(True, "vertical_sign_inverted", "sign=%d expected=%d" % (sign, expect_sign))
            else:
                self._sign_streak = 0
        return OrientationChange(False)
