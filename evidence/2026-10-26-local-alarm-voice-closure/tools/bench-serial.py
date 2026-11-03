#!/usr/bin/env python3
"""bench-serial.py — serial harness for LOCAL-ALARM-VOICE-CLOSURE bench firmware.

The bench demo AP is absent (nodes log WiFi reason=201 NO_AP_FOUND), so the nodes are
driven over the USB serial console instead of the TCP gateway.  This tool:

  * opens a COM port (default 115200 8N1) with DTR/RTS RELEASED at open time,
    so the only reset is the normal open pulse (expected, the firmware then boots);
  * reads the console continuously and logs every line with elapsed seconds +
    local wall clock, stripping ANSI escape codes and tolerating non-UTF8 bytes;
  * writes ONLY the scenario command lines, at their scheduled atSec offsets,
    one command per line, exactly as given:
        inj climate <temp> <rh>   inj climate invalid   inj pir 0|1
        inj sos   inj motion   stop   ack <alarmId>   reset   pause   resume
  * prints a final summary: lines captured, bytes, every command with send time.

Install note: this machine has pyserial 3.5 at
  D:\\Espressif-5.1.6\\python_env\\idf5.1_py3.11_env\\Scripts\\python.exe
(the previously assumed ...\\idf5.1_py3.11_env\\python.exe does not exist).

Usage
  python bench-serial.py --list-ports
  python bench-serial.py --selftest
  python bench-serial.py --scenario tools/bench-scenario.example.json --print-plan
  python bench-serial.py --com COM4 --scenario tools/bench-scenario.example.json
  python bench-serial.py --com COM4 --send-line "inj climate 35.0 80" --seconds 20
  python bench-serial.py --com COM4 --scenario s.json --out verify/serial-COM4.log

Scenario JSON
  {"durationSec": 60,
   "steps": [{"atSec": 2, "send": "inj climate 35.0 80"},
             {"atSec": 5, "send": "stop"},
             {"atSec": 8, "send": "ack ALARM-123"}]}

Exit codes: 0 = OK; 2 = usage/scenario/open error; 1 = runtime error.
"""
from __future__ import annotations

import argparse
import codecs
import datetime as _dt
import json
import re
import sys
import time
from pathlib import Path

try:
    import serial
    from serial.tools import list_ports
except ImportError:  # pragma: no cover
    sys.stderr.write("ERROR: pyserial not importable in this interpreter: %s\n" % sys.executable)
    sys.exit(2)

TOOLS_DIR = Path(__file__).resolve().parent
EVIDENCE_DIR = TOOLS_DIR.parent
DEFAULT_BAUD = 115200

# ANSI CSI / OSC / single-char escapes, then remaining C0 control bytes (keep TAB).
ANSI_RE = re.compile(
    r"\x1b\[[0-9;?]*[ -/]*[@-~]"          # CSI ... final byte
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC ... BEL / ST
    r"|\x1b[@-Z\\-_]"                      # other ESC sequences
)
CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# Serial markers the Lead wants to see in the captured log.
EXPECTED_MARKERS = [
    "BENCH INJECT MODE",
    "PLAY clip=",
    "STOP result=",
    "ACK 已接受并生效",
    "STOP 已接受并生效",
    "重复提醒",
    "异常解除 -> NORMAL",
    "INJ ",
    "→ {",
]


def strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences and stray control bytes from a console line."""
    return CTRL_RE.sub("", ANSI_RE.sub("", text))


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def fmt_elapsed(seconds: float) -> str:
    return "+%012.3fs" % seconds


def norm_com(value: str) -> str:
    v = value.strip()
    if re.fullmatch(r"\d+", v):
        return "COM" + v
    return v.upper()


class LineMuxer:
    """Incrementally decode bytes -> text -> newline-delimited lines (UTF-8 tolerant)."""

    def __init__(self, max_buffer: int = 1 << 20) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._buf = ""
        self.max_buffer = max_buffer

    def feed(self, data: bytes) -> list[str]:
        self._buf += self._decoder.decode(data, final=False)
        out: list[str] = []
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            out.append(line.rstrip("\r"))
        if len(self._buf) > self.max_buffer:
            out.append("[bench-serial] WARN dropped an overlong partial line (%d chars)" % len(self._buf))
            self._buf = ""
        return out

    def flush(self) -> list[str]:
        self._buf += self._decoder.decode(b"", final=True)
        if not self._buf:
            return []
        rest, self._buf = self._buf, ""
        return [rest.rstrip("\r")]


class Scenario:
    """Validated, time-ordered command schedule; catches up on late steps."""

    def __init__(self, steps: list[dict], duration: float | None, source: str = "<inline>") -> None:
        self.steps = sorted(steps, key=lambda s: s["atSec"])
        self.duration = duration
        self.source = source
        self._next = 0
        self.sent: list[dict] = []

    @classmethod
    def from_file(cls, path: str) -> "Scenario":
        p = Path(path)
        try:
            raw = p.read_text(encoding="utf-8-sig")
        except OSError as exc:
            raise ValueError("cannot read scenario %s: %s" % (path, exc)) from exc
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("scenario is not valid JSON: %s" % exc) from exc
        if not isinstance(data, dict):
            raise ValueError("scenario root must be an object")
        duration = data.get("durationSec")
        if duration is not None:
            if not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration < 0:
                raise ValueError("durationSec must be a number >= 0")
            duration = float(duration)
        raw_steps = data.get("steps", [])
        if not isinstance(raw_steps, list):
            raise ValueError("steps must be a list")
        steps: list[dict] = []
        for i, st in enumerate(raw_steps):
            if not isinstance(st, dict):
                raise ValueError("steps[%d] must be an object" % i)
            if "atSec" not in st:
                raise ValueError("steps[%d] missing atSec" % i)
            at = st["atSec"]
            if not isinstance(at, (int, float)) or isinstance(at, bool) or at < 0:
                raise ValueError("steps[%d].atSec must be a number >= 0" % i)
            send = st.get("send", st.get("cmd"))
            if not isinstance(send, str) or not send.strip():
                raise ValueError("steps[%d].send must be a non-empty string" % i)
            if "\n" in send or "\r" in send:
                raise ValueError("steps[%d].send must be a single line" % i)
            steps.append({"atSec": float(at), "send": send})
        return cls(steps, duration, source=str(p))

    @classmethod
    def from_send_lines(cls, lines: list[str], duration: float | None) -> "Scenario":
        steps = []
        for i, s in enumerate(lines):
            if not isinstance(s, str) or not s.strip():
                raise ValueError("--send-line #%d is empty" % (i + 1))
            if "\n" in s or "\r" in s:
                raise ValueError("--send-line #%d must be a single line" % (i + 1))
            steps.append({"atSec": 0.0, "send": s})
        return cls(steps, duration, source="--send-line")

    def due(self, elapsed: float) -> list[dict]:
        due: list[dict] = []
        while self._next < len(self.steps) and self.steps[self._next]["atSec"] <= elapsed:
            due.append(self.steps[self._next])
            self._next += 1
        return due

    def remaining(self) -> int:
        return len(self.steps) - self._next


def write_due_commands(port, scenario: Scenario, elapsed: float, ctx: dict | None = None) -> list[dict]:
    """Write each due command as exactly one line; return send records. No other writes.

    Dynamic token: a command containing {lastAlarm} is resolved to the most recent
    alarm id observed on the serial log (so scenarios do not hardcode runtime ids).
    """
    records = []
    for step in scenario.due(elapsed):
        cmd = step["send"]
        resolved = cmd
        if "{lastAlarm}" in cmd or "{lastAlarmId}" in cmd:
            last = (ctx or {}).get("lastAlarm", "")
            if not last:
                # Not observed yet: defer this step by putting it back is complex;
                # fail loudly instead of sending a literal placeholder.
                rec = {
                    "atSec": step["atSec"],
                    "send": cmd,
                    "sendElapsedSec": round(elapsed, 3),
                    "wall": now_iso(),
                    "ok": False,
                    "error": "no alarm id observed yet for {lastAlarm}",
                }
                scenario.sent.append(rec)
                records.append(rec)
                continue
            resolved = cmd.replace("{lastAlarmId}", last).replace("{lastAlarm}", last)
        payload = (resolved + "\n").encode("utf-8")
        try:
            port.write(payload)
            ok = True
            err = ""
        except Exception as exc:  # serial.SerialException / timeout
            ok = False
            err = str(exc)
        rec = {
            "atSec": step["atSec"],
            "send": resolved,
            "template": cmd if resolved != cmd else "",
            "sendElapsedSec": round(elapsed, 3),
            "wall": now_iso(),
            "ok": ok,
            "error": err,
        }
        scenario.sent.append(rec)
        records.append(rec)
    return records


# ---------------------------------------------------------------- selftest
class FakePort:
    def __init__(self) -> None:
        self.writes: list[bytes] = []

    def write(self, data: bytes) -> int:
        self.writes.append(data)
        return len(data)


def run_selftest() -> int:
    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, bool(ok), detail))
        print("CHECK %s %s%s" % ("PASS" if ok else "FAIL", name, (" :: " + detail) if detail else ""))

    # 1) ANSI stripping
    raw = "\x1b[0;32mI (1234) bench: \x1b[0mBENCH INJECT MODE\x1b[K \x1b[31mred\x1b[0m"
    check("ansi-strip", strip_ansi(raw) == "I (1234) bench: BENCH INJECT MODE red", repr(strip_ansi(raw)))
    check("ansi-osc-strip", strip_ansi("a\x1b]0;title\x07b") == "ab", repr(strip_ansi("a\x1b]0;title\x07b")))
    check("control-bytes-strip", strip_ansi("a\x00\x01\x07b\x08") == "ab", repr(strip_ansi("a\x00\x01\x07b\x08")))

    # 2) UTF-8 Chinese survives; split mid-multibyte across feeds
    marker = "ACK 已接受并生效：id=ALM-1"
    payload = ("\x1b[0m" + marker + "\x1b[0m\n").encode("utf-8")
    mux = LineMuxer()
    got: list[str] = []
    for i in range(0, len(payload), 3):
        got.extend(mux.feed(payload[i:i + 3]))
    got.extend(mux.flush())
    check("utf8-split-chinese", got == ["\x1b[0m" + marker + "\x1b[0m"] and strip_ansi(got[0]) == marker, repr(got))

    # 3) non-UTF8 bytes tolerated (no crash, replacement char)
    mux2 = LineMuxer()
    lines = mux2.feed(b"bad=\xff\xfe\x00 ok\n")
    check("invalid-bytes-tolerated", len(lines) == 1 and "bad=" in lines[0] and "\ufffd" in lines[0], repr(lines))

    # 4) CRLF and partial-line flush
    mux3 = LineMuxer()
    check("crlf", mux3.feed(b"line1\r\nline2\r\n") == ["line1", "line2"], repr(mux3.feed(b"")))
    mux4 = LineMuxer()
    first = mux4.feed(b"partial-no-newline")
    rest = mux4.flush()
    check("partial-flush", first == [] and rest == ["partial-no-newline"], repr(first + rest))

    # 5) scenario validation + scheduling
    import tempfile
    good = {
        "durationSec": 60,
        "steps": [
            {"atSec": 5, "send": "stop"},
            {"atSec": 2, "send": "inj climate 35.0 80"},
            {"atSec": 2.5, "send": "inj pir 1"},
        ],
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump(good, fh, ensure_ascii=False)
        good_path = fh.name
    try:
        sc = Scenario.from_file(good_path)
        check("scenario-duration", sc.duration == 60.0, str(sc.duration))
        check("scenario-sorted", [s["send"] for s in sc.steps] ==
              ["inj climate 35.0 80", "inj pir 1", "stop"], repr([s["send"] for s in sc.steps]))
        fake = FakePort()
        check("scenario-not-due-early", write_due_commands(fake, sc, 1.999) == [] and fake.writes == [], repr(fake.writes))
        recs = write_due_commands(fake, sc, 2.5)
        check("scenario-due-exact", [r["send"] for r in recs] == ["inj climate 35.0 80", "inj pir 1"],
              repr([r["send"] for r in recs]))
        check("commands-write-exact-bytes", fake.writes ==
              [b"inj climate 35.0 80\n", b"inj pir 1\n"], repr(fake.writes))
        recs2 = write_due_commands(fake, sc, 100.0)
        check("scenario-catch-up", [r["send"] for r in recs2] == ["stop"], repr([r["send"] for r in recs2]))
        check("no-extra-writes", len(fake.writes) == 3, repr(fake.writes))
    finally:
        try:
            Path(good_path).unlink()
        except OSError:
            pass

    invalid = [
        ("not-json", "{"),
        ("steps-not-list", {"durationSec": 5, "steps": {}}),
        ("negative-at", {"durationSec": 5, "steps": [{"atSec": -1, "send": "stop"}]}),
        ("missing-send", {"durationSec": 5, "steps": [{"atSec": 1}]}),
        ("multiline-send", {"durationSec": 5, "steps": [{"atSec": 1, "send": "a\nb"}]}),
        ("bad-duration", {"durationSec": "x", "steps": []}),
    ]
    for name, content in invalid:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            if isinstance(content, str):
                fh.write(content)
            else:
                json.dump(content, fh)
            bad_path = fh.name
        try:
            Scenario.from_file(bad_path)
            check("reject-" + name, False, "accepted invalid scenario")
        except ValueError:
            check("reject-" + name, True)
        finally:
            try:
                Path(bad_path).unlink()
            except OSError:
                pass

    # 6) DTR/RTS released at construction time (no port opened here)
    ser = make_serial("COM99", DEFAULT_BAUD)
    check("dtr-released-preopen", ser.dtr is False, repr(ser.dtr))
    check("rts-released-preopen", ser.rts is False, repr(ser.rts))
    check("never-touches-dtr-after-open", re.search(r"ser\.(dtr|rts)\s*=", _OPEN_PATH_SOURCE) is None,
          "main() only reads dtr/rts state")

    failed = [c for c in checks if not c[1]]
    print("BENCH_SERIAL SELFTEST %s %d/%d checks passed" %
          ("PASS" if not failed else "FAIL", len(checks) - len(failed), len(checks)))
    for name, _ok, detail in failed:
        print("  FAILED %s :: %s" % (name, detail))
    return 0 if not failed else 1


def make_serial(com: str, baud: int):
    """Build a closed pyserial object with DTR/RTS released BEFORE open()."""
    ser = serial.Serial()
    ser.port = com
    ser.baudrate = baud
    ser.bytesize = serial.EIGHTBITS
    ser.parity = serial.PARITY_NONE
    ser.stopbits = serial.STOPBITS_ONE
    ser.timeout = 0.05
    ser.write_timeout = 1
    ser.xonxoff = False
    ser.rtscts = False
    ser.dsrdtr = False
    ser.dtr = False  # released: board resets only on the normal open pulse
    ser.rts = False
    return ser


# Source snippet guard used only by the selftest: the open path must never assert DTR/RTS.
_OPEN_PATH_SOURCE = Path(__file__).read_text(encoding="utf-8").split("def main(")[-1]


# ---------------------------------------------------------------- main
def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser(
        description="ESP32 bench serial harness: timed command injection + ANSI-free capture",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Exit codes: 0=OK, 2=usage/scenario/open error, 1=runtime error.",
    )
    ap.add_argument("--com", help="COM port, e.g. COM4 (or 4)")
    ap.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    ap.add_argument("--scenario", help="scenario JSON file ({durationSec, steps:[{atSec, send}]})")
    ap.add_argument("--send-line", action="append", default=[], metavar="LINE",
                    help="send this exact command line immediately after opening (repeatable)")
    ap.add_argument("--seconds", type=float, default=0,
                    help="capture duration override; 0 = scenario durationSec, else until Ctrl+C")
    ap.add_argument("--out", help="log file (default <evidence>/verify/serial-<COM>-<ts>.log)")
    ap.add_argument("--list-ports", action="store_true", help="list COM ports and exit")
    ap.add_argument("--print-plan", action="store_true",
                    help="validate scenario/send-line and print the command plan, then exit (no port)")
    ap.add_argument("--selftest", action="store_true",
                    help="offline self-test (ANSI stripper, UTF-8, scenario parser, command writes); no port")
    args = ap.parse_args()

    if args.selftest:
        return run_selftest()

    if args.print_plan:
        try:
            scenario = Scenario.from_file(args.scenario) if args.scenario else Scenario([], None)
            if args.send_line:
                manual = Scenario.from_send_lines(args.send_line, None)
                scenario.steps.extend(manual.steps)
                scenario.steps.sort(key=lambda s: s["atSec"])
                scenario.source += " + --send-line"
        except ValueError as exc:
            sys.stderr.write("ERROR: %s\n" % exc)
            return 2
        print("BENCH_SERIAL plan source=%s duration=%s steps=%d" % (
            scenario.source, ("%gs" % scenario.duration) if scenario.duration else "until Ctrl+C",
            len(scenario.steps)))
        for i, step in enumerate(scenario.steps, 1):
            print("  %2d atSec=%g send=%s" % (i, step["atSec"], step["send"]))
        print("BENCH_SERIAL plan OK (no port opened)")
        return 0

    if args.list_ports:
        ports = sorted(list_ports.comports(), key=lambda p: p.device)
        print("BENCH_SERIAL list-ports via pyserial %s" % serial.__version__)
        for p in ports:
            print("  %-6s %s" % (p.device, p.description or ""))
        if not ports:
            print("  (no COM ports detected)")
        print("BENCH_SERIAL list-ports OK (no port opened, DTR/RTS untouched)")
        return 0

    if not args.com:
        sys.stderr.write("ERROR: --com is required (or use --list-ports / --selftest)\n")
        return 2

    com = norm_com(args.com)
    try:
        scenario = Scenario.from_file(args.scenario) if args.scenario else Scenario([], None)
        if args.send_line:
            manual = Scenario.from_send_lines(args.send_line, None)
            scenario.steps.extend(manual.steps)
            scenario.steps.sort(key=lambda s: s["atSec"])
            scenario.source += " + --send-line"
        duration = scenario.duration
        if args.seconds and args.seconds > 0:
            duration = float(args.seconds)
    except ValueError as exc:
        sys.stderr.write("ERROR: %s\n" % exc)
        return 2

    out = Path(args.out) if args.out else EVIDENCE_DIR / "verify" / (
        "serial-%s-%s.log" % (re.sub(r"[^A-Za-z0-9]", "", com), time.strftime("%Y%m%d-%H%M%S")))
    out.parent.mkdir(parents=True, exist_ok=True)

    ser = make_serial(com, args.baud)
    try:
        ser.open()
    except Exception as exc:
        sys.stderr.write("ERROR: failed to open %s: %s\n" % (com, exc))
        ports = [p.device for p in list_ports.comports()]
        if ports:
            sys.stderr.write("Available ports: %s\n" % ", ".join(sorted(ports)))
        return 2

    log = out.open("w", encoding="utf-8", errors="replace")
    started = time.monotonic()
    lines = 0
    nbytes = 0
    markers: dict[str, int] = {m: 0 for m in EXPECTED_MARKERS}
    mux = LineMuxer()
    ctx: dict = {"lastAlarm": ""}
    alarm_re = re.compile(r"e-\d{1,16}-\d{1,6}")
    fatal = ""

    def emit(text: str) -> None:
        wall = now_iso()
        entry = "[%s] [%s] %s" % (fmt_elapsed(time.monotonic() - started), wall, text)
        log.write(entry + "\n")
        log.flush()
        print(entry, flush=True)

    try:
        print("BENCH_SERIAL OPEN com=%s baud=%d dtr=%s rts=%s handshake=None" % (com, args.baud, ser.dtr, ser.rts))
        print("BENCH_SERIAL log=%s" % out)
        print("BENCH_SERIAL duration=%s scenario=%s steps=%d" % (
            ("%gs" % duration) if duration else "until Ctrl+C", scenario.source, len(scenario.steps)))
        log.write("# bench-serial.py start %s\n" % now_iso())
        log.write("# com=%s baud=%d dtr=%s rts=%s log=%s\n" % (com, args.baud, ser.dtr, ser.rts, out))
        for step in scenario.steps:
            log.write("# plan atSec=%g send=%s\n" % (step["atSec"], step["send"]))
        log.flush()
        for step in scenario.steps:
            print("BENCH_SERIAL plan atSec=%g send=%s" % (step["atSec"], step["send"]))

        while True:
            elapsed = time.monotonic() - started
            if duration and elapsed >= duration:
                break
            try:
                data = ser.read(4096)
            except Exception as exc:
                fatal = "serial read failed: %s" % exc
                break
            if data:
                nbytes += len(data)
                for line in mux.feed(data):
                    lines += 1
                    visible = strip_ansi(line)
                    for m in markers:
                        if m in visible:
                            markers[m] += 1
                    if "-> ALARM" in visible:
                        m = alarm_re.search(visible)
                        if m and m.group(0) != ctx["lastAlarm"]:
                            ctx["lastAlarm"] = m.group(0)
                            print("BENCH_SERIAL LAST_ALARM id=%s" % ctx["lastAlarm"], flush=True)
                    emit(visible)
            for rec in write_due_commands(ser, scenario, elapsed, ctx):
                if rec["ok"]:
                    emit("SEND -> %s (atSec=%g, elapsed=%.3fs)" % (rec["send"], rec["atSec"], rec["sendElapsedSec"]))
                else:
                    emit("SEND FAILED -> %s: %s" % (rec["send"], rec["error"]))
    except KeyboardInterrupt:
        fatal = ""
    except Exception as exc:  # defensive: never crash without a summary
        fatal = "unexpected error: %s" % exc
    finally:
        try:
            for line in mux.flush():
                lines += 1
                emit(strip_ansi(line))
        except Exception:
            pass
        try:
            if ser.is_open:
                ser.close()
        except Exception:
            pass
        duration_s = time.monotonic() - started
        hit = ", ".join("%s=%d" % (m, n) for m, n in markers.items() if n)
        print("BENCH_SERIAL SUMMARY lines=%d bytes=%d sent=%d duration=%.3fs markers={%s} log=%s" % (
            lines, nbytes, len(scenario.sent), duration_s, hit, out))
        log.write("# BENCH_SERIAL SUMMARY lines=%d bytes=%d sent=%d duration=%.3fs markers={%s}\n" % (
            lines, nbytes, len(scenario.sent), duration_s, hit))
        for i, rec in enumerate(scenario.sent, 1):
            detail = "SENT #%d at=%.3fs wall=%s ok=%s line=%r" % (
                i, rec["sendElapsedSec"], rec["wall"], rec["ok"], rec["send"])
            print("BENCH_SERIAL " + detail)
            log.write("# BENCH_SERIAL " + detail + "\n")
        log.close()
        if fatal:
            sys.stderr.write("ERROR: %s\n" % fatal)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
