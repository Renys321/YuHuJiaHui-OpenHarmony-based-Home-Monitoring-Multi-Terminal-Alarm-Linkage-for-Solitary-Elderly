#!/usr/bin/env python3
"""serial-capture.py — optional pyserial variant of serial-capture.ps1.

Same contract: open an ESP32 serial console WITHOUT toggling DTR/RTS, log every
line with a local wall-clock timestamp, stop after --seconds or Ctrl+C, print a
summary.  Dependency: pyserial (available in the ESP-IDF env).

python:  D:\\Espressif-5.1.6\\python_env\\idf5.1_py3.11_env\\Scripts\\python.exe
         (pyserial 3.5 importable; the previously assumed ...\\idf5.1_py3.11_env\\python.exe
          does not exist on this machine)

Usage:
  python serial-capture.py --list
  python serial-capture.py --com COM4 --seconds 120
  python serial-capture.py --com COM5 --seconds 0 --baud 115200 --out D:\\...\\verify\\serial-COM5.log
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
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


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def norm_com(value: str) -> str:
    v = value.strip()
    if re.fullmatch(r"\d+", v):
        return "COM" + v
    return v.upper()


def main() -> int:
    ap = argparse.ArgumentParser(description="ESP32 serial capture without DTR/RTS auto-reset")
    ap.add_argument("--com", help="COM port, e.g. COM4 (or 4)")
    ap.add_argument("--seconds", type=int, default=0, help="capture duration; 0 = until Ctrl+C")
    ap.add_argument("--out", help="log path (default <evidence>/verify/serial-<COM>-<ts>.log)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--list", action="store_true", help="list COM ports and exit")
    ap.add_argument("--assert-dtr-rts", action="store_true", help="assert DTR/RTS (will reset the board)")
    args = ap.parse_args()

    if args.list:
        ports = sorted(list_ports.comports(), key=lambda p: p.device)
        print("SERIAL_CAPTURE list-ports via pyserial %s" % serial.__version__)
        if not ports:
            print("  (no COM ports detected)")
        for p in ports:
            print("  %-6s %s" % (p.device, p.description or ""))
        print("SERIAL_CAPTURE list-ports OK (no port opened, DTR/RTS untouched)")
        return 0

    if not args.com:
        sys.stderr.write("ERROR: --com is required (or use --list)\n")
        return 2

    com = norm_com(args.com)
    out = Path(args.out) if args.out else EVIDENCE_DIR / "verify" / (
        "serial-%s-%s.log" % (re.sub(r"[^A-Za-z0-9]", "", com), time.strftime("%Y%m%d-%H%M%S"))
    )
    out.parent.mkdir(parents=True, exist_ok=True)

    ser = serial.Serial()
    ser.port = com
    ser.baudrate = args.baud
    ser.bytesize = serial.EIGHTBITS
    ser.parity = serial.PARITY_NONE
    ser.stopbits = serial.STOPBITS_ONE
    ser.timeout = 0.05
    ser.write_timeout = 1
    ser.xonxoff = False
    ser.rtscts = False
    ser.dsrdtr = False
    # Deassert DTR/RTS before open() so the ESP32 auto-reset circuit is not triggered.
    ser.dtr = bool(args.assert_dtr_rts)
    ser.rts = bool(args.assert_dtr_rts)
    try:
        ser.open()
    except Exception as exc:  # serial.SerialException and friends
        sys.stderr.write("ERROR: failed to open %s: %s\n" % (com, exc))
        ports = [p.device for p in list_ports.comports()]
        if ports:
            sys.stderr.write("Available ports: %s\n" % ", ".join(sorted(ports)))
        return 2

    started = time.monotonic()
    lines = 0
    nbytes = 0
    buf = ""
    try:
        print("SERIAL_CAPTURE start com=%s baud=%d dtr=%s rts=%s" % (com, args.baud, ser.dtr, ser.rts))
        print("SERIAL_CAPTURE log=%s" % out)
        print("SERIAL_CAPTURE duration=%s" % ("%ds" % args.seconds if args.seconds > 0 else "until Ctrl+C"))
        with out.open("a", encoding="utf-8") as fh:
            def emit(line: str) -> None:
                nonlocal lines
                lines += 1
                entry = "[%s] %s" % (now_iso(), line.rstrip("\r"))
                fh.write(entry + "\n")
                fh.flush()
                print(entry)

            fh.write("# serial-capture.py %s\n" % now_iso())
            fh.write("# com=%s baud=%d dtr=%s rts=%s\n" % (com, args.baud, ser.dtr, ser.rts))
            fh.flush()
            while True:
                if args.seconds > 0 and time.monotonic() - started >= args.seconds:
                    break
                data = ser.read(4096)
                if data:
                    nbytes += len(data)
                    buf += data.decode("utf-8", "replace")
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        emit(line)
                else:
                    time.sleep(0.03)
            if buf:
                emit(buf)
                buf = ""
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if ser.is_open:
                ser.close()
        except Exception:
            pass
        summary = "SERIAL_CAPTURE stop com=%s lines=%d bytes=%d duration=%.3fs log=%s" % (
            com, lines, nbytes, time.monotonic() - started, out)
        print(summary)
        try:
            with out.open("a", encoding="utf-8") as fh:
                fh.write("# %s\n" % summary)
        except Exception:
            pass
        if lines == 0:
            sys.stderr.write("WARN: no lines captured; check wiring, baud (%d), board power\n" % args.baud)
    return 0


if __name__ == "__main__":
    sys.exit(main())
