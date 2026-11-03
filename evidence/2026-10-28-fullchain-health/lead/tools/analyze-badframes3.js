#!/usr/bin/env node
/**
 * 只读分析 v3：按 deviceId 各自的正常帧长度求插入，精确解剖。
 */
'use strict';
const fs = require('node:fs');

const file = process.argv[2];
const text = fs.readFileSync(file).toString('latin1');
const lines = text.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s[0] === '{');

const rows = lines.map((line) => {
  try { return { line, obj: JSON.parse(line) }; } catch { return { line, obj: null }; }
});

// 每设备正常长度
const lenByDev = new Map();
for (const r of rows) {
  if (!r.obj) continue;
  const d = r.obj.deviceId;
  if (!lenByDev.has(d)) lenByDev.set(d, []);
  lenByDev.get(d).push(r.line.length);
}
const expected = new Map();
for (const [d, arr] of lenByDev) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  expected.set(d, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}
console.log('每设备正常帧长度:', JSON.stringify([...expected.entries()]));

let bad = 0;
rows.forEach((r, idx) => {
  if (r.obj) return;
  bad++;
  const line = r.line;
  const devMatch = line.match(/"deviceId":"([^"]+)"/);
  const deviceId = devMatch ? devMatch[1] : '?';
  const exp = expected.get(deviceId);
  const dl = exp ? line.length - exp : NaN;
  console.log(`\n=== 坏帧#${bad} 序位${idx} deviceId=${deviceId} len=${line.length} 正常=${exp} 插入=${dl} ===`);
  if (!exp || dl <= 0) { console.log('  长度异常，跳过'); return; }

  let hit = null;
  for (let i = 1; i <= line.length - dl && !hit; i++) {
    const cand = line.slice(0, i) + line.slice(i + dl);
    if (cand.length !== exp) continue;
    try { const o = JSON.parse(cand); if (o.deviceId === deviceId) hit = { i, cand, o }; } catch { }
  }
  if (!hit) { console.log('  未找到精确修复点'); return; }

  const inserted = line.slice(hit.i, hit.i + dl);
  console.log(`  插入位置=[${hit.i}, ${hit.i + dl})  ts=${hit.o.ts}`);
  console.log(`  插入内容=${JSON.stringify(inserted)}`);
  console.log(`  插入点前 60B=${JSON.stringify(line.slice(Math.max(0, hit.i - 60), hit.i))}`);
  console.log(`  插入点后 60B=${JSON.stringify(line.slice(hit.i + dl, hit.i + dl + 60))}`);

  // 找"被复制"的源位置：在修复后的正常帧里找同样内容
  const src = hit.cand.indexOf(inserted);
  console.log(`  该片段在修复后帧内的位置=${src}`);
  const pre = line.slice(hit.i - dl, hit.i);
  console.log(`  与紧邻前 ${dl}B 相同? ${pre === inserted ? 'YES ← 重复写/回绕' : 'no'}`);
  // 与"本帧更早的同一位置"比较：插入内容是否等于 line 中 [src, src+dl)
  console.log(`  line[${src}..${src + dl}) 内容=${JSON.stringify(line.slice(src, src + dl))}`);

  // 检查是否为本帧某段整体平移：比较插入后结构与正常帧
  const diffAt = (a, b) => { for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] !== b[k]) return k; return Math.min(a.length, b.length); };
  const normal = rows.find((x) => x.obj && x.obj.deviceId === deviceId && x.line.length === exp).line;
  console.log(`  与同设备正常帧首个差异位置=${diffAt(line, normal)}`);
});
console.log(`\n总帧=${rows.length} 坏帧=${bad} 坏帧率=${(bad / rows.length * 100).toFixed(1)}%`);
