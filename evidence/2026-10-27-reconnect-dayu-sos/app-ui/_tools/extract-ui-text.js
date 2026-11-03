// 从 uitest dumpLayout JSON 中提取“文本 -> bounds + clickable”，用于精确点击与文案取证。
const fs = require('fs');
const file = process.argv[2];
const filter = process.argv[3] || '';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = [];
function walk(node) {
  if (!node || typeof node !== 'object') return;
  const attrs = node.attributes || {};
  const text = attrs.text || '';
  if (text && text.indexOf(filter) >= 0) {
    out.push({
      text,
      bounds: attrs.bounds,
      clickable: attrs.clickable,
      type: attrs.type,
      description: attrs.description || ''
    });
  }
  const kids = node.children || [];
  for (const kid of kids) walk(kid);
}
walk(data);
for (const item of out) console.log(JSON.stringify(item));
if (out.length === 0) console.log('NO_TEXT_MATCH');
