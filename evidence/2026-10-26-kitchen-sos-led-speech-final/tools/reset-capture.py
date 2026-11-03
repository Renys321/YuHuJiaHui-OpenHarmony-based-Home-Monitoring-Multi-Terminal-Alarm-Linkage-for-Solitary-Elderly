"""Reset one ESP32 board via the CH340 auto-reset lines and capture the full boot log.

Why: opening the port alone no longer resets the board (DTR/RTS are released before
open), so a deliberate RTS->EN pulse is used, keeping the port open so the very first
boot lines are captured. Read-only apart from the reset pulse; no flash write.

Usage: python reset-capture.py --com COM4 --seconds 24 --out verify/x.log
"""
import argparse
import re
import sys
import time
from pathlib import Path

import serial

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[@-_]")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--com", required=True)
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=24.0)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    ser = serial.Serial()
    ser.port = args.com
    ser.baudrate = args.baud
    ser.timeout = 0.2
    ser.dtr = False
    ser.rts = False
    ser.open()
    started = time.monotonic()
    log = out.open("w", encoding="utf-8", errors="replace")
    try:
        # ESP32 auto-reset circuit: RTS -> EN. Pulse EN low, release, board boots.
        ser.dtr = False
        ser.rts = True
        time.sleep(0.15)
        ser.rts = False
        time.sleep(0.05)
        line = b""
        while time.monotonic() - started < args.seconds:
            chunk = ser.read(4096)
            if not chunk:
                continue
            for b in chunk:
                if b == 0x0A:
                    text = ANSI.sub("", line.decode("utf-8", "replace")).strip()
                    line = b""
                    if text:
                        ts = time.monotonic() - started
                        entry = "[+%08.3fs] %s" % (ts, text)
                        log.write(entry + "\n")
                        log.flush()
                        print(entry, flush=True)
                elif b != 0x0D:
                    line += bytes([b])
    finally:
        try:
            ser.close()
        finally:
            log.close()
    print("RESET_CAPTURE_DONE com=%s seconds=%s out=%s" % (args.com, args.seconds, out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
