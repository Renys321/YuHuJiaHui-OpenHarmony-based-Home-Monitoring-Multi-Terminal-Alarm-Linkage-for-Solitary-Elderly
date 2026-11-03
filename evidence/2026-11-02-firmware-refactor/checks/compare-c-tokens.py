#!/usr/bin/env python3
"""C/H 词法比对：去掉注释与空白后比较 token 序列，字符串/字符字面量原样保留。"""
import re
import sys

TOKEN_RE = re.compile(
    r'''
    (?P<ws>\s+)
  | (?P<line>//[^\n]*)
  | (?P<block>/\*.*?\*/)
  | (?P<str>"(?:\\.|[^"\\])*")
  | (?P<chr>'(?:\\.|[^'\\])*')
  | (?P<id>[A-Za-z_]\w*)
  | (?P<num>\.?\d(?:[eEpP][+-]|[\w.])*)
  | (?P<op>\#\#|[^\sA-Za-z_0-9])
    ''',
    re.S | re.X,
)


def tokens(text):
    out = []
    for m in TOKEN_RE.finditer(text):
        kind = m.lastgroup
        if kind in ('ws', 'line', 'block'):
            continue
        out.append((kind, m.group()))
    return out


def main():
    old = open(sys.argv[1], encoding='utf-8').read()
    new = open(sys.argv[2], encoding='utf-8').read()
    a, b = tokens(old), tokens(new)
    if len(a) != len(b):
        print('TOKEN_COUNT_DIFF old=%d new=%d' % (len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            if x != y:
                print('first mismatch at %d: %r != %r' % (i, x, y))
                break
        sys.exit(1)
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            print('TOKEN_DIFF at %d: %r != %r' % (i, x, y))
            sys.exit(1)
    print('TOKENS_MATCH count=%d' % len(a))


if __name__ == '__main__':
    main()
