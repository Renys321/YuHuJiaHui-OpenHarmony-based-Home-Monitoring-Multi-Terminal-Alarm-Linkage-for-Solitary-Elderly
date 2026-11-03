import json, sys, io

def walk(node, out, depth=0):
    a = node.get('attributes', {}) or {}
    t = a.get('text', '') or ''
    typ = a.get('type', '') or ''
    b = a.get('bounds', '') or ''
    desc = a.get('description', '') or ''
    rid = a.get('id', '') or ''
    clickable = a.get('clickable', '')
    if t.strip() or desc.strip():
        out.append({'d': depth, 'type': typ, 'text': t, 'desc': desc, 'id': rid,
                    'bounds': b, 'clickable': clickable, 'enabled': a.get('enabled',''),
                    'checked': a.get('checked',''), 'selected': a.get('selected','')})
    for c in node.get('children', []) or []:
        walk(c, out, depth+1)

def main(path):
    with io.open(path, 'r', encoding='utf-8') as f:
        j = json.load(f)
    out = []
    walk(j, out)
    for r in out:
        print(f"{r['d']:>2} | {r['type'][:14]:<14} | {r['bounds']:<26} | clk={str(r['clickable']):<5} | {r['text']}" + (f"  [desc={r['desc']}]" if r['desc'] else '') + (f"  [id={r['id']}]" if r['id'] else ''))

if __name__ == '__main__':
    main(sys.argv[1])
