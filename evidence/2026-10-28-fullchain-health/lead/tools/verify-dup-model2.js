#!/usr/bin/env node
/** 只读校验 v2：枚举所有"删除 dl 字节后可解析"的位置，再判定是否满足严格重复模型 / 陈旧残留模型。 */
'use strict';
const fs = require('node:fs');
const text = fs.readFileSync(process.argv[2]).toString('latin1');
const rows = text.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s[0] === '{')
  .map((line) => { try { return { line, obj: JSON.parse(line) }; } catch { return { line, obj: null }; } });

const cnt = new Map();
for (const r of rows) if (r.obj) { const d = r.obj.deviceId; const m = cnt.get(d) || new Map(); m.set(r.line.length, (m.get(r.line.length) || 0) + 1); cnt.set(d, m); }
const expLen = new Map(); for (const [d, m] of cnt) expLen.set(d, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);

let n = 0;
for (let idx = 0; idx < rows.length; idx++) {
  const r = rows[idx]; if (r.obj) continue;
  n++;
  const dev = (r.line.match(/"deviceId":"([^"]+)"/) || [])[1];
  const L = expLen.get(dev); const dl = r.line.length - L;
  const hits = [];
  for (let i = 1; i <= r.line.length - dl; i++) {
    const cand = r.line.slice(0, i) + r.line.slice(i + dl);
    try { JSON.parse(cand); } catch { continue; }
    const rem = r.line.slice(i, i + dl);
    const pureDup = (cand.slice(0, i) + cand.slice(i, i + dl) + cand.slice(i)) === r.line;
    // 陈旧残留：该片段是否出现在之前 6 帧（同设备）里
    let stale = -1;
    for (let j = idx - 1; j >= 0 && j >= idx - 6; j--) if (rows[j].line.includes(rem)) { stale = j; break; }
    hits.push({ i, dl, E: i + dl, pureDup, stale, remStart: rem.slice(0, 40) });
  }
  console.log(`\n坏帧#${n} dev=${dev} len=${r.line.length} 正常=${L} 候选修复点=${hits.length}`);
  for (const h of hits) console.log(`  i=${h.i} E=${h.E} dl=${h.dl} 严格重复=${h.pureDup ? 'YES' : 'no'} 片段出现在更早帧=${h.stale} 片段开头=${JSON.stringify(h.remStart)}`);
}
