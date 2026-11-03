"""test_fall_orientation.py — 跌倒方向鲁棒性（2026-11-02 补丁）的单元测试。

背景：既有判定要求 horizontal（torso_angle>=45° 或近方形框），竖向屈膝下坠与
朝摄像头前倒永远不满足，因此漏检。本补丁增加**方向不敏感**的 "快速塌落" 判据：
  相对最近站立基线 total body drop >= 0.22
  + 窗口内峰值下坠速度 >= 0.30/s
  + 低位/地面末端证据（髋到地面层 / 肩很低 / 肩低于髋 / 框高塌缩）
并修正两处方向语义：
  - upright 必须肩中心在髋中心上方（否则"朝镜头前倒"的投影会被误判为直立）；
  - near-square bbox 不能单独构成 horizontal（真实机位坐/蹲时下肢截断会产生方框）。

约定：这些用例是**合成关键点序列**（非真机数据）。真机验证仍需现场录像。
"""
import unittest

from fall_detector import DetectorConfig, FallDetector, FallState, Point, PoseFrame


def pose(ts_ms, bbox, shoulder_y, hip_y, track_id=1, shoulder_x=0.50, hip_x=0.50, conf=0.95):
    points = {
        "left_shoulder": Point(shoulder_x - 0.04, shoulder_y, conf),
        "right_shoulder": Point(shoulder_x + 0.04, shoulder_y, conf),
        "left_hip": Point(hip_x - 0.03, hip_y, conf),
        "right_hip": Point(hip_x + 0.03, hip_y, conf),
    }
    return PoseFrame(ts_ms, bbox, points, pose_confidence=0.9, track_id=track_id)


def pose_tilt(ts_ms, bbox, hip_y, torso_deg, track_id=1, hip_x=0.50, conf=0.95):
    """构造具有指定归一化躯干角（atan2(|dx|,|dy|)）的姿态，用于真机角度分布回归。"""
    import math
    dy = 0.02 if torso_deg >= 80.0 else 0.10
    dx = math.tan(math.radians(torso_deg)) * dy
    shoulder_y = hip_y - dy
    points = {
        "left_shoulder": Point(hip_x - dx - 0.04, shoulder_y, conf),
        "right_shoulder": Point(hip_x - dx + 0.04, shoulder_y, conf),
        "left_hip": Point(hip_x - 0.03, hip_y, conf),
        "right_hip": Point(hip_x + 0.03, hip_y, conf),
    }
    return PoseFrame(ts_ms, bbox, points, pose_confidence=0.9, track_id=track_id)


def standing(ts_ms, hip_y=0.52, track_id=1):
    return pose(ts_ms, (0.40, 0.10, 0.60, 0.92), 0.30, hip_y, track_id)


def vertical_collapse_sequence(track_id=1):
    """竖向屈膝下坠：躯干全程竖直（torso≈0°），髋/肩快速整体下沉到地面层。"""
    return [
        standing(0, track_id=track_id),
        standing(500, track_id=track_id),
        standing(1000, track_id=track_id),
        # 髋 0.52 -> 0.68（0.32/s），肩跟随下沉
        pose(1500, (0.35, 0.20, 0.75, 0.95), 0.46, 0.68, track_id),
        # 髋 0.84（0.32/s），已到"地面层"
        pose(2000, (0.32, 0.30, 0.72, 0.98), 0.58, 0.84, track_id),
        pose(2500, (0.30, 0.35, 0.70, 0.99), 0.60, 0.86, track_id),
        pose(3000, (0.30, 0.35, 0.70, 0.99), 0.60, 0.86, track_id),
    ]


def forward_camera_sequence(track_id=1):
    """朝摄像头前倒：投影压缩后肩中心落到髋下方（shoulder_hip_dy<0），躯干投影角≈0°。"""
    return [
        standing(0, track_id=track_id),
        standing(500, track_id=track_id),
        standing(1000, track_id=track_id),
        pose(1500, (0.46, 0.25, 0.56, 0.98), 0.55, 0.58, track_id),   # 肩快速下沉
        pose(2000, (0.44, 0.40, 0.58, 0.99), 0.68, 0.64, track_id),   # 投影反置：肩低于髋
        pose(2500, (0.44, 0.40, 0.58, 0.99), 0.70, 0.66, track_id),
        pose(3000, (0.44, 0.40, 0.58, 0.99), 0.70, 0.66, track_id),
    ]


