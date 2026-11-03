// 比较两份 JS/TS/ETS 源码的可执行 token 序列（忽略注释与空白）。
// 用途：确认“润色”只动了注释/排版，没有改逻辑或字符串。
const fs = require('fs');

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      tokens.push(src.slice(start, i));
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      const start = i;
      i++;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++;
      tokens.push(src.slice(start, i));
      continue;
    }
    tokens.push(c);
    i++;
  }
  return tokens;
}

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error('usage: node compare-js-tokens.js <old> <new>');
  process.exit(2);
}
const a = tokenize(fs.readFileSync(oldPath, 'utf8'));
const b = tokenize(fs.readFileSync(newPath, 'utf8'));
if (a.length !== b.length) {
  console.log(`TOKEN_COUNT_DIFF old=${a.length} new=${b.length}`);
  process.exit(1);
}
for (let i = 0; i < a.length; i++) {
  if (a[i] !== b[i]) {
    console.log(`TOKEN_DIFF at ${i}: old=<${a[i]}> new=<${b[i]}>`);
    process.exit(1);
  }
}
console.log(`TOKENS_MATCH count=${a.length}`);
