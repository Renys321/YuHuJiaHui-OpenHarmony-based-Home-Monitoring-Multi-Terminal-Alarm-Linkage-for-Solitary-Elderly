#!/usr/bin/env node
/**
 * 只读分析 v2：用"正常帧长度众数"作为基准，精确求坏帧的插入长度与插入位置，
 * 并判断插入片段是"本帧前文重复"还是"上一帧残留"。
 */
'use strict';
const fs = require('node:fs');

const file = process.argv[2];
const text = fs.readFileSync(file).toString('latin1');
const frames = text.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s[0] === '{');

const parsed = [];
for (const line of frames) {
  try { parsed.push({ line, obj: JSON.parse(line) }); } catch { parsed.push({ line, obj: null }); }
}
const mode = (arr) => {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
};
const goodLen = mode(parsed.filter((p) => p.obj).map((p) => p.line.length));
console.log(`基准正常帧长度(众数)=${goodLen}  帧数=${parsed.length}`);

let bad = 0;
parsed.forEach((p, idx) => {
  if (p.obj) return;
  bad++;
  const L = p.line.length;
  const dl = L - goodLen;                    // 插入长度
  console.log(`\n=== 坏帧#${bad} (序位 ${idx}) len=${L}  推断插入长度=${dl} ===`);

  let hit = null;
  for (let i = 1; i <= L - dl && !hit; i++) {
    const cand = p.line.slice(0, i) + p.line.slice(i + dl);
    if (cand.length !== goodLen) continue;
    try {
      const o = JSON.parse(cand);
      if (o.deviceId && String(o.ts).length >= 10) hit = { i, cand, o };
    } catch { /* next */ }
  }
  if (!hit) { console.log('  未找到精确修复点'); return; }

  const inserted = p.line.slice(hit.i, hit.i + dl);
  console.log(`  插入位置=[${hit.i}, ${hit.i + dl})  deviceId=${hit.o.deviceId} ts=${hit.o.ts} state=${hit.o.state}`);
  console.log(`  插入内容=${JSON.stringify(inserted)}`);
  console.log(`  插入点前 40B=${JSON.stringify(p.line.slice(hit.i - 40, hit.i))}`);
  console.log(`  插入点后 40B=${JSON.stringify(p.line.slice(hit.i + dl, hit.i + dl + 40))}`);

  // 与紧邻前文比较
  const neighbour = p.line.slice(hit.i - dl, hit.i);
  console.log(`  与紧邻前 ${dl}B 相同? ${neighbour === inserted ? 'YES ← 环缓冲回绕/重复写特征' : 'no'}`);

  // 与本帧其他位置比较
  const pos = [];
  let from = 0, q;
  while ((q = p.line.indexOf(inserted, from)) !== -1) { pos.push(q); from = q + 1; }
  console.log(`  该片段在本帧出现位置=${JSON.stringify(pos)}`);

  // 与上一帧（同 deviceId）比较
  for (let j = idx - 1; j >= 0 && j >= idx - 6; j--) {
    const prev = parsed[j].line;
    if (prev.includes(inserted)) { console.log(`  该片段出现在第 ${j} 帧（更早，可能为陈旧残留）`); break; }
  }

  // 修复后与基准帧做 diff 预览
  console.log(`  修复后长度=${hit.cand.length}，与正常帧结构一致? ${JSON.stringify(Object.keys(hit.o).join(','))}`);
});

console.log(`\n坏帧合计=${bad}  坏帧率=${(bad / parsed.length * 100).toFixed(1)}%`);
