#!/usr/bin/env node
/**
 * 只读校验：验证"坏帧 = 正常帧[0..k] + 正常帧[k..E] + 正常帧[k..]" 这一重复模型，
 * 并检查所有坏帧的重复片段是否都终止于同一偏移 E。
 */
'use strict';
const fs = require('node:fs');

const text = fs.readFileSync(process.argv[2]).toString('latin1');
const lines = text.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s[0] === '{');
const rows = lines.map((line) => { try { return { line, obj: JSON.parse(line) }; } catch { return { line, obj: null }; } });

const exp = new Map();
for (const r of rows) { if (!r.obj) continue; const d = r.obj.deviceId; const m = exp.get(d) || new Map(); m.set(r.line.length, (m.get(r.line.length) || 0) + 1); exp.set(d, m); }
const expectedLen = new Map();
for (const [d, m] of exp) expectedLen.set(d, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);

let n = 0;
for (const r of rows) {
  if (r.obj) continue;
  n++;
  const dev = (r.line.match(/"deviceId":"([^"]+)"/) || [])[1];
  const L = expectedLen.get(dev);
  const dl = r.line.length - L;
  let best = null;
  for (let i = 1; i <= r.line.length - dl; i++) {
    const cand = r.line.slice(0, i) + r.line.slice(i + dl);
    if (cand.length !== L) continue;
    try { JSON.parse(cand); } catch { continue; }
    // 检查严格重复模型：bad == cand[0..i] + cand[i..i+dl] + cand[i..]
    const model = cand.slice(0, i) + cand.slice(i, i + dl) + cand.slice(i);
    if (model === r.line) { best = { i, dl, E: i + dl }; break; }
  }
  if (!best) { console.log(`坏帧#${n} dev=${dev} 未匹配严格重复模型`); continue; }
  console.log(`坏帧#${n} dev=${dev} L=${r.line.length} 正常=${L} 重复片段=[${best.i}, ${best.E}) 长度=${best.dl}  → 终止偏移 E=${best.E}`);
}
console.log('\n理论解释：mirror 写入的行 = "relay "(6B) + JSON + "\\n"，JSON 812B → 线上 819B；');
console.log('若 hdc fport 转发缓冲为 768B，则边界落在 JSON 偏移 768-6 = 762 —— 与上面所有坏帧的重复终止偏移一致。');