def run_sequence(detector, frames):
    return [detector.update(frame) for frame in frames]


class OrientationAgnosticCollapseTests(unittest.TestCase):
    # 1) 竖向屈膝下坠（旧实现漏检）现在可检出；事件来自非水平路径
    def test_1_vertical_buckle_is_detected(self):
        detector = FallDetector()
        events = run_sequence(detector, vertical_collapse_sequence())
        fired = [e for e in events if e is not None]
        self.assertEqual(1, len(fired), "竖向塌落必须恰好触发一次")
        self.assertEqual(FallState.FALLEN, detector.state)
        event = fired[0]
        self.assertLess(event.torso_angle_deg, 25.0, "竖向跌倒的躯干角应保持竖直")
        self.assertLess(event.bbox_aspect, 0.95, "竖向跌倒不应依赖近方形框")
        self.assertGreaterEqual(event.hip_drop_per_sec, 0.30)

    # 2) 朝摄像头前倒（投影竖直、肩低于髋）可检出
    def test_2_forward_camera_fall_is_detected(self):
        detector = FallDetector()
        fired = [e for e in run_sequence(detector, forward_camera_sequence()) if e is not None]
        self.assertEqual(1, len(fired), "朝镜头前倒必须触发一次")
        self.assertLess(fired[0].torso_angle_deg, 25.0)

    # 3) 180° 侧倒（旧实现可检出）必须保持可检出
    def test_3_side_fall_180_still_detected(self):
        detector = FallDetector()
        frames = [
            standing(0),
            pose(200, (0.18, 0.66, 0.82, 0.92), 0.77, 0.78),   # torso≈88°
            pose(900, (0.18, 0.66, 0.82, 0.92), 0.77, 0.78),
            pose(1500, (0.18, 0.66, 0.82, 0.92), 0.77, 0.78),
        ]
        fired = [e for e in run_sequence(detector, frames) if e is not None]
        self.assertEqual(1, len(fired))

    # 4) 关闭 collapse_enabled 后回到 2026-10-28 前的行为（竖向漏检）
    def test_4_collapse_disabled_matches_legacy(self):
        detector = FallDetector(DetectorConfig(collapse_enabled=False))
        fired = [e for e in run_sequence(detector, vertical_collapse_sequence()) if e is not None]
        self.assertEqual(0, len(fired), "关闭新判据后竖向跌倒应保持漏检（用于 A/B）")

    # 5) 正常坐下 / 蹲下 / 弯腰不误报
    def test_5_sit_crouch_bend_do_not_fire(self):
        sitting = [
            standing(0), standing(400),
            pose(800, (0.35, 0.30, 0.65, 0.92), 0.36, 0.56),
            pose(1300, (0.35, 0.34, 0.65, 0.92), 0.42, 0.62),
            pose(1900, (0.35, 0.37, 0.65, 0.92), 0.46, 0.70),
            pose(2600, (0.35, 0.37, 0.65, 0.92), 0.46, 0.70),
        ]
        crouch = list(sitting)
        crouch[-2] = pose(1900, (0.30, 0.30, 0.70, 0.92), 0.47, 0.68)
        crouch[-1] = pose(2600, (0.30, 0.30, 0.70, 0.92), 0.47, 0.68)
        bend = [
            standing(0), standing(400),
            pose(900, (0.28, 0.28, 0.68, 0.92), 0.43, 0.55),
            pose(1400, (0.28, 0.28, 0.68, 0.92), 0.45, 0.57),
            pose(2000, (0.40, 0.10, 0.60, 0.92), 0.30, 0.52),
        ]
        for name, frames in (("sitting", sitting), ("crouch", crouch), ("bending", bend)):
            detector = FallDetector()
            fired = [e for e in run_sequence(detector, frames) if e is not None]
            self.assertEqual(0, len(fired), "%s 不得误报" % name)

    # 6) near-square bbox + 竖直躯干不再算 horizontal（真实机位坐/蹲的近方框）
    def test_6_near_square_bbox_with_vertical_torso_is_not_horizontal(self):
        detector = FallDetector()
        detector.update(standing(0))
        detector.update(pose(200, (0.30, 0.40, 0.78, 0.90), 0.40, 0.62))  # aspect≈0.96, torso≈0°
        snap = detector.snapshot(200)
        self.assertAlmostEqual(0.96, snap["bbox_aspect"], places=2)
        self.assertFalse(snap["horizontal"], "近方形框不能单独证明水平")

    # 7) 近方形框 + 躯干确实倾斜（35°–45°）仍可作为水平证据（保留原有能力）
    def test_7_near_square_bbox_with_tilt_is_horizontal(self):
        detector = FallDetector()
        detector.update(standing(0))
        points = {
            "left_shoulder": Point(0.46, 0.40, 0.95),
            "right_shoulder": Point(0.54, 0.40, 0.95),
            "left_hip": Point(0.548, 0.50, 0.95),   # dx≈0.078 dy≈0.10 -> ≈38°
            "right_hip": Point(0.628, 0.50, 0.95),
        }
        frame = PoseFrame(200, (0.30, 0.38, 0.78, 0.88), points, pose_confidence=0.9)
        detector.update(frame)
        snap = detector.snapshot(200)
        self.assertGreaterEqual(snap["torso_angle_deg"], 35.0)
        self.assertTrue(snap["horizontal"])

    # 8) 单帧关键点跳变不能形成 FALL（需要连续塌落证据 + confirm 窗口）
    def test_8_single_frame_spike_does_not_fire(self):
        detector = FallDetector()
        frames = [
            standing(0), standing(500), standing(1000),
            pose(1500, (0.20, 0.30, 0.80, 0.99), 0.80, 0.95),   # 单帧跳到地面
            standing(2000), standing(2500), standing(3000),
        ]
        fired = [e for e in run_sequence(detector, frames) if e is not None]
        self.assertEqual(0, len(fired), "单帧跳变不得触发 FALL")

    # 9) 肩低于髋（朝镜头前倒的投影）不能再被当作 upright
    def test_9_inverted_shoulders_are_not_upright(self):
        detector = FallDetector()
        detector.update(standing(0))
        detector.update(pose(500, (0.44, 0.40, 0.58, 0.99), 0.70, 0.66))  # 肩(0.70) 低于 髋(0.66)
        snap = detector.snapshot(500)
        self.assertLess(snap["shoulder_hip_dy"], 0.0)
        self.assertFalse(snap["upright"], "投影反置的身体不得判为直立")
        self.assertFalse(snap["standing"])

    # 10) 配置 ground-zone 时，髋部在区域内即可作为"地面层"
    def test_10_ground_zone_vertical_collapse_detected(self):
        detector = FallDetector(ground_zones=[(0.0, 0.55, 1.0, 1.0)])
        frames = [
            standing(0), standing(500), standing(1000),
            pose(1500, (0.35, 0.20, 0.75, 0.95), 0.50, 0.62),
            pose(2000, (0.32, 0.30, 0.72, 0.98), 0.62, 0.70),  # 髋 0.70 在 zone 内、未到 0.78
            pose(2500, (0.30, 0.35, 0.70, 0.99), 0.64, 0.72),
            pose(3000, (0.30, 0.35, 0.70, 0.99), 0.64, 0.72),
        ]
        fired = [e for e in run_sequence(detector, frames) if e is not None]
        self.assertEqual(1, len(fired), "配置 ground-zone 时竖向塌落也应触发")

    # 11) 跌倒后站起（回到站立高度）应恢复
    def test_11_recovery_after_vertical_fall(self):
        detector = FallDetector()
        run_sequence(detector, vertical_collapse_sequence())
        self.assertEqual(FallState.FALLEN, detector.state)
        detector.update(standing(3500))
        self.assertEqual(FallState.FALLEN, detector.state, "仅回到站立高度不足 recover_ms 时不恢复")
        detector.update(standing(6000))
        self.assertEqual(FallState.NORMAL, detector.state)

    # 12) 快照暴露塌落诊断量（供真机标定），且既有 9 项阈值快照不变
    def test_12_snapshot_exposes_collapse_diagnostics(self):
        detector = FallDetector()
        for frame in vertical_collapse_sequence()[:5]:
            detector.update(frame)
        snap = detector.snapshot(2000)
        self.assertEqual(9, len(snap["thresholds"]), "既有阈值快照保持 9 项，不得破坏既有契约")
        collapse = snap["collapse"]
        self.assertIn("evidence", collapse)
        self.assertIn("hold_evidence", collapse)
        self.assertIn("terminal_drop_per_sec", collapse)
        self.assertIn("knee_y", collapse)
        self.assertIn("ankle_y", collapse)
        self.assertIn("peak_hip_drop_per_sec", collapse)
        self.assertIn("thresholds", collapse)
        self.assertGreaterEqual(collapse["peak_hip_drop_per_sec"], 0.30)

    # 13) 默认参数锁定（防止后续被悄悄放宽/收紧）
    def test_13_collapse_defaults_are_exact(self):
        config = DetectorConfig()
        self.assertTrue(config.collapse_enabled)
        self.assertEqual(0.22, config.collapse_min_body_drop)
        self.assertEqual(2500, config.collapse_window_ms)
        self.assertEqual(0.30, config.collapse_peak_drop_per_sec)
        self.assertEqual(0.78, config.collapse_floor_hip_y)
        self.assertEqual(0.72, config.collapse_floor_shoulder_y)
        self.assertEqual(0.55, config.collapse_max_height_ratio)
        self.assertEqual(200, config.collapse_confirm_ms)
        self.assertEqual(0.22, config.collapse_terminal_drop_per_sec)
        self.assertEqual(35.0, config.horizontal_aspect_min_torso_deg)

    # 14) 受控减速的快速深蹲/坐到地面：即使整体下沉量与峰值速度都够，也不得误报
    #     （触底帧速度已被肌肉减速到 0.12/s < terminal 0.22/s；与真机 2026-11-02
    #      快速深蹲 0 误报的经验一致）
    def test_14_fast_controlled_crouch_to_floor_does_not_fire(self):
        detector = FallDetector()
        frames = [
            standing(0), standing(400), standing(800),
            # 快下（0.32/s）后逐步减速，最终坐到地面层
            pose(1100, (0.37, 0.16, 0.63, 0.94), 0.39, 0.60),
            pose(1400, (0.35, 0.24, 0.65, 0.96), 0.46, 0.67),
            pose(1700, (0.33, 0.30, 0.67, 0.98), 0.51, 0.72),
            pose(2000, (0.32, 0.34, 0.68, 0.99), 0.54, 0.76),
            pose(2300, (0.32, 0.36, 0.68, 0.99), 0.56, 0.79),
            pose(2600, (0.32, 0.37, 0.68, 0.99), 0.57, 0.81),
            pose(2900, (0.32, 0.37, 0.68, 0.99), 0.57, 0.82),
        ]
        fired = [e for e in run_sequence(detector, frames) if e is not None]
        self.assertEqual(0, len(fired), "受控减速的快速深蹲不得误报")

    # 15) 关闭 terminal 门槛后，同一受控深蹲会误报 —— 证明是 terminal 判据在起作用
    def test_15_terminal_gate_is_the_discriminator(self):
        detector = FallDetector(DetectorConfig(collapse_terminal_drop_per_sec=0.0))
        frames = [
            standing(0), standing(400), standing(800),
            pose(1100, (0.37, 0.16, 0.63, 0.94), 0.39, 0.60),
            pose(1400, (0.35, 0.24, 0.65, 0.96), 0.46, 0.67),
            pose(1700, (0.33, 0.30, 0.67, 0.98), 0.51, 0.72),
            pose(2000, (0.32, 0.34, 0.68, 0.99), 0.54, 0.76),
            pose(2300, (0.32, 0.36, 0.68, 0.99), 0.56, 0.79),
            pose(2600, (0.32, 0.37, 0.68, 0.99), 0.57, 0.81),
            pose(2900, (0.32, 0.37, 0.68, 0.99), 0.57, 0.82),
        ]
        fired = [e for e in run_sequence(detector, frames) if e is not None]
        self.assertGreaterEqual(len(fired), 1, "关闭 terminal 门槛后应能复现误报（A/B 对照）")

    # 17) 近景构图保护（2026-11-02 18:36 现场教训）：框底触底≈1.0 时，
    #     若身体已明显下沉（>= collapse_min_body_drop），不得再用 bottom-clip
    #     兜底判 upright —— 否则正在塌落的帧会被当成"已恢复"，错误取消 collapse 疑点。
    def test_17_bottom_clip_fallback_disabled_after_descent(self):
        detector = FallDetector()
        # 近景站姿：框底 .99（下肢被切）、aspect≈0.94 只能靠 bottom-clip 判直立
        frames = [
            pose(0, (0.30, 0.49, 0.77, 0.99), 0.44, 0.60),
            pose(500, (0.30, 0.49, 0.77, 0.99), 0.44, 0.60),
            pose(1000, (0.30, 0.49, 0.77, 0.99), 0.44, 0.60),   # 站立基线
            pose(1500, (0.30, 0.49, 0.77, 0.99), 0.69, 0.85),   # 快速下沉，框底仍 .99
            pose(1800, (0.30, 0.49, 0.77, 0.99), 0.70, 0.86),
            pose(2100, (0.30, 0.49, 0.77, 0.99), 0.70, 0.86),
        ]
        fired = [e for e in run_sequence(detector, frames) if e is not None]
        self.assertEqual(1, len(fired), "近景快速塌落必须仍能检出，不能被 bottom-clip 兜底取消")
        snap = detector.snapshot(1800)
        self.assertTrue(snap["bottom_clipped"])
        self.assertFalse(snap["upright"], "身体已下沉时不得用框底触底兜底判直立")

    # 18) 近景站姿（未下沉）仍应允许 bottom-clip 兜底判直立（保持原能力）
    def test_18_bottom_clip_fallback_still_works_when_standing(self):
        detector = FallDetector()
        detector.update(pose(0, (0.30, 0.49, 0.77, 0.99), 0.44, 0.60))
        snap = detector.snapshot(0)
        self.assertTrue(snap["bottom_clipped"])
        self.assertTrue(snap["upright"], "仍在站立高度的近景帧应保留 bottom-clip 兜底")

    # 16) 摔倒后髋部继续下沉（触底帧仍在快速下坠）仍然检出：正向场景不受影响
    def test_16_fall_with_high_terminal_velocity_still_detected(self):
        detector = FallDetector()
        frames = [
            standing(0), standing(500), standing(1000),
            pose(1500, (0.35, 0.20, 0.75, 0.95), 0.46, 0.68),   # 0.32/s
            pose(1800, (0.32, 0.28, 0.72, 0.98), 0.56, 0.80),   # 0.40/s（触底仍快）
            pose(2100, (0.30, 0.34, 0.70, 0.99), 0.60, 0.86),
            pose(2400, (0.30, 0.34, 0.70, 0.99), 0.60, 0.86),
        ]
        fired = [e for e in run_sequence(detector, frames) if e is not None]
        self.assertEqual(1, len(fired), "触底帧仍在下坠的跌倒必须检出")

    # 19) 真机 18:39–18:41 批次的“躺倒确认帧 49.4°”仍须检出
    #     注意：该批次动作归属后续被用户更正为“归属不清、不作误报证据”，
    #     因此这里只做角度边界回归（49.4° > 45° 阈值），不作为真机命中率证据。
    def test_19_min_lying_angle_from_ambiguous_live_batch_still_detected(self):
        detector = FallDetector(ground_zones=[(0.0, 0.55, 1.0, 1.0)])
        frames = [
            standing(0), standing(500), standing(1000),
            pose_tilt(1400, (0.40, 0.35, 0.75, 0.99), 0.62, 49.4),
            pose_tilt(1700, (0.40, 0.35, 0.75, 0.99), 0.70, 49.4),
            pose_tilt(2100, (0.40, 0.35, 0.75, 0.99), 0.79, 49.4),
            pose_tilt(2500, (0.40, 0.35, 0.75, 0.99), 0.79, 49.4),
        ]
        fired = [e for e in run_sequence(detector, frames) if e is not None]
        self.assertEqual(1, len(fired), "49.4° 躺倒帧仍须检出（45° 阈值）")

    # 20) 10-28 现场 trace 的 68.1° 侧倒必须保持检出
    def test_20_2026_10_28_side_fall_trace_still_detected(self):
        detector = FallDetector()
        frames = [
            standing(0), standing(400), standing(800),
            pose_tilt(1200, (0.30, 0.60, 0.80, 0.98), 0.552, 73.7),
            pose_tilt(1800, (0.30, 0.60, 0.80, 0.99), 0.617, 68.1),
            pose_tilt(2400, (0.30, 0.60, 0.80, 0.99), 0.617, 68.1),
        ]
        fired = [e for e in run_sequence(detector, frames) if e is not None]
        self.assertEqual(1, len(fired), "10-28 trace 的 68.1° 侧倒必须仍检出")

    # 21) 水平角阈值保持 45°（曾试收紧到 48.5°，因依据批次归属不清而回退，不引入未验证改动）
    def test_21_horizontal_angle_threshold_stays_45(self):
        self.assertEqual(45.0, DetectorConfig().horizontal_torso_angle_deg)


if __name__ == "__main__":
    unittest.main()
