#!/usr/bin/env node
/**
 * 只读分析：transport 层留下的 9001 原始广播字节流，定位 esp32-sos 坏帧的"插入片段"到底是什么。
 * 不改现场、不连设备。用法：node analyze-badframes.js <bin>
 */
'use strict';
const fs = require('node:fs');

const file = process.argv[2];
const buf = fs.readFileSync(file);
const text = buf.toString('latin1');            // 逐字节保真
const frames = text.split('\n');

let ok = 0, bad = 0;
const badList = [];
const lenByDev = new Map();

for (const raw of frames) {
  const line = raw.replace(/\r$/, '');
  if (!line || line[0] !== '{') continue;
  let obj = null;
  try { obj = JSON.parse(line); } catch { /* fallthrough */ }
  if (obj) {
    ok++;
    const d = obj.deviceId || '?';
    if (!lenByDev.has(d)) lenByDev.set(d, []);
    lenByDev.get(d).push(Buffer.byteLength(line, 'latin1'));
  } else {
    bad++;
    badList.push(line);
  }
}

console.log(`帧总数(JSON起头)=${ok + bad}  正常=${ok}  坏帧=${bad}  坏帧率=${(bad / (ok + bad) * 100).toFixed(1)}%`);
console.log('\n=== 正常帧长度分布（按 deviceId） ===');
for (const [d, arr] of lenByDev) {
  arr.sort((a, b) => a - b);
  const min = arr[0], max = arr[arr.length - 1];
  console.log(`  ${d.padEnd(16)} n=${String(arr.length).padStart(3)}  len min=${min} max=${max}  ${JSON.stringify([...new Set(arr)].sort((a,b)=>a-b))}`);
}

console.log('\n=== 坏帧逐条解剖 ===');
badList.forEach((line, idx) => {
  const L = line.length;
  const open = (line.match(/\{/g) || []).length;
  const close = (line.match(/\}/g) || []).length;
  console.log(`\n#${idx + 1} len=${L}  {=${open} }=${close}`);

  // 暴力搜索：删掉 [i, i+len) 后能否 JSON.parse 成功
  let found = null;
  for (let i = 1; i < L && !found; i++) {
    for (let dl = 1; dl <= 200 && i + dl <= L; dl++) {
      const cand = line.slice(0, i) + line.slice(i + dl);
      try {
        const o = JSON.parse(cand);
        found = { i, dl, removed: line.slice(i, i + dl), cand, obj: o };
        break;
      } catch { /* keep trying */ }
    }
  }
  if (!found) { console.log('  未找到可修复的删除区间（可能不是简单插入）'); return; }

  const { i, dl, removed, cand, obj } = found;
  console.log(`  插入区间=[${i}, ${i + dl})  长度=${dl}  deviceId=${obj.deviceId} ts=${obj.ts} state=${obj.state}`);
  console.log(`  删除内容(可打印)=${JSON.stringify(removed.slice(0, 60))}${dl > 60 ? '...' : ''}`);

  // 插入内容是否等于它前面紧邻的 dl 字节（环缓冲回绕特征）
  const before = line.slice(Math.max(0, i - dl), i);
  console.log(`  与紧邻前文重复? ${before === removed ? 'YES（回绕/重复写特征）' : 'no'}`);

  // 插入内容是否出现在整帧更早的位置
  const earlier = line.indexOf(removed, 0);
  const occurrences = [];
  let from = 0, pos;
  while ((pos = line.indexOf(removed, from)) !== -1 && occurrences.length < 6) { occurrences.push(pos); from = pos + 1; }
  console.log(`  该片段在帧内出现位置: ${JSON.stringify(occurrences)}（插入区间起点 ${i}）`);

  // 修复后与"正常 804B 帧"结构对比
  console.log(`  修复后长度=${cand.length}  键=${Object.keys(obj).join(',')}`);
});
