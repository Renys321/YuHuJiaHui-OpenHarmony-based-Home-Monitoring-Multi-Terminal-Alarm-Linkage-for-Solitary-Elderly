#!/usr/bin/env python3
"""vision_guardian.py — 独立于 YOLO 子进程的 PC 侧监护守护器。

为什么需要它
------------
跌倒检测的取帧与 watchdog 都运行在 yolo_pose_service.py 进程内。该进程一旦崩溃/被杀，
它自己的 watchdog 也随之消失：设备侧 monitorOnline 会停留在最后一次的值（通常是 1），
"PC 监护已失联"这件事再也没人上报。本守护器把"进程存活"与"是否还在收帧"分开：

  * 子进程退出 / 9200 端口关闭 / /healthz 连续失败  →  确认故障
  * 确认故障后：只发布一次 monitor offline，然后按有界退避自动拉起子进程
  * monitor online 永远由 YOLO 自己"收到第一帧"后发布，本守护器从不发布 online
    （否则"服务起来了但相机没帧"会变成假在线）

协议复用（不新造协议）：与 yolo_pose_service.MqttCommandSink 完全一致的消息体
  {"cmd":"monitor","state":"offline","reason":"no_frame","source":"yolo-pose"}
经 bridge/mqtt_tool.js pub 发到 home/<device>/cmd。

安全：不读取、不打印任何密钥；日志只含时间、进程号、故障类别、退避毫秒数和发布结果。
不重启 Broker / Bridge / public-sync / DAYU APP。
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Tuple

DEFAULT_BACKOFF_MS = (2000, 5000, 10000, 30000)
DEFAULT_HEALTH_FAIL_THRESHOLD = 3
DEFAULT_STABLE_RESET_MS = 60000
DEFAULT_TICK_MS = 2000
# YOLO 子进程要加载模型后才开始监听 9200（实测约 1-3 秒，冷启动可能更久）。
# 没有这段宽限期，守护器会在子进程还没起来时误判 port_closed 并把它杀掉（本轮真机已复现）。
DEFAULT_STARTUP_GRACE_MS = 20000
DEFAULT_HEALTH_TIMEOUT_S = 3.0
OFFLINE_REASON = "no_frame"          # 复用既有 reason；不发明新协议字段
MONITOR_SOURCE = "yolo-pose"


# --------------------------------------------------------------------------- 依赖注入
@dataclass
class GuardianDeps:
    """所有副作用都可替换，便于确定性单测（不启动真实进程）。"""

    now: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    spawn: Callable[[], object] = lambda: None
    is_alive: Callable[[object], bool] = lambda child: False
    terminate: Callable[[object], None] = lambda child: None
    port_open: Callable[[], bool] = lambda: True
    health_ok: Callable[[], bool] = lambda: True
    publish_offline: Callable[[], None] = lambda: None
    log: Callable[[str], None] = lambda line: print(line, flush=True)


@dataclass
class GuardianStats:
    restarts: int = 0
    offline_events: int = 0
    ticks: int = 0
    last_reason: str = ""
    spawns: int = 0


class VisionGuardian:
    """有界退避、单次 offline、永不伪造 online 的守护状态机。"""

    def __init__(
        self,
        deps: GuardianDeps,
        *,
        health_fail_threshold: int = DEFAULT_HEALTH_FAIL_THRESHOLD,
        stable_reset_ms: int = DEFAULT_STABLE_RESET_MS,
        backoff_ms: Tuple[int, ...] = DEFAULT_BACKOFF_MS,
        tick_ms: int = DEFAULT_TICK_MS,
        startup_grace_ms: int = DEFAULT_STARTUP_GRACE_MS,
    ) -> None:
        if health_fail_threshold < 1:
            raise ValueError("health_fail_threshold must be >= 1")
        if stable_reset_ms < 0:
            raise ValueError("stable_reset_ms must be >= 0")
        if startup_grace_ms < 0:
            raise ValueError("startup_grace_ms must be >= 0")
        if not backoff_ms or min(backoff_ms) <= 0:
            raise ValueError("backoff_ms must be positive")
        self.deps = deps
        self.health_fail_threshold = int(health_fail_threshold)
        self.stable_reset_ms = int(stable_reset_ms)
        self.backoff_ms = tuple(int(v) for v in backoff_ms)
        self.tick_ms = int(tick_ms)
        self.startup_grace_ms = int(startup_grace_ms)
        self.child_started_ms = None
        self.stats = GuardianStats()
        self.child = None
        self.health_failures = 0
        self.backoff_index = 0
        self.offline_published = False
        self.last_healthy_ms = None
        self.restart_at_ms = None
        self.stopping = False

    # ------------------------------------------------------------------ 工具
    def backoff_for_attempt(self, index: int) -> int:
        return self.backoff_ms[min(max(index, 0), len(self.backoff_ms) - 1)]

    def _now_ms(self) -> float:
        """统一时间单位：deps.now 约定返回秒（time.monotonic 语义），内部一律用毫秒。

        实测踩坑：曾把"秒"和"退避毫秒"直接相加，退避会被放大 1000 倍（2s 变 2000s）。
        """
        return float(self.deps.now()) * 1000.0

    def _log(self, message: str) -> None:
        self.deps.log("[guardian] " + message)

    # ------------------------------------------------------------------ 生命周期
    def start(self) -> None:
        self._log("starting YOLO child")
        self.child = self.deps.spawn()
        self.stats.spawns += 1
        self.offline_published = False
        self.health_failures = 0
        now_ms = self._now_ms()
        self.last_healthy_ms = now_ms
        self.child_started_ms = now_ms

    def _confirm_failure(self, reason: str, now_ms: float) -> None:
        """确认一次故障：只发布一次 offline，然后按退避安排重启。"""
        self.stats.last_reason = reason
        if not self.offline_published:
            try:
                self.deps.publish_offline()
                self.offline_published = True
                self.stats.offline_events += 1
                self._log("failure=" + reason + " -> published monitor offline (" + OFFLINE_REASON + ") once")
            except Exception as error:                      # noqa: BLE001 - 发布失败不能拖垮守护
                self._log("failure=" + reason + " -> offline publish failed: " + type(error).__name__)
        delay = self.backoff_for_attempt(self.backoff_index)
        self.backoff_index += 1
        if self.child is not None:
            try:
                self.deps.terminate(self.child)
            except Exception:                               # noqa: BLE001
                pass
            self.child = None
        self.restart_at_ms = now_ms + delay
        self._log("failure=" + reason + " -> restart in " + str(delay) + " ms (attempt index " + str(self.backoff_index) + ")")

    def _maybe_restart(self, now_ms: float) -> None:
        if self.restart_at_ms is None or now_ms < self.restart_at_ms:
            return
        self.restart_at_ms = None
        self.stats.restarts += 1
        self.start()
        self._log("restarted YOLO child (restart #" + str(self.stats.restarts) + ")")

    # ------------------------------------------------------------------ 心跳
    def tick(self) -> None:
        now_ms = self._now_ms()
        self.stats.ticks += 1
        if self.stopping:
            return
        if self.restart_at_ms is not None:
            self._maybe_restart(now_ms)
            return
        if self.child is None:
            self._confirm_failure("no_child", now_ms)
            return

        if not self.deps.is_alive(self.child):
            self._confirm_failure("child_exit", now_ms)     # 真崩溃立即发现，宽限期不掩盖
            return
        if self.child_started_ms is not None and now_ms - self.child_started_ms < self.startup_grace_ms:
            return                                          # 启动宽限：模型加载期间不判 port/health
        if not self.deps.port_open():
            self._confirm_failure("port_closed", now_ms)
            return
        if not self.deps.health_ok():
            self.health_failures += 1
            if self.health_failures >= self.health_fail_threshold:
                self._confirm_failure("health_fail", now_ms)
            else:
                self._log("health check failed (" + str(self.health_failures) + "/" + str(self.health_fail_threshold) + ")")
            return

        self.health_failures = 0
        if self.last_healthy_ms is None:
            self.last_healthy_ms = now_ms
        elif self.stable_reset_ms > 0 and now_ms - self.last_healthy_ms >= self.stable_reset_ms:
            if self.backoff_index != 0:
                self._log("stable window reached -> backoff reset")
            self.backoff_index = 0
            self.last_healthy_ms = now_ms

    def serve_forever(self) -> int:
        self.start()
        try:
            while not self.stopping:
                self.tick()
                self.deps.sleep(self.tick_ms / 1000.0)
        except KeyboardInterrupt:
            self._log("interrupted")
        finally:
            self.shutdown()
        return 0

    def shutdown(self) -> None:
        self.stopping = True
        if self.child is not None:
            try:
                self.deps.terminate(self.child)
                self._log("stopped YOLO child")
            except Exception:                               # noqa: BLE001
                pass
            self.child = None


# --------------------------------------------------------------------------- 单实例锁
class InstanceLock:
    """PID 锁：第二个守护器必须被明确拒绝（不是静默退出）。"""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        """判断 PID 是否存活。

        注意（实测踩坑）：**Windows 上绝不能用 os.kill(pid, 0)** —— CPython 把 sig=0 当作
        CTRL_C_EVENT，会调用 GenerateConsoleCtrlEvent 给同控制台进程组发 Ctrl+C，
        既可能打断自己（本轮测试就因此收到 KeyboardInterrupt），也不是存活检查语义。
        Windows 改用 OpenProcess + GetExitCodeProcess(STILL_ACTIVE)。
        """
        if pid <= 0:
            return False
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.restype = wintypes.HANDLE
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                return False
            try:
                code = wintypes.DWORD()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return False
                return code.value == STILL_ACTIVE
            finally:
                kernel32.CloseHandle(handle)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            try:
                old = int(self.path.read_text(encoding="utf-8").strip() or "0")
            except ValueError:
                old = 0
            if self._pid_alive(old):
                raise RuntimeError("another vision guardian is already running (pid " + str(old) + ")")
            self.path.unlink(missing_ok=True)
        self.path.write_text(str(os.getpid()), encoding="utf-8")

    def release(self) -> None:
        try:
            if self.path.exists() and self.path.read_text(encoding="utf-8").strip() == str(os.getpid()):
                self.path.unlink()
        except OSError:
            pass


# --------------------------------------------------------------------------- 真实副作用
def build_monitor_payload() -> str:
    """guardian 只发布 offline；消息体与 yolo_pose_service 完全一致。"""
    return json.dumps(
        {"cmd": "monitor", "state": "offline", "reason": OFFLINE_REASON, "source": MONITOR_SOURCE},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def make_mqtt_publisher(node: str, tool: Path, broker: str, device_id: str) -> Callable[[], None]:
    """复用既有协议：mqtt_tool.js pub -> home/<device>/cmd。"""
    payload = build_monitor_payload()

    def publish() -> None:
        command = [node, str(tool), "pub", "--broker", broker,
                   "--topic", "home/" + device_id + "/cmd", "--msg", payload]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=8)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())

    return publish


def make_health_check(port: int, timeout_s: float = DEFAULT_HEALTH_TIMEOUT_S) -> Callable[[], bool]:
    url = "http://127.0.0.1:" + str(port) + "/healthz"

    def healthy() -> bool:
        try:
            with urllib.request.urlopen(url, timeout=timeout_s) as response:
                return 200 <= int(response.status) < 300
        except (urllib.error.URLError, OSError, ValueError):
            return False

    return healthy


def make_port_check(port: int, timeout_s: float = 1.0) -> Callable[[], bool]:
    def port_open() -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=timeout_s):
                return True
        except OSError:
            return False

    return port_open


def tee_logger(path: Path) -> Callable[[str], None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a", encoding="utf-8")

    def log(line: str) -> None:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        text = stamp + " " + line
        print(text, flush=True)
        handle.write(text + "\n")
        handle.flush()

    return log


def make_spawner(python: str, service: Path, service_args: list, workdir: Path,
                 log: Callable[[str], None], service_log: Optional[Path] = None):
    """启动 YOLO 子进程。

    子进程 stdout/stderr 必须被保留（不能丢弃）：既写脱敏日志文件，也由调用方决定是否可见。
    """
    command = [python, str(service)] + list(service_args)
    handle = None
    if service_log is not None:
        Path(service_log).parent.mkdir(parents=True, exist_ok=True)
        handle = Path(service_log).open("a", encoding="utf-8")
        log("YOLO stdout/stderr -> " + str(service_log))

    def spawn() -> object:
        child = subprocess.Popen(command, cwd=str(workdir),
                                 stdout=handle if handle is not None else None,
                                 stderr=subprocess.STDOUT if handle is not None else None,
                                 text=True)
        log("child started pid=" + str(child.pid))
        return child

    def is_alive(child: object) -> bool:
        return isinstance(child, subprocess.Popen) and child.poll() is None

    def terminate(child: object) -> None:
        if not isinstance(child, subprocess.Popen):
            return
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        log("child stopped pid=" + str(child.pid) + " code=" + str(child.returncode))

    return spawn, is_alive, terminate


def build_arg_parser() -> argparse.ArgumentParser:
    project = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="PC-side vision guardian (offline reporting + bounded restart)")
    parser.add_argument("--python", default=str(project / ".venv-vision" / "Scripts" / "python.exe"))
    parser.add_argument("--service", default=str(project / "vision" / "yolo_pose_service.py"))
    parser.add_argument("--model", default=str(project / "vision" / "yolo11n-pose.pt"))
    parser.add_argument("--listen-host", default="127.0.0.1")
    parser.add_argument("--listen-port", type=int, default=9200)
    parser.add_argument("--broker", default="127.0.0.1:1883")
    parser.add_argument("--target-device", default="dayu200-living")
    parser.add_argument("--node", default="node")
    parser.add_argument("--mqtt-tool", default=str(project / "bridge" / "mqtt_tool.js"))
    parser.add_argument("--log", default=str(project / "evidence" / "2026-10-15-dayu-fall-monitor-runtime" / "guardian.log"))
    parser.add_argument("--lock", default=str(project / "evidence" / "2026-10-15-dayu-fall-monitor-runtime" / "guardian.lock"))
    parser.add_argument("--service-log", default=str(project / "evidence" / "2026-10-15-dayu-fall-monitor-runtime" / "yolo-service.log"))
    parser.add_argument("--health-fail-threshold", type=int, default=DEFAULT_HEALTH_FAIL_THRESHOLD)
    parser.add_argument("--stable-reset-ms", type=int, default=DEFAULT_STABLE_RESET_MS)
    parser.add_argument("--tick-ms", type=int, default=DEFAULT_TICK_MS)
    parser.add_argument("--startup-grace-ms", type=int, default=DEFAULT_STARTUP_GRACE_MS,
                        help="子进程启动后多久才开始判定 port/health（模型加载需要时间）")
    parser.add_argument("--publish", action="store_true", help="pass --publish to the YOLO service (real FALL commands)")
    return parser


def main(argv: Optional[list] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    log = tee_logger(Path(args.log))
    lock = InstanceLock(Path(args.lock))
    try:
        lock.acquire()
    except RuntimeError as error:
        log("refused to start: " + str(error))
        return 2

    project = Path(__file__).resolve().parent.parent
    service_args = [
        "--model", args.model, "--device", "cpu",
        "--listen-host", args.listen_host, "--listen-port", str(args.listen_port),
        "--broker", args.broker, "--target-device", args.target_device,
    ]
    if args.publish:
        service_args.append("--publish")

    spawn, is_alive, terminate = make_spawner(args.python, Path(args.service), service_args, project, log,
                                              Path(args.service_log))
    deps = GuardianDeps(
        spawn=spawn,
        is_alive=is_alive,
        terminate=terminate,
        port_open=make_port_check(args.listen_port),
        health_ok=make_health_check(args.listen_port),
        publish_offline=make_mqtt_publisher(args.node, Path(args.mqtt_tool), args.broker, args.target_device),
        log=log,
    )
    guardian = VisionGuardian(
        deps,
        health_fail_threshold=args.health_fail_threshold,
        stable_reset_ms=args.stable_reset_ms,
        tick_ms=args.tick_ms,
        startup_grace_ms=args.startup_grace_ms,
    )

    def on_signal(signum, _frame):                          # noqa: ANN001
        log("signal " + str(signum) + " -> shutting down")
        guardian.stopping = True

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    log("guardian start pid=" + str(os.getpid()) + " port=" + str(args.listen_port) + " device=" + args.target_device)
    try:
        guardian.serve_forever()
    finally:
        lock.release()
        log("guardian stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
