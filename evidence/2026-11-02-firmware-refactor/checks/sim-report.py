#!/usr/bin/env python3
"""Build sample status frames from the exact format strings in the firmware
sources and validate that they are complete JSON lines."""
import json
import re
import os
import sys

NEW = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'firmware', 'common', 'components', 'elder_node')
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'baseline', 'firmware', 'common', 'components', 'elder_node')


def read(path):
    return open(path, encoding="utf-8").read()


LIT = re.compile(r'\s*("(?:\\.|[^"\\])*")')


def extract_format(text, anchor):
    """Concatenate only the run of adjacent C string literals that forms the
    format string. Stops at the first token that is not another literal, so
    argument literals like "true"/"false" are not swallowed."""
    i = text.index(anchor)
    pos = i
    parts = []
    while True:
        m = LIT.match(text, pos)
        if not m:
            break
        parts.append(json.loads(m.group(1)))
        pos = m.end()
    assert parts, "no format literals found at anchor"
    return "".join(parts)


report_fmt = extract_format(read(NEW + r"\node_main.c"), '"{\\"deviceId\\"')
base_report_fmt = extract_format(read(BASE + r"\node_main.c"), '"{\\"deviceId\\"')
assert report_fmt == base_report_fmt, "report format string changed"
assert report_fmt.endswith("\n"), "status frame must end with newline"

def extract_format_after(text, marker):
    """Find `marker`, then start at the next double quote (the opening quote of
    the format literal) and return the adjacent-literal run."""
    i = text.index(marker)
    i = text.index('"', i + len(marker))
    return extract_format(text[i:], '"')


def pyfmt(s):
    """C's %lld has no Python equivalent; values fit in a Python int."""
    return s.replace("%lld", "%d")


ntext = read(NEW + r"\node_main.c")
btext = read(BASE + r"\node_main.c")

door_fmt = extract_format(read(NEW + r"\door_monitor.c"), '"\\"door\\"')
base_door_fmt = extract_format(btext[btext.index("static void report"):], '"\\"door\\"')
assert door_fmt == base_door_fmt, "door format string changed"

event_fmt = extract_format(read(NEW + r"\door_monitor.c"), '"%s{\\"seq\\"')
base_event_fmt = extract_format(btext[btext.index("static void report"):], '"%s{\\"seq\\"')
assert event_fmt == base_event_fmt, "door event format string changed"

water_fmt = extract_format_after(ntext, "snprintf(water_json")
base_water_fmt = extract_format_after(btext, "snprintf(water_json")
assert water_fmt == base_water_fmt, "water format string changed"

battery_fmt = extract_format_after(ntext, "snprintf(battery_json")
base_battery_fmt = extract_format_after(btext, "snprintf(battery_json")
assert battery_fmt == base_battery_fmt, "battery format string changed"


def door_json(open_state, last_open, last_close, seq, events=None):
    s = pyfmt(door_fmt) % (open_state, last_open, last_close, seq)
    if events:
        s += ',"events":['
        s += "".join(pyfmt(event_fmt) % (("," if i > 0 else ""), e[0], e[1], e[2])
                     for i, e in enumerate(events))
        s += "]"
    return s + "},"


def water_json(wet, valid):
    return pyfmt(water_fmt) % ("true" if wet else "false",
                               "true" if valid else "false")


def battery_json(present, valid, mv, percent, low, calibrated, reason):
    return pyfmt(battery_fmt) % (
        "true" if present else "false",
        "true" if valid else "false",
        "null" if mv is None else mv,
        "null" if percent is None else percent,
        "true" if low else "false",
        "true" if calibrated else "false",
        reason)


def frame(device, room, state, last_ts, count, door, temp, rh, ok, valid,
          gas, gas_ok, smoke, smoke_ok, water="", battery="", alarm_id="", alarm_type="", alarm_count=0):
    return pyfmt(report_fmt) % (
        device, room, 1762000000000, state,
        last_ts, count,
        door,
        temp, rh, ok, valid,
        gas, gas_ok, valid,
        smoke, smoke_ok, valid,
        water,
        count,
        alarm_id, alarm_type, alarm_count,
        battery,
    )


cases = []
# kitchen: door enabled, no water/battery, normal
cases.append(("kitchen normal", frame(
    "esp32-kitchen", "厨房", "NORMAL", 1761999999000, 12,
    door_json("false", 1761999000000, 1761999999000, 4,
              [(3, "true", 1761998500000), (4, "false", 1761999999000)]),
    26.5, 55.0, "false", "true", 320, "true", 180, "true")))
# kitchen: baseline not established -> open null
cases.append(("kitchen baseline unknown", frame(
    "esp32-kitchen", "厨房", "NORMAL", 0, 0,
    door_json("null", 0, 0, 0), 26.5, 55.0, "false", "true",
    320, "true", 180, "true")))
# kitchen: SOS alarm
cases.append(("kitchen SOS", frame(
    "esp32-kitchen", "厨房", "ALARM", 1761999999000, 3,
    door_json("false", 0, 1761999000000, 1),
    26.5, 55.0, "false", "true", 320, "true", 180, "true",
    alarm_id="e-1762000000-1", alarm_type="MANUAL_SOS", alarm_count=1)))
# bathroom: water segment enabled
cases.append(("bathroom water", frame(
    "esp32-bath", "卫生间", "NORMAL", 1761999999000, 7,
    door_json("true", 1761999999000, 1761998000000, 2),
    24.0, 60.0, "false", "true", 0, "false", 0, "false",
    water=water_json(False, True))))
# synthetic battery: valid and invalid
cases.append(("battery valid", frame(
    "esp32-sos", "随身", "NORMAL", 0, 0, door_json("false", 0, 0, 0),
    25.0, 50.0, "false", "false", 0, "false", 0, "false",
    battery=battery_json(True, True, 4012, 80, False, True, ""))))
cases.append(("battery invalid", frame(
    "esp32-sos", "随身", "NORMAL", 0, 0, door_json("false", 0, 0, 0),
    25.0, 50.0, "false", "false", 0, "false", 0, "false",
    battery=battery_json(False, False, None, None, False, False, "UNSTABLE"))))

for name, raw in cases:
    assert raw.endswith("\n")
    obj = json.loads(raw)
    assert obj["deviceId"] and obj["room"]
    assert isinstance(obj["ts"], int) and isinstance(obj["sensors"], dict)
    assert "motion" in obj["sensors"] and "door" in obj["sensors"]
    assert len(obj["history"]) == 7 and len(obj["slots"]) == 4
    assert "alarm" in obj
    print("PASS %-24s bytes=%d door.open=%s" % (name, len(raw), obj["sensors"]["door"]["open"]))
print("report format identical to baseline; %d frames parsed" % len(cases))
