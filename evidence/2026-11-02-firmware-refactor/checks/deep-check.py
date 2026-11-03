#!/usr/bin/env python3
"""Deep equivalence check for the elder_node firmware refactor.

Compares the pre-refactor baseline (single node_main.c + headers) against the
current split modules at token level, ignoring comments/whitespace, and checks
string literals and #define values globally.
"""
import os
import re
import sys
from collections import Counter

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'baseline', 'firmware', 'common', 'components', 'elder_node')
NEW = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'firmware', 'common', 'components', 'elder_node')

TOKEN_RE = re.compile(r'''
    (?P<ws>\s+)
  | (?P<line>//[^\n]*)
  | (?P<block>/\*.*?\*/)
  | (?P<str>"(?:\\.|[^"\\])*")
  | (?P<chr>'(?:\\.|[^'\\])*')
  | (?P<id>[A-Za-z_]\w*)
  | (?P<num>\.?\d(?:[eEpP][+-]|[\w.])*)
  | (?P<op>\#\#|[^\sA-Za-z_0-9])
''', re.S | re.X)

DEF_RE = re.compile(r'(?m)^(?:static\s+)?[A-Za-z_][\w \t\*]*?\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{')

# old name -> new name (canonical, applied to both token streams)
RENAMES = {
    'ai_key_handle': 'board_ai_key_tick',
    'buzzer': 'board_buzzer',
    'xl9555_beep': 'board_buzzer',
    'gpio_start': 'board_gpio_start',
    'time_sync_start': 'wifi_time_sync_start',
    'xl9555_beep_init': 'beep_init',
    'xl9555_key0_init': 'key0_init',
    'xl9555_read_ports': 'board_xl9555_read_ports',
    'xl9555_read_reg': 'board_xl9555_read',
    'xl9555_write_reg': 'board_xl9555_write',
    'now_ms': 'node_now_ms',
}


def strip_comments(text):
    return TOKEN_RE.sub(lambda m: '' if m.lastgroup in ('line', 'block') else m.group(), text)


def parse_funcs(text):
    out = {}
    for m in DEF_RE.finditer(text):
        name = m.group(1)
        i = m.end() - 1
        depth = 0
        while i < len(text):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            i += 1
        if name not in out:
            out[name] = text[m.end():i - 1]
    return out


def toks(text):
    out = []
    for m in TOKEN_RE.finditer(text):
        kind = m.lastgroup
        if kind in ('ws', 'line', 'block'):
            continue
        val = m.group()
        if kind == 'id':
            val = RENAMES.get(val, val)
        out.append(val)
    return out


def read(path):
    return open(path, encoding='utf-8').read()


def main():
    base_text = read(os.path.join(BASE, 'node_main.c'))
    base_funcs = parse_funcs(base_text)
    new_funcs = {}
    for fn in sorted(os.listdir(NEW)):
        if fn.endswith('.c'):
            for k, v in parse_funcs(read(os.path.join(NEW, fn))).items():
                new_funcs.setdefault(k, (fn, v))

    same = 0
    diffs = []
    only_base = []
    # functions intentionally split/merged
    skip = {'sensors_start'}
    for old, body in sorted(base_funcs.items()):
        if old in skip:
            continue
        newname = RENAMES.get(old, old)
        if newname not in new_funcs:
            only_base.append(old)
            continue
        fn, nbody = new_funcs[newname]
        a, b = toks(body), toks(nbody)
        if a == b:
            same += 1
        else:
            i = next((j for j, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            diffs.append((old, newname, fn, a, b, i))

    print('== function bodies (comments/whitespace ignored) ==')
    print('identical: %d, differing: %d, no counterpart: %d' % (same, len(diffs), len(only_base)))
    if only_base:
        print('no counterpart:', ', '.join(only_base))
    for old, newname, fn, a, b, i in diffs:
        lo = max(0, i - 6)
        print('\n[DIFF] %s -> %s (%s) tokens old=%d new=%d first=%d' % (old, newname, fn, len(a), len(b), i))
        print('  old: ...', ' '.join(a[lo:i + 6]))
        print('  new: ...', ' '.join(b[lo:i + 6]))

    # ---- global string literals (all source files, comments stripped) ----
    def all_strings(root, header_too=True):
        c = Counter()
        for fn in os.listdir(root):
            if fn.endswith('.c') or (header_too and fn.endswith('.h')):
                text = strip_comments(read(os.path.join(root, fn)))
                for m in TOKEN_RE.finditer(text):
                    if m.lastgroup == 'str':
                        c[m.group()] += 1
        return c

    bs, ns = all_strings(BASE), all_strings(NEW)
    missing = sorted(k for k in bs if k not in ns)
    extra = sorted(k for k in ns if k not in bs)
    print('\n== string literals ==')
    print('baseline distinct=%d current distinct=%d' % (len(bs), len(ns)))
    print('missing in current (%d):' % len(missing))
    for s in missing:
        print('  -', s)
    print('new in current (%d):' % len(extra))
    for s in extra:
        print('  +', s)

    # ---- #define values ----
    DEFINE_RE = re.compile(r'(?m)^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]*(.*)$')

    def macros(root):
        out = {}
        for fn in os.listdir(root):
            if fn.endswith('.c') or fn.endswith('.h'):
                text = strip_comments(read(os.path.join(root, fn)))
                for m in DEFINE_RE.finditer(text):
                    name, val = m.group(1), m.group(2).strip()
                    out.setdefault(name, ' '.join(toks(val)))
        return out

    bm, nm = macros(BASE), macros(NEW)
    print('\n== #define values ==')
    changed = [(k, bm[k], nm[k]) for k in bm if k in nm and bm[k] != nm[k]]
    gone = [k for k in bm if k not in nm]
    added = [k for k in nm if k not in bm]
    print('changed: %d, missing: %d, added: %d' % (len(changed), len(gone), len(added)))
    for k, a, b in changed:
        print('  ~', k, ':', a, '->', b)
    for k in gone:
        print('  -', k, '=', bm[k])
    for k in added:
        print('  +', k, '=', nm[k])

    # ---- header inline functions ----
    print('\n== header inline functions ==')
    hdr_ok = hdr_diff = 0
    for fn in sorted(os.listdir(BASE)):
        if not fn.endswith('.h'):
            continue
        old_path = os.path.join(BASE, fn)
        new_path = os.path.join(NEW, fn)
        if not os.path.exists(new_path):
            print('  MISSING HEADER', fn)
            continue
        bf = parse_funcs(read(old_path))
        nf = parse_funcs(read(new_path))
        for name, body in sorted(bf.items()):
            if name in nf and toks(body) == toks(nf[name]):
                hdr_ok += 1
            else:
                hdr_diff += 1
                print('  DIFF %s:%s' % (fn, name))
    print('identical inline functions: %d, differing/missing: %d' % (hdr_ok, hdr_diff))

    return 0 if not diffs and not missing and not extra and not changed and not gone and not added and not hdr_diff else 1


if __name__ == '__main__':
    sys.exit(main())
