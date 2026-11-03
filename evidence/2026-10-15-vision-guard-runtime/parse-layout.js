'use strict';
const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = [];
function walk(n, depth) {
  const a = n.attributes || {};
  const t = (a.text || '').trim();
  if (t) out.push({ text: t, bounds: a.bounds, clickable: a.clickable, type: a.type, depth });
  (n.children || []).forEach((c) => walk(c, depth + 1));
}
walk(j, 0);
out.forEach((r) => console.log(JSON.stringify(r)));
