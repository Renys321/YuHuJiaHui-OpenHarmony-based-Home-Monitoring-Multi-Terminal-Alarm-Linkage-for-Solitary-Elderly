#!/usr/bin/env python3
"""test_vision_guardian.py — 外部监护守护器的确定性单测（不启动真实进程）。

覆盖：正常不重启、崩溃只报一次 offline、自动重启、健康失败去抖、退避上限、
单实例拒绝、healthz 不能伪造 online、优雅退出无僵尸子进程、日志不泄露敏感信息。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vision_guardian import (  # noqa: E402
    DEFAULT_BACKOFF_MS,
    InstanceLock,
    VisionGuardian,
    build_monitor_payload,
)

SENSITIVE_MARKERS = ("ingest_key", "x-ingest-key", "authorization", "bearer ", "token", "password",
                     "private key", "ssh-", "data:image", "/9j/")   # 最后两个是 JPEG/base64 特征


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.t = float(start)

    def now(self) -> float:
        return self.t

    def advance_ms(self, ms: float) -> None:
        self.t += float(ms) / 1000.0


class FakeChild:
    def __init__(self, pid: int) -> None:
        self.pid = pid


class FakeMqtt:
    def __init__(self) -> None:
        self.calls = 0

    def publish(self) -> None:
        self.calls += 1


def make_guardian(**overrides):
    from vision_guardian import GuardianDeps

    clock = FakeClock()
    state = {"alive": True, "port": True, "health": True, "next_pid": 100}
    mqtt = FakeMqtt()
    lines: list = []
    terminated: list = []

    def spawn():
        state["next_pid"] += 1
        state["alive"] = True
        return FakeChild(state["next_pid"])

    deps = GuardianDeps(
        now=clock.now,
        sleep=lambda seconds: None,
        spawn=spawn,
        is_alive=lambda child: state["alive"],
        terminate=lambda child: (terminated.append(child), state.__setitem__("alive", False)),
        port_open=lambda: state["port"],
        health_ok=lambda: state["health"],
        publish_offline=mqtt.publish,
        log=lines.append,
    )
    # 单测默认关闭启动宽限（真机默认 20s，见下面两个专门用例）
    params = dict(health_fail_threshold=3, stable_reset_ms=60000, tick_ms=2000, startup_grace_ms=0)
    params.update(overrides)
    guardian = VisionGuardian(deps, **params)
    return guardian, clock, state, mqtt, lines, terminated


class VisionGuardianTests(unittest.TestCase):
    # ------------------------------------------------------------ 1) 正常不重启
    def test_healthy_child_is_never_restarted(self) -> None:
        guardian, clock, _state, mqtt, _lines, _term = make_guardian()
        guardian.start()
        for _ in range(50):
            clock.advance_ms(2000)
            guardian.tick()
        self.assertEqual(guardian.stats.spawns, 1)
        self.assertEqual(guardian.stats.restarts, 0)
        self.assertEqual(mqtt.calls, 0)
        self.assertEqual(guardian.stats.offline_events, 0)

    # ------------------------------------------------------------ 2) 崩溃只报一次
    def test_child_crash_publishes_offline_exactly_once(self) -> None:
        guardian, clock, state, mqtt, _lines, _term = make_guardian()
        guardian.start()
        state["alive"] = False
        guardian.tick()
        self.assertEqual(mqtt.calls, 1, "确认崩溃后必须发布一次 offline")
        for _ in range(5):
            clock.advance_ms(100)
            guardian.tick()
        self.assertEqual(mqtt.calls, 1, "同一 episode 内不得重复发布 offline")
        self.assertEqual(guardian.stats.last_reason, "child_exit")

    # ------------------------------------------------------------ 3) 自动重启
    def test_child_is_restarted_after_backoff(self) -> None:
        guardian, clock, state, _mqtt, _lines, _term = make_guardian()
        guardian.start()
        state["alive"] = False
        guardian.tick()
        clock.advance_ms(DEFAULT_BACKOFF_MS[0] - 1)
        guardian.tick()
        self.assertEqual(guardian.stats.spawns, 1, "退避未到不得重启")
        clock.advance_ms(2)
        guardian.tick()
        self.assertEqual(guardian.stats.spawns, 2, "退避到期必须重启")
        self.assertEqual(guardian.stats.restarts, 1)
        self.assertTrue(state["alive"])

    # ------------------------------------------------------------ 4) 健康失败去抖
    def test_health_failures_are_debounced(self) -> None:
        guardian, _clock, state, mqtt, _lines, _term = make_guardian(health_fail_threshold=3)
        guardian.start()
        state["health"] = False
        guardian.tick()
        guardian.tick()
        self.assertEqual(mqtt.calls, 0, "未达阈值不得发布")
        guardian.tick()
        self.assertEqual(mqtt.calls, 1, "达到阈值发布一次")
        self.assertEqual(guardian.stats.last_reason, "health_fail")

    def test_port_closed_is_a_failure(self) -> None:
        guardian, _clock, state, mqtt, _lines, _term = make_guardian()
        guardian.start()
        state["port"] = False
        guardian.tick()
        self.assertEqual(mqtt.calls, 1)
        self.assertEqual(guardian.stats.last_reason, "port_closed")

    # ------------------------------------------------------------ 5) 退避上限
    def test_backoff_grows_then_caps(self) -> None:
        guardian, _clock, _state, _mqtt, _lines, _term = make_guardian()
        self.assertEqual([guardian.backoff_for_attempt(i) for i in range(6)],
                         [2000, 5000, 10000, 30000, 30000, 30000])
        self.assertEqual(max(DEFAULT_BACKOFF_MS), 30000)

    def test_backoff_resets_after_stable_window(self) -> None:
        guardian, clock, state, _mqtt, _lines, _term = make_guardian(stable_reset_ms=5000)
        guardian.start()
        state["alive"] = False
        guardian.tick()
        self.assertGreater(guardian.backoff_index, 0)
        clock.advance_ms(DEFAULT_BACKOFF_MS[0] + 1)
        guardian.tick()                      # 重启成功
        clock.advance_ms(6000)               # 稳定运行超过窗口
        guardian.tick()
        self.assertEqual(guardian.backoff_index, 0, "稳定窗口后应清零退避")

    # ------------------------------------------------------------ 6) 单实例
    def test_second_instance_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "guardian.lock"
            first = InstanceLock(lock_path)
            first.acquire()
            try:
                second = InstanceLock(lock_path)
                with self.assertRaises(RuntimeError) as ctx:
                    second.acquire()
                self.assertIn("already running", str(ctx.exception))
            finally:
                first.release()

    def test_stale_lock_is_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            lock_path = Path(tmp) / "guardian.lock"
            lock_path.write_text("999999999", encoding="utf-8")   # 几乎不可能存在的 PID
            lock = InstanceLock(lock_path)
            lock.acquire()
            self.assertEqual(lock_path.read_text(encoding="utf-8").strip(), str(os.getpid()))
            lock.release()
            self.assertFalse(lock_path.exists())

    # ------------------------------------------------------------ 7) 不能伪造 online
    def test_healthz_success_never_publishes_online(self) -> None:
        payload = json.loads(build_monitor_payload())
        self.assertEqual(payload["cmd"], "monitor")
        self.assertEqual(payload["state"], "offline")
        self.assertEqual(payload["reason"], "no_frame")
        self.assertEqual(payload["source"], "yolo-pose")
        self.assertEqual(set(payload.keys()), {"cmd", "state", "reason", "source"},
                         "只允许既有协议字段，不新增/不夹带载荷")
        guardian, clock, _state, mqtt, _lines, _term = make_guardian()
        guardian.start()
        for _ in range(20):
            clock.advance_ms(2000)
            guardian.tick()          # 全程 healthy
        self.assertEqual(mqtt.calls, 0, "健康检查成功绝不能产生任何 monitor 发布（online 只能由 YOLO 首帧产生）")

    # ------------------------------------------------------------ 8) 优雅退出
    def test_shutdown_terminates_child(self) -> None:
        guardian, _clock, _state, _mqtt, _lines, terminated = make_guardian()
        guardian.start()
        guardian.shutdown()
        self.assertEqual(len(terminated), 1, "退出时必须终止子进程，避免僵尸")
        self.assertIsNone(guardian.child)
        self.assertTrue(guardian.stopping)

    def test_no_spawn_storm_while_waiting(self) -> None:
        guardian, clock, state, mqtt, _lines, _term = make_guardian()
        guardian.start()
        state["alive"] = False
        guardian.tick()
        for _ in range(200):
            clock.advance_ms(10)
            guardian.tick()
        self.assertEqual(guardian.stats.spawns, 1, "退避窗口内不得反复拉起子进程")
        self.assertEqual(mqtt.calls, 1, "也不得刷 MQTT")

    # ------------------------------------------------------------ 启动宽限（真机踩坑修复）
    def test_startup_grace_suppresses_premature_port_failure(self) -> None:
        """模型加载期间 9200 还没监听，绝不能被误判为故障并杀掉子进程。"""
        guardian, clock, state, mqtt, _lines, terminated = make_guardian(startup_grace_ms=20000)
        guardian.start()
        state["port"] = False                     # 子进程还在加载模型
        for _ in range(19):
            clock.advance_ms(1000)
            guardian.tick()
        self.assertEqual(mqtt.calls, 0, "宽限期内不得发布 offline")
        self.assertEqual(len(terminated), 0, "宽限期内不得杀掉子进程")
        clock.advance_ms(1500)                    # 超过 20s 仍未监听
        guardian.tick()
        self.assertEqual(mqtt.calls, 1, "宽限期结束后必须判定 port_closed")
        self.assertEqual(guardian.stats.last_reason, "port_closed")

    def test_real_child_crash_is_detected_inside_startup_grace(self) -> None:
        guardian, _clock, state, mqtt, _lines, _term = make_guardian(startup_grace_ms=20000)
        guardian.start()
        state["alive"] = False
        guardian.tick()
        self.assertEqual(mqtt.calls, 1, "真崩溃不受启动宽限影响，必须立即上报")
        self.assertEqual(guardian.stats.last_reason, "child_exit")

    # ------------------------------------------------------------ 9) 日志脱敏
    def test_logs_do_not_leak_sensitive_data(self) -> None:
        guardian, clock, state, _mqtt, lines, _term = make_guardian()
        guardian.start()
        state["health"] = False
        for _ in range(4):
            clock.advance_ms(1000)
            guardian.tick()
        text = "\n".join(str(line) for line in lines).lower()
        for marker in SENSITIVE_MARKERS:
            self.assertNotIn(marker, text, "日志不得包含敏感标记: " + marker)
        self.assertTrue(any("failure=" in line for line in lines), "应记录故障类别")

    def test_payload_contains_no_image_or_secret(self) -> None:
        raw = build_monitor_payload()
        for marker in SENSITIVE_MARKERS:
            self.assertNotIn(marker, raw.lower())
        self.assertLess(len(raw), 200, "监护事件载荷必须极小")


if __name__ == "__main__":
    unittest.main()
