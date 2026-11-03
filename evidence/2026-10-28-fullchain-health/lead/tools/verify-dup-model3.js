#!/usr/bin/env node
/**
 * 只读校验 v3：用"正常 sos 帧 + 替换 ts/lastSeen"重建真值帧，与坏帧做 LCP/LCS 对齐，
 * 精确给出插入区间与插入内容是否为其前/后文的重复。
 */
'use strict';
const fs = require('node:fs');
const text = fs.readFileSync(process.argv[2]).toString('latin1');
const rows = text.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s[0] === '{')
  .map((line) => { try { return { line, obj: JSON.parse(line) }; } catch { return { line, obj: null }; } });

const sosNormal = rows.filter((r) => r.obj && r.obj.deviceId === 'esp32-sos' && r.line.length === 812);
const N = sosNormal[0].line;
console.log(`正常 sos 帧样本长度=${N.length}`);

const bads = rows.filter((r) => !r.obj && /"deviceId":"esp32-sos"/.test(r.line));
console.log(`坏帧数=${bads.length}\n`);

const rebuild = (ts, lastSeen) => N
  .replace(/"ts":\d+/, `"ts":${ts}`)
  .replace(/"lastSeen":\d+/, `"lastSeen":${lastSeen}`);

bads.forEach((b, idx) => {
  const bad = b.line;
  const ts = (bad.match(/"ts":(\d+)/) || [])[1];
  const ls = (bad.match(/"lastSeen":(\d+)/) || [])[1];
  let T = null;
  if (ts && ls) T = rebuild(ts, ls);
  if (!T || T.length !== 812) { console.log(`#${idx + 1}: 无法重建真值帧，跳过`); return; }

  let p = 0; while (p < T.length && p < bad.length && T[p] === bad[p]) p++;
  let s = 0; while (s < T.length - p && s < bad.length - p && T[T.length - 1 - s] === bad[bad.length - 1 - s]) s++;
  const insLen = bad.length - T.length;
  const inserted = bad.slice(p, bad.length - s);
  console.log(`#${idx + 1} len=${bad.length} 真值=${T.length} 插入=${insLen}  LCP=${p} LCS=${s}`);
  console.log(`   真值[p..]=${JSON.stringify(T.slice(p, p + 50))}`);
  console.log(`   插入片段 =${JSON.stringify(inserted.slice(0, 80))}${inserted.length > 80 ? '...' : ''}`);
  console.log(`   坏帧插入后=${JSON.stringify(bad.slice(bad.length - s, bad.length - s + 50))}`);
  // 插入片段与真值前文的关系
  const at = T.indexOf(inserted);
  console.log(`   插入片段在真值帧中的位置=${at}（真值长度 ${T.length}）；为真值前文重复? ${at >= 0 && at < p ? 'YES' : 'no'}`);
  console.log(`   插入片段 == 真值[p-insLen..p)? ${T.slice(Math.max(0, p - insLen), p) === inserted}`);
  console.log(`   插入片段 == 真值[p..p+insLen)（即后文重复）? ${T.slice(p, p + insLen) === inserted}`);
});
